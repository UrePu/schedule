/**
 * 브라우저 → 우리 API. **화면은 이 파일의 함수만 부른다.**
 *
 * 여기가 하는 일은 두 가지뿐이다.
 * 1. `fetch` 를 감싸고 `credentials: "same-origin"` 을 붙인다(세션 쿠키를 실어야 한다).
 * 2. 실패 응답을 **`ApiRequestError` 하나로** 접는다 — 화면이 HTTP 상태나
 *    `OPENAPI0000X` 를 몰라도 되게.
 *
 * ★ 넥슨 프록시로 나가는 요청은 키를 **헤더**에만 싣는다. 쿼리에 실으면 브라우저
 *   히스토리와 서버 액세스 로그에 원문이 남는다.
 * ★ 그 키는 이제 **선택**이다(§2.1.2). 서버가 DB 에 보관된 키를 복호화해 쓰므로, 이
 *   브라우저에 원문이 없어도 호출이 성립한다. 갖고 있으면 보내는 이유는 하위 호환과
 *   백필(아직 서버에 없는 키를 이 호출의 성공으로 검증해 올린다) 두 가지뿐이다.
 */

import { PROXY_API_KEY_HEADER } from "@/lib/nexon/constants";
import type {
  NexonCharacterBasicResult,
  NexonCharacterListResult,
  NexonSchedulerStateResult,
} from "@/lib/nexon/types";

import type {
  AddCredentialResponse,
  ApiErrorBody,
  ApiErrorKind,
  CredentialSummary,
  DeleteCredentialResponse,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  QuotaResponse,
} from "../types";

/** 화면이 잡는 단 하나의 실패 타입. `kind` 로만 분기한다. */
export class ApiRequestError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | null;

  constructor(kind: ApiErrorKind, message: string, status: number, code: string | null) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== "object" || candidate === null) return false;
  const error = candidate as { kind?: unknown; message?: unknown };
  return typeof error.kind === "string" && typeof error.message === "string";
}

async function request<T>(
  input: string,
  init?: RequestInit & { readonly apiKey?: string | null },
): Promise<T> {
  const headers = new Headers(init?.headers);
  // null·빈 문자열은 "이 브라우저에 키가 없다"이며 정상 상태다. 헤더를 붙이지 않고 보낸다.
  if (init?.apiKey !== undefined && init.apiKey !== null && init.apiKey !== "") {
    headers.set(PROXY_API_KEY_HEADER, init.apiKey);
  }
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
    // 세션 쿠키가 실려야 한다. 기본값(same-origin)이지만 명시해 의도를 남긴다.
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
    if (isApiErrorBody(body)) {
      throw new ApiRequestError(
        body.error.kind,
        body.error.message,
        response.status,
        body.error.code ?? null,
      );
    }
    throw new ApiRequestError(
      "internal",
      "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      response.status,
      null,
    );
  }

  return body as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// 인증
// ─────────────────────────────────────────────────────────────────────────────

/** 키로 로그인(없으면 가입). **넥슨 호출 1건**을 서버가 대신 낸다. */
export function postLogin(input: {
  readonly apiKey: string;
  readonly label?: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 현재 사용자. **비로그인도 성공 응답**이며 `user: null` 이다. */
export function getMe(): Promise<MeResponse> {
  return request<MeResponse>("/api/auth/me", { method: "GET" });
}

export function postLogout(): Promise<LogoutResponse> {
  return request<LogoutResponse>("/api/auth/logout", { method: "POST" });
}

/** 등록된 키 목록. **세션이 있어야 한다**(없으면 401). 원문도 해시도 나오지 않는다. */
export function getCredentials(): Promise<{
  readonly credentials: readonly CredentialSummary[];
}> {
  return request<{ readonly credentials: readonly CredentialSummary[] }>(
    "/api/auth/credentials",
    { method: "GET" },
  );
}

/** 부계정 키 추가. **세션이 있어야 한다.** */
export function postCredential(input: {
  readonly apiKey: string;
  readonly label?: string;
}): Promise<AddCredentialResponse> {
  return request<AddCredentialResponse>("/api/auth/credentials", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * 등록된 키 1개 삭제. **세션이 있어야 하고 되돌릴 수 없다.**
 *
 * 대상이 본문이 아니라 **경로**에 있다. `DELETE` 본문은 스펙상 의미가 정의되지 않아
 * 중간 계층이 조용히 버릴 수 있고, 그러면 "가끔 아무것도 안 지워진다"가 된다.
 *
 * 서버가 거부하는 경우가 둘 있고 둘 다 `ApiRequestError.kind` 로 구분된다 —
 * `last_credential`(마지막 남은 키) 과 `bad_request`(없는 키·남의 키, 404).
 */
export function deleteCredential(
  credentialId: string,
): Promise<DeleteCredentialResponse> {
  return request<DeleteCredentialResponse>(
    `/api/auth/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 넥슨 프록시
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 보유 캐릭터 목록.
 *
 * `credentialId` 로 **어느 넥슨 계정의 목록인지** 지목한다. 생략하면 서버가 이 사용자의
 * 키 중 하나(주 키 우선)로 부른다. `apiKey` 는 선택이다 — 없으면 서버가 DB 에서 꺼낸다.
 */
export function getNexonCharacterList(
  apiKey: string | null,
  credentialId?: string | null,
): Promise<NexonCharacterListResult> {
  const suffix =
    credentialId === undefined || credentialId === null
      ? ""
      : `?${new URLSearchParams({ credentialId }).toString()}`;
  return request<NexonCharacterListResult>(`/api/nexon/character/list${suffix}`, {
    method: "GET",
    apiKey,
  });
}

export function getNexonCharacterBasic(
  apiKey: string | null,
  ocid: string,
): Promise<NexonCharacterBasicResult> {
  const query = new URLSearchParams({ ocid });
  return request<NexonCharacterBasicResult>(
    `/api/nexon/character/basic?${query.toString()}`,
    { method: "GET", apiKey },
  );
}

export function getNexonSchedulerState(
  apiKey: string | null,
  ocid: string,
  date?: string,
): Promise<NexonSchedulerStateResult> {
  const query = new URLSearchParams({ ocid });
  if (date !== undefined) query.set("date", date);
  return request<NexonSchedulerStateResult>(
    `/api/nexon/scheduler/character-state?${query.toString()}`,
    { method: "GET", apiKey },
  );
}

/** 우리 장부. 넥슨을 부르지 않으므로 15분 규칙 대상이 아니다. */
export function getNexonQuota(): Promise<QuotaResponse> {
  return request<QuotaResponse>("/api/nexon/quota", { method: "GET" });
}
