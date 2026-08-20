import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  acceptFriendLink,
  fetchFriendOverview,
  issueFriendLink,
} from "@/features/friends/server/friend-repo";
import type { FriendOverview } from "@/features/friends/types";

/**
 * `POST /api/friends/link`        — 내 친구 링크를 **새로 발급**한다 (세션 필요)
 * `POST /api/friends/link?use=1`  — 받은 링크로 친구가 된다 (세션 필요)
 *
 * 발주 지시(2026-08-20): *"닉네임으로 검색 신청이 가능하지만 내 설정에 검색 거부도
 * 있어야함. 거부 시 링크로 친추 가능"*
 *
 * ★ **토큰 원문은 발급 응답에만 있다.** 서버는 SHA-256 해시만 보관하므로 다시 만들어 줄 수
 *   없다(§2.1 · `invite_links` 와 같은 기조). 새로 발급하면 옛 링크는 그 자리에서 죽고,
 *   그것이 유출된 링크를 되돌리는 유일한 방법이다.
 * ★ 발급과 사용을 **한 라우트의 쿼리로** 가른 이유: 둘 다 "링크"라는 한 자원에 대한 조작이고
 *   경로를 나누면 토큰이 URL 에 실리기 쉬워진다. 사용 쪽은 토큰을 **본문**으로 받는다 —
 *   URL 은 브라우저 기록·서버 로그·리퍼러에 남는다.
 */

const useSchema = z.object({
  token: z
    .string({ error: "링크가 필요합니다." })
    .min(1, "링크가 비어 있습니다.")
    .max(200, "링크 형식이 올바르지 않습니다."),
});

export interface FriendLinkIssueResponse {
  /** ⚠️ **이 응답에만 있다.** 다시 조회할 수 없다. */
  readonly token: string;
}

export interface FriendLinkUseResponse {
  readonly outcome: "accepted" | "already";
  /** 누구와 친구가 됐는지. 화면이 이름으로 결과를 말한다. */
  readonly friendName: string;
  readonly overview: FriendOverview;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const isUse = new URL(request.url).searchParams.get("use") !== null;

    if (!isUse) {
      const issued = await issueFriendLink(session.uid);
      return jsonOk<FriendLinkIssueResponse>({ token: issued.token }, 201);
    }

    const body = await readJsonBody(request, useSchema);
    const result = await acceptFriendLink(session.uid, body.token);
    const overview = await fetchFriendOverview(session.uid);

    return jsonOk<FriendLinkUseResponse>({
      outcome: result.status,
      friendName: result.friend.mainCharacterName ?? result.friend.displayName,
      overview,
    });
  } catch (error) {
    return handleRouteError(error, "api/friends/link#POST");
  }
}
