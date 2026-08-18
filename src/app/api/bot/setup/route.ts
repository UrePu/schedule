import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchBotSetup } from "@/features/bot/server/setup-repo";
import type { BotSetupState } from "@/features/bot/types";

/**
 * `GET /api/bot/setup` — 내가 관여하는 방 + 내 파티의 알림 목적지.
 *
 * **세션 인증**이다. 봇 엔드포인트(채널 서명)와 인증 수단이 다르지만, 오류 몸체와
 * `handleRouteError` 마감은 다른 쓰기 API 와 같은 규약을 쓴다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();
    const setup = await fetchBotSetup(session.uid);
    return jsonOk<BotSetupState>(setup);
  } catch (error) {
    return handleRouteError(error, "api/bot/setup#GET");
  }
}
