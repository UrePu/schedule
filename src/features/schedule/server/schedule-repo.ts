import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 화면의 **유일한 DB 접근 지점**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 읽기 경로가 둘인 이유 — service_role 은 브라우저로 나갈 수 없다.
 *
 *   서버 컴포넌트(`/schedule/page.tsx`)  ──직접 import──▶ 이 파일 ──▶ Supabase
 *   클라이언트(`ScheduleWorkspace`)      ──fetch()──▶ Route Handler ──▶ 이 파일
 *
 * 그래서 조회·권한 판정 로직은 **여기 한 곳에만** 있고, 컴포넌트가 보는 시그니처는
 * `data/schedule-queries.ts` 가 그대로 유지한다.
 *
 * ── 가시성 모델 (CLAUDE.md §2.1 · DB-SCHEMA 난제 1) ──────────────────────────
 * 인증 모델이 "서버 전용 쓰기 + RLS 전면 차단"이라 `auth.uid()` 는 **항상 null** 이다.
 * 우리 세션은 `readSession()` 이 주는 서명 쿠키뿐이므로, 열람 범위 판정은 DB 가 아니라
 * 이 파일이 한다. 그래서 모든 읽기 함수가 `viewerUserId: string | null` 을 **첫 인자로**
 * 받는다. Route Handler 와 서버 컴포넌트가 각자 `readSession()` 으로 채운다.
 *
 * ── 로직을 앱에 다시 구현하지 않는다 ─────────────────────────────────────────
 * 가용시간 해석·겹침·열람권한은 전부 DB 함수(`resolve_availability`,
 * `availability_overlap`, `can_view_availability`)를 호출한다. 웹과 카톡 봇이 **같은 답**을
 * 내야 하므로 구현은 DB 에 하나만 있어야 한다.
 */

import { ApiError } from "@/features/auth/server/http";
import { TRACKED_BOSS_CYCLES } from "@/lib/domain/boss-scope";
import { buildPartyTitle } from "@/lib/domain/party-title";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { Database } from "@/types/database";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityInterval,
  AvailabilityPattern,
  AvailabilityPatternInput,
  BossCatalogEntry,
  BossCycle,
  BossDifficultyTier,
  CreatePartyInput,
  CreateRunBundleInput,
  CreateRunInput,
  GuestNameInput,
  IsoWeekday,
  MesoOrUnknown,
  OverlapWindow,
  Party,
  PartyBoss,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
  RunParticipant,
  RunStatus,
  SaveRunSignupInput,
  ScheduledRun,
  SetPartyBossesInput,
  TimeRange,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
  WeekKey,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";

// ─────────────────────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST 에러의 최소 모양. `code` 로 "스키마가 아직 없다"를 가려낸다. */
interface QueryError {
  readonly message: string;
  readonly code?: string;
}

/** PostgREST 응답의 최소 모양. `PostgrestSingleResponse<T>` 가 그대로 들어온다. */
interface QueryResult<T> {
  readonly data: T | null;
  readonly error: QueryError | null;
}

