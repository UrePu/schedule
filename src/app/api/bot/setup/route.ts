import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchBotSetup } from "@/features/bot/server/setup-repo";
import type { BotSetupState } from "@/features/bot/types";

/**
 * `GET /api/bot/setup` — 내 계정에 연결된 카톡 닉네임 목록.
 *
 * ⚠️ 2026-09-28 이전에는 "내가 관여하는 방 + 내 파티의 알림 목적지" 였다. 방과 알림이
 * 함께 삭제되면서 남은 것은 신원 하나다.
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
