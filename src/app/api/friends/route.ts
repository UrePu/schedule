import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchFriendOverview,
  setFriendDiscoverable,
} from "@/features/friends/server/friend-repo";
import type { FriendOverview } from "@/features/friends/types";

/**
 * `GET   /api/friends` — 친구 화면 한 벌(친구 · 받은 신청 · 보낸 신청 · 내 검색 설정)
 * `PATCH /api/friends` — 내 설정 변경(지금은 검색 노출 여부 하나)
 *
 * 발주 지시(2026-08-20): *"친구기능 실제로 구현. 검색 신청 수락 목록."*
 *
 * ★ **세 목록을 한 응답에 싣는다.** 조각으로 나눠 받으면 "수락했는데 아직 신청 목록에
 *   남아 있는" 순간이 생긴다 — 같은 사실의 앞뒷면이라 한 스냅샷이어야 한다.
 * ★ 전부 **세션 필수**다. 친구 관계는 공개면에 실릴 값이 아니다.
 */

const settingsSchema = z.object({
  /** 닉네임 검색에 내가 걸리는가. `false` 가 발주자가 말한 "검색 거부" 다. */
  discoverable: z.boolean({ error: "검색 허용 여부는 true/false 여야 합니다." }),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const overview = await fetchFriendOverview(session.uid);
    return jsonOk<FriendOverview>(overview);
  } catch (error) {
    return handleRouteError(error, "api/friends#GET");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, settingsSchema);
    await setFriendDiscoverable(session.uid, body.discoverable);

    // 화면 전체를 돌려준다 — 설정 한 칸만 바꿔도 목록이 같은 스냅샷으로 유지된다.
    const overview = await fetchFriendOverview(session.uid);
    return jsonOk<FriendOverview>(overview);
  } catch (error) {
    return handleRouteError(error, "api/friends#PATCH");
  }
}
