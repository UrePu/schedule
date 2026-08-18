import "server-only";

/**
 * Route Handler 공통 응답/에러 처리.
 *
 * ★ **이 파일이 API 키 유출의 마지막 관문이다.**
 *   어떤 예외가 올라오든 여기서 **우리가 만든 문구만** 내보낸다. 예외 객체의 `message`
 *   를 그대로 흘려보내지 않는다 — 라이브러리 예외에는 요청 헤더가 통째로 들어 있는
 *   경우가 있고, 우리 헤더에는 키가 들어 있다.
 */

import { z } from "zod";

import { isNexonApiError, nexonErrorMessage } from "@/lib/nexon/errors";

import type { ApiErrorBody, ApiErrorKind } from "../types";

/** 우리 쪽 사정으로 실패했을 때 던지는 에러. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;

  constructor(kind: ApiErrorKind, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }

  static unauthenticated(): ApiError {
    return new ApiError(
      "unauthenticated",
      "로그인이 필요합니다. API 키로 먼저 로그인해 주세요.",
      401,
    );
  }

  static badRequest(message: string): ApiError {
    return new ApiError("bad_request", message, 400);
  }

  static keyOwnedByOtherAccount(): ApiError {
    return new ApiError(
      "key_owned_by_other_account",
      "이 API 키는 이미 다른 계정에 등록되어 있습니다. 계정 병합은 지원하지 않습니다.",
      409,
    );
  }

  /**
   * 보낸 키가 그 캐릭터의 계정 키가 아니다.
   *
   * ★ **넥슨을 부르기 전에** 던진다. 넥슨도 `OPENAPI00004` 로 거절하지만 그 거절은
   *   호출량 1건을 태운 뒤에 오고, 실계정에서 이 실패가 진입할 때마다 반복됐다.
   * ★ 400 이 아니라 **409** 다 — 요청 형식이 잘못된 것이 아니라, 등록된 자원(캐릭터)과
   *   보낸 자격증명이 **맞지 않는** 상태 충돌이다. 화면은 `kind` 로 분기하므로 상태
   *   코드에 의존하지 않지만, 로그에서 형식 오류와 섞이지 않는 편이 낫다.
   */
  static credentialMismatch(message: string): ApiError {
    return new ApiError("credential_mismatch", message, 409);
  }

  /**
   * 이 자격증명의 원문 키가 **서버에 보관돼 있지 않다** (CLAUDE.md §2.1.2).
   *
   * ★ `credential_mismatch` 와 다르다. 그쪽은 "보낸 키가 그 계정 것이 아니다"이고,
   *   이쪽은 "부를 키가 아예 없다"이다. 조치도 다르다 — 전자는 맞는 키를 보내는 것,
   *   후자는 **그 계정 키를 한 번 입력해 서버에 올리는 것**이다.
   * ★ **오류가 아니라 상태에 가깝다.** 아직 키를 올리지 않은 자격증명이 있는 것은
   *   정상이며, 화면은 이것을 실패가 아니라 "할 일"로 그린다(§2.1.2).
   */
  static serverKeyMissing(message: string): ApiError {
    return new ApiError("server_key_missing", message, 409);
  }

  /**
   * **마지막 남은 키는 지울 수 없다** (CLAUDE.md §2.1).
   *
   * 로그인 경로가 `sha256(키)` → `api_key_hash` → `app_users` 하나뿐이라, 키를 전부
   * 지우면 그 계정에 **다시 들어갈 방법이 없어진다.** 캐릭터·파티·수익 기록은 DB 에
   * 그대로 남는데 문만 사라지는, 사용자가 스스로 복구할 수 없는 상태다.
   *
   * ★ 화면에도 같은 안내가 있지만 **판정은 서버가 한다.** 화면의 비활성화는 실수를
   *   줄이는 장치일 뿐 경계가 아니다 — 경계는 언제나 서버다.
   * ★ 400 이 아니라 **409** 다. 요청 형식이 아니라 자원의 **현재 상태**(키가 하나뿐)
   *   때문에 거부되며, 키를 하나 더 등록하면 같은 요청이 그대로 성공한다.
   */
  static lastCredential(): ApiError {
    return new ApiError(
      "last_credential",
      "마지막 남은 키는 삭제할 수 없습니다. 이 키를 지우면 이 계정으로 다시 로그인할 방법이 사라집니다. 다른 키를 먼저 등록해 주세요.",
      409,
    );
  }

  /**
   * 없는 키와 **남의 키**를 같은 답으로 접는다.
   *
   * 403 으로 갈라 주면 "그 id 는 존재한다"는 사실이 새어 나가고, uuid 를 훑어
   * 남의 자격증명 존재 여부를 확인할 수 있게 된다. 삭제 대상 확인은 언제나
   * `user_id` 와 함께 하므로, 여기 도달했다는 것은 둘 중 하나라는 뜻뿐이다.
   */
  static credentialNotFound(): ApiError {
    return new ApiError(
      "bad_request",
      "등록된 키를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.",
      404,
    );
  }

  static accountUnavailable(): ApiError {
    return new ApiError(
      "account_unavailable",
      "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.",
      403,
    );
  }

  static internal(): ApiError {
    return new ApiError(
      "internal",
      "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      500,
    );
  }
}

