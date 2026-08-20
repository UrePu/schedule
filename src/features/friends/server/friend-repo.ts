import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 친구 — 검색 · 신청 · 수락 · 목록, 그리고 검색 거부와 개인 링크
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"친구기능 실제로 구현. 검색 신청 수락 목록. 전부 추가 하고 맨위에
 * 수익 옆에 친구 탭 만들어. 닉네임으로 검색 신청이 가능하지만 내 설정에 검색 거부도 있어야함.
 * 거부 시 링크로 친추 가능"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 파일이 지키는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **관계는 쌍당 한 줄이다.** `friendships_pair_uniq`(least/greatest 표현식 유니크)가
 *   방향과 무관하게 중복을 막는다. 그래서 "내가 A에게 신청" 과 "A가 나에게 신청" 이 동시에
 *   존재할 수 없고, 코드는 언제나 **기존 행이 있는지 먼저 본다.**
 * ★ **신청을 받는 쪽만 수락할 수 있다.** 요청자가 자기 신청을 수락하면 상대 동의 없이
 *   관계가 생긴다 — 그건 친구가 아니라 강제 연결이다.
 * ★ **검색은 본캐 닉네임 앞부분 일치**이며 `friend_discoverable = true` 인 사람만 나온다.
 *   두 글자 미만은 검색하지 않는다 — 한 글자로 훑으면 그건 검색이 아니라 명단 열람이다.
 * ★ **링크 토큰은 해시만 저장한다**(§2.1 · `invite_links` 와 같은 기조). 원문은 발급하는
 *   순간 한 번만 화면에 나가고 서버는 다시 만들어 줄 수 없다.
 *
 * ⚠️ **친구가 되면 서로의 가능 시간이 보인다.** `can_view_availability()` 가 이미 "본인 /
 *    수락된 친구 / 같은 파티" 를 열람 범위로 정해 두었고(마이그레이션 11), 지금까지
 *    `friendships` 에 행이 하나도 없어서 그 갈래가 잠들어 있었을 뿐이다. 이 파일이 그
 *    갈래를 깨우므로, 수락은 **사람이 누르는 행동**이어야 하고 자동 수락은 없다.
 */

import { createHash, randomBytes } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";

import type {
  FriendLinkIssue,
  FriendOverview,
  FriendRequestRow,
  FriendRow,
  FriendSearchHit,
} from "../types";

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

