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
 *    13번째 켜기를 막는 가드(`assertWeeklyPlanSlotAvailable`)도 **뷰가 낸
 *    `planned_weekly` / `weekly_limit` 을 읽어 비교만** 한다 — 세는 일은 여전히 뷰가 한다.
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
import { getBossEntry } from "@/lib/boss-master";
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
 * 어떤 기준으로도 맞지 않으므로, 한 번 실패하면 이 목록으로 떨어져 인원수를 **기본값 1**
 * 로 읽는다(2026-08-19 — 예전에는 "미설정"이었다). 다시 시도하지 않도록 프로세스 단위로
 * 기억한다(아래 `planViewHasPartySize`).
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
      `20260818110000_boss_plan_party_size.sql 미적용으로 보고 인원수를 기본값 1 로 읽습니다.`,
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
   * (`PLAN_COLUMNS_LEGACY` 로 떨어진 경우). 마이그레이션 25 이후 컬럼은 `NOT NULL` 이므로
   * 값의 `null` 은 **마이그레이션 25 이전 DB** 에서만 나오고, 키의 부재는 "이 DB 에 아직
   * 기능이 없다"는 뜻이다 — 둘 다 화면에는 기본값 `1` 로 보인다.
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
    /*
     * ★ 2026-08-19 부터 `?? 1` 이다(예전에는 `?? null`).
     *   컬럼이 `NOT NULL DEFAULT 1` 이라 값이 비는 경우는 **마이그레이션 25 이전 DB 에서
     *   `PLAN_COLUMNS_LEGACY` 로 떨어졌을 때**뿐이고, 그때 화면에 보여야 하는 값도 1 이다
     *   (발주자 지시: "그냥 1인을 기본으로 잡아 굳이 1이라고 설정안하게").
     *   ⚠️ 이 접기의 대가는 §1.3 D3 의 과대 계상이 경고 없이 지나간다는 것이다 — 알고 한다.
     */
    defaultPartySize: row.default_party_size ?? 1,
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

/**
 * 보스 마스터의 정렬 순서를 **뒤집어서** 따른다 — **최신 보스가 맨 위다.**
 *
 * 발주자 지적(2026-08-18): *"스케줄러, 혹은 보스로 등록된것 아래부터 역정렬해서 보여줘.
 * 유피테르가 맨 위로 오게 뭔 카오스 피에르여"* — "스케줄러"가 곧 이 목록이다
 * (인게임 `registration_flag` → `v_character_boss_plan_status`).
 *
 * 카탈로그(`@/lib/boss-master` 의 `getTrackedBossCatalog`)도 같은 날 뒤집었다. 둘이
 * 같은 패널에 위아래로 놓이므로(`run-composer` 의 ②와 ③) 한쪽만 뒤집으면 **같은 보스가
 * 목록마다 다른 자리에** 나타나고, 그러면 매번 다시 찾아야 한다.
 *
 * 마지막 `localeCompare` 만 오름차순으로 남긴다. 그것은 순서에 뜻이 없는 **동점
 * 처리기**라, 뒤집으면 정렬이 안정적이지 않다는 인상만 준다.
 */
function comparePlanRows(a: PlanRow, b: PlanRow): number {
  return (
    (b.boss_sort_order ?? 0) - (a.boss_sort_order ?? 0) ||
    (b.difficulty_sort_order ?? 0) - (a.difficulty_sort_order ?? 0) ||
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
      // ★ 방향까지 넘긴다. 사용자가 **끈** 보스는 어긋남이 아니라 지켜진 판단이다.
      manualActive: row.manual_active,
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
  readonly questState?: unknown;
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
  return toChores(payload, "weeklyContents");
}

/**
 * 일간 숙제. 주간과 **같은 규칙**이라 한 함수를 공유한다.
 *
 * ★ 일간을 따로 읽기 시작한 이유(2026-08-19): `!숙제` 가 `일퀘 · 몬파` 를 보여줘야 하는데
 *   `dailyContents` 는 `sync-scheduler` 가 이미 payload 에 저장하고 있었고 읽는 쪽만
 *   없었다. 넥슨을 다시 부르지 않는다 — 이미 받아 둔 바이트를 읽을 뿐이다.
 */
function toDailyChores(payload: unknown): readonly SchedulerChore[] {
  return toChores(payload, "dailyContents");
}

function toChores(
  payload: unknown,
  key: "weeklyContents" | "dailyContents",
): readonly SchedulerChore[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as Record<string, unknown>)[key];
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
      questState: asNumberOrNull(chore.questState),
    });
  }
  return chores;
}

