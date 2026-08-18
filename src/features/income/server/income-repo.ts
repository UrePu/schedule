import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 수익 화면의 **유일한 DB 접근 지점**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **여기서 수익을 계산하지 않는다.** 이 파일에는 금액에 대한 곱하기·나누기·합계가
 *    한 줄도 없다. 값의 출처는 전부 DB 다:
 *
 *      pot = party_size × floor(가격/party_size)   ← `boss_clears_apply_state()` 트리거
 *      내 몫                                        ← `resolve_crystal_payout()`
 *      런 안의 재분배                                ← `distribute_meso()`
 *      캐릭터별 / 사용자별 주간 합계                 ← `v_weekly_crystal_income_by_character`
 *                                                     `v_weekly_income`
 *
 *    이 규칙을 두 번 어겨서 두 번 고쳤다. 웹과 카톡 봇(`!결정석`)과 집계 뷰가 서로 다른
 *    답을 내기 시작하는 지점이 정확히 여기다.
 *
 * ── 파티 인원을 고치면 어떻게 다시 계산되는가 (핵심) ─────────────────────────
 * 인원 수정의 **유일한 입구는 `set_clear_party_size(clear_id, party_size)` RPC** 다.
 * 이 파일은 `boss_clears` 의 `party_size` 를 직접 UPDATE 하지 않는다.
 *   → 함수 안에서 금액 재계산(pot·share_bp·crystal_share_meso)과
 *     `party_size_confirmed = true` 승격, 런 전체 동기화, 분배 재계산이 한 트랜잭션에서 끝난다.
 *   → 가격 재조회는 `current_crystal_price(boss, cleared_at)` 로 **클리어 시점 기준**이고,
 *     `cycle` 과 시세 스냅샷은 트리거가 **보존**한다(§1 "가격·주기 소급 변경 금지").
 *   → 애플리케이션이 pot 공식을 다시 쓰지 않는 유일한 방법이기도 하다.
 *
 * ★ 예전에는 호출부마다 `party_size` 와 `price_snapshotted_at: null` 을 직접 UPDATE 해
 *   트리거를 다시 태웠다. 그 방식은 재스냅샷 규칙을 **호출부 세 곳에 복제**했고,
 *   확인 비트도 올리지 못했다. 전용 함수는 정확히 그것을 막으려고 생겼다.
 *
 * ── 왜 서버 컴포넌트와 Route Handler 가 같은 파일을 보는가 ───────────────────
 * `schedule-repo` · `dashboard-repo` 와 같은 이유다. service_role 은 브라우저로 나갈 수
 * 없으므로 첫 렌더는 서버 컴포넌트가 이 파일을 직접 import 하고, 체크·수정 이후의 갱신은
 * Route Handler 가 같은 함수를 부른다. 조회 로직이 두 벌이 되지 않는다.
 *
 * ── 일간 보스는 이 화면에 없다 (2026-08-18 발주자 지시) ──────────────────────
 * 목록·건수·금액 어디에도 일간이 들어가지 않는다. 규칙의 소유자는 `@/lib/domain/boss-scope`
 * 이고, 금액을 빼는 방법과 그것이 12개 절삭을 흔들지 않는 이유는
 * `./crystal-scope` 머리말에 적혀 있다. **이미 쌓인 일간 기록은 지우지 않는다** —
 * 표시와 집계에서 빼는 것으로 충분하고, 과거 데이터 파기는 되돌릴 수 없다.
 */

import { ApiError } from "@/features/auth/server/http";
import { fetchWeeklyIncome } from "@/features/dashboard/server/dashboard-repo";
import { fetchMyRunCharacters } from "@/features/schedule/server/schedule-repo";
import { isTrackedBossCycle } from "@/lib/domain/boss-scope";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { getWeekKey } from "@/lib/time/week";

import {
  excludedDailyFor,
  fetchWeeklyCrystalScope,
  subtractDailyMeso,
} from "./crystal-scope";
import type {
  BossCycle,
  BossDifficultyTier,
  MesoOrUnknown,
  WeekKey,
} from "@/types/domain";