/**
 * 쿼리 실패를 **우리 문구**로 접는다.
 * 원문 메시지는 서버 로그로만 나간다 — PostgREST 에러에는 스키마 구조가 그대로 들어 있다.
 */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[schedule-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[schedule-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/**
 * 볼 수 없는 파티는 **존재 여부도 알리지 않는다** — 403 은 "그 파티는 있다"는 정보를 준다.
 * 비공개 파티 목록을 id 로 훑어 낼 수 있게 되므로 404 로 통일한다.
 */
function partyNotVisible(): ApiError {
  return new ApiError(
    "bad_request",
    "파티를 찾을 수 없거나 열람 권한이 없습니다.",
    404,
  );
}

function notPartyMember(): ApiError {
  return new ApiError(
    "bad_request",
    "이 파티의 구성원만 편집할 수 있습니다.",
    403,
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 마이그레이션 22 미적용 대응 — 읽기는 폴백, 쓰기는 읽을 수 있는 문장
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `20260818120000_party_bosses_and_short_names.sql` 은 이 저장소에서 **아직 라이브에
 * 적용되지 않은 상태로 배포될 수 있다**(이 환경에 DDL 경로가 없다). 그 상태에서
 * `/schedule` 이 통째로 죽으면 안 된다 — 파티 보스 목록은 새 기능이고, 겹쳐보기와 일정은
 * 그것 없이도 성립하기 때문이다.
 *
 * 그래서:
 *   · 읽기 → 빈 목록 + `short_name` 대신 보스 전체 이름 (기능만 조용히 빠진다)
 *   · 쓰기 → **400 + 무엇을 하면 되는지 적힌 한국어 문장** (500 이면 로그에만 남는다)
 *
 * 세 객체(`party_bosses` · `boss_difficulties.short_name` · `parties.name_is_custom`)는
 * **한 마이그레이션 파일**에 있으므로 한 번의 탐침으로 셋 다 판정된다.
 * 적용 뒤에는 프로세스를 다시 띄우면 `null` 에서 출발해 다시 집는다.
 */
let partyBossFeature: boolean | null = null;

/** "그런 테이블 없음". 42P01 = undefined_table, PGRST205 = 스키마 캐시에 없는 테이블. */
function isMissingRelation(error: QueryError | null): boolean {
  return error !== null && (error.code === "42P01" || error.code === "PGRST205");
}

/** "그런 컬럼 없음". 42703 = undefined_column. */
function isUndefinedColumn(error: QueryError | null): boolean {
  return error !== null && error.code === "42703";
}

/** "그런 함수 없음". PGRST202 = 스키마 캐시에 없는 함수. */
function isMissingFunction(error: QueryError | null): boolean {
  return error !== null && error.code === "PGRST202";
}

async function hasPartyBossFeature(db: AdminDb): Promise<boolean> {
  if (partyBossFeature !== null) return partyBossFeature;

  const probe = await db.from("party_bosses").select("id").limit(1);
  partyBossFeature = !isMissingRelation(probe.error);
  if (!partyBossFeature) {
    console.warn(
      "[schedule-repo] party_bosses 테이블이 없습니다. " +
        "20260818120000_party_bosses_and_short_names.sql 미적용으로 보고 " +
        "파티 보스 목록을 비활성화합니다(줄임말 대신 보스 전체 이름을 씁니다).",
    );
  }
  return partyBossFeature;
}

function partyBossFeatureUnavailable(): ApiError {
  return ApiError.badRequest(
    "파티 보스 목록 기능이 아직 데이터베이스에 적용되지 않았습니다. " +
      "supabase/migrations/20260818120000_party_bosses_and_short_names.sql 을 적용해 주세요.",
  );
}

/**
 * `boss_difficulties.short_name` 을 한 번에 읽어 온다.
 *
 * 뷰(`v_boss_catalog`)에 컬럼을 얹지 않고 **따로 읽는** 이유: 뷰를 갈아 끼우면
 * 마이그레이션 미적용 시 카탈로그 조회가 통째로 실패해 보스를 하나도 못 고르게 된다.
 * 78행짜리 별도 조회는 값싸고, 실패해도 줄임말만 빠진다.
 */
async function loadBossShortNames(
  db: AdminDb,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  /*
    이미 "컬럼 없음"으로 판정났으면 **다시 묻지 않는다.** 판정 없이 매 요청마다
    실패 왕복을 반복하면 카탈로그 조회 하나가 두 번씩 나간다(실측으로 그랬다).
  */
  if (partyBossFeature === false) return map;

  const result = await db.from("boss_difficulties").select("id,short_name");
  if (result.error !== null) {
    if (isUndefinedColumn(result.error) || isMissingRelation(result.error)) {
      partyBossFeature = false;
      console.warn(
        "[schedule-repo] boss_difficulties.short_name 이 없습니다. " +
          "20260818120000_party_bosses_and_short_names.sql 미적용으로 보고 " +
          "보스 전체 이름을 줄임말 자리에 씁니다.",
      );
      return map;
    }
    console.error(`[schedule-repo] 보스 줄임말 조회: ${result.error.message}`);
    throw ApiError.internal();
  }
  for (const row of result.data ?? []) {
    if (row.short_name !== null && row.short_name.trim() !== "") {
      map.set(row.id, row.short_name);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 트리거가 채우는 관리 번호 (§1.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BEFORE INSERT 트리거가 채우는 컬럼을 **선택 항목으로 되돌린** 삽입 타입.
 *
 * 생성 타입(`src/types/database.ts`)이 `member_no` / `run_no` 를 **필수**로 표시하는 이유는
 * 두 컬럼이 `NOT NULL` 인데 **DB 기본값이 없기** 때문이다. 타입 생성기는 트리거의 존재를
 * 모른다. 실제로 값을 채우는 것은
 *   `party_participants_assign_member_no()` / `party_runs_assign_run_no()`
 * 이고, 두 함수 모두 `pg_advisory_xact_lock` 을 잡은 뒤 `max + 1` 을 넣는다.
 *
 * ★ **값을 절대 넘기지 않는다.** 두 트리거의 첫 줄이
 *   `if new.member_no is not null then return new;  -- 명시 지정은 존중한다`
 *   라서, 자리 채우기용 숫자를 넣으면 **그 값이 그대로 저장된다.** 앱이 `max` 를 읽고
 *   넣는 방식도 조회와 삽입 사이가 열려 있어 동시 편집에서 유니크 위반이 난다.
 *   번호를 정하는 주체는 언제나 **트리거 하나**여야 §1.4(재배열·재사용 금지, 신규 max+1)가
 *   웹·봇·초대 링크 어느 경로로 들어와도 똑같이 성립한다.
 *
 * 마이그레이션 추가는 이번 작업 범위 밖이라 타입 쪽에서 좁게 해결한다.
 */
type TriggerAssigned<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

type ParticipantInsert =
  Database["public"]["Tables"]["party_participants"]["Insert"];
/** `member_no` 는 트리거가 넣는다. 이 타입으로 만든 행에는 그 키가 아예 없다. */
type ParticipantSeed = TriggerAssigned<ParticipantInsert, "member_no">;

type PartyRunInsert = Database["public"]["Tables"]["party_runs"]["Insert"];
/** `run_no` 는 트리거가, `week_key` 는 생성 컬럼이 채운다. 둘 다 넘기지 않는다. */
type PartyRunSeed = TriggerAssigned<PartyRunInsert, "run_no">;

/** `created_at` → `id` 순. 시드가 같은 시각이어도 순서가 흔들리지 않는다. */
function compareByCreatedThenId(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 가시성 판정
// ─────────────────────────────────────────────────────────────────────────────

/** 공개 파티 id. `v_public_party_board` 는 이미 `archived_at is null` 을 걸러 준다. */
async function loadPublicPartyIds(db: AdminDb): Promise<Set<PartyId>> {
  const rows = unwrap(
    await db.from("v_public_party_board").select("id"),
    "공개 파티 목록 조회",
  );
  const ids = new Set<PartyId>();
  for (const row of rows) {
    if (row.id !== null) ids.add(row.id);
  }
  return ids;
}

/** 내가 **아직 나가지 않은** 파티 id. 비로그인은 빈 집합이다. */
async function loadMyPartyIds(
  db: AdminDb,
  viewerUserId: string | null,
): Promise<Set<PartyId>> {
  if (viewerUserId === null) return new Set<PartyId>();
  const rows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .eq("user_id", viewerUserId)
      .is("left_at", null),
    "내 파티 목록 조회",
  );
  return new Set(rows.map((row) => row.party_id));
}

/**
 * 그 파티가 이 열람자에게 보이는가.
 * 보관(`archived_at`)된 파티는 내가 속해 있어도 목록에서 빠지므로 여기서도 제외한다.
 */
async function assertPartyVisible(
  db: AdminDb,
  viewerUserId: string | null,
  partyId: PartyId,
): Promise<void> {
  const publicIds = await loadPublicPartyIds(db);
  if (publicIds.has(partyId)) return;

  if (viewerUserId === null) throw partyNotVisible();

  const membership = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("party_id", partyId)
      .eq("user_id", viewerUserId)
      .is("left_at", null)
      .limit(1),
    "파티 참가 여부 확인",
  );
  if (membership.length === 0) throw partyNotVisible();

  const alive = unwrap(
    await db
      .from("parties")
      .select("id")
      .eq("id", partyId)
      .is("archived_at", null)
      .limit(1),
    "파티 보관 여부 확인",
  );
  if (alive.length === 0) throw partyNotVisible();
}

/** 쓰기 전 검사 — 요청자가 그 파티의 살아 있는 참가자인지. 참가자 id 를 돌려준다. */
async function requirePartyMembership(
  db: AdminDb,
  userId: string,
  partyId: PartyId,
): Promise<string> {
  const rows = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("party_id", partyId)
      .eq("user_id", userId)
      .is("left_at", null)
      .limit(1),
    "파티 편집 권한 확인",
  );
  const participantId = rows[0]?.id;
  if (participantId === undefined) throw notPartyMember();
  return participantId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 캐릭터 — 일정에 데려갈 대상
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 일정에 데려갈 수 있는 내 캐릭터.
 *
 * ★ **`is_tracked = true` 인 것만** 후보다 (§2.1.1). 추적하지 않는 캐릭터는 인게임
 *   스케줄러와 동기화되지 않으므로 클리어·결정석 집계가 성립하지 않는다. 후보를 넓히면
 *   "일정은 잡혔는데 수익에는 영영 안 잡히는" 캐릭터가 생긴다.
 *
 * 비로그인은 빈 배열이다 — 쓰기 자체가 불가능하므로 에러가 아니라 정상 상태다.
 */
export async function fetchMyRunCharacters(
  viewerUserId: string | null,
): Promise<readonly RunCharacterOption[]> {
  if (viewerUserId === null) return [];
  const db = getAdminDb();

  const rows = unwrap(
    await db
      .from("characters")
      .select("id,character_name,world_name,character_class,character_level,is_main")
      .eq("user_id", viewerUserId)
      .eq("is_tracked", true),
    "일정용 캐릭터 목록 조회",
  );

  return rows
    .map(
      (row): RunCharacterOption => ({
        characterId: row.id,
        name: row.character_name,
        worldName: row.world_name,
        className: row.character_class,
        level: row.character_level,
        isMain: row.is_main,
      }),
    )
    .sort(
      (a, b) =>
        // 본캐가 맨 앞(§2.1 — 표시 정체성), 그 다음 레벨 내림차순.
        Number(b.isMain) - Number(a.isMain) ||
        (b.level ?? 0) - (a.level ?? 0) ||
        // `localeCompare` 는 ICU 버전이 서버/브라우저에서 달라 정렬이 갈릴 수 있다.
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/**
 * 그 캐릭터가 **이 사용자 것이고 추적 중인지** 확인한다.
 *
 * ★ 두 조건을 한 쿼리에 함께 건다. 소유만 확인하고 추적을 빼면, 화면이 주지 않는 값을
 *   API 로 직접 보내 추적하지 않는 캐릭터를 일정에 넣을 수 있다 — 그 캐릭터는 동기화
 *   대상이 아니라 결정석 집계에서 영원히 빠진다.
 * ★ **남의 캐릭터는 404 가 아니라 400 이다.** 이 값은 사용자가 고른 목록에서 오므로
 *   존재 여부를 숨길 이유가 없고, 화면이 "목록을 새로 불러오라"고 안내해야 한다.
 */
async function requireOwnedTrackedCharacter(
  db: AdminDb,
  userId: string,
  characterId: string,
): Promise<string> {
  const rows = unwrap(
    await db
      .from("characters")
      .select("id")
      .eq("id", characterId)
      .eq("user_id", userId)
      .eq("is_tracked", true)
      .limit(1),
    "캐릭터 소유 확인",
  );
  const owned = rows[0]?.id;
  if (owned === undefined) {
    throw ApiError.badRequest(
      "내 추적 캐릭터가 아닙니다. 캐릭터 목록을 새로 불러오거나 추적 대상에 추가해 주세요.",
    );
  }
  return owned;
}

/**
 * 캐릭터 id → 표시에 필요한 값(이름 · 월드 · **본캐 여부**).
 *
 * ★ `is_main` 을 반드시 함께 읽는다. 본캐/부캐 구분이 없으면 `더저(더저)` 처럼 정보
 *   없는 괄호가 붙는다 — 판정 규칙은 `lib/domain/participant-label.ts` 가 소유하고
 *   이 함수는 그 판정에 필요한 재료만 모은다.
 * ★ 조회 대상이 없으면 **쿼리를 보내지 않는다.** `in()` 에 빈 배열을 주면 왕복만 낭비된다.
 */
interface CharacterLabelRow {
  readonly characterName: string;
  readonly worldName: string | null;
  readonly isMain: boolean;
}

async function loadCharacterLabels(
  db: AdminDb,
  characterIds: readonly string[],
): Promise<Map<string, CharacterLabelRow>> {
  const byId = new Map<string, CharacterLabelRow>();
  const ids = unique(characterIds);
  if (ids.length === 0) return byId;

  const rows = unwrap(
    await db
      .from("characters")
      .select("id,character_name,world_name,is_main")
      .in("id", ids),
    "참여 캐릭터 조회",
  );
  for (const row of rows) {
    byId.set(row.id, {
      characterName: row.character_name,
      worldName: row.world_name,
      isMain: row.is_main,
    });
  }
  return byId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 런 참가자 — **캐릭터까지** 함께 읽는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 런별 참가 의사 + 그 사람이 데려가는 캐릭터.
 *
 * 왜 캐릭터를 굳이 붙이는가: 주간 결정석 12개 상한이 **캐릭터당**이라(§1) 사람 이름만
 * 있는 목록은 수익을 계산할 수 없다. `run_signups.character_id` 는 처음부터 있었고
 * 화면이 그것을 읽지 않고 있었을 뿐이다.
 *
 * ★ **비로그인에게는 빈 목록이다.** 공개 파티의 시간표는 비로그인도 보지만, 그 설계된
 *   공개면은 `v_public_party_runs`(런 자체)까지이고 **누가 어느 캐릭터로 가는지는
 *   거기에 없다.** 요구사항("참가자 목록에 캐릭터 이름을 표시")은 관련된 사람들을 위한
 *   것이지 공개면을 넓히라는 것이 아니므로, 열람자가 없으면 조회 자체를 하지 않는다.
 *   에러가 아니라 정상적인 빈 상태이며, 비로그인 페이지의 왕복 3회도 함께 사라진다.
 *
 * ⚠️ `character_id` 는 `on delete set null` 이라 캐릭터가 지워지면 **행은 남고 값만
 *    비는** 상태가 정상적으로 존재한다. 없는 것을 에러로 그리지 않는다.
 */
async function loadRunParticipants(
  db: AdminDb,
  viewerUserId: string | null,
  runIds: readonly string[],
): Promise<Map<string, RunParticipant[]>> {
  const byRun = new Map<string, RunParticipant[]>();
  if (viewerUserId === null || runIds.length === 0) return byRun;

  const signups = unwrap(
    await db
      .from("run_signups")
      .select("id,run_id,participant_id,status,character_id")
      .in("run_id", [...runIds]),
    "런 참가자 조회",
  );
  if (signups.length === 0) return byRun;

  const participantIds = unique(signups.map((row) => row.participant_id));
  const characterIds = unique(
    signups.flatMap((row) => (row.character_id === null ? [] : [row.character_id])),
  );

  const [participantRows, characterById] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select("id,user_id,guest_id,display_name,member_no")
          .in("id", participantIds),
        "런 참가자 신원 조회",
      ))(),
    loadCharacterLabels(db, characterIds),
  ]);

  const participantById = new Map(participantRows.map((row) => [row.id, row]));

  for (const row of signups) {
    const participant = participantById.get(row.participant_id);
    if (participant === undefined) continue;
    const personId = participant.user_id ?? participant.guest_id;
    if (personId === null) continue;

    const character =
      row.character_id === null ? undefined : characterById.get(row.character_id);

    const list = byRun.get(row.run_id) ?? [];
    list.push({
      signupId: row.id,
      participantId: row.participant_id,
      personId,
      displayName: participant.display_name,
      isGuest: participant.user_id === null,
      // §1.4 — 관리 번호는 재배열하지 않으므로 연속이 아닐 수 있다.
      seatNo: participant.member_no,
      status: row.status,
      characterId: row.character_id,
      characterName: character?.characterName ?? null,
      // 캐릭터가 없으면 "본캐 여부"라는 질문 자체가 성립하지 않는다 → false.
      isMainCharacter: character?.isMain ?? false,
      worldName: character?.worldName ?? null,
    });
    byRun.set(row.run_id, list);
  }

  for (const list of byRun.values()) {
    list.sort((a, b) => a.seatNo - b.seatNo);
  }
  return byRun;
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티
// ─────────────────────────────────────────────────────────────────────────────

/** 파티별 살아 있는 구성원 수. `v_public_party_board.member_count` 와 같은 정의다. */
async function loadMemberCounts(
  db: AdminDb,
  partyIds: readonly PartyId[],
): Promise<Map<PartyId, number>> {
  const counts = new Map<PartyId, number>();
  if (partyIds.length === 0) return counts;

  const rows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .in("party_id", [...partyIds])
      .is("left_at", null),
    "파티 구성원 수 집계",
  );
  for (const row of rows) {
    counts.set(row.party_id, (counts.get(row.party_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * 볼 수 있는 파티 목록.
 *
 * - 로그인 → 내가 살아 있는 파티 **∪** 공개 파티(`v_public_party_board`)
 * - 비로그인 → 공개 파티만
 *
 * 정렬은 **내 파티 먼저, 그 다음 공개 파티**다. 서버 컴포넌트가 `parties[0]` 을 기본
 * 선택으로 쓰므로, 로그인한 사람에게는 남의 공개 파티가 아니라 자기 파티가 먼저 열린다.
 */
const MY_PARTY_COLUMNS =
  "id,name,visibility,default_capacity,created_at,name_is_custom";
/** `name_is_custom` 이 **없던 시절의** 컬럼 목록 (마이그레이션 22 미적용 DB). */
const MY_PARTY_COLUMNS_LEGACY = "id,name,visibility,default_capacity,created_at";

interface MyPartyRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: Party["visibility"];
  readonly default_capacity: number;
  readonly created_at: string;
  readonly name_is_custom: boolean;
}

/**
 * 내 파티 행.
 *
 * ★ 마이그레이션 미적용이면 `name_is_custom` 을 **true 로 가정**한다. false 로 가정하면
 *   그 상태에서 로스터를 고칠 때 서버가 사람이 지은 이름을 자동 제목으로 갈아 버린다 —
 *   모를 때는 사용자의 입력을 지키는 쪽으로 실패한다.
 */
async function loadMyPartyRows(
  db: AdminDb,
  partyIds: readonly PartyId[],
): Promise<readonly MyPartyRow[]> {
  if (partyIds.length === 0) return [];

  if (partyBossFeature !== false) {
    const result = await db
      .from("parties")
      .select(MY_PARTY_COLUMNS)
      .in("id", [...partyIds])
      .is("archived_at", null);
    if (!isUndefinedColumn(result.error)) {
      return unwrap(result, "내 파티 조회");
    }
    partyBossFeature = false;
    console.warn(
      "[schedule-repo] parties.name_is_custom 이 없습니다. " +
        "20260818120000_party_bosses_and_short_names.sql 미적용으로 보고 " +
        "모든 파티 제목을 '사람이 정한 것'으로 다룹니다(자동 갱신 없음).",
    );
  }

  const rows = unwrap(
    await db
      .from("parties")
      .select(MY_PARTY_COLUMNS_LEGACY)
      .in("id", [...partyIds])
      .is("archived_at", null),
    "내 파티 조회",
  );
  return rows.map((row) => ({ ...row, name_is_custom: true }));
}

export async function fetchParties(
  viewerUserId: string | null,
): Promise<readonly Party[]> {
  const db = getAdminDb();

  const [myIds, publicRows] = await Promise.all([
    loadMyPartyIds(db, viewerUserId),
    (async () =>
      unwrap(
        await db
          .from("v_public_party_board")
          .select("id,name,default_capacity,member_count,created_at"),
        "공개 파티 목록 조회",
      ))(),
  ]);

  const mineRows = await loadMyPartyRows(db, [...myIds]);

  const mineIdSet = new Set(mineRows.map((row) => row.id));
  const counts = await loadMemberCounts(db, [
    ...mineIdSet,
    ...publicRows.flatMap((row) => (row.id === null ? [] : [row.id])),
  ]);

  const mine = mineRows
    .map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      party: {
        partyId: row.id,
        name: row.name,
        visibility: row.visibility,
        defaultCapacity: row.default_capacity,
        memberCount: counts.get(row.id) ?? 0,
        nameIsCustom: row.name_is_custom,
      } satisfies Party,
    }))
    .sort(compareByCreatedThenId);

  const publics = publicRows
    // 내가 속한 공개 파티는 위에서 이미 나왔다. 중복 노출하지 않는다.
    .filter((row) => row.id !== null && !mineIdSet.has(row.id))
    .map((row) => ({
      createdAt: row.created_at ?? "",
      id: row.id ?? "",
      party: {
        partyId: row.id ?? "",
        name: row.name ?? "이름 없는 파티",
        // 이 뷰는 정의상 `visibility = 'public'` 인 행만 담는다.
        visibility: "public",
        defaultCapacity: row.default_capacity ?? 6,
        memberCount: row.member_count ?? counts.get(row.id ?? "") ?? 0,
        /*
          남의 공개 파티는 편집 대상이 아니다. `true` 로 두어 **그 이름에 손대지 않는다**는
          뜻을 타입으로도 남긴다(공개 게시판 뷰에는 이 컬럼이 아예 없다).
        */
        nameIsCustom: true,
      } satisfies Party,
    }))
    .sort(compareByCreatedThenId);

  return [...mine, ...publics].map((entry) => entry.party);
}

/** 단건 조회. 보이지 않는 파티는 404 로 접는다. */
export async function fetchParty(
  viewerUserId: string | null,
  partyId: PartyId,
): Promise<Party> {
  const parties = await fetchParties(viewerUserId);
  const party = parties.find((entry) => entry.partyId === partyId);
  if (party === undefined) throw partyNotVisible();
  return party;
}

/**
 * 그 파티의 구성원.
 *
 * ⚠️ **번호(`member_no`)는 파티 단위**이고 **연속이 아닐 수 있다** (§1.4).
 *    3번이 나가면 4번은 계속 4번이고 3번 자리는 빈 채로 둔다. 화면은 배열 인덱스가
 *    아니라 이 값을 그대로 쓴다.
 */
export async function fetchPartyMembers(
  viewerUserId: string | null,
  partyId: PartyId,
): Promise<readonly PartyMember[]> {
  const db = getAdminDb();
  await assertPartyVisible(db, viewerUserId, partyId);

  const rows = unwrap(
    await db
      .from("party_participants")
      .select("id,user_id,guest_id,display_name,member_no,character_id")
      .eq("party_id", partyId)
      .is("left_at", null)
      .order("member_no", { ascending: true }),
    "파티 구성원 조회",
  );

  /*
    참여 캐릭터를 함께 읽는다 — `더저(메검메)` 표시의 재료다(§ 발주 요구).
    `character_id` 는 `on delete set null` 이라 캐릭터가 지워지면 값만 비는 상태가
    정상적으로 존재한다. 없는 것을 에러로 그리지 않는다.
  */
  const characterById = await loadCharacterLabels(
    db,
    rows.flatMap((row) => (row.character_id === null ? [] : [row.character_id])),
  );

  const members: PartyMember[] = [];
  for (const row of rows) {
    // CHECK `num_nonnulls(user_id, guest_id) = 1` 이 보장하지만, 방어적으로 건너뛴다.
    const personId = row.user_id ?? row.guest_id;
    if (personId === null) continue;
    const character =
      row.character_id === null ? undefined : characterById.get(row.character_id);
    members.push({
      personId,
      participantId: row.id,
      displayName: row.display_name,
      isGuest: row.user_id === null,
      seatNo: row.member_no,
      characterId: row.character_id,
      characterName: character?.characterName ?? null,
      isMainCharacter: character?.isMain ?? false,
    });
  }
  return members;
}

/**
 * **이 파티에 어느 캐릭터로 들어가 있는지**를 정한다 (`party_participants.character_id`).
 *
 * ★ 고칠 수 있는 것은 **내 참가자 행 하나**뿐이다. 경로 어디에도 "누구의" 를 받는 자리가
 *   없고, `requirePartyMembership` 이 돌려주는 내 참가자 id 로만 UPDATE 한다.
 * ★ `characterId === null` 은 **지정 해제**다. 유효한 입력이며 에러가 아니다.
 * ★ 캐릭터는 `requireOwnedTrackedCharacter` 로 다시 확인한다 — 화면이 주지 않는 값을
 *   API 로 직접 보내 남의 캐릭터를 내 자리에 붙이는 경로를 막는다.
 *
 * 런 단위 캐릭터(`run_signups.character_id`)는 **건드리지 않는다.** 파티엔 메검메로
 * 있어도 특정 런만 본캐로 나가는 일이 실제로 있고, 두 값은 그래서 따로 존재한다.
 */
export async function updateMyPartyCharacter(
  userId: string,
  input: UpdatePartyCharacterInput,
): Promise<readonly PartyMember[]> {
  const db = getAdminDb();
  const myParticipantId = await requirePartyMembership(
    db,
    userId,
    input.partyId,
  );

  const characterId =
    input.characterId === null
      ? null
      : await requireOwnedTrackedCharacter(db, userId, input.characterId);

  unwrap(
    await db
      .from("party_participants")
      .update({ character_id: characterId })
      .eq("id", myParticipantId)
      .select("id"),
    "파티 참여 캐릭터 저장",
  );

  return fetchPartyMembers(userId, input.partyId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 사람 후보
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 파티에 넣을 수 있는 사람 후보 = **본인 / 수락된 친구 / 같은 파티 구성원(게스트 포함)**.
 *
 * 이 모집단은 `public.can_view_availability()` 의 열람 범위와 **의도적으로 같다.**
 * 파티에 넣는 순간 그 사람의 가용시간이 보이게 되므로, 후보를 넓히면 그대로 열람 범위가
 * 넓어진다. 비로그인은 빈 배열이다(쓰기 자체가 불가능하다).
 */
export async function fetchPeoplePool(
  viewerUserId: string | null,
): Promise<readonly Person[]> {
  if (viewerUserId === null) return [];
  const db = getAdminDb();

  const myPartyIds = [...(await loadMyPartyIds(db, viewerUserId))];

  const [friendRows, partyMateRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("friendships")
          .select("requester_user_id,addressee_user_id")
          .eq("status", "accepted")
          .or(
            `requester_user_id.eq.${viewerUserId},addressee_user_id.eq.${viewerUserId}`,
          ),
        "친구 목록 조회",
      ))(),
    (async () =>
      myPartyIds.length === 0
        ? []
        : unwrap(
            await db
              .from("party_participants")
              .select("user_id,guest_id")
              .in("party_id", myPartyIds)
              .is("left_at", null),
            "같은 파티 구성원 조회",
          ))(),
  ]);

  const userIds = new Set<string>([viewerUserId]);
  const guestIds = new Set<string>();

  for (const row of friendRows) {
    const other =
      row.requester_user_id === viewerUserId
        ? row.addressee_user_id
        : row.requester_user_id;
    userIds.add(other);
  }
  for (const row of partyMateRows) {
    if (row.user_id !== null) userIds.add(row.user_id);
    else if (row.guest_id !== null) guestIds.add(row.guest_id);
  }

  const [userRows, guestRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("app_users")
          .select("id,display_name")
          .in("id", [...userIds])
          .eq("status", "active")
          .is("deleted_at", null),
        "사람 후보(사용자) 조회",
      ))(),
    (async () =>
      guestIds.size === 0
        ? []
        : unwrap(
            await db
              .from("guest_profiles")
              .select("id,display_name")
              .in("id", [...guestIds]),
            "사람 후보(게스트) 조회",
          ))(),
  ]);

  const people: Person[] = [
    ...userRows.map(
      (row): Person => ({
        personId: row.id,
        displayName: row.display_name,
        isGuest: false,
      }),
    ),
    ...guestRows.map(
      (row): Person => ({
        personId: row.id,
        displayName: row.display_name,
        isGuest: true,
      }),
    ),
  ];

  // 본인을 맨 앞에. 나머지는 한국어 이름순이라 목록에서 사람을 눈으로 찾기 쉽다.
  return people.sort((a, b) => {
    if (a.personId === viewerUserId) return -1;
    if (b.personId === viewerUserId) return 1;
    return a.displayName.localeCompare(b.displayName, "ko-KR");
  });
}

/** 이름이 비었을 때 구성원으로 만드는 표시명. 예) `우레푸 외 3명` */
export function summarizePartyName(memberNames: readonly string[]): string {
  if (memberNames.length === 0) return "새 파티";
  if (memberNames.length === 1) return memberNames[0];
  return `${memberNames[0]} 외 ${memberNames.length - 1}명`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 가용 시간 — 판정도 계산도 **DB 함수**가 한다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 열람 가능한 사람만 남긴다.
 *
 * ★ `can_view_availability(viewer, person)` 은 **viewer 가 null 이면 무조건 false** 다.
 *   즉 **비로그인은 남의 가용시간을 볼 수 없다.** 이건 스키마가 정한 정책이므로
 *   화면에서는 에러가 아니라 **빈 상태**로 보여야 한다 — 그래서 throw 하지 않고
 *   빈 배열을 돌려준다.
 */
async function visiblePersonIds(
  db: AdminDb,
  viewerUserId: string | null,
  personIds: readonly PersonId[],
): Promise<string[]> {
  if (viewerUserId === null || personIds.length === 0) return [];

  const candidates = unique(personIds);
  const verdicts = await Promise.all(
    candidates.map(async (personId) => {
      const result = await db.rpc("can_view_availability", {
        p_viewer_user_id: viewerUserId,
        p_person_id: personId,
      });
      if (result.error !== null) {
        console.error(
          `[schedule-repo] can_view_availability 실패: ${result.error.message}`,
        );
        throw ApiError.internal();
      }
      return result.data === true;
    }),
  );

  return candidates.filter((_, index) => verdicts[index]);
}

/** → `public.resolve_availability(p_person_ids, p_from, p_to)` */
export async function fetchAvailability(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
): Promise<readonly AvailabilityInterval[]> {
  const db = getAdminDb();
  const allowed = await visiblePersonIds(db, viewerUserId, personIds);
  if (allowed.length === 0) return [];

  const rows = unwrap(
    await db.rpc("resolve_availability", {
      p_person_ids: allowed,
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
    }),
    "가용시간 해석",
  );

  return rows.map(
    (row): AvailabilityInterval => ({
      personId: row.person_id,
      startsAt: new Date(row.starts_at),
      endsAt: new Date(row.ends_at),
      // DB 함수 반환에 `note` 컬럼이 없다. 해석된 구간은 여러 패턴 행의 합집합에서
      // 잘려 나온 조각이라 "어느 패턴의 메모인가"가 애초에 정의되지 않는다.
      note: null,
    }),
  );
}

/**
 * → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count)`
 *
 * ⚠️ **화면이 겹침을 따로 계산하지 않는다.** 카톡 봇도 같은 함수를 부르므로 두 곳에서
 *    계산하면 반드시 답이 갈라진다.
 */
export async function fetchAvailabilityOverlap(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
): Promise<readonly OverlapWindow[]> {
  const db = getAdminDb();
  const allowed = await visiblePersonIds(db, viewerUserId, personIds);
  if (allowed.length === 0) return [];

  const rows = unwrap(
    await db.rpc("availability_overlap", {
      p_person_ids: allowed,
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
      p_min_count: Math.max(1, Math.trunc(minCount)),
    }),
    "가용시간 겹침 조회",
  );

  return rows.map(
    (row): OverlapWindow => ({
      startsAt: new Date(row.window_start),
      endsAt: new Date(row.window_end),
      availableCount: row.available_count,
      personIds: row.person_ids ?? [],
    }),
  );
}

const EXCEPTION_COLUMNS =
  "id,user_id,guest_id,exception_date,start_minute,end_minute,note";

interface ExceptionRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly guest_id: string | null;
  readonly exception_date: string;
  readonly start_minute: number;
  readonly end_minute: number;
  readonly note: string | null;
}

/**
 * 예외 행 → 도메인 타입. **조회와 등록이 같은 변환을 쓰도록** 한 곳에 뒀다.
 *
 * ⚠️ DB 의 `start_minute` / `end_minute` 는 **not null** 이고, 하루 전체 제외는
 *    `0 ~ 1440` 으로 저장된다. 도메인 타입은 "둘 다 null 이면 그날 전체"이므로 여기서
 *    되돌린다. 이 변환이 두 벌이 되면 등록 직후 화면과 새로고침 뒤 화면이 달라진다.
 */
function toAvailabilityException(row: ExceptionRow): AvailabilityException | null {
  const personId = row.user_id ?? row.guest_id;
  if (personId === null) return null;
  const wholeDay = row.start_minute === 0 && row.end_minute >= 1440;
  return {
    id: row.id,
    personId,
    dayKey: row.exception_date,
    startMinute: wholeDay ? null : row.start_minute,
    endMinute: wholeDay ? null : row.end_minute,
    note: row.note,
  };
}

/**
 * 예외(제외) 원본. `resolve_availability` 결과에는 "어디가 왜 깎였는지"가 남지 않으므로
 * 화면이 그 자국을 그리려면 이 조회가 따로 필요하다.
 */
export async function fetchAvailabilityExceptions(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
): Promise<readonly AvailabilityException[]> {
  const db = getAdminDb();
  const allowed = await visiblePersonIds(db, viewerUserId, personIds);
  if (allowed.length === 0) return [];

  const fromDay = kstDayKey(range.from);
  const toDay = kstDayKey(range.to);

  // `or(user_id.in.(…),guest_id.in.(…))` 대신 두 번 조회한다 — uuid 를 문자열 필터에
  // 끼워 넣지 않으므로 필터 주입 여지가 원천적으로 없다.
  const [userRows, guestRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("availability_exceptions")
          .select(EXCEPTION_COLUMNS)
          .in("user_id", allowed)
          .gte("exception_date", fromDay)
          .lte("exception_date", toDay),
        "가용시간 예외 조회(사용자)",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("availability_exceptions")
          .select(EXCEPTION_COLUMNS)
          .in("guest_id", allowed)
          .gte("exception_date", fromDay)
          .lte("exception_date", toDay),
        "가용시간 예외 조회(게스트)",
      ))(),
  ]);

  const byId = new Map<string, AvailabilityException>();
  for (const row of [...userRows, ...guestRows]) {
    const exception = toAvailabilityException(row);
    if (exception !== null) byId.set(exception.id, exception);
  }

  return [...byId.values()].sort(
    (a, b) => a.dayKey.localeCompare(b.dayKey) || a.id.localeCompare(b.id),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 가용 시간 **쓰기** — 언제나 세션 본인 것만
// ─────────────────────────────────────────────────────────────────────────────
//
// 읽기 함수가 `viewerUserId: string | null` 을 받는 것과 달리, 쓰기 함수는 `userId: string`
// 을 받는다. **"누구의 가용시간을 쓸 것인가"를 받는 자리가 없다** — 대상은 언제나 호출자
// 본인이고, 받지 않는 값은 위조될 수 없다. 게스트(초대 링크) 쪽 쓰기는 세션이라는 근거가
// 없으므로 이 경로로 들어오지 않는다.

const PATTERN_COLUMNS = "id,user_id,guest_id,weekday,start_minute,end_minute,note";

interface PatternRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly guest_id: string | null;
  readonly weekday: number;
  readonly start_minute: number;
  readonly end_minute: number;
  readonly note: string | null;
}

function toAvailabilityPattern(row: PatternRow): AvailabilityPattern | null {
  const personId = row.user_id ?? row.guest_id;
  if (personId === null) return null;
  return {
    id: row.id,
    personId,
    // DB CHECK 가 1~7 을 보장한다. 경계에서 한 번만 좁힌다.
    weekday: row.weekday as IsoWeekday,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    note: row.note,
  };
}

/**
 * 내 요일별 반복 패턴 원본.
 *
 * ⚠️ `resolve_availability()` 로는 이걸 대신할 수 없다. 그 함수는 **패턴 − 예외**를
 *    절대 시각 구간으로 펼쳐 주므로, 편집기가 필요로 하는 "어느 요일의 몇 시부터 몇 시"
 *    라는 원본 의도가 이미 사라진 뒤다.
 */
export async function fetchMyAvailabilityPatterns(
  userId: string,
): Promise<readonly AvailabilityPattern[]> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("availability_patterns")
      .select(PATTERN_COLUMNS)
      .eq("user_id", userId)
      .order("weekday", { ascending: true })
      .order("start_minute", { ascending: true }),
    "가용시간 패턴 조회",
  );

  return rows.flatMap((row) => {
    const pattern = toAvailabilityPattern(row);
    return pattern === null ? [] : [pattern];
  });
}

