import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 연결 코드와 신원 — **닉네임은 키가 아니다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 방에서 얻을 수 있는 발신자 정보는 **불투명 id + 닉네임**뿐이고, 닉네임은 언제든
 * 바뀌며 중복될 수 있다. 그래서 신원의 유일한 근거는 `!연결 <코드>` 로 맺어진
 * `bot_channel_members(channel_id, sender_id) → app_users.id` 매핑이다
 * (CLAUDE.md §2.3 · research-KAKAO-BOT §2.9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 코드 취급 — **원문은 DB 에 없다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `guest_profiles.claim_token_hash`(초대 링크) · `user_credentials.api_key_hash`
 * (넥슨 키)와 **같은 기조**다:
 *   - 발급: 원문은 **발급 응답 1회만** 나가고, 저장은 SHA-256 hex.
 *   - 검증: 받은 원문을 해시해 대조한다. 역방향은 존재하지 않는다.
 *   - 소모: `consumed_at` 을 채워 **한 번만** 쓸 수 있게 한다.
 *   - 재발급: 이전 미사용 코드를 `revoked_at` 으로 죽인다(사용자당 동시 1개).
 *
 * ⚠️ **코드별 시도 횟수(`attempt_count`)로는 무차별 대입을 막을 수 없다.** 틀린 코드는
 *    어떤 행에도 해시가 맞지 않아 셀 대상 자체가 없기 때문이다. 그래서 실제 방어는
 *    (a) 짧은 TTL 10분, (b) 32글자 알파벳 6자리(≈10억 가지), (c) 아래
 *    **발신자별 실패 제한**이다. `attempt_count` 는 "코드는 맞았는데 소모에 실패한"
 *    경우에만 오르며, 그 값이 한도를 넘으면 코드를 폐기한다.
 */

import { createHash, randomInt } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import type { AdminDb } from "@/lib/supabase/admin-db";
import type { BotLinkCode, BotLinkCodeKind } from "../types";

import { ignoreError, unwrap } from "./shared";

/** 코드 수명. 방에서 바로 치는 값이므로 길 이유가 없다. */
const CODE_TTL_MINUTES = 10;

/**
 * 헷갈리는 글자를 뺀 알파벳: `I` `O` `0` `1` 없음. 32글자 · 6자리 ≈ 10.7억 가지.
 * 사람이 방에서 손으로 옮겨 적는 값이라 **오독을 줄이는 것이 보안만큼 중요하다.**
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 방에서 친 값은 공백·하이픈이 섞이기 쉽다. 형식이 아니면 DB 를 때리지 않는다. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const char of code) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// 발급 (웹 · 세션 인증)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 코드를 발급한다. **같은 종류의 기존 미사용 코드는 즉시 죽는다**(동시 1개).
 *
 * 두 장을 동시에 살려 두면 "아까 받은 코드"와 "방금 받은 코드"가 둘 다 통해서,
 * 어느 것이 유효한지 사용자도 우리도 말할 수 없게 된다.
 */
export async function issueLinkCode(
  db: AdminDb,
  input: { readonly kind: BotLinkCodeKind; readonly userId: string },
  now: Date,
): Promise<BotLinkCode> {
  ignoreError(
    await db
      .from("bot_link_codes")
      .update({ revoked_at: now.toISOString() })
      .eq("user_id", input.userId)
      .eq("kind", input.kind)
      .is("consumed_at", null)
      .is("revoked_at", null),
    "기존 연결 코드 폐기",
  );

  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);

  /*
    `code_hash` 는 전역 유니크다. 10억 분의 1 충돌이라도 사용자에게 500 을 주지 않도록
    몇 번 다시 뽑는다. 실패가 계속되면 그건 우리 쪽 사고이므로 500 이 맞다.
  */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const result = await db
      .from("bot_link_codes")
      .insert({
        kind: input.kind,
        code_hash: hashCode(code),
        user_id: input.userId,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (result.error === null) {
      return { kind: input.kind, code, expiresAt: expiresAt.toISOString() };
    }
    if (result.error.code !== "23505") {
      console.error(`[bot] 연결 코드 발급 실패: ${result.error.message}`);
      throw ApiError.internal();
    }
  }

  console.error("[bot] 연결 코드 해시 충돌이 반복됩니다.");
  throw ApiError.internal();
}

// ─────────────────────────────────────────────────────────────────────────────
// 소모
// ─────────────────────────────────────────────────────────────────────────────

interface LinkCodeRow {
  readonly id: string;
  readonly kind: BotLinkCodeKind;
  readonly user_id: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

/**
 * 쓸 수 없는 코드는 **원인을 나누지 않는다.**
 *
 * "없는 코드"와 "만료된 코드"를 구분해 주면 훑어서 살아 있는 코드를 찾을 수 있다
 * (초대 토큰이 같은 이유로 원인을 접는다). 대신 사용자가 **할 수 있는 일**을 말한다.
 */
export function codeUnusableReply(): string {
  return [
    "❌ 코드가 맞지 않거나 만료됐어요.",
    "웹에서 새 코드를 받아 다시 입력해 주세요.",
  ].join("\n");
}

async function findUsableCode(
  db: AdminDb,
  code: string,
  kind: BotLinkCodeKind,
): Promise<LinkCodeRow | null> {
  const rows = unwrap(
    await db
      .from("bot_link_codes")
      .select("id,kind,user_id,attempt_count,max_attempts")
      .eq("code_hash", hashCode(code))
      .eq("kind", kind)
      .is("consumed_at", null)
      .is("revoked_at", null)
      /*
        ★ 만료 비교는 **DB 시각**으로 한다. `expires_at` 을 우리가 채우긴 하지만, 두
          시계가 어긋나면 이미 죽은 코드가 그 차이만큼 더 살아 있게 된다(이 저장소의
          개발 머신은 Supabase 보다 7.6초 느렸다). PostgREST 의 `now` 는 Postgres 가
          `timestamptz 'now'` 로 캐스팅해 트랜잭션 시각으로 비교한다.
      */
      .gt("expires_at", "now")
      .limit(1),
    "연결 코드 조회",
  );
  const row = rows[0] as LinkCodeRow | undefined;
  if (row === undefined) return null;
  if (row.attempt_count >= row.max_attempts) return null;
  return row;
}

/** 코드는 맞았지만 소모에 실패한 경우. 한도를 넘으면 그 코드를 죽인다. */
async function noteCodeAttempt(db: AdminDb, row: LinkCodeRow, now: Date): Promise<void> {
  const next = row.attempt_count + 1;
  ignoreError(
    await db
      .from("bot_link_codes")
      .update(
        next >= row.max_attempts
          ? { attempt_count: next, revoked_at: now.toISOString() }
          : { attempt_count: next },
      )
      .eq("id", row.id),
    "연결 코드 시도 횟수 갱신",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 발신자별 실패 제한 — **프로세스 내 최선 노력**
// ─────────────────────────────────────────────────────────────────────────────
/*
  담을 테이블이 없고(새 마이그레이션 금지) 실패한 코드는 어떤 행에도 매달 수 없다.
  인스턴스가 여러 개면 한도가 인스턴스 수만큼 늘어난다는 뜻이므로 **이것만 믿지 않는다** —
  진짜 방어는 10분 TTL 과 10억 가지 코드 공간이다. 이 맵은 한 방에서 사람이 코드를
  연타로 찍어 보는 흔한 경우를 끊는 용도다.
*/
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

export function tooManyLinkFailures(channelId: string, senderId: string, now: Date): boolean {
  const entry = failures.get(`${channelId}:${senderId}`);
  if (entry === undefined) return false;
  if (entry.resetAt <= now.getTime()) return false;
  return entry.count >= FAILURE_LIMIT;
}

export function noteLinkFailure(channelId: string, senderId: string, now: Date): void {
  const key = `${channelId}:${senderId}`;
  const entry = failures.get(key);
  if (entry === undefined || entry.resetAt <= now.getTime()) {
    failures.set(key, { count: 1, resetAt: now.getTime() + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLinkFailures(channelId: string, senderId: string): void {
  failures.delete(`${channelId}:${senderId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// `!연결` — 발신자 ↔ 계정 매핑
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedMember {
  readonly userId: string;
  readonly displayName: string | null;
}

/**
 * 코드로 이 발신자를 계정에 붙인다. 성공하면 그 계정 id 를 돌려준다.
 *
 * ★ 같은 `(channel, sender)` 가 이미 다른 계정에 붙어 있으면 **덮어쓴다.** 코드가
 *   계정 소유를 증명하므로, 기기를 넘겨받았거나 방을 다시 만든 경우를 막을 이유가 없다.
 *   반대로 코드 없이 바뀌는 경로는 존재하지 않는다.
 */
export async function consumeMemberLinkCode(
  db: AdminDb,
  input: {
    readonly code: string;
    readonly channelId: string;
    readonly senderId: string;
    readonly displayName: string;
  },
  now: Date,
): Promise<LinkedMember | null> {
  const row = await findUsableCode(db, input.code, "member_link");
  if (row === null) return null;
  if (row.user_id === null) {
    await noteCodeAttempt(db, row, now);
    return null;
  }

  const consumed = unwrap(
    await db
      .from("bot_link_codes")
      .update({
        consumed_at: now.toISOString(),
        consumed_by_channel_id: input.channelId,
      })
      .eq("id", row.id)
      // 경합 방어: 그 사이 누가 썼다면 아무 행도 갱신되지 않는다.
      .is("consumed_at", null)
      .select("id"),
    "연결 코드 소모",
  );
  if (consumed.length === 0) return null;

  unwrap(
    await db
      .from("bot_channel_members")
      .upsert(
        {
          channel_id: input.channelId,
          sender_id: input.senderId,
          user_id: row.user_id,
          display_name: input.displayName,
          linked_at: now.toISOString(),
          last_seen_at: now.toISOString(),
        },
        { onConflict: "channel_id,sender_id" },
      )
      .select("id"),
    "발신자 계정 매핑 저장",
  );

  return { userId: row.user_id, displayName: input.displayName };
}

/** 매핑을 지운다. 지운 것이 있으면 `true`. */
export async function unlinkMember(
  db: AdminDb,
  channelId: string,
  senderId: string,
): Promise<boolean> {
  const removed = unwrap(
    await db
      .from("bot_channel_members")
      .delete()
      .eq("channel_id", channelId)
      .eq("sender_id", senderId)
      .select("id"),
    "발신자 계정 매핑 해제",
  );
  return removed.length > 0;
}

/**
 * 발신자 → 계정. **이것이 신원 해석의 유일한 경로다.**
 *
 * 닉네임 스냅샷은 표시용으로만 갱신한다 — 바뀌었다고 매핑이 흔들리지 않는다.
 */
export async function resolveMember(
  db: AdminDb,
  channelId: string,
  senderId: string,
  displayName: string,
  now: Date,
): Promise<LinkedMember | null> {
  const rows = unwrap(
    await db
      .from("bot_channel_members")
      .select("user_id,display_name")
      .eq("channel_id", channelId)
      .eq("sender_id", senderId)
      .limit(1),
    "발신자 계정 조회",
  );
  const row = rows[0];
  if (row === undefined) return null;

  if (row.display_name !== displayName) {
    ignoreError(
      await db
        .from("bot_channel_members")
        .update({ display_name: displayName, last_seen_at: now.toISOString() })
        .eq("channel_id", channelId)
        .eq("sender_id", senderId),
      "발신자 표시 이름 갱신",
    );
  }

  return { userId: row.user_id, displayName: row.display_name };
}

// ─────────────────────────────────────────────────────────────────────────────
// `channel_pair` — 방 최초 연결
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsumedPairCode {
  readonly codeId: string;
  readonly userId: string;
}

export async function findPairCode(
  db: AdminDb,
  code: string,
): Promise<ConsumedPairCode | null> {
  const row = await findUsableCode(db, code, "channel_pair");
  if (row === null || row.user_id === null) return null;
  return { codeId: row.id, userId: row.user_id };
}

/** 페어링이 끝난 뒤 코드를 소모 처리한다. 실패하면 채널을 만들지 않았어야 하므로 던진다. */
export async function markPairCodeConsumed(
  db: AdminDb,
  codeId: string,
  channelId: string,
  now: Date,
): Promise<boolean> {
  const consumed = unwrap(
    await db
      .from("bot_link_codes")
      .update({
        consumed_at: now.toISOString(),
        consumed_by_channel_id: channelId,
      })
      .eq("id", codeId)
      .is("consumed_at", null)
      .select("id"),
    "페어링 코드 소모",
  );
  return consumed.length > 0;
}
