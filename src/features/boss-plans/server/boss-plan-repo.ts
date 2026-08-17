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
 * ⚠️ **진행률·상한 판정을 여기서 다시 계산하지 않는다.** `planned/cleared/remaining`,
 *    `weekly_over_limit`, `weekly_slots_remaining` 은 전부 뷰가 낸다. 이 파일이 하는 일은
 *    **뷰의 컬럼을 화면 타입으로 옮기는 것뿐**이며, 세기·나누기가 등장하면 이미 규칙 위반이다.
 *    (`weekly_crystal_sell_limit()` 이 단일 출처라 12 라는 숫자도 여기 없다.)
 *
 * ── 열람 범위는 **본인뿐**이다 (난제 16-6) ───────────────────────────────────
 * 가용시간(본인/친구/같은 파티)보다도 좁다. 판정은 `can_view_character_plans()` 하나에
 * 못박혀 있고 여기서는 그것을 호출만 한다 — TS 에 술어를 다시 적으면 웹과 봇이 갈라진다.
 */

import { ApiError } from "@/features/auth/server/http";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import type { BossCycle, BossDifficultyTier } from "@/types/domain";

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
  "plan_id,user_id,character_id,boss_difficulty_id,boss_id,boss_display_name,difficulty,cycle,max_party,released,boss_sort_order,difficulty_sort_order,is_active,manual_active,api_registered,has_conflict,origin,counts_toward_weekly_limit,is_cleared,cleared_at,note";

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
  readonly released: boolean | null;
  readonly boss_sort_order: number | null;
  readonly difficulty_sort_order: number | null;
  readonly is_active: boolean | null;
  readonly manual_active: boolean | null;
  readonly api_registered: boolean | null;
  readonly has_conflict: boolean | null;
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
    released: row.released ?? true,
    isActive: row.is_active ?? false,
    manualActive: row.manual_active,
    apiRegistered: row.api_registered,
    hasConflict: row.has_conflict ?? false,
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

/** `PLAN_COLUMNS` 와 같은 이유로 **한 줄 리터럴**이어야 한다. */
const PROGRESS_COLUMNS =
  "user_id,character_id,character_name,world_name,week_key,planned_total,planned_weekly,planned_daily,planned_monthly,cleared_total,cleared_weekly,remaining_total,remaining_weekly,inactive_total,conflict_count,weekly_limit,weekly_over_limit,weekly_slots_remaining";

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
  readonly planned_total: number | string | null;
  readonly planned_weekly: number | string | null;
  readonly planned_daily: number | string | null;
  readonly planned_monthly: number | string | null;
  readonly cleared_total: number | string | null;
  readonly cleared_weekly: number | string | null;
  readonly remaining_total: number | string | null;
  readonly remaining_weekly: number | string | null;
  readonly inactive_total: number | string | null;
  readonly conflict_count: number | string | null;
  readonly weekly_limit: number | string | null;
  readonly weekly_over_limit: boolean | null;
  readonly weekly_slots_remaining: number | string | null;
}

function toProgress(row: ProgressRow): CharacterWeeklyProgress | null {
  if (row.character_id === null || row.week_key === null) return null;
  return {
    characterId: row.character_id,
    characterName: row.character_name ?? "알 수 없음",
    worldName: row.world_name,
    weekKey: row.week_key,
    plannedTotal: toCount(row.planned_total),
    plannedWeekly: toCount(row.planned_weekly),
    plannedDaily: toCount(row.planned_daily),
    plannedMonthly: toCount(row.planned_monthly),
    clearedTotal: toCount(row.cleared_total),
    clearedWeekly: toCount(row.cleared_weekly),
    remainingTotal: toCount(row.remaining_total),
    remainingWeekly: toCount(row.remaining_weekly),
    inactiveTotal: toCount(row.inactive_total),
    conflictCount: toCount(row.conflict_count),
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

/** 캐릭터 하나의 계획 전체 + 이번 주 진행 상황 + 마지막 동기화 결과. */
export async function fetchCharacterPlanBundle(
  viewerUserId: string | null,
  characterId: string,
): Promise<CharacterPlanBundle> {
  const db = getAdminDb();
  await assertCanViewPlans(db, viewerUserId, characterId);

  const [planRows, progressRows, snapshots] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_character_boss_plan_status")
          .select(PLAN_COLUMNS)
          .eq("character_id", characterId),
        "캐릭터 보스 계획 조회",
      ))(),
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
    progress: progressRow === undefined ? null : toProgress(progressRow),
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
 * ⚠️ 뷰는 `credential_id` 만 주고 **원문 키는 어디에도 없다**(§2.1.1). 브라우저가 자기
 *    저장소에서 그 id 로 키를 꺼낸다. 서버가 키를 알 방법도, 알 필요도 없다.
 */
async function loadCredentialByCharacter(
  db: AdminDb,
  userId: string,
): Promise<Map<string, { id: string; label: string | null }>> {
  const rows = unwrap(
    await db
      .from("v_character_sync_source")
      .select("character_id,credential_id,credential_label")
      .eq("user_id", userId),
    "캐릭터별 동기화 자격증명 조회",
  );

  const byCharacter = new Map<string, { id: string; label: string | null }>();
  for (const row of rows) {
    // 뷰 컬럼은 전부 nullable 이다(뷰의 숙명). 둘 중 하나라도 비면 "동기화 불가"다.
    if (row.character_id === null || row.credential_id === null) continue;
    byCharacter.set(row.character_id, {
      id: row.credential_id,
      label: row.credential_label,
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
    (async () =>
      unwrap(
        await db
          .from("v_character_boss_plan_status")
          .select(PLAN_COLUMNS)
          .eq("user_id", userId)
          // ★ **할 일 목록이지 전리품 목록이 아니다** — 켜져 있고 아직 안 깬 것만.
          //   이 한 줄이 난제 16-5 가 말한 "남은 목록"의 정의 그대로다.
          .eq("is_active", true)
          .eq("is_cleared", false),
        "주간 체크리스트 계획 조회",
      ))(),
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

  const remainingByCharacter = new Map<string, CharacterBossPlan[]>();
  for (const row of [...planRows].sort(comparePlanRows)) {
    const plan = toPlan(row);
    if (plan === null) continue;
    const list = remainingByCharacter.get(plan.characterId) ?? [];
    list.push(plan);
    remainingByCharacter.set(plan.characterId, list);
  }

  const progressByCharacter = new Map<string, CharacterWeeklyProgress>();
  for (const row of progressRows) {
    const progress = toProgress(row);
    if (progress !== null) {
      progressByCharacter.set(progress.characterId, progress);
    }
  }

  return characters.map((character) => ({
    character,
    progress: progressByCharacter.get(character.characterId) ?? null,
    snapshot: snapshots.get(character.characterId) ?? null,
    remaining: remainingByCharacter.get(character.characterId) ?? [],
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
