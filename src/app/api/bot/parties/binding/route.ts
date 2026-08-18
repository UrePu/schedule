import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { setPartyChannel } from "@/features/bot/server/setup-repo";
import type { BotBoundParty } from "@/features/bot/types";

/**
 * `PUT /api/bot/parties/binding` — 파티 알림이 갈 방을 정한다. **세션 인증.**
 *
 * 요청 `{ partyId, channelId | null }` → 응답 `{ party }`
 *
 * ★ **알림은 사람이 아니라 방을 따라간다**(§2.3). 한 사람이 여러 방에 있을 때 사람
 *   기준으로 라우팅하면 전 방에 도배된다. `channelId = null` 은 "웹 전용 파티,
 *   푸시 없음"이며 **정상 상태**다.
 * ★ 목적지 해석 자체는 언제나 `party_notify_channel_ids()` 를 통한다 — 나중에 한 파티가
 *   여러 방에 알림을 보내야 해지면 그 함수만 고치면 되고, 여기와 적재 코드는 그대로다.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  partyId: z.string().regex(UUID, "파티 식별자 형식이 올바르지 않습니다."),
  channelId: z
    .string()
    .regex(UUID, "방 식별자 형식이 올바르지 않습니다.")
    .nullable(),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const party = await setPartyChannel(session.uid, body.partyId, body.channelId);
    return jsonOk<{ party: BotBoundParty }>({ party });
  } catch (error) {
    return handleRouteError(error, "api/bot/parties/binding#PUT");
  }
}
