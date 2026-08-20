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
  removeFriendship,
  respondToFriendRequest,
  sendFriendRequest,
} from "@/features/friends/server/friend-repo";
import type { FriendOverview } from "@/features/friends/types";

/**
 * `POST   /api/friends/requests` — 친구 신청
 * `PATCH  /api/friends/requests` — 받은 신청에 답하기(수락 / 거절)
 * `DELETE /api/friends/requests` — 친구 끊기 또는 내가 보낸 신청 취소
 *
 * ★ **세 조작 모두 응답으로 화면 전체를 돌려준다.** 신청을 수락하면 받은 신청 목록에서
 *   빠지고 친구 목록에 들어간다 — 두 목록이 동시에 움직이므로 조각으로 갱신하면 화면이
 *   잠깐 서로 어긋난 상태를 그린다(수익 화면의 `applyDetail` 과 같은 규약).
 * ★ 판정(누가 수락할 수 있는가 · 남의 신청인가)은 전부 repo 가 한다. 라우트는 세션을
 *   확인하고 본문을 검증할 뿐이다.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendSchema = z.object({
  targetUserId: z
    .string({ error: "상대 식별자가 필요합니다." })
    .regex(UUID, "상대 식별자 형식이 올바르지 않습니다."),
});

const respondSchema = z.object({
  friendshipId: z
    .string({ error: "신청 식별자가 필요합니다." })
    .regex(UUID, "신청 식별자 형식이 올바르지 않습니다."),
  accept: z.boolean({ error: "수락 여부는 true/false 여야 합니다." }),
});

const removeSchema = z.object({
  friendshipId: z
    .string({ error: "관계 식별자가 필요합니다." })
    .regex(UUID, "관계 식별자 형식이 올바르지 않습니다."),
});

/** 신청 결과와 함께 화면 전체를 싣는다. */
export interface FriendMutationResponse {
  /**
   * `requested` = 신청을 보냈다 / `accepted` = 상대의 신청이 있어 바로 친구가 됐다 /
   * `already` = 이미 그 상태였다. 화면이 문구를 고르는 데 쓴다.
   */
  readonly outcome: "requested" | "accepted" | "already" | "done";
  /**
   * 이 조작으로 **계정에 승계된 게스트 줄 수**(2026-08-20 발주자).
   *
   * 화면이 반드시 말해야 하는 값이다 — 파티원 목록에서 게스트가 사라지고 계정이 그 자리에
   * 들어서는 변화라, 조용히 일어나면 "파티원이 갑자기 바뀌었다" 로 보인다.
   */
  readonly claimedGuests: number;
  readonly overview: FriendOverview;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, sendSchema);
    const result = await sendFriendRequest(session.uid, body.targetUserId);
    const overview = await fetchFriendOverview(session.uid);

    return jsonOk<FriendMutationResponse>(
      { outcome: result.status, claimedGuests: result.claimedGuests, overview },
      201,
    );
  } catch (error) {
    return handleRouteError(error, "api/friends/requests#POST");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, respondSchema);
    const claimedGuests = await respondToFriendRequest(
      session.uid,
      body.friendshipId,
      body.accept,
    );
    const overview = await fetchFriendOverview(session.uid);

    return jsonOk<FriendMutationResponse>({
      outcome: "done",
      claimedGuests,
      overview,
    });
  } catch (error) {
    return handleRouteError(error, "api/friends/requests#PATCH");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, removeSchema);
    await removeFriendship(session.uid, body.friendshipId);
    const overview = await fetchFriendOverview(session.uid);

    // 친구를 끊는다고 승계가 되돌아가지는 않는다 — 그 사람은 여전히 그 계정이다.
    return jsonOk<FriendMutationResponse>({
      outcome: "done",
      claimedGuests: 0,
      overview,
    });
  } catch (error) {
    return handleRouteError(error, "api/friends/requests#DELETE");
  }
}
