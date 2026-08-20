/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 친구 — 브라우저 쪽 데이터 경계
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 **이 파일의 함수만** 부른다. 본문은 전부 `/api/friends/...` 호출이고, 그
 * Route Handler 가 `features/friends/server/friend-repo.ts` 를 부른다.
 *
 * ⚠️ **이 파일은 클라이언트 번들에 들어간다.** service_role 키나 `server-only` 모듈을
 *    여기서 import 하면 안 된다.
 * ★ 조작 응답은 **화면 전체**(`overview`)를 싣는다. 친구가 되면 받은 신청 목록에서 빠지고
 *   친구 목록에 들어가므로, 조각으로 갱신하면 두 목록이 잠깐 어긋난다.
 */

import type {
  FriendLinkIssue,
  FriendOverview,
  FriendSearchHit,
} from "../types";

/** 조작 결과 + 갱신된 화면. */
export interface FriendMutationResponse {
  readonly outcome: "requested" | "accepted" | "already" | "done";
  readonly overview: FriendOverview;
}

export interface FriendLinkUseResponse {
  readonly outcome: "accepted" | "already";
  readonly friendName: string;
  readonly overview: FriendOverview;
}

interface ErrorBody {
  readonly error?: { readonly message?: string };
}

/**
 * 공통 요청기. 실패는 **서버가 준 한국어 문구**를 그대로 올린다 — 화면이 문구를 다시
 * 지어내면 서버 규칙이 바뀔 때 거짓말이 된다.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `요청이 실패했습니다 (HTTP ${String(response.status)}).`;
    try {
      const body = (await response.json()) as ErrorBody;
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // 본문이 JSON 이 아닌 경우(프록시 오류 등). 위 기본 문구를 그대로 쓴다.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/** 친구 화면 한 벌. */
export function fetchFriendOverview(): Promise<FriendOverview> {
  return request<FriendOverview>("/api/friends");
}

/** 닉네임 앞부분으로 검색. **두 글자 미만은 서버가 400 으로 막는다.** */
export async function searchFriends(
  query: string,
): Promise<readonly FriendSearchHit[]> {
  const body = await request<{ readonly hits: readonly FriendSearchHit[] }>(
    `/api/friends/search?q=${encodeURIComponent(query)}`,
  );
  return body.hits;
}

/** 친구 신청. 상대가 이미 나에게 신청해 뒀으면 서버가 **그 자리에서 수락**한다. */
export function sendFriendRequest(
  targetUserId: string,
): Promise<FriendMutationResponse> {
  return request<FriendMutationResponse>("/api/friends/requests", {
    method: "POST",
    body: JSON.stringify({ targetUserId }),
  });
}

/** 받은 신청에 답한다. 거절은 행을 지운다(나중에 다시 신청할 수 있어야 하므로). */
export function respondFriendRequest(input: {
  readonly friendshipId: string;
  readonly accept: boolean;
}): Promise<FriendMutationResponse> {
  return request<FriendMutationResponse>("/api/friends/requests", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** 친구 끊기 / 보낸 신청 취소. 양쪽 다 지울 수 있다 — 관계는 쌍의 것이다. */
export function removeFriendship(
  friendshipId: string,
): Promise<FriendMutationResponse> {
  return request<FriendMutationResponse>("/api/friends/requests", {
    method: "DELETE",
    body: JSON.stringify({ friendshipId }),
  });
}

/** 검색 노출 여부. `false` 가 "검색 거부" 다. */
export function setFriendDiscoverable(
  discoverable: boolean,
): Promise<FriendOverview> {
  return request<FriendOverview>("/api/friends", {
    method: "PATCH",
    body: JSON.stringify({ discoverable }),
  });
}

/**
 * 내 친구 링크를 새로 발급한다.
 *
 * ⚠️ 돌아온 토큰은 **이 순간에만** 존재한다. 서버는 해시만 갖고 있어 다시 못 만들어 준다.
 */
export function issueFriendLink(): Promise<FriendLinkIssue> {
  return request<FriendLinkIssue>("/api/friends/link", { method: "POST" });
}

/** 받은 링크로 친구가 된다. 토큰은 **본문**으로 보낸다(URL 은 기록에 남는다). */
export function useFriendLink(token: string): Promise<FriendLinkUseResponse> {
  return request<FriendLinkUseResponse>("/api/friends/link?use=1", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
