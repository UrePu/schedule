import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  MAX_PICKUP,
  pickupOutbox,
  pumpChannelSchedule,
} from "@/features/bot/server/outbox";
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `pollIntervalSec` 은 **고정값이 아니다** (2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 30초 상수였다. 실측해 보니 방 5개가 하루 14,400번을 두드리는데 그중 실제로
 * 보낼 것이 있던 경우는 거의 없었다 — 예정된 런이 0건, 정기 알림은 방 하나에 하루 한 번.
 * 그래서 서버가 **다음 알림까지의 거리**를 재서 돌려준다(`pumpChannelSchedule`).
 * 조용하면 5분까지 벌어지고, 발사 시각이 다가오면 저절로 30초로 좁아진다 —
 * **호출은 1/10 로 줄고 알림은 늦지 않는다.**
 *
 * ⚠️ 이 값은 **런너가 지켜야 효과가 있다.** 무시하고 자기 간격으로 도는 런너에게는
 *    아무 일도 일어나지 않는다(계약상 그래도 동작은 한다).
 */

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

    /*
      ★ **알림 적재를 여기서 한다.** 런너가 어차피 이 경로를 두드리므로, 그 순간 "때가 된
        알림"을 넣으면 별도 크론이 필요 없다 — 방이 살아 있을 때만 도는 구조라 빈 프로젝트에
        스케줄러를 하나 더 세울 이유가 없다.
      ★ **이 방 것만 적재한다.** 폴링하는 방과 무관한 알림까지 만들면 한 방의 폴링이
        다른 방의 지연을 대신 갚는 셈이라, 어느 방이 조용해지면 그쪽만 늦어지는 것이 아니라
        원인을 알 수 없는 편차가 생긴다.
      ★ **픽업이 먼저다.** 순서를 뒤집으면 적재가 실패했을 때 이미 큐에 있던 것까지 못
        가져간다. 그리고 지금 큐에 밀린 것이 있는지(`messages.length`)가 다음 간격을
        정하는 입력이기도 하다 — 밀렸으면 곧바로 다시 오게 해야 한다.
    */
    const messages = await pickupOutbox(db, channel.id, max, now);

    /*
      적재가 실패해도 픽업 결과는 그대로 돌려준다 — 적재는 다음 폴링(수십 초~5분 뒤)에 다시
      시도되지만, 이미 큐에 있는 것까지 못 가져가면 그건 되돌릴 수 없는 손해다.
      그때는 간격도 **보수적으로 최소값**을 쓴다. 다음에 언제 올지 모르는 채로 길게
      재우면 알림이 통째로 밀린다.
    */
    let pollIntervalSec = 30;
    try {
      const pumped = await pumpChannelSchedule(
        db,
        channel.id,
        now,
        messages.length > 0,
      );
      pollIntervalSec = pumped.pollIntervalSec;
    } catch (error) {
      console.error(
        "[api/bot/outbox#GET] 알림 적재 실패:",
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
    }

    return jsonOk<BotOutboxResponse>({
      serverTime: Math.floor(now.getTime() / 1000),
      messages,
      pollIntervalSec,
    });
  } catch (error) {
    return handleRouteError(error, "api/bot/outbox#GET");
  }
}
