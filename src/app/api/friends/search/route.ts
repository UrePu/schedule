import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { searchFriendCandidates } from "@/features/friends/server/friend-repo";
import type { FriendSearchHit } from "@/features/friends/types";

/**
 * `GET /api/friends/search?q=닉네임` — 본캐 닉네임 앞부분으로 사람 찾기 (세션 필요)
 *
 * ★ **검색을 거부한 사람은 결과에 아예 없다.** "검색 거부한 사용자입니다" 같은 답을 주면
 *   그 자체로 존재를 알려 주는 것이라 거부 설정이 반쯤만 지켜진다(발주 지시 2026-08-20).
 * ★ 최소 길이·이스케이프·개수 상한은 repo 가 소유한다. 한 글자로 훑거나 `%` 를 넣어
 *   전체 명단을 끌어오는 길을 거기서 막는다.
 */

export interface FriendSearchResponse {
  readonly hits: readonly FriendSearchHit[];
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const query = new URL(request.url).searchParams.get("q") ?? "";
    const hits = await searchFriendCandidates(session.uid, query);

    return jsonOk<FriendSearchResponse>({ hits });
  } catch (error) {
    return handleRouteError(error, "api/friends/search#GET");
  }
}
