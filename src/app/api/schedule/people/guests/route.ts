import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchGuestManageStates } from "@/features/schedule/server/schedule-repo";
import type { GuestManageSnapshot } from "@/features/schedule/types";

/**
 * `GET /api/schedule/people/guests` — 내 후보 모집단의 게스트마다 **숨기기·지우기가
 * 되는지**와 지우면 무엇이 사라지는지(세션 필요).
 *
 * ★ 후보 목록(`GET /api/schedule/people`)과 **따로 둔 이유**: 판정은 게스트마다 기록 표
 *   여덟 개를 세는 일이라, 사람 고르기 창을 열 때마다 돌리기엔 무겁다. 화면은 사용자가
 *   `목록 정리` 를 눌렀을 때만 이 경로를 부른다.
 * ★ 비로그인은 401 이다. 후보 목록과 달리 "빈 상태" 가 의미 있는 화면이 아니다 —
 *   이 정보는 정리 권한이 있는 사람에게만 뜻이 있다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();
    const snapshot = await fetchGuestManageStates(session.uid);
    return jsonOk<GuestManageSnapshot>(snapshot);
  } catch (error) {
    return handleRouteError(error, "api/schedule/people/guests#GET");
  }
}
