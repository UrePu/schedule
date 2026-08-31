import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 채널 게이트 — **모든 봇 요청이 여기를 먼저 통과한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇 트래픽은 사용자 세션이 아니라 **채널 시크릿**으로 인증된다. 즉 RLS 로 보호되는
 * 대상이 아니다(마이그레이션 06 머리말). anon/authenticated 는 봇 테이블 전체가
 * 차단돼 있고, 이 파일이 서명을 검증한 **뒤에만** service_role 로 접근한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `signed = false` 채널을 받지 않기로 했다 — 근거
 * ─────────────────────────────────────────────────────────────────────────────
 * research-KAKAO-BOT §3.4 는 "HMAC 을 못 계산하는 클라이언트를 위해 Bearer + 타임스탬프로
 * 낮춘 채널을 별도 플래그로 표시하고 아웃박스 권한만 제한한다"는 대안을 남겼다.
 * **이번 구현은 그 대안을 열지 않는다.**
 *   - CLAUDE.md §2.2 의 계약에서 `signature` 는 **필수 필드**다.
 *   - 무서명 채널은 방 ID 하나만 알면 남이 `!드랍` 을 쳐 **수익 원장에 쓰기**를 할 수
 *     있는 경로가 된다. 아웃박스만 막는 것으로는 그 구멍이 닫히지 않는다.
 *     (예시가 `!클리어` 였으나 2026-08-20 에 그 명령을 뺐다. 원장에 쓰는 명령이 하나라도
 *      남아 있는 한 이 근거는 그대로 성립하므로 예시만 바꾼다.)
 *   - 페어링은 언제나 `signed = true` 로 만든다. 컬럼은 그대로 두었으므로, 나중에
 *     정말 필요해지면 이 함수 하나에 분기를 더하면 된다.
 */

import { randomInt } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import type { AdminDb } from "@/lib/supabase/admin-db";

import { ignoreError, unwrap } from "./shared";
import {
  computeSignature,
  resolveSecretByHash,
  signatureEquals,
  timestampWithinWindow,
} from "./signature";

/** 서명 실패 임계. 넘으면 채널을 임시 정지한다(research-KAKAO-BOT §3.4). */
const SIGNATURE_FAILURE_LIMIT = 20;

/** 임시 정지 길이. 임계와 같은 10분이다. */
const SUSPENSION_MINUTES = 10;

const CHANNEL_COLUMNS =
  "id,room,platform,kind,status,signed,owner_user_id,secret_hash,previous_secret_hash,previous_secret_expires_at,signature_failure_count,suspended_until";

export interface BotChannelRow {
  readonly id: string;
  readonly room: string;
  readonly platform: string;
  /**
   * 방 종류(2026-08-31). `party_room` = 여럿이 있는 방 · `direct` = 한 사람의 개인톡.
   *
   * ★ **명령의 뜻이 이 값으로 갈린다.** `!알림` 이 대표적이다 — 파티방에서는 "이 방의
   *   정기 시각과 파티별 오프셋"이고, 개인톡에서는 "내 모든 일정의 요약·임박 설정"이다.
   *   같은 이름을 쓰는 것이 맞다: 사람이 알고 싶은 것("나한테 언제 알려 줄래")은 하나이고,
   *   방의 성격이 그 답을 정한다.
   */
  readonly kind: "party_room" | "direct";
  readonly status: "active" | "degraded" | "paused";
  readonly signed: boolean;
  readonly owner_user_id: string | null;
  readonly secret_hash: string;
  readonly previous_secret_hash: string | null;
  readonly previous_secret_expires_at: string | null;
  readonly signature_failure_count: number;
  readonly suspended_until: string | null;
}

/** `room` 형식. DB 의 CHECK 와 같은 규칙을 **DB 를 때리기 전에** 적용한다. */
export const ROOM_PATTERN = /^ch_[A-Za-z0-9]{8,40}$/;

const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_BODY_LENGTH = 24;

/**
 * 새 채널 ID. **불투명하다** — 카톡 방 이름도 `chat_id` 도 여기 들어가지 않는다(§3.6).
 *
 * 24자 · 62진 ≈ 143비트. 열거로 남의 방을 찾는 일이 성립하지 않는다.
 */
