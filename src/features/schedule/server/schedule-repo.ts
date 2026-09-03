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
import { enqueueRunsCreatedNotice } from "@/features/bot/server/outbox";
import { getBossEntryMap } from "@/lib/boss-master";
import { buildPartyTitle } from "@/lib/domain/party-title";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { Database } from "@/types/database";
import type {
  AvailabilityCycle,
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityInterval,
  AvailabilityPattern,
  AvailabilityPatternInput,
  BossCatalogEntry,
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
  PartyMemberBrief,
  Person,
  PersonId,
  RunCharacterOption,
  RunId,
  RunCommitment,
  RunParticipant,
  RunRemovalOutcome,
  RunStatus,
  SaveRunSignupInput,
  ScheduledRun,
  DaySelection,
  SetPartyBossesInput,
  ShiftAssignment,
  ShiftPreset,
  ShiftPresetInput,
  TimeRange,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
  UpdateRunInput,
  WeekKey,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";
import type {
  PartySharesPayload,
  RunShareParticipantWire,
  RunSharesPayload,
} from "../types";

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

/*
 * ★ `loadBossShortNames()` 는 없앴다. 줄임말은 `boss_difficulties.short_name` 을
 *   매번 78행씩 읽어 왔지만, 이제 시드 마이그레이션에서 생성한 코드 상수
 *   (`@/lib/boss-master`)가 같은 값을 왕복 없이 준다. 마이그레이션 미적용 대비
 *   폴백(줄임말 자리에 보스 전체 이름)은 상수 쪽 `shortName ?? koreanName` 이
 *   그대로 이어받는다.
 */

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
  /*
   * ★ 세 조회를 **동시에** 띄운다 (2026-08-18 성능 작업).
   *   예전에는 `공개 목록 → 참가 여부 → 보관 여부` 직렬 3단이었고, 이 함수는
   *   `/schedule` 첫 진입에서 구성원·파티 보스·런 조회가 **각각** 부른다. 원격
   *   Supabase 왕복 1회 ≈ 78ms 이므로 직렬 3단은 그 자체로 ~230ms 다.
   *
   *   ⚠️ **판정은 한 글자도 바뀌지 않는다.** 아래 if 순서가 예전 코드의 조기 반환
   *      순서와 같고, 각 조회는 서로의 결과를 쓰지 않는다. 달라지는 것은 "공개
   *      파티였다면 하지 않았을 조회 두 번"이 함께 나간다는 점뿐인데, 그 둘은
   *      service_role 내부 조회이고 결과는 버려진다.
   *   ⚠️ 비로그인은 참가 조회를 **띄우지 않는다.** `user_id` 가 null 이면 조건이
   *      성립하지 않아 의미가 없고, 예전 코드도 그 지점에서 곧장 거절했다.
   */
  const [publicIds, membership, alive] = await Promise.all([
    loadPublicPartyIds(db),
    viewerUserId === null
      ? Promise.resolve([] as { id: string }[])
      : (async () =>
          unwrap(
            await db
              .from("party_participants")
              .select("id")
              .eq("party_id", partyId)
              .eq("user_id", viewerUserId)
              .is("left_at", null)
              .limit(1),
            "파티 참가 여부 확인",
          ))(),
    (async () =>
      unwrap(
        await db
          .from("parties")
          .select("id")
          .eq("id", partyId)
          .is("archived_at", null)
          .limit(1),
        "파티 보관 여부 확인",
      ))(),
  ]);

  if (publicIds.has(partyId)) return;
  if (viewerUserId === null) throw partyNotVisible();
  if (membership.length === 0) throw partyNotVisible();
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

  const participantRows = unwrap(
    await db
      .from("party_participants")
      /*
        ★ **`character_id` 를 함께 읽는다** (2026-08-20).
          런에 캐릭터를 따로 고르지 않았어도 **파티에 데려가는 캐릭터**가 있으면 그것이
          답이다 — DB 함수 `run_participant_names` 가 이미
          `coalesce(s.character_id, pp.character_id)` 로 그렇게 떨어진다.
          여기만 `run_signups.character_id` 만 보고 있어서, 같은 사람이 봇에서는
          `죠린(쌍욱)` 웹에서는 `캐릭터 미지정` 으로 나왔다(발주 지적).
      */
      .select("id,user_id,guest_id,display_name,member_no,character_id")
      .in("id", participantIds),
    "런 참가자 신원 조회",
  );

  const participantById = new Map(participantRows.map((row) => [row.id, row]));

  /*
    캐릭터 라벨은 **떨어뜨린 결과**로 모은다. 런 캐릭터만 모으면 파티 캐릭터로 떨어진
    사람의 이름을 못 찾아 다시 `미지정` 이 된다.
  */
  const characterById = await loadCharacterLabels(
    db,
    unique(
      signups.flatMap((row) => {
        const fallback =
          participantById.get(row.participant_id)?.character_id ?? null;
        const resolved = row.character_id ?? fallback;
        return resolved === null ? [] : [resolved];
      }),
    ),
  );

  for (const row of signups) {
    const participant = participantById.get(row.participant_id);
    if (participant === undefined) continue;
    const personId = participant.user_id ?? participant.guest_id;
    if (personId === null) continue;

    /*
      런에 고른 캐릭터가 우선이고, 없으면 **파티에 데려가는 캐릭터**로 떨어진다.
      DB `run_participant_names` 의 `coalesce(s.character_id, pp.character_id)` 와 같은 순서다.
    */
    const resolvedCharacterId = row.character_id ?? participant.character_id;
    const character =
      resolvedCharacterId === null
        ? undefined
        : characterById.get(resolvedCharacterId);

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
      characterId: resolvedCharacterId,
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

/*
 * ★ 여기 있던 `loadMemberCounts` 는 **없앴다** (2026-08-18 성능 작업).
 *   인원수를 세는 자리가 이제 둘뿐이고 둘 다 조회 자체에 들어 있다 —
 *   내 파티는 `members:party_participants(id)` 임베딩, 공개 파티는
 *   `v_public_party_board.member_count`. 셋째 구현이 있으면 언젠가 갈라진다.
 */

/**
 * 볼 수 있는 파티 목록.
 *
 * - 로그인 → 내가 살아 있는 파티 **∪** 공개 파티(`v_public_party_board`)
 * - 비로그인 → 공개 파티만
 *
 * 정렬은 **내 파티 먼저, 그 다음 공개 파티**다. 서버 컴포넌트가 `parties[0]` 을 기본
 * 선택으로 쓰므로, 로그인한 사람에게는 남의 공개 파티가 아니라 자기 파티가 먼저 열린다.
 */
/*
 * 내 파티 조회의 select 절.
 *
 * ⚠️ **문자열을 이어 붙이지 않는다.** supabase-js 는 select 문자열의 **리터럴 타입**을
 *    읽어 반환 타입을 만든다. `A + B` 로 만들면 리터럴성이 사라져 결과가
 *    `GenericStringError` 로 떨어지고, 타입 검사에서 곧바로 드러난다(실제로 그랬다).
 *    그래서 임베딩까지 포함한 **완성된 리터럴**을 둔다.
 */
const MY_PARTY_SELECT =
  "id,name,visibility,default_capacity,created_at,name_is_custom,owner_user_id,me:party_participants!inner(user_id),members:party_participants(id,user_id,display_name,guest_id,member_no,character:characters(character_name,is_main,character_level,character_class,image_url))";
/** `name_is_custom` 이 **없던 시절의** 컬럼 목록 (마이그레이션 22 미적용 DB). */
const MY_PARTY_SELECT_LEGACY =
  "id,name,visibility,default_capacity,created_at,owner_user_id,me:party_participants!inner(user_id),members:party_participants(id,user_id,display_name,guest_id,member_no,character:characters(character_name,is_main,character_level,character_class,image_url))";

interface MyPartyRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: Party["visibility"];
  readonly default_capacity: number;
  readonly created_at: string;
  readonly name_is_custom: boolean;
  /** ← `parties.owner_user_id`. **파티를 만든 사람.** 해체 권한의 근거다. */
  readonly owner_user_id: string;
  /** 임베딩으로 함께 세어 온 현재 인원(나간 사람 제외). 별도 집계 조회가 없다. */
  readonly member_count: number;
  /** 같은 임베딩에서 뽑은 구성원 조각(`member_no` 순). → `Party.members` */
  readonly members: readonly PartyMemberBrief[];
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
  viewerUserId: string | null,
): Promise<readonly MyPartyRow[]> {
  if (viewerUserId === null) return [];

  /*
   * ★ **왕복 3단이 1단이 됐다** (2026-08-18 성능 작업).
   *   예전에는 `party_participants → parties → 인원수 집계` 순서로 세 번 물었다. 셋은
   *   전부 같은 관계(`party_participants.party_id → parties.id`)를 따라간 것뿐이라
   *   PostgREST 임베딩 하나로 끝난다 — `loadSessionUser` 에서 이미 쓴 기법이다.
   *
   *   · `me:…!inner`  = **내가 낀 파티만** 남긴다(조인 필터). 임베딩 필터는 부모까지
   *                     거르는 `!inner` 일 때만 목록을 좁힌다.
   *   · `members:…`   = 같은 관계를 **한 번 더** 붙여 인원수를 센다. 별칭이 다르므로
   *                     `me` 의 `user_id` 필터가 이쪽에 새지 않는다(그래야 남까지 센다).
   *
   *   ⚠️ 두 임베딩의 필터는 **각자의 별칭**으로 건다. `members.left_at` 을 빼먹으면
   *      나간 사람까지 세어 인원수가 조용히 부풀고, `me.left_at` 을 빼먹으면 이미 나온
   *      파티가 내 목록에 계속 남는다.
   */
  if (partyBossFeature !== false) {
    const result = await db
      .from("parties")
      .select(MY_PARTY_SELECT)
      .eq("me.user_id", viewerUserId)
      .is("me.left_at", null)
      .is("members.left_at", null)
      .is("archived_at", null);
    if (!isUndefinedColumn(result.error)) {
      const rows = unwrap(result, "내 파티 조회");
      const mainByUser = await loadMainCharacters(db, rows);
      return await withCachedLooks(
        db,
        rows.map((row) => toMyPartyRow(mainByUser, row)),
      );
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
      .select(MY_PARTY_SELECT_LEGACY)
      .eq("me.user_id", viewerUserId)
      .is("me.left_at", null)
      .is("members.left_at", null)
      .is("archived_at", null),
    "내 파티 조회",
  );
  const mainByUser = await loadMainCharacters(db, rows);
  return await withCachedLooks(
    db,
    rows.map((row) => ({
      ...toMyPartyRow(mainByUser, row),
      name_is_custom: true,
    })),
  );
}

/** 본캐 한 명분. 캐릭터를 고르지 않은 구성원이 이것으로 칄워진다. */
interface MainCharacter {
  readonly characterName: string;
  readonly characterLevel: number | null;
  readonly characterClass: string | null;
  readonly imageUrl: string | null;
}

/**
 * 구성원들의 **본캐**를 한 번에 읽는다.
 *
 * ★ 왜 임베딩이 아니고 별도 조회인가: `party_participants.user_id → characters` 는
 *   **외래 키가 아니다**(`characters.user_id` 는 `app_users` 를 가리킨다). PostgREST 는
 *   선언된 관계만 임베딩하므로 그 길이 없고, 있었더라도 파티마다 중복으로 딸려왔을 것이다.
 * ★ **빈 목록이면 조회 자체를 건너뛰다** — 모두 캐릭터를 고른 파티에서 왜복을 늘리지
 *   않는다. 지금은 대부분 비어 있어 거의 항상 도지만, 그 사실이 바뀌면 비용도 같이 준다.
 */
async function loadMainCharacters(
  db: AdminDb,
  rows: readonly { readonly members?: readonly unknown[] | null }[],
): Promise<ReadonlyMap<string, MainCharacter>> {
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const member of Array.isArray(row.members) ? row.members : []) {
      if (typeof member !== "object" || member === null) continue;
      const record = member as Record<string, unknown>;
      // 이미 고른 캐릭터가 있으면 본캐를 물을 이유가 없다.
      if (record["character"] !== null && record["character"] !== undefined) continue;
      const userId = record["user_id"];
      if (typeof userId === "string") userIds.add(userId);
    }
  }
  if (userIds.size === 0) return new Map();

  const { data, error } = await db
    .from("characters")
    .select("user_id,character_name,character_level,character_class,image_url")
    .in("user_id", [...userIds])
    .eq("is_main", true);
  if (error !== null) {
    // 보조 정보다. 못 읽었다고 파티 목록을 실패시킬 이유가 없다.
    console.warn(`[schedule-repo] 본캐 조회 실패: ${error.message}`);
    return new Map();
  }

  const map = new Map<string, MainCharacter>();
  for (const row of data ?? []) {
    if (row.user_id === null || row.character_name === null) continue;
    map.set(row.user_id, {
      characterName: row.character_name,
      characterLevel: row.character_level,
      characterClass: row.character_class,
      imageUrl: row.image_url,
    });
  }
  return map;
}

/**
 * 임베딩 결과 → `MyPartyRow`. **인원수는 `members` 배열의 길이**다 — 별도 집계 조회가
 * 사라진 자리다. `me` 는 목록을 좁히는 데만 쓰고 값은 버린다.
 */
function toMyPartyRow(
  mainByUser: ReadonlyMap<string, MainCharacter>,
  row: {
  readonly id: string;
  readonly name: string;
  readonly visibility: Party["visibility"];
  readonly default_capacity: number;
  readonly created_at: string;
  readonly name_is_custom?: boolean;
  readonly owner_user_id?: string | null;
  readonly members?: readonly unknown[] | null;
  },
): MyPartyRow {
  const members = Array.isArray(row.members) ? row.members : [];
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    default_capacity: row.default_capacity,
    created_at: row.created_at,
    name_is_custom: row.name_is_custom ?? true,
    /*
      빈 문자열로 접는다 — 어느 사용자 id 와도 같지 않으므로 **"소유자 아님"** 이 된다.
      해체 버튼이 안 보이는 쪽으로 기우는 것이 맞다. 반대로 기울면 눌러 봐야 403 이다.
    */
    owner_user_id: row.owner_user_id ?? "",
    member_count: members.length,
    members: memberBriefsOf(members, mainByUser),
  };
}

