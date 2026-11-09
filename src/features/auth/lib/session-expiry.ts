/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 쓰는 도중 세션이 끊겼다 → **로그인 화면으로** (발주 2026-11-09)
 * ═════════════════════════════════════════════════════════════════════════════
 * 페이지를 열 때의 판정은 서버가 한다(`server/login-required.tsx`). 그런데 화면을 연 채로
 * 세션이 끝나면(30일 만료 · 다른 탭에서 로그아웃 · 계정 정지) 그다음 요청부터 우리
 * API 가 401 을 준다. 그대로 두면 **그 화면만 에러 상태로 끊긴 채** 남고, 사람은 무엇을
 * 해야 할지 모른다. 그래서 브라우저 쪽 요청 헬퍼가 전부 이 파일을 한 줄로 부른다.
 *
 * 이 파일만 `window` 를 만진다. 판정 자체는 순수 모듈(`./login-redirect.ts`)에 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 보내지 않는 경우 — 전부 의도다
 * ─────────────────────────────────────────────────────────────────────────────
 *   - **본문이 `unauthenticated` 가 아닌 401.** 넥슨 키 거절도 401 이다
 *     (`isSessionExpiredResponse` 머리말).
 *   - **`/` 에서.** 그 자리가 로그인 화면이라, 거기서 `/` 로 보내면 재적재가 끝없이 돈다.
 *   - **공개 화면에서**(`/s/*` · `/invite/*` · `/guide`). 로그인 없이 보라고 만든 화면이고,
 *     그 위의 401 은 "이 동작은 로그인이 필요하다"는 뜻일 뿐 화면을 떠날 이유가 아니다.
 *   위 둘은 허용 목록(`isLoginRequiredPath`)이 함께 보장한다.
 *   - **이미 보내는 중일 때.** 화면 하나가 동시에 여러 요청을 띄우므로 401 도 여러 개가
 *     함께 온다. 이동은 한 번이면 된다(모듈 플래그).
 */

import {
  isLoginRequiredPath,
  isSessionExpiredResponse,
  loginHref,
  toSafeReturnPath,
} from "./login-redirect";

/**
 * 이미 로그인 화면으로 보내는 중인가. 문서가 바뀌면 모듈째 사라지므로 되돌릴 일이 없다.
 * (`replace` 라 뒤로가기로 이 문서에 돌아올 수도 없다.)
 */
let redirecting = false;

/**
 * 지금 보고 있는 주소로 돌아오는 로그인 화면 주소. 브라우저 밖에서는 `/`.
 *
 * ★ `pathname + search` 를 그대로 넘긴다 — `/friends?add=<토큰>` 의 토큰이 로그인 뒤에도
 *   살아 있어야 한다. 받을 자격이 없는 경로면 `toSafeReturnPath` 가 null 로 접어 `/` 가 된다.
 */
export function currentLoginHref(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search } = window.location;
  return loginHref(toSafeReturnPath(`${pathname}${search}`));
}

/**
 * 지금 화면을 로그인 화면으로 **바꾼다**(`replace` — 뒤로가기가 끊긴 화면으로 돌아가지 않게).
 *
 * 로그인이 필요한 화면에서만 움직인다. `/` 나 공개 화면이면 아무것도 하지 않고 false —
 * 그 자리에서 보내면 무한 재적재이거나, 보지 말라고 한 적 없는 화면을 빼앗는 일이 된다.
 */
export function replaceWithLogin(): boolean {
  if (typeof window === "undefined") return false;
  if (redirecting) return true;
  if (!isLoginRequiredPath(window.location.pathname)) return false;
  redirecting = true;
  window.location.replace(currentLoginHref());
  return true;
}

/**
 * 요청 헬퍼가 실패 응답을 받았을 때 **던지기 전에** 부른다. 세션 만료가 아니면 아무것도
 * 하지 않고, 맞으면 로그인 화면으로 보낸다. 어느 쪽이든 호출부는 기존대로 던진다 —
 * 이동이 끝나기 전 잠깐 동안 화면은 자기 에러 상태를 그대로 그린다.
 */
export function redirectToLoginIfSessionExpired(
  status: number,
  body: unknown,
): void {
  if (!isSessionExpiredResponse(status, body)) return;
  replaceWithLogin();
}