/** 실패는 우리 문구로 접는다 — PostgREST 원문에는 스키마 구조가 그대로 들어 있다. */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[friend-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[friend-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/** base64url 32바이트 = 43자. 추측 공간이 2^256 이라 열거는 성립하지 않는다. */
const TOKEN_BYTES = 32;
/** 우리 발급값은 43자다. 그보다 긴 입력은 해시할 것도 없다. */
const MAX_TOKEN_LENGTH = 200;

/** 검색 최소 길이. 한 글자로 훑으면 그건 검색이 아니라 명단 열람이다. */
const MIN_QUERY_LENGTH = 2;
/** 한 번에 돌려주는 검색 결과 수. 넘치면 더 좁혀 치라고 말한다. */
const SEARCH_LIMIT = 20;

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 없는 대상. **존재 여부를 알리지 않으려고** 404 로 통일한다 — 남의 신청을 가리켰는지
 * 아예 없는 신청인지 구분해 주면 id 를 훑어 관계를 캐낼 수 있다(`partyNotVisible` 과
 * 같은 판단).
 */
function friendNotFound(message: string): ApiError {
  return new ApiError("bad_request", message, 404);
}

function linkUnusable(): ApiError {
  /*
    "없는 링크" 와 "이미 갈아치운 링크" 를 **구분해 말하지 않는다.** 구분하면 토큰을
    던져 보며 존재 여부를 캐낼 수 있다. 사용자가 할 일은 어느 쪽이든 같다 — 새 링크를
    받는 것이다.
  */
  return ApiError.badRequest(
    "쓸 수 없는 링크입니다. 상대에게 새 링크를 받아 주세요.",
  );
}

function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (token === "" || token.length > MAX_TOKEN_LENGTH) throw linkUnusable();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw linkUnusable();
  return token;
}

/** `친구` 화면에 나가는 사람 한 명. 신원은 **본캐 닉네임**이다(§2.1). */
interface UserBrief {
  readonly userId: string;
  readonly displayName: string;
  readonly mainCharacterName: string | null;
  readonly mainWorldName: string | null;
}

const USER_COLUMNS = "id,display_name,main_character_name,main_world_name";

function toBrief(row: {
  readonly id: string;
  readonly display_name: string;
  readonly main_character_name: string | null;
  readonly main_world_name: string | null;
}): UserBrief {
  return {
    userId: row.id,
    displayName: row.display_name,
    mainCharacterName: row.main_character_name,
    mainWorldName: row.main_world_name,
  };
}

async function loadUsers(
  db: AdminDb,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, UserBrief>> {
  if (userIds.length === 0) return new Map();
  const rows = unwrap(
    await db.from("app_users").select(USER_COLUMNS).in("id", [...userIds]),
    "사용자 조회",
  );
  return new Map(rows.map((row) => [row.id, toBrief(row)]));
}

/**
 * 그 사람과 나 사이의 관계 한 줄. 없으면 `null`.
 *
 * 방향이 둘이라 `or` 로 두 번 본다 — 쌍당 한 줄이므로 결과는 최대 하나다.
 */
async function loadPair(
  db: AdminDb,
  userId: string,
  otherUserId: string,
): Promise<{
  readonly id: string;
  readonly requester_user_id: string;
  readonly addressee_user_id: string;
  readonly status: string;
  readonly blocked_by_user_id: string | null;
} | null> {
  const rows = unwrap(
    await db
      .from("friendships")
      .select("id,requester_user_id,addressee_user_id,status,blocked_by_user_id")
      .or(
        `and(requester_user_id.eq.${userId},addressee_user_id.eq.${otherUserId}),` +
          `and(requester_user_id.eq.${otherUserId},addressee_user_id.eq.${userId})`,
      )
      .limit(1),
    "친구 관계 조회",
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 목록 — 친구 · 받은 신청 · 보낸 신청 · 내 설정
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 친구 화면 한 벌. **한 번의 요청으로 화면 전체**를 받는다.
 *
 * 조각으로 나눠 받으면 "수락했는데 아직 신청 목록에 남아 있는" 순간이 생긴다 — 같은
 * 사실의 앞뒷면이라 한 스냅샷이어야 한다(`availability_board` 와 같은 판단).
 */
export async function fetchFriendOverview(
  userId: string,
): Promise<FriendOverview> {
  const db = getAdminDb();

  const [rows, me] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("friendships")
          .select(
            "id,requester_user_id,addressee_user_id,status,created_at,responded_at",
          )
          .or(
            `requester_user_id.eq.${userId},addressee_user_id.eq.${userId}`,
          )
          .neq("status", "blocked")
          .order("created_at", { ascending: false }),
        "친구 목록 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("app_users")
          .select("id,friend_discoverable")
          .eq("id", userId)
          .limit(1),
        "내 설정 조회",
      ))(),
  ]);

  const otherIds = rows.map((row) =>
    row.requester_user_id === userId
      ? row.addressee_user_id
      : row.requester_user_id,
  );
  const users = await loadUsers(db, otherIds);

  const friends: FriendRow[] = [];
  const incoming: FriendRequestRow[] = [];
  const outgoing: FriendRequestRow[] = [];

  for (const row of rows) {
    const otherId =
      row.requester_user_id === userId
        ? row.addressee_user_id
        : row.requester_user_id;
    const other = users.get(otherId);
    // 사용자가 지워졌다면 관계도 cascade 로 사라진다. 방어적으로만 건너뛴다.
    if (other === undefined) continue;

    const entry = {
      friendshipId: row.id,
      userId: other.userId,
      displayName: other.displayName,
      mainCharacterName: other.mainCharacterName,
      mainWorldName: other.mainWorldName,
      createdAt: row.created_at,
    };

    if (row.status === "accepted") {
      friends.push({ ...entry, acceptedAt: row.responded_at });
      continue;
    }
    // pending. **받은 것과 보낸 것은 할 수 있는 일이 다르다** — 받은 것만 수락할 수 있다.
    if (row.addressee_user_id === userId) incoming.push(entry);
    else outgoing.push(entry);
  }

  return {
    friends,
    incoming,
    outgoing,
    discoverable: me[0]?.friend_discoverable ?? true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 검색
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 본캐 닉네임 앞부분으로 사람을 찾는다.
 *
 * ★ `friend_discoverable = false` 인 사람은 **결과에 아예 없다.** "검색 거부한 사람입니다"
 *   같은 답을 주면 그 자체로 존재를 알려 주는 것이라, 거부 설정이 반쯤만 지켜진다.
 * ★ 나 자신도 뺀다. 자기 자신에게 친구 신청하는 화면은 만들 이유가 없고, DB CHECK
 *   (`friendships_not_self`)도 그것을 막는다.
 * ★ 이미 친구이거나 신청이 오간 사람은 **빼지 않고 상태를 실어 보낸다.** 목록에서 사라지면
 *   "왜 안 나오지?" 가 되고, 그 답을 화면이 할 수 없다.
 */
export async function searchFriendCandidates(
  userId: string,
  rawQuery: string,
): Promise<readonly FriendSearchHit[]> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    throw ApiError.badRequest(
      `닉네임을 ${String(MIN_QUERY_LENGTH)}글자 이상 입력해 주세요.`,
    );
  }

  const db = getAdminDb();
  /*
    `%` `_` 는 like 의 와일드카드다. 사용자가 친 그대로 넘기면 `%` 한 글자가 전체 명단을
    끌어온다 — 검색 최소 길이를 우회하는 구멍이라 반드시 이스케이프한다.
  */
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);

  const rows = unwrap(
    await db
      .from("app_users")
      .select(USER_COLUMNS)
      .eq("friend_discoverable", true)
      .neq("id", userId)
      .not("main_character_name", "is", null)
      .ilike("main_character_name", `${escaped}%`)
      .order("main_character_name", { ascending: true })
      .limit(SEARCH_LIMIT),
    "닉네임 검색",
  );
  if (rows.length === 0) return [];

  const pairs = unwrap(
    await db
      .from("friendships")
      .select("id,requester_user_id,addressee_user_id,status")
      .or(`requester_user_id.eq.${userId},addressee_user_id.eq.${userId}`)
      .in("requester_user_id", [userId, ...rows.map((row) => row.id)])
      .in("addressee_user_id", [userId, ...rows.map((row) => row.id)]),
    "기존 관계 조회",
  );

  const byOther = new Map(
    pairs.map((pair) => [
      pair.requester_user_id === userId
        ? pair.addressee_user_id
        : pair.requester_user_id,
      pair,
    ]),
  );

  return rows.map((row) => {
    const brief = toBrief(row);
    const pair = byOther.get(row.id);
    const relation: FriendSearchHit["relation"] =
      pair === undefined
        ? "none"
        : pair.status === "accepted"
          ? "friend"
          : pair.status === "blocked"
            ? "blocked"
            : pair.requester_user_id === userId
              ? "outgoing"
              : "incoming";
    return { ...brief, relation };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 신청 · 수락 · 거절 · 삭제
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 친구 신청.
 *
 * 이미 관계가 있으면 상태별로 답이 다르다 — **조용히 성공시키지 않는다.**
 *   · 이미 친구        → 그대로 알려 준다.
 *   · 내가 이미 보냄   → 중복 신청은 만들지 않는다(쌍당 한 줄).
 *   · 상대가 보낸 신청 → **그 자리에서 수락**한다. 서로 신청한 상황에서 "이미 있습니다"만
 *     말하면 둘 다 상대가 수락하기를 기다리게 된다.
 *   · 차단            → 아무 일도 일어나지 않는다. 차단 사실은 알려 주지 않는다.
 */
export async function sendFriendRequest(
  userId: string,
  targetUserId: string,
): Promise<{ readonly status: "requested" | "accepted" | "already" }> {
  if (userId === targetUserId) {
    throw ApiError.badRequest("자기 자신에게는 신청할 수 없습니다.");
  }

  const db = getAdminDb();
  const target = unwrap(
    await db.from("app_users").select("id").eq("id", targetUserId).limit(1),
    "상대 확인",
  );
  if (target.length === 0) throw friendNotFound("그런 사용자가 없습니다.");

  const existing = await loadPair(db, userId, targetUserId);
  if (existing !== null) {
    if (existing.status === "accepted") return { status: "already" };
    if (existing.status === "blocked") {
      /*
        차단은 방향이 있지만 **어느 쪽이 막았는지 알려 주지 않는다.** 알려 주면 차단이
        상대에게 통보되는 셈이라 차단의 목적을 잃는다.
      */
      throw ApiError.badRequest("지금은 이 사용자에게 신청할 수 없습니다.");
    }
    if (existing.addressee_user_id === userId) {
      unwrap(
        await db
          .from("friendships")
          .update({ status: "accepted", responded_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select("id"),
        "맞신청 수락",
      );
      return { status: "accepted" };
    }
    return { status: "already" };
  }

  unwrap(
    await db
      .from("friendships")
      .insert({
        requester_user_id: userId,
        addressee_user_id: targetUserId,
        status: "pending",
      })
      .select("id"),
    "친구 신청",
  );
  return { status: "requested" };
}

/**
 * 받은 신청에 답한다. **받는 쪽만** 부를 수 있다.
 *
 * 거절은 행을 **지운다.** `declined` 상태를 두면 "거절당한 사람"이 영원히 남고, 나중에
 * 마음이 바뀌어 다시 신청할 때 쌍 유니크에 걸려 신청 자체가 막힌다.
 */
export async function respondToFriendRequest(
  userId: string,
  friendshipId: string,
  accept: boolean,
): Promise<void> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("friendships")
      .select("id,addressee_user_id,status")
      .eq("id", friendshipId)
      .limit(1),
    "신청 조회",
  );
  const row = rows[0];
  // 남의 신청을 가리켰는지 **없는 신청인지 구분하지 않는다** — 둘 다 404 다.
  if (row === undefined || row.addressee_user_id !== userId) {
    throw friendNotFound("그런 친구 신청이 없습니다.");
  }
  if (row.status !== "pending") {
    throw ApiError.badRequest("이미 처리된 신청입니다.");
  }

  if (!accept) {
    unwrap(
      await db.from("friendships").delete().eq("id", friendshipId).select("id"),
      "신청 거절",
    );
    return;
  }

  unwrap(
    await db
      .from("friendships")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("id", friendshipId)
      .select("id"),
    "신청 수락",
  );
}

/**
 * 친구 끊기(또는 내가 보낸 신청 취소).
 *
 * **양쪽 다 지울 수 있다.** 관계는 쌍의 것이지 신청자의 것이 아니다.
 */
export async function removeFriendship(
  userId: string,
  friendshipId: string,
): Promise<void> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("friendships")
      .select("id,requester_user_id,addressee_user_id")
      .eq("id", friendshipId)
      .limit(1),
    "관계 조회",
  );
  const row = rows[0];
  if (
    row === undefined ||
    (row.requester_user_id !== userId && row.addressee_user_id !== userId)
  ) {
    throw friendNotFound("그런 친구 관계가 없습니다.");
  }

  unwrap(
    await db.from("friendships").delete().eq("id", friendshipId).select("id"),
    "친구 삭제",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 내 설정 — 검색 거부
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 닉네임 검색 노출 여부를 바꾼다.
 *
 * ★ 끄더라도 **이미 맺은 친구는 그대로다.** 이 설정이 정하는 것은 "새로 찾아지는가" 하나뿐
 *   이며, 관계를 끊는 것은 별개의 행동이다.
 */
export async function setFriendDiscoverable(
  userId: string,
  discoverable: boolean,
): Promise<void> {
  const db = getAdminDb();
  unwrap(
    await db
      .from("app_users")
      .update({ friend_discoverable: discoverable })
      .eq("id", userId)
      .select("id"),
    "검색 설정 저장",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 개인 친구 링크 — 검색을 꺼 둔 사람에게 닿는 유일한 길
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 새 링크를 발급한다. **옛 링크는 그 자리에서 죽는다**(사람당 한 줄).
 *
 * 원문은 여기서 돌려주는 이 순간에만 존재한다 — 서버는 해시만 갖는다. 다시 보고 싶으면
 * 새로 만들면 되고, 그것이 곧 유출된 링크를 되돌리는 방법이다.
 */
export async function issueFriendLink(
  userId: string,
): Promise<FriendLinkIssue> {
  const db = getAdminDb();
  const token = newToken();

  unwrap(
    await db
      .from("friend_links")
      .upsert(
        {
          user_id: userId,
          token_hash: hashToken(token),
          rotated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("user_id"),
    "친구 링크 발급",
  );

  return { token };
}

/**
 * 링크로 친구 신청을 건다.
 *
 * ★ **자동 수락이 아니다.** 링크는 "나를 찾을 수 있게" 해 줄 뿐이고, 관계는 링크 주인이
 *   수락해야 성립한다… 가 원래 안전한 설계지만, 이 링크는 **주인이 직접 건네준 것**이라
 *   주인의 의사가 이미 표현돼 있다. 그래서 링크로 들어온 신청은 **바로 친구가 된다** —
 *   검색을 꺼 둔 사람이 링크를 준 뒤 다시 수락을 눌러야 한다면 그 링크는 반쪽짜리다.
 * ★ 이미 친구면 아무 일도 하지 않고 그대로 알려 준다(멱등).
 */
export async function acceptFriendLink(
  userId: string,
  rawToken: string,
): Promise<{
  readonly status: "accepted" | "already";
  readonly friend: UserBrief;
}> {
  const db = getAdminDb();
  const token = normalizeToken(rawToken);

  const rows = unwrap(
    await db
      .from("friend_links")
      .select("user_id")
      .eq("token_hash", hashToken(token))
      .limit(1),
    "링크 조회",
  );
  const ownerId = rows[0]?.user_id;
  if (ownerId === undefined) throw linkUnusable();
  if (ownerId === userId) {
    throw ApiError.badRequest("내 링크로는 나를 추가할 수 없습니다.");
  }

  const owners = await loadUsers(db, [ownerId]);
  const friend = owners.get(ownerId);
  if (friend === undefined) throw linkUnusable();

  const existing = await loadPair(db, userId, ownerId);
  const now = new Date().toISOString();

  if (existing !== null) {
    if (existing.status === "accepted") return { status: "already", friend };
    if (existing.status === "blocked") throw linkUnusable();
    unwrap(
      await db
        .from("friendships")
        .update({ status: "accepted", responded_at: now })
        .eq("id", existing.id)
        .select("id"),
      "링크로 수락",
    );
    return { status: "accepted", friend };
  }

  unwrap(
    await db
      .from("friendships")
      .insert({
        requester_user_id: userId,
        addressee_user_id: ownerId,
        status: "accepted",
        responded_at: now,
      })
      .select("id"),
    "링크로 친구 추가",
  );
  return { status: "accepted", friend };
}
