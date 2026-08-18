import "server-only";

/**
 * 봇 서버 모듈 공용 조각.
 *
 * `features/invites/server/invite-repo.ts` · `features/schedule/server/schedule-repo.ts`
 * 와 **같은 `unwrap` 규약**을 쓴다 — PostgREST 오류 원문에는 스키마 구조가 그대로
 * 들어 있으므로 서버 로그로만 보내고, 밖으로는 우리 문구만 내보낸다.
 */

import { ApiError } from "@/features/auth/server/http";

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

export function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[bot] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[bot] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/** 오류를 무시해도 되는 부수 갱신(마지막 접속 시각 등). 실패해도 요청을 깨지 않는다. */
export function ignoreError(
  result: { readonly error: { readonly message: string } | null },
  context: string,
): void {
  if (result.error !== null) {
    console.warn(`[bot] ${context}: ${result.error.message}`);
  }
}