export function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, {
    status,
    // 인증 상태가 걸린 응답은 절대 캐시하지 않는다.
    headers: { "cache-control": "no-store" },
  });
}

function jsonError(
  kind: ApiErrorKind,
  message: string,
  status: number,
  code: string | null = null,
): Response {
  const body: ApiErrorBody = { error: { kind, code, message } };
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * 모든 Route Handler 의 마지막 catch.
 *
 * 분류되지 않은 예외는 **500 + 우리 문구**로 접는다. 원문 메시지는 서버 로그에만 남는다.
 */
export function handleRouteError(error: unknown, context: string): Response {
  if (error instanceof ApiError) {
    return jsonError(error.kind, error.message, error.status);
  }

  if (isNexonApiError(error)) {
    // detail 은 서버 로그로만. 응답에는 종류/코드/우리 문구만 나간다.
    if (error.detail !== null) {
      console.warn(`[${context}] 넥슨 실패(${error.kind}): ${error.detail}`);
    }
    return jsonError(
      error.kind,
      nexonErrorMessage(error.kind),
      error.status,
      error.code,
    );
  }

  if (error instanceof z.ZodError) {
    return jsonError("bad_request", "요청 형식이 올바르지 않습니다.", 400);
  }

  console.error(
    `[${context}] 처리되지 않은 오류:`,
    error instanceof Error ? `${error.name}: ${error.message}` : error,
  );
  const fallback = ApiError.internal();
  return jsonError(fallback.kind, fallback.message, fallback.status);
}

/** JSON 본문을 스키마로 검증한다. 본문이 없거나 깨졌으면 400. */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = (await request.json()) as unknown;
  } catch {
    throw ApiError.badRequest("요청 본문이 JSON 이 아닙니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest(
      parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.",
    );
  }
  return parsed.data;
}

/**
 * API 키 입력 스키마.
 *
 * **형식(접두사 등)으로 키를 판별하지 않는다** — 그렇게 하기로 이미 결정했다
 * (research-NEXON-API #8). 여기서 보는 것은 "비어 있지 않다"와
 * "헤더에 넣을 수 없는 문자가 없다" 두 가지뿐이고, 진짜 유효성은 넥슨이 판정한다.
 */
export const apiKeySchema = z
  // 타입 불일치(누락 포함)까지 한국어로 답한다. zod 기본 문구는 영어라 화면에 그대로 나간다.
  .string({ error: "API 키를 입력해 주세요." })
  .trim()
  .min(1, "API 키를 입력해 주세요.")
  .max(512, "API 키가 너무 깁니다.")
  // 개행/제어문자가 섞이면 HTTP 헤더 주입이 된다. 붙여넣기 사고를 여기서 끊는다.
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "API 키에 사용할 수 없는 문자가 포함되어 있습니다.",
  );

export const labelSchema = z.string().trim().min(1).max(40).optional();