export function generateRoomId(): string {
  let body = "";
  for (let index = 0; index < ROOM_BODY_LENGTH; index += 1) {
    body += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return `ch_${body}`;
}

export async function loadChannelByRoom(
  db: AdminDb,
  room: string,
): Promise<BotChannelRow | null> {
  if (!ROOM_PATTERN.test(room)) return null;
  const rows = unwrap(
    await db.from("bot_channels").select(CHANNEL_COLUMNS).eq("room", room).limit(1),
    "채널 조회",
  );
  return (rows[0] as BotChannelRow | undefined) ?? null;
}

/**
 * 지금 이 채널이 요청을 받을 수 있는 상태인가.
 *
 * ★ `paused` 와 `suspended_until` 은 **다른 것**이다. 앞은 사람이 끈 것, 뒤는 서명
 *   실패가 쌓여 자동으로 잠긴 것이다. 둘 다 403 이지만 로그에서는 구분된다.
 * ★ `degraded` 는 **막지 않는다.** 아웃박스 배달이 실패한 상태라는 표시일 뿐이고,
 *   명령에 답하는 것은 여전히 정상이다 — 오히려 그때 사람이 상태를 물어본다.
 */
export function assertChannelUsable(channel: BotChannelRow, now: Date): void {
  if (channel.status === "paused") {
    console.warn(`[bot] 정지된 채널 요청: channel=${channel.id}`);
    throw ApiError.botUnauthorized(403);
  }
  if (
    channel.suspended_until !== null &&
    new Date(channel.suspended_until).getTime() > now.getTime()
  ) {
    console.warn(`[bot] 임시 정지 중 채널 요청: channel=${channel.id}`);
    throw ApiError.botUnauthorized(403);
  }
}

/**
 * 서명을 검증한다. 실패는 **던진다** — 호출부가 성공 경로만 보게 하려는 것이다.
 *
 * 회전 중이면 **구 시크릿도 받는다**(`previous_secret_expires_at` 이 살아 있을 때만).
 * 그 창이 없으면 회전 순간 방의 봇이 조용히 죽는다 — 클라이언트가 새 시크릿을 받아
 * 반영하기까지 시차가 있기 때문이다.
 */
export async function verifyChannelSignature(
  db: AdminDb,
  channel: BotChannelRow,
  base: string,
  presented: string,
  timestamp: number,
  now: Date,
): Promise<void> {
  if (!channel.signed) {
    console.warn(`[bot] 무서명 채널은 허용하지 않습니다: channel=${channel.id}`);
    throw ApiError.botUnauthorized(401);
  }

  if (!timestampWithinWindow(timestamp, now)) {
    await noteSignatureFailure(db, channel, now, "timestamp");
    throw ApiError.botUnauthorized(401);
  }

  const current = resolveSecretByHash(channel.id, channel.secret_hash);
  if (current !== null && signatureEquals(computeSignature(current, base), presented)) {
    await noteSignatureSuccess(db, channel, now);
    return;
  }

  const previousAlive =
    channel.previous_secret_hash !== null &&
    channel.previous_secret_expires_at !== null &&
    new Date(channel.previous_secret_expires_at).getTime() > now.getTime();

  if (previousAlive && channel.previous_secret_hash !== null) {
    const previous = resolveSecretByHash(channel.id, channel.previous_secret_hash);
    if (previous !== null && signatureEquals(computeSignature(previous, base), presented)) {
      await noteSignatureSuccess(db, channel, now);
      return;
    }
  }

  await noteSignatureFailure(db, channel, now, "signature");
  throw ApiError.botUnauthorized(401);
}

/**
 * 성공하면 실패 카운터를 **0 으로 되돌린다.**
 *
 * ⚠️ 스키마에 "실패 시각"을 담을 컬럼이 없어 *10분 내 20회* 를 글자 그대로 세지 못한다.
 *    대신 **성공하면 리셋**하는 방식으로 근사한다. 실질 효과는 같다 — 정상 클라이언트는
 *    매 요청 성공하므로 카운터가 쌓이지 않고, 무작위로 두드리는 쪽만 20을 채운다.
 *    (새 마이그레이션은 이번 작업에서 금지되어 있어 컬럼을 늘리지 않았다.)
 */
async function noteSignatureSuccess(
  db: AdminDb,
  channel: BotChannelRow,
  now: Date,
): Promise<void> {
  ignoreError(
    await db
      .from("bot_channels")
      .update({
        last_seen_at: now.toISOString(),
        // 이미 0/null 이어도 같은 값을 다시 쓰는 것뿐이라 왕복이 늘지 않는다.
        signature_failure_count: 0,
        suspended_until: null,
      })
      .eq("id", channel.id),
    "채널 접속 시각 갱신",
  );
}

async function noteSignatureFailure(
  db: AdminDb,
  channel: BotChannelRow,
  now: Date,
  reason: "signature" | "timestamp",
): Promise<void> {
  const next = channel.signature_failure_count + 1;
  const exceeded = next > SIGNATURE_FAILURE_LIMIT;

  console.warn(
    `[bot] 서명 검증 실패(${reason}): channel=${channel.id} count=${String(next)}` +
      (exceeded ? " → 임시 정지" : ""),
  );

  ignoreError(
    await db
      .from("bot_channels")
      .update(
        exceeded
          ? {
              signature_failure_count: 0,
              suspended_until: new Date(
                now.getTime() + SUSPENSION_MINUTES * 60_000,
              ).toISOString(),
            }
          : { signature_failure_count: next },
      )
      .eq("id", channel.id),
    "서명 실패 카운트 갱신",
  );
}
