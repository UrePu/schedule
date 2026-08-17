/**
 * 넥슨 API 에러 → **도메인 에러**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 코드를 그대로 올려보내지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면이 `OPENAPI00005` 라는 문자열을 알아야 한다면, 넥슨이 코드를 바꾸는 순간
 * 화면이 깨진다. 게다가 같은 코드가 상황에 따라 다른 뜻을 가진다 —
 * `OPENAPI00004` 는 "없는 캐릭터명"이기도 하고 "조회 범위 밖 날짜"이기도 하고
 * "남의 계정 ocid"이기도 하다(전부 실측). 그래서 **경계에서 한 번만** 도메인 종류로
 * 접고, 그 뒤로는 종류만 다닌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 매핑 근거는 실측이다 (CLAUDE.md §1.0 / Claude/NEXON-API-OBSERVED.md)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이전 문서에 있던 *추정* 매핑 몇 개는 실제와 달랐다. 아래 표는 살아 있는 키로
 * 직접 재현한 것만 담는다. 관측되지 않은 코드는 **`unknown` 으로 떨어뜨리고 코드를
 * 보존한다** — 아는 척하지 않는다.
 *
 * | 상황                                   | HTTP | error.name     | kind                |
 * |----------------------------------------|------|----------------|---------------------|
 * | 없는 캐릭터명 / 범위 밖 date / 남의 ocid | 400  | OPENAPI00004   | `invalid_parameter` |
 * | 잘못된 ocid                             | 400  | OPENAPI00003   | `invalid_id`        |
 * | 없는 경로 (유효 키)                     | 403  | OPENAPI00002   | `forbidden`         |
 * | 무효 키                                 | -    | OPENAPI00005   | `invalid_key`       |
 * | 할당량 초과                             | 429  | OPENAPI00007   | `quota_exceeded`    |
 */

/** 화면과 봇이 분기해야 하는 **유일한** 실패 축. */
export type NexonErrorKind =
  /** API 키가 무효하다. 로그인 화면은 "키를 다시 확인해 주세요"로 끝난다. */
  | "invalid_key"
  /** 하루/초당 호출 한도를 넘겼다. **재시도하지 않는다.** */
  | "quota_exceeded"
  /** 넘긴 파라미터가 넥슨 기준으로 유효하지 않다(없는 캐릭터명, 조회 범위 밖 날짜 등). */
  | "invalid_parameter"
  /** ocid 형식이 잘못됐다. ocid 는 가변값이므로 재해석이 필요하다는 신호다. */
  | "invalid_id"
  /** 그 키로 접근할 수 없는 경로/자원이다. */
  | "forbidden"
  /** 넥슨 쪽 장애(5xx). 우리 잘못이 아니고, 잠시 뒤 다시 하면 된다. */
  | "upstream_unavailable"
  /** 응답이 우리가 아는 스펙과 다르다. **조용히 넘기지 않는다** — 드리프트 신호다. */
  | "schema_mismatch"
  /** 네트워크 실패 / 타임아웃. 응답 자체를 못 받았다. */
  | "network"
  /** 위 어디에도 해당하지 않는다. 코드는 `code` 에 보존된다. */
  | "unknown";

/**
 * 사용자에게 그대로 보여도 되는 한국어 문구. **키·내부 식별자를 담지 않는다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 문구 규칙 — **원인을 말하고, 사용자가 할 일을 말한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * "확인해 주세요"는 행동을 지시하지 않는다. 특히 `invalid_parameter` 의 예전 문구
 * ("캐릭터명이나 조회 날짜를 확인해 주세요")는 **사실이 아니었다** — 실제 원인은
 * "그 캐릭터가 다른 넥슨 계정 소속"이었고, 사용자에게 캐릭터명이나 날짜를 고칠 수단은
 * 애초에 없다. 우리가 만들지 않은 입력을 사용자에게 확인하라고 말하면 안 된다.
 *
 * ⚠️ 여기 있는 것은 **엔드포인트를 모르는 일반 문구**다. 동기화 화면처럼 맥락이 분명한
 *    자리는 `features/boss-plans/lib/sync-failure-message.ts` 가 더 정확한 문장을 만든다.
 */
