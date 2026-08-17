import { getAdminDb } from "@/lib/supabase/admin-db";
import { loadSessionUser } from "@/features/auth/server/account";
import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  clearSessionCookie,
  readSession,
} from "@/features/auth/server/session";
import type { MeResponse } from "@/features/auth/types";

/**
 * `GET /api/auth/me`
 *
 * 응답 `{ user: SessionUser | null }` — **비로그인도 200 이다.**
 *
 * ★ 401 로 답하지 않는 것이 의도다. 이 앱은 **비로그인 열람이 정상 경로**이고
 *   (CLAUDE.md §2.1 · DoD), 화면은 "로그인 안 됨"을 에러가 아니라 상태로 그린다.
 *   401 을 주면 TanStack Query 가 에러 상태로 떨어져 홈 화면이 오류 화면이 된다.
 *
 * 토큰이 살아 있어도 계정이 삭제·정지됐으면 여기서 걸린다 — 서명 쿠키가 개별 폐기를
 * 못 하는 대신, **매 요청 계정 상태를 확인**하는 것으로 그 구멍을 메운다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) {
      return jsonOk<MeResponse>({ user: null });
    }

    const user = await loadSessionUser(getAdminDb(), session.uid);

    if (user === null || user.status !== "active") {
      // 살아 있는 토큰이 죽은 계정을 가리킨다 → 쿠키를 지워 매 요청 헛돌지 않게 한다.
      await clearSessionCookie();
      return jsonOk<MeResponse>({ user: null });
    }

    return jsonOk<MeResponse>({ user });
  } catch (error) {
    return handleRouteError(error, "api/auth/me");
  }
}
