import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터별 보스 계획의 **유일한 DB 접근 지점** (DB-SCHEMA 난제 16)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 테이블 `character_boss_plans`, 뷰 3종, 함수 `set_character_boss_plan` /
 *    `sync_character_boss_plan` / `can_view_character_plans` 는 **전부 service_role
 *    전용**이다(마이그레이션 19-10). anon/authenticated 는 `REVOKE ALL` 로 막혀 있어
 *    브라우저에서 Supabase 를 직접 부를 방법이 없다. 접근 경로는 Route Handler 하나뿐이고
 *    그 앞에 세션 검증이 있다.
 *
 * ⚠️ **상한 판정을 여기서 다시 계산하지 않는다.** `weekly_limit` / `weekly_over_limit` /
 *    `weekly_slots_remaining` 과 주간 카운트(`planned_weekly` / `cleared_weekly` /
 *    `remaining_weekly` / `planned_monthly`)는 **전부 뷰가 낸 값을 그대로 옮긴다.**
 *    (`weekly_crystal_sell_limit()` 이 단일 출처라 12 라는 숫자도 여기 없다.)
 *
 * ⚠️ **예외는 `*_total` 5개뿐이다** (`planned_total` / `cleared_total` / `remaining_total` /
 *    `inactive_total` / `conflict_count`). 일간 보스가 범위 밖이 되면서(2026-08-18 발주자
 *    지시, `@/lib/domain/boss-scope`) 이 다섯 개는 뷰 값을 쓸 수 없게 됐다 —
 *    뷰가 일간까지 합쳐 세는데, 뺄셈으로 되돌릴 수도 없다(뷰에 `cleared_monthly` /
 *    `remaining_monthly` 가 없어 "일간분"만 분리해 낼 방법이 없다). 그래서 **이미 일간을
 *    걸러 읽은 계획 행**에서 그 다섯 개만 다시 센다. 12개 상한 판정에는 손대지 않는다 —
 *    일간은 애초에 그 카운터 밖이라 값이 바뀌면 그것이 곧 버그다.
 *
 * ── 열람 범위는 **본인뿐**이다 (난제 16-6) ───────────────────────────────────
 * 가용시간(본인/친구/같은 파티)보다도 좁다. 판정은 `can_view_character_plans()` 하나에
 * 못박혀 있고 여기서는 그것을 호출만 한다 — TS 에 술어를 다시 적으면 웹과 봇이 갈라진다.
 */

import { ApiError } from "@/features/auth/server/http";
import { TRACKED_BOSS_CYCLES } from "@/lib/domain/boss-scope";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import type { BossCycle, BossDifficultyTier } from "@/types/domain";

import { tallyPlanConflicts } from "../lib/plan-conflict";
import type {
  CharacterBossPlan,
  CharacterChecklist,
  CharacterWeeklyProgress,
  ChecklistCharacter,
  PlanOrigin,
  SchedulerChore,
  SchedulerSnapshot,
} from "../types";

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

