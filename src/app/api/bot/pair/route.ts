import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { generateRoomId } from "@/features/bot/server/channel";
import {
  findPairCode,
  markPairCodeConsumed,
  normalizeCode,
} from "@/features/bot/server/link";
import { deriveChannelSecret, hashSecret } from "@/features/bot/server/signature";
import { unwrap } from "@/features/bot/server/shared";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotPairResponse } from "@/features/bot/types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/bot/pair` — 방 최초 연결
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * **부트스트랩 구간이라 여기만 무서명이다.** 아직 시크릿이 없으니 서명할 수가 없다.
 * 그래서 방어를 따로 건다:
 *   - 6자리 코드(32글자 알파벳 ≈ 10.7억) · TTL 10분 · **1회용**
 *   - 코드는 웹에서 **로그인한 사람만** 발급한다 → 방의 주인이 누구인지가 정해진다
 *   - IP 당 분당 5회 (아래 주석 참고)
 *
 * ⚠️ **원문 시크릿은 이 응답이 유일한 출구다.** 서버는 `sha256(secret)` 만 보관하며,
 *    원문은 요청 시각에 마스터키에서 다시 파생해 만든다(`server/signature.ts` 머리말).
 *    로그에도 남기지 않는다.
 *
 * ⚠️ 우리는 **서버만 제공한다.** 이 계약을 만족하는 클라이언트는 무엇이든 붙을 수 있고,
 *    이 저장소는 그런 클라이언트를 만들거나 배포하지 않는다.
 */

const bodySchema = z.object({
  code: z.string().trim().min(1).max(32),
  /** 로그·통계 전용. **분기 로직에 쓰지 않는다**(§3.6). */
  runner: z.string().trim().max(60).optional(),
  roomFingerprint: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "방 지문 형식이 올바르지 않습니다.")
    .optional(),
});

/** 폴링 권장 간격. 클라이언트가 이 값을 지키면 방당 부하가 예측 가능해진다. */
const POLL_INTERVAL_SEC = 30;

/*
  IP 레이트리밋 — **프로세스 내 최선 노력**이다.
  담을 테이블이 없고(이번 작업은 새 마이그레이션 금지) 인스턴스가 여러 개면 한도가 그만큼
  늘어난다. 진짜 방어는 위의 코드 공간·TTL·1회용이며, 이 맵은 한 대에서 코드를 연타로
  긁는 흔한 경우를 끊는 용도다.
*/
const PAIR_LIMIT = 5;
const PAIR_WINDOW_MS = 60_000;
const pairAttempts = new Map<string, { count: number; resetAt: number }>();

function tooManyPairAttempts(ip: string, now: Date): boolean {
  const entry = pairAttempts.get(ip);
  if (entry === undefined || entry.resetAt <= now.getTime()) {
    pairAttempts.set(ip, { count: 1, resetAt: now.getTime() + PAIR_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > PAIR_LIMIT;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded !== "") {
    return (forwarded.split(",")[0] ?? "").trim() || "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  try {
    if (tooManyPairAttempts(clientIp(request), now)) {
      throw ApiError.botRateLimited();
    }

    const body = await readJsonBody(request, bodySchema);
    const code = normalizeCode(body.code);
    // 형식 오류와 없는 코드를 같은 답으로 접는다 — 살아 있는 코드를 훑을 수 없게.
    if (code === null) throw ApiError.botUnauthorized(404);

    const db = getAdminDb();
    const pairCode = await findPairCode(db, code);
    if (pairCode === null) throw ApiError.botUnauthorized(404);

    const room = generateRoomId();
    const inserted = unwrap(
      await db
        .from("bot_channels")
        .insert({
          room,
          platform: "kakao",
          // 세대 0. 회전할 때마다 1씩 오른다(`server/signature.ts`).
          secret_hash: "0".repeat(64),
          owner_user_id: pairCode.userId,
          // **서명 없는 채널은 만들지 않는다**(`server/channel.ts` 머리말의 근거).
          signed: true,
          runner: body.runner ?? null,
          room_fingerprint: body.roomFingerprint ?? null,
          last_seen_at: now.toISOString(),
        })
        .select("id"),
      "채널 생성",
    );
    const channelId = inserted[0]?.id;
    if (channelId === undefined) throw ApiError.internal();

    /*
      시크릿은 **채널 id 에서 파생**되므로 행을 만든 뒤에야 계산할 수 있다.
      그래서 두 단계다: 자리표시자 해시로 삽입 → 진짜 해시로 갱신.
      중간 상태의 해시는 어떤 시크릿과도 대응하지 않으므로 그 사이에는 아무도 통과하지 못한다.
    */
    const secret = deriveChannelSecret(channelId, 0);
    unwrap(
      await db
        .from("bot_channels")
        .update({ secret_hash: hashSecret(secret) })
        .eq("id", channelId)
        .select("id"),
      "채널 시크릿 확정",
    );

    const consumed = await markPairCodeConsumed(db, pairCode.codeId, channelId, now);
    if (!consumed) {
      // 경합에서 졌다면 방금 만든 채널은 주인이 없다. 남겨 두면 유령 채널이 된다.
      unwrap(
        await db.from("bot_channels").delete().eq("id", channelId).select("id"),
        "경합 채널 회수",
      );
      throw ApiError.botUnauthorized(404);
    }

    return jsonOk<BotPairResponse>(
      { room, secret, pollIntervalSec: POLL_INTERVAL_SEC },
      201,
    );
  } catch (error) {
    return handleRouteError(error, "api/bot/pair#POST");
  }
}
