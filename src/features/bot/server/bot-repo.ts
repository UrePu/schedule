import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 봇 명령이 읽고 쓰는 데이터
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ **계산과 문구를 새로 만들지 않는다.**
 *   - 알림 한 줄(`19:00 1파티 스우 (우레푸, …)`)은 **DB 함수 `format_run_notice`** 가
 *     소유한다. 웹 미리보기와 봇 발송이 갈라지면 안 되기 때문이다(마이그레이션 13-4).
 *   - 주간 수익 합계는 `dashboard-repo.fetchWeeklyIncome()` 을, 클리어 처리는
 *     `income-repo.setRunClear()` 를 그대로 부른다. 화면과 봇이 **같은 답**을 내야 한다는
 *     것이 §2.2 의 전제다.
 *
 * ★ **파티 번호·좌석 번호를 다시 매기지 않는다**(§1.4). 번호는 방에서 사람이 부르는
 *   이름이라, 우리가 재배열하면 진행 중이던 대화가 조용히 어긋난다. 이 파일은 번호를
 *   **읽기만** 한다.
 */

import { loadLatestSnapshotsByUser } from "@/features/boss-plans/server/boss-plan-repo";
import { fetchWeeklyIncome } from "@/features/dashboard/server/dashboard-repo";
import { setRunClear } from "@/features/income/server/income-repo";
import {
  resolveChoreStatus,
  type ChoreStatus,
} from "@/lib/domain/chore-status";
import {
  formatRunGroupRange,
  groupConsecutiveRuns,
} from "@/lib/domain/run-grouping";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey, addKstDays, kstIsoWeekday } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { BossCatalogEntry } from "@/types/domain";

import type { DayScope } from "../lib/command-parse";
import { unwrap } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// 방에 바인딩된 파티 · 이번 주 일정
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 조회할 **주차의 기준 시점**. `!일정 다음주` 는 7일 뒤 주차를 본다.
 *
 * 주 단위가 아닌 토막(오늘·내일·요일)은 언제나 이번 주 안이므로 오프셋이 없다.
 */
export function weekAnchor(scope: DayScope, now: Date): Date {
  if (scope.kind !== "week" || scope.weekOffset === 0) return now;
  return addKstDays(now, 7 * scope.weekOffset);
}

/** 날짜 토막에 걸리는가. 시각 미정(`scheduled_at is null`)은 **주 단위에서만** 보인다. */
function matchesScope(scheduledAt: Date | null, scope: DayScope, now: Date): boolean {
  if (scope.kind === "week") return true;
  if (scheduledAt === null) return false;

  if (scope.kind === "today") return kstDayKey(scheduledAt) === kstDayKey(now);
  if (scope.kind === "tomorrow") {
    return kstDayKey(scheduledAt) === kstDayKey(addKstDays(now, 1));
  }
  return kstIsoWeekday(scheduledAt) === scope.isoWeekday;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 내 이번 주 런 — `!일정` 은 **방이 아니라 사람**을 본다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-19): *"이렇게 내 정보만 딱딱 깔끔하게 뜨는거지 파티방과 상관없이.
 * 파티방 등록하는건 일정 30분전에 발생하는 알리미 (…) 필요할거같음."*
 *
 * 그전까지 `!일정` 은 **이 방에 묶인 파티**의 런에 참가자 명단을 달아 보여 줬다. 이제는
 * 발신자 **본인의 런만** 보여 주고 줄이 뒤집힌다(`보스들 : 내 캐릭터`).
 * 방↔파티 바인딩은 `!일정` 과 무관해지고 **알리미의 목적지**로만 남는다(§2.3).
 *
 * 그래서 `fetchRoomRuns` · `fetchOtherRuns` 가 사라지고 이 하나가 남았다. 조회·폴백·정렬은
 * 전부 DB `user_week_runs` 가 갖는다 — 캐릭터 폴백 규칙이 `run_participant_names` 와
 * 같은 곳에 있어야 두 문구가 갈라지지 않는다.
 */
export interface MyRun {
  readonly runId: string;
  readonly partyId: string;
  readonly scheduledAt: Date | null;
  readonly durationMinutes: number | null;
  /** 방+주차에 매인 번호. 방에 안 묶인 파티는 `null` 이며 **정상**이다. */
  readonly partyNo: number | null;
  /** `boss_difficulties.short_name` — `익세` · `하대` · `하카` · `노유`. */
  readonly shortName: string;
  /** 이 런에 데려가는 캐릭터. 지정도 파티 기본값도 없으면 `null`. */
  readonly characterName: string | null;
}