import type {
  CharacterIncome,
  ClearRecord,
  ClearSource,
  ClearWinner,
  ScheduledRunClear,
  UnsoldDrop,
  WeeklyIncomeDetail,
  WeeklyIncomeTotals,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────────────────────

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

/** 실패는 우리 문구로 접는다 — PostgREST 에러 원문에는 스키마 구조가 그대로 들어 있다. */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[income-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[income-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/**
 * 없는 기록과 남의 기록을 **같은 답으로** 접는다.
 *
 * 403 은 "그 id 는 존재한다"는 정보를 준다. 클리어 id 를 훑으면 남이 어떤 보스를 언제
 * 잡았는지 알아낼 수 있게 되므로 둘 다 404 다.
 */
function clearNotFound(): ApiError {
  return new ApiError(
    "bad_request",
    "클리어 기록을 찾을 수 없거나 편집 권한이 없습니다.",
    404,
  );
}

function runNotFound(): ApiError {
  return new ApiError(
    "bad_request",
    "일정을 찾을 수 없거나 편집 권한이 없습니다.",
    404,
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * 뷰의 집계 컬럼은 `numeric` 이라 PostgREST 가 **문자열**로 준다(`"6"`).
 * 건수는 전부 작은 정수라 여기서 한 번만 좁힌다. 금액은 절대 이 함수를 쓰지 않는다.
 */
function toCount(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `bigint` 컬럼 → 메소.
 *
 * ★ 안전 정수 범위를 넘으면 `null`(미확인)로 접는다. `Number` 로 조용히 반올림하면
 *   화면이 **틀린 금액을 사실인 것처럼** 말하게 된다. `null` 은 이미 "모름"이라는 뜻을
 *   갖고 있고 화면이 그 상태를 그릴 줄 안다.
 */
function toSafeMeso(value: number | string | null): MesoOrUnknown {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isSafeInteger(parsed)) {
    console.warn(
      `[income-repo] 메소 값이 안전 정수 범위를 벗어났습니다: ${String(value)}`,
    );
    return null;
  }
  return parsed;
}

/** `party_size` 의 DB CHECK 범위. **보스별 상한과 교차 검증하지 않는다** (§1.3 D5). */
export const PARTY_SIZE_MIN = 1;
export const PARTY_SIZE_MAX = 24;

/** 1/n 의 분모 기본값. `entry_party_size` 가 비면 그 런의 모집 정원을 쓴다. */
function entryPartySizeOf(row: {
  readonly entry_party_size: number | null;
  readonly capacity: number;
}): number {
  const raw = row.entry_party_size ?? row.capacity;
  return Math.min(Math.max(raw, PARTY_SIZE_MIN), PARTY_SIZE_MAX);
}

/**
 * 넥슨 관측과 수동 체크 중 **어느 쪽이 반영됐는가**.
 *
 * ★ 판정 규칙은 `boss_clears_apply_state()` 트리거의 것을 그대로 읽어 온 것이다 —
 *   관측 시각이 더 최신인 쪽이 이기고, 동률이면 사람이 이긴다. 여기서 **다시 판정하지
 *   않는다**; 승패의 결과(`effective_cleared`)는 이미 행에 들어 있고 이 함수는 그것을
 *   사람에게 설명하기 위한 라벨만 만든다.
 */
function resolveWinner(row: {
  readonly manual_cleared: boolean | null;
  readonly manual_set_at: string | null;
  readonly api_cleared: boolean | null;
  readonly api_observed_at: string | null;
}): ClearWinner {
  if (row.manual_cleared === null && row.api_cleared === null) return "none";
  if (row.manual_cleared === null) return "api";
  if (row.api_cleared === null) return "manual";
  const manualAt = row.manual_set_at === null ? -Infinity : Date.parse(row.manual_set_at);
  const apiAt = row.api_observed_at === null ? -Infinity : Date.parse(row.api_observed_at);
  return manualAt >= apiAt ? "manual" : "api";
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회를 위한 보조 로더
// ─────────────────────────────────────────────────────────────────────────────

interface BossInfo {
  readonly displayName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  readonly maxParty: number | null;
  readonly crystalPriceMeso: MesoOrUnknown;
}

async function loadBossInfo(
  db: AdminDb,
  bossDifficultyIds: readonly string[],
): Promise<Map<string, BossInfo>> {
  const map = new Map<string, BossInfo>();
  if (bossDifficultyIds.length === 0) return map;

  const rows = unwrap(
    await db
      .from("v_boss_catalog")
      .select(
        "boss_difficulty_id,korean_name,difficulty,cycle,max_party,crystal_price_meso",
      )
      .in("boss_difficulty_id", [...bossDifficultyIds]),
    "보스 마스터 조회",
  );

  for (const row of rows) {
    if (row.boss_difficulty_id === null) continue;
    map.set(row.boss_difficulty_id, {
      // `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태로 난이도를 포함한다.
      displayName: row.korean_name ?? row.boss_difficulty_id,
      difficulty: row.difficulty ?? "normal",
      cycle: row.cycle ?? "weekly",
      maxParty: row.max_party,
      crystalPriceMeso: toSafeMeso(row.crystal_price_meso),
    });
  }
  return map;
}

interface CharacterInfo {
  readonly name: string;
  readonly worldName: string | null;
}

async function loadCharacters(
  db: AdminDb,
  characterIds: readonly string[],
): Promise<Map<string, CharacterInfo>> {
  const map = new Map<string, CharacterInfo>();
  if (characterIds.length === 0) return map;

  const rows = unwrap(
    await db
      .from("characters")
      .select("id,character_name,world_name")
      .in("id", [...characterIds]),
    "캐릭터 조회",
  );
  for (const row of rows) {
    map.set(row.id, { name: row.character_name, worldName: row.world_name });
  }
  return map;
}

interface RunInfo {
  readonly runId: string;
  readonly runNo: number;
  readonly partyId: string;
  readonly partyName: string;
  readonly bossDifficultyId: string;
  readonly scheduledAt: string | null;
  readonly entryPartySize: number;
  readonly goingCount: number;
}

/** `party_runs` + 파티 이름 + `going` 인원. 인원은 화면 경고에만 쓰고 금액에는 쓰지 않는다. */
async function loadRunInfo(
  db: AdminDb,
  runIds: readonly string[],
): Promise<Map<string, RunInfo>> {
  const map = new Map<string, RunInfo>();
  if (runIds.length === 0) return map;

  const runRows = unwrap(
    await db
      .from("party_runs")
      .select(
        "id,party_id,run_no,boss_difficulty_id,scheduled_at,capacity,entry_party_size",
      )
      .in("id", [...runIds]),
    "일정 조회",
  );
  if (runRows.length === 0) return map;

  const [partyRows, signupRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("parties")
          .select("id,name")
          .in("id", unique(runRows.map((row) => row.party_id))),
        "파티 이름 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("run_signups")
          .select("run_id,status")
          .in("run_id", runRows.map((row) => row.id))
          .eq("status", "going"),
        "참여 인원 조회",
      ))(),
  ]);

  const partyNameById = new Map(partyRows.map((row) => [row.id, row.name]));
  const goingByRun = new Map<string, number>();
  for (const row of signupRows) {
    goingByRun.set(row.run_id, (goingByRun.get(row.run_id) ?? 0) + 1);
  }

  for (const row of runRows) {
    map.set(row.id, {
      runId: row.id,
      // 트리거가 넣은 관리 번호. 재배열·재사용하지 않는다 (§1.4).
      runNo: row.run_no,
      partyId: row.party_id,
      partyName: partyNameById.get(row.party_id) ?? "이름 없는 파티",
      bossDifficultyId: row.boss_difficulty_id,
      scheduledAt: row.scheduled_at,
      entryPartySize: entryPartySizeOf(row),
      goingCount: goingByRun.get(row.id) ?? 0,
    });
  }
  return map;
}

/** 내가 아직 나가지 않은 파티 참가자 행 id. 파티 소속 판정의 단일 출처다. */
async function loadMyParticipantIds(
  db: AdminDb,
  userId: string,
): Promise<string[]> {
  const rows = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("user_id", userId)
      .is("left_at", null),
    "내 파티 참가자 조회",
  );
  return rows.map((row) => row.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회 — 화면 전체를 한 번에 만든다
// ─────────────────────────────────────────────────────────────────────────────

interface ClearRow {
  readonly id: string;
  readonly character_id: string | null;
  readonly boss_difficulty_id: string;
  readonly run_id: string | null;
  readonly party_size: number;
  /** 인원을 사람이 확인했는가. DB 가 들고 있는 사실이다(추론 아님). */
  readonly party_size_confirmed: boolean;
  readonly cycle: BossCycle | null;
  readonly base_price_meso: number | null;
  readonly pot_meso: number | null;
  readonly crystal_share_meso: number | null;
  readonly share_bp: number | null;
  readonly source: ClearSource;
  readonly manual_cleared: boolean | null;
  readonly manual_set_at: string | null;
  readonly api_cleared: boolean | null;
  readonly api_observed_at: string | null;
  readonly effective_cleared: boolean;
  readonly has_conflict: boolean;
  readonly cleared_at: string | null;
}

/**
 * ★ **하나의 문자열 리터럴이어야 한다.** supabase-js 는 select 문자열을 타입 수준에서
 *   파싱해 행 모양을 만든다. `"a," + "b"` 로 이어 붙이면 타입이 `string` 으로 뭉개져
 *   컬럼 오타가 런타임까지 살아남는다(그러라고 `AdminDb` 에 타입을 붙였다).
 */
const CLEAR_COLUMNS =
  "id,character_id,boss_difficulty_id,run_id,party_size,party_size_confirmed,cycle,base_price_meso,pot_meso,crystal_share_meso,share_bp,source,manual_cleared,manual_set_at,api_cleared,api_observed_at,effective_cleared,has_conflict,cleared_at";

/** 위와 같은 이유로 한 줄이다. */
const BY_CHARACTER_COLUMNS =
  "character_id,income_meso,clear_count,weekly_clear_count,daily_clear_count,monthly_clear_count,unknown_price_count,weekly_over_limit_count,weekly_sell_limit";
// ⚠️ `daily_clear_count` 는 **화면에 올리지 않고 뺄셈 검산에만** 남겨 둔다. 뷰가 세는
//    일간 건수와 우리가 원장에서 센 일간 건수가 어긋나면 뺄셈 전제가 깨진 것이므로,
//    조용히 틀린 숫자를 그리는 대신 로그로 드러낸다.

/**
 * 인원을 **아무도 확인한 적이 없는** 클리어인가.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이것은 **DB 가 들고 있는 사실**이다. 여기서 추론하지 않는다.
 * ─────────────────────────────────────────────────────────────────────────────
 * `boss_clears.party_size_confirmed` 를 그대로 뒤집어 읽는다. 값을 채우는 주체는 DB 뿐이다:
 * - INSERT 트리거(`boss_clears_apply_state`)가 유도한다 — 사람/봇이 만든 행이거나
 *   런에 걸린 행이면 인원을 알고 만든 것이므로 확인됨.
 * - `set_clear_party_size()` 가 사용자의 확인을 true 로 올린다. UPDATE 에서는 트리거가
 *   이 비트를 건드리지 않으므로 한번 한 확인이 조용히 취소되지 않는다.
 *
 * ★ 예전에는 `source='nexon_api' and run_id is null and party_size = 1` 이라는 **추론**이었다.
 *   그 식은 **진짜로 솔로였던 API 클리어**를 영원히 "확인 필요"로 띄웠다 — 사용자가 몇 번
 *   확인해도 값이 1 이라 조건이 계속 참이었기 때문이다. 저장할 자리가 없어 생긴 오탐이고,
 *   마이그레이션 20 이 그 자리를 만들면서 사라졌다.
 */
function isPartySizeUnconfirmed(row: ClearRow): boolean {
  return !row.party_size_confirmed;
}

function toClearRecord(
  row: ClearRow,
  boss: BossInfo | undefined,
  character: CharacterInfo | undefined,
  run: RunInfo | undefined,
): ClearRecord {
  const maxParty = boss?.maxParty ?? null;
  return {
    clearId: row.id,
    characterId: row.character_id,
    characterName: character?.name ?? null,
    worldName: character?.worldName ?? null,
    bossDifficultyId: row.boss_difficulty_id,
    bossDisplayName: boss?.displayName ?? row.boss_difficulty_id,
    difficulty: boss?.difficulty ?? "normal",
    // ★ 마스터의 현재 주기가 아니라 **클리어 시점에 스냅샷된 주기**를 쓴다.
    //   2026-06-18 패치처럼 주간↔일간이 바뀌면 12 카운터 대상이 달라지므로,
    //   과거 기록은 당시 주기로 남아야 한다(§1).
    cycle: row.cycle,
    countsTowardWeeklyLimit: row.cycle === "weekly",
    partySize: row.party_size,
    maxParty,
    overMaxParty: maxParty !== null && row.party_size > maxParty,
    partySizeUnconfirmed: isPartySizeUnconfirmed(row),
    goingCount: run?.goingCount ?? null,
    shareMeso: toSafeMeso(row.crystal_share_meso),
    potMeso: toSafeMeso(row.pot_meso),
    basePriceMeso: toSafeMeso(row.base_price_meso),
    shareBp: row.share_bp,
    source: row.source,
    manualCleared: row.manual_cleared,
    apiCleared: row.api_cleared,
    hasConflict: row.has_conflict,
    winner: resolveWinner(row),
    runId: row.run_id,
    runNo: run?.runNo ?? null,
    partyName: run?.partyName ?? null,
    clearedAt: row.cleared_at,
  };
}

/**
 * 그 주에 내가 `going` 으로 등록한 일정 + 각 일정의 클리어 상태.
 *
 * **취소된 런은 뺀다.** 클리어 체크 대상이 아니고, 목록에 남으면 취소한 일정에 수익이
 * 붙는다. §1.4 의 "번호는 재배열하지 않는다"는 그대로 지켜진다 — 빠진 번호가 구멍으로
 * 남을 뿐이다.
 */
async function loadScheduledRunClears(
  db: AdminDb,
  userId: string,
  weekKey: WeekKey,
  clearRows: readonly ClearRow[],
  bosses: Map<string, BossInfo>,
): Promise<{
  readonly runs: readonly ScheduledRunClear[];
  readonly runIds: readonly string[];
}> {
  const participantIds = await loadMyParticipantIds(db, userId);
  if (participantIds.length === 0) return { runs: [], runIds: [] };

  const signupRows = unwrap(
    await db
      .from("run_signups")
      .select("run_id,character_id,participant_id")
      .in("participant_id", participantIds)
      .eq("status", "going"),
    "내 참여 일정 조회",
  );
  if (signupRows.length === 0) return { runs: [], runIds: [] };

  const runRows = unwrap(
    await db
      .from("party_runs")
      .select(
        "id,party_id,run_no,boss_difficulty_id,scheduled_at,capacity,entry_party_size,week_key",
      )
      .in("id", unique(signupRows.map((row) => row.run_id)))
      .eq("week_key", weekKey)
      .is("cancelled_at", null)
      .neq("status", "cancelled"),
    "이번 주 일정 조회",
  );
  if (runRows.length === 0) return { runs: [], runIds: [] };

  const characterIdBySignup = new Map(
    signupRows.map((row) => [row.run_id, row.character_id]),
  );

  const missingBossIds = runRows
    .map((row) => row.boss_difficulty_id)
    .filter((id) => !bosses.has(id));
  if (missingBossIds.length > 0) {
    const extra = await loadBossInfo(db, unique(missingBossIds));
    for (const [id, info] of extra) bosses.set(id, info);
  }

  const runInfo = await loadRunInfo(
    db,
    runRows.map((row) => row.id),
  );

  const [partyRows, characters] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("parties")
          .select("id,name")
          .in("id", unique(runRows.map((row) => row.party_id))),
        "파티 이름 조회",
      ))(),
    loadCharacters(
      db,
      unique(
        [...characterIdBySignup.values()].flatMap((id) => (id === null ? [] : [id])),
      ),
    ),
  ]);
  const partyNameById = new Map(partyRows.map((row) => [row.id, row.name]));

  // 클리어 원장과의 연결. 유니크 키는 (user, character, boss, week) 이므로
  // 런에 직접 걸린 행이 없어도 같은 캐릭터·보스의 이번 주 행이면 같은 사건이다.
  const clearByRunId = new Map<string, ClearRow>();
  const clearByCharacterBoss = new Map<string, ClearRow>();
  for (const row of clearRows) {
    if (row.run_id !== null) clearByRunId.set(row.run_id, row);
    if (row.character_id !== null) {
      clearByCharacterBoss.set(
        `${row.character_id}::${row.boss_difficulty_id}`,
        row,
      );
    }
  }

  const runs: ScheduledRunClear[] = runRows
    /*
     * ★ 일간 보스 일정은 목록에서 뺀다(`@/lib/domain/boss-scope`). 런 작성기가 일간을
     *   더는 제안하지 않으므로 새로 생길 일은 없고, 과거에 만들어진 것만 걸린다.
     *   **빼는 쪽이 맞는 이유**: 여기 체크박스는 수익에 반영하려고 누르는 것인데,
     *   일간은 집계에서 제외되므로 체크해도 금액이 움직이지 않는다. 남겨 두면 화면이
     *   "누르면 반영된다"고 거짓말하게 된다. 런 자체는 지우지 않으며 일정 화면에 그대로 있다.
     */
    .filter((row) => isTrackedBossCycle(bosses.get(row.boss_difficulty_id)?.cycle))
    .map((row) => {
    const characterId = characterIdBySignup.get(row.id) ?? null;
    const boss = bosses.get(row.boss_difficulty_id);
    const info = runInfo.get(row.id);
    const clear =
      clearByRunId.get(row.id) ??
      (characterId === null
        ? undefined
        : clearByCharacterBoss.get(`${characterId}::${row.boss_difficulty_id}`));

    return {
      runId: row.id,
      runNo: row.run_no,
      partyId: row.party_id,
      partyName: partyNameById.get(row.party_id) ?? "이름 없는 파티",
      bossDifficultyId: row.boss_difficulty_id,
      bossDisplayName: boss?.displayName ?? row.boss_difficulty_id,
      difficulty: boss?.difficulty ?? "normal",
      cycle: boss?.cycle ?? "weekly",
      scheduledAt: row.scheduled_at,
      entryPartySize: entryPartySizeOf(row),
      goingCount: info?.goingCount ?? 0,
      maxParty: boss?.maxParty ?? null,
      characterId,
      characterName:
        characterId === null ? null : (characters.get(characterId)?.name ?? null),
      crystalPriceMeso: boss?.crystalPriceMeso ?? null,
      cleared: clear?.effective_cleared ?? false,
      manualCleared: clear?.manual_cleared ?? null,
      apiCleared: clear?.api_cleared ?? null,
      hasConflict: clear?.has_conflict ?? false,
      winner: clear === undefined ? "none" : resolveWinner(clear),
      clearId: clear?.id ?? null,
    };
  });

  // 시각 미정(null)은 맨 뒤 — 조율 중인 일정이다. 동률이면 등록 번호 순.
  runs.sort((a, b) => {
    const at = a.scheduledAt === null ? Infinity : Date.parse(a.scheduledAt);
    const bt = b.scheduledAt === null ? Infinity : Date.parse(b.scheduledAt);
    return at - bt || a.runNo - b.runNo;
  });

  return { runs, runIds: runs.map((run) => run.runId) };
}