/** `PLAN_COLUMNS` 와 같은 이유로 **한 줄 리터럴**이어야 한다. */
const SNAPSHOT_COLUMNS =
  "character_id,snapshot_at,fetched_at,weekly_boss_clear_count,weekly_boss_clear_limit_count,payload";

/** 스냅샷 행 → 도메인. 두 로더가 **같은 변환**을 쓰도록 한 곳에 뒀다. */
function collectLatestSnapshots(
  rows: readonly {
    readonly character_id: string;
    readonly snapshot_at: string;
    readonly fetched_at: string;
    readonly weekly_boss_clear_count: number | null;
    readonly weekly_boss_clear_limit_count: number | null;
    readonly payload: unknown;
  }[],
): Map<string, SchedulerSnapshot> {
  const byCharacter = new Map<string, SchedulerSnapshot>();
  for (const row of rows) {
    if (byCharacter.has(row.character_id)) continue;
    byCharacter.set(row.character_id, {
      snapshotAt: row.snapshot_at,
      fetchedAt: row.fetched_at,
      weeklyBossClearCount: row.weekly_boss_clear_count,
      weeklyBossClearLimitCount: row.weekly_boss_clear_limit_count,
      weeklyChores: toWeeklyChores(row.payload),
      dailyChores: toDailyChores(row.payload),
    });
  }
  return byCharacter;
}

/**
 * **추적 캐릭터 전원**의 최신 스냅샷 — 캐릭터 id 목록을 기다리지 않는다.
 *
 * ★ 이게 요점이다 (2026-08-18 성능 작업). 예전에는 체크리스트가 `추적 캐릭터 조회 →
 *   (계획 ∥ 진행 ∥ 스냅샷)` 의 직렬 2단이었는데, **직렬인 이유가 스냅샷 하나뿐**이었다
 *   (계획·진행은 `user_id` 로 바로 읽는다). `characters!inner` 로 소유자를 걸면
 *   스냅샷도 `user_id` 만으로 읽히므로 네 조회가 전부 같은 단에서 출발한다.
 *
 * ⚠️ 모집단이 `fetchTrackedChecklistCharacters` 와 **정확히 같아야** 한다
 *    (`user_id` + `is_tracked = true`). 넓히면 추적 해제한 캐릭터의 스냅샷이 딸려 오고,
 *    좁히면 카드가 "동기화한 적 없음"으로 잘못 보인다.
 */
