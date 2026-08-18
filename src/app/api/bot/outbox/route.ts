import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { MAX_PICKUP, pickupOutbox } from "@/features/bot/server/outbox";
import { authenticateHeaderRequest } from "@/features/bot/server/request-auth";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotOutboxResponse } from "@/features/bot/types";

/**
 * `GET /api/bot/outbox?room=…&max=5` — 밀린 선제 알림을 가져간다. **서명 필요.**
 *
 * 서명 대상 경로에는 **쿼리스트링이 포함**된다(`?room=…&max=…`). GET 은 쿼리가 곧
 * 요청 내용이라, 빼면 `max` 를 바꿔치기해도 서명이 통과한다.
 *
 * ⚠️ **롱폴링(`wait`)은 지원하지 않는다.** 서버리스 함수를 25초 붙잡아 두는 대가가
 *    이 기능의 값어치보다 크고, 계약 자체가 "미지원 클라이언트는 단순 간격 폴링해도
 *    동작한다"로 설계돼 있다. 대신 응답에 `pollIntervalSec` 을 실어, 빈 응답을 받고
 *    곧바로 다시 부르는 열린 루프가 생기지 않게 한다.
 */

const POLL_INTERVAL_SEC = 30;

export async function GET(request: Request): Promise<Response> {
  const now = new Date();
  try {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    const maxRaw = Number.parseInt(url.searchParams.get("max") ?? "", 10);
    const max = Number.isFinite(maxRaw) ? maxRaw : MAX_PICKUP;

    const db = getAdminDb();
    const channel = await authenticateHeaderRequest({
      db,
      request,
      room,
      body: null,
      now,
    });

    const messages = await pickupOutbox(db, channel.id, max, now);

    return jsonOk<BotOutboxResponse>({
      serverTime: Math.floor(now.getTime() / 1000),
      messages,
      pollIntervalSec: POLL_INTERVAL_SEC,
    });
  } catch (error) {
    return handleRouteError(error, "api/bot/outbox#GET");
  }
}
