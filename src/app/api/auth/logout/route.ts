import { clearSessionCookie } from "@/features/auth/server/session";
import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import type { LogoutResponse } from "@/features/auth/types";

/**
 * `POST /api/auth/logout` → `{ ok: true }`
 *
 * 쿠키만 지운다. **저장된 API 키는 브라우저 쪽 관심사**라 여기서 손대지 않는다
 * (localStorage 는 서버가 볼 수 없다). 클라이언트가 로그아웃 시 함께 지운다.
 *
 * 세션이 없어도 200 이다 — 로그아웃은 멱등해야 한다.
 * GET 을 두지 않은 이유: 링크 프리페치나 이미지 태그로 남을 로그아웃시킬 수 있게 된다.
 */
export async function POST(): Promise<Response> {
  try {
    await clearSessionCookie();
    return jsonOk<LogoutResponse>({ ok: true });
  } catch (error) {
    return handleRouteError(error, "api/auth/logout");
  }
}
