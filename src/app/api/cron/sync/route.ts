import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { CRON_SLOTS, runNightlySync } from "@/features/boss-plans/server/nightly-sync";
import type {
  CronSlot,
  NightlySyncSummary,
} from "@/features/boss-plans/server/nightly-sync";

/**
 * `GET /api/cron/sync` — 매일 밤 예약 동기화 (2026-08-20 발주 지시).
 *
 * *"매일 저녁 23시 55분에 동기화를 돌린다고 치면"* → **23:50 KST = 14:50 UTC** 로 잡았다.
 * 넥슨 데이터가 ~15분 지연되므로(§1.1) 자정에 가까울수록 마지막 판을 놓치고, 실패했을 때
 * 다시 시도할 여유도 사라진다. 5분 앞이 그 둘을 조금씩 산다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 인증 — **크론만 부를 수 있어야 한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 라우트는 세션 없이 **DB 에 저장된 사용자 키로 넥슨을 부른다.** 열려 있으면 누구나
 * 남의 호출량을 태울 수 있는 문이 된다. Vercel 크론은 `Authorization: Bearer $CRON_SECRET`
 * 을 붙여 주므로 그 값과 대조한다.
 *
 * ⚠️ **`CRON_SECRET` 이 없으면 아무도 부를 수 없다.** 환경변수가 비어 있을 때 통과시키면
 *    배포 직후의 무방비 창이 생긴다 — 설정 누락은 잠기는 쪽으로 실패해야 한다.
 * ⚠️ 응답에 **누가 동기화됐는지 적지 않는다.** 크론 로그는 대개 넓게 보이므로 건수만 남긴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `?slot=` — 어느 크론이 불렀는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 크론이 둘이다(`vercel.json`). 매일 23:55 짜리와, **수요일 23:00** 에 한 번 더 도는
 * 목요일 초기화 직전 보험. 둘은 같은 일을 하지만 **대표하는 시각이 다르므로**, 발견한
 * 클리어를 어느 시각에 박을지는 부른 쪽이 말해 줘야 한다(`nightly-sync` 의 `CRON_SLOTS`).
 *
 * 모르는 값이 오면 **거절하지 않고 `nightly` 로 떨어뜨린다.** 여기서 400 을 내면 오타 하나로
 * 그날 밤 동기화가 통째로 사라지는데, 최악이라야 명목 시각이 55분 어긋나는 것뿐이다.
 */

export const dynamic = "force-dynamic";
/**
 * 28명 × (넥슨 왕복 + 키별 250ms 간격)이면 10초를 넘길 수 있다. 기본 한도로는 중간에
 * 잘리고, 잘린 뒤 남은 캐릭터는 그날 밤 아무도 다시 부르지 않는다.
 */
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret === "") return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!isAuthorized(request)) {
      /*
        401 이 아니라 **404** 다. 401 은 "이 자리에 무언가 있다"를 알려 주므로 크론 경로를
        찾아 두드릴 이유를 만든다(파티 열람 판정과 같은 규약).
      */
      return new Response("Not Found", { status: 404 });
    }

    const requested = new URL(request.url).searchParams.get("slot");
    const slot: CronSlot =
      requested !== null && requested in CRON_SLOTS
        ? (requested as CronSlot)
        : "nightly";

    const summary = await runNightlySync(new Date(), slot);
    console.info(
      `[cron/sync] slot=${slot} · 동기화 ${String(summary.synced)}건 · 건너뜀 ${String(
        summary.skipped,
      )}건 · 실패 ${String(summary.failed)}건 · 서버키없음 ${String(
        summary.noServerKey,
      )}건 · ${String(summary.elapsedMs)}ms`,
    );

    return jsonOk<NightlySyncSummary>(summary);
  } catch (error) {
    return handleRouteError(error, "api/cron/sync#GET");
  }
}