export async function fetchMyRuns(
  db: AdminDb,
  userId: string,
  scope: DayScope,
  now: Date,
): Promise<readonly MyRun[]> {
  /*
    주차 오프셋만큼 **KST 로 7일씩** 민 시점의 주차 키를 쓴다. 단순히 `+7*24h` 를 더하지
    않는 이유는 KST 에 서머타임이 없더라도 `addKstDays` 가 달력 기준이라 경계에서 안전하기
    때문이다. 주차 경계 자체(목 00:00)는 `getWeekKey` 가 안다 — 여기서 다시 계산하지 않는다.
  */
  const anchor = weekAnchor(scope, now);
  const result = await db.rpc("user_week_runs", {
    p_user_id: userId,
    p_week_key: getWeekKey(anchor),
  });
  if (result.error !== null) {
    console.warn(`[bot] 내 일정 조회 실패: ${result.error.message}`);
    return [];
  }
  const rows = result.data ?? [];

  return rows
    .map((row) => ({
      runId: row.run_id,
      partyId: row.party_id,
      scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
      durationMinutes: row.duration_minutes,
      partyNo: row.party_no,
      shortName: row.short_name,
      characterName: row.character_name,
    }))
    .filter((run) => matchesScope(run.scheduledAt, scope, now));
}

// ─────────────────────────────────────────────────────────────────────────────
// 연속한 런 묶기 — 규칙은 lib/domain/run-grouping.ts 가 소유한다
// ─────────────────────────────────────────────────────────────────────────────

/** 한 묶음. `21:40 ~ 22:40` 헤더 하나에 캐릭터별 줄이 달린다. */
export interface RunGroup {
  readonly partyNo: number | null;
  /** 이미 조립된 헤더의 시각 부분. `시간미정` 일 수 있다. */
  readonly range: string;
  /** 헤더의 `⏰`(임박) 판정에 쓴다. 시각 미정이면 `null`. */
  readonly startAt: Date | null;
  /** `익세 하대 하카 : 무르겨르` — 캐릭터 하나가 한 줄이다. */
  readonly lines: readonly string[];
}

/**
 * 시간순 런을 묶고, 묶음 안에서 **캐릭터별로 한 줄**로 접는다.
 *
 * ★ 어디서 끊는지와 헤더 시각 표기는 `lib/domain/run-grouping.ts` 가 소유한다(웹 일정
 *   화면이 같은 규칙을 써야 한다). 여기가 더하는 것은 **캐릭터별 접기** 하나뿐이다.
 * ★ 같은 묶음에서 한 캐릭터가 보스 넷을 돈다면 `익세 하대 하카 노유 : 무르겨르` 한 줄이다.
 *   보스마다 캐릭터 이름을 되풀이하면 실제로 다른 부분(보스)이 묻힌다 — 발주자가 이 모양을
 *   직접 그려 보냈다.
 */
