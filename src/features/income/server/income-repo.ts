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
import { getBossEntryMap } from "@/lib/boss-master";
import { isTrackedBossCycle } from "@/lib/domain/boss-scope";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { getWeekKey } from "@/lib/time/week";

import { monthKeyOfWeek, weekEndOfKey, weekStartOfKey } from "../lib/week-range";

import {
  excludedDailyFor,
  fetchWeeklyCrystalScope,
  subtractDailyMeso,
} from "./crystal-scope";
import {
  buildCrystalIncomeSummary,
  fetchCrystalPotential,
  fetchMonthlyCrystalIncome,
} from "./crystal-summary";
import type {
  BossCycle,
  BossDifficultyTier,
  MesoOrUnknown,
  WeekKey,
} from "@/types/domain";

import type {
  AddRunDropInput,
  CharacterIncome,
  ClearRecord,
  ClearSource,
  ClearWinner,
  CrystalCycleTally,
  DropShareMode,
  IncomeCharacterOption,
  IncomeLedgerResponse,
  LedgerDrop,
  RunDropParticipant,
  RunDropRecord,
  ScheduledRunClear,
  UnsoldDrop,
  UpdateRunDropInput,
  WeekLedgerEntry,
  WeeklyBossSlots,
  WeeklyIncomeDetail,
  WeeklyIncomeTotals,
} from "../types";

/**
 * 드랍 목록을 만들기 전 단계의 일정 행. 드랍은 **런 id 가 정해진 뒤에야** 읽을 수 있으므로
 * (`loadRunDrops` 의 입력이 그 id 들이다) 두 필드는 호출부에서 마지막에 붙인다.
 */
type ScheduledRunBase = Omit<ScheduledRunClear, "drops" | "dropParticipants">;

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

/**
 * 보스 **표시 정보**. `v_boss_catalog` 왕복을 코드 상수로 바꿨다(`@/lib/boss-master`).
 *
 * ⚠️ **정산은 여전히 DB 가 소유한다.** 클리어에 굳는 금액은
 *    `current_crystal_price(boss, cleared_at)` 가 **클리어 시점 기준**으로 정하고
 *    `resolve_crystal_payout` 이 나눈다(웹과 카톡 봇이 같은 답을 내야 한다). 여기서
 *    쓰는 `crystalPriceMeso` 는 "지금 시세" 표시용이며 과거 기록을 덮지 않는다.
 */
