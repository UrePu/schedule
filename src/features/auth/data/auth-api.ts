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
  init?: RequestInit & { readonly apiKey?: string },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.apiKey !== undefined) {
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

// ─────────────────────────────────────────────────────────────────────────────
// 넥슨 프록시
// ─────────────────────────────────────────────────────────────────────────────

export function getNexonCharacterList(
  apiKey: string,
): Promise<NexonCharacterListResult> {
  return request<NexonCharacterListResult>("/api/nexon/character/list", {
    method: "GET",
    apiKey,
  });
}

export function getNexonCharacterBasic(
  apiKey: string,
  ocid: string,
): Promise<NexonCharacterBasicResult> {
  const query = new URLSearchParams({ ocid });
  return request<NexonCharacterBasicResult>(
    `/api/nexon/character/basic?${query.toString()}`,
    { method: "GET", apiKey },
  );
}

export function getNexonSchedulerState(
  apiKey: string,
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