const KIND_MESSAGE: Record<NexonErrorKind, string> = {
  invalid_key:
    "넥슨 API 키가 유효하지 않습니다. openapi.nexon.com 에서 키를 새로 발급받아 다시 로그인해 주세요.",
  quota_exceeded:
    "넥슨 API 하루 호출 한도를 다 썼습니다. 자동 갱신은 멈추며, 잠시 뒤(또는 내일) 다시 시도하면 됩니다.",
  /*
   * `OPENAPI00004` 는 상황이 셋이다(§1.0 실측): 없는 캐릭터명 · 조회 범위 밖 날짜 ·
   * **남의 계정 ocid**. 우리 화면에서 압도적으로 흔한 것은 세 번째이며, 앞의 둘은
   * 사용자가 입력하는 값도 아니다. 그래서 세 번째를 앞에 두고 조치를 붙인다.
   */
  invalid_parameter:
    "넥슨 API 가 이 요청을 받아들이지 않았습니다. 이 캐릭터가 다른 넥슨 계정 소속이거나 조회 가능한 기간을 벗어난 요청입니다. 계정 · 키 관리에서 그 계정의 API 키를 등록해 주세요.",
  invalid_id:
    "캐릭터 식별자(ocid)가 더 이상 유효하지 않습니다. 캐릭터 선택을 한 번 열어 목록을 새로 받아 주세요.",
  forbidden:
    "이 API 키로는 접근할 수 없는 요청입니다. 키의 권한을 확인하거나 새로 발급해 주세요.",
  upstream_unavailable:
    "넥슨 API 가 일시적으로 응답하지 않습니다. 넥슨 쪽 문제이므로 잠시 뒤 새로고침을 눌러 주세요.",
  schema_mismatch:
    "넥슨 API 응답 형식이 예상과 다릅니다. 저장된 값은 그대로이며, 잠시 뒤 다시 시도해 주세요.",
  network:
    "넥슨 API 에 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 새로고침을 눌러 주세요.",
  unknown: "넥슨 API 요청이 실패했습니다. 잠시 뒤 새로고침을 눌러 주세요.",
};

/** 도메인 종류 → 우리 API 가 브라우저에 돌려줄 HTTP 상태. */
const KIND_HTTP_STATUS: Record<NexonErrorKind, number> = {
  invalid_key: 401,
  quota_exceeded: 429,
  invalid_parameter: 400,
  invalid_id: 400,
  forbidden: 403,
  upstream_unavailable: 502,
  schema_mismatch: 502,
  network: 504,
  unknown: 502,
};

/**
 * 실측으로 확인된 코드만 매핑한다.
 * 여기 없는 코드는 `unknown` 이 되고 `code` 필드에 원본이 남는다.
 */
const CODE_KIND: Readonly<Record<string, NexonErrorKind>> = {
  OPENAPI00002: "forbidden",
  OPENAPI00003: "invalid_id",
  OPENAPI00004: "invalid_parameter",
  OPENAPI00005: "invalid_key",
  OPENAPI00007: "quota_exceeded",
};

export interface NexonApiErrorInit {
  readonly kind: NexonErrorKind;
  /** `error.name` (예: `OPENAPI00005`). 없으면 null. */
  readonly code?: string | null;
  /** 넥슨이 돌려준 HTTP 상태. 네트워크 실패면 null. */
  readonly upstreamStatus?: number | null;
  /** 서버 로그 전용 상세. **응답 본문에 포함되지 않는다.** */
  readonly detail?: string | null;
}

/**
 * 넥슨 호출 실패를 나타내는 단일 에러 타입.
 *
 * ★ **API 키는 이 객체 어디에도 들어가지 않는다.** 생성자가 키를 받지 않으므로
 *   실수로 넣을 방법 자체가 없다.
 */
export class NexonApiError extends Error {
  readonly kind: NexonErrorKind;
  readonly code: string | null;
  readonly upstreamStatus: number | null;
  /** 서버 로그용. `toResponseBody()` 는 이 값을 내보내지 않는다. */
  readonly detail: string | null;

  constructor(init: NexonApiErrorInit) {
    super(KIND_MESSAGE[init.kind]);
    this.name = "NexonApiError";
    this.kind = init.kind;
    this.code = init.code ?? null;
    this.upstreamStatus = init.upstreamStatus ?? null;
    this.detail = init.detail ?? null;
  }

  /** 우리 Route Handler 가 돌려줄 HTTP 상태. */
  get status(): number {
    return KIND_HTTP_STATUS[this.kind];
  }

  /**
   * 브라우저로 나가는 본문.
   * `detail` 은 **의도적으로 제외**한다 — 상류 문구를 그대로 흘리지 않는다.
   */
  toResponseBody(): {
    error: { kind: NexonErrorKind; code: string | null; message: string };
  } {
    return {
      error: { kind: this.kind, code: this.code, message: this.message },
    };
  }
}

export function isNexonApiError(value: unknown): value is NexonApiError {
  return value instanceof NexonApiError;
}

/** 종류 → 한국어 문구. 클라이언트가 자체 문구를 만들 때도 이 표를 쓴다. */
export function nexonErrorMessage(kind: NexonErrorKind): string {
  return KIND_MESSAGE[kind];
}

/** 알려진 종류인지. 서버 응답을 클라이언트에서 되읽을 때 쓴다. */
export function isNexonErrorKind(value: unknown): value is NexonErrorKind {
  return typeof value === "string" && value in KIND_MESSAGE;
}

/**
 * HTTP 상태 + `error.name` 을 도메인 종류로 접는다.
 *
 * 우선순위:
 * 1. **429 는 코드와 무관하게 항상 `quota_exceeded`.** 상류가 코드를 안 붙여도 막힌 건 막힌 거다.
 * 2. 실측된 코드 표.
 * 3. 5xx → `upstream_unavailable`.
 * 4. 그 외 → `unknown` (코드 보존).
 */
export function classifyNexonFailure(
  httpStatus: number,
  code: string | null,
): NexonErrorKind {
  if (httpStatus === 429) return "quota_exceeded";
  if (code !== null && code in CODE_KIND) return CODE_KIND[code];
  if (httpStatus >= 500) return "upstream_unavailable";
  return "unknown";
}
