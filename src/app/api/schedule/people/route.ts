import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { PeoplePoolResponse } from "@/features/schedule/data/schedule-queries";
import { fetchPeoplePool } from "@/features/schedule/server/schedule-repo";

/**
 * `GET /api/schedule/people` — 파티에 넣을 수 있는 사람 후보.
 *
 * 모집단은 **본인 / 수락된 친구 / 같은 파티 구성원(게스트 포함)** 이며,
 * `public.can_view_availability()` 의 열람 범위와 **의도적으로 같다** — 파티에 넣는
 * 순간 그 사람의 가용시간이 보이게 되므로, 후보를 넓히면 그대로 열람 범위가 넓어진다.
 *
 * 비로그인은 **빈 배열 + 200** 이다. "없다"는 에러가 아니라 상태이고,
 * 화면(`PartyEditorDialog`)은 빈 상태를 그린다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    const people = await fetchPeoplePool(session?.uid ?? null);
    return jsonOk<PeoplePoolResponse>({ people });
  } catch (error) {
    return handleRouteError(error, "api/schedule/people#GET");
  }
}