/**
 * 아직 팔지 않은 드랍 목록.
 *
 * `sale_amount_meso` 가 `null` 이면 **아직 안 판 것이지 0원에 판 것이 아니다**(§8-6).
 * 정산 뷰에는 아예 나타나지 않으므로 합계와 별개로 여기서 건수·품목만 보여 준다.
 */
async function loadUnsoldDrops(
  db: AdminDb,
  weekKey: WeekKey,
  runIds: readonly string[],
  bosses: Map<string, BossInfo>,
  runInfoByRunId: Map<string, RunInfo>,
): Promise<readonly UnsoldDrop[]> {
  if (runIds.length === 0) return [];

  const rows = unwrap(
    await db
      .from("run_drops")
      .select("id,run_id,item_name,created_at")
      .in("run_id", [...runIds])
      .eq("week_key", weekKey)
      .is("sale_amount_meso", null),
    "미판매 드랍 조회",
  );

  return rows
    .map((row) => {
      const run = runInfoByRunId.get(row.run_id);
      const boss =
        run === undefined ? undefined : bosses.get(run.bossDifficultyId);
      return {
        dropId: row.id,
        itemName: row.item_name,
        runId: row.run_id,
        bossDisplayName: boss?.displayName ?? run?.bossDifficultyId ?? "",
        recordedAt: row.created_at,
      };
    })
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

function toTotals(
  weekKey: WeekKey,
  summary: Awaited<ReturnType<typeof fetchWeeklyIncome>>,
): WeeklyIncomeTotals | null {
  if (summary === null) return null;
  return {
    weekKey,
    crystalIncomeMeso: summary.crystalIncomeMeso,
    dropIncomeMeso: summary.dropIncomeMeso,
    totalIncomeMeso: summary.totalIncomeMeso,
    clearCount: summary.clearCount,
    weeklyClearCount: summary.weeklyClearCount,
    unknownPriceCount: summary.unknownPriceCount,
    weeklyOverLimitCount: summary.weeklyOverLimitCount,
    dropCount: summary.dropCount,
    unsoldDropCount: summary.unsoldDropCount,
  };
}

/**
 * 주간 수익 화면 전체.
 *
 * **2단 구조다** — 캐릭터별(12 상한이 적용되는 층) → 사용자 합계. 두 층 모두 뷰가 낸
 * 값을 그대로 옮긴다.
 */
export async function fetchWeeklyIncomeDetail(
  userId: string,
  weekKey: WeekKey,
): Promise<WeeklyIncomeDetail> {
  const db = getAdminDb();

  /*
   * 계정 천장(90개)과 일간 뺄셈은 같은 원장에서 나온다. 먼저 띄워 두고 `fetchWeeklyIncome`
   * 에 그대로 넘겨, 같은 주차의 `boss_clears` 를 두 번 읽지 않는다.
   */
  const scopePromise = fetchWeeklyCrystalScope(userId, weekKey, db);

  const [summary, byCharacterRows, allClearRows, characterOptions, scope] =
    await Promise.all([
      scopePromise.then((resolved) =>
        fetchWeeklyIncome(userId, weekKey, resolved),
      ),
      (async () =>
        unwrap(
          await db
            .from("v_weekly_crystal_income_by_character")
            .select(BY_CHARACTER_COLUMNS)
            .eq("user_id", userId)
            .eq("week_key", weekKey),
          "캐릭터별 주간 수익 조회",
        ))(),
      (async () =>
        unwrap(
          await db
            .from("boss_clears")
            .select(CLEAR_COLUMNS)
            .eq("user_id", userId)
            .eq("week_key", weekKey),
          "이번 주 클리어 조회",
        ))(),
      /*
       * 수정 모달의 캐릭터 드롭다운 후보.
       *
       * ★ 일정 화면의 함수를 **그대로 재사용**한다. 후보 규칙("추적 중인 내 캐릭터만",
       *   §2.1.1)과 정렬(본캐 → 레벨 내림차순)이 두 화면에서 같아야 하는데, 같은 규칙을
       *   두 번 구현하면 언젠가 한쪽만 바뀐다. 이미 `fetchWeeklyIncome`(대시보드)을 같은
       *   이유로 재사용하고 있다.
       */
      fetchMyRunCharacters(userId),
      scopePromise,
    ]);

  /*
   * ★ **일간 보스 행을 먼저 떼어 낸다** (`@/lib/domain/boss-scope`).
   *
   *   판정은 **엔트리(난이도) 단위**다. `boss_clears.cycle` 은 클리어 시점 스냅샷이라
   *   가장 정확하지만 아직 안 깬 행에서는 비어 있으므로, 그때만 보스 마스터의 현재
   *   주기로 보충한다. 둘 다 모르면 남긴다 — 모르는 것을 일간으로 단정해 지우면
   *   사용자의 기록이 조용히 사라진다.
   *
   *   행을 **삭제하지는 않는다.** DB 에는 그대로 있고 화면·집계에서만 빠진다.
   */
  const bosses = await loadBossInfo(
    db,
    unique(allClearRows.map((row) => row.boss_difficulty_id)),
  );
  const clearRows = allClearRows.filter((row) =>
    isTrackedBossCycle(row.cycle ?? bosses.get(row.boss_difficulty_id)?.cycle),
  );

  /*
   * ★ **집계에 반영되지 않는 행(`effective_cleared = false`)까지 들고 있는다.**
   *
   *   수익 목록에는 당연히 반영된 것만 올라간다. 하지만 일정의 체크 상태와 충돌 배지는
   *   반영되지 않은 행에서 나온다 — 사람이 "안 깼다"고 체크했는데 넥슨은 "깼다"고 하는
   *   경우가 정확히 그것이고(`manual_cleared=false` + `api_cleared=true` →
   *   `effective_cleared=false` + `has_conflict=true`), 그게 사용자가 가장 알아야 하는
   *   상태다. 반영된 행만 읽으면 그 충돌이 화면에서 **통째로 사라진다.**
   *   (실제로 그렇게 만들었다가 검증에서 잡혔다.)
   */
  const effectiveClearRows = clearRows.filter((row) => row.effective_cleared);

  const [characters, clearRunInfo] = await Promise.all([
    loadCharacters(
      db,
      unique(
        [
          ...clearRows.flatMap((row) =>
            row.character_id === null ? [] : [row.character_id],
          ),
          ...byCharacterRows.flatMap((row) =>
            row.character_id === null ? [] : [row.character_id],
          ),
        ],
      ),
    ),
    loadRunInfo(
      db,
      unique(clearRows.flatMap((row) => (row.run_id === null ? [] : [row.run_id]))),
    ),
  ]);

  const { runs, runIds } = await loadScheduledRunClears(
    db,
    userId,
    weekKey,
    clearRows,
    bosses,
  );

  // 미판매 드랍은 **내가 참여한 이번 주 런**의 것만 본다. `v_weekly_income.unsoldDropCount`
  // 와 같은 모집단이며, 그 건수 자체는 뷰가 센 값을 쓴다(우리는 목록만 만든다).
  const allRunInfo = new Map(clearRunInfo);
  if (runIds.length > 0) {
    const extra = await loadRunInfo(db, runIds);
    for (const [id, info] of extra) allRunInfo.set(id, info);
  }
  const unsoldDrops = await loadUnsoldDrops(
    db,
    weekKey,
    unique([...runIds, ...clearRunInfo.keys()]),
    bosses,
    allRunInfo,
  );

  // 수익 목록은 **집계에 반영된 것만** 올린다. 반영되지 않은 행은 위 일정 목록에서
  // 체크 상태와 충돌 배지로 이미 드러난다.
  const clearsByCharacter = new Map<string, ClearRecord[]>();
  for (const row of effectiveClearRows) {
    const record = toClearRecord(
      row,
      bosses.get(row.boss_difficulty_id),
      row.character_id === null ? undefined : characters.get(row.character_id),
      row.run_id === null ? undefined : allRunInfo.get(row.run_id),
    );
    const key = row.character_id ?? "";
    const list = clearsByCharacter.get(key) ?? [];
    list.push(record);
    clearsByCharacter.set(key, list);
  }
  for (const list of clearsByCharacter.values()) {
    // 금액 큰 순 — 12 상한이 걸리는 지점이 위로 온다. 동률이면 이름으로 안정 정렬.
    list.sort(
      (a, b) =>
        (b.shareMeso ?? -1) - (a.shareMeso ?? -1) ||
        a.bossDisplayName.localeCompare(b.bossDisplayName, "ko-KR"),
    );
  }

  /*
   * 캐릭터별 층 — 뷰 값에서 **그 캐릭터의 일간분만** 뺀다.
   *
   * 뺄셈이 순위를 흔들지 않는 이유(12개 절삭은 주간 행에만 걸린다)는 `./crystal-scope`
   * 머리말에 있다. 여기서 다시 합산하지 않는 것이 핵심이다 — 다시 합산했다면 12개
   * 절삭 규칙이 TS 에 복제됐을 것이다.
   */
  const characterIncomes: CharacterIncome[] = byCharacterRows.flatMap((row) => {
    const key = row.character_id ?? "";
    const info = row.character_id === null ? undefined : characters.get(key);
    const excluded = excludedDailyFor(scope, row.character_id);

    /*
     * 검산: 뷰가 센 일간 건수와 우리가 원장에서 센 일간 건수는 같아야 한다. 어긋나면
     * 뺄셈의 전제가 깨진 것이므로 조용히 넘어가지 않고 로그로 드러낸다(화면은 계속 그린다 —
     * 숫자를 안 보여 주는 것보다 낫다).
     */
    const viewDailyCount = toCount(row.daily_clear_count);
    if (viewDailyCount !== excluded.count) {
      console.warn(
        `[income-repo] 일간 건수 불일치(character=${key || "미지정"}): 뷰 ${viewDailyCount} vs 원장 ${excluded.count}`,
      );
    }

    const clearCount = Math.max(toCount(row.clear_count) - excluded.count, 0);
    // 일간만 있던 캐릭터는 이제 이 화면에 존재할 이유가 없다. 0건 카드를 만들지 않는다.
    if (clearCount === 0) return [];

    return [
      {
        characterId: row.character_id,
        characterName: info?.name ?? "삭제된 캐릭터",
        worldName: info?.worldName ?? null,
        incomeMeso: subtractDailyMeso(toSafeMeso(row.income_meso), excluded),
        clearCount,
        // 주간·월간 카운트는 손대지 않는다 — 일간이 들어간 적 없는 숫자다.
        weeklyClearCount: toCount(row.weekly_clear_count),
        monthlyClearCount: toCount(row.monthly_clear_count),
        unknownPriceCount: Math.max(
          toCount(row.unknown_price_count) - excluded.unknownPriceCount,
          0,
        ),
        weeklyOverLimitCount: toCount(row.weekly_over_limit_count),
        // 12 를 코드에 박지 않는다 — `weekly_crystal_sell_limit()` 이 유일한 출처다.
        weeklySellLimit: toCount(row.weekly_sell_limit),
        clears: clearsByCharacter.get(key) ?? [],
      },
    ];
  });

  characterIncomes.sort(
    (a, b) =>
      (b.incomeMeso ?? -1) - (a.incomeMeso ?? -1) ||
      a.characterName.localeCompare(b.characterName, "ko-KR"),
  );

  return {
    weekKey,
    totals: toTotals(weekKey, summary),
    characters: characterIncomes,
    runs,
    unsoldDrops,
    characterOptions,
    accountCrystalUsage: scope.accounts,
    unassignedCrystalCount: scope.unassignedCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기 — Route Handler(service_role) + 세션 검증을 거친다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 파티 인원 수정 (§1.3 D3 — "인원은 사용자가 고칠 수 있어야 한다").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 재계산도 확인 비트도 **DB 함수 하나에 맡긴다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `set_clear_party_size(clear_id, party_size)` 가 전부 한다:
 *   1) `party_size` 를 고치고 `party_size_confirmed` 를 true 로 올린다
 *      — "인원이 2명 맞다"는 확인 행위 자체가 결과이므로 값이 이미 같아도 호출한다.
 *   2) 재스냅샷을 유도해 pot·share_bp·crystal_share_meso 를 다시 만든다. 이때
 *      `cycle` 과 시세 스냅샷은 **보존**된다 — 보스 주기는 패치로 바뀌는데
 *      `boss_difficulties.cycle` 에는 이력이 없어 재조회가 곧 과거 덮어쓰기이기 때문이다.
 *   3) 런에 걸린 기록이면 `party_runs.entry_party_size` 와 **그 런의 모든 클리어**를 함께
 *      고치고 `recompute_run_crystal_shares()` 로 분배 몫까지 맞춘다.
 *      "몇 명이 입장했는가"는 개인이 아니라 그 입장 자체의 사실이라, 내 행만 고치면 같은
 *      런의 참가자들이 서로 다른 pot 을 갖게 되고 `v_run_crystal_settlement` 가 어긋난다.
 *
 * ★ 그래서 이 함수는 `boss_clears` 를 **직접 UPDATE 하지 않는다.** 직접 UPDATE 는
 *   재스냅샷 규칙을 애플리케이션에 복제하는 일이고, 확인 비트도 올리지 못한다.
 *
 * ★ 소유권 검사만 여기 남는다. RPC 는 service_role 전용이고 소유권을 보지 않기 때문이다
 *   (`recompute_run_crystal_shares()` 와 같은 규약). 런 전체를 고칠 권한은 "그 런에 내
 *   클리어 기록이 있다" = 그 입장에 참여했다는 사실로 충분하다.
 *
 * ★ `max_party` 는 **막지 않는다** (§1.3 D5). 값 대부분이 세대 규칙에서 유도된 것이라
 *   실제 파티가 그 값을 넘는데 저장이 거부되면 사용자가 앱을 못 쓴다. 초과는 화면이
 *   경고로 처리한다. DB CHECK 범위(1~24)만 여기서 지킨다.
 */
