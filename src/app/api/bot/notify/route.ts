import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  runDirectNotifications,
  type DirectNotifySummary,
} from "@/features/bot/server/direct-notify";
import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /api/bot/notify` — 개인톡 알림을 아웃박스에 적재한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * pg_cron 이 **10분마다** 부른다. 다만 그 앞에 **SQL 게이트**가 있어서, 보낼 것이 없는
 * 틱에서는 이 라우트가 아예 불리지 않는다(`trigger_bot_notify()` →
 * `bot_direct_notify_pending()`, 마이그레이션 `20260831120100`). 하루 144번 중 대부분이
 * 그 자리에서 끝나므로 실제 호출은 알림이 있는 날 몇 번뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 인증 — **왜 방 시크릿 + HMAC 이 아닌가**
 * ─────────────────────────────────────────────────────────────────────────────
 * 다른 `/api/bot/*` 는 런너가 부르므로 **방별 시크릿 + HMAC 서명 + 타임스탬프 + nonce**
 * 를 쓴다(§2.2, `server/request-auth.ts`). 이 경로는 부르는 쪽이 런너가 아니라 **우리
 * 데이터베이스의 크론**이고, 특정 방에 매이지도 않는다(대상이 여러 사람이다). 방이
 * 없으니 방 시크릿이 있을 수 없고, 억지로 하나를 고르면 그 방이 죽는 순간 전원의 알림이
 * 멈춘다.
 *
 * 그래서 **크론 경로의 기존 관례**를 그대로 따른다 — `/api/cron/sync` 와 같은
 * `Authorization: Bearer $CRON_SECRET` 이다. 봇 쪽 관례를 버린 것이 아니라, 이 요청의
 * 발신자가 봇이 아니라 크론이라 그쪽 관례가 맞는 것이다.
 *
 * ⚠️ **`CRON_SECRET` 이 비어 있으면 아무도 부를 수 없다.** 설정 누락은 **잠기는 쪽**으로
 *    실패해야 한다 — 통과시키면 배포 직후에 누구나 남의 방으로 알림을 밀어 넣을 수 있는
 *    무방비 창이 생긴다.
 * ⚠️ 실패는 **401 이 아니라 404** 다. 401 은 "이 자리에 무언가 있다"를 알려 주므로 찾아
 *    두드릴 이유를 만든다(`/api/cron/sync` · 파티 열람 판정과 같은 규약).
 * ⚠️ 응답에 **누구에게 보냈는지 적지 않는다.** 크론 로그는 대개 넓게 보이므로 건수만 남긴다.
 *
 * ★ `inserted = 0` 은 **정상**이다. 게이트는 "런 하나가 발사 거리에 들었다"까지 보고,
 *   실제 발송은 **묶음의 첫 런**에서만 일어난다(`direct-notify.ts` 머리말). 이미 같은
 *   `dedupe_key` 가 아웃박스에 있는 경우도 0 이다 — 그게 중복 방지가 작동한 모습이다.
 */

export const dynamic = "force-dynamic";

/** 대상이 여럿이면 사람마다 조회가 붙는다. 기본 한도로는 중간에 잘릴 수 있다. */
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret === "") return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!isAuthorized(request)) {
      return new Response("Not Found", { status: 404 });
    }

    const summary = await runDirectNotifications(getAdminDb(), new Date());
    console.info(
      `[api/bot/notify] 대상 ${String(summary.targets)}명 · 적재 ${String(
        summary.inserted,
      )}건`,
    );

    return jsonOk<DirectNotifySummary>(summary);
  } catch (error) {
    return handleRouteError(error, "api/bot/notify#GET");
  }
}