/**
 * 임베딩으로 딸려 온 구성원 행 → **미리보기 조각**(`member_no` 순).
 *
 * ★ **여기서 문자열로 합치지 않는다**(2026-09-02). 예전에는 `participantLabel` 로
 *   `더저(무르겨르)` 한 줄을 만들어 보냈는데, 그 규칙은 본캐로 참여하면 괄호를 붙이지
 *   않으므로 **절반의 사람은 캐릭터가 화면에 안 나왔다.** 발주자가 원한 것은 그 반대다
 *   (*"캐릭터 실제로 보여주고싶은데"*). 어떻게 보일지는 화면마다 다르므로 재료만 준다.
 *   ⚠️ 그래도 `participantLabel` 은 여전히 **한 줄이 필요한 자리**의 주인이다(겹쳐보기
 *      좌측 · 런 참가자 목록 · 카톡). 이 함수는 그 규칙을 대체하지 않는다.
 * ★ 모양이 어긋난 행은 **조용히 건너뛴다.** 이 값은 목록의 보조 설명이라, 못 읽었다고
 *   파티 목록 전체를 실패시킬 이유가 없다 — 빠지면 예전처럼 파티 이름만 보인다.
 */
function memberBriefsOf(
  rows: readonly unknown[],
  mainByUser: ReadonlyMap<string, MainCharacter>,
): readonly PartyMemberBrief[] {
  return rows
    .flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const record = row as Record<string, unknown>;
      const displayName = record["display_name"];
      if (typeof displayName !== "string" || displayName === "") return [];

      const embedded = record["character"];
      const character =
        typeof embedded === "object" && embedded !== null
          ? (embedded as Record<string, unknown>)
          : null;
      const memberNo = record["member_no"];

      /*
        ── 캐릭터를 안 고른 사람은 **본캐로 채운다** (2026-09-02) ─────────────
        발주자: *"내 캐릭터만 보여주는게 아니라 파티원 캐릭터까지 보여줘야하는데"*.
        `party_participants.character_id` 는 대부분 비어 있다 — 본인만 고를 수 있는 값이라
        남들은 손댄 적이 없다. 그때 그 사람이 들고 가는 것은 **본캐**이고, 본캐 행에는
        레벨·직업·초상화가 이미 있다. 이름만 덩그러니 두면 파티원 절반이 실루엣이 된다.
        ⚠️ 이름은 `displayName` 을 그대로 둔다 — 정식 사용자의 표시명이 곧 본캐 닉네임이라
           (§2.1) 본캐 이름으로 덮어써 봐야 같은 글자이고, 다르면 그건 표시명 쪽이 옳다.
      */
      const userId = record["user_id"];
      const fallback =
        character === null && typeof userId === "string"
          ? (mainByUser.get(userId) ?? null)
          : null;

      const characterName = character?.["character_name"];
      const characterLevel = character?.["character_level"];
      const characterClass = character?.["character_class"];
      const characterImageUrl = character?.["image_url"];

      return [
        {
          // 번호를 못 읽으면 맨 뒤로. 순서가 흔들려도 이름이 사라지는 것보다는 낫다.
          memberNo:
            typeof memberNo === "number" ? memberNo : Number.MAX_SAFE_INTEGER,
          brief: {
            displayName,
            characterName:
              typeof characterName === "string"
                ? characterName
                : (fallback?.characterName ?? null),
            characterLevel:
              typeof characterLevel === "number"
                ? characterLevel
                : (fallback?.characterLevel ?? null),
            characterClass:
              typeof characterClass === "string"
                ? characterClass
                : (fallback?.characterClass ?? null),
            characterImageUrl:
              typeof characterImageUrl === "string" && characterImageUrl !== ""
                ? characterImageUrl
                : (fallback?.imageUrl ?? null),
            isGuest:
              record["guest_id"] !== null && record["guest_id"] !== undefined,
          } satisfies PartyMemberBrief,
        },
      ];
    })
    .sort((a, b) => a.memberNo - b.memberNo)
    .map((member) => member.brief);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 게스트 얼굴 — **이름으로 찾아 둔 캐시(`character_looks`)로 마지막 자리를 메운다**
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 발주(2026-09-03): *"내 api 로 파티원들의 이미지를 가져오는식으로"*.
 *
 * `memberBriefsOf` 를 지나고도 초상화가 `null` 로 남는 사람이 있다 — `characters` 행이
 * 아예 없는 **게스트**다. 그 사람에게는 ocid 가 없어 기존 초상화 경로
 * (`portrait-backfill`)가 절대 닿지 못하고, 그래서 파티 고르기 화면에서 계속 실루엣이었다.
 * `character_looks` 는 이름만으로 받아 둔 그 사람들의 생김새이고, 이 함수가 그것을 읽는
 * **유일한 자리**다.
 *
 * ★★ **여기서 넥슨을 부르지 않는다.** 이름 하나에 2콜 + 같은 키 250ms 간격이라
 *    (`features/characters/server/name-portrait-lookup.ts`), 서버 렌더 도중에 부르면
 *    파티 목록을 여는 데 초 단위가 걸린다. 이 자리는 **DB 한 번**이고, 캐시에 없으면
 *    그냥 실루엣이다. 채우는 일은 사용자가 모달을 열 때 클라이언트가
 *    `POST /api/characters/looks` 를 한 번 부르고 파티 쿼리를 무효화하는 쪽이 진다
 *    (§2.4 규칙 1 — 화면 데이터의 주인은 쿼리 캐시).
 *
 * ★★ **우선순위: `characters` 임베딩 → 본캐 폴백 → 그다음에야 캐시.**
 *    캐시는 **아무도 답을 못 준 자리만** 메운다. 앞의 둘은 "이 사람이 이 파티에 실제로
 *    데려가는 캐릭터"라는 우리 쪽 사실이고, 캐시는 "그 이름으로 검색하면 이렇게 생겼다"는
 *    추정이다. 순서를 뒤집으면 부캐로 참여한 사람의 얼굴이 본캐 얼굴로 덮인다.
 *    그래서 판정 기준은 `characterImageUrl === null` 하나다 — 앞의 둘 중 하나라도
 *    답했으면 그 값이 이미 들어와 있다.
 */
interface CachedLook {
  readonly characterLevel: number | null;
  readonly characterClass: string | null;
  readonly imageUrl: string | null;
}

/** `character_looks.character_name` 의 CHECK 와 같은 값. 넘는 이름은 물어봐야 없다. */
const LOOK_NAME_MAX_LENGTH = 40;

/**
 * 이 구성원을 캐시에서 찾을 때 쓰는 이름.
 *
 * `characterName ?? displayName` 이다 — 정식 사용자의 표시명은 곧 본캐 닉네임이고
 * (§2.1, `PartyMemberBrief.characterName` 주석), 게스트는 표시명이 곧 적어 넣은
 * 캐릭터명이다. 앞뒤 공백은 DB 쪽 `btrim` CHECK 와 맞추려고 여기서 턴다.
 */
function lookKeyOf(member: PartyMemberBrief): string | null {
  const raw = (member.characterName ?? member.displayName).trim();
  if (raw === "" || raw.length > LOOK_NAME_MAX_LENGTH) return null;
  return raw;
}

/**
 * 이름 묶음 → 생김새 캐시. **실패는 전부 "채울 게 없다"로 접는다.**
 *
 * ⚠️ 마이그레이션 `20260903120000_character_look_cache.sql` 이 아직 안 들어간 DB 에서는
 *    이 표가 없어 PostgREST 가 `42P01` / `PGRST205` 를 준다. 그때 던지면 **파티 목록
 *    전체가 실패한다** — 있으면 좋은 얼굴 하나 때문에 화면을 못 그리는 것은 명백히 손해다.
 *    권한·네트워크 등 다른 실패도 결론이 같으므로 원인을 가르지 않고 한 번에 접는다.
 */
async function readLookCache(
  db: AdminDb,
  names: readonly string[],
): Promise<ReadonlyMap<string, CachedLook>> {
  const byName = new Map<string, CachedLook>();
  if (names.length === 0) return byName;

  try {
    const { data, error } = await db
      .from("character_looks")
      .select("character_name,character_level,character_class,image_url")
      .in("character_name", [...names]);
    if (error !== null) {
      if (!isMissingRelation(error)) {
        console.warn(`[schedule-repo] 생김새 캐시 조회 실패: ${error.message}`);
      }
      return byName;
    }
    for (const row of data ?? []) {
      byName.set(row.character_name, {
        characterLevel: row.character_level,
        characterClass: row.character_class,
        imageUrl: row.image_url,
      });
    }
  } catch (caught) {
    console.warn(
      `[schedule-repo] 생김새 캐시 조회 건너뜀: ${
        caught instanceof Error ? caught.message : String(caught)
      }`,
    );
  }
  return byName;
}

/**
 * 파티 행들의 구성원 중 **초상화가 비어 있는 사람만** 캐시로 메운다.
 *
 * 조회는 이름을 전부 모아 `.in(...)` **한 번**이다. 파티마다 부르면 목록 하나를 그리는 데
 * 왕복이 파티 수만큼 늘어난다 — `loadMainCharacters` 가 이미 같은 이유로 한 번에 읽는다.
 */
async function withCachedLooks<T extends { readonly members: readonly PartyMemberBrief[] }>(
  db: AdminDb,
  rows: readonly T[],
): Promise<readonly T[]> {
  const wanted = new Set<string>();
  for (const row of rows) {
    for (const member of row.members) {
      if (member.characterImageUrl !== null) continue;
      const key = lookKeyOf(member);
      if (key !== null) wanted.add(key);
    }
  }
  if (wanted.size === 0) return rows;

  const looks = await readLookCache(db, [...wanted]);
  if (looks.size === 0) return rows;

  return rows.map((row) => ({
    ...row,
    members: row.members.map((member) => {
      // 이미 답이 있는 사람은 손대지 않는다 — 위 우선순위 주석 그대로다.
      if (member.characterImageUrl !== null) return member;
      const key = lookKeyOf(member);
      const look = key === null ? undefined : looks.get(key);
      if (look === undefined) return member;
      return {
        ...member,
        // 이름은 덮지 않는다. 표시명이 곧 캐릭터명이라 같은 글자이고, 다르면 표시명이 옳다.
        characterLevel: member.characterLevel ?? look.characterLevel,
        characterClass: member.characterClass ?? look.characterClass,
        // `null` 이면 넥슨도 못 찾은 이름이다 — 오류가 아니라 실루엣이다(§2.1.1).
        characterImageUrl: look.imageUrl,
      } satisfies PartyMemberBrief;
    }),
  }));
}

