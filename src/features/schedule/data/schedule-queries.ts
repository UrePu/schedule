import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityInterval,
  AvailabilityPattern,
  AvailabilityPatternInput,
  BossCatalogEntry,
  CreatePartyInput,
  CreateRunBundleInput,
  CreateRunInput,
  OverlapWindow,
  Party,
  PartyBoss,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
  RunCommitment,
  RunId,
  RunParticipant,
  RunRemovalOutcome,
  SaveRunSignupInput,
  ScheduledRun,
  SetPartyBossesInput,
  TimeRange,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
  UpdateRunInput,
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

export interface RunCommitmentWire
  extends Omit<RunCommitment, "startsAt" | "endsAt"> {
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * 일정 등록 요청 본문. `scheduledAt` 만 ISO 문자열이다.
 *
 * ★ 보스를 **배열로** 보낸다. 단건 등록은 길이 1 인 배열일 뿐이라 서버 구현이 하나다.
 *   (예전 `bossDifficultyId` 단수 필드는 서버가 여전히 받아 주지만 새 호출은 쓰지 않는다.)
 */
export interface CreateRunBody
  extends Omit<
    CreateRunInput,
    "partyId" | "scheduledAt" | "bossDifficultyId"
  > {
  readonly scheduledAt: string;
  readonly bossDifficultyIds: readonly string[];
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
/**
 * 등록 결과.
 *
 * `run` 은 **첫 번째 런**이고 `runs` 가 전부다. 묶음으로 3개를 잡아도 화면이 마지막
 * 하나만 보고 있으면 나머지 둘이 조용히 사라진 것처럼 보이므로 둘 다 싣는다.
 */
export interface PartyRunResponse {
  readonly run: ScheduledRunWire;
  readonly runs: readonly ScheduledRunWire[];
}
/** 파티에 등록된 보스 목록. 저장 응답에는 제목이 바뀐 파티도 함께 실린다. */
export interface PartyBossesResponse {
  readonly bosses: readonly PartyBoss[];
}
export interface PartyBossesSaveResponse {
  readonly bosses: readonly PartyBoss[];
  readonly party: Party;
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
/**
 * 이미 등록된 런이 잡아먹은 시간. **비어 있는 것이 정상**이다 —
 * 잡아 둔 일정이 없거나, 마이그레이션이 아직 안 들어갔거나(§ repo 폴백).
 */
export interface RunCommitmentsResponse {
  readonly commitments: readonly RunCommitmentWire[];
}
/**
 * 패턴·예외에는 `Date` 가 없다 — 요일 번호와 KST 벽시계 **분**, 그리고 `yyyy-MM-dd`
 * 날짜 키뿐이라 JSON 을 그대로 실어 보낼 수 있다. 그래서 `*Wire` 타입도 되돌리기도 없다.
 * (이건 우연이 아니라 설계다: 절대 시각으로 저장하면 "매주 21시"가 서머타임·시간대에
 *  휘둘린다. 반복 패턴의 진실은 벽시계다.)
 */
export interface AvailabilityPatternsResponse {
  readonly patterns: readonly AvailabilityPattern[];
}
export interface AvailabilityExceptionResponse {
  readonly exception: AvailabilityException;
}
export interface DeletedExceptionResponse {
  readonly deletedId: string;
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

/**
 * 일정 **수정** 응답. ← `PATCH /api/schedule/runs/{runId}`
 *
 * ★ `previousWeekKey ≠ weekKey` 면 화면이 **두 주차를 모두** 무효화해야 한다. 시각을
 *   다음 주로 옮기면 이번 주 목록에서는 사라지고 다음 주 목록에 나타나는데, 한쪽만
 *   날리면 나머지 한쪽이 유령 항목을 들고 남는다.
 * ★ 이 타입이 **여기**에 사는 이유는 다른 wire 타입과 같다 — Route Handler 와 브라우저가
 *   같은 모양을 공유해야 하고, 그 계약의 주인은 데이터 접근 경계인 이 파일이다.
 *   (예전에는 라우트 파일이 export 했는데, 그러면 화면이 서버 모듈을 import 하게 된다.)
 */
export interface RunEditResponse {
  readonly run: ScheduledRunWire;
  readonly partyId: string;
  readonly weekKey: WeekKey;
  readonly previousWeekKey: WeekKey;
  readonly runs: readonly ScheduledRunWire[];
}

/** 일정 **취소/삭제** 응답. `outcome` 이 서버가 실제로 무엇을 했는지 말한다. */
export interface RunRemovalResponse {
  readonly outcome: RunRemovalOutcome;
  readonly runId: string;
  readonly partyId: string;
  readonly weekKey: WeekKey;
  readonly runs: readonly ScheduledRunWire[];
}

/** 되살린 뒤 화면이 쓰는 모양(`Date` 로 되돌린 `runs`). */
export interface RunEditResult
  extends Omit<RunEditResponse, "run" | "runs"> {
  readonly run: ScheduledRun;
  readonly runs: readonly ScheduledRun[];
}

export interface RunRemovalResult extends Omit<RunRemovalResponse, "runs"> {
  readonly runs: readonly ScheduledRun[];
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

/**
 * 새 파티. **세션이 필요하다** — 서버가 401 로 거른다.
 *
 * ★ `guestNames` 로 **닉네임만 있는 사람도 함께 넣는다.** 상대가 아직 이 앱을 쓰지
 *   않아도 파티가 성립해야 한다는 것이 발주 요구였다. 게스트도 번호를 받고, 나중에
 *   초대 링크로 계정을 승계해도 그 번호는 유지된다 (§1.4).
 */
export async function createParty(input: CreatePartyInput): Promise<Party> {
  const body = await request<PartyResponse>("/api/schedule/parties", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      memberPersonIds: input.memberPersonIds,
      guestNames: input.guestNames ?? [],
      // 순서가 곧 묶음 제목의 순서다(`익세 하대 하카`). 여기서 정렬하지 않는다.
      bossDifficultyIds: input.bossDifficultyIds ?? [],
    }),
  });
  return body.party;
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티의 보스 목록 — "이 묶음은 익세 → 하대 → 하카를 돈다"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * → `GET /api/schedule/parties/{id}/bosses`
 *
 * ⚠️ **비로그인도 200 이다.** 공개 파티라면 무엇을 도는 묶음인지 보여야 한다.
 *    볼 수 없는 파티는 404 이고, 마이그레이션 미적용이면 빈 배열이다(에러가 아니다).
 */
export async function fetchPartyBosses(
  partyId: PartyId,
): Promise<readonly PartyBoss[]> {
  if (partyId === "") return [];
  const body = await request<PartyBossesResponse>(
    `/api/schedule/parties/${encodeURIComponent(partyId)}/bosses`,
  );
  return body.bosses;
}

/**
 * 보스 목록 **전체 교체**(추가·삭제·순서 변경이 전부 이 하나다). **세션이 필요하다.**
 *
 * ★ 응답에 **파티가 함께 온다.** `name_is_custom = false` 인 파티는 저장과 동시에 제목이
 *   `익세 하대 하카 2인` 으로 다시 만들어지므로, 화면이 그 사실을 바로 반영해야 한다.
 * ★ 빈 배열은 "전부 지운다"이며 정상 입력이다.
 */
export async function savePartyBosses(
  input: SetPartyBossesInput,
): Promise<PartyBossesSaveResponse> {
  return request<PartyBossesSaveResponse>(
    `/api/schedule/parties/${encodeURIComponent(input.partyId)}/bosses`,
    {
      method: "PUT",
      body: JSON.stringify({ bossDifficultyIds: input.bossDifficultyIds }),
    },
  );
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
      body: JSON.stringify({
        memberPersonIds: input.memberPersonIds,
        // 새로 만들 게스트만. 이미 있는 게스트는 `memberPersonIds` 쪽이다.
        guestNames: input.guestNames ?? [],
      }),
    },
  );
  return body.members;
}

/**
 * **이 파티에 데려갈 내 캐릭터**를 정한다 (`party_participants.character_id`).
 *
 * ★ 바뀌는 것은 **내 행 하나**다. 서버가 세션으로 대상을 정하므로 "누구의"를 보낼 자리가
 *   없다 — 남이 어느 캐릭터로 갈지는 본인만 아는 정보다.
 * ★ `characterId: null` 은 지정 해제이며 정상 입력이다.
 * ★ 표시(`더저(메검메)`)는 저장 문자열이 아니라 **읽을 때 조합**된다 —
 *   `lib/domain/participant-label.ts` 가 그 규칙의 유일한 주인이다.
 */
export async function updateMyPartyCharacter(
  input: UpdatePartyCharacterInput,
): Promise<readonly PartyMember[]> {
  const body = await request<PartyMembersResponse>(
    `/api/schedule/parties/${encodeURIComponent(input.partyId)}/character`,
    {
      method: "PUT",
      body: JSON.stringify({ characterId: input.characterId }),
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

/**
 * → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count[, p_exclude_run_id])`
 *
 * ★ 이 답에서는 **이미 등록된 런이 잡아먹은 시간이 빠져 있다**(2026-08-18). 한 사람이
 *   같은 시각에 보스 둘을 도는 일정은 성립하지 않기 때문이다. 무엇이 빠졌는지는
 *   `fetchRunCommitments` 가 따로 알려 주고, 화면은 그것을 "이미 일정 있음" 으로 그린다.
 * ★ `excludeRunId` = **수정 중인 런 하나를 점유에서 뺀다.** 없으면 그 런이 자기 자신을
 *   막아 시각을 옮길 수 없다.
 */
export async function fetchAvailabilityOverlap(
  personIds: readonly PersonId[],
  range: TimeRange,
  minCount: number,
  excludeRunId: RunId | null = null,
): Promise<readonly OverlapWindow[]> {
  if (personIds.length === 0) return [];

  const query = personQuery(personIds, range);
  query.set("kind", "overlap");
  query.set("minCount", String(minCount));
  if (excludeRunId !== null) query.set("excludeRunId", excludeRunId);
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

/**
 * → `public.person_run_commitments(p_person_ids, p_from, p_to, p_exclude_run_id)`
 *
 * **이미 등록된 보스 일정이 잡아먹은 시간.** 겹침 질의는 이 구간을 이미 뺀 답을 주지만,
 * 화면은 그 사실을 **보여 줘야** 한다 — 가능 시간이 조용히 줄기만 하면 사용자에게는
 * "왜 안 되지?" 만 남는다. 그래서 조회가 따로 있다(예외 조회와 완전히 같은 이유다).
 *
 * ⚠️ **빈 배열이 정상 상태다.** 잡아 둔 일정이 없거나, 비로그인이라 열람 권한이 없거나,
 *    마이그레이션이 아직 안 들어갔을 때 전부 빈 배열이다. 오류가 아니다.
 */
export async function fetchRunCommitments(
  personIds: readonly PersonId[],
  range: TimeRange,
  excludeRunId: RunId | null = null,
): Promise<readonly RunCommitment[]> {
  if (personIds.length === 0) return [];

  const query = personQuery(personIds, range);
  query.set("kind", "commitments");
  if (excludeRunId !== null) query.set("excludeRunId", excludeRunId);
  const body = await request<RunCommitmentsResponse>(
    `/api/schedule/availability?${query.toString()}`,
  );
  return body.commitments.map((row) => ({
    ...row,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 가용 시간 **쓰기** — 대상은 언제나 세션 본인
// ─────────────────────────────────────────────────────────────────────────────

/**
 * → `GET /api/schedule/availability/patterns`
 *
 * ⚠️ **비로그인은 401 이다**(빈 배열이 아니다). 조회 쪽과 규칙이 다른 이유는 이것이
 *    공개 시간표가 아니라 **내 편집 원본**이기 때문이다. 화면은 세션이 있을 때만 켠다.
 */
export async function fetchMyAvailabilityPatterns(): Promise<
  readonly AvailabilityPattern[]
> {
  const body = await request<AvailabilityPatternsResponse>(
    "/api/schedule/availability/patterns",
  );
  return body.patterns;
}

/**
 * → `PUT /api/schedule/availability/patterns` — 내 패턴 **전체 교체**.
 *
 * ★ 자정 넘김은 `endMinute > 1440` 한 줄로 보낸다. 수 22:00~02:00 = `{3, 1320, 1560}`.
 *   두 줄로 쪼개 보내면 되돌려 읽을 때 사용자의 의도가 이미 사라진 뒤다 (§1.4).
 */
export async function saveMyAvailabilityPatterns(
  patterns: readonly AvailabilityPatternInput[],
): Promise<readonly AvailabilityPattern[]> {
  const body = await request<AvailabilityPatternsResponse>(
    "/api/schedule/availability/patterns",
    { method: "PUT", body: JSON.stringify({ patterns }) },
  );
  return body.patterns;
}

/**
 * → `POST /api/schedule/availability/exceptions` — "이 날(또는 이 시간)은 안 됨".
 *
 * ★ **뺄셈만 한다.** 사유를 보낼 자리가 없고, 패턴에 없는 시간을 더할 수도 없다 (§1.4).
 */
export async function createAvailabilityException(
  input: AvailabilityExceptionInput,
): Promise<AvailabilityException> {
  const body = await request<AvailabilityExceptionResponse>(
    "/api/schedule/availability/exceptions",
    { method: "POST", body: JSON.stringify(input) },
  );
  return body.exception;
}

/** → `DELETE /api/schedule/availability/exceptions?id=…` (내 것만 지워진다) */
export async function deleteAvailabilityException(
  exceptionId: string,
): Promise<string> {
  const query = new URLSearchParams({ id: exceptionId });
  const body = await request<DeletedExceptionResponse>(
    `/api/schedule/availability/exceptions?${query.toString()}`,
    { method: "DELETE" },
  );
  return body.deletedId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 마스터
// ─────────────────────────────────────────────────────────────────────────────

/**
 * → `select * from public.v_boss_catalog order by sort_order desc`
 *
 * **최신 보스가 맨 위다.** 순서의 주인은 서버(`schedule-repo.fetchBossCatalog`) 하나이고
 * 화면은 받은 차례를 그대로 그린다 — 세 화면이 각자 뒤집으면 순서가 갈라진다.
 */
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
  const runs = await createPartyRunBundle({
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
  if (run === undefined) {
    throw new Error("[schedule] 일정이 등록되지 않았습니다.");
  }
  return run;
}

/**
 * **묶음 등록** — 체크한 보스들을 시작 시각 하나로 **연달아** 잡는다.
 *
 * ★ 서버가 i 번째 보스를 `시작 + durationMinutes × i` 에 놓는다. 여기서 시각을 미리
 *   벌려 보내지 않는 이유는, 배치 규칙이 두 곳에 생기면 화면 미리보기와 실제 저장이
 *   조용히 갈라지기 때문이다. 화면은 **같은 규칙으로 미리보기만** 그린다.
 * ★ 배열 순서가 등록 순서이고, 그 순서대로 `run_no` 가 `max + 1` 로 붙는다 (§1.4).
 */
export async function createPartyRunBundle(
  input: CreateRunBundleInput,
): Promise<readonly ScheduledRun[]> {
  if (input.entryPartySize < 1) {
    throw new Error("[schedule] 파티 인원수는 1명 이상이어야 합니다.");
  }
  if (input.bossDifficultyIds.length === 0) {
    throw new Error("[schedule] 등록할 보스를 하나 이상 선택해 주세요.");
  }

  const payload: CreateRunBody = {
    bossDifficultyIds: [...input.bossDifficultyIds],
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
  return body.runs.map(reviveRun);
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

// ─────────────────────────────────────────────────────────────────────────────
// 일정 수정 · 취소/삭제
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 일정 수정(부분 수정). **세션이 필요하다.**
 *
 * ★ **`runNo` 를 보낼 자리가 없다** (§1.4 — 번호는 재부여하지 않는다).
 * ★ `scheduledAt: null` 은 **시각 미정으로 되돌린다**는 뜻이고 `undefined`(안 보냄)와
 *   다르다. 두 값을 접으면 "메모만 고치려다 시각이 지워지는" 사고가 난다.
 * ★ `cancelled: false` 만 받는다 = **취소 되돌리기.** 취소는 `removePartyRun` 하나가
 *   소유한다 — 같은 일을 두 경로가 하면 반드시 갈라진다.
 *
 * ⚠️ 서버가 **409** 로 거절하는 두 경우가 있고, 문구는 서버가 한국어로 준다.
 *    (취소된 런 수정 · 클리어가 붙은 런의 주차 이동) `request()` 가 그 문구를 그대로
 *    `Error.message` 로 올리므로 화면은 그것을 보여 주기만 하면 된다.
 */
export async function updatePartyRun(
  input: UpdateRunInput,
): Promise<RunEditResult> {
  const { runId, scheduledAt, ...rest } = input;
  const payload: Record<string, unknown> = { ...rest };
  if (scheduledAt !== undefined) {
    payload.scheduledAt = scheduledAt === null ? null : scheduledAt.toISOString();
  }

  const body = await request<RunEditResponse>(
    `/api/schedule/runs/${encodeURIComponent(runId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
  return {
    ...body,
    run: reviveRun(body.run),
    runs: body.runs.map(reviveRun),
  };
}

/**
 * 일정 **취소 또는 삭제**. 어느 쪽인지는 **서버가 판정한다.**
 *
 * ★ 클라이언트가 "클리어 붙었나요?" 를 먼저 묻고 다시 부르는 왕복을 만들지 않는다.
 *   그 사이에 같이 간 사람이 클리어를 체크하면 판정이 뒤집히고, 클라이언트는 이미 틀린
 *   답을 들고 있다. 무엇을 했는지는 응답의 `outcome` 이 말하고, 화면은 그것을 그대로
 *   사용자에게 옮긴다.
 */
export async function removePartyRun(
  runId: RunId,
): Promise<RunRemovalResult> {
  const body = await request<RunRemovalResponse>(
    `/api/schedule/runs/${encodeURIComponent(runId)}`,
    { method: "DELETE" },
  );
  return { ...body, runs: body.runs.map(reviveRun) };
}
