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
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { Database } from "@/types/database";
import type {
  AvailabilityException,
  AvailabilityInterval,
  BossCatalogEntry,
  BossCycle,
  BossDifficultyTier,
  CreatePartyInput,
  CreateRunInput,
  MesoOrUnknown,
  OverlapWindow,
  Party,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
  RunParticipant,
  RunStatus,
  SaveRunSignupInput,
  ScheduledRun,
  TimeRange,
  UpdatePartyRosterInput,
  WeekKey,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";

// ─────────────────────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST 응답의 최소 모양. `PostgrestSingleResponse<T>` 가 그대로 들어온다. */
interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
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

  const [participantRows, characterRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select("id,user_id,guest_id,display_name,member_no")
          .in("id", participantIds),
        "런 참가자 신원 조회",
      ))(),
    (async () =>
      characterIds.length === 0
        ? []
        : unwrap(
            await db
              .from("characters")
              .select("id,character_name,world_name")
              .in("id", characterIds),
            "런 참가 캐릭터 조회",
          ))(),
  ]);

  const participantById = new Map(participantRows.map((row) => [row.id, row]));
  const characterById = new Map(characterRows.map((row) => [row.id, row]));

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
      // §1.4 — 관리 번호는 재배열하지 않으므로 연속이 아닐 수 있다.
      seatNo: participant.member_no,
      status: row.status,
      characterId: row.character_id,
      characterName: character?.character_name ?? null,
      worldName: character?.world_name ?? null,
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

  const mineRows =
    myIds.size === 0
      ? []
      : unwrap(
          await db
            .from("parties")
            .select("id,name,visibility,default_capacity,created_at")
            .in("id", [...myIds])
            .is("archived_at", null),
          "내 파티 조회",
        );

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
      .select("id,user_id,guest_id,display_name,member_no")
      .eq("party_id", partyId)
      .is("left_at", null)
      .order("member_no", { ascending: true }),
    "파티 구성원 조회",
  );

  const members: PartyMember[] = [];
  for (const row of rows) {
    // CHECK `num_nonnulls(user_id, guest_id) = 1` 이 보장하지만, 방어적으로 건너뛴다.
    const personId = row.user_id ?? row.guest_id;
    if (personId === null) continue;
    members.push({
      personId,
      participantId: row.id,
      displayName: row.display_name,
      isGuest: row.user_id === null,
      seatNo: row.member_no,
    });
  }
  return members;
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

