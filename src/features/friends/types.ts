/**
 * 친구 기능의 화면 타입 (2026-08-20 발주자).
 *
 * ★ 신원은 **본캐 닉네임**이다(§2.1). `displayName` 은 그 값이 없을 때의 폴백이며,
 *   화면은 `mainCharacterName ?? displayName` 순으로 부른다.
 * ★ 시각은 전부 **ISO 문자열**이다 — JSON 으로 나가는 값이라 `Date` 를 쓰면 타입이
 *   거짓말을 한다(수익 원장·대시보드와 같은 규약).
 */

/** 목록에 서는 사람 한 명의 공통 부분. */
export interface FriendPerson {
  readonly userId: string;
  readonly displayName: string;
  readonly mainCharacterName: string | null;
  readonly mainWorldName: string | null;
}

/** 맺어진 친구. */
export interface FriendRow extends FriendPerson {
  readonly friendshipId: string;
  readonly createdAt: string;
  /** 수락 시각. 링크로 바로 맺어진 관계도 값이 있다. */
  readonly acceptedAt: string | null;
}

/** 아직 답을 기다리는 신청(받은 것 · 보낸 것 같은 모양). */
export interface FriendRequestRow extends FriendPerson {
  readonly friendshipId: string;
  readonly createdAt: string;
}

/**
 * 검색 결과 한 줄.
 *
 * `relation` 이 있는 이유: 이미 친구이거나 신청이 오간 사람을 **목록에서 빼지 않기**
 * 때문이다. 빼면 "왜 안 나오지?" 가 되고 화면이 그 답을 할 수 없다.
 */
export interface FriendSearchHit extends FriendPerson {
  readonly relation: "none" | "friend" | "incoming" | "outgoing" | "blocked";
}

/** 친구 화면 한 벌. **한 번의 요청으로 화면 전체**를 받는다. */
export interface FriendOverview {
  readonly friends: readonly FriendRow[];
  /** 내가 답해야 하는 신청. */
  readonly incoming: readonly FriendRequestRow[];
  /** 내가 보내 놓고 기다리는 신청. */
  readonly outgoing: readonly FriendRequestRow[];
  /** 닉네임 검색에 내가 걸리는가. */
  readonly discoverable: boolean;
}

/**
 * 새로 발급한 링크 토큰.
 *
 * ⚠️ **이 순간에만 존재한다.** 서버는 해시만 갖고 있어 다시 만들어 줄 수 없다
 * (§2.1 · `invite_links` 와 같은 기조). 화면은 받는 즉시 복사할 수 있게 보여 준다.
 */
export interface FriendLinkIssue {
  readonly token: string;
}