export async function fetchParties(
  viewerUserId: string | null,
): Promise<readonly Party[]> {
  const db = getAdminDb();

  /*
   * ★ **직렬 3단 → 1단** (2026-08-18 성능 작업).
   *   예전: `내 파티 id → 파티 행 → 인원수 집계`. 뒤 둘은 앞의 결과를 **필터로만** 썼고
   *   전부 같은 관계를 따라간 것이라, PostgREST 임베딩 하나로 합쳐진다(위 참조).
   *   공개 파티 쪽 인원수는 `v_public_party_board.member_count` 가 이미 세어 준다 —
   *   그 값을 두고 다시 집계하던 것이 세 번째 왕복이었다.
   */
  const [mineRows, publicRows] = await Promise.all([
    loadMyPartyRows(db, viewerUserId),
    (async () =>
      unwrap(
        await db
          .from("v_public_party_board")
          .select("id,name,default_capacity,member_count,created_at"),
        "공개 파티 목록 조회",
      ))(),
  ]);

  const mineIdSet = new Set(mineRows.map((row) => row.id));

  const mine = mineRows
    .map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      party: {
        partyId: row.id,
        name: row.name,
        visibility: row.visibility,
        defaultCapacity: row.default_capacity,
        memberCount: row.member_count,
        members: row.members,
        nameIsCustom: row.name_is_custom,
        isOwner: row.owner_user_id === viewerUserId,
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
        /*
          뷰가 `count(...) filter (where left_at is null)` 로 이미 센 값이다. 예전에는
          이 값을 두고도 `party_participants` 를 한 번 더 집계했다 — 같은 숫자를 위한
          왕복이었고, 두 곳에서 세면 언젠가 서로 다른 말을 한다.
        */
        memberCount: row.member_count ?? 0,
        /*
          남의 공개 파티는 편집 대상이 아니다. `true` 로 두어 **그 이름에 손대지 않는다**는
          뜻을 타입으로도 남긴다(공개 게시판 뷰에는 이 컬럼이 아예 없다).
        */
        nameIsCustom: true,
        /*
          ★ **공개 파티는 구성원 이름을 싣지 않는다.** 공개 게시판 뷰가 인원수만 내주고,
            이름을 보태자고 그 공개면을 넓힐 이유가 없다 — 드롭다운에서 헷갈리는 것은
            내가 낀 파티들이고(비슷한 보스 줄임말 제목), 그건 위 갈래가 이미 해결한다.
        */
        members: [],
        /*
          이 목록은 **내가 안 낀 공개 파티**만 담는다(위 filter). 남의 파티를 해체할 수는
          없으므로 언제나 false 다 — 뷰에 `owner_user_id` 가 없어서가 아니라 뜻이 그렇다.
        */
        isOwner: false,
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

  /*
    ★ 열람 검사와 본문 조회를 **동시에** 띄운다 (2026-08-18 성능 작업).
      검사가 거절하면 `Promise.all` 이 그대로 거절하므로 **한 바이트도 밖으로 나가지
      않는다** — 결과는 버려진다. 직렬로 두면 볼 수 있는 사람에게도 왕복 한 단계를
      더 기다리게 하는데, 원격 Supabase 왕복 1회가 ≈78ms 다.

    ★ **참여 캐릭터를 임베딩으로 함께 읽는다** — 예전에는 구성원을 받은 뒤
      `loadCharacterLabels` 로 한 단계 더 나갔다. 이 함수의 결과(`personIds`)가
      겹쳐보기 조회의 입력이라 **여기서 늦어지는 만큼 화면 전체가 늦어진다.**
      `character_id` 는 `on delete set null` 이라 임베딩이 `null` 인 것이 정상이다.
  */
  const [, rows] = await Promise.all([
    assertPartyVisible(db, viewerUserId, partyId),
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select(
            "id,user_id,guest_id,display_name,member_no,character_id,characters(character_name,is_main)",
          )
          .eq("party_id", partyId)
          .is("left_at", null)
          .order("member_no", { ascending: true }),
        "파티 구성원 조회",
      ))(),
  ]);

  const members: PartyMember[] = [];
  for (const row of rows) {
    // CHECK `num_nonnulls(user_id, guest_id) = 1` 이 보장하지만, 방어적으로 건너뛴다.
    const personId = row.user_id ?? row.guest_id;
    if (personId === null) continue;
    const character = row.characters;
    members.push({
      personId,
      participantId: row.id,
      displayName: row.display_name,
      isGuest: row.user_id === null,
      seatNo: row.member_no,
      characterId: row.character_id,
      characterName: character?.character_name ?? null,
      isMainCharacter: character?.is_main ?? false,
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
 * → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count[, p_exclude_run_id])`
 *
 * ⚠️ **화면이 겹침을 따로 계산하지 않는다.** 카톡 봇도 같은 함수를 부르므로 두 곳에서
 *    계산하면 반드시 답이 갈라진다.
 *
 * ★ 2026-08-18 부터 이 함수의 답에서는 **이미 등록된 런이 잡아먹은 시간이 빠져 있다**
 *   (`20260818130000_availability_minus_runs.sql`). 한 사람이 같은 시각에 보스 둘을 도는
 *   일정은 성립하지 않는다는 발주 요구다. 개인 레인의 막대는 여전히 전체를 그리고,
 *   점유 구간은 `fetchPersonRunCommitments` 가 따로 실어 화면이 **"이미 일정 있음"** 으로
 *   구분해 보여 준다 — 조용히 줄어들면 "왜 안 되지?" 만 남는다.
 *
 * ★ `excludeRunId` = **수정 중인 런 하나를 점유에서 뺀다.** 없으면 그 런 자신의 점유가
 *   후보 시간대를 통째로 지워 시각을 한 칸도 옮길 수 없다.
 *
 * ⚠️ 마이그레이션 미적용 DB 에는 5인자 오버로드가 없다. 그래서 `excludeRunId` 가 없으면
 *    **인자를 아예 싣지 않고**(옛 4인자와 호환), 실었는데 함수가 없다고 하면 한 번 더
 *    빼고 재시도한다. 기능만 빠지고 화면은 살아 있는 쪽을 고른다.
 */
export async function fetchAvailabilityOverlap(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
  excludeRunId: RunId | null = null,
): Promise<readonly OverlapWindow[]> {
  const db = getAdminDb();
  const allowed = await visiblePersonIds(db, viewerUserId, personIds);
  if (allowed.length === 0) return [];

  const base = {
    p_person_ids: allowed,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_min_count: Math.max(1, Math.trunc(minCount)),
  };

  let result = await db.rpc(
    "availability_overlap",
    excludeRunId === null ? base : { ...base, p_exclude_run_id: excludeRunId },
  );

  if (result.error !== null && excludeRunId !== null && isMissingFunction(result.error)) {
    console.warn(
      "[schedule-repo] availability_overlap 에 p_exclude_run_id 가 없습니다. " +
        "20260818130000_availability_minus_runs.sql 미적용으로 보고 제외 없이 다시 조회합니다.",
    );
    result = await db.rpc("availability_overlap", base);
  }

  const rows = unwrap(result, "가용시간 겹침 조회");

  return rows.map(
    (row): OverlapWindow => ({
      startsAt: new Date(row.window_start),
      endsAt: new Date(row.window_end),
      availableCount: row.available_count,
      personIds: row.person_ids ?? [],
    }),
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이미 등록된 일정이 잡아먹은 시간 → `public.person_run_commitments(...)`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 원문(2026-08-18): *"일정을 등록하면 그 일정도 가능 시간에 반영이 되어야지
 * 당연히 보스를 두개 동시에 할수있는건아니잖음"*.
 *
 * ★ **판정은 전부 DB 함수가 한다.** `going` 신청만 세고 취소·시각미정 런은 세지 않는다는
 *   규칙을 여기서 다시 적으면 카톡 봇(`availability_overlap` 을 직접 부른다)과 답이 갈린다.
 * ★ 열람 권한은 다른 가용시간 조회와 **같은 관문**(`visiblePersonIds`)을 지난다. 남의
 *   일정 점유도 결국 그 사람의 생활 정보다.
 *
 * ⚠️ **마이그레이션 미적용은 오류가 아니다.** `20260818130000_availability_minus_runs.sql`
 *    이 아직 안 들어간 DB 에서는 함수가 없어 PostgREST 가 `PGRST202` 를 준다. 그때는
 *    빈 배열을 돌려주고 한 번만 경고한다 — 그 상태의 화면은 이 기능만 빠진 **예전 그대로**의
 *    겹쳐보기이고, 죽는 것보다 낫다(`hasPartyBossFeature` 와 같은 기조).
 */
let runCommitmentFeature: boolean | null = null;

export async function fetchPersonRunCommitments(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
  excludeRunId: RunId | null = null,
): Promise<readonly RunCommitment[]> {
  if (runCommitmentFeature === false) return [];

  const db = getAdminDb();
  const allowed = await visiblePersonIds(db, viewerUserId, personIds);
  if (allowed.length === 0) return [];

  const result = await db.rpc("person_run_commitments", {
    p_person_ids: allowed,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_exclude_run_id: excludeRunId,
  });

  if (result.error !== null) {
    if (isMissingFunction(result.error)) {
      runCommitmentFeature = false;
      console.warn(
        "[schedule-repo] person_run_commitments 함수가 없습니다. " +
          "20260818130000_availability_minus_runs.sql 미적용으로 보고 " +
          "\"이미 일정 있음\" 표시를 비활성화합니다(겹침 계산은 예전과 같습니다).",
      );
      return [];
    }
    console.error(
      `[schedule-repo] 등록된 일정 점유 조회 실패: ${result.error.message}`,
    );
    throw ApiError.internal();
  }

  runCommitmentFeature = true;
  return (result.data ?? []).map(
    (row): RunCommitment => ({
      personId: row.person_id,
      runId: row.run_id,
      partyId: row.party_id,
      bossDifficultyId: row.boss_difficulty_id,
      shortName: row.short_name,
      startsAt: new Date(row.starts_at),
      endsAt: new Date(row.ends_at),
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
// 겹쳐보기 **한 벌** — 왕복 하나로 (마이그레이션 24)
// ─────────────────────────────────────────────────────────────────────────────
//
// 위 네 함수는 **같은 사람 집합 · 같은 시간 구간**을 받는다. 병렬로 띄워도 왕복 깊이는
// 2단(열람 판정 → 본문)이고, 요청 개수는 `4 × (사람수 + 1)` 이다. 6인 파티면 28건.
// 원격 Supabase 왕복 1회 ≈ 78ms 이므로 이건 화면 전환 시간의 가장 큰 덩어리였다.
//
// ⚠️ **계산은 한 줄도 옮겨 오지 않았다** (§1.4). `public.availability_board()` 는
//    `resolve_availability` · `availability_overlap` · `person_run_commitments` ·
//    `can_view_availability` 를 **그대로 호출**해 결과를 한 jsonb 로 싣는 묶음 함수다.
//    위 네 함수는 시그니처도 의미도 그대로 남아 있고, 카톡 봇과
//    `/api/schedule/availability?kind=…` 는 계속 그것들을 쓴다.

/** `public.availability_board()` 한 번이 주는 것 — 화면 한 벌. */
export interface AvailabilityBoard {
  /** 개인 레인(패턴 − 예외). `resolve_availability` */
  readonly intervals: readonly AvailabilityInterval[];
  /** 겹침 창(패턴 − 예외 − 런 점유). `availability_overlap` */
  readonly overlap: readonly OverlapWindow[];
  /** 제외 자국 원본. `availability_exceptions` */
  readonly exceptions: readonly AvailabilityException[];
  /** "이미 일정 있음" 블록. `person_run_commitments` */
  readonly commitments: readonly RunCommitment[];
  /**
   * 이 구간에 **가능 시간이 하나도 없는** 사람들 (2026-08-19 발주자: *"파티원이 게스트
   * 혹은 시간설정을 아예 안했다면 그냥 내 시간을 겹침으로 표시하게"*).
   *
   * 겹침의 분모에서 빠진 사람이며, 화면은 **이름을 밝혀야 한다** — 숫자만 줄이면
   * `전원 3명` 이 실제로는 5명 중 3명이라는 사실이 사라진다.
   */
  readonly unscheduledPersonIds: readonly PersonId[];
}

const EMPTY_BOARD: AvailabilityBoard = {
  intervals: [],
  overlap: [],
  exceptions: [],
  commitments: [],
  unscheduledPersonIds: [],
};

/**
 * 묶음 함수가 있는 DB 인가. `runCommitmentFeature` 와 같은 기조로 **한 번만 확인**하고
 * 없으면 옛 4종 호출로 되돌아간다 — 마이그레이션 24 미적용은 오류가 아니다.
 */
let availabilityBoardFeature: boolean | null = null;

/** jsonb 는 `Json` 타입으로 온다. 배열이 아니면 빈 배열로 본다(모양이 깨져도 화면은 산다). */
function boardRows(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object",
  );
}

function boardText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function boardDate(row: Record<string, unknown>, key: string): Date {
  // `to_jsonb(timestamptz)` 는 오프셋이 붙은 ISO 문자열이라 세션 타임존과 무관하게 옳다.
  return new Date(boardText(row, key) ?? "");
}

/**
 * 겹쳐보기 화면 한 벌을 **왕복 한 번**에.
 *
 * ★ 사람이 0명이거나 열람자가 없으면 **왕복이 아예 없다.** 예전에는 그 경우에도 네 함수가
 *   각각 `visiblePersonIds` 를 돌려 빈 배열을 확인했다 — 비로그인 `/schedule` 이 아무것도
 *   못 보면서 왕복만 쓰던 자리다 (`can_view_availability` 는 열람자 없이 무조건 false).
 *
 * ⚠️ **마이그레이션 24 미적용은 오류가 아니다.** PostgREST 가 `PGRST202` 를 주면 한 번만
 *    경고하고 **옛 4종 호출로 되돌아간다.** 그 상태의 화면은 왕복이 예전만큼 나갈 뿐
 *    결과가 완전히 같다 — 묶음 함수가 하는 일이 "묶기"뿐이기 때문이다.
 */
export async function fetchAvailabilityBoard(
  viewerUserId: string | null,
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
  excludeRunId: RunId | null = null,
): Promise<AvailabilityBoard> {
  if (viewerUserId === null || personIds.length === 0) return EMPTY_BOARD;

  if (availabilityBoardFeature !== false) {
    const db = getAdminDb();
    const result = await db.rpc("availability_board", {
      p_viewer_user_id: viewerUserId,
      p_person_ids: unique(personIds),
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
      p_min_count: Math.max(1, Math.trunc(minCount)),
      p_exclude_run_id: excludeRunId,
    });

    if (result.error === null) {
      availabilityBoardFeature = true;
      return withUnscheduled(
        parseBoard(result.data),
        viewerUserId,
        personIds,
        range,
        minCount,
        excludeRunId,
      );
    }

    if (!isMissingFunction(result.error)) {
      console.error(
        `[schedule-repo] 겹쳐보기 묶음 조회 실패: ${result.error.message}`,
      );
      throw ApiError.internal();
    }

    availabilityBoardFeature = false;
    console.warn(
      "[schedule-repo] availability_board 함수가 없습니다. " +
        "20260818140000_availability_board.sql 미적용으로 보고 " +
        "예전처럼 네 조회를 따로 부릅니다(결과는 완전히 같고 왕복만 늘어납니다).",
    );
  }

  const [intervals, overlap, exceptions, commitments] = await Promise.all([
    fetchAvailability(viewerUserId, personIds, range),
    fetchAvailabilityOverlap(viewerUserId, personIds, range, minCount, excludeRunId),
    fetchAvailabilityExceptions(viewerUserId, personIds, range),
    fetchPersonRunCommitments(viewerUserId, personIds, range, excludeRunId),
  ]);
  // 폴백 경로도 **같은 규칙**을 지난다 — 두 경로가 다른 겹침을 내면 안 된다.
  return withUnscheduled(
    { intervals, overlap, exceptions, commitments, unscheduledPersonIds: [] },
    viewerUserId,
    personIds,
    range,
    minCount,
    excludeRunId,
  );
}

/**
 * jsonb → 도메인. **예외 행은 `toAvailabilityException` 을 그대로 통과시킨다** — 하루 전체
 * 제외(`0~1440` → `null/null`)의 되돌림이 조회·등록·묶음에서 갈리면 등록 직후 화면과
 * 새로고침 뒤 화면이 달라진다.
 */
function parseBoard(data: unknown): AvailabilityBoard {
  const exceptions: AvailabilityException[] = [];
  for (const row of boardRows(data, "exceptions")) {
    const start = row.start_minute;
    const end = row.end_minute;
    if (typeof start !== "number" || typeof end !== "number") continue;
    const id = boardText(row, "id");
    if (id === null) continue;
    const exception = toAvailabilityException({
      id,
      user_id: boardText(row, "user_id"),
      guest_id: boardText(row, "guest_id"),
      exception_date: boardText(row, "exception_date") ?? "",
      start_minute: start,
      end_minute: end,
      note: boardText(row, "note"),
    });
    if (exception !== null) exceptions.push(exception);
  }

  return {
    intervals: boardRows(data, "intervals").flatMap((row) => {
      const personId = boardText(row, "person_id");
      if (personId === null) return [];
      return [
        {
          personId,
          startsAt: boardDate(row, "starts_at"),
          endsAt: boardDate(row, "ends_at"),
          // 원천 함수에 `note` 컬럼이 없다 — `fetchAvailability` 와 같은 이유다.
          note: null,
        } satisfies AvailabilityInterval,
      ];
    }),
    overlap: boardRows(data, "overlap").flatMap((row) => {
      const count = row.available_count;
      if (typeof count !== "number") return [];
      const ids = row.person_ids;
      return [
        {
          startsAt: boardDate(row, "window_start"),
          endsAt: boardDate(row, "window_end"),
          availableCount: count,
          personIds: Array.isArray(ids)
            ? ids.filter((id): id is string => typeof id === "string")
            : [],
        } satisfies OverlapWindow,
      ];
    }),
    exceptions,
    commitments: boardRows(data, "commitments").flatMap((row) => {
      const personId = boardText(row, "person_id");
      const runId = boardText(row, "run_id");
      const partyId = boardText(row, "party_id");
      const bossDifficultyId = boardText(row, "boss_difficulty_id");
      if (
        personId === null ||
        runId === null ||
        partyId === null ||
        bossDifficultyId === null
      ) {
        return [];
      }
      return [
        {
          personId,
          runId,
          partyId,
          bossDifficultyId,
          shortName: boardText(row, "short_name") ?? bossDifficultyId,
          startsAt: boardDate(row, "starts_at"),
          endsAt: boardDate(row, "ends_at"),
        } satisfies RunCommitment,
      ];
    }),
    /*
      묶음 함수는 이 값을 모른다 — 구간을 보고 **호출부가** 채운다
      (`withUnscheduled`). 여기서 빈 배열을 두는 것은 자리를 만들어 두기 위해서다.
    */
    unscheduledPersonIds: [],
  };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 시간을 등록하지 않은 사람을 겹침 분모에서 뺀다 (2026-08-19 발주자)
 * ═════════════════════════════════════════════════════════════════════════════
 * *"파티원이 게스트 혹은 시간설정을 아예 안했다면 그냥 내 시간을 겹침으로 표시하게
 * 변경하고"*
 *
 * 그전에는 `전원` 이 곧 구성원 수였다. 게스트 한 명만 끼어도 "전원이 되는 시간"이 영원히
 * 없어 **겹침이 통째로 비었고**, 화면이 아무 도움도 못 줬다.
 *
 * ★ **분모가 실제로 불가능할 때만** 낮춘다(`minCount > 등록한 사람 수`). 사용자가 직접
 *   고른 `k명 이상` 이 만족 가능한 값이면 그대로 둔다 — 요청을 조용히 바꾸지 않는다.
 * ★ 겹침만 다시 부른다. 개인 레인·예외·점유는 분모와 무관해 그대로 쓴다(왕복 1회 추가,
 *   그것도 실제로 빠진 사람이 있을 때만).
 *
 * ⚠️ 이것은 §1.4 의 "거짓 가능보다 거짓 불가능이 낫다"와 **의도적으로 어긋난다.** 시간을
 *    안 적은 사람이 그 시각에 되는지 우리는 모르는데 빼고 그린다. 그래서 누구를 뺐는지
 *    `unscheduledPersonIds` 로 올려 보내고 **화면이 이름으로 밝힌다.**
 */
async function withUnscheduled(
  board: AvailabilityBoard,
  viewerUserId: string,
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
  excludeRunId: RunId | null,
): Promise<AvailabilityBoard> {
  const withIntervals = new Set(board.intervals.map((item) => item.personId));
  const unscheduledPersonIds = unique(personIds).filter(
    (id) => !withIntervals.has(id),
  );
  if (unscheduledPersonIds.length === 0) return board;

  const scheduledCount = unique(personIds).length - unscheduledPersonIds.length;
  const nextMinCount = Math.max(scheduledCount, 1);
  if (nextMinCount >= minCount) return { ...board, unscheduledPersonIds };

  const overlap = await fetchAvailabilityOverlap(
    viewerUserId,
    personIds,
    range,
    nextMinCount,
    excludeRunId,
  );
  return { ...board, overlap, unscheduledPersonIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가용 시간 **쓰기** — 언제나 세션 본인 것만
// ─────────────────────────────────────────────────────────────────────────────
//
// 읽기 함수가 `viewerUserId: string | null` 을 받는 것과 달리, 쓰기 함수는 `userId: string`
// 을 받는다. **"누구의 가용시간을 쓸 것인가"를 받는 자리가 없다** — 대상은 언제나 호출자
// 본인이고, 받지 않는 값은 위조될 수 없다. 게스트(초대 링크) 쪽 쓰기는 세션이라는 근거가
// 없으므로 이 경로로 들어오지 않는다.

const PATTERN_COLUMNS =
  "id,user_id,guest_id,weekday,cycle_day,start_minute,end_minute,note";

interface PatternRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly guest_id: string | null;
  readonly weekday: number | null;
  readonly cycle_day: number | null;
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
    /*
      DB CHECK(`availability_patterns_one_axis`)가 **둘 중 정확히 하나**를 보장한다.
      요일축은 1~7 이라 경계에서 한 번만 좁힌다.
    */
    weekday: row.weekday === null ? null : (row.weekday as IsoWeekday),
    cycleDay: row.cycle_day,
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
      // 축이 섞여 있어도 정렬은 하나면 된다 — 한 사람의 유효 축은 언제나 하나뿐이고,
      // 쓰지 않는 축의 행은 화면이 걸러 낸다(`nullsFirst` 로 순서를 고정해 둔다).
      .order("weekday", { ascending: true, nullsFirst: true })
      .order("cycle_day", { ascending: true, nullsFirst: true })
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
  /**
   * ★ **교체 범위는 저장하는 축 하나뿐이다** (2026-08-20 · 교대 근무).
   *   한 사람이 요일 행과 주기 행을 동시에 가질 수 있고(주기를 켜도 요일 행은 지우지
   *   않는다 — 되돌릴 수 있어야 한다), 여기서 전부 지우면 격자 한 번 저장에 반대쪽 축이
   *   통째로 증발한다. 지우는 것은 지금 그리고 있는 축뿐이다.
   */
  axis: "weekday" | "cycle" = "weekday",
): Promise<readonly AvailabilityPattern[]> {
  const db = getAdminDb();

  const deleteQuery = db
    .from("availability_patterns")
    .delete()
    .eq("user_id", userId);

  const { error: deleteError } = await (axis === "weekday"
    ? deleteQuery.is("cycle_day", null)
    : deleteQuery.not("cycle_day", "is", null));
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
            cycle_day: pattern.cycleDay,
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
 * 그 날짜에 이미 등록된 내 제외가 있는가.
 *
 * 방에서 `!제외 0820` 을 두 번 치면 같은 뜻의 행이 둘 쌓인다. `resolve_availability` 는
 * multirange 뺄셈이라 결과가 달라지지는 않지만, 사용자가 나중에 하나만 지우고 "왜 아직
 * 제외지"가 된다. 그래서 **만들기 전에 확인**한다.
 */
export async function findMyAvailabilityExceptionsOn(
  userId: string,
  dayKey: string,
): Promise<readonly AvailabilityException[]> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("availability_exceptions")
      .select(EXCEPTION_COLUMNS)
      .eq("user_id", userId)
      .eq("exception_date", dayKey),
    "특이사항 조회",
  );
  return rows.flatMap((row) => {
    const parsed = toAvailabilityException(row);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * 그 날짜의 **내** 제외를 전부 지운다. 방에서 `!제외해제 0820` 이 쓴다.
 *
 * ★ id 가 아니라 날짜로 지우는 이유: 방에서는 id 를 알 길이 없다. `user_id` 조건이
 *   소유 확인 그 자체인 것은 id 삭제와 같다 — 남의 행은 조건에 걸리지 않는다.
 * ★ 지운 건수를 돌려준다. 0 이면 "원래 없었다"이고, 그 사실을 방에 말해 줘야 사용자가
 *   날짜를 잘못 쳤는지 알 수 있다.
 */
export async function deleteMyAvailabilityExceptionsOn(
  userId: string,
  dayKey: string,
): Promise<number> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("availability_exceptions")
      .delete()
      .eq("user_id", userId)
      .eq("exception_date", dayKey)
      .select("id"),
    "특이사항 삭제",
  );
  return rows.length;
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

// ────────────────────────────────────────────────────────────────────────────
// 교대 근무 — 주기(A) · 프리셋과 배정(B)
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주자(2026-08-20): *"2교대 3교대 하는사람도 등록할수있게"*.
// 교대는 요일이 아니라 **N일 주기**로 돌고(주주야야비비 6일 · 4조 3교대 8일), 근무표가
// 불규칙한 사람은 주기로도 못 적는다. 그래서 둘 다 둔다 — 주기 패턴과 달력 배정.
//
// ★ 계산은 전부 DB(resolve_availability)가 한다. 여기서는 **원본 의도만 저장**한다.
//   근무시간을 예외 행으로 풀어 저장하지 않는 이유는 마이그레이션 33 에 적어 두었다:
//   같은 사실이 두 곳에 저장되면 반드시 갈라진다.

/** 시간대 묶음 개수 상한. 3교대에 비번을 더해도 4개면 끝나고, 그 이상은 달력이 못 읽힌다. */
export const MAX_SHIFT_PRESETS = 8;

export async function fetchMyAvailabilityCycle(
  userId: string,
): Promise<AvailabilityCycle | null> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("availability_cycles")
      .select("cycle_days,anchor_date")
      .eq("user_id", userId)
      .limit(1),
    "교대 주기 조회",
  );

  const row = rows[0];
  if (row === undefined) return null;
  return { cycleDays: row.cycle_days, anchorDate: row.anchor_date };
}

/**
 * 주기를 켜거나 바꾼다. 사람당 하나뿐이라 **upsert** 다.
 *
 * ⚠️ 주기를 켜면 그 사람의 가용시간은 **주기축 행만** 보게 되므로, 아직 아무것도 칠하지
 *    않았다면 가용시간이 빈다. 화면이 그 사실을 먼저 말해야 한다 — 다만 방향은 옳다.
 *    거짓 "불가" 는 슬롯 하나를 놓치고, 거짓 "가능" 은 못 오는 사람을 앉힌다(§1.4).
 */
export async function setMyAvailabilityCycle(
  userId: string,
  cycle: AvailabilityCycle,
): Promise<AvailabilityCycle> {
  const db = getAdminDb();
  unwrap(
    await db
      .from("availability_cycles")
      .upsert(
        {
          user_id: userId,
          guest_id: null,
          cycle_days: cycle.cycleDays,
          anchor_date: cycle.anchorDate,
        },
        { onConflict: "user_id" },
      )
      .select("cycle_days"),
    "교대 주기 저장",
  );
  return cycle;
}

/** 주기를 끈다. **주기축 패턴 행은 지우지 않는다** — 다시 켜면 그대로 살아난다. */
export async function clearMyAvailabilityCycle(userId: string): Promise<void> {
  const db = getAdminDb();
  const { error } = await db
    .from("availability_cycles")
    .delete()
    .eq("user_id", userId);
  if (error !== null) {
    console.error(`[schedule-repo] 교대 주기 해제: ${error.message}`);
    throw ApiError.internal();
  }
}

export async function fetchMyShiftPresets(
  userId: string,
): Promise<readonly ShiftPreset[]> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("shift_presets")
      .select("id,name,start_minute,end_minute,sort_order")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("start_minute", { ascending: true }),
    "근무 프리셋 조회",
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    sortOrder: row.sort_order,
  }));
}

/**
 * 프리셋 한 건 추가. 이름은 사람당 유일하다(DB 유니크) — 같은 이름을 두 개 만들면
 * 달력에 찍힌 "야간" 이 어느 쪽인지 아무도 모르게 된다.
 */
export async function createMyShiftPreset(
  userId: string,
  input: ShiftPresetInput,
): Promise<ShiftPreset> {
  const db = getAdminDb();
  const existing = await fetchMyShiftPresets(userId);
  if (existing.length >= MAX_SHIFT_PRESETS) {
    throw new ApiError(
      "bad_request",
      `시간대는 최대 ${String(MAX_SHIFT_PRESETS)}개까지 만들 수 있습니다.`,
      400,
    );
  }
  if (existing.some((preset) => preset.name === input.name)) {
    throw new ApiError("bad_request", "같은 이름의 시간대가 이미 있습니다.", 400);
  }

  const rows = unwrap(
    await db
      .from("shift_presets")
      .insert({
        user_id: userId,
        guest_id: null,
        name: input.name,
        start_minute: input.startMinute,
        end_minute: input.endMinute,
        sort_order: existing.length,
      })
      .select("id,name,start_minute,end_minute,sort_order"),
    "근무 프리셋 저장",
  );

  const row = rows[0];
  if (row === undefined) throw ApiError.internal();
  return {
    id: row.id,
    name: row.name,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    sortOrder: row.sort_order,
  };
}

/**
 * 프리셋 삭제. **그 프리셋으로 찍힌 배정도 함께 사라진다**(FK on delete cascade).
 * 근무 종류를 지우면서 달력만 남기면 "무슨 근무인지 모르는 배정" 이 생긴다.
 */
export async function deleteMyShiftPreset(
  userId: string,
  presetId: string,
): Promise<void> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("shift_presets")
      .delete()
      .eq("user_id", userId)
      .eq("id", presetId)
      .select("id"),
    "근무 프리셋 삭제",
  );
  if (rows.length === 0) {
    throw new ApiError("bad_request", "삭제할 시간대를 찾을 수 없습니다.", 404);
  }
}

export async function fetchMyShiftAssignments(
  userId: string,
  fromDayKey: string,
  toDayKey: string,
): Promise<readonly ShiftAssignment[]> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("shift_assignments")
      .select("work_date,preset_id")
      .eq("user_id", userId)
      .gte("work_date", fromDayKey)
      .lte("work_date", toDayKey)
      .order("work_date", { ascending: true }),
    "근무 배정 조회",
  );

  return rows.map((row) => ({
    workDate: row.work_date,
    presetId: row.preset_id,
  }));
}

/**
 * 달력에 찍기 — 날짜들의 **가능 시간 지정**을 바꾼다.
 *
 * 세 가지 중 하나다(`DaySelection`):
 *   · `clear`   → 지정을 지운다. 그 날은 **평소 패턴**으로 돌아간다.
 *   · `blocked` → 그 날은 **종일 불가**(`preset_id = null` 행을 남긴다).
 *   · `preset`  → 그 날은 그 묶음의 시간만 가능하다.
 *
 * ★ 하루에 하나라 **upsert** 다(유니크 `(user_id, work_date)`). 같은 날을 두 번 칠해도
 *   결과가 같아야 사용자가 마음 놓고 누른다.
 * ★ 묶음 소유자 검사는 DB 트리거가 한다(마이그레이션 33·35). 여기서 한 번 더 보는 것은
 *   **에러를 사람 말로 돌려주기 위해서**지, 그것이 방어선이라서가 아니다.
 */
export async function setMyShiftAssignments(
  userId: string,
  dayKeys: readonly string[],
  selection: DaySelection,
): Promise<number> {
  if (dayKeys.length === 0) return 0;
  const db = getAdminDb();

  if (selection.kind === "clear") {
    const rows = unwrap(
      await db
        .from("shift_assignments")
        .delete()
        .eq("user_id", userId)
        .in("work_date", [...dayKeys])
        .select("id"),
      "가능 시간 지정 삭제",
    );
    return rows.length;
  }

  if (selection.kind === "preset") {
    const presets = await fetchMyShiftPresets(userId);
    if (!presets.some((preset) => preset.id === selection.presetId)) {
      throw new ApiError("bad_request", "내 목록에 없는 시간대입니다.", 400);
    }
  }

  const presetId = selection.kind === "preset" ? selection.presetId : null;
  const rows = unwrap(
    await db
      .from("shift_assignments")
      .upsert(
        dayKeys.map((dayKey) => ({
          user_id: userId,
          guest_id: null,
          work_date: dayKey,
          preset_id: presetId,
        })),
        { onConflict: "user_id,work_date" },
      )
      .select("id"),
    "가능 시간 지정 저장",
  );
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 마스터 — **DB 를 읽지 않는다** (`@/lib/boss-master`)
// ─────────────────────────────────────────────────────────────────────────────
/*
 * 예전에는 여기서 `v_boss_catalog` · `boss_aliases` · `boss_difficulties.short_name`
 * 세 번을 읽었다. 셋 다 게임 패치 때만 바뀌는 값이라 탭을 옮길 때마다 다시 묻는 것은
 * 순수한 낭비였다(발주자 지시, 2026-08-18). 지금은 시드 마이그레이션에서 생성한 코드
 * 상수를 그대로 쓴다 — 왕복 3회가 0회가 된다.
 *
 * ⚠️ **DB 표는 그대로다.** `party_runs` · `party_bosses` 등이 `boss_difficulty_id` 를
 *    FK 로 참조하므로 참조 무결성은 여전히 DB 가 갖는다. 바뀐 것은 읽는 경로뿐이다.
 * ⚠️ 일간 제외와 정렬(내림차순)의 단일 소유자도 그쪽으로 옮겼다
 *    (`getTrackedBossCatalog`). 이 함수는 그것을 그대로 돌려주는 얇은 껍데기다.
 */

/*
 * ★ `fetchBossCatalog()` 와 `GET /api/schedule/bosses` 는 **둘 다 없앴다.**
 *   목록이 필요한 화면은 `getTrackedBossCatalog()` 를 직접 import 한다. 서버를
 *   거칠 이유가 없는 값을 위해 라우트 하나와 왕복 하나를 유지할 이유가 없다.
 *   호출부 전수 확인 결과: 라우트 · 두 페이지의 prefetch · 두 워크스페이스 —
 *   전부 상수 직접 참조로 바뀌었다.
 */


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
  entries: ReadonlyMap<string, BossCatalogEntry>,
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

  /*
    ★ 열람 검사와 본문 조회를 **동시에** 띄운다 (2026-08-18 성능 작업).
      검사가 거절하면 `Promise.all` 이 그대로 거절하므로 **한 바이트도 밖으로 나가지
      않는다** — 결과는 버려진다. 직렬로 두면 볼 수 있는 사람에게도 왕복 한 단계를
      더 기다리게 하는데, 원격 Supabase 왕복 1회가 ≈78ms 다.
  */
  const [, rows] = await Promise.all([
    assertPartyVisible(db, viewerUserId, partyId),
    loadPartyBossRows(db, partyId),
  ]);
  if (rows.length === 0) return [];

  const entries = getBossEntryMap(rows.map((row) => row.boss_difficulty_id));
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
    const entries = getBossEntryMap(rows.map((row) => row.boss_difficulty_id));
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
  const entries = getBossEntryMap(bossDifficultyIds);
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

  /*
    ★ 열람 검사와 본문 조회를 **동시에** 띄운다 (2026-08-18 성능 작업).
      검사가 거절하면 `Promise.all` 이 그대로 거절하므로 **한 바이트도 밖으로 나가지
      않는다** — 결과는 버려진다. 직렬로 두면 볼 수 있는 사람에게도 왕복 한 단계를
      더 기다리게 하는데, 원격 Supabase 왕복 1회가 ≈78ms 다.
  */
  const [, rows] = await Promise.all([
    assertPartyVisible(db, viewerUserId, partyId),
    (async () =>
      unwrap(
        await db
          .from("party_runs")
          .select(RUN_COLUMNS)
          .eq("party_id", partyId)
          .eq("week_key", weekKey)
          .is("cancelled_at", null)
          .neq("status", "cancelled"),
        "파티 일정 조회",
      ))(),
  ]);

  const bosses = getBossEntryMap(unique(rows.map((row) => row.boss_difficulty_id)));

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
    /*
      방금 만든 파티의 표시 이름은 **여기서 조합하지 않는다.** `member_no` 는 트리거가
      채우고 참여 캐릭터도 아직 정해지지 않아, 지금 만든 문자열은 곧 낡는다. 목록을
      다시 읽으면 `fetchParties` 가 제대로 채워 준다(생성 직후 무효화가 이미 돈다).
    */
    members: [],
    nameIsCustom,
    // 방금 만든 사람이 곧 소유자다(위 insert 의 `owner_user_id: userId`).
    isOwner: true,
  };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 해체 — **만든 사람만.** 그리고 **지우지 않고 보관한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(2026-08-20): *"파티 터트리는기능이 없네 처음에 생성한사람이 터트릴수잇는
 * 권한을 줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `delete` 가 아니라 `archived_at` 인가 — **수익 이력이 딸려 죽는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * FK 사슬을 따라가면 `parties → party_runs → run_drops` 가 **전부 `on delete cascade`** 다.
 * 즉 파티 행 하나를 지우면 `!드랍` 으로 기록해 둔 **드랍 수익이 함께 사라진다.**
 * (`boss_clears.run_id` 는 `on delete set null` 이라 결정석 클리어는 살아남는다 —
 *  `party_size` 가 이미 그 행에 박혀 있어 금액도 그대로다. 죽는 것은 드랍 쪽이다.)
 *
 * 그리고 **보관만으로 이미 "터진다".** 파티를 읽는 모든 경로가 예외 없이
 * `archived_at is null` 을 걸고 있다 — 대시보드 · 겹쳐보기 · 초대 · 봇 · 공개 게시판.
 * 즉 사용자가 보는 결과는 삭제와 구분되지 않으면서, 되돌릴 수 있고 돈 기록이 남는다.
 *
 * ★ **소유자만** 할 수 있다(발주 요구). 구성원 확인(`requirePartyMembership`)으로는
 *   부족하다 — 아무나 남의 파티를 없앨 수 있게 된다.
 * ★ 이미 보관된 파티에 다시 해도 **조용히 성공**한다(멱등). 두 번 눌렀을 때 오류를 보는
 *   것보다 같은 결과가 낫다.
 */
export async function archiveParty(
  userId: string,
  partyId: PartyId,
): Promise<void> {
  const db = getAdminDb();

  /*
    소유자 확인과 갱신을 **한 문장**으로 한다. 먼저 읽고 나중에 쓰면 그 사이에 소유자가
    바뀔 수 있고(경합), 조건이 두 곳에 생긴다. 0건이 갱신되면 남의 파티이거나 없는 파티다.
  */
  const updated = unwrap(
    await db
      .from("parties")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", partyId)
      .eq("owner_user_id", userId)
      .is("archived_at", null)
      .select("id"),
    "파티 해체",
  );

  if (updated.length > 0) return;

  /*
    0건이었다. **이미 보관된 것**과 **권한이 없는 것**을 갈라야 한다 — 앞은 성공으로
    접어야 하고(멱등), 뒤는 막아야 한다.
  */
  const existing = unwrap(
    await db
      .from("parties")
      .select("owner_user_id,archived_at")
      .eq("id", partyId)
      .limit(1),
    "파티 해체 대상 확인",
  );

  const party = existing[0];
  // 없는 파티와 남의 파티를 같은 답으로 접는다 — id 로 존재 여부를 훑을 수 없게.
  if (party === undefined || party.owner_user_id !== userId) {
    throw new ApiError(
      "bad_request",
      "파티를 만든 사람만 해체할 수 있습니다.",
      403,
    );
  }
  // 소유자가 맞고 이미 보관돼 있다 — 원하던 상태이므로 성공이다.
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

  /*
    ── 이름 ──────────────────────────────────────────────────────────────────
    ★ `undefined` 는 **"건드리지 않는다"** 이고 빈 문자열과 다르다. 이름 칸이 없는
      호출자(있다면)가 실수로 제목을 지워 버리는 일이 없어야 한다.
    ★ 사람이 적었으면 `name_is_custom = true` 로 잠근다 — 그래야 아래 자동 제목이
      덮지 않는다. 비웠으면 `false` 로 풀고, 바로 이어지는 `refreshPartyAutoName` 이
      보스·정원으로 제목을 다시 만든다(`익세 하대 하카 3인`).
    ★ DB CHECK 가 1~60자라 빈 이름은 넣을 수 없다. 그래서 "비움"은 이름을 지우는 것이
      아니라 **자동 제목으로 되돌리는 것**이며, 실제 문자열은 아래가 채운다.
  */
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    unwrap(
      await db
        .from("parties")
        .update(
          trimmed === ""
            ? { name_is_custom: false }
            : { name: trimmed.slice(0, 60), name_is_custom: true },
        )
        .eq("id", input.partyId)
        .select("id"),
      "파티 이름 갱신",
    );
  }

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

  const bosses = getBossEntryMap(bossIds);
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
   *
   * ★ **등록자를 강제로 넣지 않는다** (2026-08-20 발주 지시: *"파티를 만들어줄뿐이지 내가
   *   무조건 보스 파티에 들어가는건 아니야"*).
   *
   *   예전에는 `unique([userId, ...participantPersonIds])` 로 본인을 언제나 끼워 넣었다.
   *   근거가 *"캐릭터를 골라 놓고 참가자에서 빠지는 상태는 없어야 한다"* 였는데, 그 전제
   *   자체가 **파티와 보스 파티를 같은 것으로 본 오해**였다. 이 앱에서
   *     · **파티** = 단톡방에 모인 사람들 (5명)
   *     · **보스 일정** = 그중 실제로 가는 사람들 (3명)
   *   이고, 일정을 잡아 주는 사람이 그 보스에 간다는 보장은 없다. 방장이 일정만 잡아 주는
   *   것은 정상적인 쓰임이다.
   *
   *   그대로 두면 화면과 서버가 **정면으로 어긋난다** — 등록 폼에서 본인 체크를 껐는데
   *   서버가 도로 넣으면, 방에 공유되는 알림이 안 가는 사람의 이름을 부른다. 그게 발주자가
   *   지적한 바로 그 증상이다(*"그 일정이 단톡방에 공유될때 다른사람들이 들어가는게 문제"*).
   *
   *   ⚠️ 등록자가 참여하려면 **폼에서 자기를 체크하면 된다.** 그 경로가 이미 있으므로
   *      여기서 대신 판단할 이유가 없다.
   */
  const signupPersonIds = unique(input.participantPersonIds);

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

  /*
    ★ 알림 적재도 **참가 등록이 끝난 이 시점**이다 (마이그레이션 13-5).
      `bot_outbox` 는 문구를 **얼려서** 담으므로 "언제 만드느냐"가 곧 내용이다. 삽입
      트리거로 걸면 참가자가 들어오기 전에 발화해 `(모집중)` 만 담긴 알림이 나간다.
      그래서 DB 는 규칙(문구·dedupe·TTL)을 갖고, 서버는 **타이밍만** 갖는다.

    ★ 목적지가 없으면(웹 전용 파티) 0건이 적재되고 그것이 정상이다. 수정 시에는
      다시 적재하지 않는다 — `dedupe_key = run_created:<run_id>` 가 같아서 같은 방에
      같은 알림이 두 번 뜨지 않는다. "시간이 바뀌었다" 알림은 별도 종류가 필요한
      일이라 이번 범위가 아니다.

    ★ **실패해도 던지지 않는다.** 알림을 못 쌓았다고 방금 만든 일정을 되돌릴 수 없다.
  */
  await Promise.all(
    // 등록은 **한 번의 행동**이다. 런마다 부르면 세 건을 한 번에 넣었을 때 말풍선이
    // 세 개 뜬다(발주 지적 2026-08-19). 묶음 적재가 단건도 알아서 처리한다.
    [enqueueRunsCreatedNotice(db, createdRows.map((run) => run.id), new Date())],
  );

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

// ─────────────────────────────────────────────────────────────────────────────
// 일정 **수정 · 취소 · 삭제**
//
// 발주 지시(2026-08-18): "일정 수정 취소 삭제 하는 부분은 api 부터 먼저 만들고 있어"
// 발주자 확정 정책(원문): "클리어 붙은것은 취소, 안붙은건 삭제 가능하게 하고"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **"이 런에 수익 기록이 붙었는가"의 유일한 정의.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   취소와 삭제를 가르는 판정이 두 곳에 복제되면 반드시 갈라진다 — 한쪽이 지우고
 *   다른 쪽이 남기는 순간 수익 이력이 조용히 끊긴다. 그래서 수정(주차 이동 제한)과
 *   제거(취소/삭제 분기)가 **같은 이 함수 하나**만 부른다.
 *
 * ── 왜 `boss_clears` 만이 아니라 `run_drops` 까지 보는가 (§0.2-1 형제 위치) ───
 * 둘 다 `run_id` 로 런에 매달린 **수익 원장**이고, 런을 지우면
 *   - `boss_clears.run_id` 는 `on delete set null` → 행은 남지만 어느 일정이었는지가
 *     사라진다(파티·입장 인원 맥락이 날아가고 `setRunClear` 의 체크 상태와도 끊긴다)
 *   - `run_drops` 는 `on delete cascade` → **행 자체가 사라진다**
 * 후자가 더 나쁘다. 지금 함께 보는 비용은 왕복 한 번이고, 빠뜨렸을 때의 비용은
 * 사용자의 수익 기록이다.
 *
 * ★ **드랍 쓰기 경로가 실제로 생겼다** (2026-08-18 — `/api/income/runs/{id}/drops`).
 *   이 주석은 원래 "드랍은 아직 만들 수 없어 항상 0건이지만 미리 본다"였다. 이제는
 *   드랍만 있고 클리어는 없는 런이 실제로 존재하며, 그런 런은 **삭제가 아니라 취소**된다.
 *   그 사실을 말해야 하는 자리 두 곳도 함께 고쳤다 — 아래 주차 이동 409 문구와
 *   `scheduled-run-list.tsx` 의 삭제 확인 문구(§0.2-1).
 *
 * ⚠️ **사용자별로 세지 않는다.** 6인 파티의 런에는 남의 클리어도 매달린다. 내가 안
 *    깼다고 지워 버리면 같이 간 사람의 이력이 사라진다.
 */
async function runHasIncomeRecords(
  db: AdminDb,
  runId: string,
): Promise<boolean> {
  const [clears, drops] = await Promise.all([
    (async () =>
      unwrap(
        await db.from("boss_clears").select("id").eq("run_id", runId).limit(1),
        "일정에 연결된 클리어 조회",
      ))(),
    (async () =>
      unwrap(
        await db.from("run_drops").select("id").eq("run_id", runId).limit(1),
        "일정에 연결된 드랍 조회",
      ))(),
  ]);
  return clears.length > 0 || drops.length > 0;
}

/**
 * 수정·취소·삭제 공통 전처리 — **런을 찾고 권한을 판정한다.**
 *
 * ── 권한 기준: 등록 경로(`createPartyRuns`)와 **같다** ──────────────────────
 * `party_runs.created_by_participant_id` 로 좁히지 않고 **그 파티의 현재 구성원이면
 * 누구나** 고치고 지울 수 있다. 근거:
 *   - 등록(`POST`)이 `requirePartyMembership` 하나만 요구한다. 만들 수 있는 사람이
 *     고칠 수 없으면, 만든 사람이 자리를 비운 파티는 시각 하나 못 옮긴다 — 이 앱의
 *     1순위 가치가 "여럿이 한 시간표를 맞추는 것"(§1.2)인데 그 조율이 한 사람에게
 *     잠긴다.
 *   - 로스터 편집(`updatePartyRoster`)·보스 편집(`setPartyBosses`)도 이미 같은
 *     기준이다. 일정만 더 좁히면 "왜 이것만 안 되냐"가 된다.
 *   - 남의 파티는 당연히 막힌다. 그게 이 함수가 하는 일이다.
 *
 * ── 없는 런과 안 보이는 런은 같은 답(404) ───────────────────────────────────
 * `assertPartyVisible` 을 **먼저** 지난다. 비공개 파티의 런에 403 을 주면 "그 런은
 * 존재한다"는 사실이 새어 나가고, uuid 를 훑어 남의 일정 존재 여부를 확인할 수 있게
 * 된다. 보이지만 구성원이 아닌 경우(공개 파티)만 403 이다.
 */
async function loadRunForEdit(
  db: AdminDb,
  userId: string,
  runId: string,
): Promise<RunRow> {
  const rows = unwrap(
    await db.from("party_runs").select(RUN_COLUMNS).eq("id", runId).limit(1),
    "일정 조회",
  );
  const row = rows[0];
  if (row === undefined) throw partyNotVisible();

  await assertPartyVisible(db, userId, row.party_id);
  await requirePartyMembership(db, userId, row.party_id);
  return row;
}

/** `week_key` 는 생성 컬럼이라 항상 채워져 있다. 방어적으로만 되계산한다. */
function weekKeyOf(row: RunRow): WeekKey {
  return (
    row.week_key ??
    getWeekKey(
      row.scheduled_at === null ? new Date() : new Date(row.scheduled_at),
    )
  );
}

/**
 * 시각 유무에 맞춘 상태 보정.
 *
 * ⚠️ DB CHECK `party_runs_confirmed_needs_time` 이 `status = 'confirmed'` 인데
 *    `scheduled_at` 이 null 인 행을 거부한다. 시각을 지우면서 상태를 그대로 두면
 *    Postgres 영문 제약 위반이 나고 `unwrap` 이 그것을 500 으로 접는다 — 사용자에게는
 *    아무 설명도 남지 않는다. 그래서 여기서 미리 맞춘다.
 *
 * `done` 은 건드리지 않는다. 이미 끝난 일정의 시각을 정정하는 것이지 되돌리는 게 아니다.
 */
function resolveRunStatus(
  current: RunStatus,
  restoring: boolean,
  scheduledAt: string | null,
): RunStatus {
  if (restoring) return scheduledAt === null ? "proposed" : "confirmed";
  if (current === "done") return current;
  if (scheduledAt === null) return current === "confirmed" ? "proposed" : current;
  return current === "proposed" ? "confirmed" : current;
}

/** 수정 응답 — **바뀐 뒤의 그 주차 전체**를 싣는다(다른 쓰기 API 와 같은 규약). */
export interface PartyRunEditResult {
  readonly run: ScheduledRun;
  readonly partyId: PartyId;
  /** 수정 뒤 그 런이 속한 주차. */
  readonly weekKey: WeekKey;
  /**
   * 수정 **전** 주차. 시각을 다음 주로 옮기면 두 주차의 목록이 모두 바뀐다 —
   * 화면이 어느 캐시를 무효화해야 하는지 알 수 있게 그대로 알려 준다.
   */
  readonly previousWeekKey: WeekKey;
  /** `weekKey` 주차의 갱신된 일정 전체. */
  readonly runs: readonly ScheduledRun[];
}

/** 취소/삭제 응답. `outcome` 이 **서버가 무엇을 했는지**를 말한다. */
export interface PartyRunRemovalResult {
  readonly outcome: RunRemovalOutcome;
  readonly runId: RunId;
  readonly partyId: PartyId;
  readonly weekKey: WeekKey;
  readonly runs: readonly ScheduledRun[];
}

/**
 * 일정 수정 (부분 수정).
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **`run_no` 는 여기서 절대 바뀌지 않는다** (§1.4).
 *   ═══════════════════════════════════════════════════════════════════════════
 *   트리거 `party_runs_assign_run_no` 는 `before insert` 에만 붙어 있어 UPDATE 로는
 *   재부여가 일어나지 않고, `patch` 에도 `run_no` 자리를 두지 않는다 — **담지 않는
 *   값은 바뀔 수 없다.** 시각을 다음 주로 옮겨도 번호는 그대로여야 한다. 카톡에서
 *   "2번 일정"이라 부르던 대화가 조용히 다른 일정을 가리키면 안 된다.
 *
 * ⚠️ `week_key` 는 생성 컬럼이라 **UPDATE 에 실으면 에러다.** `scheduled_at` 만 바꾸면
 *    DB 가 알아서 따라간다. 그래서 새 주차는 계산하지 않고 **갱신된 행에서 읽는다** —
 *    생성 컬럼 식을 TS 에 한 번 더 적으면 그 순간 두 구현이 생긴다.
 *
 * ⚠️ 트리거 `party_runs_ensure_party_number` 가 `update of scheduled_at` 에도 붙어
 *    있어 옮겨 간 주차의 **방×주차 파티 번호**를 확보한다. 그것은 `run_no` 와 다른
 *    번호이고(§2.3), `assign_party_number` 는 멱등하며 기존 번호를 재사용한다.
 */
export async function updatePartyRun(
  userId: string,
  input: UpdateRunInput,
): Promise<PartyRunEditResult> {
  const db = getAdminDb();
  const row = await loadRunForEdit(db, userId, input.runId);

  const wasCancelled = row.cancelled_at !== null || row.status === "cancelled";
  const restoring = input.cancelled === false;

  /*
    ★ 취소된 런은 **먼저 복구해야 고칠 수 있다.**
      취소분은 목록·대시보드·수익 집계에서 전부 걸러지므로, 그 상태로 시각을 고치면
      사용자에게는 "저장했는데 화면이 그대로"로 보인다. 성공했다고 답하면서 아무것도
      보여 주지 못하는 응답이 가장 나쁘다.
    ★ 400 이 아니라 409 다 — 요청 형식이 아니라 자원의 **현재 상태** 때문에 거부되며,
      복구하면 같은 요청이 그대로 성공한다(`http.ts` 의 다른 409 들과 같은 기조).
    ★ 복구와 다른 수정은 **한 요청에 함께** 보낼 수 있다. "복구부터 하고 다시 저장"을
      강요하면 왕복이 둘로 늘고 그 사이에 상태가 또 바뀔 수 있다.
  */
  if (wasCancelled && !restoring) {
    throw new ApiError(
      "bad_request",
      "취소된 일정입니다. 먼저 취소를 되돌린 뒤에 수정할 수 있습니다.",
      409,
    );
  }

  const patch: Database["public"]["Tables"]["party_runs"]["Update"] = {};

  let nextScheduledAt = row.scheduled_at;
  if (input.scheduledAt !== undefined) {
    if (input.scheduledAt === null) {
      nextScheduledAt = null;
    } else {
      const ms = input.scheduledAt.getTime();
      if (!Number.isFinite(ms)) {
        throw ApiError.badRequest("일정 시각을 해석할 수 없습니다.");
      }
      nextScheduledAt = new Date(ms).toISOString();
    }
    patch.scheduled_at = nextScheduledAt;
  }

  if (input.durationMinutes !== undefined) {
    const minutes = Math.trunc(input.durationMinutes);
    // DB CHECK 와 **같은 경계**다. 여기서 걸러야 사용자가 한국어 문구를 받는다 —
    // DB 까지 내려가면 Postgres 영문 제약 위반이 나고 `unwrap` 이 500 으로 접는다.
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 600) {
      throw ApiError.badRequest("소요 시간은 5분에서 600분 사이여야 합니다.");
    }
    patch.duration_minutes = minutes;
  }

  if (input.entryPartySize !== undefined) {
    const size = Math.trunc(input.entryPartySize);
    if (!Number.isFinite(size) || size < 1 || size > 24) {
      throw ApiError.badRequest("파티 인원수는 1명에서 24명 사이여야 합니다.");
    }
    // `max_party` 초과는 **막지 않는다.** 소프트 상한이라 화면이 경고만 한다 (§1.3 D5).
    patch.entry_party_size = size;
  }

  if (input.note !== undefined) {
    const note = input.note === null ? null : input.note.trim();
    patch.note = note === "" ? null : note;
  }

  /*
    ── 클리어가 붙은 런은 **주차를 넘어 옮길 수 없다** (§1.3 D1) ────────────────
    수익은 클리어 주차에 귀속되고 `boss_clears.week_key` 는 체크 시점에 스냅샷된 값이라
    (`setRunClear` 가 `run.scheduled_at` 으로 찍는다), 런만 다음 주로 옮기면 일정은
    이번 주에 있는데 수익은 지난주에 남는다. 게다가 CHECK
    `boss_clears_week_key_matches_cleared_at` 때문에 원장 쪽을 따라 옮기는 것도 공짜가
    아니다. 같은 주 안의 시각 정정(21시 → 22시)은 수익 주차를 건드리지 않으므로 허용한다.
  */
  if (patch.scheduled_at !== undefined && (await runHasIncomeRecords(db, row.id))) {
    /*
      ★ 문구가 **두 원장을 모두** 말한다 (§0.2-1, 2026-08-18). 판정은 위
        `runHasIncomeRecords` 이고 그것은 `boss_clears` 와 `run_drops` 를 함께 본다.
        드랍 기록 경로가 생기기 전에는 실제로 클리어만 걸려서 문구가 "클리어" 하나만
        말해도 사실이었지만, 이제는 드랍만 있는 런도 여기서 막힌다 — 그때 "클리어 체크를
        해제하라"고만 하면 사용자가 할 수 없는 조치를 지시하는 것이 된다.
    */
    if (nextScheduledAt === null) {
      throw new ApiError(
        "bad_request",
        "클리어나 드랍이 기록된 일정은 시각을 지울 수 없습니다. 수익이 그 시각의 주차에 매여 있습니다.",
        409,
      );
    }
    if (getWeekKey(new Date(nextScheduledAt)) !== weekKeyOf(row)) {
      throw new ApiError(
        "bad_request",
        "클리어나 드랍이 기록된 일정은 다른 주차로 옮길 수 없습니다. 먼저 클리어 체크를 해제하거나 드랍 기록을 정리해 주세요.",
        409,
      );
    }
  }

  if (restoring) patch.cancelled_at = null;

  const nextStatus = resolveRunStatus(row.status, restoring, nextScheduledAt);
  if (nextStatus !== row.status) patch.status = nextStatus;

  /*
    바꿀 것이 하나도 없으면 UPDATE 를 보내지 않는다. `set_updated_at` 과
    `party_runs_ensure_party_number` 가 헛돌 이유가 없다. 응답은 그대로 만들어 준다 —
    "아무것도 안 바뀜"은 실패가 아니다.
  */
  let finalRow = row;
  if (Object.keys(patch).length > 0) {
    const updatedRows = unwrap(
      await db
        .from("party_runs")
        .update(patch)
        .eq("id", row.id)
        .select(RUN_COLUMNS),
      "일정 수정",
    );
    const updatedRow = updatedRows[0];
    if (updatedRow === undefined) throw ApiError.internal();
    finalRow = updatedRow;
  }

  const weekKey = weekKeyOf(finalRow);
  const runs = await fetchPartyRuns(userId, finalRow.party_id, weekKey);
  const run = runs.find((candidate) => candidate.runId === finalRow.id);
  // 방금 살려 낸/고친 런이 그 주차 목록에 없다면 우리 필터와 DB 가 어긋난 것이다.
  if (run === undefined) throw ApiError.internal();

  return {
    run,
    partyId: finalRow.party_id,
    weekKey,
    previousWeekKey: weekKeyOf(row),
    runs,
  };
}

/**
 * 일정 **취소 또는 삭제** — 어느 쪽인지는 **서버가 판정한다.**
 *
 * 발주자 확정 정책: *"클리어 붙은것은 취소, 안붙은건 삭제 가능하게 하고"*
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   클라이언트는 어느 쪽인지 **몰라도 된다.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   "클리어 붙었나요?" 를 먼저 묻고 다시 부르는 왕복을 만들지 않는다. 그 사이에 같이
 *   간 사람이 클리어를 체크하면 판정이 뒤집히고, 클라이언트는 이미 틀린 답을 들고
 *   있다. 한 번의 요청 안에서 판정과 실행이 같이 일어나야 그 창이 없다.
 *
 * ★ 취소는 `cancelled_at` **컬럼 하나**로 표현한다(마이그레이션 불필요 — 컬럼은
 *   `20260817090300_scheduling.sql` 에 이미 있다). `status = 'cancelled'` 도 함께
 *   찍는다 — 기존 조회들이 두 조건을 **둘 다** 보고 거르기 때문이다.
 *
 * ★ **이미 취소된 런에 다시 요청해도 성공이다**(멱등). 다만 클리어가 없다면 그때는
 *   삭제된다 — 취소된 채 남은 런을 목록에서 완전히 치우는 유일한 경로다.
 */
/**
 * 한 런을 **취소하거나 삭제한다**. 어느 쪽인지는 수익 기록의 유무가 정한다.
 *
 * ★ 이 판정이 한 곳에만 있어야 한다. 낱개 삭제와 묶음 삭제가 서로 다른 규칙을 가지면,
 *   "하나씩 지울 때는 남던 기록이 한 번에 지울 때는 사라지는" 사고가 난다.
 */
async function applyRunRemoval(
  db: AdminDb,
  row: { readonly id: RunId; readonly cancelled_at: string | null; readonly status: string },
): Promise<RunRemovalOutcome> {
  const alreadyCancelled =
    row.cancelled_at !== null || row.status === "cancelled";
  const hasIncome = await runHasIncomeRecords(db, row.id);

  if (hasIncome) {
    /*
      ★ **지우지 않는다.** `boss_clears.run_id` 는 `on delete set null` 이라 행은 남지만
        어느 일정이었는지가 사라지고, `run_drops` 는 `on delete cascade` 라 통째로
        사라진다. 수익 이력이 끊기는 쪽을 사용자가 되돌릴 방법은 없다.
    */
    if (!alreadyCancelled) {
      unwrap(
        await db
          .from("party_runs")
          .update({
            cancelled_at: new Date().toISOString(),
            status: "cancelled",
          })
          .eq("id", row.id)
          .select("id"),
        "일정 취소",
      );
    }
    return "cancelled";
  }

  unwrap(
    await db.from("party_runs").delete().eq("id", row.id).select("id"),
    "일정 삭제",
  );
  return "deleted";
}

export async function removePartyRun(
  userId: string,
  runId: RunId,
): Promise<PartyRunRemovalResult> {
  const db = getAdminDb();
  const row = await loadRunForEdit(db, userId, runId);
  const weekKey = weekKeyOf(row);
  const outcome = await applyRunRemoval(db, row);

  /*
    §1.4 — **번호는 재배열하지 않는다.** 삭제해도 남은 런의 `run_no` 는 그대로이고,
    다음 등록은 `max(run_no) + 1` 을 받는다(트리거가 지워진 번호까지 포함한 max 를
    본다). 빠진 번호는 목록에 구멍으로 남을 뿐이다.
  */
  const runs = await fetchPartyRuns(userId, row.party_id, weekKey);
  return {
    outcome,
    runId: row.id,
    partyId: row.party_id,
    weekKey,
    runs,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음 삭제 — 연속한 일정을 **한 번에**
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 발주자(2026-08-20): *"이거 한번에 삭제하는것좀 만들어줘"* — 한 번에 5개씩 등록되는
 * 연속 일정을 낱개로 다섯 번 지우게 두면, 확인 패널도 다섯 번 열어야 한다.
 *
 * ★ 판정은 낱개와 **같은 함수**(`applyRunRemoval`)가 한다. 그래서 묶음이라고 해서 수익
 *   기록이 붙은 일정이 삭제되는 일은 없다 — 그런 것은 여기서도 취소로 남는다.
 * ★ 결과를 **뭉뚱그리지 않는다.** 삭제된 수와 취소된 수를 따로 세어 돌려준다. "5건
 *   처리했습니다" 라고만 하면 사용자는 자기 수익 기록이 어떻게 됐는지 알 수 없다.
 * ★ 순차로 돈다. 다섯 건 남짓이라 병렬로 얻을 것이 없고, 순차가 실패 지점을 분명하게
 *   남긴다(앞의 것은 처리됐고 뒤는 그대로다).
 * ⚠️ 주차가 섞일 수 있다. 묶음은 **연속한 시각**으로 끊기지 목요일 초기화로 끊기지
 *    않으므로, 수요일 23:40 ~ 목요일 00:20 묶음은 두 주차에 걸친다. 그래서 건드린 주차를
 *    전부 돌려주고 화면이 그 전부를 무효화한다.
 */
export interface PartyRunBulkRemovalResult {
  readonly deletedCount: number;
  readonly cancelledCount: number;
  readonly partyId: PartyId;
  readonly weekKeys: readonly WeekKey[];
}

/** 한 번에 지울 수 있는 최대 건수. 한 묶음이 이보다 길 이유가 없다. */
export const MAX_BULK_RUN_REMOVAL = 30;

export async function removePartyRuns(
  userId: string,
  runIds: readonly RunId[],
): Promise<PartyRunBulkRemovalResult> {
  if (runIds.length === 0) {
    throw new ApiError("bad_request", "지울 일정이 없습니다.", 400);
  }
  if (runIds.length > MAX_BULK_RUN_REMOVAL) {
    throw new ApiError(
      "bad_request",
      `한 번에 ${String(MAX_BULK_RUN_REMOVAL)}건까지만 지울 수 있습니다.`,
      400,
    );
  }

  const db = getAdminDb();
  const weekKeys = new Set<WeekKey>();
  let partyId: PartyId | null = null;
  let deletedCount = 0;
  let cancelledCount = 0;

  for (const runId of runIds) {
    /*
      권한 검사도 낱개와 같은 자리다(`loadRunForEdit` 가 세션 사용자로 조회한다).
      남의 파티 일정이 섞여 들어오면 그 지점에서 그대로 거절된다.
    */
    const row = await loadRunForEdit(db, userId, runId);
    if (partyId !== null && row.party_id !== partyId) {
      throw new ApiError(
        "bad_request",
        "한 번에 지우는 일정은 같은 파티여야 합니다.",
        400,
      );
    }
    partyId = row.party_id;
    weekKeys.add(weekKeyOf(row));

    const outcome = await applyRunRemoval(db, row);
    if (outcome === "deleted") deletedCount += 1;
    else cancelledCount += 1;
  }

  if (partyId === null) throw ApiError.internal();
  return {
    deletedCount,
    cancelledCount,
    partyId,
    weekKeys: [...weekKeys],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 분배 배율 (share) — **계산은 전부 DB 가 한다**
//
// 발주 지시(2026-08-19): "파티 설정할때 분배 배율 설정하는 칸도 있어야함.
//   단순히 2인이면 1:1 이 아니라 스펙에 차이나는 사람끼리 1:2 분배 하는경우도있음"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **비율을 왜 파티가 아니라 런(일정)에 다는가**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   결정석 pot 은 "그 보스에 **실제로 같이 들어간 사람들**"이 나눈다. 6인 파티에서
 *   4명만 간 런이면 그 4명 사이에서 합이 100% 여야 하므로, 파티 단위 비율로는 애초에
 *   표현할 수 없다. 그래서 스키마도 `run_signups.share_bp` 다
 *   (마이그레이션 `20260817091000_payout_shares_and_drops.sql` 10-2 주석).
 *
 * ★ **여기서 나눗셈을 하지 않는다.** 가중치 → 만분율 환산도, pot → 개인 수령액도
 *   전부 `public.distribute_meso()`(최대잉여법) 한 구현이 한다. 웹·카톡 봇·주간 집계
 *   뷰가 같은 답을 내야 하고, 화면이 1/n 을 다시 적었다가 실제 약정과 다른 금액을 말한
 *   사고가 이미 두 번 있었다.
 */
const RUN_SHARE_BP_TOTAL = 10_000;

/** `PUT .../shares` 가 받는 한 줄. `weight` 는 화면이 100 을 곱해 정수로 만든 값이다. */
export interface RunShareWeightSeed {
  readonly participantId: string;
  readonly weight: number;
}

/** 분배 화면 한 벌을 만든다. 읽기 경로(GET)와 쓰기 응답이 **같은 함수**를 쓴다. */
async function buildRunSharesPayload(
  db: AdminDb,
  userId: string,
  row: RunRow,
): Promise<RunSharesPayload> {
  const entryPartySize = entryPartySizeOf(row);

  /*
    pot = 게임이 파티 전체에 준 총액 = party_size × floor(솔로가 / party_size).
    곱하기 전의 floor 를 생략하면 나누어떨어지지 않는 보스에서 최대 n-1 메소가
    **없던 돈으로 늘어난다**(하드 스우 51,500,000 → pot 51,499,998).
    가격 미확인은 `null` 이며 0 이 아니다 (§1.3 D4).
  */
  const boss = getBossEntryMap([row.boss_difficulty_id]).get(
    row.boss_difficulty_id,
  );
  const perEntrant = crystalShareMeso(
    boss?.crystalPriceMeso ?? null,
    entryPartySize,
  );
  const potMeso = perEntrant === null ? null : perEntrant * entryPartySize;

  const [participants, signupRows, runRows, weightRows] = await Promise.all([
    (async () =>
      (await loadRunParticipants(db, userId, [row.id])).get(row.id) ?? [])(),
    (async () =>
      unwrap(
        await db
          .from("run_signups")
          .select("participant_id,share_bp")
          .eq("run_id", row.id),
        "분배 비율 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_runs")
          .select("share_mode")
          .eq("id", row.id)
          .limit(1),
        "분배 방식 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("v_run_share_weights")
          .select("participant_id,weight")
          .eq("run_id", row.id),
        "런 분배 가중치 조회",
      ))(),
  ]);

  const bpByParticipant = new Map(
    signupRows.map((entry) => [entry.participant_id, entry.share_bp]),
  );

  /*
    수령액도 DB 가 낸다. 가중치는 뷰 `v_run_share_weights` 가 이미 정한 것을 쓴다 —
    `auto_equal` 이면 1(정확한 1/n), `manual` 이면 `share_bp`. 균등을 만분율로
    표현하면 1/6 이 1667/1666 으로 근사되어 1인당 수천 메소가 어긋난다.
  */
  const amountByParticipant = new Map<string, number>();
  const keys: string[] = [];
  const weights: number[] = [];
  for (const entry of weightRows) {
    if (entry.participant_id === null || entry.weight === null) continue;
    keys.push(entry.participant_id);
    weights.push(entry.weight);
  }
  if (potMeso !== null && keys.length > 0) {
    const distributed = unwrap(
      await db.rpc("distribute_meso", {
        p_total: potMeso,
        p_keys: keys,
        p_weights: weights,
      }),
      "결정석 분배 계산",
    );
    for (const entry of distributed) {
      amountByParticipant.set(entry.key, entry.amount);
    }
  }

  return {
    runId: row.id,
    partyId: row.party_id,
    weekKey: weekKeyOf(row),
    shareMode: runRows[0]?.share_mode ?? "auto_equal",
    entryPartySize,
    potMeso,
    /*
      §1.4 — 번호(`seatNo`)는 재부여하지 않으므로 연속이 아닐 수 있다.
      `loadRunParticipants` 가 이미 번호순으로 정렬해 준다.
    */
    participants: participants.map<RunShareParticipantWire>((participant) => ({
      signupId: participant.signupId,
      participantId: participant.participantId,
      seatNo: participant.seatNo,
      displayName: participant.displayName,
      isGuest: participant.isGuest,
      status: participant.status,
      characterName: participant.characterName,
      shareBp: bpByParticipant.get(participant.participantId) ?? 0,
      amountMeso: amountByParticipant.get(participant.participantId) ?? null,
    })),
  };
}

/** 분배 화면 조회. 파티 구성원만 볼 수 있다 — 남의 파티 금전 약정은 공개면이 아니다. */
export async function fetchRunShares(
  userId: string,
  runId: RunId,
): Promise<RunSharesPayload> {
  const db = getAdminDb();
  const row = await loadRunForEdit(db, userId, runId);
  return buildRunSharesPayload(db, userId, row);
}

/**
 * 사용자 지정 비율 저장.
 *
 * ── 왜 가중치를 받아 **DB 로 만분율을 만드는가** ────────────────────────────
 * `set_run_shares` 는 합계가 **정확히 10000** 이 아니면 거절한다. `1 : 2` 를
 * `3333 : 6667` 로 만드는 잔돈 배분을 TS 에서 하면 그 순간 반올림 규칙이 두 벌이 되고,
 * 카톡 봇이 같은 비율에 다른 답을 낸다. → `distribute_meso(10000, ids, weights)` 를
 * 그대로 쓴다. 이 함수는 합계가 총액과 **정확히 일치**함을 보장한다.
 *
 * ⚠️ `going` 이 아닌 참가자는 대상이 아니다 — DB CHECK
 *    `run_signups_non_going_has_no_share` 가 `share_bp = 0` 을 강제한다. 여기서 걸러
 *    보내지 않으면 Postgres 영문 제약 위반이 500 으로 접혀 사용자에게 아무 설명도
 *    남지 않는다.
 */
export async function setRunShares(
  userId: string,
  runId: RunId,
  seeds: readonly RunShareWeightSeed[],
): Promise<RunSharesPayload> {
  const db = getAdminDb();
  const row = await loadRunForEdit(db, userId, runId);

  const signupRows = unwrap(
    await db
      .from("run_signups")
      .select("participant_id,status")
      .eq("run_id", row.id),
    "분배 대상 참가자 조회",
  );
  const goingIds = new Set(
    signupRows
      .filter((entry) => entry.status === "going")
      .map((entry) => entry.participant_id),
  );

  if (goingIds.size === 0) {
    throw ApiError.badRequest(
      "참가 확정한 사람이 없어 분배 배율을 정할 수 없습니다.",
    );
  }

  const submitted = new Map<string, number>();
  for (const seed of seeds) {
    if (!goingIds.has(seed.participantId)) {
      // 어느 id 인지는 밝히지 않는다 — 남의 참가자 id 존재 여부가 새어 나간다.
      throw ApiError.badRequest(
        "이 일정에 참가 확정하지 않은 사람은 분배 대상이 아닙니다.",
      );
    }
    if (submitted.has(seed.participantId)) {
      throw ApiError.badRequest("같은 참가자가 두 번 들어 있습니다.");
    }
    submitted.set(seed.participantId, seed.weight);
  }

  /*
    빠진 사람을 0 으로 **암묵 처리하지 않는다.** 화면이 한 줄을 못 보낸 버그가 곧바로
    "그 사람 몫이 0" 이라는 금전 약정으로 저장되기 때문이다. 전원을 함께 보내게 한다.
  */
  if (submitted.size !== goingIds.size) {
    throw ApiError.badRequest(
      "참가 확정한 사람 전원의 분배 배율을 함께 보내야 합니다.",
    );
  }

  const ids = [...submitted.keys()];
  const weights = ids.map((id) => submitted.get(id) ?? 0);
  if (weights.reduce((sum, value) => sum + value, 0) <= 0) {
    throw ApiError.badRequest(
      "분배 배율의 합이 0 입니다. 최소 한 명은 0보다 큰 값을 가져야 합니다.",
    );
  }

  // 가중치 → 만분율. **잔돈 배분은 DB 의 최대잉여법이 한다.**
  const bpRows = unwrap(
    await db.rpc("distribute_meso", {
      p_total: RUN_SHARE_BP_TOTAL,
      p_keys: ids,
      p_weights: weights,
    }),
    "분배 비율 환산",
  );
  const bpByParticipant = new Map(
    bpRows.map((entry) => [entry.key, entry.amount]),
  );
  const shareBps = ids.map((id) => Number(bpByParticipant.get(id) ?? 0));

  /*
    ★ **저장 위치가 파티로 올라갔다** (발주 지시 2026-08-19: *"분배를 보스별로 붙이지말고
      파티 자체에 설정을 넣어줘"*). 예전에는 `set_run_shares` 가 `run_signups.share_bp` 와
      `party_runs.share_mode` 에 썼는데, 이제 그 두 자리는 **아무도 읽지 않는다**
      (마이그레이션 `20260819200000`). 거기 계속 쓰면 화면에서 비율을 고쳐도 정산이
      그대로인 상태가 된다 — 가장 나쁜 종류의 침묵이다.
    ★ 파티 구성원 전체가 아니라 **이번에 보낸 사람들**만 갱신한다. 이 런에 안 온 파티원의
      비율까지 건드리면, 한 번의 편집이 다른 일정의 약정을 조용히 바꾼다.
  */
  unwrap(
    await db
      .from("parties")
      .update({ share_mode: "manual" })
      .eq("id", row.party_id)
      .select("id"),
    "분배 방식 저장",
  );
  await Promise.all(
    ids.map(async (participantId, index) =>
      unwrap(
        await db
          .from("party_participants")
          .update({ share_bp: shareBps[index] ?? 0 })
          .eq("id", participantId)
          .select("id"),
        "분배 비율 저장",
      ),
    ),
  );

  /*
    이미 기록된 결정석 금액을 다시 나눈다. **가격 스냅샷은 건드리지 않는다** —
    R3(소급 변경 금지)를 지키기 위해 pot 은 그대로 두고 배분만 다시 한다.
    이걸 빠뜨리면 수익 화면의 수령액이 새 비율을 따라오지 않는다.
  */
  unwrap(
    await db.rpc("recompute_run_crystal_shares", { p_run_id: row.id }),
    "결정석 수령액 재계산",
  );

  return buildRunSharesPayload(db, userId, row);
}

/**
 * 균등으로 되돌리기.
 *
 * `share_mode` 를 `auto_equal` 로 되돌린 **뒤에** `rebalance_run_shares` 를 부른다.
 * 순서가 중요하다 — 그 함수는 `manual` 이고 합계가 이미 10000 이면 **손대지 않는다**
 * (사용자가 정한 비율을 지키는 것이 그 함수의 일이다).
 *
 * 균등 모드가 만분율이 아니라 가중치 1 을 쓰는 이유는 뷰 `v_run_share_weights` 주석
 * 참고 — 만분율로 균등을 표현하면 6인 파티에서 1인당 수천 메소가 게임 결과와 어긋난다.
 */
export async function resetRunSharesToEqual(
  userId: string,
  runId: RunId,
): Promise<RunSharesPayload> {
  const db = getAdminDb();
  const row = await loadRunForEdit(db, userId, runId);

  /*
    ★ 되돌리는 자리도 **파티**다. `party_runs.share_mode` 는 더 이상 읽히지 않으므로
      거기 되돌려 봐야 아무 일도 일어나지 않는다(마이그레이션 `20260819200000`).
    ★ 비율을 0 이 아니라 **null 로** 지운다. `v_run_share_weights` 는 합이 0 이면 균등으로
      떨어지지만, 0 을 남기면 "이 사람 몫은 0" 이라는 약정처럼 읽힌다. 균등은 "정하지
      않았다"이지 "0을 줬다"가 아니다.
  */
  unwrap(
    await db
      .from("parties")
      .update({ share_mode: "auto_equal" })
      .eq("id", row.party_id)
      .select("id"),
    "분배 방식 되돌리기",
  );

  unwrap(
    await db
      .from("party_participants")
      .update({ share_bp: null })
      .eq("party_id", row.party_id)
      .select("id"),
    "분배 비율 지우기",
  );
  unwrap(
    await db.rpc("recompute_run_crystal_shares", { p_run_id: row.id }),
    "결정석 수령액 재계산",
  );

  return buildRunSharesPayload(db, userId, row);
}

// ─────────────────────────────────────────────────────────────────────────────
// 분배 배율 — **파티 설정**이 소유한다 (2026-08-19 발주자)
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주자: *"분배조율도 파티 설정에 있어야된다고 했잖슴"* · 앞선 지시:
// *"분배를 보스별로 붙이지말고 파티 자체에 설정을 넣어줘"*
//
// DB 는 이미 파티가 갖고 있다 — `parties.share_mode` + `party_participants.share_bp`
// (마이그레이션 `20260819200000`). 위쪽 런 단위 함수들은 그 컬럼에 쓰고 있었을 뿐이며,
// **입구가 일정 카드에 있어서** 사용자에게는 보스별 설정처럼 보였다. 이 아래가 그 입구를
// 파티로 옮긴 자리다.
//
// ⚠️ 비율은 **정산 값**이다. `fetchPartyMembers` 같은 공개 열람 경로에 실어 보내지 않는다
//    (비로그인 시간표에서도 보이게 되고, 그게 B-5 가 났던 방식이다). 그래서 아래 조회는
//    **파티 구성원 본인만** 통과한다.

/** 파티 분배 설정 한 벌. 읽기(GET)와 쓰기 응답이 같은 함수를 쓴다. */
async function buildPartySharesPayload(
  db: AdminDb,
  partyId: PartyId,
): Promise<PartySharesPayload> {
  const [partyRows, memberRows] = await Promise.all([
    (async () =>
      unwrap(
        await db.from("parties").select("id,share_mode").eq("id", partyId).limit(1),
        "파티 분배 방식 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select("id,display_name,member_no,share_bp")
          .eq("party_id", partyId)
          .is("left_at", null)
          .order("member_no", { ascending: true }),
        "파티 분배 비율 조회",
      ))(),
  ]);

  const party = partyRows[0];
  if (party === undefined) throw partyNotVisible();

  return {
    partyId,
    shareMode: party.share_mode === "manual" ? "manual" : "auto_equal",
    participants: memberRows.map((row) => ({
      participantId: row.id,
      seatNo: row.member_no,
      displayName: row.display_name,
      shareBp: row.share_bp,
    })),
  };
}

/** 파티 분배 설정 읽기. **구성원만** 볼 수 있다(위 ⚠️). */
export async function fetchPartyShares(
  userId: string,
  partyId: PartyId,
): Promise<PartySharesPayload> {
  const db = getAdminDb();
  await requirePartyMembership(db, userId, partyId);
  return buildPartySharesPayload(db, partyId);
}

/**
 * 이 파티의 **이번 주 일정**들의 결정석 수령액을 다시 나눈다.
 *
 * ★ **지난 주는 건드리지 않는다.** 이미 기록된 주의 정산을 오늘의 합의로 다시 쓰면 그건
 *   소급 변경이고, 이 저장소가 스냅샷을 찍는 이유(R3)와 정면으로 어긋난다. 화면도
 *   "이번 주 정산부터 반영된다"고 말한다.
 * ★ pot 은 손대지 않는다 — 다시 나누기만 한다(`recompute_run_crystal_shares`).
 */
async function recomputePartyWeekShares(
  db: AdminDb,
  partyId: PartyId,
  weekKey: WeekKey,
): Promise<void> {
  const runs = unwrap(
    await db
      .from("party_runs")
      .select("id")
      .eq("party_id", partyId)
      .eq("week_key", weekKey),
    "파티 일정 조회",
  );

  await Promise.all(
    runs.map(async (run) =>
      unwrap(
        await db.rpc("recompute_run_crystal_shares", { p_run_id: run.id }),
        "결정석 수령액 재계산",
      ),
    ),
  );
}

/**
 * 파티 분배 비율 저장.
 *
 * ★ **전원을 함께 보내야 한다.** 빠진 사람을 0 으로 암묵 처리하면 화면이 한 줄을 못 보낸
 *   버그가 곧바로 "그 사람 몫은 0" 이라는 금전 약정이 된다(런 버전과 같은 규약).
 * ★ **여기서 나눗셈을 하지 않는다.** 가중치 → 만분율 환산은 `distribute_meso()`
 *   한 구현이 한다. 웹·카톡 봇·집계 뷰가 같은 답을 내야 한다.
 */
export async function setPartyShares(
  userId: string,
  partyId: PartyId,
  seeds: readonly RunShareWeightSeed[],
  now: Date = new Date(),
): Promise<PartySharesPayload> {
  const db = getAdminDb();
  await requirePartyMembership(db, userId, partyId);

  const memberRows = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("party_id", partyId)
      .is("left_at", null),
    "파티 구성원 조회",
  );
  const memberIds = new Set(memberRows.map((row) => row.id));

  const submitted = new Map<string, number>();
  for (const seed of seeds) {
    if (!memberIds.has(seed.participantId)) {
      throw ApiError.badRequest("이 파티의 구성원이 아닌 사람이 들어 있습니다.");
    }
    if (submitted.has(seed.participantId)) {
      throw ApiError.badRequest("같은 구성원이 두 번 들어 있습니다.");
    }
    submitted.set(seed.participantId, seed.weight);
  }
  if (submitted.size !== memberIds.size) {
    throw ApiError.badRequest("구성원 전원의 분배 배율을 함께 보내야 합니다.");
  }

  const ids = [...submitted.keys()];
  const weights = ids.map((id) => submitted.get(id) ?? 0);
  if (weights.reduce((sum, value) => sum + value, 0) <= 0) {
    throw ApiError.badRequest(
      "분배 배율의 합이 0 입니다. 최소 한 명은 0보다 큰 값을 가져야 합니다.",
    );
  }

  const bpRows = unwrap(
    await db.rpc("distribute_meso", {
      p_total: RUN_SHARE_BP_TOTAL,
      p_keys: ids,
      p_weights: weights,
    }),
    "분배 비율 환산",
  );
  const bpByParticipant = new Map(bpRows.map((entry) => [entry.key, entry.amount]));

  unwrap(
    await db
      .from("parties")
      .update({ share_mode: "manual" })
      .eq("id", partyId)
      .select("id"),
    "분배 방식 저장",
  );
  await Promise.all(
    ids.map(async (participantId) =>
      unwrap(
        await db
          .from("party_participants")
          .update({ share_bp: Number(bpByParticipant.get(participantId) ?? 0) })
          .eq("id", participantId)
          .select("id"),
        "분배 비율 저장",
      ),
    ),
  );

  await recomputePartyWeekShares(db, partyId, getWeekKey(now));
  return buildPartySharesPayload(db, partyId);
}

/**
 * 균등으로 되돌리기.
 *
 * 비율을 0 이 아니라 **`null` 로** 지운다. 균등은 "정하지 않았다"이지 "0을 줬다"가 아니고,
 * 0 을 남기면 그 사람 몫이 없다는 약정처럼 읽힌다.
 */
export async function resetPartySharesToEqual(
  userId: string,
  partyId: PartyId,
  now: Date = new Date(),
): Promise<PartySharesPayload> {
  const db = getAdminDb();
  await requirePartyMembership(db, userId, partyId);

  unwrap(
    await db
      .from("parties")
      .update({ share_mode: "auto_equal" })
      .eq("id", partyId)
      .select("id"),
    "분배 방식 되돌리기",
  );
  unwrap(
    await db
      .from("party_participants")
      .update({ share_bp: null })
      .eq("party_id", partyId)
      .select("id"),
    "분배 비율 지우기",
  );

  await recomputePartyWeekShares(db, partyId, getWeekKey(now));
  return buildPartySharesPayload(db, partyId);
}
