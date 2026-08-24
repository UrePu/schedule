import { PROXY_API_KEY_HEADER } from "@/lib/nexon/constants";

import type {
  CharacterPlanResponse,
  ChecklistResponse,
  ResetPlanInput,
  SetPlanInput,
  SetPlanPartySizeInput,
  SyncResult,
} from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 계획 · 주간 체크리스트 — **브라우저 쪽 데이터 접근 경계**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 이 파일의 함수만 부른다. 본문은 전부 `/api/boss-plans/...` 호출이다.
 *
 * ⚠️ **Supabase 를 직접 부르지 않는다.** `character_boss_plans` 와 뷰 3종, 함수 3종은
 *    전부 service_role 전용이라(마이그레이션 19-10) 브라우저에는 권한 자체가 없다.
 *    이 파일에는 `fetch` 밖에 없으므로 service_role 키가 이 경로로 샐 수 없다.
 *
 * ⚠️ **동기화만 넥슨을 탄다.** 그것도 사용자가 버튼을 눌렀을 때 나가는 **mutation** 이라
 *    TanStack Query 의 staleTime 개념이 없다 — `nexonQueryOptions` 의 15분 하한은
 *    "주기적으로 다시 물어보는 조회"에 대한 규칙이고, 여기에는 적용 대상이 없다.
 *    나머지 조회는 전부 우리 DB 이므로 `"db"` 네임스페이스 + 전역 기본값(60초)을 쓴다.
 */

interface ApiErrorShape {
  readonly error: {
    readonly message?: unknown;
    readonly kind?: unknown;
    readonly code?: unknown;
  };
}

