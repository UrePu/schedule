import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 초대 링크 · 승계(claim) — **게스트 한 명이 계정 하나로 바뀌는 지점**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(원문):
 *   "친구 초대 기능을 사용하면 내 파티에 들어가있는만큼 다 동기화되는 기능이 필요함.
 *    1,2,3,4파티가 있을때 1,2,3 파티에만 그사람이 끼어있다. 이러면 바로 그 초대된
 *    친구에게도 파티 시간이 뜨는거지. 1,2,3 파티가 그리고."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 링크는 **파티가 아니라 사람**에게 붙는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 링크 한 장으로 그 사람이 끼어 있는 파티가 **전부** 따라온다. 파티마다 링크를
 * 만드는 모델이었다면 위 요구를 만족시키려고 3장을 보내야 하고, 받는 사람은 3번
 * 승계해야 하며, 그중 하나만 눌렀을 때의 반쪽 상태가 생긴다.
 *
 * 옮기는 일 자체는 **DB 함수 `claim_guest_profile(p_guest_id, p_user_id)` 가 한다.**
 * 여러 테이블(`party_participants` · `availability_slots` · `run_signups` · `party_runs`)을
 * 한 트랜잭션으로 옮기고 중복 파티는 병합하며 감사 로그까지 남기는 동작이라, 앱에서
 * 다시 구현하면 중간 상태가 새어 나간다. 이 파일은 **권한 판정과 토큰 취급만** 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 번호(`member_no`)는 승계해도 그대로다 (§1.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * `claim_guest_profile` 의 전환 구문은
 *   `update party_participants set user_id = ..., guest_id = null, display_name = ...`
 * 이고 **`member_no` 를 건드리지 않는다.** 그래서 카톡에서 이미 오간 "3번"이 승계
 * 전후로 같은 사람을 가리킨다. 재번호를 매기는 코드가 이 경로 어디에도 없어야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 토큰 취급 — 원문은 DB 에 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * `guest_profiles.claim_token_hash` 는 스키마 주석부터 "원문은 브라우저에만, 서버는
 * 해시만" 으로 규정돼 있다(마이그레이션 05). CLAUDE.md §2.1 의 API 키 원칙과 같은 기조다.
 * - 발급: 32바이트 난수 → base64url 원문을 **응답에 한 번만** 싣고, 저장은 SHA-256 hex.
 * - 조회/승계: 받은 원문을 해시해서 컬럼과 대조한다. 역방향은 존재하지 않는다.
 * - 승계 완료: `claim_guest_profile` 이 `claim_token_hash` 를 **null 로 비운다** →
 *   같은 링크를 두 번 쓸 수 없다.
 * - 재발급: 새 해시가 덮어써지므로 **이전 링크는 즉시 죽는다.**
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import type {
  GuestInvite,
  InviteClaimResult,
  InviteSummary,
  PersonId,
} from "@/types/domain";

// ─────────────────────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────────────────────

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

/** 원문 메시지는 서버 로그로만. PostgREST 에러에는 스키마 구조가 그대로 들어 있다. */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[invite-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[invite-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/**
 * 쓸 수 없는 토큰은 **원인을 나누지 않는다.**
 *
 * "그런 토큰 없음" 과 "이미 사용됨" 을 구분해 주면 링크를 훑어 어떤 토큰이 살아 있는지
 * 알아낼 수 있다(세션 토큰 검증이 실패 사유를 숨기는 것과 같은 이유).
 * 대신 사용자가 **할 수 있는 일**을 문구에 담는다 — 링크를 다시 받아 오는 것.
 */
function inviteUnusable(): ApiError {
  return new ApiError(
    "bad_request",
    "이 초대 링크는 만료되었거나 이미 사용되었습니다. 초대한 사람에게 새 링크를 받아 주세요.",
    404,
  );
}

/** 토큰 원문 길이 상한. 우리 발급값은 43자이고, 그보다 긴 입력은 해시할 것도 없다. */
const MAX_TOKEN_LENGTH = 200;

/** base64url 32바이트 = 43자. 추측 공간이 2^256 이라 열거는 성립하지 않는다. */
const TOKEN_BYTES = 32;

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 받은 토큰을 정규화한다. 카톡·메일로 링크가 오가면 앞뒤 공백이 붙는 일이 흔하다.
 * 형식이 아예 아닌 값은 **DB 를 때리기 전에** 끊는다.
 */
function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (token === "" || token.length > MAX_TOKEN_LENGTH) throw inviteUnusable();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw inviteUnusable();
  return token;
}

/**
 * 해시 두 개를 **상수시간**으로 비교한다.
 *
 * DB 조회 자체는 `eq(claim_token_hash, ...)` 라 이미 인덱스 동등 비교지만, 조회 결과를
 * 다시 확인하는 이 한 줄이 있으면 나중에 조회 방식이 바뀌어도(`like`, 앞자리 조회 등)
 * 비교가 타이밍으로 새지 않는다. 길이가 다르면 비교할 것도 없다.
 */
function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─────────────────────────────────────────────────────────────────────────────
// 게스트가 끼어 있는 파티
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 그 게스트가 **살아 있는 참가자로** 들어가 있는 파티 이름들.
 *
 * ★ 승계 **전에** 읽어야 한다. `claim_guest_profile` 이 끝나면 `guest_id` 로 찾을 수 있는
 *   행이 하나도 남지 않아, 사용자에게 "무엇이 딸려왔는지" 보여 줄 근거가 사라진다.
 * ★ 보관(`archived_at`)된 파티는 어차피 목록에 뜨지 않으므로 여기서도 뺀다 — 딸려온다고
 *   말해 놓고 화면에 없으면 그게 버그로 읽힌다.
 */
async function loadGuestPartyNames(
  db: AdminDb,
  guestId: string,
): Promise<{ readonly partyIds: string[]; readonly partyNames: string[] }> {
  const participantRows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .eq("guest_id", guestId)
      .is("left_at", null),
    "게스트 참가 파티 조회",
  );
  const partyIds = [...new Set(participantRows.map((row) => row.party_id))];
  if (partyIds.length === 0) return { partyIds: [], partyNames: [] };

  const partyRows = unwrap(
    await db
      .from("parties")
      .select("id,name")
      .in("id", partyIds)
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
    "게스트 참가 파티 이름 조회",
  );
  return {
    partyIds: partyRows.map((row) => row.id),
    partyNames: partyRows.map((row) => row.name),
  };
}

/**
 * 초대장을 만들 자격 — **그 게스트와 파티를 공유하는 사람만.**
 *
 * 이 판정이 없으면 게스트 uuid 하나로 아무나 남의 게스트 초대 링크를 뽑을 수 있고,
 * 그 링크는 그 사람이 낀 **모든 파티**를 통째로 넘긴다. 파티 로스터 편집 권한
 * (`requirePartyMembership`)과 같은 눈높이로 맞춘다.
 */
async function assertCanInviteGuest(
  db: AdminDb,
  userId: string,
  guestId: string,
  guestPartyIds: readonly string[],
): Promise<void> {
  if (guestPartyIds.length === 0) {
    throw ApiError.badRequest(
      "이 사람은 아직 어떤 파티에도 들어 있지 않습니다. 파티에 먼저 추가해 주세요.",
    );
  }

  const shared = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .in("party_id", [...guestPartyIds])
      .eq("user_id", userId)
      .is("left_at", null)
      .limit(1),
    "초대 권한 확인",
  );
  if (shared.length === 0) {
    // 존재 여부를 알리지 않는다 — 파티 조회가 404 로 통일된 것과 같은 이유.
    console.warn(
      `[invite-repo] 파티를 공유하지 않는 게스트 초대 시도: user=${userId} guest=${guestId}`,
    );
    throw new ApiError(
      "bad_request",
      "초대할 수 없는 사람입니다. 같은 파티에 있는 사람만 초대할 수 있습니다.",
      404,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 발급
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 게스트에게 초대 링크를 발급한다.
 *
 * ⚠️ **재발급하면 이전 링크가 죽는다.** `claim_token_hash` 를 덮어쓰기 때문이다.
 *    화면이 그 사실을 말해 줘야 한다 — 옛 링크를 이미 보낸 사람은 다시 보내야 한다.
 * ⚠️ 이미 승계된 게스트에게는 발급하지 않는다. 그 사람은 이제 계정이 있고, 링크는
 *    "그 계정의 파티를 남에게 넘기는 열쇠"가 되어 버린다.
 */
export async function issueGuestInvite(
  userId: string,
  guestPersonId: PersonId,
): Promise<GuestInvite> {
  const db = getAdminDb();

  const guestRows = unwrap(
    await db
      .from("guest_profiles")
      .select("id,display_name,claimed_by_user_id")
      .eq("id", guestPersonId)
      .limit(1),
    "게스트 조회",
  );
  const guest = guestRows[0];
  if (guest === undefined) {
    throw new ApiError(
      "bad_request",
      "초대할 수 없는 사람입니다. 같은 파티에 있는 사람만 초대할 수 있습니다.",
      404,
    );
  }

  const { partyIds, partyNames } = await loadGuestPartyNames(db, guest.id);
  await assertCanInviteGuest(db, userId, guest.id, partyIds);

  if (guest.claimed_by_user_id !== null) {
    throw ApiError.badRequest(
      `${guest.display_name} 님은 이미 계정으로 전환되어 초대 링크가 필요하지 않습니다.`,
    );
  }

  const token = newToken();
  unwrap(
    await db
      .from("guest_profiles")
      .update({ claim_token_hash: hashToken(token), last_seen_at: new Date().toISOString() })
      .eq("id", guest.id)
      // 경합 방어: 그 사이에 누가 승계했다면 아무 행도 갱신되지 않는다.
      .is("claimed_by_user_id", null)
      .select("id"),
    "초대 토큰 발급",
  );

  return {
    guestPersonId: guest.id,
    guestDisplayName: guest.display_name,
    token,
    partyNames,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회 (비로그인도 볼 수 있다)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 초대 링크를 열었을 때 보여 줄 내용.
 *
 * ★ **세션이 없어도 200 이다.** 받는 사람은 대개 아직 계정이 없다 — 로그인해야만 내용을
 *   볼 수 있으면 "무엇에 로그인하는지" 모르는 채로 API 키를 넣게 된다.
 * ★ 공개하는 것은 **닉네임과 파티 이름**뿐이다. 시간표·구성원·일정은 이 화면에 없다.
 *   토큰을 가진 사람에게만 보이므로 공개면이 넓어지지도 않는다.
 * ★ 쓸 수 없는 토큰은 `null` 을 돌려준다 — 페이지가 오류가 아니라 **안내**로 그려야 하고,
 *   비로그인 화면에 빨간 오류가 뜨는 것은 §4(빨강은 실패·취소 전용)에도 어긋난다.
 */
export async function resolveInvite(
  rawToken: string,
): Promise<InviteSummary | null> {
  const db = getAdminDb();

  let token: string;
  try {
    token = normalizeToken(rawToken);
  } catch {
    return null;
  }
  const tokenHash = hashToken(token);

  const rows = unwrap(
    await db
      .from("guest_profiles")
      .select("id,display_name,claim_token_hash,claimed_by_user_id")
      .eq("claim_token_hash", tokenHash)
      .limit(1),
    "초대 링크 조회",
  );
  const guest = rows[0];
  if (guest === undefined) return null;
  if (guest.claim_token_hash === null) return null;
  if (!hashEquals(guest.claim_token_hash, tokenHash)) return null;

  const { partyNames } = await loadGuestPartyNames(db, guest.id);

  return {
    guestDisplayName: guest.display_name,
    partyNames,
    alreadyClaimed: guest.claimed_by_user_id !== null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 승계
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 게스트를 **내 계정으로** 가져온다.
 *
 * ★ 토큰 증명이 필수다. 게스트 uuid 만으로는 절대 승계되지 않는다.
 * ★ 이미 **다른 계정**에 승계된 게스트는 거부된다. DB 함수도 `unique_violation` 으로
 *   막지만, 그 예외 문구는 사용자가 읽을 것이 아니므로 여기서 먼저 사람 말로 막는다.
 * ★ 파티 이름은 **승계 전에** 읽는다(`loadGuestPartyNames` 주석 참고).
 */
export async function claimInvite(
  userId: string,
  rawToken: string,
): Promise<InviteClaimResult> {
  const db = getAdminDb();
  const token = normalizeToken(rawToken);
  const tokenHash = hashToken(token);

  const rows = unwrap(
    await db
      .from("guest_profiles")
      .select("id,display_name,claim_token_hash,claimed_by_user_id")
      .eq("claim_token_hash", tokenHash)
      .limit(1),
    "승계 대상 조회",
  );
  const guest = rows[0];
  if (guest === undefined) throw inviteUnusable();
  if (guest.claim_token_hash === null) throw inviteUnusable();
  if (!hashEquals(guest.claim_token_hash, tokenHash)) throw inviteUnusable();

  if (
    guest.claimed_by_user_id !== null &&
    guest.claimed_by_user_id !== userId
  ) {
    // `claim_guest_profile` 의 '이미 다른 계정에 승계되었습니다' 를 사용자 문구로 옮긴 것.
    throw new ApiError(
      "bad_request",
      "이 초대는 이미 다른 계정이 사용했습니다. 초대한 사람에게 새 링크를 받아 주세요.",
      409,
    );
  }

  const { partyNames } = await loadGuestPartyNames(db, guest.id);

  const result = await db.rpc("claim_guest_profile", {
    p_guest_id: guest.id,
    p_user_id: userId,
  });
  if (result.error !== null) {
    console.error(`[invite-repo] claim_guest_profile 실패: ${result.error.message}`);
    throw ApiError.internal();
  }

  // `returns table (...)` 은 행 배열로 온다. 정상 경로에서는 정확히 한 행이다.
  const row = result.data?.[0];
  if (row === undefined) {
    console.error("[invite-repo] claim_guest_profile 이 결과 행을 돌려주지 않았습니다.");
    throw ApiError.internal();
  }

  return {
    movedParticipants: row.moved_participants,
    mergedParticipants: row.merged_participants,
    partyNames,
  };
}
