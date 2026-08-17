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
