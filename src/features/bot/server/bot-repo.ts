import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 봇 명령이 읽고 쓰는 데이터
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ **계산과 문구를 새로 만들지 않는다.**
 *   - 알림 한 줄(`19시 1파티 스우 (우레푸, …)`)은 **DB 함수 `format_run_notice`** 가
 *     소유한다. 웹 미리보기와 봇 발송이 갈라지면 안 되기 때문이다(마이그레이션 13-4).
 *   - 주간 수익 합계는 `dashboard-repo.fetchWeeklyIncome()` 을, 클리어 처리는
 *     `income-repo.setRunClear()` 를 그대로 부른다. 화면과 봇이 **같은 답**을 내야 한다는
 *     것이 §2.2 의 전제다.
 *
 * ★ **파티 번호·좌석 번호를 다시 매기지 않는다**(§1.4). 번호는 방에서 사람이 부르는
 *   이름이라, 우리가 재배열하면 진행 중이던 대화가 조용히 어긋난다. 이 파일은 번호를
 *   **읽기만** 한다.
 */

import { fetchWeeklyIncome } from "@/features/dashboard/server/dashboard-repo";
import { setRunClear } from "@/features/income/server/income-repo";
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
  readonly scheduledAt: Date | null;
  /** `format_run_notice` 가 만든 평문 한 줄. 우리가 조립하지 않는다. */
  readonly line: string;
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

  const rows = unwrap(
    await db
      .from("party_runs")
      .select("id,scheduled_at")
      .in("party_id", partyIds)
      .eq("week_key", getWeekKey(now))
      .is("cancelled_at", null)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true, nullsFirst: false }),
    "방 일정 조회",
  );

  const matched = rows
    .map((row) => ({
      runId: row.id,
      scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
    }))
    .filter((run) => matchesScope(run.scheduledAt, scope, now));

  if (matched.length === 0) return [];

  /*
    문구는 DB 가 만든다. 런 하나당 RPC 한 번이지만 **동시에** 보내므로 왕복 지연은
    사실상 한 번이다(명령 응답 예산 2초 안). 앱에서 같은 문자열을 다시 조립하는 쪽이
    빠르긴 해도, 그 순간 웹과 봇의 문구가 갈라진다.
  */
  const lines = await Promise.all(
    matched.map(async (run) => {
      const result = await db.rpc("format_run_notice", {
        p_run_id: run.runId,
        p_kind: "plain",
        p_now: now.toISOString(),
      });
      if (result.error !== null) {
        console.warn(`[bot] 알림 문구 생성 실패(run=${run.runId}): ${result.error.message}`);
        return null;
      }
      return typeof result.data === "string" ? result.data : null;
    }),
  );

  return matched.flatMap((run, index) => {
    const line = lines[index];
    if (line === null || line === undefined) return [];
    return [{ ...run, line }];
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