/**
 * 예외(제외) 원본. `resolve_availability` 결과에는 "어디가 왜 깎였는지"가 남지 않으므로
 * 화면이 그 자국을 그리려면 이 조회가 따로 필요하다.
 *
 * ⚠️ DB 의 `start_minute` / `end_minute` 는 **not null** 이고, 하루 전체 제외는
 *    `0 ~ 1440` 으로 저장된다. 도메인 타입은 "둘 다 null 이면 그날 전체"이므로 여기서 되돌린다.
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
  const columns = "id,user_id,guest_id,exception_date,start_minute,end_minute,note";

  // `or(user_id.in.(…),guest_id.in.(…))` 대신 두 번 조회한다 — uuid 를 문자열 필터에
  // 끼워 넣지 않으므로 필터 주입 여지가 원천적으로 없다.
  const [userRows, guestRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("availability_exceptions")
          .select(columns)
          .in("user_id", allowed)
          .gte("exception_date", fromDay)
          .lte("exception_date", toDay),
        "가용시간 예외 조회(사용자)",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("availability_exceptions")
          .select(columns)
          .in("guest_id", allowed)
          .gte("exception_date", fromDay)
          .lte("exception_date", toDay),
        "가용시간 예외 조회(게스트)",
      ))(),
  ]);

  const byId = new Map<string, AvailabilityException>();
  for (const row of [...userRows, ...guestRows]) {
    const personId = row.user_id ?? row.guest_id;
    if (personId === null) continue;
    // 하루 전체(0~1440 이상)는 도메인에서 `null / null` 로 표현한다.
    const wholeDay = row.start_minute === 0 && row.end_minute >= 1440;
    byId.set(row.id, {
      id: row.id,
      personId,
      dayKey: row.exception_date,
      startMinute: wholeDay ? null : row.start_minute,
      endMinute: wholeDay ? null : row.end_minute,
      note: row.note,
    });
  }

  return [...byId.values()].sort(
    (a, b) => a.dayKey.localeCompare(b.dayKey) || a.id.localeCompare(b.id),
  );
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
    difficulty: row.difficulty,
    cycle: row.cycle,
    maxParty: row.max_party ?? 6,
    crystalPriceMeso: row.crystal_price_meso,
    released: row.released ?? true,
    aliases,
  };
}

/**
 * → `select * from public.v_boss_catalog order by sort_order`
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

  const [rows, aliasRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_boss_catalog")
          .select(BOSS_CATALOG_COLUMNS)
          .order("sort_order", { ascending: true }),
        "보스 카탈로그 조회",
      ))(),
    (async () =>
      unwrap(
        await db.from("boss_aliases").select("alias,boss_id,boss_difficulty_id"),
        "보스 별칭 조회",
      ))(),
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
    const entry = toBossEntry(row, aliases);
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

  const rows = unwrap(
    await db
      .from("v_boss_catalog")
      .select(BOSS_CATALOG_COLUMNS)
      .in("boss_difficulty_id", [...bossDifficultyIds]),
    "런 보스 정보 조회",
  );
  for (const row of rows) {
    const entry = toBossEntry(row, []);
    if (entry !== null) map.set(entry.bossDifficultyId, entry);
  }
  return map;
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

/**
 * 새 파티.
 *
 * ⚠️ `member_no` 는 **넘기지 않는다.** 트리거가 행마다 `max + 1` 을 넣어 1..n 이 된다
 *    (`TriggerAssigned` 주석 참고). 넘기면 트리거가 그 값을 그대로 존중해 버린다.
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

  const names = memberIds.map(
    (id) => people.get(id)?.displayName ?? "알 수 없음",
  );
  const name = clampPartyName(
    input.name.trim() === "" ? summarizePartyName(names) : input.name,
  );
  if (name === "") throw ApiError.badRequest("파티 이름이 비어 있습니다.");

  const partyRows = unwrap(
    await db
      .from("parties")
      .insert({
        owner_user_id: userId,
        name,
        visibility: "private",
        default_capacity: Math.min(Math.max(memberIds.length, 1), 24),
      })
      .select("id,name,visibility,default_capacity"),
    "파티 생성",
  );
  const party = partyRows[0];
  if (party === undefined) throw ApiError.internal();

  const participants: ParticipantSeed[] = memberIds.map((personId) => {
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
  const inserts: ParticipantSeed[] = additions.map((personId) => {
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

  return fetchPartyMembers(userId, input.partyId);
}

/**
 * 일정 등록.
 *
 * ⚠️ `week_key` 는 **생성 컬럼**(`week_key(coalesce(scheduled_at, created_at))`)이라
 *    INSERT 에 넣으면 에러다. 넣지 않는다.
 * ⚠️ `max_party` 초과는 **막지 않는다.** 소프트 상한이라 화면이 경고만 한다 (§1.3 D5).
 * ⚠️ `run_no` 도 **넘기지 않는다.** 트리거 `party_runs_assign_run_no` 가 advisory lock
 *    안에서 `max + 1` 을 넣는다(`TriggerAssigned` 주석 참고).
 */
export async function createPartyRun(
  userId: string,
  input: CreateRunInput,
): Promise<ScheduledRun> {
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

  if (!Number.isFinite(input.entryPartySize) || input.entryPartySize < 1) {
    throw ApiError.badRequest("파티 인원수는 1명 이상이어야 합니다.");
  }
  const entryPartySize = Math.min(Math.trunc(input.entryPartySize), 24);
  const durationMinutes = Math.min(
    Math.max(Math.trunc(input.durationMinutes), 5),
    600,
  );

  const bosses = await loadBossEntries(db, [input.bossDifficultyId]);
  const boss = bosses.get(input.bossDifficultyId);
  if (boss === undefined) {
    throw ApiError.badRequest("등록할 수 없는 보스입니다.");
  }

  // 참가 의사는 **사람 id** 로 들어오므로 그 파티의 `party_participants.id` 로 옮긴다.
  const members = await fetchPartyMembers(userId, input.partyId);
  const participantIdByPerson = new Map(
    members.map((member) => [member.personId, member.participantId]),
  );

  const capacity = Math.min(Math.max(members.length, entryPartySize, 1), 24);

  const seed: PartyRunSeed = {
    party_id: input.partyId,
    boss_difficulty_id: input.bossDifficultyId,
    scheduled_at: input.scheduledAt.toISOString(),
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

  // **참가 등록 뒤에** 부른다 — `v_run_share_weights` 가 `run_signups` 를 읽으므로
  // 순서가 뒤집히면 방금 만든 런의 참가자가 한 명도 안 보인다.
  // 참가자 목록도 같은 이유로 이 시점에 읽는다.
  const [shares, participants] = await Promise.all([
    loadViewerShares(db, userId, [
      {
        runId: run.id,
        entryPartySize: entryPartySizeOf(run),
        crystalPriceMeso: boss.crystalPriceMeso,
      },
    ]),
    loadRunParticipants(db, userId, [run.id]),
  ]);

  return toScheduledRun(
    run,
    boss,
    shares.get(run.id) ?? null,
    participants.get(run.id) ?? [],
  );
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