/**
 * 내 패턴 **전체 교체**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 부분 갱신이 아니라 통째 교체인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 입력이 **격자 칠하기**다. 사용자가 만들어 내는 것은 "이 행을 지우고 저 행을 늘려라"가
 * 아니라 **한 주의 최종 모양** 하나뿐이다. 행 단위 diff 를 서버에서 되짚으면 같은 결과에
 * 두 가지 저장 경로가 생기고, 인접한 칸을 합쳐 한 줄로 만드는 규칙이 diff 와 충돌한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 순서: **지우고 → 넣는다.** 뒤집지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * PostgREST 에는 트랜잭션이 없으므로 두 단계 사이에서 실패할 수 있다. 두 실패 모양 중
 * 어느 쪽을 고를지가 이 순서의 전부다.
 *   - 지우고 → 넣기 실패 : 가용시간이 **비어 있다**. 거짓 "불가" — 시간대 하나를 놓친다.
 *   - 넣고 → 지우기 실패 : 옛 행과 새 행이 **둘 다 남는다**. 합집합이므로 거짓 "가능" —
 *                          못 오는 사람이 예약된다.
 * §1.4 가 못박은 대로 **거짓 불가가 언제나 싸다.** 그래서 삭제가 먼저다.
 * (초안은 브라우저에 그대로 남아 있으므로 사용자는 곧바로 다시 저장할 수 있다.)
 */