function loadBossInfo(
  bossDifficultyIds: readonly string[],
): Map<string, BossInfo> {
  const map = new Map<string, BossInfo>();
  if (bossDifficultyIds.length === 0) return map;

  for (const [id, entry] of getBossEntryMap(bossDifficultyIds)) {
    map.set(id, {
      // `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태로 난이도를 포함한다.
      displayName: entry.koreanName,
      difficulty: entry.difficulty,
      cycle: entry.cycle,
      maxParty: entry.maxParty,
      // ★ `null` 은 0 이 아니라 미확인이다 (§1.3 D4).
      crystalPriceMeso: toSafeMeso(entry.crystalPriceMeso),
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
  if (runIds.length === 0) return new Map();

  const runRows = unwrap(
    await db
      .from("party_runs")
      .select(
        "id,party_id,run_no,boss_difficulty_id,scheduled_at,capacity,entry_party_size",
      )
      .in("id", [...runIds]),
    "일정 조회",
  );
  return buildRunInfo(db, runRows);
}

/**
 * **이미 읽어 온 런 행**으로 `RunInfo` 를 만든다 — 파티 이름과 참여 인원만 더 읽는다.
 *
 * 왜 나눴는가(2026-08-18 성능 작업): `loadScheduledRunClears` 는 이번 주 런을 이미
 * 한 번 읽어 놓고도 `loadRunInfo(id[])` 를 불러 **같은 행을 다시** 읽고 있었다.
 * 원격 Supabase 왕복이 1회 ≈ 78ms 인 환경에서 그 한 단계가 그대로 지연이다.
 */
async function buildRunInfo(
  db: AdminDb,
  runRows: readonly {
    readonly id: string;
    readonly party_id: string;
    readonly run_no: number;
    readonly boss_difficulty_id: string;
    readonly scheduled_at: string | null;
    readonly capacity: number;
    readonly entry_party_size: number | null;
  }[],
): Promise<Map<string, RunInfo>> {
  const map = new Map<string, RunInfo>();
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
 *
 * ★ **2026-08-19 이후 이 함수는 사실상 언제나 `false` 를 돌려준다.** 판정식은 한 글자도
 *   바뀌지 않았고, 바뀐 것은 **DB 가 담는 값**이다: 파티 인원의 기본값이 1인 확정이 되면서
 *   (발주자 지시) `sync-scheduler.ts` 가 넥슨 클리어를 `party_size_confirmed = true` 로
 *   넣고, 이미 쌓여 있던 행은 마이그레이션 25 가 올렸다.
 *   여기를 고치지 않은 것이 의도다 — 화면 판정을 DB 사실에서 떼어 내는 순간, 마이그레이션
 *   20 이 없앤 "추론으로 만든 오탐"이 그대로 되살아난다.
 *   ⚠️ 대가: 실제로는 파티였던 클리어가 아무 경고 없이 1인으로 계산된다(§1.3 D3).
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
  participantIds: readonly string[],
  weekKey: WeekKey,
  clearRows: readonly ClearRow[],
  bosses: Map<string, BossInfo>,
): Promise<{
  readonly runs: readonly ScheduledRunBase[];
  readonly runIds: readonly string[];
  /** 여기서 이미 만든 런 정보. 호출부가 **다시 읽지 않도록** 함께 돌려준다. */
  readonly runInfo: ReadonlyMap<string, RunInfo>;
}> {
  /*
   * ★ `participantIds` 를 인자로 받는다(2026-08-18 성능 작업). 예전에는 이 함수가
   *   직접 읽어서, 호출부의 큰 `Promise.all` 이 끝난 **뒤에야** 그 왕복이 시작됐다.
   *   내 파티 참가자 목록은 아무것도 기다릴 필요가 없으므로 호출부에서 함께 띄운다.
   */
  const EMPTY = { runs: [], runIds: [], runInfo: new Map<string, RunInfo>() };
  if (participantIds.length === 0) return EMPTY;

  /*
   * ★ **신청 → 런 의 직렬 2단이 1단이 됐다** (2026-08-18 성능 작업).
   *   뒤 조회는 앞 결과를 **필터로만** 썼다(`in(id, 내 신청의 run_id)`). 그건 곧
   *   `run_signups → party_runs` FK 를 따라간 것이고, PostgREST 임베딩이 정확히 그 일을
   *   한 번에 한다. `!inner` 라 조건에 맞는 런이 없는 신청은 부모째로 빠진다 —
   *   `in(...)` + 별도 필터와 같은 모집단이다.
   *
   *   ⚠️ 주차·취소 필터는 **임베딩 이름으로** 건다(`party_runs.week_key` …).
   *      `run_signups` 쪽에 걸면 존재하지 않는 컬럼이라 조용히 빗나간다.
   */
  const signupRows = unwrap(
    await db
      .from("run_signups")
      .select(
        "run_id,character_id,participant_id,party_runs!inner(id,party_id,run_no,boss_difficulty_id,scheduled_at,capacity,entry_party_size,week_key)",
      )
      .in("participant_id", participantIds)
      .eq("status", "going")
      .eq("party_runs.week_key", weekKey)
      .is("party_runs.cancelled_at", null)
      .neq("party_runs.status", "cancelled"),
    "내 참여 일정 조회",
  );
  if (signupRows.length === 0) return EMPTY;

  /*
    한 런에 내 신청이 두 줄일 이유는 없지만(파티당 내 참가자 행은 하나), 임베딩은
    신청 단위로 오므로 **런은 id 로 한 번만 담는다.** 중복이 생기면 목록이 두 번 나온다.
  */
  const runById = new Map<string, (typeof signupRows)[number]["party_runs"]>();
  for (const row of signupRows) {
    if (!runById.has(row.party_runs.id)) runById.set(row.party_runs.id, row.party_runs);
  }
  const runRows = [...runById.values()];
  if (runRows.length === 0) return EMPTY;

  const characterIdBySignup = new Map(
    signupRows.map((row) => [row.run_id, row.character_id]),
  );

  const missingBossIds = runRows
    .map((row) => row.boss_difficulty_id)
    .filter((id) => !bosses.has(id));
  if (missingBossIds.length > 0) {
    const extra = loadBossInfo(unique(missingBossIds));
    for (const [id, info] of extra) bosses.set(id, info);
  }

  /*
   * ★ 예전에는 여기가 3단이었다: `loadRunInfo`(런 행 재조회 → 파티 ∥ 참여) 를 **기다린
   *   뒤** 파티 이름을 **또** 읽고 캐릭터를 읽었다. 런 행은 바로 위에서 이미 읽었고
   *   파티 이름은 `buildRunInfo` 가 이미 만든다 — 두 조회 모두 중복이었다.
   *   지금은 1단이다: (파티 ∥ 참여) ∥ 캐릭터.
   */
  const [runInfo, characters] = await Promise.all([
    buildRunInfo(db, runRows),
    loadCharacters(
      db,
      unique(
        [...characterIdBySignup.values()].flatMap((id) => (id === null ? [] : [id])),
      ),
    ),
  ]);

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

  const runs: ScheduledRunBase[] = runRows
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
      partyName: info?.partyName ?? "이름 없는 파티",
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

  return { runs, runIds: runs.map((run) => run.runId), runInfo };
}

/** `run_drops` 에서 화면이 쓰는 컬럼 전부. 금액 컬럼은 **그대로 옮기기만** 한다. */
const DROP_COLUMNS =
  "id,run_id,item_name,sale_amount_meso,sold_at,share_mode,solo_participant_id,note,created_at";

/**
 * 이번 주 드랍 전부 — **판매된 것과 아직 안 판 것을 함께** 읽는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 미판매 목록을 따로 읽지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 `sale_amount_meso is null` 만 읽는 함수 하나였다(화면에 쓰기 경로가 없어
 * 항상 0건이었다). 이제 런마다 드랍 목록을 보여 주므로 같은 표를 두 번 읽을 이유가 없다 —
 * 한 번 읽고 여기서 갈라 준다. 미판매 **건수**는 여전히 뷰(`v_weekly_income`)가 센 값을
 * 쓰고, 이 함수는 **목록**만 만든다(두 숫자가 갈라지지 않게 하려는 것).
 *
 * ⚠️ **금액을 여기서 나누지 않는다.** 내 몫은 `v_run_drop_settlement.amount_meso` 이고
 *    그 값은 `distribute_meso()` 가 냈다. 수령 인원은 `v_run_drop_recipients` 가
 *    `party_default`/`custom`/`solo` 세 방식을 이미 해석한 결과다. 화면도 이 파일도
 *    1/n 을 다시 적지 않는다.
 *
 * ⚠️ `myShareMeso` 의 `null` 과 `0` 은 다른 뜻이다.
 *    - 미판매(`saleAmountMeso === null`) → **모름**이므로 `null`
 *    - 판매됐는데 내가 수령자가 아님     → **사실 0** 이므로 `0`
 *    접으면 "아직 안 팔았다"와 "내 몫이 없다"가 같은 화면이 된다.
 */
async function loadRunDrops(
  db: AdminDb,
  userId: string,
  weekKey: WeekKey,
  runIds: readonly string[],
  bosses: Map<string, BossInfo>,
  runInfoByRunId: ReadonlyMap<string, RunInfo>,
): Promise<{
  readonly byRun: ReadonlyMap<string, RunDropRecord[]>;
  readonly unsold: readonly UnsoldDrop[];
}> {
  const EMPTY = { byRun: new Map<string, RunDropRecord[]>(), unsold: [] };
  if (runIds.length === 0) return EMPTY;

  const rows = unwrap(
    await db
      .from("run_drops")
      .select(DROP_COLUMNS)
      .in("run_id", [...runIds])
      .eq("week_key", weekKey),
    "드랍 조회",
  );
  if (rows.length === 0) return EMPTY;

  const dropIds = rows.map((row) => row.id);
  const soloIds = unique(
    rows.flatMap((row) =>
      row.solo_participant_id === null ? [] : [row.solo_participant_id],
    ),
  );

  const [settlementRows, recipientRows, soloRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_run_drop_settlement")
          .select("drop_id,amount_meso")
          .in("drop_id", dropIds)
          .eq("user_id", userId),
        "드랍 정산 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("v_run_drop_recipients")
          .select("drop_id,participant_id")
          .in("drop_id", dropIds),
        "드랍 수령자 조회",
      ))(),
    (async () =>
      soloIds.length === 0
        ? []
        : unwrap(
            await db
              .from("party_participants")
              .select("id,display_name")
              .in("id", soloIds),
            "드랍 독식 대상 조회",
          ))(),
  ]);

  const myShareByDrop = new Map<string, number>();
  for (const row of settlementRows) {
    if (row.drop_id === null || row.amount_meso === null) continue;
    myShareByDrop.set(row.drop_id, row.amount_meso);
  }

  const recipientsByDrop = new Map<string, Set<string>>();
  for (const row of recipientRows) {
    if (row.drop_id === null || row.participant_id === null) continue;
    const set = recipientsByDrop.get(row.drop_id) ?? new Set<string>();
    set.add(row.participant_id);
    recipientsByDrop.set(row.drop_id, set);
  }

  const soloNameById = new Map(
    soloRows.map((row) => [row.id, row.display_name]),
  );

  const byRun = new Map<string, RunDropRecord[]>();
  const unsold: UnsoldDrop[] = [];

  for (const row of rows) {
    const sale = row.sale_amount_meso;
    const record: RunDropRecord = {
      dropId: row.id,
      runId: row.run_id,
      itemName: row.item_name,
      saleAmountMeso: sale,
      soldAt: row.sold_at,
      shareMode: row.share_mode,
      soloParticipantId: row.solo_participant_id,
      soloDisplayName:
        row.solo_participant_id === null
          ? null
          : (soloNameById.get(row.solo_participant_id) ?? null),
      note: row.note,
      // 미판매는 모름(null), 판매됐는데 수령자가 아니면 사실 0.
      myShareMeso: sale === null ? null : (myShareByDrop.get(row.id) ?? 0),
      recipientCount: recipientsByDrop.get(row.id)?.size ?? 0,
      recordedAt: row.created_at,
    };

    const list = byRun.get(row.run_id) ?? [];
    list.push(record);
    byRun.set(row.run_id, list);

    if (sale === null) {
      const run = runInfoByRunId.get(row.run_id);
      const boss =
        run === undefined ? undefined : bosses.get(run.bossDifficultyId);
      unsold.push({
        dropId: row.id,
        itemName: row.item_name,
        runId: row.run_id,
        bossDisplayName: boss?.displayName ?? run?.bossDifficultyId ?? "",
        recordedAt: row.created_at,
      });
    }
  }

  // 기록 순. 목록이 시간 순으로 쌓여야 "방금 넣은 것"이 어디 있는지 찾을 수 있다.
  for (const list of byRun.values()) {
    list.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
  unsold.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  return { byRun, unsold };
}

/**
 * `solo` 분배에서 고를 수 있는 사람 — 그 런에 `going` 으로 등록된 참가자.
 *
 * 출처가 `v_run_share_weights` 인 것이 중요하다. 이 뷰가 곧 `party_default` 분배의
 * 모집단이므로, "다 가져갈 사람"의 후보와 "나눠 가질 사람"의 목록이 **같은 정의**를 쓴다.
 * 게스트도 들어 있다 — 게스트에게 몰아주는 것도 정상적인 정산이다.
 */
async function loadRunDropParticipants(
  db: AdminDb,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, RunDropParticipant[]>> {
  const byRun = new Map<string, RunDropParticipant[]>();
  if (runIds.length === 0) return byRun;

  const rows = unwrap(
    await db
      .from("v_run_share_weights")
      .select("run_id,participant_id,member_no,display_name")
      .in("run_id", [...runIds]),
    "일정 참가자 조회",
  );

  for (const row of rows) {
    if (row.run_id === null || row.participant_id === null) continue;
    const list = byRun.get(row.run_id) ?? [];
    list.push({
      participantId: row.participant_id,
      memberNo: row.member_no,
      displayName: row.display_name ?? "이름 없는 참가자",
    });
    byRun.set(row.run_id, list);
  }

  /*
    §1.4 — 번호는 관리 식별자다. 번호 순으로 세워야 카톡 평문의 "3번"과 화면이 같은
    사람을 가리킨다. 번호가 없는 자리는 뒤로 보내고 이름으로 안정 정렬한다.
  */
  for (const list of byRun.values()) {
    list.sort(
      (a, b) =>
        (a.memberNo ?? Number.MAX_SAFE_INTEGER) -
          (b.memberNo ?? Number.MAX_SAFE_INTEGER) ||
        a.displayName.localeCompare(b.displayName, "ko-KR"),
    );
  }
  return byRun;
}

/**
 * `v_weekly_crystal_income_by_character` 에서 칸 계산이 쓰는 부분만. 구조적 타입이라
 * supabase-js 가 만든 행이 그대로 들어맞는다.
 */
interface WeeklySlotRowLike {
  readonly character_id: string | null;
  readonly weekly_clear_count: string | number | null;
  readonly weekly_sell_limit: string | number | null;
}

/**
 * `주간 보스 40 / 84건` 의 분자·분모.
 *
 * ⚠️ **분모는 `추적 캐릭터 수 × 캐릭터당 상한` 이다** (§1.1.1). 12개 상한은 캐릭터당이라
 *    합산 분자에 캐릭터 하나의 상한을 붙이면 화면이 `40 / 12건` 을 그린다 — 실제로 그렇게
 *    나갔던 화면이고, 대시보드는 `buildWeeklyBossCapacity()` 로 같은 규칙을 쓴다.
 *    (두 함수가 따로인 이유: 대시보드는 체크리스트를, 이 화면은 이미 읽어 둔 추적 캐릭터
 *     목록을 갖고 있다. **규칙은 같고 입력만 다르다** — 이 화면 때문에 체크리스트 조회를
 *     하나 더 붙이는 편이 더 비싸다.)
 *
 * ⚠️ **추적 0명이면 `limitTotal` 은 `null` 이다. `0` 이 아니다.** `0` 도 숫자라 화면이
 *    `0 / 0` 을 그리고, 그건 "분모가 없다"가 아니라 "상한이 0"이라는 거짓말이다.
 * ⚠️ **12 를 코드에 박지 않는다.** 상한의 단일 출처는 `weekly_crystal_sell_limit()` 이고
 *    뷰가 `weekly_sell_limit` 컬럼으로 실어 준다. 없으면 `null`(모름)이다.
 *
 * 분자는 **추적 캐릭터의 클리어만** 센다. 추적하지 않는 캐릭터는 12칸을 분모에 주지
 * 않으므로 분자에서도 빼는 것이 맞다.
 */
function buildWeeklyBossSlots(
  trackedCharacters: readonly IncomeCharacterOption[],
  rows: readonly WeeklySlotRowLike[],
): WeeklyBossSlots {
  const trackedIds = new Set(
    trackedCharacters.map((option) => option.characterId),
  );

  let perCharacterLimit: number | null = null;
  let clearedTotal = 0;
  for (const row of rows) {
    const limit = toCount(row.weekly_sell_limit);
    // 첫 번째로 **양수**를 주는 행을 쓴다. 0 은 "상한 없음"이 아니라 "값이 아직 없다"이다.
    if (perCharacterLimit === null && limit > 0) perCharacterLimit = limit;
    if (row.character_id !== null && trackedIds.has(row.character_id)) {
      clearedTotal += toCount(row.weekly_clear_count);
    }
  }

  const trackedCount = trackedIds.size;
  return {
    trackedCount,
    perCharacterLimit,
    limitTotal:
      perCharacterLimit === null || trackedCount === 0
        ? null
        : trackedCount * perCharacterLimit,
    clearedTotal,
  };
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

  const [
    summary,
    byCharacterRows,
    allClearRows,
    characterOptions,
    scope,
    participantIds,
    potential,
    monthIncome,
  ] = await Promise.all([
      /*
        ★ **프라미스를 그대로 넘긴다** (2026-08-18 성능 작업). 예전에는 `.then()` 안에서
          불러서 `v_weekly_income` 조회가 scope 를 기다린 뒤에야 출발했다 — 이 묶음의
          깊이가 1단이 아니라 2단이 되던 유일한 이유였다. 뺄셈은 여전히 둘 다 도착한
          뒤에 하므로 값은 한 글자도 다르지 않다.
      */
      fetchWeeklyIncome(userId, weekKey, scopePromise),
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
      /*
        내 파티 참가자 행 id. 아무것도 기다릴 필요가 없는데 예전에는
        `loadScheduledRunClears` 안에서 **이 묶음이 끝난 뒤** 시작됐다 — 왕복 한 단계를
        통째로 뒤로 미루는 배치였다.
      */
      loadMyParticipantIds(db, userId),
      /*
        이론상 최대치(`v_weekly_plan_potential`). 다른 조회에 의존하지 않으므로 같은 단에
        올린다 — 왕복 1회이고 캐릭터 수와 무관하다. **넥슨 호출 0건.**
      */
      fetchCrystalPotential(userId, db),
      /*
        이번 **달**의 월간 보스 수익(마이그레이션 32). 주차 버킷과 범위가 달라 따로 읽는다 —
        목요일이 지났다고 이번 달에 잡은 검은 마법사가 사라지면 안 된다(2026-08-20 발주자).
      */
      fetchMonthlyCrystalIncome(userId, monthKeyOfWeek(weekKey), db),
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
  const bosses = loadBossInfo(
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

  /*
   * ★ **일정 묶음을 같은 단에 올렸다** (2026-08-18 성능 작업).
   *   `loadScheduledRunClears` 의 입력은 `participantIds` 와 `clearRows` 뿐이고 둘 다
   *   위 묶음에서 이미 나왔다 — 캐릭터·런 정보를 **기다릴 이유가 없었다.** 예전에는
   *   그 뒤에 줄을 서서 안쪽 3단이 통째로 뒤로 밀렸다(원격 왕복 1회 ≈ 78ms).
   */
  const [characters, clearRunInfo, scheduled] = await Promise.all([
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
    loadScheduledRunClears(db, participantIds, weekKey, clearRows, bosses),
  ]);

  const { runs, runIds, runInfo: scheduledRunInfo } = scheduled;

  // 미판매 드랍은 **내가 참여한 이번 주 런**의 것만 본다. `v_weekly_income.unsoldDropCount`
  // 와 같은 모집단이며, 그 건수 자체는 뷰가 센 값을 쓴다(우리는 목록만 만든다).
  /*
    ★ 예전에는 여기서 `loadRunInfo(runIds)` 를 **또** 불렀다. 그 런들은 바로 위
      `loadScheduledRunClears` 가 이미 읽어 만든 것이라, 같은 값을 위해 왕복 2단이
      더 나갔다. 이제 그 함수가 만든 map 을 그대로 받아 합친다.
  */
  const allRunInfo = new Map(clearRunInfo);
  for (const [id, info] of scheduledRunInfo) allRunInfo.set(id, info);

  /*
    드랍 목록과 `solo` 후보를 함께 띄운다. 서로 의존하지 않으므로 직렬로 둘 이유가 없다.
    `dropParticipants` 는 **일정 목록에 있는 런만** 필요하다 — 후보를 고르는 화면이
    거기뿐이기 때문이다. 반면 드랍 목록은 클리어가 가리키는 런까지 포함해야 미판매
    목록이 뷰가 센 건수와 같은 모집단을 본다.
  */
  const [{ byRun: dropsByRun, unsold: unsoldDrops }, dropParticipantsByRun] =
    await Promise.all([
      loadRunDrops(
        db,
        userId,
        weekKey,
        unique([...runIds, ...clearRunInfo.keys()]),
        bosses,
        allRunInfo,
      ),
      loadRunDropParticipants(db, runIds),
    ]);

  const runsWithDrops: readonly ScheduledRunClear[] = runs.map((run) => ({
    ...run,
    drops: dropsByRun.get(run.runId) ?? [],
    dropParticipants: dropParticipantsByRun.get(run.runId) ?? [],
  }));

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
    runs: runsWithDrops,
    unsoldDrops,
    characterOptions,
    accountCrystalUsage: scope.accounts,
    unassignedCrystalCount: scope.unassignedCount,
    /*
     * ★ 상단 요약은 **대시보드와 같은 함수**가 조립한다(`./crystal-summary`). 여기서
     *   따로 더하면 두 화면이 다른 숫자를 말하기 시작하고, 그건 이 저장소가 두 번 고친
     *   사고다. 주간 보스 칸의 분모도 정의가 한 곳뿐이다 — 아래 `buildWeeklyBossSlots`.
     *
     * ⚠️ **최대치는 이번 주에만 붙인다.** 계획은 현재 상태이고 과거 주차의 계획 스냅샷은
     *    남지 않으므로, 지난주 카드에 지금 계획의 상한을 그리면 그건 그때의 상한이 아니다.
     */
    crystalSummary: buildCrystalIncomeSummary(
      weekKey,
      summary,
      weekKey === getWeekKey(new Date()) ? potential : null,
      buildWeeklyBossSlots(characterOptions, byCharacterRows),
      /*
        ★ **월간은 달 단위다** (2026-08-20 발주자). 주차 버킷으로 세면 목요일 리셋을 넘긴
          순간 이번 달에 잡은 검은 마법사가 0 이 된다 — 인게임 월간 초기화는 달력 1일이다.
          지난 주차를 보고 있을 때는 **그 주가 속한 달**을 센다.
      */
      monthIncome,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 원장(ledger) — 캘린더와 주차별 내역이 **같은 조회 하나**를 본다
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주자 지시(2026-08-19): *"캘린더를 박아놔서 언제 무슨보스를 돌았고 하는 내역들을
// 볼수있게 해봐 주차별로 32주차엔 얼마 벌었다. 드랍 뭐였다 등등"*
//
// ★ **주차가 1층이다.** 달력은 월 격자로 그리지만 회계 단위는 주(목 00:00 KST 리셋)이고
//   12개 상한도 주 단위다. 그래서 서버는 주차 묶음을 주고 달력이 그것을 날짜로 흩어
//   그린다 — 같은 원장을 두 번 조회하지 않으므로 달력과 주차 목록이 다른 숫자를 말할 수 없다.
//
// ⚠️ **일간 보스는 여기에도 없다**(2026-08-18 발주자 결정). 금액은 뷰의 주기별 컬럼
//    (마이그레이션 27)에서 오므로 뺄셈이 아예 필요 없고, 목록은 `isTrackedBossCycle` 로 거른다.

/** ★ 한 줄 리터럴 — supabase-js 가 select 문자열을 타입 수준에서 파싱한다. */
const LEDGER_INCOME_COLUMNS =
  "week_key,weekly_crystal_income_meso,monthly_crystal_income_meso,weekly_clear_count,monthly_clear_count,weekly_unknown_price_count,monthly_unknown_price_count,weekly_over_limit_count,drop_income_meso,unsold_drop_count";

/** 같은 이유로 한 줄이다. */
const LEDGER_DROP_COLUMNS =
  "drop_id,run_id,week_key,item_name,sale_amount_meso,amount_meso";

/**
 * `CLEAR_COLUMNS` + `week_key`. 이번 주 화면은 한 주만 읽어 주차를 알 필요가 없지만,
 * 원장은 여러 주를 한 번에 읽으므로 행마다 어느 주인지가 있어야 묶을 수 있다.
 * (역시 **이어 붙이지 않고** 한 줄로 적는다 — 타입이 `string` 으로 뭉개지면 컬럼 오타가
 *  런타임까지 살아남는다.)
 */
const LEDGER_CLEAR_COLUMNS =
  "id,week_key,character_id,boss_difficulty_id,run_id,party_size,party_size_confirmed,cycle,base_price_meso,pot_meso,crystal_share_meso,share_bp,source,manual_cleared,manual_set_at,api_cleared,api_observed_at,effective_cleared,has_conflict,cleared_at";

/*
 * 조회 범위 상한은 `../lib/week-range` 가 소유한다 — **화면도 같은 값을 봐야** "더 보기"가
 * 상한을 넘겨 400 을 받는 일이 없다. Route Handler 가 여기서 가져다 쓰던 이름을 유지하려고
 * 재수출만 한다(서버 파일은 `server-only` 라 화면이 직접 import 할 수 없다).
 */
export { LEDGER_MAX_WEEKS } from "../lib/week-range";

/** 주기별 금액·건수 한 벌. 뷰가 갈라 준 값을 그대로 옮긴다. */
function toCycleTally(
  clearCount: string | number | null,
  incomeMeso: string | number | null,
  unknownPriceCount: string | number | null,
): CrystalCycleTally {
  return {
    clearCount: toCount(clearCount),
    incomeMeso: toSafeMeso(incomeMeso),
    unknownPriceCount: toCount(unknownPriceCount),
  };
}

/**
 * `from ~ to` 주차의 원장 전체 (양 끝 포함).
 *
 * **기록이 없는 주차는 응답에 아예 없다.** 빈 주를 0 원 행으로 지어내면 "그 주에 0원을
 * 벌었다"가 되는데 실제로는 "아무것도 기록되지 않았다"이다. 달력은 그 차이를 빈 칸으로
 * 그리고, 주차 목록은 아예 줄을 만들지 않는다.
 *
 * ★ 주차 키는 **문자열 비교로 정렬된다** — `2026-W05 < 2026-W33` 이고 연도가 앞에 있어
 *   해가 바뀌어도 순서가 맞다(`2025-W52 < 2026-W01`). 그래서 범위 필터가 `gte`/`lte` 로 끝난다.
 */
export async function fetchIncomeLedger(
  userId: string,
  fromWeekKey: WeekKey,
  toWeekKey: WeekKey,
): Promise<IncomeLedgerResponse> {
  const db = getAdminDb();

  const [incomeRows, allClearRows, dropRows, characterOptions, earliestRows] =
    await Promise.all([
      (async () =>
        unwrap(
          await db
            .from("v_weekly_income")
            .select(LEDGER_INCOME_COLUMNS)
            .eq("user_id", userId)
            .gte("week_key", fromWeekKey)
            .lte("week_key", toWeekKey),
          "주차별 수익 조회",
        ))(),
      (async () =>
        unwrap(
          await db
            .from("boss_clears")
            .select(LEDGER_CLEAR_COLUMNS)
            .eq("user_id", userId)
            .eq("effective_cleared", true)
            .gte("week_key", fromWeekKey)
            .lte("week_key", toWeekKey),
          "주차별 클리어 조회",
        ))(),
      /*
        판매된 드랍의 **내 몫**. `v_run_drop_settlement` 은 미판매를 이미 빼 놓았고
        금액은 `distribute_meso()` 가 낸 값이다 — 화면도 서버도 1/n 을 다시 적지 않는다.
      */
      (async () =>
        unwrap(
          await db
            .from("v_run_drop_settlement")
            .select(LEDGER_DROP_COLUMNS)
            .eq("user_id", userId)
            .gte("week_key", fromWeekKey)
            .lte("week_key", toWeekKey),
          "주차별 드랍 조회",
        ))(),
      fetchMyRunCharacters(userId),
      /*
        기록이 있는 가장 오래된 주차. "더 보기" 가 더 볼 것이 남았는지 판단하는 근거이며,
        서버가 페이지 커서를 들고 있지 않아도 되게 한다(빈 주차만 잔뜩 부르는 일이 없다).
      */
      (async () =>
        unwrap(
          await db
            .from("v_weekly_income")
            .select("week_key")
            .eq("user_id", userId)
            .order("week_key", { ascending: true })
            .limit(1),
          "원장 시작 주차 조회",
        ))(),
    ]);

  const bosses = loadBossInfo(
    unique(allClearRows.map((row) => row.boss_difficulty_id)),
  );
  // 일간은 목록에서 뺀다. 주기 스냅샷이 비어 있으면 마스터의 현재 주기로 보충한다.
  const clearRows = allClearRows.filter((row) =>
    isTrackedBossCycle(row.cycle ?? bosses.get(row.boss_difficulty_id)?.cycle),
  );

  /*
    드랍이 나온 일정의 보스 이름. `loadRunInfo()` 는 파티 이름과 `going` 인원까지 함께
    읽는데 원장에는 둘 다 필요 없다 — 여기서는 `party_runs` 한 번으로 끝낸다.
  */
  const dropRunIds = unique(dropRows.flatMap((row) => (row.run_id === null ? [] : [row.run_id])));
  const [characters, dropRunRows] = await Promise.all([
    loadCharacters(
      db,
      unique(
        clearRows.flatMap((row) =>
          row.character_id === null ? [] : [row.character_id],
        ),
      ),
    ),
    (async () =>
      dropRunIds.length === 0
        ? []
        : unwrap(
            await db
              .from("party_runs")
              .select("id,boss_difficulty_id")
              .in("id", dropRunIds),
            "드랍 일정 조회",
          ))(),
  ]);

  const dropBosses = loadBossInfo(
    unique(dropRunRows.map((row) => row.boss_difficulty_id)),
  );
  const bossOfRun = new Map<string, string>();
  for (const row of dropRunRows) bossOfRun.set(row.id, row.boss_difficulty_id);

  // ── 주차별로 묶는다 ───────────────────────────────────────────────────────
  const clearsByWeek = new Map<string, ClearRecord[]>();
  for (const row of clearRows) {
    /*
      런 정보(`runNo` · 파티 이름 · `going` 인원)는 **싣지 않는다.** 원장의 줄과 수정
      다이얼로그 어디에서도 쓰지 않으면서 주차 수만큼 왕복을 늘리기 때문이다. 이번 주
      화면(`fetchWeeklyIncomeDetail`)은 그 값이 필요해 계속 읽는다.
    */
    const record = toClearRecord(
      row,
      bosses.get(row.boss_difficulty_id),
      row.character_id === null ? undefined : characters.get(row.character_id),
      undefined,
    );
    const list = clearsByWeek.get(row.week_key) ?? [];
    list.push(record);
    clearsByWeek.set(row.week_key, list);
  }
  for (const list of clearsByWeek.values()) {
    // 최근에 깬 것이 위로. 시각을 모르는 행은 맨 아래로 내린다.
    list.sort(
      (a, b) =>
        (b.clearedAt === null ? 0 : Date.parse(b.clearedAt)) -
          (a.clearedAt === null ? 0 : Date.parse(a.clearedAt)) ||
        a.bossDisplayName.localeCompare(b.bossDisplayName, "ko-KR"),
    );
  }

  const dropsByWeek = new Map<string, LedgerDrop[]>();
  for (const row of dropRows) {
    if (row.drop_id === null || row.run_id === null || row.week_key === null) {
      continue;
    }
    const bossId = bossOfRun.get(row.run_id) ?? null;
    const boss = bossId === null ? undefined : dropBosses.get(bossId);
    const list = dropsByWeek.get(row.week_key) ?? [];
    list.push({
      dropId: row.drop_id,
      runId: row.run_id,
      itemName: row.item_name ?? "이름 없는 드랍",
      bossDisplayName: boss?.displayName ?? null,
      bossDifficultyId: bossId,
      difficulty: boss?.difficulty ?? null,
      saleAmountMeso: toSafeMeso(row.sale_amount_meso),
      myShareMeso: toSafeMeso(row.amount_meso),
    });
    dropsByWeek.set(row.week_key, list);
  }
  for (const list of dropsByWeek.values()) {
    list.sort(
      (a, b) =>
        (b.myShareMeso ?? -1) - (a.myShareMeso ?? -1) ||
        a.itemName.localeCompare(b.itemName, "ko-KR"),
    );
  }

  const weeks: WeekLedgerEntry[] = [];
  for (const row of incomeRows) {
    const weekKey = row.week_key;
    if (weekKey === null) continue;

    const weekly = toCycleTally(
      row.weekly_clear_count,
      row.weekly_crystal_income_meso,
      row.weekly_unknown_price_count,
    );
    const monthly = toCycleTally(
      row.monthly_clear_count,
      row.monthly_crystal_income_meso,
      row.monthly_unknown_price_count,
    );
    const dropIncomeMeso = toSafeMeso(row.drop_income_meso);
    const drops = dropsByWeek.get(weekKey) ?? [];
    const clears = clearsByWeek.get(weekKey) ?? [];
    const unsoldDropCount = toCount(row.unsold_drop_count);

    /*
      ★ 일간만 있던 주는 **원장에 올리지 않는다.** 일간은 범위 밖이라 우리가 말할 수 있는
        것이 하나도 남지 않는데, 거기서 `0 메소` 를 찍으면 "아무것도 못 벌었다"는 거짓
        주장이 된다. (`fetchWeeklyIncome` 이 요약에서 같은 판단을 한다.)
    */
    if (
      weekly.clearCount === 0 &&
      monthly.clearCount === 0 &&
      drops.length === 0 &&
      unsoldDropCount === 0
    ) {
      continue;
    }

    /*
      결정석 합계와 총합만 여기서 더한다. 두 항 모두 **뷰가 같은 절삭 규칙으로** 낸 값이라
      규칙이 복제되지 않고, 한쪽이 `null`(안전 정수 초과)이면 합도 `null` 이다 —
      모르는 값을 0 으로 채워 더하면 그 순간 금액이 조용히 줄어든다.
    */
    const crystalIncomeMeso =
      weekly.incomeMeso === null || monthly.incomeMeso === null
        ? null
        : weekly.incomeMeso + monthly.incomeMeso;
    const totalIncomeMeso =
      crystalIncomeMeso === null || dropIncomeMeso === null
        ? null
        : crystalIncomeMeso + dropIncomeMeso;

    weeks.push({
      weekKey,
      startsAt: weekStartOfKey(weekKey).toISOString(),
      endsAt: weekEndOfKey(weekKey).toISOString(),
      crystalIncomeMeso,
      dropIncomeMeso,
      totalIncomeMeso,
      weekly,
      monthly,
      weeklyOverLimitCount: toCount(row.weekly_over_limit_count),
      unsoldDropCount,
      clears,
      drops,
    });
  }

  // 최신 주차가 먼저. 주차 키는 문자열 비교만으로 시간 순서가 맞는다.
  weeks.sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  return {
    weeks,
    characterOptions,
    earliestWeekKey: earliestRows[0]?.week_key ?? null,
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
/**
 * 원장 한 줄을 **클리어 해제** — 잘못 들어온 기록을 그 자리에서 되돌린다
 * (발주 지적 2026-09-01: *"이 화면에 클리어 해제 없고"*).
 *
 * 수정 창에는 인원과 캐릭터를 고치는 길만 있었다. 그런데 **틀린 기록의 가장 흔한 형태는
 * "안 잡았는데 들어와 있는 것"**이고(동기화가 집어 온 클리어, 잘못 누른 12칸), 그건 인원을
 * 아무리 고쳐도 사라지지 않는다. 그 자리에서 되돌릴 수 없으면 사람은 원장을 못 믿는다.
 *
 * ★ 규칙은 `setRunClear` · `setPlanClear` 와 **같다** — 넥슨 관측이 없는 행은 지우고,
 *   있는 행은 `manual_cleared = false` 로 눕힌다. 관측이 있는 행을 지우면 "사람이 아니라고
 *   했다"는 사실까지 사라져 다음 동기화가 곧바로 되살린다.
 * ★ 대상은 **`clear_id` 하나**다. 이 창은 이미 그 행을 손에 들고 있으므로
 *   (캐릭터·보스·주차로) 다시 찾을 이유가 없고, 찾는 순간 같은 판정이 세 벌이 된다.
 */
export async function unsetLedgerClear(
  userId: string,
  clearId: string,
): Promise<void> {
  const db = getAdminDb();

  const { data: clear, error } = await db
    .from("boss_clears")
    .select("id,api_cleared")
    .eq("id", clearId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null) {
    console.error(`[income-repo] 클리어 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  // 없는 기록과 남의 기록을 구분하지 않는다.
  if (clear === null) throw clearNotFound();

  if (clear.api_cleared === null) {
    const { error: deleteError } = await db
      .from("boss_clears")
      .delete()
      .eq("id", clear.id)
      .eq("user_id", userId);
    if (deleteError !== null) {
      console.error(`[income-repo] 클리어 해제 실패: ${deleteError.message}`);
      throw ApiError.internal();
    }
    return;
  }

  const { error: updateError } = await db
    .from("boss_clears")
    .update({ manual_cleared: false, manual_set_at: new Date().toISOString() })
    .eq("id", clear.id)
    .eq("user_id", userId);
  if (updateError !== null) {
    console.error(`[income-repo] 클리어 해제 실패: ${updateError.message}`);
    throw ApiError.internal();
  }
}

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

/**
 * 계획 한 칸을 클리어로 표시 / 해제 — **런 없이** (발주 지시 2026-08-31:
 * *"이번주 현황에서 클릭하면 클리어 판정 되게 해줘"*).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `setRunClear` 로는 안 되는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 그쪽은 **등록한 일정**이 있어야 한다(파티 · going 참여 · 캐릭터 지정). `/boss-status`
 * 의 12칸은 일정이 아니라 **계획**이고, 실제로 일정 없이 도는 보스가 더 많다 —
 * 실측(2026-08-31): 한 계정의 검은 마법사 계획 6건 중 그날 일정에 잡혀 있던 것은 0건.
 * 넥슨 동기화를 기다리는 길도 있지만 그건 ~15분 뒤이고(§1.1), 월간 보스는 스케줄러
 * 응답에 아예 들어 있지 않은 경우가 있다.
 *
 * ★ 나머지 규칙은 `setRunClear` 와 **같다** — `manual_cleared` / `manual_set_at` 두
 *   컬럼만 쓰고, 해제는 넥슨 관측이 없는 행만 지운다(관측이 있으면 "사람이 아니라고
 *   했다"는 사실을 남겨야 다음 동기화가 다시 클리어로 만들지 않는다). 규칙을 두 벌로
 *   적으면 어느 화면에서 눌렀는지에 따라 원장이 달라진다.
 * ★ 인원은 **그 계획의 `default_party_size`** 를 쓴다(§1.3 D3). 기본값 1 을 그대로 두면
 *   2인으로 도는 보스가 두 배로 잡히고, 그 숫자는 사람이 다시 고쳐야 한다.
 * ★ 런과 **연결하지 않는다.** 일정이 있는 보스는 시간표에서 체크하는 길(`setRunClear`)이
 *   이미 있고 그쪽이 더 좋은 행을 만든다(입장 인원 · 예정 시각 · going 분배). 둘 다 같은
 *   유니크 키를 쓰므로 나중에 시간표에서 눌러도 행이 둘이 되지 않고 그쪽이 보완한다.
 */
export async function setPlanClear(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
  cleared: boolean,
): Promise<void> {
  const db = getAdminDb();

  /*
    남의 캐릭터와 없는 캐릭터를 **같은 답**으로 접는다 — 존재 여부를 알려 주면 id 를
    훑어 누가 무엇을 키우는지 캐낼 수 있다(`runNotFound` 와 같은 기조).
  */
  const { data: character, error: characterError } = await db
    .from("characters")
    .select("id")
    .eq("id", characterId)
    .eq("user_id", userId)
    .maybeSingle();
  if (characterError !== null) {
    console.error(`[income-repo] 캐릭터 조회 실패: ${characterError.message}`);
    throw ApiError.internal();
  }
  if (character === null) {
    throw new ApiError(
      "bad_request",
      "캐릭터를 찾을 수 없거나 편집 권한이 없습니다.",
      404,
    );
  }

  const nowIso = new Date().toISOString();
  const weekKey = getWeekKey(new Date(nowIso));

  const { data: existing, error: existingError } = await db
    .from("boss_clears")
    .select("id,api_cleared,cleared_at")
    .eq("user_id", userId)
    .eq("character_id", characterId)
    .eq("boss_difficulty_id", bossDifficultyId)
    .eq("week_key", weekKey)
    .maybeSingle();
  if (existingError !== null) {
    console.error(`[income-repo] 기존 클리어 조회 실패: ${existingError.message}`);
    throw ApiError.internal();
  }

  if (!cleared) {
    if (existing === null) return;

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

  if (existing !== null) {
    /*
      이미 있는 행은 **두 컬럼만** 든다. 인원은 건드리지 않는다 — 그 행은 런에 걸려
      있거나 사람이 고쳐 둔 값일 수 있고, 여기서 계획 기본값을 씌우면 정확히
      §1.3 D3 을 거스른다.
    */
    const { error } = await db
      .from("boss_clears")
      .update({
        manual_cleared: true,
        manual_set_at: nowIso,
        cleared_at: existing.cleared_at ?? nowIso,
      })
      .eq("id", existing.id)
      .eq("user_id", userId);
    if (error !== null) {
      console.error(`[income-repo] 클리어 표시 실패: ${error.message}`);
      throw ApiError.internal();
    }
    return;
  }

  const { data: plan, error: planError } = await db
    .from("character_boss_plans")
    .select("default_party_size")
    .eq("character_id", characterId)
    .eq("boss_difficulty_id", bossDifficultyId)
    .maybeSingle();
  if (planError !== null) {
    console.error(`[income-repo] 계획 인원 조회 실패: ${planError.message}`);
    throw ApiError.internal();
  }

  const { error } = await db.from("boss_clears").insert({
    user_id: userId,
    character_id: characterId,
    boss_difficulty_id: bossDifficultyId,
    week_key: weekKey,
    cleared_at: nowIso,
    manual_cleared: true,
    manual_set_at: nowIso,
    party_size: plan?.default_party_size ?? 1,
    source: "manual",
  });
  if (error !== null) {
    console.error(`[income-repo] 클리어 기록 실패: ${error.message}`);
    throw ApiError.internal();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 드랍 쓰기 — 발주 요구: *"드랍 넣고"* (2026-08-18)
//
// 발주자 확인: *"드랍은 어디서 하는건지 모르겠네 파티에서 입력하는건가?"*
// → DB(`run_drops` · `run_drop_shares` · 정산 뷰 4종)는 처음부터 완비되어 있었고
//   **쓰기 경로만 없었다.** 화면은 `dropIncomeMeso` 를 표시만 했고 값은 항상 0 이었다.
//
// ⚠️ **여기서도 금액을 나누지 않는다.** 우리가 저장하는 것은 `sale_amount_meso`(판매
//    총액)와 분배 **방식**뿐이고, 누가 얼마를 가져가는지는 `v_run_drop_recipients` →
//    `distribute_meso()` → `v_run_drop_settlement` 이 정한다. 이 파일이 1/n 을 적는
//    순간 웹과 카톡 봇의 답이 갈라진다.
// ─────────────────────────────────────────────────────────────────────────────

/** 없는 드랍과 남의 드랍을 **같은 답으로** 접는다(위 `clearNotFound` 와 같은 이유). */
function dropNotFound(): ApiError {
  return new ApiError(
    "bad_request",
    "드랍 기록을 찾을 수 없거나 편집 권한이 없습니다.",
    404,
  );
}

/** DB CHECK(`length(btrim(item_name)) between 1 and 100`)와 **같은 범위**다. */
const DROP_ITEM_NAME_MAX = 100;
/** 메모 상한. DB 에 CHECK 는 없지만 무제한 텍스트를 받을 이유도 없다. */
const DROP_NOTE_MAX = 500;
/**
 * 판매액 상한. DB CHECK 는 `>= 0` 뿐이지만 `bigint` 를 그대로 열어 두면 JS 의
 * 안전 정수 범위를 넘는 값이 들어와 화면에서 조용히 어긋난다. 1조는 실제 드랍
 * 시세보다 두 자릿수 넉넉하다.
 */
const DROP_SALE_MAX = 1_000_000_000_000;

/**
 * 드랍을 만지려면 **그 런에 `going` 으로 등록된 파티원**이어야 한다.
 *
 * 기준을 `setRunClear` 와 같게 맞춘 것이 중요하다. 드랍을 나눠 갖는 모집단이 정확히
 * `going` 참가자(`v_run_share_weights`)이므로, 그 자리에 없던 사람이 기록을 만들면
 * 자기 몫이 0 인 정산을 남기게 된다.
 *
 * 없는 런·남의 파티는 **같은 404** 다 — 403 은 "그 런은 존재한다"를 흘린다.
 */
async function requireRunDropAccess(
  db: AdminDb,
  userId: string,
  runId: string,
): Promise<{ readonly participantId: string; readonly cancelled: boolean }> {
  const { data: run, error: runError } = await db
    .from("party_runs")
    .select("id,party_id,cancelled_at,status")
    .eq("id", runId)
    .maybeSingle();
  if (runError !== null) {
    console.error(`[income-repo] 일정 조회 실패: ${runError.message}`);
    throw ApiError.internal();
  }
  if (run === null) throw runNotFound();

  const { data: participant, error: participantError } = await db
    .from("party_participants")
    .select("id")
    .eq("party_id", run.party_id)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (participantError !== null) {
    console.error(
      `[income-repo] 파티 구성원 조회 실패: ${participantError.message}`,
    );
    throw ApiError.internal();
  }
  if (participant === null) throw runNotFound();

  const { data: signup, error: signupError } = await db
    .from("run_signups")
    .select("id,status")
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
      "참여(going)로 등록한 일정에만 드랍을 기록할 수 있습니다.",
      403,
    );
  }

  return {
    participantId: participant.id,
    cancelled: run.cancelled_at !== null || run.status === "cancelled",
  };
}

/** 아이템 이름 정규화 + 검증. DB CHECK 가 같은 규칙을 다시 본다. */
function normalizeItemName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw ApiError.badRequest("아이템 이름을 입력해 주세요.");
  }
  if (name.length > DROP_ITEM_NAME_MAX) {
    throw ApiError.badRequest(
      `아이템 이름은 ${DROP_ITEM_NAME_MAX}자까지 입력할 수 있습니다.`,
    );
  }
  return name;
}

/**
 * 판매액 검증. **`null` 을 그대로 통과시키는 것이 이 함수의 요점이다** —
 * "아직 안 팔았다"가 정상 입력이고, 0 으로 바꿔치기하면 "0메소를 벌었다"는 거짓이 된다.
 */
function normalizeSaleAmount(raw: number | null): number | null {
  if (raw === null) return null;
  if (!Number.isFinite(raw)) {
    throw ApiError.badRequest("판매액을 해석할 수 없습니다.");
  }
  const amount = Math.trunc(raw);
  if (amount < 0) {
    throw ApiError.badRequest("판매액은 0 이상이어야 합니다.");
  }
  if (amount > DROP_SALE_MAX) {
    throw ApiError.badRequest("판매액이 너무 큽니다. 값을 다시 확인해 주세요.");
  }
  return amount;
}

function normalizeNote(raw: string | null): string | null {
  if (raw === null) return null;
  const note = raw.trim();
  if (note.length === 0) return null;
  if (note.length > DROP_NOTE_MAX) {
    throw ApiError.badRequest(
      `메모는 ${DROP_NOTE_MAX}자까지 입력할 수 있습니다.`,
    );
  }
  return note;
}

/**
 * `solo` 대상이 **그 런의 `going` 참가자**인지 확인한다.
 *
 * DB 도 FK 로 막지만 그건 "party_participants 에 있는 id 인가"까지다 — 다른 파티의
 * 참가자를 넣어도 FK 는 통과하고, 그 순간 `v_run_drop_recipients` 가 `solo` 행을
 * 만들지만 그 사람은 이 런의 분배 모집단이 아니다. 그러면 정산 결과가 그 런의
 * 참가자 명단과 어긋난 채로 남는다. 그래서 여기서 먼저 막는다.
 */
async function assertSoloParticipantInRun(
  db: AdminDb,
  runId: string,
  participantId: string,
): Promise<void> {
  const rows = unwrap(
    await db
      .from("v_run_share_weights")
      .select("participant_id")
      .eq("run_id", runId)
      .eq("participant_id", participantId)
      .limit(1),
    "드랍 독식 대상 확인",
  );
  if (rows.length === 0) {
    throw ApiError.badRequest(
      "그 일정에 참여(going)로 등록된 사람만 드랍을 독식할 수 있습니다.",
    );
  }
}

/** `share_mode` 에 따라 `solo_participant_id` 를 정리한다. DB CHECK 와 같은 규칙이다. */
async function resolveSoloParticipant(
  db: AdminDb,
  runId: string,
  shareMode: Exclude<DropShareMode, "custom">,
  soloParticipantId: string | null,
): Promise<string | null> {
  if (shareMode !== "solo") return null;
  if (soloParticipantId === null) {
    throw ApiError.badRequest("독식할 사람을 골라 주세요.");
  }
  await assertSoloParticipantInRun(db, runId, soloParticipantId);
  return soloParticipantId;
}

/**
 * 드랍 한 건을 기록한다.
 *
 * ★ **판매액 없이 저장되는 것이 기본 흐름이다.** 아이템만 먼저 적고 팔린 뒤에 금액을
 *   채운다. 그동안 이 행은 합계에서 빠지고 `unsold_drop_count` 로만 세어진다.
 * ★ `week_key` 를 **보내지 않는다.** `run_drops_apply_state()` 트리거가 런의 주차를
 *   따라 찍는다 — 클리어의 "클리어 주차 귀속"(§1.3 D1)과 같은 기조다.
 * ★ `sold_at` 도 보내지 않는다. 금액이 처음 채워질 때 트리거가 찍고, 금액을 지우면
 *   되돌린다. 우리가 손대면 CHECK(`run_drops_sold_pair`)와 어긋날 수 있다.
 */
export async function addRunDrop(
  userId: string,
  input: AddRunDropInput,
): Promise<void> {
  const db = getAdminDb();
  const { participantId, cancelled } = await requireRunDropAccess(
    db,
    userId,
    input.runId,
  );
  if (cancelled) {
    throw ApiError.badRequest("취소된 일정에는 드랍을 기록할 수 없습니다.");
  }

  const soloParticipantId = await resolveSoloParticipant(
    db,
    input.runId,
    input.shareMode,
    input.soloParticipantId,
  );

  const { error } = await db.from("run_drops").insert({
    run_id: input.runId,
    item_name: normalizeItemName(input.itemName),
    sale_amount_meso: normalizeSaleAmount(input.saleAmountMeso),
    share_mode: input.shareMode,
    solo_participant_id: soloParticipantId,
    recorded_by_participant_id: participantId,
    note: normalizeNote(input.note),
  });
  if (error !== null) {
    console.error(`[income-repo] 드랍 기록 실패: ${error.message}`);
    throw ApiError.internal();
  }
}

/** 드랍 행 + 그 런의 권한을 함께 확인한다. 수정·삭제가 같은 전처리를 쓴다. */
async function loadDropForEdit(
  db: AdminDb,
  userId: string,
  dropId: string,
): Promise<{
  readonly runId: string;
  readonly shareMode: DropShareMode;
  readonly soloParticipantId: string | null;
}> {
  const { data: drop, error } = await db
    .from("run_drops")
    .select("id,run_id,share_mode,solo_participant_id")
    .eq("id", dropId)
    .maybeSingle();
  if (error !== null) {
    console.error(`[income-repo] 드랍 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  if (drop === null) throw dropNotFound();

  /*
    권한은 **런 기준**이다. 기록한 사람만 고칠 수 있게 하면 같이 간 사람이 판매액을
    채워 넣을 수 없다 — 클리어 체크를 파티원 누구나 하는 것과 같은 판단이다.
    남의 파티면 `requireRunDropAccess` 가 404 로 접고, 우리는 그 404 를 드랍 쪽 문구로
    바꿔 준다(런이 안 보이는 것과 드랍이 없는 것은 사용자에게 같은 사실이다).
  */
  try {
    await requireRunDropAccess(db, userId, drop.run_id);
  } catch (accessError) {
    if (accessError instanceof ApiError && accessError.status === 404) {
      throw dropNotFound();
    }
    throw accessError;
  }

  return {
    runId: drop.run_id,
    shareMode: drop.share_mode,
    soloParticipantId: drop.solo_participant_id,
  };
}

/**
 * 드랍을 고친다 — **판매액을 나중에 채우는 것이 주 용도다.**
 *
 * ⚠️ `saleAmountMeso` 의 `undefined`(안 보냄)와 `null`(미판매로 되돌림)은 서로 다른
 *    뜻이라 접지 않는다. `null` 을 보내면 트리거가 `sold_at` 까지 되돌리고 그 행은
 *    다시 미판매로 세어진다.
 *
 * ⚠️ **취소된 일정의 드랍도 고칠 수 있다.** 새로 만들 수만 없다. 드랍이 붙은 런은
 *    삭제가 아니라 취소되므로(`runHasIncomeRecords`), 취소 후 편집을 막으면 판매액을
 *    영원히 못 채우는 기록이 생긴다.
 */
export async function updateRunDrop(
  userId: string,
  input: UpdateRunDropInput,
): Promise<void> {
  const db = getAdminDb();
  const current = await loadDropForEdit(db, userId, input.dropId);

  const patch: {
    item_name?: string;
    sale_amount_meso?: number | null;
    share_mode?: DropShareMode;
    solo_participant_id?: string | null;
    note?: string | null;
  } = {};

  if (input.itemName !== undefined) {
    patch.item_name = normalizeItemName(input.itemName);
  }
  if (input.saleAmountMeso !== undefined) {
    patch.sale_amount_meso = normalizeSaleAmount(input.saleAmountMeso);
  }
  if (input.note !== undefined) {
    patch.note = normalizeNote(input.note);
  }

  if (input.shareMode !== undefined) {
    if (current.shareMode === "custom") {
      /*
        `custom` 에서 벗어나면 `run_drop_shares` 의 비율이 고아가 된다. 우리 쓰기 경로는
        `custom` 을 만들지 않으므로 이 분기는 DB 를 직접 만진 데이터에서만 걸리는데,
        그때 조용히 비율을 버리는 것보다 손대지 않는 편이 낫다.
      */
      throw ApiError.badRequest(
        "건별 사용자 지정 비율이 걸린 드랍입니다. 이 화면에서는 분배 방식을 바꿀 수 없습니다.",
      );
    }
    patch.share_mode = input.shareMode;
    patch.solo_participant_id = await resolveSoloParticipant(
      db,
      current.runId,
      input.shareMode,
      input.soloParticipantId ?? current.soloParticipantId,
    );
  } else if (input.soloParticipantId !== undefined) {
    // 방식은 그대로 두고 대상만 바꾸는 경우. `solo` 가 아니면 넣을 자리가 없다.
    if (current.shareMode !== "solo") {
      throw ApiError.badRequest(
        "독식 대상은 한 사람이 전부 가져가는 분배에서만 지정할 수 있습니다.",
      );
    }
    patch.solo_participant_id = await resolveSoloParticipant(
      db,
      current.runId,
      "solo",
      input.soloParticipantId,
    );
  }

  // 바꿀 것이 없으면 UPDATE 를 보내지 않는다. 트리거가 헛돌 이유가 없다.
  if (Object.keys(patch).length === 0) return;

  const { error } = await db
    .from("run_drops")
    .update(patch)
    .eq("id", input.dropId);
  if (error !== null) {
    console.error(`[income-repo] 드랍 수정 실패: ${error.message}`);
    throw ApiError.internal();
  }
}

/**
 * 드랍을 지운다. **되돌릴 수 없다.**
 *
 * 함께 사라지는 것: `run_drop_shares`(`drop_id` 가 `on delete cascade`). 그 외에는
 * 아무것도 딸려 있지 않다 — 결정석과 달리 드랍은 12개 상한에도, 캐릭터별 카운터에도
 * 들어가지 않기 때문이다. 그래서 확인 단계는 두되(화면) 취소/삭제 분기 같은 것은 없다.
 */
export async function removeRunDrop(
  userId: string,
  dropId: string,
): Promise<void> {
  const db = getAdminDb();
  await loadDropForEdit(db, userId, dropId);

  const { error } = await db.from("run_drops").delete().eq("id", dropId);
  if (error !== null) {
    console.error(`[income-repo] 드랍 삭제 실패: ${error.message}`);
    throw ApiError.internal();
  }
}