/** 실패는 우리 문구로 접는다 — PostgREST 에러 원문에는 스키마 구조가 그대로 들어 있다. */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[boss-plan-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[boss-plan-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/**
 * 볼 수 없는 캐릭터는 **존재 여부도 알리지 않는다** — 403 은 "그 캐릭터는 있다"는
 * 정보를 준다. 파티에 쓴 규칙과 같다.
 */
function characterNotVisible(): ApiError {
  return new ApiError(
    "bad_request",
    "캐릭터를 찾을 수 없거나 열람 권한이 없습니다.",
    404,
  );
}

/**
 * 열람 판정. **`can_view_character_plans()` 한 곳에만 있다** (난제 16-6).
 * 비로그인(viewer null)은 DB 함수가 무조건 false 를 주므로 여기서 따로 막지 않아도 되지만,
 * 왕복을 아끼려고 먼저 끊는다.
 */
async function assertCanViewPlans(
  db: AdminDb,
  viewerUserId: string | null,
  characterId: string,
): Promise<void> {
  if (viewerUserId === null) throw characterNotVisible();

  const result = await db.rpc("can_view_character_plans", {
    p_viewer_user_id: viewerUserId,
    p_character_id: characterId,
  });
  if (result.error !== null) {
    console.error(
      `[boss-plan-repo] can_view_character_plans 실패: ${result.error.message}`,
    );
    throw ApiError.internal();
  }
  if (result.data !== true) throw characterNotVisible();
}

/**
 * 쓰기 전 검사. 계획을 쓰려면 **추적 중인 내 캐릭터**여야 한다.
 *
 * 열람(본인)보다 한 칸 좁은 이유: 추적하지 않는 캐릭터는 동기화 대상이 아니라
 * `api_registered` 가 영원히 채워지지 않는다. 계획만 덩그러니 남는 상태를 만들지 않는다.
 */
async function requireOwnedTrackedCharacter(
  db: AdminDb,
  userId: string,
  characterId: string,
): Promise<void> {
  const rows = unwrap(
    await db
      .from("characters")
      .select("id")
      .eq("id", characterId)
      .eq("user_id", userId)
      .eq("is_tracked", true)
      .limit(1),
    "계획 편집 대상 캐릭터 확인",
  );
  if (rows.length === 0) {
    throw ApiError.badRequest(
      "내 추적 캐릭터가 아닙니다. 캐릭터 선택에서 추적 대상에 추가해 주세요.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 뷰 행 → 화면 타입
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **한 줄짜리 문자열 리터럴이어야 한다.** `"a," + "b"` 로 이어 붙이면 TS 가 결과를
 *    `string` 으로 넓혀 버리고, Supabase 타입 클라이언트는 리터럴이 아닌 select 문자열의
 *    행 타입을 풀지 못해 `GenericStringError` 를 돌려준다. 보기 좋게 나누고 싶어도
 *    나누면 타입이 통째로 사라진다.
 */
const PLAN_COLUMNS =
  "plan_id,user_id,character_id,boss_difficulty_id,boss_id,boss_display_name,difficulty,cycle,max_party,default_party_size,released,boss_sort_order,difficulty_sort_order,is_active,manual_active,api_registered,api_observed_at,has_conflict,origin,counts_toward_weekly_limit,is_cleared,cleared_at,note";

/**
 * `default_party_size` 가 **없던 시절의** 컬럼 목록.
 *
 * 마이그레이션 `20260818110000_boss_plan_party_size.sql` 이 아직 적용되지 않은 DB 에서는
 * 위 목록이 PostgREST 42703(undefined_column)으로 통째로 실패하고, 그러면 `/boss-plans`
 * 와 대시보드 체크리스트가 **화면 전체로** 죽는다. 인원수 하나 때문에 목록을 못 보는 것은
 * 어떤 기준으로도 맞지 않으므로, 한 번 실패하면 이 목록으로 떨어져 인원수만 "미설정"으로
 * 읽는다. 다시 시도하지 않도록 프로세스 단위로 기억한다(아래 `planViewHasPartySize`).
 */
const PLAN_COLUMNS_LEGACY =
  "plan_id,user_id,character_id,boss_difficulty_id,boss_id,boss_display_name,difficulty,cycle,max_party,released,boss_sort_order,difficulty_sort_order,is_active,manual_active,api_registered,api_observed_at,has_conflict,origin,counts_toward_weekly_limit,is_cleared,cleared_at,note";

/**
 * 뷰에 `default_party_size` 가 있는가. `null` = 아직 모름.
 *
 * 마이그레이션이 적용되면 프로세스 재시작 시 다시 `null` 에서 출발해 새 컬럼을 집는다.
 * 적용 전 서버가 계속 떠 있는 동안 매 요청마다 실패 왕복을 반복하지 않으려는 캐시일 뿐,
 * 판정의 근거는 언제나 DB 가 준 에러 코드다.
 */
let planViewHasPartySize: boolean | null = null;

/** PostgREST 가 "그런 컬럼 없음"이라고 말했는가. 42703 = undefined_column. */
function isUndefinedColumn(error: { readonly code?: string } | null): boolean {
  return error !== null && error.code === "42703";
}

function warnMissingPartySizeColumn(context: string): void {
  console.warn(
    `[boss-plan-repo] ${context}: v_character_boss_plan_status 에 default_party_size 가 없습니다. ` +
      `20260818110000_boss_plan_party_size.sql 미적용으로 보고 인원수를 "미설정"으로 읽습니다.`,
  );
}

/**
 * ★ **`manual_set_at` 은 뷰에 없다.** 그래서 원본 테이블에서 따로 읽어 채운다.
 *
 * 이 한 컬럼이 있어야 "우리 설정이 더 최신이라 아직 게임에 반영되지 않은 것"과
 * "넥슨이 나중에 관측했는데도 다른 진짜 어긋남"이 갈린다(`lib/plan-conflict.ts`).
 * 뷰에 컬럼을 추가하는 것이 정공법이지만 그러려면 마이그레이션이 필요하고,
 * 미적용분(`20260818110000_boss_plan_party_size.sql`)이 이미 하나 밀려 있어 더 쌓으면
 * 적용 순서가 꼬인다. 왕복 한 번이 그 대가다 — `plan_id` 로만 맞추므로 뷰의 필터와
 * 어긋날 수 없고(없는 키는 그냥 `null` 로 남는다), 인덱스는 PK 를 탄다.
 *
 * `api_observed_at` 은 뷰가 이미 주므로 여기서 다시 읽지 않는다.
 */
async function readManualSetAtByPlanId(
  db: AdminDb,
  column: "character_id" | "user_id",
  value: string,
): Promise<Map<string, string | null>> {
  const rows = unwrap(
    await db
      .from("character_boss_plans")
      .select("id,manual_set_at")
      .eq(column, value),
    "계획 수동 설정 시각 조회",
  );

  const byPlanId = new Map<string, string | null>();
  for (const row of rows) byPlanId.set(row.id, row.manual_set_at);
  return byPlanId;
}

/** 뷰 행에 `manual_set_at` 을 얹는다. 없으면 `null` — "모른다"이지 오류가 아니다. */
function withManualSetAt(
  rows: readonly PlanRow[],
  byPlanId: Map<string, string | null>,
): readonly PlanRow[] {
  return rows.map((row) => ({
    ...row,
    manual_set_at: row.plan_id === null ? null : (byPlanId.get(row.plan_id) ?? null),
  }));
}

/** 캐릭터 하나의 계획 행. 일간은 항상 제외한다(`@/lib/domain/boss-scope`). */
async function readPlanRowsByCharacter(
  db: AdminDb,
  characterId: string,
): Promise<readonly PlanRow[]> {
  const context = "캐릭터 보스 계획 조회";
  const manualSetAtPromise = readManualSetAtByPlanId(
    db,
    "character_id",
    characterId,
  );

  if (planViewHasPartySize !== false) {
    const result = await db
      .from("v_character_boss_plan_status")
      .select(PLAN_COLUMNS)
      .eq("character_id", characterId)
      .in("cycle", [...TRACKED_BOSS_CYCLES]);
    if (!isUndefinedColumn(result.error)) {
      planViewHasPartySize = true;
      return withManualSetAt(unwrap(result, context), await manualSetAtPromise);
    }
    planViewHasPartySize = false;
    warnMissingPartySizeColumn(context);
  }

  return withManualSetAt(
    unwrap(
      await db
        .from("v_character_boss_plan_status")
        .select(PLAN_COLUMNS_LEGACY)
        .eq("character_id", characterId)
        .in("cycle", [...TRACKED_BOSS_CYCLES]),
      context,
    ),
    await manualSetAtPromise,
  );
}

/** 사용자 전체(추적 캐릭터 전원)의 계획 행. 대시보드 체크리스트가 쓴다. */
async function readPlanRowsByUser(
  db: AdminDb,
  userId: string,
): Promise<readonly PlanRow[]> {
  const context = "주간 체크리스트 계획 조회";
  const manualSetAtPromise = readManualSetAtByPlanId(db, "user_id", userId);

  if (planViewHasPartySize !== false) {
    const result = await db
      .from("v_character_boss_plan_status")
      .select(PLAN_COLUMNS)
      .eq("user_id", userId)
      .in("cycle", [...TRACKED_BOSS_CYCLES]);
    if (!isUndefinedColumn(result.error)) {
      planViewHasPartySize = true;
      return withManualSetAt(unwrap(result, context), await manualSetAtPromise);
    }
    planViewHasPartySize = false;
    warnMissingPartySizeColumn(context);
  }

  return withManualSetAt(
    unwrap(
      await db
        .from("v_character_boss_plan_status")
        .select(PLAN_COLUMNS_LEGACY)
        .eq("user_id", userId)
        .in("cycle", [...TRACKED_BOSS_CYCLES]),
      context,
    ),
    await manualSetAtPromise,
  );
}

/** 뷰 컬럼은 전부 nullable 로 생성된다(뷰의 숙명). 핵심 컬럼이 비면 그 행은 버린다. */
interface PlanRow {
  readonly plan_id: string | null;
  readonly character_id: string | null;
  readonly boss_difficulty_id: string | null;
  readonly boss_id: string | null;
  readonly boss_display_name: string | null;
  readonly difficulty: BossDifficultyTier | null;
  readonly cycle: BossCycle | null;
  readonly max_party: number | null;
  /**
   * `?` 인 이유는 nullable 이라서가 아니라 **컬럼이 아예 없을 수 있어서**다
   * (`PLAN_COLUMNS_LEGACY` 로 떨어진 경우). 값의 `null` 은 "미설정"이라는 뜻이고,
   * 키의 부재는 "이 DB 에 아직 기능이 없다"는 뜻이다 — 화면에는 둘 다 미설정으로 보인다.
   */
  readonly default_party_size?: number | null;
  readonly released: boolean | null;
  readonly boss_sort_order: number | null;
  readonly difficulty_sort_order: number | null;
  readonly is_active: boolean | null;
  readonly manual_active: boolean | null;
  readonly api_registered: boolean | null;
  readonly api_observed_at: string | null;
  readonly has_conflict: boolean | null;
  /**
   * ★ **뷰에 없는 컬럼이다.** `withManualSetAt()` 이 원본 테이블에서 읽어 얹는다.
   *   `?` 인 이유는 뷰 결과에는 키가 아예 없기 때문이고, 값의 `null` 은 "수동 판단 없음"
   *   또는 "못 읽었음"을 뜻한다. 판정은 `lib/plan-conflict.ts` 가 한다.
   */
  readonly manual_set_at?: string | null;
  readonly origin: string | null;
  readonly counts_toward_weekly_limit: boolean | null;
  readonly is_cleared: boolean | null;
  readonly cleared_at: string | null;
  readonly note: string | null;
}

function toOrigin(value: string | null): PlanOrigin {
  if (value === "manual" || value === "both") return value;
  return "nexon_api";
}

function toPlan(row: PlanRow): CharacterBossPlan | null {
  if (
    row.plan_id === null ||
    row.character_id === null ||
    row.boss_difficulty_id === null ||
    row.boss_id === null ||
    row.boss_display_name === null ||
    row.difficulty === null ||
    row.cycle === null
  ) {
    return null;
  }
  return {
    planId: row.plan_id,
    characterId: row.character_id,
    bossDifficultyId: row.boss_difficulty_id,
    bossId: row.boss_id,
    bossDisplayName: row.boss_display_name,
    difficulty: row.difficulty,
    cycle: row.cycle,
    maxParty: row.max_party,
    // ★ `?? null` 이지 `?? 1` 이 아니다. 미설정을 1 로 접으면 §1.3 D3 의 과대 계상이
    //   화면에서 사라진 것처럼 보인다.
    defaultPartySize: row.default_party_size ?? null,
    released: row.released ?? true,
    isActive: row.is_active ?? false,
    manualActive: row.manual_active,
    apiRegistered: row.api_registered,
    hasConflict: row.has_conflict ?? false,
    // ★ 두 시각은 화면이 "게임 반영 대기"와 "진짜 어긋남"을 가르는 유일한 근거다.
    //   `hasConflict` 만 내려보내면 예전처럼 방금 바꾼 설정에도 경고가 붙는다.
    manualSetAt: row.manual_set_at ?? null,
    apiObservedAt: row.api_observed_at,
    origin: toOrigin(row.origin),
    // ★ 뷰가 내준 값을 그대로 쓴다. 화면이 cycle 로 다시 판정하면 규칙이 두 벌이 된다.
    countsTowardWeeklyLimit: row.counts_toward_weekly_limit ?? false,
    isCleared: row.is_cleared ?? false,
    clearedAt: row.cleared_at,
    note: row.note,
  };
}

/** 보스 마스터의 정렬 순서를 그대로 따른다 — 목록 순서가 게임 안 순서와 같아야 찾기 쉽다. */
function comparePlanRows(a: PlanRow, b: PlanRow): number {
  return (
    (a.boss_sort_order ?? 0) - (b.boss_sort_order ?? 0) ||
    (a.difficulty_sort_order ?? 0) - (b.difficulty_sort_order ?? 0) ||
    (a.boss_difficulty_id ?? "").localeCompare(b.boss_difficulty_id ?? "")
  );
}

/**
 * `PLAN_COLUMNS` 와 같은 이유로 **한 줄 리터럴**이어야 한다.
 *
 * ★ `planned_total` / `cleared_total` / `remaining_total` / `inactive_total` /
 *   `conflict_count` 는 **읽지 않는다.** 뷰가 일간까지 세기 때문이다(파일 머리말 참고).
 *   `planned_daily` 도 마찬가지로 뺐다 — 일간은 이제 화면에 존재하지 않는 개념이다.
 */
const PROGRESS_COLUMNS =
  "user_id,character_id,character_name,world_name,week_key,planned_weekly,planned_monthly,cleared_weekly,remaining_weekly,weekly_limit,weekly_over_limit,weekly_slots_remaining";

/**
 * 집계 컬럼은 `count(*)` 라 PostgREST 가 **문자열**로 줄 수 있다(numeric/bigint 취급).
 * 전부 12 안팎의 작은 정수라 `Number` 로 좁혀도 정밀도 문제가 없다 — 메소 금액과 다르다.
 */
function toCount(value: number | string | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ProgressRow {
  readonly character_id: string | null;
  readonly character_name: string | null;
  readonly world_name: string | null;
  readonly week_key: string | null;
  readonly planned_weekly: number | string | null;
  readonly planned_monthly: number | string | null;
  readonly cleared_weekly: number | string | null;
  readonly remaining_weekly: number | string | null;
  readonly weekly_limit: number | string | null;
  readonly weekly_over_limit: boolean | null;
  readonly weekly_slots_remaining: number | string | null;
}

/**
 * 뷰가 낼 수 없게 된 다섯 칸 — **일간을 이미 걸러 읽은 계획 행에서만** 센다.
 *
 * 뷰(`v_character_weekly_boss_progress`)의 `*_total` 은 일간까지 합산하고, 거기서
 * "일간분"만 빼낼 수 있는 컬럼이 없다(`cleared_monthly` / `remaining_monthly` 부재).
 * 그래서 이 함수의 입력은 **반드시 `.in("cycle", TRACKED_BOSS_CYCLES)` 로 읽은 행**이어야
 * 하며, 그렇지 않으면 일간이 도로 섞인다. 조건식은 뷰의 `filter (where …)` 절과 글자
 * 그대로 같다 — 규칙을 바꾼 것이 아니라 모집단만 좁힌 것이다.
 */
interface TrackedPlanTally {
  readonly plannedTotal: number;
  readonly clearedTotal: number;
  readonly remainingTotal: number;
  readonly inactiveTotal: number;
  /** 넥슨 관측이 더 최신인데도 다름 — 진짜 어긋남. 이때만 경고한다. */
  readonly conflictDivergedCount: number;
  /** 우리 설정이 더 최신 — 게임 반영 대기. 경고가 아니다. */
  readonly conflictPendingCount: number;
}

function tallyTrackedPlans(rows: readonly PlanRow[]): TrackedPlanTally {
  let plannedTotal = 0;
  let clearedTotal = 0;
  let remainingTotal = 0;
  let inactiveTotal = 0;

  for (const row of rows) {
    const active = row.is_active === true;
    const cleared = row.is_cleared === true;
    if (active) {
      plannedTotal += 1;
      if (cleared) clearedTotal += 1;
      else remainingTotal += 1;
    } else {
      inactiveTotal += 1;
    }
  }

  /*
   * ★ `has_conflict` 를 그대로 세지 않는다. 트리거가 최신성을 비교하지 않아서
   *   사용자가 앱에서 방금 켠 항목까지 전부 세지고, 그러면 요약 문장이
   *   "해소할 방법이 없는 경고 N개"가 된다(§1.1 — 넥슨 스케줄러는 읽기 전용이다).
   *   판정은 `lib/plan-conflict.ts` 하나에만 있고 화면도 같은 함수를 쓴다.
   */
  const conflicts = tallyPlanConflicts(
    rows.map((row) => ({
      hasConflict: row.has_conflict === true,
      manualSetAt: row.manual_set_at ?? null,
      apiObservedAt: row.api_observed_at,
    })),
  );

  return {
    plannedTotal,
    clearedTotal,
    remainingTotal,
    inactiveTotal,
    conflictDivergedCount: conflicts.diverged,
    conflictPendingCount: conflicts.pending,
  };
}

/** 계획 행을 캐릭터별로 묶는다. 집계와 목록이 **같은 행 집합**에서 나오게 하려는 것이다. */
function groupPlanRowsByCharacter(
  rows: readonly PlanRow[],
): Map<string, PlanRow[]> {
  const byCharacter = new Map<string, PlanRow[]>();
  for (const row of rows) {
    if (row.character_id === null) continue;
    const list = byCharacter.get(row.character_id) ?? [];
    list.push(row);
    byCharacter.set(row.character_id, list);
  }
  return byCharacter;
}

/**
 * 뷰의 주간·상한 컬럼 + 우리가 센 `*_total` 을 합쳐 화면 타입을 만든다.
 *
 * ★ 12개 상한 관련 값은 **한 글자도 우리가 만들지 않는다.** 일간은 그 카운터 밖이라
 *   제외해도 값이 변하지 않아야 하고, 변한다면 그것이 회귀다.
 */
function toProgress(
  row: ProgressRow,
  tally: TrackedPlanTally,
): CharacterWeeklyProgress | null {
  if (row.character_id === null || row.week_key === null) return null;
  return {
    characterId: row.character_id,
    characterName: row.character_name ?? "알 수 없음",
    worldName: row.world_name,
    weekKey: row.week_key,
    plannedTotal: tally.plannedTotal,
    plannedWeekly: toCount(row.planned_weekly),
    plannedMonthly: toCount(row.planned_monthly),
    clearedTotal: tally.clearedTotal,
    clearedWeekly: toCount(row.cleared_weekly),
    remainingTotal: tally.remainingTotal,
    remainingWeekly: toCount(row.remaining_weekly),
    inactiveTotal: tally.inactiveTotal,
    conflictDivergedCount: tally.conflictDivergedCount,
    conflictPendingCount: tally.conflictPendingCount,
    // ★ 상한값도 뷰에서 온다. `weekly_crystal_sell_limit()` 이 단일 출처다.
    weeklyLimit: toCount(row.weekly_limit),
    weeklyOverLimit: row.weekly_over_limit ?? false,
    weeklySlotsRemaining: toCount(row.weekly_slots_remaining),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 스케줄러 스냅샷 — `보스 10/12` 의 출처
// ─────────────────────────────────────────────────────────────────────────────

/** 저장된 payload 한 건의 최소 모양 (`SNAPSHOT_PAYLOAD_SCHEMA` 참고). */
interface StoredChore {
  readonly contentName?: unknown;
  readonly type?: unknown;
  readonly registered?: unknown;
  readonly nowCount?: unknown;
  readonly maxCount?: unknown;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 주간 숙제 목록을 payload 에서 꺼낸다.
 *
 * ★ payload 에는 **정규화된 형태**가 들어 있다(`sync-scheduler.ts` 의
 *   `SNAPSHOT_PAYLOAD_SCHEMA` 주석 참고). 넥슨 원문의 문자열 플래그(`"false"`)를
 *   그대로 저장하면 읽는 쪽마다 파싱을 다시 하게 되고, `"false"` 가 JS 에서 참이라
 *   한 곳만 빠뜨려도 등록하지 않은 숙제가 전부 등록된 것으로 보인다(§1.0).
 *   접기는 `lib/nexon/client.ts` 경계에서 이미 끝나 있고 그 결과를 저장한다.
 * ★ 등록한 것만 남긴다 — 22건 전부를 늘어놓으면 할 일 목록이 아니라 카탈로그가 된다.
 */
function toWeeklyChores(payload: unknown): readonly SchedulerChore[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as { weeklyContents?: unknown }).weeklyContents;
  if (!Array.isArray(raw)) return [];

  const chores: SchedulerChore[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const chore = entry as StoredChore;
    if (typeof chore.contentName !== "string") continue;
    if (chore.registered !== true) continue;
    chores.push({
      contentName: chore.contentName,
      type: typeof chore.type === "string" ? chore.type : null,
      registered: true,
      nowCount: asNumberOrNull(chore.nowCount),
      maxCount: asNumberOrNull(chore.maxCount),
    });
  }
  return chores;
}

/** `PLAN_COLUMNS` 와 같은 이유로 **한 줄 리터럴**이어야 한다. */
const SNAPSHOT_COLUMNS =
  "character_id,snapshot_at,fetched_at,weekly_boss_clear_count,weekly_boss_clear_limit_count,payload";

/**
 * 캐릭터별 **최신** 스냅샷.
 *
 * 캐릭터마다 `order by snapshot_at desc limit 1` 을 따로 돌리면 N 왕복이 된다.
 * 한 번에 읽고 TS 에서 첫 행만 남긴다 — 정렬은 DB 가 하므로 우리가 비교하는 것은
 * "이 캐릭터를 이미 봤는가" 하나뿐이다.
 */
async function loadLatestSnapshots(
  db: AdminDb,
  characterIds: readonly string[],
): Promise<Map<string, SchedulerSnapshot>> {
  const byCharacter = new Map<string, SchedulerSnapshot>();
  if (characterIds.length === 0) return byCharacter;

  const rows = unwrap(
    await db
      .from("character_scheduler_snapshots")
      .select(SNAPSHOT_COLUMNS)
      .in("character_id", [...characterIds])
      .order("snapshot_at", { ascending: false }),
    "스케줄러 스냅샷 조회",
  );

  for (const row of rows) {
    if (byCharacter.has(row.character_id)) continue;
    byCharacter.set(row.character_id, {
      snapshotAt: row.snapshot_at,
      fetchedAt: row.fetched_at,
      weeklyBossClearCount: row.weekly_boss_clear_count,
      weeklyBossClearLimitCount: row.weekly_boss_clear_limit_count,
      weeklyChores: toWeeklyChores(row.payload),
    });
  }
  return byCharacter;
}

// ─────────────────────────────────────────────────────────────────────────────
// 읽기
// ─────────────────────────────────────────────────────────────────────────────

export interface CharacterPlanBundle {
  readonly plans: readonly CharacterBossPlan[];
  readonly progress: CharacterWeeklyProgress | null;
  readonly snapshot: SchedulerSnapshot | null;
}

/**
 * 캐릭터 하나의 계획 전체 + 이번 주 진행 상황 + 마지막 동기화 결과.
 *
 * ★ 일간 보스는 여기서 빠진다(`@/lib/domain/boss-scope`). 이미 저장돼 있는 일간 계획
 *   행은 **지우지 않고** 조회에서만 제외한다 — 과거 데이터 파기는 되돌릴 수 없다.
 */
export async function fetchCharacterPlanBundle(
  viewerUserId: string | null,
  characterId: string,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await assertCanViewPlans(db, viewerUserId, characterId);

  const [planRows, progressRows, snapshots] = await Promise.all([
    // ★ 일간 제외는 헬퍼 안에 있다. `tallyTrackedPlans()` 의 전제이기도 하다.
    readPlanRowsByCharacter(db, characterId),
    (async () =>
      unwrap(
        await db
          .from("v_character_weekly_boss_progress")
          .select(PROGRESS_COLUMNS)
          .eq("character_id", characterId),
        "캐릭터 주간 진행 상황 조회",
      ))(),
    loadLatestSnapshots(db, [characterId]),
  ]);

  const plans = [...planRows]
    .sort(comparePlanRows)
    .flatMap((row) => {
      const plan = toPlan(row);
      return plan === null ? [] : [plan];
    });

  const progressRow = progressRows[0];

  return {
    plans,
    progress:
      progressRow === undefined
        ? null
        : toProgress(progressRow, tallyTrackedPlans(planRows)),
    snapshot: snapshots.get(characterId) ?? null,
  };
}

/**
 * 캐릭터 → **그 캐릭터를 읽을 수 있는 자격증명**.
 *
 * 조인은 이미 `v_character_sync_source` 에 있다(마이그레이션 12-4):
 * `characters.nexon_account_ref → credential_nexon_accounts → user_credentials`,
 * 그중 무효화되지 않은 키를 최근 검증 순으로 하나 고른다. **여기서 다시 조인하지 않는다** —
 * 두 벌이 되면 "동기화 가능"의 정의가 웹과 DB 에서 갈라진다.
 *
 * ⚠️ 뷰는 `credential_id` 와 `allow_server_side_use` 만 준다 — **원문도 암호문도 여기에
 *    없다**(§2.1.2). 서버가 키를 쓸 때는 `user_credentials` 에서 따로 복호화하며, 이
 *    함수가 싣는 것은 "어느 자격증명인가"와 "서버가 그 키를 갖고 있는가" 두 가지뿐이다.
 *    후자가 곧 화면이 "이 브라우저에 키 없음"을 경고로 그릴지 말지의 판정 근거다.
 */
interface CharacterCredential {
  readonly id: string;
  readonly label: string | null;
  /** 서버가 이 자격증명의 키를 대신 부를 수 있는가(`allow_server_side_use`). */
  readonly hasServerKey: boolean;
}

async function loadCredentialByCharacter(
  db: AdminDb,
  userId: string,
): Promise<Map<string, CharacterCredential>> {
  const rows = unwrap(
    await db
      .from("v_character_sync_source")
      .select(
        "character_id,credential_id,credential_label,allow_server_side_use",
      )
      .eq("user_id", userId),
    "캐릭터별 동기화 자격증명 조회",
  );

  const byCharacter = new Map<string, CharacterCredential>();
  for (const row of rows) {
    // 뷰 컬럼은 전부 nullable 이다(뷰의 숙명). 둘 중 하나라도 비면 "동기화 불가"다.
    if (row.character_id === null || row.credential_id === null) continue;
    byCharacter.set(row.character_id, {
      id: row.credential_id,
      label: row.credential_label,
      hasServerKey: row.allow_server_side_use === true,
    });
  }
  return byCharacter;
}

/** 체크리스트에 넣을 추적 캐릭터. 정렬은 본캐 → 레벨 내림차순. */
export async function fetchTrackedChecklistCharacters(
  db: AdminDb,
  userId: string,
): Promise<readonly ChecklistCharacter[]> {
  const [rows, credentialByCharacter] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("characters")
          .select(
            "id,character_name,world_name,character_class,character_level,is_main",
          )
          .eq("user_id", userId)
          .eq("is_tracked", true),
        "추적 캐릭터 조회",
      ))(),
    loadCredentialByCharacter(db, userId),
  ]);

  return rows
    .map((row): ChecklistCharacter => {
      const credential = credentialByCharacter.get(row.id) ?? null;
      return {
        characterId: row.id,
        name: row.character_name,
        worldName: row.world_name,
        className: row.character_class,
        level: row.character_level,
        isMain: row.is_main,
        credentialId: credential?.id ?? null,
        credentialLabel: credential?.label ?? null,
        serverKeyAvailable: credential?.hasServerKey ?? false,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isMain) - Number(a.isMain) ||
        (b.level ?? 0) - (a.level ?? 0) ||
        // `localeCompare` 를 쓰지 않는다 — ICU 버전이 서버/브라우저에서 달라
        // 정렬이 갈릴 수 있다(대시보드의 같은 정렬과 동일한 이유).
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/**
 * 대시보드 첫 화면 (§1.1.1) — 추적 캐릭터 **전원**의 주간 체크리스트.
 *
 * ★ **넥슨을 부르지 않는다.** 캐릭터당 1콜이라 대시보드 진입만으로 자동 호출하면
 *   11명 추적 시 열 때마다 11콜이 나간다(개발 키 하루 1,000콜). 최신화는 사용자가
 *   버튼을 눌렀을 때만 일어난다 — 동기화한 적 없는 캐릭터는 빈 상태로 안내한다.
 *
 * 왕복은 캐릭터 수와 무관하게 **4번**이다(캐릭터 / 계획 / 진행 / 스냅샷).
 */
export async function fetchWeeklyChecklist(
  userId: string,
): Promise<readonly CharacterChecklist[]> {
  const db = getAdminDb();
  const characters = await fetchTrackedChecklistCharacters(db, userId);
  if (characters.length === 0) return [];

  const characterIds = characters.map((entry) => entry.characterId);

  const [planRows, progressRows, snapshots] = await Promise.all([
    // ★ 일간 제외 (`@/lib/domain/boss-scope`)는 헬퍼 안에 있다. 그 한 줄이 체크리스트·
    //   진행률·숨김 개수까지 한꺼번에 일간에서 떼어 놓는다.
    readPlanRowsByUser(db, userId),
    (async () =>
      unwrap(
        await db
          .from("v_character_weekly_boss_progress")
          .select(PROGRESS_COLUMNS)
          .eq("user_id", userId),
        "주간 체크리스트 진행 상황 조회",
      ))(),
    loadLatestSnapshots(db, characterIds),
  ]);

  /*
   * ★ **켜져 있는 계획 전부를 싣는다 — 클리어한 것까지.** (발주자 지시, 2026-08-18)
   *   예전에는 `is_cleared` 까지 걸러 "남은 것"만 보냈는데, 대시보드가 12칸 그리드가
   *   되면서 잡은 보스도 칸을 차지해야 한다(잡은 것은 취소선 + 회색). 화면이 다시
   *   `isCleared` 로 거르면 예전의 "남은 목록"이 그대로 나오므로 **배열을 두 벌 보내지
   *   않는다** — 두 벌이 되면 반드시 갈라진다.
   *
   *   꺼 둔 계획(`is_active = false`)은 여전히 빠진다. 그건 "이번 주에 안 간다"는 뜻이라
   *   그리드에 자리를 줄 이유가 없고, 12칸 상한 계산에도 들어가지 않는다.
   *   정렬은 보스 마스터 순서 그대로다 — 클리어할 때마다 칸이 뒤섞이면 훑어보기가 무너진다.
   */
  const rowsByCharacter = groupPlanRowsByCharacter(planRows);

  const plannedByCharacter = new Map<string, CharacterBossPlan[]>();
  for (const row of [...planRows].sort(comparePlanRows)) {
    if (row.is_active !== true) continue;
    const plan = toPlan(row);
    if (plan === null) continue;
    const list = plannedByCharacter.get(plan.characterId) ?? [];
    list.push(plan);
    plannedByCharacter.set(plan.characterId, list);
  }

  const progressByCharacter = new Map<string, CharacterWeeklyProgress>();
  for (const row of progressRows) {
    if (row.character_id === null) continue;
    const progress = toProgress(
      row,
      tallyTrackedPlans(rowsByCharacter.get(row.character_id) ?? []),
    );
    if (progress !== null) {
      progressByCharacter.set(progress.characterId, progress);
    }
  }

  return characters.map((character) => ({
    character,
    progress: progressByCharacter.get(character.characterId) ?? null,
    snapshot: snapshots.get(character.characterId) ?? null,
    planned: plannedByCharacter.get(character.characterId) ?? [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기 — 사람이 켜고 끄는 경로 (`manual_*` 만 건드린다)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 계획을 켜거나 끈다. → `public.set_character_boss_plan(character, boss_difficulty, active)`
 *
 * ★ **UPSERT 를 직접 쓰지 않는다.** 규칙이 트리거에 있어도 앱이
 *   `on conflict do update set manual_active = …` 를 잘못 쓰면 동기화 값이 섞인다.
 *   그래서 쓰기 경로가 함수 둘로 고정돼 있고(난제 16-2), 이쪽은 `manual_*` 만 만진다.
 * ★ **13개째도 막지 않는다.** 계획은 탐색적이라 후보를 올려 두고 끄는 과정을 지난다
 *   (난제 16-3). 초과는 뷰의 `weekly_over_limit` 으로 **경고만** 한다.
 */
export async function setCharacterBossPlan(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
  active: boolean,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  const result = await db.rpc("set_character_boss_plan", {
    p_character_id: characterId,
    p_boss_difficulty_id: bossDifficultyId,
    p_active: active,
  });
  if (result.error !== null) {
    console.error(
      `[boss-plan-repo] set_character_boss_plan 실패: ${result.error.message}`,
    );
    // 존재하지 않는 보스 엔트리는 사용자가 고칠 수 있는 입력 오류다.
    throw ApiError.badRequest(
      "계획을 저장하지 못했습니다. 보스 항목이 올바른지 확인해 주세요.",
    );
  }

  return fetchCharacterPlanBundle(userId, characterId);
}

/**
 * 계획을 목록에서 **완전히 지운다**.
 *
 * `set_character_boss_plan(..., false)` 는 "끈 채로 목록에 남긴다"는 뜻이고, 이건 다르다.
 * 난이도를 잘못 골라 추가한 행을 되돌릴 길이 필요해서 둘 다 제공한다.
 *
 * ⚠️ 삭제 전용 DB 함수는 없다(난제 16 각주 24). 그래서 여기서 직접 지우되,
 *    `user_id` + `character_id` 를 **함께** 걸어 남의 행에 닿을 수 없게 한다 —
 *    `requireOwnedTrackedCharacter` 와 겹치는 이중 방어다.
 */
export async function removeCharacterBossPlan(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  const { error } = await db
    .from("character_boss_plans")
    .delete()
    .eq("user_id", userId)
    .eq("character_id", characterId)
    .eq("boss_difficulty_id", bossDifficultyId);

  if (error !== null) {
    console.error(`[boss-plan-repo] 계획 삭제 실패: ${error.message}`);
    throw ApiError.internal();
  }

  return fetchCharacterPlanBundle(userId, characterId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기 — 기본 파티 인원수 (마이그레이션 21)
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST 가 "그런 함수 없음"이라고 말했는가. PGRST202 = 스키마 캐시에 없는 함수. */
function isMissingFunction(error: { readonly code?: string } | null): boolean {
  return error !== null && error.code === "PGRST202";
}

/**
 * 마이그레이션 미적용은 **500 이 아니라 사용자가 읽을 수 있는 문장**으로 접는다.
 * 여기서 500 을 내면 화면에는 "요청을 처리하지 못했습니다"만 뜨고, 무엇을 해야 하는지가
 * 로그에만 남는다 — 아무도 못 고치는 오류가 된다.
 */
function partySizeFeatureUnavailable(): ApiError {
  return ApiError.badRequest(
    "인원수 설정 기능이 아직 데이터베이스에 적용되지 않았습니다. " +
      "supabase/migrations/20260818110000_boss_plan_party_size.sql 을 적용해 주세요.",
  );
}

/**
 * "이 보스를 몇 인으로 도는가"를 정한다.
 * → `public.set_character_boss_plan_party_size(character, boss_difficulty, size)`
 *
 * ★ `partySize = null` 은 **설정 해제**다. 0 이 아니고, 1 로 접지도 않는다 —
 *   미설정과 1인은 다른 상태이기 때문이다(§1.3 D3, 마이그레이션 21 머리말).
 * ★ **이미 쌓인 클리어를 소급해서 바꾸지 않는다.** DB 함수가 `default_party_size` 한
 *   컬럼만 만지므로 구조적으로 그렇게 될 수 없다. 소급은 아래 별도 함수뿐이다.
 * ★ `max_party` 초과도 저장한다(§1.3 D5 — 대부분 추정치라 막으면 진짜 파티를 거부한다).
 *   경고는 화면이 한다.
 */
export async function setCharacterBossPlanPartySize(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
  partySize: number | null,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  const result = await db.rpc("set_character_boss_plan_party_size", {
    p_character_id: characterId,
    p_boss_difficulty_id: bossDifficultyId,
    p_party_size: partySize,
  });
  if (result.error !== null) {
    if (isMissingFunction(result.error)) throw partySizeFeatureUnavailable();
    console.error(
      `[boss-plan-repo] set_character_boss_plan_party_size 실패: ${result.error.message}`,
    );
    // 계획에 없는 보스(no_data_found)와 범위 밖 값(check_violation) 둘 다
    // **사용자가 고칠 수 있는 입력 오류**다. 서버 내부 사정이 아니다.
    throw ApiError.badRequest(
      "인원수를 저장하지 못했습니다. 목록에 있는 보스인지, 1~24 사이 값인지 확인해 주세요.",
    );
  }

  return fetchCharacterPlanBundle(userId, characterId);
}

export interface ApplyPartySizeOutcome {
  readonly affected: number;
  readonly dryRun: boolean;
  /** 실제 적용일 때만 갱신된 번들을 싣는다. 미리보기는 아무것도 바꾸지 않았다. */
  readonly bundle: CharacterPlanBundle | null;
}

/**
 * **이미 쌓인 미확인 클리어**에 계획의 기본 인원수를 적용한다.
 * → `public.apply_plan_party_sizes_to_clears(character, dry_run)`
 *
 * ⚠️ 되돌릴 수 없다. 그래서 `dryRun` 이 있고, 화면은 건수를 먼저 보여 주고 확인을 받는다.
 *    대상 판정식은 DB 함수 하나에만 있으므로 미리보기와 실행이 어긋날 수 없다.
 *
 * ★ 사용자가 **이미 확인한 인원**(`party_size_confirmed`)과 **런에 걸린 클리어**는 대상이
 *   아니다. 사실이 기본값을 이긴다는 규칙이 DB 쪽 WHERE 절에 그대로 적혀 있다.
 * ★ 인원 수정은 DB 안에서도 `set_clear_party_size()` 를 통과한다 — 금액 재계산과 주기
 *   보존 규약을 우회하는 경로를 새로 만들지 않는다.
 */
export async function applyPlanPartySizesToClears(
  userId: string,
  characterId: string,
  dryRun: boolean,
): Promise<ApplyPartySizeOutcome> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  const result = await db.rpc("apply_plan_party_sizes_to_clears", {
    p_character_id: characterId,
    p_dry_run: dryRun,
  });
  if (result.error !== null) {
    if (isMissingFunction(result.error)) throw partySizeFeatureUnavailable();
    console.error(
      `[boss-plan-repo] apply_plan_party_sizes_to_clears 실패: ${result.error.message}`,
    );
    throw ApiError.internal();
  }

  const affected = typeof result.data === "number" ? result.data : 0;

  return {
    affected,
    dryRun,
    bundle: dryRun ? null : await fetchCharacterPlanBundle(userId, characterId),
  };
}
