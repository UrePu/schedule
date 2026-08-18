import "server-only";

/**
 * 헤더 서명 방식의 요청 인증 (`/outbox` · `/outbox/ack` · `/rotate`).
 *
 * `POST /api/bot/command` 만 서명을 **본문 필드**로 받는다 — 커스텀 헤더를 붙이지 못하는
 * 클라이언트가 있어서다(research-KAKAO-BOT §3.4). 나머지는 헤더가 깔끔하다.
 *
 *   X-MS-Timestamp / X-MS-Nonce / X-MS-Signature
 *   base = "{timestamp}.{nonce}.{METHOD}.{path+query}.{sha256(canonical body)}"
 *
 * ⚠️ **nonce 를 `bot_command_log` 에 넣지 않는다.** 그 표는 `command like '!%'` CHECK 가
 *    걸린 **명령 감사 로그**이고, 30초마다 오는 폴링을 거기 쌓으면 명령 이력이 폴링에
 *    파묻힌다. 대신 이 경로들은 **재생해도 부작용이 없도록** 설계되어 있다:
 *      - 폴링 재생 → 리스가 이미 걸려 같은 건이 두 번 나가지 않는다.
 *      - ack 재생 → `sent` 는 되돌아가지 않으므로 두 번째는 아무것도 바꾸지 않는다.
 *      - 회전 재생 → 타임스탬프 창(±300초) 안에서만 가능하고, 재생하면 새 시크릿이
 *        하나 더 나올 뿐 이전 것은 유예 기간 동안 계속 유효하다.
 *    nonce 는 그래도 **요구한다.** 없으면 서명이 요청마다 같아져 캡처 한 번이 영구
 *    유효해지고, 창 안이라도 반복 사용이 가능해진다.
 */

import { ApiError } from "@/features/auth/server/http";
import type { AdminDb } from "@/lib/supabase/admin-db";

import {
  assertChannelUsable,
  loadChannelByRoom,
  verifyChannelSignature,
  type BotChannelRow,
} from "./channel";
import { canonicalize, sha256Hex, signatureBase } from "./signature";

export interface HeaderAuthInput {
  readonly db: AdminDb;
  readonly request: Request;
  readonly room: string;
  /** 본문이 있으면 그 **파싱된 객체**. 없으면 `null`(GET). */
  readonly body: unknown;
  readonly now: Date;
}

export async function authenticateHeaderRequest(
  input: HeaderAuthInput,
): Promise<BotChannelRow> {
  const timestampRaw = input.request.headers.get("x-ms-timestamp");
  const nonce = input.request.headers.get("x-ms-nonce");
  const signature = input.request.headers.get("x-ms-signature");

  if (timestampRaw === null || nonce === null || signature === null) {
    throw ApiError.botUnauthorized(401);
  }
  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) throw ApiError.botUnauthorized(401);
  if (nonce.length < 8 || nonce.length > 200) throw ApiError.botUnauthorized(401);

  const channel = await loadChannelByRoom(input.db, input.room);
  // 없는 방과 서명 실패를 같은 종류로 접는다 — 불투명 ID 의 존재 여부를 알리지 않는다.
  if (channel === null) throw ApiError.botUnauthorized(404);
  assertChannelUsable(channel, input.now);

  const url = new URL(input.request.url);
  const base = signatureBase({
    timestamp,
    nonce,
    method: input.request.method,
    path: `${url.pathname}${url.search}`,
    bodyHash: sha256Hex(input.body === null ? "" : canonicalize(input.body)),
  });

  await verifyChannelSignature(
    input.db,
    channel,
    base,
    signature,
    timestamp,
    input.now,
  );
  return channel;
}
