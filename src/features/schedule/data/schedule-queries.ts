import type {
  AvailabilityException,
  AvailabilityInterval,
  BossCatalogEntry,
  CreatePartyInput,
  CreateRunInput,
  OverlapWindow,
  Party,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
  RunParticipant,
  SaveRunSignupInput,
  ScheduledRun,
  TimeRange,
  UpdatePartyRosterInput,
  WeekKey,
} from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 데이터 접근 경계 (data access boundary) — **브라우저 쪽**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 **이 파일의 함수만** 부른다. 본문은 전부 `/api/schedule/...` 호출이고,
 * 그 Route Handler 가 `features/schedule/server/schedule-repo.ts` 를 부른다.
 *
 * ⚠️ **이 파일은 클라이언트 번들에 들어간다.** 그래서:
 *   - `@/lib/supabase/admin-db` 를 import 하면 안 된다(`server-only` 라 빌드가 깨진다).
 *   - service_role 키가 이 경로로 새어 나갈 수 없다 — 여기엔 `fetch` 밖에 없다.
 *
 * ⚠️ **서버 컴포넌트는 이 파일을 부르지 않는다.** 상대 경로 `fetch("/api/...")` 는
 *   서버에서 해석되지 않는다. `/schedule/page.tsx` 는 repo 를 직접 import 한다.
 *
 * ── 직렬화 규칙 ──────────────────────────────────────────────────────────────
 * `Date` 는 JSON 으로 나갈 수 없다. Route Handler 가 ISO 문자열로 내보내고
 * (`*Wire` 타입) 여기서 `new Date(...)` 로 되돌린다. 컴포넌트는 `Date` 를 기대하므로
 * 이 되돌리기를 빠뜨리면 화면이 조용히 깨진다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 전송 타입(wire) — Route Handler 와 공유한다
// ─────────────────────────────────────────────────────────────────────────────

/** `ScheduledRun` 에서 `scheduledAt` 만 ISO 문자열로 바뀐 모양. */
export interface ScheduledRunWire
  extends Omit<ScheduledRun, "scheduledAt"> {
  readonly scheduledAt: string | null;
}