function readErrorField(body: unknown, field: keyof ApiErrorShape["error"]) {
  if (typeof body !== "object" || body === null) return null;
  const candidate = (body as Partial<ApiErrorShape>).error;
  if (typeof candidate !== "object" || candidate === null) return null;
  const value = (candidate as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * 서버가 준 **실패의 종류**까지 들고 다니는 에러.
 *
 * `Error` 를 상속하므로 기존 화면의 `error.message` 는 그대로 동작한다.
 * `kind` 를 따로 싣는 이유는 **자동 동기화 배치가 "계속할지 멈출지"를 판정**해야 하기
 * 때문이다(`lib/scheduler-freshness.ts`). 문구로 분기하면 문구를 다듬는 순간 조용히
 * 깨지므로, `ApiErrorBody.kind` 라는 기계용 축을 그대로 쓴다.
 *
 * ⚠️ 화면 문구는 계속 `message` 를 쓴다. `kind` 는 **제어 흐름 전용**이다.
 */
export class BossPlanRequestError extends Error {
  /** ← `ApiErrorBody.error.kind`. 본문을 못 읽었으면 `null`. */
  readonly kind: string | null;
  /** ← 넥슨 원본 코드(`OPENAPI00007` 등). 진단용. */
  readonly code: string | null;

  constructor(message: string, kind: string | null, code: string | null) {
    super(message);
    this.name = "BossPlanRequestError";
    this.kind = kind;
    this.code = code;
  }
}

/**
 * 실패는 **`BossPlanRequestError` 하나로** 접는다. 화면(`ErrorState`)은 상태 코드가
 * 아니라 "실패했다"만 알면 되고, 서버가 준 한국어 문구를 그대로 보여 준다 — 특히 동기화
 * 실패는 "키가 없다 / 쿼터 초과 / 추적 대상이 아니다" 가 서로 다른 조치를 요구한다.
 */
async function request<T>(
  path: string,
  init?: RequestInit & { readonly apiKey?: string | null },
): Promise<T> {
  const headers = new Headers(init?.headers);
  // 키가 없으면 헤더를 붙이지 않는다 — 서버가 DB 에서 꺼내 쓴다(§2.1.2). 오류가 아니다.
  if (init?.apiKey !== undefined && init.apiKey !== null && init.apiKey !== "") {
    // ★ 키는 **헤더로만**. 쿼리에 실으면 브라우저 히스토리와 액세스 로그에 남는다.
    headers.set(PROXY_API_KEY_HEADER, init.apiKey);
  }
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
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
    throw new BossPlanRequestError(
      readErrorField(body, "message") ??
        `[boss-plans] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
      readErrorField(body, "kind"),
      readErrorField(body, "code"),
    );
  }
  return body as T;
}

/** 대시보드 첫 화면 — 추적 캐릭터 전원의 주간 체크리스트. **넥슨 호출 0건.** */
export function fetchWeeklyChecklist(): Promise<ChecklistResponse> {
  return request<ChecklistResponse>("/api/boss-plans/checklist");
}

/** 캐릭터 하나의 계획 전체 + 이번 주 진행 상황. **넥슨 호출 0건.** */
export function fetchCharacterPlans(
  characterId: string,
): Promise<CharacterPlanResponse> {
  const query = new URLSearchParams({ characterId });
  return request<CharacterPlanResponse>(`/api/boss-plans?${query.toString()}`);
}

/**
 * 계획을 켜거나 끈다.
 *
 * ★ **끄기는 되돌아오지 않는다.** `manual_active = false` 라는 묘비가 남고 트리거의
 *   `coalesce` 가 그것을 집으므로, 다음 동기화가 넥슨의 `registration_flag = true` 를
 *   봐도 이 보스는 꺼진 채로 있다(발주자 지시, 2026-08-18).
 * ★ **13번째 주간 보스 켜기는 서버가 거절한다.** 2025-08-21 패치 이후 13번째는 입장
 *   자체가 불가능해(§1) 저장해 주는 것이 곧 거짓말이 된다. 실패는 `BossPlanRequestError`
 *   로 오고 문구가 무엇을 꺼야 하는지 말한다. **월간은 그 12에 들어가지 않는다.**
 *   ⚠️ 판정을 여기(브라우저)에 다시 적지 않는다 — 규칙이 두 벌이 되면 반드시 갈라진다.
 */
export function setCharacterBossPlan(
  input: SetPlanInput,
): Promise<CharacterPlanResponse> {
  return request<CharacterPlanResponse>("/api/boss-plans", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * **내 판단을 지우고 인게임 목록에 맡긴다.**
 *
 * ⚠️ 목록에서 빼려는 것이라면 이 함수가 아니라 `setCharacterBossPlan({ active: false })`
 *    다. 이쪽은 판단 자체를 지우므로 **넥슨이 등록 중인 보스는 다시 나타난다** — 버그가
 *    아니라 이 동작의 정의다. 화면은 그 사실을 확인창으로 먼저 말한 뒤에만 부른다.
 * ⚠️ 넥슨이 한 번도 말한 적 없는 보스(손으로 추가한 행)는 되살릴 값이 없으므로 서버가
 *    행을 지운다. 난이도를 잘못 골라 추가한 것을 되돌리는 길이 그 갈래다.
 */
export function resetCharacterBossPlanToApi(
  input: ResetPlanInput,
): Promise<CharacterPlanResponse> {
  const query = new URLSearchParams({
    characterId: input.characterId,
    bossDifficultyId: input.bossDifficultyId,
  });
  return request<CharacterPlanResponse>(`/api/boss-plans?${query.toString()}`, {
    method: "DELETE",
  });
}

/**
 * "이 보스는 몇 인으로 도는가"를 정한다. `partySize: null` 은 **설정 해제**다.
 *
 * ★ 이 값은 **앞으로 생길 클리어의 기본값**이다. 이미 쌓인 클리어는 한 건도 바뀌지 않는다
 *   — 사용자가 손으로 고쳐 둔 인원을 나중의 기본값이 덮으면 §1.3 D3 을 정확히 거스른다.
 * ★ `max_party` 초과도 저장된다(§1.3 D5). 막지 않고 화면이 주황으로 경고만 한다.
 */
export function setCharacterBossPlanPartySize(
  input: SetPlanPartySizeInput,
): Promise<CharacterPlanResponse> {
  return request<CharacterPlanResponse>("/api/boss-plans/party-size", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/*
 * ★ 2026-08-19 삭제 — 이미 쌓인 클리어에 계획 인원수를 **일괄 소급**하던 함수.
 *   `POST /api/boss-plans/party-size` 를 부르던 함수였고, 그 라우트의 POST 도 함께 없앴다.
 *   DB 쪽 대상 조건이 `boss_clears.party_size_confirmed = false` 인데 기본 인원 1인
 *   확정(마이그레이션 25) 이후 미확인 행이 하나도 남지 않아 **언제나 0건**이었다.
 *   인원 교정은 이제 클리어를 한 건씩 고치는 경로로만 한다(발주자 지시: *"개별수정
 *   가능하도록해"*). 인원수 **설정**(`setCharacterBossPlanPartySize`, PUT)은 그대로 살아 있다.
 */

/**
 * 인게임 스케줄러 동기화. **캐릭터당 넥슨 1콜**이다.
 *
 * 부르는 곳은 둘이다(§1.1.1):
 *   1. 대시보드 진입 시 **자동 1회** — 단, 마지막 호출이 15분 지연 창 안이면 건너뛴다.
 *   2. **수동 새로고침 버튼** — 신선도 가드를 우회한다(사용자가 명시적으로 눌렀으므로).
 * 두 경로 모두 `paceNexonRequest()` 를 통과해 초당 5콜 한도를 지킨다.
 *
 * ★ **`apiKey` 는 선택이다**(§2.1.2). 서버가 `characterId` 로 그 캐릭터가 속한 넥슨 계정의
 *   키를 DB 에서 복호화해 부른다. 이 브라우저에 원문이 있으면 함께 보내는데, 이유는
 *   하위 호환과 **백필**(서버에 아직 없는 키를 이 호출의 성공으로 검증해 올린다)이다.
 */
export function syncCharacterScheduler(input: {
  readonly apiKey?: string | null;
  readonly characterId: string;
  /**
   * 사용자가 새로고침을 눌렀는가. 서버 캐시(15분)를 건너뛰고 넥슨을 다시 부른다.
   *
   * ⚠️ **자동 경로에서는 켜지 말 것.** 진입 시 동기화·밤 크론·런 종료 후 동기화까지
   *    우회하면 캐시가 존재할 이유가 없어지고 쿼터만 탄다.
   */
  readonly force?: boolean;
}): Promise<SyncResult> {
  return request<SyncResult>("/api/boss-plans/sync", {
    method: "POST",
    apiKey: input.apiKey ?? null,
    body: JSON.stringify({
      characterId: input.characterId,
      ...(input.force === true ? { force: true } : {}),
    }),
  });
}
