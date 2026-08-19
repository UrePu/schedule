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

export interface RoomRun {
  readonly runId: string;
  readonly partyId: string;
  readonly scheduledAt: Date | null;
  /** 분. 묶음의 **끊는 지점**을 정할 때 쓴다(앞 런이 끝나고 얼마나 벌어졌는가). */
  readonly durationMinutes: number | null;
  /** 이 방 안에서 파티를 부르는 번호. 없을 수 있다(주차에 번호가 안 붙은 파티). */
  readonly partyNo: number | null;
  /** `format_run_entry` 가 만든 `보스 : 이름들`. 시각은 묶음 헤더가 갖는다. */
  readonly entry: string;
}

async function channelPartyIds(db: AdminDb, channelId: string): Promise<string[]> {
  const rows = unwrap(
    await db
      .from("parties")
      .select("id")
      .eq("bot_channel_id", channelId)
      .is("archived_at", null),
    "방 바인딩 파티 조회",
  );
  return rows.map((row) => row.id);
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
 * 이 방의 **이번 주차** 일정.
 *
 * 주차 경계는 **KST 목요일 00:00**(§1). ISO 주차를 쓰면 수·목이 두 주에 걸쳐 어긋난다.
 * `week_key` 는 생성 컬럼이라 DB 가 이미 그 규칙으로 채워 둔다 — 여기서 다시 계산하지 않는다.
 */
export async function fetchRoomRuns(
  db: AdminDb,
  channelId: string,
  scope: DayScope,
  now: Date,
): Promise<readonly RoomRun[]> {
  const partyIds = await channelPartyIds(db, channelId);
  if (partyIds.length === 0) return [];

  const weekKey = getWeekKey(now);

  // 런과 파티 번호는 서로를 기다릴 이유가 없다 — 같이 보낸다.
  const [rows, numbers] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("party_runs")
          .select("id,party_id,scheduled_at,duration_minutes")
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

  const partyNoById = new Map(numbers.map((row) => [row.party_id, row.party_no]));

  const matched = rows
    .map((row) => ({
      runId: row.id,
      partyId: row.party_id,
      scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
      durationMinutes: row.duration_minutes,
      partyNo: partyNoById.get(row.party_id) ?? null,
    }))
    .filter((run) => matchesScope(run.scheduledAt, scope, now));

  if (matched.length === 0) return [];

  /*
    문구는 DB 가 만든다. 런 하나당 RPC 한 번이지만 **동시에** 보내므로 왕복 지연은
    사실상 한 번이다(명령 응답 예산 2초 안). 앱에서 같은 문자열을 다시 조립하는 쪽이
    빠르긴 해도, 그 순간 웹과 봇의 문구가 갈라진다.

    ★ `format_run_notice` 가 아니라 `format_run_entry` 를 쓴다. 목록은 시각을 **묶음
      헤더에 한 번**만 적으므로, 줄마다 시각과 파티 번호를 되풀이하면 폭만 먹는다.
      낱개로 도착하는 푸시는 여전히 `format_run_notice` 를 쓴다 — 거기엔 헤더가 없다.
  */
  const entries = await Promise.all(
    matched.map(async (run) => {
      // 보스와 명단을 두 줄로 받는다(발주 지시 2026-08-19 가독성). 구분자는 DB 가 넣는다.
      const result = await db.rpc("format_run_entry", {
        p_run_id: run.runId,
        p_multiline: true,
      });
      if (result.error !== null) {
        console.warn(`[bot] 알림 문구 생성 실패(run=${run.runId}): ${result.error.message}`);
        return null;
      }
      return typeof result.data === "string" ? result.data : null;
    }),
  );

  return matched.flatMap((run, index) => {
    const entry = entries[index];
    if (entry === null || entry === undefined) return [];
    return [{ ...run, entry }];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 이 방 밖의 내 일정 — 이름 없이 "있다"만
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 발주 요구(2026-08-19):
 *   *"!일정이라고 했으면 해당 방에서 진행하는 보스는 닉네임을 적어주고 이방이 아니면
 *     그냥 있는거만 보여줘야될듯"*
 *
 * 즉 `!일정` 은 두 층이다.
 *   - **이 방에 묶인 파티** → 보스 + 참가자 이름 (`fetchRoomRuns`)
 *   - **그 밖에 내가 낀 파티** → 보스와 시각만. 이 층이 이것이다.
 *
 * ★ 왜 이름을 빼는가. 다른 방 파티원의 이름을 이 방에 뿌리는 것은 그 사람들이 동의한
 *   범위 밖이다(§2.3 — 알림은 방을 따라간다). 반면 "이 사람은 그때 다른 보스를 간다"는
 *   사실 자체는 이 방이 일정을 잡는 데 필요하다. 그 경계가 정확히 "이름은 빼고 존재만".
 * ★ **발신자 본인이 낀 파티만** 본다. 계정이 연결되지 않았으면 이 층은 아예 비어 있다 —
 *   누가 물었는지 모르는 상태에서 남의 일정을 보여 줄 수는 없다.
 */
export interface OtherRun {
  readonly partyId: string;
  readonly scheduledAt: Date | null;
  readonly durationMinutes: number | null;
  /** 보스 이름만. 참가자는 담지 않는다. */
  readonly bossName: string;
}

export async function fetchOtherRuns(
  db: AdminDb,
  channelId: string,
  userId: string,
  scope: DayScope,
  now: Date,
): Promise<readonly OtherRun[]> {
  const participantRows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .eq("user_id", userId)
      .is("left_at", null),
    "내 파티 조회",
  );
  const myPartyIds = [...new Set(participantRows.map((row) => row.party_id))];
  if (myPartyIds.length === 0) return [];

  const parties = unwrap(
    await db
      .from("parties")
      .select("id,bot_channel_id")
      .in("id", myPartyIds)
      .is("archived_at", null),
    "파티 방 바인딩 조회",
  );
  // 이 방에 묶인 파티는 위층이 이미 이름까지 보여 준다 — 여기서 또 세지 않는다.
  const otherIds = parties
    .filter((row) => row.bot_channel_id !== channelId)
    .map((row) => row.id);
  if (otherIds.length === 0) return [];

  const rows = unwrap(
    await db
      .from("party_runs")
      .select("party_id,scheduled_at,duration_minutes,boss_difficulties!inner(korean_name)")
      .in("party_id", otherIds)
      .eq("week_key", getWeekKey(now))
      .is("cancelled_at", null)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true, nullsFirst: false }),
    "다른 방 일정 조회",
  );

  return rows
    .map((row) => ({
      partyId: row.party_id,
      scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
      durationMinutes: row.duration_minutes,
      bossName:
        (row.boss_difficulties as unknown as { korean_name: string } | null)
          ?.korean_name ?? "보스",
    }))
    .filter((run) => matchesScope(run.scheduledAt, scope, now));
}

// ─────────────────────────────────────────────────────────────────────────────
// 연속한 런 묶기 — 규칙은 lib/domain/run-grouping.ts 가 소유한다
// ─────────────────────────────────────────────────────────────────────────────

/** 한 묶음. `21:00 ~ 22:00` 헤더 하나에 보스 줄이 여럿 달린다. */
export interface RunGroup {
  readonly partyNo: number | null;
  /** 이미 조립된 헤더의 시각 부분. `시간미정` 일 수 있다. */
  readonly range: string;
  /** 헤더의 `⏰`(임박) 판정에 쓴다. 시각 미정이면 `null`. */
  readonly startAt: Date | null;
  readonly entries: readonly string[];
}

/**
 * 시간순 런을 묶음으로 접는다.
 *
 * ★ **어디서 끊는지와 헤더 시각 표기는 여기서 정하지 않는다.** 웹 일정 화면이 같은 규칙을
 *   써야 해서(봇은 한 묶음인데 웹은 네 덩어리면 같은 것을 보고 있다는 감각이 끊긴다)
 *   `lib/domain/run-grouping.ts` 로 내렸다. 여기가 더하는 것은 봇 전용인 두 가지 —
 *   **파티 번호**와 **DB 가 만든 보스 줄**뿐이다.
 */
export function groupRuns(
  runs: readonly RoomRun[],
  reference: Date | null,
): readonly RunGroup[] {
  return groupConsecutiveRuns(runs).map((group) => ({
    partyNo: group[0]?.partyNo ?? null,
    range: formatRunGroupRange(group, reference),
    startAt: group[0]?.scheduledAt ?? null,
    entries: group.map((run) => run.entry),
  }));
}

/**
 * 다른 방 일정 한 줄씩. 묶지 않는다 — 이름이 없어 줄이 짧고, 묶어 봐야 절약되는 것이
 * 헤더 한 줄뿐인데 대신 "언제 무엇"이 두 단계로 흩어진다.
 */
export function formatOtherRuns(
  runs: readonly OtherRun[],
  reference: Date | null,
): readonly string[] {
  return runs.map(
    (run) => `${formatRunGroupRange([run], reference)} ${run.bossName}`,
  );
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
      .select("id,name,bot_channel_id")
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
  }));
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