export async function replaceMyAvailabilityPatterns(
  userId: string,
  patterns: readonly AvailabilityPatternInput[],
): Promise<readonly AvailabilityPattern[]> {
  const db = getAdminDb();

  const { error: deleteError } = await db
    .from("availability_patterns")
    .delete()
    .eq("user_id", userId);
  if (deleteError !== null) {
    console.error(`[schedule-repo] 가용시간 패턴 삭제: ${deleteError.message}`);
    throw ApiError.internal();
  }

  if (patterns.length > 0) {
    unwrap(
      await db
        .from("availability_patterns")
        .insert(
          patterns.map((pattern) => ({
            user_id: userId,
            guest_id: null,
            weekday: pattern.weekday,
            start_minute: pattern.startMinute,
            end_minute: pattern.endMinute,
          })),
        )
        .select("id"),
      "가용시간 패턴 저장",
    );
  }

  return fetchMyAvailabilityPatterns(userId);
}

/**
 * 특이사항(제외) 한 건 등록.
 *
 * ★ 하루 전체 제외는 `0 ~ 1440` 한 가지 표현으로만 저장한다. 종류(kind) 컬럼을 두지 않은
 *   이유와 같다 — 같은 뜻인데 저장 형태가 둘이면 어느 쪽이 진짜인지 아무도 모르게 된다.
 * ★ `note` 는 **넣지 않는다.** 사유 입력을 만들지 않기로 했으므로 항상 null 이다 (§1.4).
 */
export async function createMyAvailabilityException(
  userId: string,
  input: AvailabilityExceptionInput,
): Promise<AvailabilityException> {
  const db = getAdminDb();

  const startMinute = input.startMinute ?? 0;
  const endMinute = input.endMinute ?? 1440;

  const rows = unwrap(
    await db
      .from("availability_exceptions")
      .insert({
        user_id: userId,
        guest_id: null,
        exception_date: input.dayKey,
        start_minute: startMinute,
        end_minute: endMinute,
      })
      .select(EXCEPTION_COLUMNS),
    "특이사항 등록",
  );

  const created = rows[0] === undefined ? null : toAvailabilityException(rows[0]);
  if (created === null) throw ApiError.internal();
  return created;
}

/**
 * 특이사항 한 건 삭제.
 *
 * ★ `user_id` 조건이 **소유 확인 그 자체**다. 남의 행은 조건에 걸리지 않아 0건이 지워지고,
 *   그때 404 를 준다 — "그 id 는 존재한다"는 정보를 주지 않기 위해 403 이 아니라 404 다
 *   (`partyNotVisible()` 과 같은 이유).
 */