export function groupRuns(
  runs: readonly MyRun[],
  reference: Date | null,
): readonly RunGroup[] {
  return groupConsecutiveRuns(runs).map((group) => {
    // 캐릭터가 처음 나온 순서를 유지한다(Map 이 삽입 순서를 지킨다).
    const byCharacter = new Map<string, string[]>();
    for (const run of group) {
      const key = run.characterName ?? "캐릭터 미정";
      const bosses = byCharacter.get(key) ?? [];
      bosses.push(run.shortName);
      byCharacter.set(key, bosses);
    }

    return {
      partyNo: group.find((run) => run.partyNo !== null)?.partyNo ?? null,
      range: formatRunGroupRange(group, reference),
      startAt: group[0]?.scheduledAt ?? null,
      lines: [...byCharacter].map(
        ([character, bosses]) => `${bosses.join(" ")} : ${character}`,
      ),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 결정석 수익
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchCrystalSummary(userId: string, now: Date) {
  return fetchWeeklyIncome(userId, getWeekKey(now));
}

// ─────────────────────────────────────────────────────────────────────────────
// 클리어 체크
// ─────────────────────────────────────────────────────────────────────────────

export interface ClearCandidate {
  readonly runId: string;
  readonly scheduledAt: Date | null;
  /** 이미 이 계정의 클리어가 이 런에 붙어 있는가. */
  readonly alreadyCleared: boolean;
}

/**
 * 이번 주차에 **내가 참여(going)로 등록한** 그 보스의 일정들.
 *
 * ★ 참여하지 않은 일정은 애초에 후보가 아니다 — `setRunClear` 도 같은 기준으로 막는다.
 *   여기서 먼저 좁히는 이유는 방에서 "그런 일정 없어요"와 "참여 등록부터 하세요"를
 *   구분해 말해 주기 위해서다.
 */
export async function findClearCandidates(
  db: AdminDb,
  userId: string,
  entry: BossCatalogEntry,
  now: Date,
): Promise<readonly ClearCandidate[]> {
  const participants = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("user_id", userId)
      .is("left_at", null),
    "내 참가자 행 조회",
  );
  if (participants.length === 0) return [];

  const signups = unwrap(
    await db
      .from("run_signups")
      .select("run_id")
      .in(
        "participant_id",
        participants.map((row) => row.id),
      )
      .eq("status", "going"),
    "내 참여 일정 조회",
  );
  if (signups.length === 0) return [];

  const runIds = [...new Set(signups.map((row) => row.run_id))];
  const runs = unwrap(
    await db
      .from("party_runs")
      .select("id,scheduled_at")
      .in("id", runIds)
      .eq("week_key", getWeekKey(now))
      .eq("boss_difficulty_id", entry.bossDifficultyId)
      .is("cancelled_at", null)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true, nullsFirst: false }),
    "클리어 후보 일정 조회",
  );
  if (runs.length === 0) return [];

  const clears = unwrap(
    await db
      .from("boss_clears")
      .select("run_id")
      .eq("user_id", userId)
      .in(
        "run_id",
        runs.map((row) => row.id),
      ),
    "기존 클리어 조회",
  );
  const clearedRunIds = new Set(
    clears.flatMap((row) => (row.run_id === null ? [] : [row.run_id])),
  );

  return runs.map((row) => ({
    runId: row.id,
    scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
    alreadyCleared: clearedRunIds.has(row.id),
  }));
}

/** 클리어 처리 자체는 수익 원장의 주인인 `income-repo` 가 한다. */
export async function markCleared(userId: string, runId: string): Promise<void> {
  await setRunClear(userId, runId, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 필수 숙제 — `!숙제` 가 읽는다
// ─────────────────────────────────────────────────────────────────────────────

export interface CharacterChores {
  readonly characterId: string;
  readonly characterName: string;
  readonly isMain: boolean;
  readonly daily: readonly ChoreStatus[];
  readonly weekly: readonly ChoreStatus[];
  /** 스냅샷이 아예 없으면 `null` — "안 함"이 아니라 **동기화한 적 없음**이다. */
  readonly syncedAt: string | null;
}

/** 방에서 부르는 이름 → 슬러그. `!숙제 수로` 처럼 짧게 칠 수 있어야 한다. */
export const CHORE_ALIASES: Readonly<Record<string, string>> = {
  수로: "underground-waterway",
  지하수로: "underground-waterway",
  에픽: "epic-dungeon",
  에픽던전: "epic-dungeon",
};

/**
 * 추적 캐릭터별 필수 숙제 4종.
 *
 * ★ **넥슨을 다시 부르지 않는다.** `character_scheduler_snapshots.payload` 에 이미 들어
 *   있는 `dailyContents` / `weeklyContents` 를 읽을 뿐이다. 데이터는 어차피 15분 지연이라
 *   (§1.1) 여기서 호출해 봐야 같은 바이트를 받고 하루 1,000 회 할당량만 태운다.
 * ★ 모집단은 웹 체크리스트와 **같아야** 한다(`user_id` + `is_tracked`). 그래서 스냅샷
 *   로더도 체크리스트가 쓰는 함수를 그대로 가져다 쓴다 — 두 화면이 다른 캐릭터 집합을
 *   보여 주면 어느 쪽이 맞는지 알 수 없게 된다.
 */
export async function fetchChoreBoard(
  db: AdminDb,
  userId: string,
  now: Date,
): Promise<readonly CharacterChores[]> {
  const weekKey = getWeekKey(now);

  const [characters, snapshots, manualRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("characters")
          .select("id,character_name,is_main,character_level")
          .eq("user_id", userId)
          .eq("is_tracked", true)
          .order("character_level", { ascending: false }),
        "추적 캐릭터 조회",
      ))(),
    loadLatestSnapshotsByUser(db, userId),
    (async () =>
      unwrap(
        await db
          .from("chore_completions")
          .select("character_id,effective_done,week_key,chore_definitions!inner(slug,scope)")
          .eq("user_id", userId)
          .eq("week_key", weekKey)
          .eq("chore_definitions.scope", "weekly"),
        "숙제 수동 체크 조회",
      ))(),
  ]);

  /*
    캐릭터별 수동 체크. **`effective_done` 이 false 인 행도 담는다** — "체크했다가 지웠다"는
    "체크한 적 없다"와 다르고, 지운 상태가 넥슨 판정을 되살리는 게 아니라 X 로 남아야 한다.
    그래서 Set 이 아니라 Map<slug, boolean> 이다.
  */
  const manualByCharacter = new Map<string, Map<string, boolean>>();
  for (const row of manualRows) {
    const characterId = row.character_id;
    if (characterId === null) continue;
    const slug = (row.chore_definitions as unknown as { slug: string } | null)?.slug;
    if (slug === undefined) continue;
    const map = manualByCharacter.get(characterId) ?? new Map<string, boolean>();
    map.set(slug, row.effective_done === true);
    manualByCharacter.set(characterId, map);
  }

  return characters.map((character) => {
    const snapshot = snapshots.get(character.id);
    const status = resolveChoreStatus({
      dailyChores: snapshot?.dailyChores ?? [],
      weeklyChores: snapshot?.weeklyChores ?? [],
      manualBySlug: manualByCharacter.get(character.id) ?? new Map<string, boolean>(),
    });
    return {
      characterId: character.id,
      characterName: character.character_name,
      isMain: character.is_main,
      daily: status.daily,
      weekly: status.weekly,
      syncedAt: snapshot?.snapshotAt ?? null,
    };
  });
}