export async function loadLatestSnapshotsByUser(
  db: AdminDb,
  userId: string,
): Promise<Map<string, SchedulerSnapshot>> {
  const rows = unwrap(
    await db
      .from("character_scheduler_snapshots")
      .select(
        "character_id,snapshot_at,fetched_at,weekly_boss_clear_count,weekly_boss_clear_limit_count,payload,characters!inner(user_id,is_tracked)",
      )
      .eq("characters.user_id", userId)
      .eq("characters.is_tracked", true)
      .order("snapshot_at", { ascending: false }),
    "스케줄러 스냅샷 조회",
  );
  return collectLatestSnapshots(rows);
}

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

  for (const [id, snapshot] of collectLatestSnapshots(rows)) {
    byCharacter.set(id, snapshot);
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

  /*
   * ★ **열람 검사와 본문 조회를 동시에 띄운다** (2026-08-18 성능 작업 —
   *   `schedule-repo` 의 `assertPartyVisible` 과 **같은 결의 문제**라 같이 고쳤다, §0.2-1).
   *
   *   ⚠️ **판정은 한 글자도 바뀌지 않는다.** 검사가 거절하면 아래 `await gate` 가 먼저
   *      던지므로 **한 바이트도 밖으로 나가지 않는다** — 읽어 둔 행은 그대로 버려진다.
   *      달라지는 것은 "볼 수 없는 사람이었다면 하지 않았을 조회 셋"이 함께 나간다는
   *      점뿐인데, 그건 service_role 내부 조회다. 볼 수 있는 사람(=거의 전부)에게는
   *      왕복 한 단계(≈78ms)가 통째로 사라진다.
   *   ⚠️ `reads` 에 미리 `catch` 를 달아 둔다. 검사가 먼저 거절하면 본문 조회의 실패는
   *      아무도 안 받는 상태가 되는데, 그게 곧 미처리 프라미스 거절이다.
   */
  const gate = assertCanViewPlans(db, viewerUserId, characterId);
  const reads = Promise.all([
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
  reads.catch(() => {
    /* 아래 `await reads` 가 진짜 오류를 던진다. 여기서는 미처리 거절만 막는다. */
  });

  await gate;
  const [planRows, progressRows, snapshots] = await reads;

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

  /*
   * ★ **직렬 2단 → 1단** (2026-08-18 성능 작업). 예전에는 추적 캐릭터 명단을 받은 **뒤에**
   *   나머지 셋이 출발했는데, 셋 중 둘(계획 · 진행)은 명단을 쓰지 않고 `user_id` 로 바로
   *   읽는다. 남은 하나(스냅샷)만 캐릭터 id 를 필요로 했고, 그것도 `characters!inner` 로
   *   소유자를 걸면 필요 없어진다 — 그래서 넷이 전부 같은 단에서 출발한다.
   */
  const [characters, planRows, progressRows, snapshots] = await Promise.all([
    fetchTrackedChecklistCharacters(db, userId),
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
    loadLatestSnapshotsByUser(db, userId),
  ]);

  /*
    추적 캐릭터가 없으면 화면에 그릴 카드가 없다. 나머지 셋은 이미 함께 나갔지만
    **버리는 쪽이 맞다** — 명단이 비어 있는데 계획만 있는 상태는 그릴 자리가 없다.
    (예전에는 여기서 조기 반환해 셋을 아예 안 보냈다. 사람이 캐릭터를 하나도 추적하지
     않는 것은 첫 로그인 직후뿐이라, 그 한 경우를 위해 일상 경로를 2단으로 두지 않는다.)
  */
  if (characters.length === 0) return [];

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
 * **13번째 주간 보스를 새로 켜려는가.** 그렇다면 막는다 (발주자 지시, 2026-08-18).
 *
 * ── 왜 규칙이 바뀌었나 ───────────────────────────────────────────────────────
 * 원래는 "계획은 탐색적이니 후보를 올려 두고 끄면 된다"(난제 16-3)라며 13번째도 저장했다.
 * 그런데 2025-08-21 패치 이후 **13번째 주간 보스는 입장 자체가 불가능하다**(§1). 즉 켜
 * 봐야 갈 수 없는 계획이고, 저장해 주면 12개 카운터와 결정석 수익 예측이 조용히 틀어진다.
 * "후보를 올려 둔다"는 사용법은 **끄기**(`manual_active = false`)가 이미 지원한다 —
 * 목록에는 남고 카운터에서만 빠지므로 탐색은 그대로 가능하다.
 *
 * ── 막는 범위는 정확히 한 가지 동작뿐이다 ────────────────────────────────────
 *   · **월간은 세지 않는다.** 검은 마법사는 12개 카운터 밖이다(§1). 판정 근거는 뷰와
 *     같은 `boss_difficulties.cycle = 'weekly'` 하나다.
 *   · **이미 켜져 있는 행을 다시 켜는 것**은 슬롯을 새로 먹지 않으므로 통과시킨다.
 *   · **끄기(`active = false`)는 절대 막지 않는다.** 상한을 넘긴 사람이 줄일 수 있는
 *     유일한 길을 막으면 갇힌다.
 *   · **이미 넘어 있는 상태(지금 14개)를 강제로 잘라내지 않는다.** 어느 것을 끌지는
 *     사용자가 정한다 — 여기서 하는 일은 "더 늘리지 않는다" 하나뿐이다.
 *   · 동기화가 넣는 `api_registered` 도 막지 않는다. 이 함수는 사람이 누른 경로에만 있고,
 *     인게임 목록은 관측된 사실이라 우리가 거부할 대상이 아니다.
 *
 * 상한값(12)은 여전히 코드에 없다 — 뷰가 `weekly_crystal_sell_limit()` 에서 낸 값을 읽는다.
 */
async function assertWeeklyPlanSlotAvailable(
  db: AdminDb,
  characterId: string,
  bossDifficultyId: string,
): Promise<void> {
  /*
    ★ 보스 마스터는 **코드 상수**다(`@/lib/boss-master`). 예전에는 이 판정 하나 때문에
      계획을 켤 때마다 `boss_difficulties` 왕복이 한 번 더 나갔다. 주기·이름은 게임
      패치 때만 바뀌는 값이라 물어볼 이유가 없다. 슬롯 잔량(아래)만 DB 가 센다.
  */
  const boss = getBossEntry(bossDifficultyId);
  // 없는 보스는 여기서 판정하지 않는다 — DB 함수의 FK 가 더 정확한 오류를 낸다.
  if (boss === undefined) return;
  // ★ 월간(검은 마법사)·일간은 12개 카운터 밖이다 (§1). 뷰의 판정식과 같은 한 줄.
  if (boss.cycle !== "weekly") return;

  const planRows = unwrap(
    await db
      .from("character_boss_plans")
      .select("is_active")
      .eq("character_id", characterId)
      .eq("boss_difficulty_id", bossDifficultyId)
      .limit(1),
    "계획 현재 상태 확인",
  );
  // 이미 켜져 있으면 슬롯을 새로 먹지 않는다.
  if (planRows[0]?.is_active === true) return;

  const progressRows = unwrap(
    await db
      .from("v_character_weekly_boss_progress")
      .select("planned_weekly,weekly_limit")
      .eq("character_id", characterId),
    "주간 슬롯 잔량 확인",
  );
  const progress = progressRows[0];
  // 계획이 한 줄도 없으면 뷰에 행 자체가 없다. 그 상태에서 상한에 닿을 수는 없다.
  if (progress === undefined) return;

  const planned = toCount(progress.planned_weekly);
  const limit = toCount(progress.weekly_limit);
  if (limit <= 0 || planned < limit) return;

  throw ApiError.badRequest(
    `주간 보스는 캐릭터당 ${limit}개까지만 입장할 수 있어 ${limit + 1}번째는 켜도 갈 수 없습니다. ` +
      `지금 ${planned}개가 켜져 있어 "${boss.koreanName}" 을(를) 켜지 못했습니다 — ` +
      `이번 주에 가지 않을 보스를 목록에서 먼저 끄고 다시 눌러 주세요. ` +
      `월간 보스는 이 ${limit}개에 들어가지 않습니다.`,
  );
}

/**
 * 계획을 켜거나 끈다. → `public.set_character_boss_plan(character, boss_difficulty, active)`
 *
 * ★ **UPSERT 를 직접 쓰지 않는다.** 규칙이 트리거에 있어도 앱이
 *   `on conflict do update set manual_active = …` 를 잘못 쓰면 동기화 값이 섞인다.
 *   그래서 쓰기 경로가 함수 둘로 고정돼 있고(난제 16-2), 이쪽은 `manual_*` 만 만진다.
 *
 * ★ **끄기는 곧 묘비다.** `manual_active = false` 와 `manual_set_at = now()` 가 남고,
 *   트리거의 `coalesce(manual_active, api_registered, false)` 가 그 `false` 를 집으므로
 *   **다음 동기화가 이 보스를 되살릴 수 없다.** 넥슨이 `registration_flag = true` 라고
 *   계속 말해도 결과는 꺼진 상태 그대로다 — 사용자가 한 번 내린 판단이 유지된다는 뜻이며,
 *   행을 지우는 방식(옛 `removeCharacterBossPlan`)이 정확히 여기서 실패했다.
 *
 * ★ **13번째 주간 보스는 막는다** — `assertWeeklyPlanSlotAvailable()` 주석 참고
 *   (발주자 지시, 2026-08-18). 월간은 세지 않고, 끄기는 언제나 통과한다.
 */
export async function setCharacterBossPlan(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
  active: boolean,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  if (active) {
    await assertWeeklyPlanSlotAvailable(db, characterId, bossDifficultyId);
  }

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
 * **내 판단을 지우고 인게임 목록에 맡긴다** (`manual_active` → `null`).
 *
 * ── 이 함수가 왜 이렇게 바뀌었나 (발주자 보고, 2026-08-18) ────────────────────
 * *"이거 들어가서 목록 수정했는데 다시 api 기반을 강제로 넣는거같음."*
 * 예전 구현은 이 자리에서 **행을 통째로 `delete()`** 했다. 그런데 계획 행은 넥슨
 * 동기화가 다시 만드는 행이다 — 다음 `sync_character_boss_plan()` 이
 * `registration_flag = true` 를 보고 **`manual_active = null` 짜리 새 행**을 넣고,
 * 트리거의 `coalesce(manual_active, api_registered, false)` 는 그 `null` 을 건너뛰어
 * `api_registered = true` 를 집는다. 결과적으로 사용자가 지운 항목이 **매 동기화마다
 * 되살아났고**, 실계정에서 `노멀 림보` · `노멀 찬란한 흉성` 이 하드 버전과 함께 목록에
 * 남아 주간 계획이 14개가 된 것이 그 증상이다. 삭제가 구조적으로 무의미했다.
 *
 * 그래서 **"목록에서 빼기"의 구현은 이제 삭제가 아니라 끄기**다
 * (`setCharacterBossPlan(..., false)` — `manual_active = false` 라는 묘비가 남아
 * 동기화가 되살릴 수 없다). 두 동선이 같은 상태로 수렴하므로 삭제 버튼은 사라지고,
 * 이 경로에는 **다른 뜻**이 남았다.
 *
 * ── 그 다른 뜻: "이 보스는 내가 판단하지 않겠다" ──────────────────────────────
 * `manual_active` / `manual_set_at` 을 `null` 로 되돌려 판정을 인게임 목록에 넘긴다.
 * ⚠️ 그러면 넥슨이 등록 중인 보스는 **다시 목록에 나타난다.** 그것이 이 동작의 정의이며
 *    되살아남은 **의도된 결과**다 — 화면이 그 사실을 먼저 말한 뒤에만 부른다
 *    (`boss-plan-workspace.tsx` 의 확인창).
 *
 * ★ 넥슨이 이 보스를 **한 번도 말한 적 없으면**(`api_registered is null`) 판단을 지우는
 *   순간 그 행은 출처가 하나도 없어진다. DB CHECK `character_boss_plans_has_source` 가
 *   그런 유령 행을 금지하므로 이때는 행을 지운다 — 난이도를 잘못 골라 손으로 추가한
 *   행을 되돌리는 옛 용도가 정확히 이 갈래이고, 되살릴 API 값이 없으니 되살아나지도 않는다.
 *
 * ⚠️ 전용 DB 함수는 없다(난제 16 각주 24). 그래서 여기서 직접 쓰되 `user_id` +
 *    `character_id` 를 **함께** 걸어 남의 행에 닿을 수 없게 한다 —
 *    `requireOwnedTrackedCharacter` 와 겹치는 이중 방어다. `is_active` 재계산은
 *    UPDATE 에도 걸리는 `character_boss_plans_apply_state` 트리거가 한다.
 */
export async function resetCharacterBossPlanToApi(
  userId: string,
  characterId: string,
  bossDifficultyId: string,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await requireOwnedTrackedCharacter(db, userId, characterId);

  const rows = unwrap(
    await db
      .from("character_boss_plans")
      .select("id,api_registered")
      .eq("user_id", userId)
      .eq("character_id", characterId)
      .eq("boss_difficulty_id", bossDifficultyId)
      .limit(1),
    "계획 수동 판단 조회",
  );

  const row = rows[0];
  // 이미 없다. 사용자가 원한 상태이므로 실패가 아니다.
  if (row === undefined) return fetchCharacterPlanBundle(userId, characterId);

  const { error } =
    row.api_registered === null
      ? await db
          .from("character_boss_plans")
          .delete()
          .eq("id", row.id)
          .eq("user_id", userId)
      : await db
          .from("character_boss_plans")
          .update({ manual_active: null, manual_set_at: null })
          .eq("id", row.id)
          .eq("user_id", userId);

  if (error !== null) {
    console.error(`[boss-plan-repo] 계획 수동 판단 초기화 실패: ${error.message}`);
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
 * ★ `partySize = null` 은 **기본값 1로 되돌리기**다(입력칸을 비웠을 때). 0 이 아니다.
 *   DB 함수가 `coalesce(p_party_size, 1)` 로 접는다 — 컬럼이 `NOT NULL DEFAULT 1` 이라
 *   접지 않으면 23502 로 죽는다(마이그레이션 25, 발주자 지시 2026-08-19).
 *   "미설정"이라는 상태는 더 이상 없다. 아무것도 정하지 않은 보스는 **1인 확정**이다.
 * ★ **이미 쌓인 클리어를 소급해서 바꾸지 않는다.** DB 함수가 `default_party_size` 한
 *   컬럼만 만지므로 구조적으로 그렇게 될 수 없다. 이미 기록된 클리어의 인원은 한 건씩
 *   개별 수정한다(발주자 지시 2026-08-19).
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
    // ⚠️ 좁히는 캐스트인 이유: supabase 타입 생성기는 함수 인자의 널 허용을 표현하지 못해
    //    `p_party_size: number` 로 나오지만, SQL 쪽은 `integer` 이고 **널이 정식 입력**이다
    //    (= 기본값 1로 되돌린다 — 20260819100000). 생성물을 손보면 재생성 때 사라지므로
    //    호출부에서 넓힌다.
    p_party_size: partySize as number,
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

/*
 * ★ 2026-08-19 삭제 — 일괄 소급의 결과 타입과 서버 래퍼.
 *   `public.apply_plan_party_sizes_to_clears(character, dry_run)` 을 부르던 함수였고,
 *   그것을 쓰던 `POST /api/boss-plans/party-size` 와 화면의 일괄 적용 버튼도 함께 없앴다.
 *
 *   왜: DB 함수의 대상 조건이 `boss_clears.party_size_confirmed = false` 인데, 기본 인원을
 *   1인으로 확정(마이그레이션 25)한 뒤로 미확인 행이 하나도 남지 않는다(실측 0/48).
 *   즉 미리보기가 **언제나 0건**이었고, 아무 일도 하지 않는 버튼은 없는 버튼보다 나쁘다.
 *
 *   **DB 함수 자체는 지우지 않았다.** 되돌리기 어렵고, 대상 조건을 "계획 인원 ≠ 클리어
 *   인원"으로 바꿔 되살릴 여지가 있다. 마이그레이션 26
 *   (`20260819110000_deprecate_apply_plan_party_sizes.sql`)이 그 사실을 함수 COMMENT 에 적었다.
 *
 *   인원수 **설정** 경로(`setCharacterBossPlanPartySize` ↔
 *   `public.set_character_boss_plan_party_size`)는 위에 그대로 살아 있다.
 */