export interface AvailabilityIntervalWire
  extends Omit<AvailabilityInterval, "startsAt" | "endsAt"> {
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface OverlapWindowWire
  extends Omit<OverlapWindow, "startsAt" | "endsAt"> {
  readonly startsAt: string;
  readonly endsAt: string;
}

/** `CreateRunInput` 의 요청 본문 모양. `scheduledAt` 만 ISO 문자열이다. */
export interface CreateRunBody
  extends Omit<CreateRunInput, "partyId" | "scheduledAt"> {
  readonly scheduledAt: string;
}

export interface PartiesResponse {
  readonly parties: readonly Party[];
}
export interface PartyResponse {
  readonly party: Party;
}
export interface PartyMembersResponse {
  readonly members: readonly PartyMember[];
}
export interface PartyRunsResponse {
  readonly runs: readonly ScheduledRunWire[];
}
export interface PartyRunResponse {
  readonly run: ScheduledRunWire;
}
export interface AvailabilityIntervalsResponse {
  readonly intervals: readonly AvailabilityIntervalWire[];
}
export interface AvailabilityOverlapResponse {
  readonly overlap: readonly OverlapWindowWire[];
}
export interface AvailabilityExceptionsResponse {
  readonly exceptions: readonly AvailabilityException[];
}
export interface BossCatalogResponse {
  readonly bosses: readonly BossCatalogEntry[];
}
export interface PeoplePoolResponse {
  readonly people: readonly Person[];
}
export interface RunCharactersResponse {
  readonly characters: readonly RunCharacterOption[];
}
export interface RunSignupResponse {
  readonly participants: readonly RunParticipant[];
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch 래퍼
// ─────────────────────────────────────────────────────────────────────────────

interface ApiErrorShape {
  readonly error: { readonly message?: unknown };
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = (body as Partial<ApiErrorShape>).error;
  if (typeof candidate !== "object" || candidate === null) return null;
  const message = (candidate as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * 실패는 **`Error` 하나로** 접는다. 화면(`ErrorState`)은 상태 코드가 아니라
 * "실패했다"만 알면 되고, TanStack Query 의 `isError` 가 그대로 에러 UI 를 켠다.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    // 세션 쿠키가 실려야 한다. 기본값이지만 의도를 남긴다.
    credentials: "same-origin",
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      extractMessage(body) ??
        `[schedule] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
    );
  }
  return body as T;
}

function personQuery(personIds: readonly PersonId[], range: TimeRange) {
  return new URLSearchParams({
    personIds: personIds.join(","),
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 볼 수 있는 파티 목록 — 내 파티 먼저, 그 다음 공개 파티.
 *
 * ★ 파티는 **여러 개다.** 보스마다 같이 가는 사람이 다르기 때문이다.
 */
export async function fetchParties(): Promise<readonly Party[]> {
  const body = await request<PartiesResponse>("/api/schedule/parties");
  return body.parties;
}

export async function fetchParty(partyId: PartyId): Promise<Party> {
  const parties = await fetchParties();
  const party = parties.find((entry) => entry.partyId === partyId);
  if (party === undefined) {
    throw new Error(`[schedule] 파티를 찾을 수 없습니다: ${partyId}`);
  }
  return party;
}

/**
 * 그 파티의 구성원.
 *
 * ⚠️ **번호(`seatNo` ← `party_participants.member_no`)는 파티 단위다.**
 *    같은 사람이 파티마다 다른 번호를 갖고, 번호는 **연속이 아닐 수 있다**.
 */
export async function fetchPartyMembers(
  partyId: PartyId,
): Promise<readonly PartyMember[]> {
  if (partyId === "") return [];
  const body = await request<PartyMembersResponse>(
    `/api/schedule/parties/${encodeURIComponent(partyId)}/members`,
  );
  return body.members;
}

/**
 * 파티에 넣을 수 있는 사람 후보 — 본인 / 수락된 친구 / 같은 파티 구성원(게스트 포함).
 * 가용시간 열람 범위(`can_view_availability`)와 **같은 모집단**이다.
 */
export async function fetchPeoplePool(): Promise<readonly Person[]> {
  const body = await request<PeoplePoolResponse>("/api/schedule/people");
  return body.people;
}

/** 이름이 비었을 때 구성원으로 만드는 표시명. 예) `우레푸 외 3명` */
export function summarizePartyName(memberNames: readonly string[]): string {
  if (memberNames.length === 0) return "새 파티";
  if (memberNames.length === 1) return memberNames[0];
  return `${memberNames[0]} 외 ${memberNames.length - 1}명`;
}

/** 새 파티. **세션이 필요하다** — 서버가 401 로 거른다. */
export async function createParty(input: CreatePartyInput): Promise<Party> {
  const body = await request<PartyResponse>("/api/schedule/parties", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.party;
}

/**
 * 로스터 편집.
 *
 * ★ **빠진 번호는 비운 채로 두고 재사용하지 않는다** (§1.4).
 *   3번이 나가면 4번은 계속 4번이고, 새 사람은 `max + 1` 을 받는다.
 */
export async function updatePartyRoster(
  input: UpdatePartyRosterInput,
): Promise<readonly PartyMember[]> {
  const body = await request<PartyMembersResponse>(
    `/api/schedule/parties/${encodeURIComponent(input.partyId)}/members`,
    {
      method: "PUT",
      body: JSON.stringify({ memberPersonIds: input.memberPersonIds }),
    },
  );
  return body.members;
}

// ─────────────────────────────────────────────────────────────────────────────
// 가용 시간 (핵심 화면 왼쪽 패널)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * → `public.resolve_availability(p_person_ids, p_from, p_to)`
 *
 * ⚠️ **비로그인은 빈 배열이다.** `can_view_availability()` 가 열람자 없이는 무조건
 *    false 라서다. 에러가 아니라 정상적인 빈 상태다.
 */
export async function fetchAvailability(
  personIds: readonly PersonId[],
  range: TimeRange,
): Promise<readonly AvailabilityInterval[]> {
  if (personIds.length === 0) return [];

  const query = personQuery(personIds, range);
  query.set("kind", "intervals");
  const body = await request<AvailabilityIntervalsResponse>(
    `/api/schedule/availability?${query.toString()}`,
  );
  return body.intervals.map((row) => ({
    ...row,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
}

/** → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count)` */
export async function fetchAvailabilityOverlap(
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
): Promise<readonly OverlapWindow[]> {
  if (personIds.length === 0) return [];

  const query = personQuery(personIds, range);
  query.set("kind", "overlap");
  query.set("minCount", String(minCount));
  const body = await request<AvailabilityOverlapResponse>(
    `/api/schedule/availability?${query.toString()}`,
  );
  return body.overlap.map((row) => ({
    ...row,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
}

/**
 * → `select * from public.availability_exceptions where …`
 *
 * 예외는 **뺄셈 전용**이라 `resolve_availability` 결과에는 흔적이 남지 않는다 —
 * 그냥 그만큼 짧아질 뿐이다. "어디가 왜 깎였는지"를 화면에 보여 주려면 이 조회가 따로 필요하다.
 */
export async function fetchAvailabilityExceptions(
  personIds: readonly PersonId[],
  range: TimeRange,
): Promise<readonly AvailabilityException[]> {
  if (personIds.length === 0) return [];

  const query = personQuery(personIds, range);
  query.set("kind", "exceptions");
  const body = await request<AvailabilityExceptionsResponse>(
    `/api/schedule/availability?${query.toString()}`,
  );
  return body.exceptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 마스터
// ─────────────────────────────────────────────────────────────────────────────

/** → `select * from public.v_boss_catalog order by sort_order` */
export async function fetchBossCatalog(): Promise<readonly BossCatalogEntry[]> {
  const body = await request<BossCatalogResponse>("/api/schedule/bosses");
  return body.bosses;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 런(일정) — **파티에 속한다**
// ─────────────────────────────────────────────────────────────────────────────

function reviveRun(wire: ScheduledRunWire): ScheduledRun {
  return {
    ...wire,
    scheduledAt: wire.scheduledAt === null ? null : new Date(wire.scheduledAt),
  };
}

/** → `party_runs` × `v_boss_catalog`, `(party_id, week_key, scheduled_at)` 인덱스를 탄다. */
export async function fetchPartyRuns(
  partyId: PartyId,
  weekKey: WeekKey,
): Promise<readonly ScheduledRun[]> {
  if (partyId === "") return [];

  const query = new URLSearchParams({ weekKey });
  const body = await request<PartyRunsResponse>(
    `/api/schedule/parties/${encodeURIComponent(partyId)}/runs?${query.toString()}`,
  );
  return body.runs.map(reviveRun);
}

/**
 * 일정 등록. **세션이 필요하다.**
 *
 * ⚠️ `entryPartySize` 는 "실제로 몇 명이 입장했는가"이며 사용자가 고칠 수 있다(§1.3 D3).
 * ⚠️ `max_party` 초과는 **막지 않는다.** 소프트 상한이라 앱이 경고만 한다(§1.3 D5).
 */
export async function createPartyRun(
  input: CreateRunInput,
): Promise<ScheduledRun> {
  if (input.entryPartySize < 1) {
    throw new Error("[schedule] 파티 인원수는 1명 이상이어야 합니다.");
  }

  const payload: CreateRunBody = {
    bossDifficultyId: input.bossDifficultyId,
    scheduledAt: input.scheduledAt.toISOString(),
    durationMinutes: input.durationMinutes,
    entryPartySize: input.entryPartySize,
    participantPersonIds: input.participantPersonIds,
    // 캐릭터는 **필수**다. 서버가 소유·추적 여부를 다시 확인하고 아니면 400 을 준다.
    characterId: input.characterId,
    note: input.note,
  };

  const body = await request<PartyRunResponse>(
    `/api/schedule/parties/${encodeURIComponent(input.partyId)}/runs`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return reviveRun(body.run);
}

// ─────────────────────────────────────────────────────────────────────────────
// 참가 신청 — **어느 캐릭터로 가는지**를 함께 보낸다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 일정에 데려갈 수 있는 내 캐릭터(추적 대상만 — §2.1.1).
 * → `GET /api/schedule/characters` (**우리 DB 만 읽는다. 넥슨 호출 0건.**)
 *
 * ⚠️ 비로그인은 서버가 401 이다. 화면은 세션이 있을 때만 이 쿼리를 켠다.
 */
export async function fetchMyRunCharacters(): Promise<
  readonly RunCharacterOption[]
> {
  const body = await request<RunCharactersResponse>("/api/schedule/characters");
  return body.characters;
}

/**
 * 참가 신청 / 캐릭터 변경. **세션이 필요하다.**
 *
 * ★ 본인 행만 바뀐다 — 남이 어느 캐릭터로 갈지는 본인만 아는 정보다.
 */
export async function saveRunSignup(
  input: SaveRunSignupInput,
): Promise<readonly RunParticipant[]> {
  const body = await request<RunSignupResponse>(
    `/api/schedule/runs/${encodeURIComponent(input.runId)}/signup`,
    {
      method: "PUT",
      body: JSON.stringify({
        characterId: input.characterId,
        status: input.status,
      }),
    },
  );
  return body.participants;
}