export async function deleteMyAvailabilityException(
  userId: string,
  exceptionId: string,
): Promise<string> {
  const db = getAdminDb();

  const rows = unwrap(
    await db
      .from("availability_exceptions")
      .delete()
      .eq("id", exceptionId)
      .eq("user_id", userId)
      .select("id"),
    "특이사항 삭제",
  );

  if (rows.length === 0) {
    throw new ApiError(
      "bad_request",
      "삭제할 특이사항을 찾을 수 없습니다.",
      404,
    );
  }
  return exceptionId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 마스터
// ─────────────────────────────────────────────────────────────────────────────

const BOSS_CATALOG_COLUMNS =
  "boss_difficulty_id,boss_id,korean_name,boss_korean_name,difficulty,cycle,max_party,crystal_price_meso,released,sort_order";

interface BossCatalogRow {
  readonly boss_difficulty_id: string | null;
  readonly boss_id: string | null;
  readonly korean_name: string | null;
  readonly boss_korean_name: string | null;
  readonly difficulty: BossDifficultyTier | null;
  readonly cycle: BossCycle | null;
  readonly max_party: number | null;
  readonly crystal_price_meso: number | null;
  readonly released: boolean | null;
  readonly sort_order: number | null;
}

/**
 * 뷰 행 → 화면 타입.
 *
 * ★ `crystal_price_meso` 가 `null` 이면 **`null` 그대로** 둔다. 0 으로 바꾸면
 *   "0메소를 벌었다"는 사실 주장이 되어 §1.3 D4 를 위반한다.
 * ★ `max_party` 는 **소프트 상한**이다 (§1.3 D5). 값이 비면 6으로 두되 화면은 경고만 한다.
 */
function toBossEntry(
  row: BossCatalogRow,
  aliases: readonly string[],
  shortNames: Map<string, string>,
): BossCatalogEntry | null {
  if (
    row.boss_difficulty_id === null ||
    row.boss_id === null ||
    row.korean_name === null ||
    row.difficulty === null ||
    row.cycle === null
  ) {
    return null;
  }
  return {
    bossDifficultyId: row.boss_difficulty_id,
    bossId: row.boss_id,
    koreanName: row.korean_name,
    bossKoreanName: row.boss_korean_name ?? row.korean_name,
    /*
      줄임말이 없으면 **보스 전체 이름**으로 떨어진다. 규칙("난이도 첫 글자 + 이름 마지막
      단어 첫 글자")으로 지어내지 않는 이유는 그 규칙이 안전하지 않기 때문이다 —
      검은 마법사는 `익마` 가 아니라 `익검마` 이고, 진 힐라와 힐라는 둘 다 `하힐` 이 된다.
      길어질 뿐 틀리지 않는 쪽을 고른다(마이그레이션 22 머리말).
    */
    shortName: shortNames.get(row.boss_difficulty_id) ?? row.korean_name,
    difficulty: row.difficulty,
    cycle: row.cycle,
    maxParty: row.max_party ?? 6,
    crystalPriceMeso: row.crystal_price_meso,
    released: row.released ?? true,
    aliases,
  };
}

/**
 * → `select * from public.v_boss_catalog where cycle in ('weekly','monthly') order by sort_order`
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **일간 보스를 거르는 단일 관문이다** (`@/lib/domain/boss-scope`)
 *   ═══════════════════════════════════════════════════════════════════════════
 *   보스를 고를 수 있는 화면은 전부 `GET /api/schedule/bosses` → 이 함수를 지난다
 *   (런 작성기, 계획 추가 모달). 그래서 제외를 여기 한 번만 적어 두면 화면마다
 *   `cycle !== "daily"` 를 흩뿌릴 이유가 사라진다.
 *
 *   ⚠️ **보스가 아니라 엔트리(난이도) 단위로 거른다.** `zakum_normal` 은 일간이지만
 *      `zakum_chaos` 는 주간이고 12개 카운터에 들어간다. 자쿰·파풀라투스·매그너스·
 *      블러디퀸·반반·피에르·벨룸 7종이 그런 구조라, 보스 단위로 지우면 카오스 자쿰·
 *      하드 매그너스 같은 **주간 보스가 통째로 사라진다.** 필터는 `boss_difficulties.cycle`
 *      을 그대로 노출하는 뷰 컬럼 `cycle` 에 걸린다.
 *
 *   ⚠️ `loadBossEntries()` 에는 같은 필터를 걸지 않는다. 그쪽은 **이미 저장된 런의 id 로**
 *      보스 정보를 되찾는 조회라, 거르면 과거에 등록된 런이 이름 없는 껍데기로 렌더된다.
 *      목록(고를 수 있는 것)과 조회(이미 고른 것)는 다른 문제다.
 *
 * **미출시(`released = false`)도 함께 돌려준다.** 두 가지 이유가 있다.
 * 1. 화면(`run-composer`)이 이미 미출시 배지를 렌더한다 — 거르면 그 분기가 죽는다.
 * 2. 미출시 3건은 정확히 벨로나 3난이도이고, 실제 런(`bellona_normal`)이 이미 그것을
 *    참조한다. 목록에서 빼면 **가격 미확인(§1.3 D4)** 표시를 확인할 길이 사라진다.
 * 전체가 78행 + 별칭 201행이라 응답은 수십 KB 수준이고, 이 카탈로그는 패치 때만
 * 바뀌므로 TanStack Query 캐시가 사실상 한 번만 받는다.
 */
export async function fetchBossCatalog(): Promise<readonly BossCatalogEntry[]> {
  const db = getAdminDb();

  const [rows, aliasRows, shortNames] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_boss_catalog")
          .select(BOSS_CATALOG_COLUMNS)
          // ★ 일간 제외의 단일 지점. 위 주석 참고.
          .in("cycle", [...TRACKED_BOSS_CYCLES])
          .order("sort_order", { ascending: true }),
        "보스 카탈로그 조회",
      ))(),
    (async () =>
      unwrap(
        await db.from("boss_aliases").select("alias,boss_id,boss_difficulty_id"),
        "보스 별칭 조회",
      ))(),
    loadBossShortNames(db),
  ]);

  // 별칭은 (a) 특정 난이도에 붙거나 (b) 보스 전체에 붙는다. 둘 다 모아 준다.
  const byDifficulty = new Map<string, string[]>();
  const byBoss = new Map<string, string[]>();
  for (const alias of aliasRows) {
    if (alias.boss_difficulty_id !== null) {
      const list = byDifficulty.get(alias.boss_difficulty_id) ?? [];
      list.push(alias.alias);
      byDifficulty.set(alias.boss_difficulty_id, list);
    } else {
      const list = byBoss.get(alias.boss_id) ?? [];
      list.push(alias.alias);
      byBoss.set(alias.boss_id, list);
    }
  }

  const entries: BossCatalogEntry[] = [];
  for (const row of rows) {
    const aliases = unique([
      ...(row.boss_difficulty_id === null
        ? []
        : (byDifficulty.get(row.boss_difficulty_id) ?? [])),
      ...(row.boss_id === null ? [] : (byBoss.get(row.boss_id) ?? [])),
    ]);
    const entry = toBossEntry(row, aliases, shortNames);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 런 목록에 붙일 보스 정보만 뽑는다(별칭은 필요 없다). */
async function loadBossEntries(
  db: AdminDb,
  bossDifficultyIds: readonly string[],
): Promise<Map<string, BossCatalogEntry>> {
  const map = new Map<string, BossCatalogEntry>();
  if (bossDifficultyIds.length === 0) return map;

  const [rows, shortNames] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_boss_catalog")
          .select(BOSS_CATALOG_COLUMNS)
          .in("boss_difficulty_id", [...bossDifficultyIds]),
        "런 보스 정보 조회",
      ))(),
    loadBossShortNames(db),
  ]);
  for (const row of rows) {
    const entry = toBossEntry(row, [], shortNames);
    if (entry !== null) map.set(entry.bossDifficultyId, entry);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티의 보스 목록 (`party_bosses`) — "이 묶음은 익세 → 하대 → 하카를 돈다"
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 발주 요구(원문): *"파티 정보 자체에 보스가 등록된다. 같은 파티에 보스가 여러개
 * 있을수도있고 추가될수도있고 삭제될수도있다."*
 *
 * `party_bosses` = **계획**(무엇을 묶어서 도는가) · `party_runs` = **실행**(언제 도는가).
 * 역할이 겹치지 않으므로 하나가 다른 하나를 대신할 수 없다.
 */

interface PartyBossRow {
  readonly boss_difficulty_id: string;
  readonly sort_order: number;
}

async function loadPartyBossRows(
  db: AdminDb,
  partyId: PartyId,
): Promise<readonly PartyBossRow[]> {
  if (!(await hasPartyBossFeature(db))) return [];

  return unwrap(
    await db
      .from("party_bosses")
      .select("boss_difficulty_id,sort_order")
      .eq("party_id", partyId)
      .order("sort_order", { ascending: true }),
    "파티 보스 목록 조회",
  );
}

/**
 * 행 + 보스 마스터 → 화면 타입.
 *
 * ⚠️ 마스터에서 사라진 보스(있을 수 없지만 FK 가 restrict 라 방어적으로)는 **버리지 않고**
 *   id 를 이름 자리에 넣는다. 조용히 사라지면 제목이 말없이 짧아진다.
 */
function toPartyBosses(
  rows: readonly PartyBossRow[],
  entries: Map<string, BossCatalogEntry>,
): readonly PartyBoss[] {
  return rows.map((row): PartyBoss => {
    const boss = entries.get(row.boss_difficulty_id);
    return {
      bossDifficultyId: row.boss_difficulty_id,
      koreanName: boss?.koreanName ?? row.boss_difficulty_id,
      bossKoreanName: boss?.bossKoreanName ?? row.boss_difficulty_id,
      shortName: boss?.shortName ?? row.boss_difficulty_id,
      difficulty: boss?.difficulty ?? "normal",
      cycle: boss?.cycle ?? "weekly",
      maxParty: boss?.maxParty ?? 6,
      crystalPriceMeso: boss?.crystalPriceMeso ?? null,
      sortOrder: row.sort_order,
    };
  });
}

/**
 * 그 파티가 묶어서 도는 보스 목록.
 *
 * ★ **읽기는 공개 파티면 비로그인도 200 이다.** 공개 시간표에서 "이 파티는 무엇을 도는가"가
 *   보이지 않으면 공개할 이유가 없다. 판정은 `assertPartyVisible` 하나가 한다.
 * ★ 마이그레이션 미적용이면 **빈 배열**이다. 에러가 아니라 "아직 기능이 없다"이다.
 */
export async function fetchPartyBosses(
  viewerUserId: string | null,
  partyId: PartyId,
): Promise<readonly PartyBoss[]> {
  const db = getAdminDb();
  await assertPartyVisible(db, viewerUserId, partyId);

  const rows = await loadPartyBossRows(db, partyId);
  if (rows.length === 0) return [];

  const entries = await loadBossEntries(
    db,
    rows.map((row) => row.boss_difficulty_id),
  );
  return toPartyBosses(rows, entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// 자동 제목 — `익세 하대 하카 2인`
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 조합 규칙은 `@/lib/domain/party-title` 하나가 소유한다. 여기서는 **재료를 모아** 그
 * 함수에 넘기고, `name_is_custom` 이 false 일 때만 저장한다.
 *
 * ★ 사용자가 적은 이름은 **절대 덮지 않는다.** 그 판정은 값 비교가 아니라 비트 하나
 *   (`parties.name_is_custom`)로 한다 — "지금 이름이 자동 제목과 같으니 자동이겠지"
 *   식의 추론은 보스를 바꾸는 순간 사람이 적은 이름을 자동으로 오인한다.
 */
interface PartyNameState {
  readonly name: string;
  readonly nameIsCustom: boolean;
  readonly defaultCapacity: number;
}

async function loadPartyNameState(
  db: AdminDb,
  partyId: PartyId,
): Promise<PartyNameState | null> {
  if (partyBossFeature !== false) {
    const result = await db
      .from("parties")
      .select("name,name_is_custom,default_capacity")
      .eq("id", partyId)
      .limit(1);
    if (!isUndefinedColumn(result.error)) {
      const row = unwrap(result, "파티 이름 상태 조회")[0];
      return row === undefined
        ? null
        : {
            name: row.name,
            nameIsCustom: row.name_is_custom,
            defaultCapacity: row.default_capacity,
          };
    }
    partyBossFeature = false;
  }

  const row = unwrap(
    await db
      .from("parties")
      .select("name,default_capacity")
      .eq("id", partyId)
      .limit(1),
    "파티 이름 상태 조회",
  )[0];
  // 컬럼이 없으면 "사람이 정한 이름"으로 다룬다 — 모를 때는 입력을 지키는 쪽으로.
  return row === undefined
    ? null
    : {
        name: row.name,
        nameIsCustom: true,
        defaultCapacity: row.default_capacity,
      };
}

/** 살아 있는 구성원 이름(번호순). 보스가 하나도 없을 때의 자동 제목 재료다. */
async function loadMemberDisplayNames(
  db: AdminDb,
  partyId: PartyId,
): Promise<readonly string[]> {
  const rows = unwrap(
    await db
      .from("party_participants")
      .select("display_name,member_no")
      .eq("party_id", partyId)
      .is("left_at", null)
      .order("member_no", { ascending: true }),
    "구성원 이름 조회",
  );
  return rows.map((row) => row.display_name);
}

/**
 * 자동 제목을 다시 만들어 저장한다. **`name_is_custom` 이 true 면 아무것도 하지 않는다.**
 *
 * 보스가 하나도 없으면 예전 규칙(`우레푸 외 3명`)으로 돌아간다 — 보스를 전부 지웠는데
 * 지난 보스 이름이 제목에 남아 있으면 그건 틀린 정보다.
 */
async function refreshPartyAutoName(
  db: AdminDb,
  partyId: PartyId,
): Promise<void> {
  const state = await loadPartyNameState(db, partyId);
  if (state === null || state.nameIsCustom) return;

  const rows = await loadPartyBossRows(db, partyId);
  let next: string | null = null;

  if (rows.length > 0) {
    const entries = await loadBossEntries(
      db,
      rows.map((row) => row.boss_difficulty_id),
    );
    next = buildPartyTitle(
      toPartyBosses(rows, entries).map((boss) => boss.shortName),
      state.defaultCapacity,
    );
  }

  if (next === null) {
    const names = await loadMemberDisplayNames(db, partyId);
    next = summarizePartyName(names);
  }

  const clamped = clampPartyName(next);
  if (clamped === "" || clamped === state.name) return;

  unwrap(
    await db
      .from("parties")
      .update({ name: clamped })
      .eq("id", partyId)
      .select("id"),
    "파티 제목 갱신",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티 보스 목록 쓰기
// ─────────────────────────────────────────────────────────────────────────────

/** 한 파티에 넣을 수 있는 보스 수. DB 함수의 상한(24)과 **같은 경계**다. */
const MAX_PARTY_BOSSES = 24;

/**
 * 주간 결정석 상한(캐릭터당 12 — §1)을 넘긴 묶음. **막지 않고 경고만 한다.**
 * 한 파티가 여러 주에 걸쳐 도는 목록을 담을 수도 있고, 상한은 캐릭터 단위라
 * 파티 단위로 강제하면 실제 사용을 거절하게 된다(§1.3 D5 와 같은 판단).
 */
export const PARTY_BOSS_WEEKLY_SOFT_LIMIT = 12;

/**
 * 입력 순서 그대로 줄임말을 돌려준다. **없는 보스는 여기서 400 으로 거른다** —
 * FK 위반까지 내려가면 Postgres 의 영어 메시지가 500 으로 접혀 아무 말도 못 한다.
 */
async function resolveBossShortNames(
  db: AdminDb,
  bossDifficultyIds: readonly string[],
): Promise<readonly string[]> {
  if (bossDifficultyIds.length > MAX_PARTY_BOSSES) {
    throw ApiError.badRequest(
      `파티에 등록할 수 있는 보스는 ${MAX_PARTY_BOSSES}개까지입니다.`,
    );
  }
  const entries = await loadBossEntries(db, bossDifficultyIds);
  const missing = bossDifficultyIds.filter((id) => !entries.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(
      "등록할 수 없는 보스가 포함되어 있습니다. 목록에서 다시 골라 주세요.",
    );
  }
  return bossDifficultyIds.map((id) => entries.get(id)?.shortName ?? id);
}

/**
 * `public.set_party_bosses(party, ids[])` — 목록 전체를 **원자적으로** 교체한다.
 *
 * 앱에서 delete → insert 로 나누면 그 사이에 실패했을 때 파티의 보스가 통째로 사라진다.
 * PostgREST 왕복 두 번은 한 트랜잭션이 아니므로 그 창이 실제로 열려 있다.
 */
async function writePartyBosses(
  db: AdminDb,
  partyId: PartyId,
  bossDifficultyIds: readonly string[],
): Promise<void> {
  const result = await db.rpc("set_party_bosses", {
    p_party_id: partyId,
    p_boss_difficulty_ids: [...bossDifficultyIds],
  });
  if (result.error === null) return;

  if (isMissingFunction(result.error) || isMissingRelation(result.error)) {
    partyBossFeature = false;
    throw partyBossFeatureUnavailable();
  }
  console.error(`[schedule-repo] set_party_bosses 실패: ${result.error.message}`);
  throw ApiError.badRequest(
    "파티 보스 목록을 저장하지 못했습니다. 목록에 있는 보스인지 확인해 주세요.",
  );
}

/** 보스 목록 저장 결과. 제목이 함께 바뀔 수 있어 파티도 같이 돌려준다. */
export interface PartyBossesResult {
  readonly bosses: readonly PartyBoss[];
  readonly party: Party;
}

/**
 * 파티의 보스 목록을 **통째로 교체**한다 (추가·삭제·순서 변경이 전부 이 한 경로다).
 *
 * ★ 부분 갱신(추가 API + 삭제 API)을 만들지 않은 이유: 순서가 의미를 갖는 목록이라
 *   "3번을 지우고 5번을 2번 자리로" 같은 요청이 곧바로 생긴다. 화면이 이미 최종 목록을
 *   손에 들고 있으므로 그것을 그대로 보내는 편이 규칙이 하나로 남는다
 *   (`PUT /api/schedule/availability/patterns` 와 같은 판단).
 * ★ 빈 배열은 **"전부 지운다"** 이며 정상 입력이다.
 * ★ 저장 뒤 `name_is_custom = false` 인 파티는 제목이 다시 만들어진다.
 */
export async function setPartyBosses(
  userId: string,
  input: SetPartyBossesInput,
): Promise<PartyBossesResult> {
  const db = getAdminDb();
  await requirePartyMembership(db, userId, input.partyId);

  const bossIds = unique([...input.bossDifficultyIds]).filter(
    (id) => id.trim() !== "",
  );

  if (!(await hasPartyBossFeature(db))) {
    /*
      마이그레이션 미적용 DB.

      ★ **빈 목록 저장은 성공으로 접는다.** 구성원 편집 창이 로스터와 보스 목록을 함께
        저장하는데, 보스를 하나도 고르지 않은 저장까지 실패시키면 그 DB 에서는 구성원을
        고칠 때마다 "저장하지 못했습니다"가 뜬다 — 실제로는 로스터가 저장된 뒤인데도.
        저장할 것이 없으면 잃을 것도 없다.
    */
    if (bossIds.length === 0) {
      return { bosses: [], party: await fetchParty(userId, input.partyId) };
    }
    throw partyBossFeatureUnavailable();
  }
  // 존재 검증(없는 보스는 여기서 400). 반환값은 쓰지 않지만 검증이 목적이다.
  await resolveBossShortNames(db, bossIds);

  await writePartyBosses(db, input.partyId, bossIds);
  await refreshPartyAutoName(db, input.partyId);

  const [bosses, party] = await Promise.all([
    fetchPartyBosses(userId, input.partyId),
    fetchParty(userId, input.partyId),
  ]);
  return { bosses, party };
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 런(일정) — **파티에 속한다**
// ─────────────────────────────────────────────────────────────────────────────

const RUN_COLUMNS =
  "id,party_id,run_no,boss_difficulty_id,scheduled_at,duration_minutes,status,capacity,entry_party_size,week_key,note,cancelled_at";

interface RunRow {
  readonly id: string;
  readonly party_id: string;
  readonly run_no: number;
  readonly boss_difficulty_id: string;
  readonly scheduled_at: string | null;
  readonly duration_minutes: number;
  readonly status: RunStatus;
  readonly capacity: number;
  readonly entry_party_size: number | null;
  readonly week_key: string | null;
  readonly note: string | null;
  readonly cancelled_at: string | null;
}

/**
 * 1/n 의 분모.
 *
 * `entry_party_size` 는 nullable 이다. 비어 있으면 그 런의 모집 정원(`capacity`)을 쓴다 —
 * 같은 행에 있어 추가 왕복이 없고, 등록 시점에 잡아 둔 인원 상한이라 분모로 가장 가까운
 * 값이다. 사용자가 언제든 고칠 수 있다 (§1.3 D3).
 */
function entryPartySizeOf(row: RunRow): number {
  return Math.max(row.entry_party_size ?? row.capacity, 1);
}

/** `loadViewerShares` 의 입력. `RunRow` + 보스 가격에서 뽑아 낸다. */
interface RunShareSeed {
  readonly runId: string;
  readonly entryPartySize: number;
  readonly crystalPriceMeso: MesoOrUnknown;
}

/** 런 하나의 분배 가중치 묶음. `distribute_meso` 인자 모양 그대로다. */
interface RunShareWeights {
  readonly keys: string[];
  readonly weights: number[];
  /** 열람자의 `party_participants.id`. 참가자가 아니면 null. */
  viewerParticipantId: string | null;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 런별 **열람자 몫** — 분배 계산은 전부 DB 가 한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **여기서 1/n 을 계산하지 않는다.** 분배 규칙의 구현은 `public.distribute_meso()`
 *    하나뿐이어야 한다 — 웹·카톡 봇(`!결정석`)·주간 집계 뷰가 **같은 답**을 내야 하기
 *    때문이다. 화면이 TS 에서 균등 분배를 다시 계산하던 시절, `share_mode = 'manual'` 인
 *    런(칼로스 33:67)에서 화면이 실제 약정과 다른 금액을 말했다.
 *
 * ── 왜 가중치를 우리가 만들지 않는가 ─────────────────────────────────────────
 * 뷰 `v_run_share_weights` 가 이미 정한다 — `auto_equal` 이면 **1**, `manual` 이면
 * `share_bp`, 아직 아무도 비율을 지정하지 않았으면(합 0) 다시 **1**.
 * ★ 균등을 bp 로 표현하면 안 된다. 1/6 이 `1667/1666` 으로 근사되어 6인 파티에서 1인당
 *   수천 메소가 어긋난다(하드 스우 실측: 8,583,333 이어야 할 값이 8,585,049 가 된다).
 *   가중치를 전부 1 로 두면 분모가 n 이라 pot 이 정확히 나누어떨어져 **게임 결과와
 *   1메소도 다르지 않다.** 이 규칙 역시 뷰에 있으므로 TS 가 알 필요가 없다.
 *
 * ── pot 은 게임이 정하고, 그 안의 배분은 사람이 정한다 ───────────────────────
 * `pot = party_size × floor(솔로가 / party_size)` — 게임 규칙이고 우리가 못 바꾼다.
 * 솔로가를 그대로 나눠 주면 나누어떨어지지 않는 보스에서 최대 `n-1` 메소가 없던 돈으로
 * 늘어난다(하드 스우 51,500,000 → pot 51,499,998). 그래서 곱셈을 생략하지 않는다.
 * 곱하기 전의 `floor` 는 `crystalShareMeso()` **한 곳**에만 있다.
 */
async function loadViewerShares(
  db: AdminDb,
  viewerUserId: string | null,
  seeds: readonly RunShareSeed[],
): Promise<Map<string, MesoOrUnknown>> {
  const shares = new Map<string, MesoOrUnknown>();
  const pots = new Map<string, number>();

  for (const seed of seeds) {
    const perEntrant = crystalShareMeso(seed.crystalPriceMeso, seed.entryPartySize);
    if (perEntrant === null) {
      // 가격 미확인. **0 이 아니다** — 화면이 합계에서 빼고 따로 센다 (§1.3 D4).
      shares.set(seed.runId, null);
      continue;
    }
    // 기본값 = 게임이 입장자 1인에게 주는 몫. 열람자가 그 런의 `going` 참가자가 아니면
    // 이 값이 그대로 답이다 — DB `resolve_crystal_payout()` 이 미등록자에게 돌려주는
    // 값과 **같은 정책**이라 우리가 새로 만든 규칙이 아니다.
    shares.set(seed.runId, perEntrant);
    pots.set(seed.runId, perEntrant * seed.entryPartySize);
  }

  // 비로그인에게는 "내 몫"이 정의되지 않는다. 위의 게임 기본값이 곧 답이므로 왕복도 하지 않는다.
  if (viewerUserId === null || pots.size === 0) return shares;

  const weightRows = unwrap(
    await db
      .from("v_run_share_weights")
      .select("run_id,participant_id,user_id,weight")
      .in("run_id", [...pots.keys()]),
    "런 분배 가중치 조회",
  );

  const byRun = new Map<string, RunShareWeights>();
  for (const row of weightRows) {
    if (row.run_id === null || row.participant_id === null || row.weight === null) {
      continue;
    }
    let entry = byRun.get(row.run_id);
    if (entry === undefined) {
      entry = { keys: [], weights: [], viewerParticipantId: null };
      byRun.set(row.run_id, entry);
    }
    entry.keys.push(row.participant_id);
    entry.weights.push(row.weight);
    if (row.user_id === viewerUserId) entry.viewerParticipantId = row.participant_id;
  }

  await Promise.all(
    [...pots].map(async ([runId, pot]) => {
      const entry = byRun.get(runId);
      // 참가자가 아니면 게임 기본값을 그대로 둔다. 호출할 이유가 없다.
      if (entry === undefined || entry.viewerParticipantId === null) return;

      const rows = unwrap(
        await db.rpc("distribute_meso", {
          p_total: pot,
          p_keys: entry.keys,
          p_weights: entry.weights,
        }),
        "결정석 분배 계산",
      );
      const mine = rows.find((row) => row.key === entry.viewerParticipantId);
      if (mine !== undefined) shares.set(runId, mine.amount);
    }),
  );

  return shares;
}

function toScheduledRun(
  row: RunRow,
  boss: BossCatalogEntry | undefined,
  viewerShareMeso: MesoOrUnknown,
  participants: readonly RunParticipant[],
): ScheduledRun {
  const scheduledAt = row.scheduled_at === null ? null : new Date(row.scheduled_at);
  return {
    runId: row.id,
    partyId: row.party_id,
    // 트리거 `party_runs_assign_run_no` 가 넣은 관리 번호. 재배열·재사용하지 않는다 (§1.4).
    runNo: row.run_no,
    bossDifficultyId: row.boss_difficulty_id,
    // ★ `bosses.korean_name`(`더스크`)이지 `boss_difficulties.korean_name`(`카오스 더스크`)이
    //   아니다. `BossCard` 가 난이도 라벨을 **별도 오버라인으로 이미 그리므로**, 후자를 넣으면
    //   카드가 "카오스 / 카오스 더스크"로 난이도를 두 번 말한다(실제로 그렇게 렌더됐다).
    //   `BossCatalogEntry` 의 두 필드가 갈라져 있는 이유가 정확히 이것이다(domain.ts §보스 마스터).
    bossKoreanName: boss?.bossKoreanName ?? row.boss_difficulty_id,
    /*
      좁은 자리(칩·요약 줄·카톡 평문)에서 쓰는 줄임말. 파티 제목(`익세 하대 하카 2인`)과
      **같은 어휘**여야 사용자가 파티와 그 일정을 눈으로 이을 수 있다.
      카드 제목에는 쓰지 않는다 — 카드는 난이도 라벨을 따로 그려서 "하드 / 하카"가 된다.
    */
    shortName: boss?.shortName ?? row.boss_difficulty_id,
    difficulty: boss?.difficulty ?? "normal",
    scheduledAt,
    durationMinutes: row.duration_minutes,
    status: row.status,
    entryPartySize: entryPartySizeOf(row),
    weekKey: row.week_key ?? getWeekKey(scheduledAt ?? new Date()),
    crystalPriceMeso: boss?.crystalPriceMeso ?? null,
    // ★ DB `distribute_meso` 가 낸 값을 **그대로 싣는다.** 여기서 다시 나누지 않는다
    //   — `loadViewerShares` 주석 참고.
    viewerShareMeso,
    note: row.note,
    // 사람 이름만으로는 "어느 캐릭터가 가는가"를 알 수 없다 — 12개 상한이 캐릭터당이다.
    participants,
  };
}

/** 시각 미정(null)은 맨 뒤 — 조율 중인 일정이다. 동률이면 등록 번호 순. */
function compareRuns(a: ScheduledRun, b: ScheduledRun): number {
  const at = a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return at - bt || a.runNo - b.runNo;
}

/**
 * 그 파티의 그 주차 일정.
 *
 * **취소된 런은 목록에서 뺀다.** 화면의 하단 합계(`scheduled-run-list.tsx`)가 전달된 런을
 * 상태와 무관하게 전부 더하므로, 취소분을 넣으면 주간 수익이 부풀려진다. §1.4 의
 * "번호는 재배열하지 않는다"는 그대로 지켜진다 — 빠진 번호가 목록에 구멍으로 남을 뿐이다.
 */
export async function fetchPartyRuns(
  viewerUserId: string | null,
  partyId: PartyId,
  weekKey: WeekKey,
): Promise<readonly ScheduledRun[]> {
  const db = getAdminDb();
  await assertPartyVisible(db, viewerUserId, partyId);

  const rows = unwrap(
    await db
      .from("party_runs")
      .select(RUN_COLUMNS)
      .eq("party_id", partyId)
      .eq("week_key", weekKey)
      .is("cancelled_at", null)
      .neq("status", "cancelled"),
    "파티 일정 조회",
  );

  const bosses = await loadBossEntries(
    db,
    unique(rows.map((row) => row.boss_difficulty_id)),
  );

  // 분배는 DB 가 한다. 화면은 받은 값을 표시만 한다 (`loadViewerShares` 주석).
  const [shares, participants] = await Promise.all([
    loadViewerShares(
      db,
      viewerUserId,
      rows.map((row) => ({
        runId: row.id,
        entryPartySize: entryPartySizeOf(row),
        crystalPriceMeso:
          bosses.get(row.boss_difficulty_id)?.crystalPriceMeso ?? null,
      })),
    ),
    loadRunParticipants(
      db,
      viewerUserId,
      rows.map((row) => row.id),
    ),
  ]);

  return rows
    .map((row) =>
      toScheduledRun(
        row,
        bosses.get(row.boss_difficulty_id),
        shares.get(row.id) ?? null,
        participants.get(row.id) ?? [],
      ),
    )
    .sort(compareRuns);
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기 — 전부 Route Handler(service_role) + 세션 검증을 거친다
// ─────────────────────────────────────────────────────────────────────────────

/** `parties.name` CHECK 는 `length(btrim(name)) between 1 and 60` 이다. */
function clampPartyName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed;
}

/**
 * 후보 목록에 없는 사람은 파티에 넣을 수 없다.
 *
 * ★ 이건 편의가 아니라 **프라이버시 경계**다. 파티에 넣는 순간
 *   `can_view_availability()` 가 그 사람의 생활 패턴을 나에게 열어 준다. 아무 uuid 나
 *   받아 주면 남의 가용시간을 마음대로 열 수 있게 된다.
 */
async function resolveSelectablePeople(
  userId: string,
  personIds: readonly PersonId[],
): Promise<Map<PersonId, Person>> {
  const pool = await fetchPeoplePool(userId);
  const byId = new Map(pool.map((person) => [person.personId, person]));
  for (const personId of personIds) {
    if (!byId.has(personId)) {
      throw ApiError.badRequest(
        "파티에 넣을 수 없는 사람이 포함되어 있습니다. 친구이거나 같은 파티인 사람만 추가할 수 있습니다.",
      );
    }
  }
  return byId;
}

/** 게스트 닉네임 길이 상한. DB CHECK(`1~40자`)와 **같은 경계**다. */
const GUEST_NAME_MAX_LENGTH = 40;
/** 한 번에 만들 수 있는 게스트 수. 로스터 상한(24)과 같은 눈금. */
const MAX_GUEST_NAMES = 24;

/**
 * **닉네임만으로** 사람을 만든다 (`guest_profiles`).
 *
 * 발주 요구(원문): "그냥 닉네임만으로도 파티 만들수있게 해야함. 상대방이 참여 안할수도있잖아."
 *
 * ★ 계정도 초대도 필요 없다. `party_participants` 의 CHECK 가
 *   `num_nonnulls(user_id, guest_id) = 1` 이라 게스트 경로는 처음부터 1급 시민이다.
 * ★ **이름이 같아도 합치지 않는다.** 닉네임은 키가 아니고, 같은 이름의 다른 사람이
 *   실제로 있다. 합쳐 버리면 남의 파티에 조용히 끼어드는 것과 같아진다.
 * ★ 만든 게스트는 `claim_token_hash` 가 **비어 있다.** 초대 링크는 나중에 따로 발급하며
 *   (`features/invites`), 그때까지는 승계할 방법이 아예 없다.
 * ★ 게스트는 세션이 없어 **가용시간을 스스로 입력할 수 없다.** 화면이 그 사실을
 *   "가능 시간 미등록"으로 정직하게 알리고 초대 링크로 유도한다.
 */
async function createGuestProfiles(
  db: AdminDb,
  names: GuestNameInput,
): Promise<Person[]> {
  const cleaned = names
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (cleaned.length === 0) return [];

  if (cleaned.length > MAX_GUEST_NAMES) {
    throw ApiError.badRequest(
      `한 번에 추가할 수 있는 게스트는 ${MAX_GUEST_NAMES}명까지입니다.`,
    );
  }
  for (const name of cleaned) {
    if (name.length > GUEST_NAME_MAX_LENGTH) {
      throw ApiError.badRequest(
        `닉네임은 ${GUEST_NAME_MAX_LENGTH}자 이하여야 합니다: ${name.slice(0, GUEST_NAME_MAX_LENGTH)}…`,
      );
    }
  }

  // 같은 요청 안의 중복만 접는다. 이미 존재하는 게스트와는 합치지 않는다(위 주석).
  const rows = unwrap(
    await db
      .from("guest_profiles")
      .insert(unique(cleaned).map((display_name) => ({ display_name })))
      .select("id,display_name"),
    "게스트 생성",
  );

  return rows.map(
    (row): Person => ({
      personId: row.id,
      displayName: row.display_name,
      isGuest: true,
    }),
  );
}

/**
 * 새 파티.
 *
 * ⚠️ `member_no` 는 **넘기지 않는다.** 트리거가 행마다 `max + 1` 을 넣어 1..n 이 된다
 *    (`TriggerAssigned` 주석 참고). 넘기면 트리거가 그 값을 그대로 존중해 버린다.
 *
 * ★ **닉네임만 있는 사람도 함께 넣는다** (`guestNames`). 그래야 상대가 아직 이 앱을
 *   쓰지 않아도 파티가 성립한다. 게스트도 번호를 받고, 그 번호는 나중에 초대 링크로
 *   계정을 승계해도 **그대로 유지된다** — `claim_guest_profile` 이 `member_no` 를
 *   건드리지 않기 때문이다 (§1.4).
 */
export async function createParty(
  userId: string,
  input: CreatePartyInput,
): Promise<Party> {
  const db = getAdminDb();

  // 생성자는 반드시 포함된다. 소유자가 없는 파티는 편집할 사람이 없다.
  const memberIds = unique([
    userId,
    ...input.memberPersonIds.filter((id) => id !== userId),
  ]);
  const people = await resolveSelectablePeople(userId, memberIds);

  /*
    게스트 생성이 파티 INSERT 보다 **먼저**다. 이름 규칙(`우레푸 외 3명`)이 게스트까지
    포함한 인원수로 계산돼야 하고, 여기서 실패하면 빈 파티가 남지 않는다.
  */
  const guests = await createGuestProfiles(db, input.guestNames ?? []);
  for (const guest of guests) people.set(guest.personId, guest);
  const allMemberIds = [...memberIds, ...guests.map((g) => g.personId)];

  const names = allMemberIds.map(
    (id) => people.get(id)?.displayName ?? "알 수 없음",
  );
  const capacity = Math.min(Math.max(allMemberIds.length, 1), 24);

  /*
    ── 제목 ───────────────────────────────────────────────────────────────────
    보스를 함께 받는 이유가 여기다. 만든 뒤에 따로 등록하게 하면 파티가 잠깐
    `우레푸 외 2명` 이라는 이름으로 존재했다가 바뀐다.

    ★ 사용자가 이름을 **적었으면 그것이 이긴다**(`nameIsCustom = true`). 비워 두면
      자동 제목이고, 이후 보스·정원이 바뀔 때 서버가 다시 만든다. "비워 두면 자동"은
      이 화면이 원래 쓰던 규약 그대로다(placeholder + 안내 문구).
  */
  const bossIds = unique([...(input.bossDifficultyIds ?? [])]).filter(
    (id) => id.trim() !== "",
  );
  const featureReady = await hasPartyBossFeature(db);
  /*
    ⚠️ 기능 여부는 **파티를 만들기 전에** 확인한다. 만든 뒤에 확인하면 보스 없는 파티만
    남기고 400 을 돌려주게 되어, 사용자는 실패했다고 읽는데 목록에는 파티가 생긴다.
  */
  if (bossIds.length > 0 && !featureReady) throw partyBossFeatureUnavailable();

  const nameIsCustom = input.name.trim() !== "";
  const shortNames =
    bossIds.length === 0 ? [] : await resolveBossShortNames(db, bossIds);
  const autoName =
    buildPartyTitle(shortNames, capacity) ?? summarizePartyName(names);
  const name = clampPartyName(nameIsCustom ? input.name : autoName);
  if (name === "") throw ApiError.badRequest("파티 이름이 비어 있습니다.");

  const partyRows = unwrap(
    await db
      .from("parties")
      .insert(
        // 컬럼이 아직 없는 DB(마이그레이션 22 미적용)에서는 이 키를 빼야 INSERT 가 산다.
        featureReady
          ? {
              owner_user_id: userId,
              name,
              visibility: "private" as const,
              default_capacity: capacity,
              name_is_custom: nameIsCustom,
            }
          : {
              owner_user_id: userId,
              name,
              visibility: "private" as const,
              default_capacity: capacity,
            },
      )
      .select("id,name,visibility,default_capacity"),
    "파티 생성",
  );
  const party = partyRows[0];
  if (party === undefined) throw ApiError.internal();

  if (bossIds.length > 0) {
    // 순서는 입력 그대로. 제목이 그 순서로 만들어졌으므로 여기서 바꾸면 둘이 어긋난다.
    await writePartyBosses(db, party.id, bossIds);
  }

  const participants: ParticipantSeed[] = allMemberIds.map((personId) => {
    const person = people.get(personId);
    const isGuest = person?.isGuest ?? false;
    return {
      party_id: party.id,
      user_id: isGuest ? null : personId,
      guest_id: isGuest ? personId : null,
      display_name: person?.displayName ?? "알 수 없음",
      role: personId === userId ? ("owner" as const) : ("member" as const),
    };
  });

  unwrap(
    // 트리거가 `member_no` 를 채운다 — 근거는 `TriggerAssigned` 주석. 좁은 캐스트 1/3.
    await db
      .from("party_participants")
      .insert(participants as ParticipantInsert[])
      .select("id"),
    "파티 구성원 생성",
  );

  return {
    partyId: party.id,
    name: party.name,
    visibility: party.visibility,
    defaultCapacity: party.default_capacity,
    memberCount: participants.length,
    nameIsCustom,
  };
}

/**
 * 로스터 편집.
 *
 * ★ **번호를 재배열하지도, 빈 번호를 재사용하지도 않는다** (§1.4).
 *   - 남는 사람 → 번호 그대로
 *   - 다시 들어온 사람 → **예전 번호를 되찾는다.** `(party_id, user_id)` 가 unique 라
 *     재삽입이 불가능하기도 하고, 대화 중 "3번"이 계속 같은 사람을 가리켜야 한다.
 *   - 처음 들어온 사람 → `max(member_no) + 1` (나간 사람의 번호까지 포함한 max)
 */
export async function updatePartyRoster(
  userId: string,
  input: UpdatePartyRosterInput,
): Promise<readonly PartyMember[]> {
  const db = getAdminDb();
  await requirePartyMembership(db, userId, input.partyId);

  // 나간 사람도 함께 읽는다 — 번호 재사용 금지와 재가입 처리에 둘 다 필요하다.
  const existing = unwrap(
    await db
      .from("party_participants")
      .select("id,user_id,guest_id,member_no,left_at")
      .eq("party_id", input.partyId),
    "로스터 조회",
  );

  // 편집자가 스스로를 빼면 그 즉시 파티가 보이지 않게 된다. 편집 다이얼로그의 일이
  // 아니므로 항상 남긴다.
  const wanted = new Set(unique([userId, ...input.memberPersonIds]));
  const existingByPerson = new Map(
    existing.flatMap((row) => {
      const personId = row.user_id ?? row.guest_id;
      return personId === null ? [] : [[personId, row] as const];
    }),
  );

  const additions = [...wanted].filter((id) => !existingByPerson.has(id));
  const people =
    additions.length === 0
      ? new Map<PersonId, Person>()
      : await resolveSelectablePeople(userId, additions);

  /*
    닉네임만 있는 신규 게스트. 기존 게스트는 이미 `PersonId` 를 가지고 있어
    `memberPersonIds` 로 들어오므로 여기서 또 만들지 않는다 — 만들면 같은 사람이
    번호 두 개를 갖게 된다.
  */
  const newGuests = await createGuestProfiles(db, input.guestNames ?? []);
  for (const guest of newGuests) people.set(guest.personId, guest);
  const allAdditions = [...additions, ...newGuests.map((g) => g.personId)];

  // (1) 빠진 사람 — 소프트 삭제. 번호는 그대로 남겨 둔다.
  for (const row of existing) {
    const personId = row.user_id ?? row.guest_id;
    if (personId === null || row.left_at !== null) continue;
    if (wanted.has(personId)) continue;
    unwrap(
      await db
        .from("party_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("id", row.id)
        .select("id"),
      "구성원 제외",
    );
  }

  // (2) 다시 들어온 사람 — 예전 번호로 복귀.
  for (const personId of wanted) {
    const row = existingByPerson.get(personId);
    if (row === undefined || row.left_at === null) continue;
    unwrap(
      await db
        .from("party_participants")
        .update({ left_at: null })
        .eq("id", row.id)
        .select("id"),
      "구성원 복귀",
    );
  }

  // (3) 처음 들어온 사람 — 트리거가 `max + 1` 을 넣는다(나간 사람의 번호까지 포함한 max).
  //     앱이 max 를 읽어 넣지 않는 이유: 조회와 삽입 사이가 열려 있어 동시 편집에서
  //     유니크 위반이 난다. 트리거는 advisory lock 안에서 계산하므로 그 틈이 없다.
  const inserts: ParticipantSeed[] = allAdditions.map((personId) => {
    const person = people.get(personId);
    const isGuest = person?.isGuest ?? false;
    return {
      party_id: input.partyId,
      user_id: isGuest ? null : personId,
      guest_id: isGuest ? personId : null,
      display_name: person?.displayName ?? "알 수 없음",
      role: "member" as const,
    };
  });
  if (inserts.length > 0) {
    unwrap(
      // 트리거가 `member_no` 를 채운다 — 근거는 `TriggerAssigned` 주석. 좁은 캐스트 2/3.
      await db
        .from("party_participants")
        .insert(inserts as ParticipantInsert[])
        .select("id"),
      "구성원 추가",
    );
  }

  const members = await fetchPartyMembers(userId, input.partyId);

  /*
    ── 정원과 제목을 로스터에 맞춘다 ──────────────────────────────────────────
    자동 제목의 `2인` 은 `parties.default_capacity` 에서 나온다(생성 시 구성원 수로
    채워진다). 로스터를 고쳤는데 정원이 그대로면 `익세 하대 하카 2인` 파티가 3명이
    되어도 계속 `2인` 이라고 말한다 — 제목이 조용히 거짓이 된다.

    ★ `name_is_custom = true` 인 파티는 **제목만** 그대로 두고 정원은 맞춘다.
      정원은 이름이 아니라 사실이고, 사람이 고른 값이 아니다.
  */
  const capacity = Math.min(Math.max(members.length, 1), 24);
  unwrap(
    await db
      .from("parties")
      .update({ default_capacity: capacity })
      .eq("id", input.partyId)
      .select("id"),
    "파티 정원 갱신",
  );
  await refreshPartyAutoName(db, input.partyId);

  return members;
}

/**
 * 일정 등록 — **체크한 보스들을 연달아 잡는다** (묶음 등록).
 *
 * 발주 요구(원문): *"보통 묶어서 가니 파티안에 보스를 여러개 등록 하고 시간 등록할때
 * 등록된 보스를 체크해서 시간대를 등록하게 만들어."*
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **순차 배치**가 기본이다. 같은 시각에 몰아넣지 않는다.
 *   ═══════════════════════════════════════════════════════════════════════════
 *   익세 → 하대 → 하카는 한 자리에서 이어서 도는 순서이지 동시에 세 군데를 가는 것이
 *   아니다. 전부 같은 시각으로 넣으면 겹쳐보기 화면에서 막대 셋이 정확히 포개져
 *   **어느 것도 읽을 수 없게 된다.** 그래서 i 번째 보스는
 *   `시작 시각 + durationMinutes × i` 에 놓인다.
 *
 *   소요 시간을 보스별로 다르게 두지 않은 이유는 그 데이터가 어디에도 없기 때문이다
 *   (넥슨 API 에도 없다 — §1.1). 한 값을 전부에 적용하고 사용자가 그 값을 조절한다.
 *
 * ★ **한 건씩 INSERT 한다.** `party_runs_assign_run_no` 트리거가 `max(run_no) + 1` 을
 *   읽어 넣는데, 여러 행을 한 문장으로 넣으면 같은 스냅샷을 보고 같은 번호를 계산할 수
 *   있다. 번호가 겹치면 카톡의 "2번 일정"이 두 개가 된다 (§1.4). 한 건씩 넣으면 각
 *   INSERT 가 별도 트랜잭션이라 그 창이 없다. N ≤ 24 라 왕복 비용도 감당된다.
 *
 * ⚠️ `week_key` 는 **생성 컬럼**(`week_key(coalesce(scheduled_at, created_at))`)이라
 *    INSERT 에 넣으면 에러다. 넣지 않는다.
 * ⚠️ `max_party` 초과는 **막지 않는다.** 소프트 상한이라 화면이 경고만 한다 (§1.3 D5).
 */
export async function createPartyRuns(
  userId: string,
  input: CreateRunBundleInput,
): Promise<readonly ScheduledRun[]> {
  const db = getAdminDb();
  const myParticipantId = await requirePartyMembership(
    db,
    userId,
    input.partyId,
  );

  // ★ **캐릭터 검증이 보스 조회보다 먼저다.** 남의 캐릭터 id 가 들어왔다면 그 요청은
  //   어차피 거절되므로, 거절이 확정된 요청에 조회를 더 태우지 않는다.
  const characterId = await requireOwnedTrackedCharacter(
    db,
    userId,
    input.characterId,
  );

  // 같은 보스를 두 번 체크한 것은 실수다. 거절할 사건이 아니라 접을 사건이다 —
  // 그대로 넣으면 결정석 수익이 두 번 잡힌다.
  const bossIds = unique([...input.bossDifficultyIds]).filter(
    (id) => id.trim() !== "",
  );
  if (bossIds.length === 0) {
    throw ApiError.badRequest("등록할 보스를 하나 이상 선택해 주세요.");
  }
  if (bossIds.length > MAX_PARTY_BOSSES) {
    throw ApiError.badRequest(
      `한 번에 등록할 수 있는 보스는 ${MAX_PARTY_BOSSES}개까지입니다.`,
    );
  }

  if (!Number.isFinite(input.entryPartySize) || input.entryPartySize < 1) {
    throw ApiError.badRequest("파티 인원수는 1명 이상이어야 합니다.");
  }
  const entryPartySize = Math.min(Math.trunc(input.entryPartySize), 24);
  const durationMinutes = Math.min(
    Math.max(Math.trunc(input.durationMinutes), 5),
    600,
  );

  const bosses = await loadBossEntries(db, bossIds);
  for (const bossId of bossIds) {
    if (!bosses.has(bossId)) {
      throw ApiError.badRequest("등록할 수 없는 보스입니다.");
    }
  }

  // 참가 의사는 **사람 id** 로 들어오므로 그 파티의 `party_participants.id` 로 옮긴다.
  const members = await fetchPartyMembers(userId, input.partyId);
  const participantIdByPerson = new Map(
    members.map((member) => [member.personId, member.participantId]),
  );

  const capacity = Math.min(Math.max(members.length, entryPartySize, 1), 24);

  /*
   * 참가 의사를 펼친다.
   *
   * ★ **캐릭터가 채워지는 것은 등록자 본인 행뿐이다.** 다른 사람이 어느 캐릭터로 갈지는
   *   우리가 알 방법이 없고(넥슨 API 도 남의 계정을 못 읽는다 — §1.1), 임의로 찍으면
   *   그 사람의 12개 상한 카운터가 엉뚱한 캐릭터에 쌓인다. 나머지는 null 로 두고
   *   `saveRunSignup()` 으로 각자 채운다.
   * ★ 등록자는 자기 파티의 참가자이므로(위 `requirePartyMembership`) 목록에 없더라도
   *   본인 행은 반드시 만든다 — 캐릭터를 골라 놓고 참가자에서 빠지는 상태는 없어야 한다.
   */
  const signupPersonIds = unique([userId, ...input.participantPersonIds]);

  const startedAtMs = input.scheduledAt.getTime();
  const createdRows: RunRow[] = [];

  for (const [index, bossDifficultyId] of bossIds.entries()) {
    const scheduledAt = new Date(
      startedAtMs + index * durationMinutes * 60_000,
    );

    const seed: PartyRunSeed = {
      party_id: input.partyId,
      boss_difficulty_id: bossDifficultyId,
      scheduled_at: scheduledAt.toISOString(),
      duration_minutes: durationMinutes,
      status: "confirmed",
      capacity,
      entry_party_size: entryPartySize,
      created_by_participant_id: myParticipantId,
      note: input.note,
      // run_no  → 트리거가 넣는다. week_key → 생성 컬럼이라 넣으면 에러다.
    };

    const runRows = unwrap(
      // 트리거가 `run_no` 를 채운다 — 근거는 `TriggerAssigned` 주석. 좁은 캐스트 3/3.
      await db
        .from("party_runs")
        .insert(seed as PartyRunInsert)
        .select(RUN_COLUMNS),
      "일정 등록",
    );
    const run = runRows[0];
    if (run === undefined) throw ApiError.internal();
    createdRows.push(run);

    const signups = signupPersonIds.flatMap((personId) => {
      const participantId = participantIdByPerson.get(personId);
      if (participantId === undefined) return [];
      return [
        {
          run_id: run.id,
          participant_id: participantId,
          status: "going" as const,
          character_id: participantId === myParticipantId ? characterId : null,
        },
      ];
    });
    if (signups.length > 0) {
      unwrap(
        await db.from("run_signups").insert(signups).select("id"),
        "일정 참가 등록",
      );
    }
  }

  // **참가 등록 뒤에** 부른다 — `v_run_share_weights` 가 `run_signups` 를 읽으므로
  // 순서가 뒤집히면 방금 만든 런의 참가자가 한 명도 안 보인다.
  // 참가자 목록도 같은 이유로 이 시점에 읽는다.
  const [shares, participants] = await Promise.all([
    loadViewerShares(
      db,
      userId,
      createdRows.map((run) => ({
        runId: run.id,
        entryPartySize: entryPartySizeOf(run),
        crystalPriceMeso:
          bosses.get(run.boss_difficulty_id)?.crystalPriceMeso ?? null,
      })),
    ),
    loadRunParticipants(
      db,
      userId,
      createdRows.map((run) => run.id),
    ),
  ]);

  return createdRows.map((run) =>
    toScheduledRun(
      run,
      bosses.get(run.boss_difficulty_id),
      shares.get(run.id) ?? null,
      participants.get(run.id) ?? [],
    ),
  );
}

/**
 * 단건 등록 — 묶음 등록의 **보스 1개짜리 특수한 경우**다.
 *
 * 계획 화면(`features/boss-plans` 의 일정 만들기 모달)이 이 시그니처를 그대로 쓰고 있어
 * 남겨 둔다. 구현이 하나이므로 두 경로가 다르게 동작할 여지가 없다.
 */
export async function createPartyRun(
  userId: string,
  input: CreateRunInput,
): Promise<ScheduledRun> {
  const runs = await createPartyRuns(userId, {
    partyId: input.partyId,
    bossDifficultyIds: [input.bossDifficultyId],
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    entryPartySize: input.entryPartySize,
    participantPersonIds: input.participantPersonIds,
    characterId: input.characterId,
    note: input.note,
  });
  const run = runs[0];
  if (run === undefined) throw ApiError.internal();
  return run;
}

/**
 * 참가 신청 — **어느 캐릭터로 가는지 반드시 밝힌다.**
 *
 * ★ 본인 행만 만든다/고친다. 남이 대신 넣어 준 행(캐릭터 null)을 본인이 채우는 것도
 *   이 경로다. `(run_id, participant_id)` 유니크라 upsert 로 한 번에 처리된다.
 * ★ 런이 아니라 **파티**로 권한을 판정한다. 런은 파티에 속하고, 파티 구성원이 아니면
 *   애초에 그 런이 보이지도 않아야 한다.
 */
export async function saveRunSignup(
  userId: string,
  input: SaveRunSignupInput,
): Promise<readonly RunParticipant[]> {
  const db = getAdminDb();

  const runRows = unwrap(
    await db
      .from("party_runs")
      .select("id,party_id,cancelled_at,status")
      .eq("id", input.runId)
      .limit(1),
    "참가 신청 대상 일정 조회",
  );
  const run = runRows[0];
  // 보이지 않는 런은 존재 여부도 알리지 않는다 — 파티와 같은 규칙이다.
  if (run === undefined) throw partyNotVisible();
  if (run.cancelled_at !== null || run.status === "cancelled") {
    throw ApiError.badRequest("취소된 일정에는 참가할 수 없습니다.");
  }

  const myParticipantId = await requirePartyMembership(db, userId, run.party_id);
  const characterId = await requireOwnedTrackedCharacter(
    db,
    userId,
    input.characterId,
  );

  unwrap(
    await db
      .from("run_signups")
      .upsert(
        {
          run_id: run.id,
          participant_id: myParticipantId,
          status: input.status,
          character_id: characterId,
        },
        { onConflict: "run_id,participant_id" },
      )
      .select("id"),
    "참가 신청 저장",
  );

  const participants = await loadRunParticipants(db, userId, [run.id]);
  return participants.get(run.id) ?? [];
}