/**
 * 주간 숙제를 사람이 체크/해제한다.
 *
 * ★ **`effective_done` 을 직접 쓰지 않는다.** `chore_completions_apply_state` 트리거가
 *   `manual_done` 과 `api_done` 을 보고 `effective_done` · `has_conflict` 를 정한다
 *   (마이그레이션 04). 앱이 결과 컬럼을 덮으면 그 규칙이 두 벌이 된다.
 * ★ 주차는 `week_key` 기본값(`week_key(now())`)에 맡긴다 — KST 목요일 경계 계산이
 *   DB 에 이미 있고, 앱에서 다시 하면 어긋날 자리가 생긴다(§1).
 */
export async function setChoreManualDone(
  db: AdminDb,
  input: {
    readonly userId: string;
    readonly characterId: string;
    readonly slug: string;
    readonly done: boolean;
  },
  now: Date,
): Promise<boolean> {
  const definitions = unwrap(
    await db
      .from("chore_definitions")
      .select("id,scope")
      .eq("slug", input.slug)
      .limit(1),
    "숙제 정의 조회",
  );
  const definition = definitions[0];
  if (definition === undefined) return false;

  unwrap(
    await db
      .from("chore_completions")
      .upsert(
        {
          user_id: input.userId,
          character_id: input.characterId,
          chore_definition_id: definition.id,
          scope: definition.scope,
          manual_done: input.done,
          manual_set_at: now.toISOString(),
          source: "manual",
          week_key: getWeekKey(now),
        },
        {
          onConflict: "user_id,character_id,chore_definition_id,week_key",
        },
      )
      .select("id"),
    "숙제 체크 저장",
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 내 파티 목록 — `!파티` 가 읽는다
// ─────────────────────────────────────────────────────────────────────────────

export interface BotPartyRow {
  readonly partyId: string;
  readonly name: string;
  /** 이 방에 묶여 있는가. */
  readonly boundHere: boolean;
  /** **다른** 방에 묶여 있는가. 옮겨오는 것이므로 확인 문구에서 그 사실을 밝힌다. */
  readonly boundElsewhere: boolean;
  /** 이번 주차 런 수. `!일정` 과 같은 주차·같은 필터라 두 답이 어긋나지 않는다. */
  readonly runCount: number;
  /** 알림 오프셋(분). 빈 배열이면 **알림 없음**이며 정상 상태다. */
  readonly reminderMinutes: readonly number[];
}

/**
 * 발신자가 **현재 속한** 파티들. 순서는 `created_at` 오름차순으로 고정한다.
 *
 * ★ 여기서 붙는 번호는 **표시용 일련번호이지 저장되는 식별자가 아니다.** §1.4 가 금지하는
 *   것은 `member_no` 처럼 대화에서 사람을 부르는 데 쓰이는 **저장된 번호를 재배열하는 것**
 *   이고, 이 목록은 명령을 칠 때마다 방금 그린 화면이다. 그래도 순서가 흔들리면 "2번"이
 *   다른 파티를 가리키므로 정렬 키를 `created_at` 으로 **고정**했고(파티가 늘어도 앞 번호는
 *   그대로), 연결 확인 문구에 **파티 이름을 반드시 되읽어** 잘못 골랐을 때 즉시 보이게 했다.
 *   되돌리기도 `!파티해제` 한 번이라 비용이 낮다.
 */
export async function listBotParties(
  db: AdminDb,
  userId: string,
  channelId: string,
  now: Date,
): Promise<readonly BotPartyRow[]> {
  const participantRows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .eq("user_id", userId)
      .is("left_at", null),
    "내 파티 조회",
  );
  const partyIds = [...new Set(participantRows.map((row) => row.party_id))];
  if (partyIds.length === 0) return [];

  const parties = unwrap(
    await db
      .from("parties")
      .select("id,name,bot_channel_id,reminder_minutes")
      .in("id", partyIds)
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
    "파티 목록 조회",
  );
  if (parties.length === 0) return [];

  // 런 수는 한 번에 긁어 와서 앱에서 센다 — 파티마다 count 쿼리를 날리면 왕복이 N 배가 된다.
  const runRows = unwrap(
    await db
      .from("party_runs")
      .select("party_id")
      .in(
        "party_id",
        parties.map((row) => row.id),
      )
      .eq("week_key", getWeekKey(now))
      .is("cancelled_at", null)
      .neq("status", "cancelled"),
    "파티 런 수 조회",
  );
  const runCounts = new Map<string, number>();
  for (const row of runRows) {
    runCounts.set(row.party_id, (runCounts.get(row.party_id) ?? 0) + 1);
  }

  return parties.map((row) => ({
    partyId: row.id,
    name: row.name,
    boundHere: row.bot_channel_id === channelId,
    boundElsewhere: row.bot_channel_id !== null && row.bot_channel_id !== channelId,
    runCount: runCounts.get(row.id) ?? 0,
    reminderMinutes: row.reminder_minutes ?? [],
  }));
}

/**
 * 파티 알림 오프셋을 바꾼다.
 *
 * ★ 값 검증은 DB `valid_reminder_minutes` CHECK 이 한다(최대 5회 · 1~1440분 · 중복 없음).
 *   앱에서 같은 규칙을 다시 적으면 웹에서 고칠 때 두 곳을 봐야 한다.
 * ★ 자격은 `setPartyChannel` 과 같아야 하지만 그 함수는 방 바인딩 전용이라, 여기서
 *   **구성원 확인만** 따로 한다 — 알림 회차는 방과 무관한 파티 설정이기 때문이다.
 */
export async function setPartyReminders(
  db: AdminDb,
  userId: string,
  partyId: string,
  minutes: readonly number[],
): Promise<boolean> {
  const membership = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("party_id", partyId)
      .eq("user_id", userId)
      .is("left_at", null)
      .limit(1),
    "파티 구성원 확인",
  );
  if (membership.length === 0) return false;

  unwrap(
    await db
      .from("parties")
      .update({ reminder_minutes: [...minutes] })
      .eq("id", partyId)
      .select("id"),
    "알림 설정 저장",
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정 표시명 · 사용 가능 여부
// ─────────────────────────────────────────────────────────────────────────────

export interface BotAccount {
  readonly userId: string;
  /** 표시 신원은 **본캐 닉네임**이다(§2.1). 없으면 계정 표시명으로 떨어진다. */
  readonly label: string;
  readonly usable: boolean;
}

/**
 * 매핑된 계정이 **지금도 쓸 수 있는 계정인가**를 함께 본다.
 *
 * 매핑은 남아 있는데 계정이 정지·삭제된 경우가 있다. 그 상태로 명령을 처리하면
 * 웹에서는 막힌 사람이 방을 통해 우회하게 된다 — 경계는 언제나 서버이고, 봇도 같은 서버다.
 */
export async function loadBotAccount(
  db: AdminDb,
  userId: string,
): Promise<BotAccount | null> {
  const rows = unwrap(
    await db
      .from("app_users")
      .select("id,display_name,main_character_name,status,deleted_at")
      .eq("id", userId)
      .limit(1),
    "계정 조회",
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    userId: row.id,
    label: row.main_character_name ?? row.display_name,
    usable: row.status === "active" && row.deleted_at === null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 방 정기 알림 시각 — `!알림 09시`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이 방의 정기 알림 시각(KST 자정 기준 분).
 *
 * 파티별 오프셋(`reminder_minutes`)과 **다른 축**이다 — 저쪽은 런 하나에 대해 "몇 분 전",
 * 이쪽은 방에 대해 "하루 중 몇 시". 그래서 저장 위치도 파티가 아니라 방이다.
 */
export async function fetchChannelDigestMinutes(
  db: AdminDb,
  channelId: string,
): Promise<readonly number[]> {
  const rows = unwrap(
    await db.from("bot_channels").select("digest_minutes").eq("id", channelId).limit(1),
    "정기 알림 시각 조회",
  );
  return rows[0]?.digest_minutes ?? [];
}

/** 값 검증은 DB CHECK(`valid_digest_minutes`)이 한다 — 최대 5개·0~1439·중복 없음. */
export async function setChannelDigestMinutes(
  db: AdminDb,
  channelId: string,
  minutes: readonly number[],
): Promise<void> {
  unwrap(
    await db
      .from("bot_channels")
      .update({ digest_minutes: [...minutes] })
      .eq("id", channelId)
      .select("id"),
    "정기 알림 시각 저장",
  );
}

/** 알림 본문이 쓰는 런 한 건. 보스는 줄임말, 명단은 `본캐(부캐)` 로 조립된 문자열. */
export interface NoticeRun {
  readonly runId: string;
  readonly partyId: string;
  readonly scheduledAt: Date | null;
  readonly durationMinutes: number | null;
  readonly partyNo: number | null;
  readonly shortName: string;
  /** `run_participant_names` 가 만든 명단. **키워드 알림이 걸리도록 이름을 접지 않는다.** */
  readonly roster: string;
}

/**
 * 이 방에 묶인 파티의 **이번 주** 런. 알림 본문 셋(등록·정기·리마인더)이 모두 이걸 쓴다.
 *
 * `!일정` 은 사람 기준이 됐지만 알림은 **방에 뿌리는 공지**라 방 기준이 맞다 — 그리고
 * 참가자 이름이 본문에 그대로 있어야 카카오톡 키워드 알림이 울린다(발주 지시 2026-08-19).
 *
 * ⚠️ 명단 상한을 크게 잡는다. `…외 N명` 으로 접히는 순간 **접힌 사람에게는 알림이 가지
 *    않는다** — 알림의 목적이 정확히 그 사람을 부르는 것이므로 여기서 줄이면 안 된다.
 */
export async function fetchRoomWeekRuns(
  db: AdminDb,
  channelId: string,
  now: Date,
): Promise<readonly NoticeRun[]> {
  const parties = unwrap(
    await db
      .from("parties")
      .select("id")
      .eq("bot_channel_id", channelId)
      .is("archived_at", null),
    "방 바인딩 파티 조회",
  );
  const partyIds = parties.map((row) => row.id);
  if (partyIds.length === 0) return [];

  const weekKey = getWeekKey(now);
  const [rows, numbers] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("party_runs")
          .select("id,party_id,scheduled_at,duration_minutes,boss_difficulties!inner(short_name)")
          .in("party_id", partyIds)
          .eq("week_key", weekKey)
          .is("cancelled_at", null)
          .neq("status", "cancelled")
          .order("scheduled_at", { ascending: true, nullsFirst: false }),
        "방 일정 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_room_numbers")
          .select("party_id,party_no")
          .in("party_id", partyIds)
          .eq("week_key", weekKey),
        "파티 번호 조회",
      ))(),
  ]);
  if (rows.length === 0) return [];

  const partyNoById = new Map(numbers.map((row) => [row.party_id, row.party_no]));
  const rosters = await Promise.all(
    rows.map(async (row) => {
      const result = await db.rpc("run_participant_names", {
        p_run_id: row.id,
        p_max_names: 12,
      });
      return typeof result.data === "string" ? result.data : null;
    }),
  );

  return rows.flatMap((row, index) => {
    const roster = rosters[index];
    if (roster === null || roster === undefined) return [];
    const short =
      (row.boss_difficulties as unknown as { short_name: string } | null)?.short_name ??
      "보스";
    return [
      {
        runId: row.id,
        partyId: row.party_id,
        scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
        durationMinutes: row.duration_minutes,
        partyNo: partyNoById.get(row.party_id) ?? null,
        shortName: short,
        roster,
      },
    ];
  });
}

