import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { ackOutbox } from "@/features/bot/server/outbox";
import { authenticateHeaderRequest } from "@/features/bot/server/request-auth";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotOutboxAckResponse } from "@/features/bot/types";

/**
 * `POST /api/bot/outbox/ack` — 배달 확인. **서명 필요.**
 *
 * ★ **멱등하다.** 이미 `sent` 인 id 를 다시 ack 해도 아무것도 바뀌지 않는다(`applied` 만
 *   0 이 된다). 클라이언트는 ack 응답을 못 받았을 때 마음 놓고 다시 보낼 수 있다.
 * ★ 재시도 가능한 실패는 백오프 뒤 다시 노출되고, `room_not_found` · `permission_denied`
 *   같은 비재시도 실패는 즉시 끝내고 채널을 `degraded` 로 표시한다.
 */

const bodySchema = z.object({
  room: z.string().trim().min(1).max(64),
  results: z
    .array(
      z.object({
        id: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            "알림 식별자 형식이 올바르지 않습니다.",
          ),
        status: z.enum(["sent", "failed"]),
        error: z.string().trim().max(200).optional(),
      }),
    )
    .max(50),
});

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  try {
    let raw: unknown;
    try {
      raw = (await request.json()) as unknown;
    } catch {
      throw ApiError.badRequest("요청 본문이 JSON 이 아닙니다.");
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw ApiError.badRequest("요청 형식이 올바르지 않습니다.");

    const db = getAdminDb();
    const channel = await authenticateHeaderRequest({
      db,
      request,
      room: parsed.data.room,
      body: raw,
      now,
    });

    const applied = await ackOutbox(db, channel.id, parsed.data.results, now);
    return jsonOk<BotOutboxAckResponse>({ applied });
  } catch (error) {
    return handleRouteError(error, "api/bot/outbox/ack#POST");
  }
}