export async function updateClearPartySize(
  userId: string,
  clearId: string,
  partySize: number,
): Promise<void> {
  if (
    !Number.isInteger(partySize) ||
    partySize < PARTY_SIZE_MIN ||
    partySize > PARTY_SIZE_MAX
  ) {
    throw ApiError.badRequest(
      `파티 인원은 ${PARTY_SIZE_MIN}명 이상 ${PARTY_SIZE_MAX}명 이하여야 합니다.`,
    );
  }

  const db = getAdminDb();

  // 소유권 확인 — `set_clear_party_size()` 는 service_role 전용이고 소유권을 보지 않는다
  // (`recompute_run_crystal_shares()` 와 같은 규약). 그 검사는 여기, 호출자 몫이다.
  const { data: clear, error } = await db
    .from("boss_clears")
    .select("id")
    .eq("id", clearId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null) {
    console.error(`[income-repo] 클리어 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  // 없는 기록과 남의 기록을 구분하지 않는다.
  if (clear === null) throw clearNotFound();

  const { error: rpcError } = await db.rpc("set_clear_party_size", {
    p_clear_id: clearId,
    p_party_size: partySize,
  });
  if (rpcError !== null) {
    console.error(`[income-repo] 파티 인원 수정 실패: ${rpcError.message}`);
    throw ApiError.internal();
  }
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 클리어를 **다른 내 캐릭터에 귀속**시킨다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 수정 모달의 주 조작이다. 근거는 §1: **일정과 클리어의 단위는 사람이 아니라 캐릭터**이고,
 * 주간 결정석 12개 상한도 **캐릭터당**이다. 넥슨 동기화가 붙인 캐릭터가 실제로 그 판을
 * 돈 캐릭터와 다르면 12 카운터가 엉뚱한 캐릭터에서 차오른다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 금액은 **바뀌지 않는다.** 바뀌는 것은 귀속이다
 * ─────────────────────────────────────────────────────────────────────────────
 * `resolve_crystal_payout(run_id, user_id, pot, party_size)` 는 **사람 단위**로 몫을 정한다.
 * 내 캐릭터끼리 옮기는 것은 `user_id` 를 바꾸지 않으므로 내 몫도 pot 도 그대로다.
 * 그래서 이 함수는 **재스냅샷을 유도하지 않는다** — `price_snapshotted_at` 을 건드리지
 * 않으므로 트리거의 금액 블록이 아예 돌지 않고, `cycle` · 시세 스냅샷도 안전하다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `world_name` 은 **일부러 `null` 로 넘긴다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 트리거는 `world_name is null and character_id is not null` 일 때만 월드를 채운다.
 * 그냥 캐릭터만 바꾸면 **이전 캐릭터의 월드 스냅샷이 그대로 남아** 이 컬럼과
 * `boss_clears_world_week_idx` 가 잘못된 월드를 말한다. 크로스월드 이동이 흔한 구조는
 * 아니지만, 틀린 월드가 조용히 남는 쪽이 훨씬 나쁘다.
 *
 * ⚠️ **주 90개 천장은 이제 월드가 아니라 넥슨 계정 단위다**(§1.3 D2 — 2026-08-18 정정).
 *    그 집계는 `character_id → nexon_account_ref` 조인으로 하며(`./crystal-scope`),
 *    `world_name` 스냅샷을 쓰지 않는다. 그래도 이 컬럼을 계속 바르게 유지하는 이유는
 *    월드가 표시·정렬에 여전히 쓰이고, 틀린 값을 남기면 나중에 되살릴 수 없기 때문이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 런에 걸린 클리어면 **그 런의 내 참여 캐릭터도 함께 고친다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `run_signups.character_id` 가 "이 일정에 어느 캐릭터로 간다"의 출처다. 클리어만 고치면
 * 일정 화면과 수익 화면이 서로 다른 캐릭터를 말하게 되고, 다음에 그 런을 다시 체크할 때
 * `setRunClear()` 가 signup 의 캐릭터로 새 클리어를 만들어 **같은 판이 두 캐릭터에
 * 기록된다.** 두 곳이 같은 사실을 들고 있으므로 함께 옮긴다.
 *
 * ⚠️ 남의 캐릭터는 **400** 이다(없는 기록·남의 기록의 404 와 다르다). 이 값은 사용자가
 *    고른 목록에서 오므로 존재를 숨길 이유가 없고, 화면은 "목록을 새로 불러오라"고
 *    안내해야 한다 — 일정 화면과 같은 규약이다.
 */
export async function updateClearCharacter(
  userId: string,
  clearId: string,
  characterId: string,
): Promise<void> {
  const db = getAdminDb();

  const { data: clear, error } = await db
    .from("boss_clears")
    .select("id,character_id,boss_difficulty_id,week_key,run_id")
    .eq("id", clearId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null) {
    console.error(`[income-repo] 클리어 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  // 없는 기록과 남의 기록을 구분하지 않는다.
  if (clear === null) throw clearNotFound();

  // 같은 캐릭터면 할 일이 없다. `set_clear_party_size()` 와 달리 여기에는 "확인했다"는
  // 상태가 없으므로, 같은 값 재저장이 만들어 낼 결과가 아예 없다.
  if (clear.character_id === characterId) return;

  // 내 것이고 추적 중인 캐릭터인가. 두 조건을 한 쿼리에 함께 건다 — 소유만 보면 화면이
  // 주지 않는 값을 API 로 직접 보내 추적하지 않는 캐릭터에 수익을 귀속시킬 수 있고,
  // 그 캐릭터는 동기화 대상이 아니라 인게임과 영영 대조되지 않는다(§2.1.1).
  const ownedRows = unwrap(
    await db
      .from("characters")
      .select("id")
      .eq("id", characterId)
      .eq("user_id", userId)
      .eq("is_tracked", true)
      .limit(1),
    "캐릭터 소유 확인",
  );
  if (ownedRows[0] === undefined) {
    throw ApiError.badRequest(
      "내 추적 캐릭터가 아닙니다. 캐릭터 목록을 새로 불러오거나 추적 대상에 추가해 주세요.",
    );
  }

  /*
   * `unique nulls not distinct (user_id, character_id, boss_difficulty_id, week_key)`.
   * 옮기려는 캐릭터가 그 주에 같은 보스를 이미 깬 것으로 되어 있으면 23505 가 난다.
   * 먼저 읽어서 **무엇이 막았는지 말해 주는 400** 으로 접는다 — 500 을 던지면 사용자는
   * 자기 데이터의 문제인지 우리 장애인지 구분할 수 없다.
   */
  const duplicateRows = unwrap(
    await db
      .from("boss_clears")
      .select("id")
      .eq("user_id", userId)
      .eq("character_id", characterId)
      .eq("boss_difficulty_id", clear.boss_difficulty_id)
      .eq("week_key", clear.week_key)
      .neq("id", clearId)
      .limit(1),
    "중복 클리어 확인",
  );
  if (duplicateRows[0] !== undefined) {
    throw ApiError.badRequest(
      "그 캐릭터는 이번 주에 이 보스를 이미 클리어한 것으로 기록돼 있습니다. 한 캐릭터가 같은 주에 같은 보스를 두 번 기록할 수는 없습니다.",
    );
  }

  const { error: updateError } = await db
    .from("boss_clears")
    .update({
      character_id: characterId,
      // ★ 월드 스냅샷을 비워 트리거가 **새 캐릭터의 월드**로 다시 찍게 한다.
      world_name: null,
    })
    .eq("id", clearId)
    .eq("user_id", userId);
  if (updateError !== null) {
    console.error(`[income-repo] 클리어 캐릭터 변경 실패: ${updateError.message}`);
    throw ApiError.internal();
  }

  if (clear.run_id === null) return;

  // 런에 걸린 기록이면 그 런의 **내** 참여 행도 같은 캐릭터로 맞춘다.
  const participantIds = await loadMyParticipantIds(db, userId);
  if (participantIds.length === 0) return;

  const { error: signupError } = await db
    .from("run_signups")
    .update({ character_id: characterId })
    .eq("run_id", clear.run_id)
    .in("participant_id", participantIds);
  if (signupError !== null) {
    console.error(`[income-repo] 일정 참여 캐릭터 동기화 실패: ${signupError.message}`);
    throw ApiError.internal();
  }
}

/**
 * 일정을 클리어로 표시 / 해제 (§1.2 2순위 — "클리어 체크 → 그 주 수익 자동 합산").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 관측을 **덮어쓰지 않는다** (DB-SCHEMA 난제 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * 우리는 `manual_cleared` / `manual_set_at` **두 컬럼만** 쓴다. `api_cleared` 는 손대지
 * 않는다. 승자 판정은 트리거가 하고(관측 시각이 최신인 쪽, 동률이면 사람),
 * 두 값이 다르면 `has_conflict` 가 켜져 화면이 "어느 쪽이 반영됐는지"를 보여 준다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `cleared_at` 을 **명시로 넘기는 이유**
 * ─────────────────────────────────────────────────────────────────────────────
 * 트리거는 `cleared_at` 이 비어 있으면 `manual_set_at`(= 지금)으로 채운다. 지난주 일정을
 * 뒤늦게 체크하면 그 순간 주차가 이번 주로 바뀌어 수익이 엉뚱한 주에 붙고,
 * `week_key = week_key(cleared_at)` CHECK 도 깨진다.
 *   → 그래서 **그 일정이 잡힌 시각**을 클리어 시각으로 넘긴다. §1.3 D1(수익은 클리어
 *     주차에 귀속)과 같은 기조다. 시각 미정 일정은 지금으로 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 새 기록의 파티 인원 = **그 런의 입장 인원** (§1.3 D3 · 이번 결함의 핵심)
 * ─────────────────────────────────────────────────────────────────────────────
 * DB 기본값 1 을 그대로 두면 6인 파티 보스가 6배로 잡힌다. 우리 런과 연결된 클리어는
 * 인원을 이미 알고 있으므로(`entry_party_size`, 없으면 `capacity`) 그 값을 쓴다.
 * 넥슨 관측으로 먼저 만들어져 있던 행도 여기서 런에 연결되면서 같은 보정을 받는다 —
 * 단, **사용자가 이미 고친 값은 건드리지 않는다.**
 */
export async function setRunClear(
  userId: string,
  runId: string,
  cleared: boolean,
): Promise<void> {
  const db = getAdminDb();

  const { data: run, error: runError } = await db
    .from("party_runs")
    .select(
      "id,party_id,boss_difficulty_id,scheduled_at,capacity,entry_party_size,cancelled_at,status",
    )
    .eq("id", runId)
    .maybeSingle();
  if (runError !== null) {
    console.error(`[income-repo] 일정 조회 실패: ${runError.message}`);
    throw ApiError.internal();
  }
  if (run === null) throw runNotFound();
  if (run.cancelled_at !== null || run.status === "cancelled") {
    throw ApiError.badRequest("취소된 일정은 클리어로 표시할 수 없습니다.");
  }

  // 파티 구성원인지 먼저 본다. 아니면 일정의 존재조차 알리지 않는다.
  const { data: participant, error: participantError } = await db
    .from("party_participants")
    .select("id")
    .eq("party_id", run.party_id)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (participantError !== null) {
    console.error(`[income-repo] 파티 구성원 조회 실패: ${participantError.message}`);
    throw ApiError.internal();
  }
  if (participant === null) throw runNotFound();

  const { data: signup, error: signupError } = await db
    .from("run_signups")
    .select("id,character_id,status")
    .eq("run_id", runId)
    .eq("participant_id", participant.id)
    .maybeSingle();
  if (signupError !== null) {
    console.error(`[income-repo] 참여 조회 실패: ${signupError.message}`);
    throw ApiError.internal();
  }
  if (signup === null || signup.status !== "going") {
    throw new ApiError(
      "bad_request",
      "참여(going)로 등록한 일정만 클리어로 표시할 수 있습니다.",
      403,
    );
  }
  if (signup.character_id === null) {
    // 12개 상한이 **캐릭터당**이라(§1) 캐릭터 없이는 수익을 귀속시킬 곳이 없다.
    throw ApiError.badRequest(
      "이 일정에 데려갈 캐릭터를 먼저 지정해 주세요. 클리어 수익은 캐릭터별로 집계됩니다.",
    );
  }

  const characterId = signup.character_id;
  const nowIso = new Date().toISOString();
  const clearedAtIso = run.scheduled_at ?? nowIso;
  const weekKey = getWeekKey(new Date(clearedAtIso));

  const { data: existing, error: existingError } = await db
    .from("boss_clears")
    .select("id,run_id,party_size_confirmed,api_cleared,cleared_at")
    .eq("user_id", userId)
    .eq("character_id", characterId)
    .eq("boss_difficulty_id", run.boss_difficulty_id)
    .eq("week_key", weekKey)
    .maybeSingle();
  if (existingError !== null) {
    console.error(`[income-repo] 기존 클리어 조회 실패: ${existingError.message}`);
    throw ApiError.internal();
  }

  if (!cleared) {
    if (existing === null) return;

    // `boss_clears` 는 클리어의 **원장**이고 "안 깼다"는 행의 부재로 표현된다.
    // 넥슨 관측이 없는 행이면 지워서 원장을 깨끗하게 두고, 관측이 있으면 남겨야
    // 한다 — 지우면 "사람이 아니라고 했다"는 사실 자체가 사라져 다음 동기화가
    // 다시 클리어로 만들어 버린다.
    if (existing.api_cleared === null) {
      const { error } = await db
        .from("boss_clears")
        .delete()
        .eq("id", existing.id)
        .eq("user_id", userId);
      if (error !== null) {
        console.error(`[income-repo] 클리어 해제 실패: ${error.message}`);
        throw ApiError.internal();
      }
      return;
    }

    const { error } = await db
      .from("boss_clears")
      .update({ manual_cleared: false, manual_set_at: nowIso })
      .eq("id", existing.id)
      .eq("user_id", userId);
    if (error !== null) {
      console.error(`[income-repo] 클리어 해제 실패: ${error.message}`);
      throw ApiError.internal();
    }
    return;
  }

  const entryPartySize = entryPartySizeOf(run);

  if (existing === null) {
    const { error } = await db.from("boss_clears").insert({
      user_id: userId,
      character_id: characterId,
      boss_difficulty_id: run.boss_difficulty_id,
      run_id: runId,
      week_key: weekKey,
      cleared_at: clearedAtIso,
      manual_cleared: true,
      manual_set_at: nowIso,
      // ★ 1 이 아니라 그 런의 입장 인원. 이 한 줄이 6배 과대 계상을 막는다.
      party_size: entryPartySize,
      source: "manual",
    });
    if (error !== null) {
      console.error(`[income-repo] 클리어 기록 실패: ${error.message}`);
      throw ApiError.internal();
    }
    return;
  }

  /*
   * 이미 있는 행을 켤 때 인원을 손대는 조건은 **하나뿐**이다:
   * 아직 아무도 인원을 확인한 적이 없는 행(`party_size_confirmed = false`)일 때.
   * 사용자가 확인해 둔 값(§1.3 D3)을 여기서 되돌리면 안 된다.
   *
   * 함께 붙은 런 조건은 추론이 아니라 **어느 런의 인원을 적용할 것인가**의 문제다.
   * `existing` 이 이미 다른 런에 걸려 있으면 그 런의 입장 인원이 따로 있으므로,
   * 이번 런의 값을 씌우면 남의 런 정산을 흔든다. 그래서 미연결이거나 같은 런일 때만 채택한다.
   */
  const adoptEntrySize =
    !existing.party_size_confirmed &&
    (existing.run_id === null || existing.run_id === runId);

  const { error } = await db
    .from("boss_clears")
    .update({
      manual_cleared: true,
      manual_set_at: nowIso,
      run_id: existing.run_id ?? runId,
      cleared_at: existing.cleared_at ?? clearedAtIso,
    })
    .eq("id", existing.id)
    .eq("user_id", userId);
  if (error !== null) {
    console.error(`[income-repo] 클리어 표시 실패: ${error.message}`);
    throw ApiError.internal();
  }

  if (!adoptEntrySize) return;

  /*
   * 인원 채택도 **전용 함수를 통해서만** 한다(위 `updateClearPartySize` 와 같은 이유).
   * 직접 UPDATE 로 `price_snapshotted_at: null` 을 넘기면 재스냅샷 규칙이 여기에도 복제되고
   * `party_size_confirmed` 도 올라가지 않아 이 행이 영원히 "확인 필요"로 남는다.
   * 위 UPDATE 로 이미 런에 걸렸으므로 함수는 런 전체를 같은 인원으로 맞추고 분배까지 끝낸다.
   * 값이 이미 같아도 호출한다 — 그 확인 자체가 결과다.
   */
  const { error: sizeError } = await db.rpc("set_clear_party_size", {
    p_clear_id: existing.id,
    p_party_size: entryPartySize,
  });
  if (sizeError !== null) {
    console.error(`[income-repo] 클리어 인원 채택 실패: ${sizeError.message}`);
    throw ApiError.internal();
  }
}