/**
 * 이 방에 묶인 파티별 알림 오프셋(분). 리마인더 적재가 쓴다.
 *
 * 파티가 여럿인 방이 정상이므로 파티 -> 오프셋 지도를 돌려준다. 빈 배열이면 그 파티는
 * 알림을 보내지 않는다는 뜻이며 **정상 상태**다.
 */
export async function fetchPartyReminderMinutes(
  db: AdminDb,
  channelId: string,
): Promise<ReadonlyMap<string, readonly number[]>> {
  const rows = unwrap(
    await db
      .from("parties")
      .select("id,reminder_minutes")
      .eq("bot_channel_id", channelId)
      .is("archived_at", null),
    "파티 알림 설정 조회",
  );
  return new Map(rows.map((row) => [row.id, row.reminder_minutes ?? []]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 드랍 기록 — `!드랍` 이 원장에 남긴다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 드랍을 붙일 런을 고른다.
 *
 * ★ **런이 곧 (파티 · 날짜 · 보스)** 다(발주 설명 2026-08-19: *"런은 기록만하고 파티의
 *   며칠날 한 보스에서 이만큼 수익이 났다"*). 그래서 드랍에 파티·날짜·보스를 따로 적지
 *   않고 런 하나만 가리키면 셋이 다 따라온다.
 * ★ 보스를 안 적으면 **방금 돈 보스**로 본다 — 이번 주, 이 방 파티, 내가 going 인 런 중
 *   지금보다 앞선 것 중 가장 최근. 방에서 드랍을 올리는 순간은 언제나 그 직후다.
 * ★ 고른 런을 답장에 되읽어 준다. 잘못 골랐으면 그 자리에서 보인다.
 */
export interface DropTargetRun {
  readonly runId: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly bossName: string;
  readonly scheduledAt: Date | null;
  /** 이 런에 going 으로 등록된 사람 수. 분배는 이 인원으로 나뉜다. */
  readonly goingCount: number;
  /** 발신자의 `party_participants.id`. 기록자로 남긴다. */
  readonly participantId: string;
}

export async function findDropTargetRun(
  db: AdminDb,
  channelId: string,
  userId: string,
  bossToken: string | undefined,
  now: Date,
): Promise<DropTargetRun | null> {
  const parties = unwrap(
    await db
      .from("parties")
      .select("id,name")
      .eq("bot_channel_id", channelId)
      .is("archived_at", null),
    "방 바인딩 파티 조회",
  );
  if (parties.length === 0) return null;
  const partyName = new Map(parties.map((row) => [row.id, row.name]));

  const mine = unwrap(
    await db
      .from("party_participants")
      .select("id,party_id")
      .eq("user_id", userId)
      .is("left_at", null)
      .in(
        "party_id",
        parties.map((row) => row.id),
      ),
    "내 파티 구성원 조회",
  );
  if (mine.length === 0) return null;
  const participantByParty = new Map(mine.map((row) => [row.party_id, row.id]));

  const rows = unwrap(
    await db
      .from("party_runs")
      .select("id,party_id,scheduled_at,boss_difficulties!inner(korean_name,short_name)")
      .in("party_id", [...participantByParty.keys()])
      .eq("week_key", getWeekKey(now))
      .is("cancelled_at", null)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: false, nullsFirst: false }),
    "런 조회",
  );
  if (rows.length === 0) return null;

  const normalized = bossToken === undefined ? null : bossToken.replace(/\s+/gu, "");
  const picked =
    normalized === null
      ? // 보스를 안 적었으면 **이미 지난 것 중 가장 최근**. 없으면 이번 주 첫 런.
        (rows.find(
          (row) =>
            row.scheduled_at !== null && new Date(row.scheduled_at).getTime() <= now.getTime(),
        ) ?? rows[rows.length - 1])
      : rows.find((row) => {
          const boss = row.boss_difficulties as unknown as {
            korean_name: string;
            short_name: string;
          };
          return (
            boss.short_name.replace(/\s+/gu, "") === normalized ||
            boss.korean_name.replace(/\s+/gu, "").includes(normalized)
          );
        });
  if (picked === undefined || picked === null) return null;

  const going = unwrap(
    await db.from("run_signups").select("id").eq("run_id", picked.id).eq("status", "going"),
    "참가자 수 조회",
  );

  const boss = picked.boss_difficulties as unknown as { korean_name: string };
  return {
    runId: picked.id,
    partyId: picked.party_id,
    partyName: partyName.get(picked.party_id) ?? "파티",
    bossName: boss.korean_name,
    scheduledAt: picked.scheduled_at === null ? null : new Date(picked.scheduled_at),
    goingCount: going.length,
    participantId: participantByParty.get(picked.party_id) ?? "",
  };
}

/**
 * 드랍을 원장에 남긴다.
 *
 * ★ **기록하는 금액은 "실제로 각자 손에 쥐는 총합"이다.** 총 판매액(950억)이 아니다 —
 *   경매장 수수료를 두 번 떼고 나면 파티에 실제로 들어오는 것은 그보다 적고, 대시보드가
 *   총액을 그대로 쌓으면 있지도 않은 수익을 보게 된다. 그래서
 *   `eachFinalMeso × 인원` 을 넣는다. 균등 분배라 나누어떨어진다.
 * ★ `share_mode` 는 기본값 `party_default` 그대로 둔다. 그러면 `v_run_drop_recipients` 가
 *   **파티 분배 설정**을 따라간다 — 분배를 파티로 올린 이번 변경과 한 몸이다.
 * ★ 총 판매액과 수수료는 `note` 에 남긴다. 나중에 "얼마에 팔았더라"를 되찾을 유일한 곳이다.
 */
export async function recordDrop(
  db: AdminDb,
  input: {
    readonly runId: string;
    readonly participantId: string;
    readonly itemName: string;
    readonly potMeso: number;
    readonly note: string;
  },
  now: Date,
): Promise<string | null> {
  const rows = unwrap(
    await db
      .from("run_drops")
      .insert({
        run_id: input.runId,
        item_name: input.itemName,
        sale_amount_meso: input.potMeso,
        sold_at: now.toISOString(),
        recorded_by_participant_id: input.participantId === "" ? null : input.participantId,
        note: input.note,
      })
      .select("id"),
    "드랍 기록",
  );
  return rows[0]?.id ?? null;
}

/**
 * 내가 기록한 **가장 최근** 드랍을 지운다. `!드랍취소` 가 쓴다.
 *
 * ★ 웹 삭제는 이번 범위 밖이라(발주 지시), 방에서 되돌릴 길이 없으면 오타 한 번이 영구
 *   기록이 된다. 그래서 최소한의 취소를 함께 연다.
 * ★ **내가 기록한 것만** 지운다. `recorded_by_participant_id` 조건이 소유 확인 그 자체다.
 */
export async function deleteMyLatestDrop(
  db: AdminDb,
  channelId: string,
  userId: string,
  now: Date,
): Promise<{ readonly itemName: string; readonly potMeso: number | null } | null> {
  const parties = unwrap(
    await db
      .from("parties")
      .select("id")
      .eq("bot_channel_id", channelId)
      .is("archived_at", null),
    "방 바인딩 파티 조회",
  );
  if (parties.length === 0) return null;

  const mine = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("user_id", userId)
      .is("left_at", null)
      .in(
        "party_id",
        parties.map((row) => row.id),
      ),
    "내 파티 구성원 조회",
  );
  if (mine.length === 0) return null;

  const rows = unwrap(
    await db
      .from("run_drops")
      .select("id,item_name,sale_amount_meso")
      .eq("week_key", getWeekKey(now))
      .in(
        "recorded_by_participant_id",
        mine.map((row) => row.id),
      )
      .order("created_at", { ascending: false })
      .limit(1),
    "내 드랍 조회",
  );
  const target = rows[0];
  if (target === undefined) return null;

  unwrap(
    await db.from("run_drops").delete().eq("id", target.id).select("id"),
    "드랍 삭제",
  );
  return { itemName: target.item_name, potMeso: target.sale_amount_meso };
}
