import { after } from "next/server";

import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { CRON_SLOTS, runNightlySync } from "@/features/boss-plans/server/nightly-sync";
import { runExpDailyFill } from "@/features/characters/server/exp-daily-fill";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type {
  CronSlot,
  NightlySyncSummary,
} from "@/features/boss-plans/server/nightly-sync";

/**
 * `GET /api/cron/sync` — **매시 50분** 예약 동기화.
 *
 * 발주 지시(2026-08-25): *"밤 11시 크론 없애고 그냥 매 시간 50분에 크론돌리는게
 * 낫지않나? 결국 아침에 돈사람들은 자동으로 !결정석 했을때 못보네"*.
 * 밤에만 돌면 아침에 잡은 보스가 그날 밤까지 어디에도 안 보인다.
 * 50분인 이유: 넥슨 데이터가 ~15분 늦으므로(§1.1) 정시에 돌면 직전 45분을 못 본다.
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
 * 지금 실제로 도는 것은 **pg_cron `50 * * * *`(매시 50분) 하나**뿐이고 `slot=hourly` 로
 * 들어온다(2026-08-25 발주 지시로 밤 크론·수요일 스윕을 걷어냈다 —
 * `20260826100000_hourly_sync_cron.sql`). `nightly` 는 손으로 돌릴 때를 위한 이름이며,
 * 슬롯마다 **대표하는 시각이 다르므로** 발견한 클리어를 어느 시각에 박을지는 부른 쪽이
 * 말해 줘야 한다(`nightly-sync` 의 `CRON_SLOTS`).
 *
 * 모르는 값이 오면 **거절하지 않고 `hourly` 로 떨어뜨린다.** 여기서 400 을 내면 오타 하나로
 * 동기화가 통째로 사라지는데, 최악이라야 클리어 시각이 조금 어긋나는 것뿐이다.
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
        : "hourly";

    const startedAt = Date.now();
    const now = new Date(startedAt);
    const summary = await runNightlySync(now, slot);

    /*
      ★ 어제 경험치 채우기(`!%` 용, 2026-11-18)는 **동기화 응답을 낸 뒤에** 돈다. 그래서 이 단계가
        느리거나 실패해도 위 동기화 결과와 응답 코드는 바뀌지 않는다(pg_net 은 매시 200 을 본다).
        시간 예산은 이 요청이 시작된 시각에서 잰다 — `after` 도 `maxDuration` 안에서만 산다.
        규칙(시간대 · 대상 · 키)은 `exp-daily-fill.ts` 머리말에 있다.
    */
    try {
      after(async () => {
        try {
          const fill = await runExpDailyFill(getAdminDb(), now, startedAt);
          if (!fill.outsideWindow) {
            console.info(
              `[cron/sync] 어제 경험치 · 대상 ${String(fill.targets)} · 채움 ${String(fill.filled)} · ` +
                `이미 있음 ${String(fill.alreadyStored)} · 키 건너뜀 ${String(fill.skippedKey)} · ` +
                `실패 ${String(fill.failed)} · 미룸 ${String(fill.deferred)} · ${String(fill.elapsedMs)}ms`,
            );
          }
        } catch (error) {
          console.warn(
            `[cron/sync] 어제 경험치 채우기 실패(동기화와 무관): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } catch (error) {
      // 등록조차 못 해도 동기화 응답은 그대로 나간다 — 이번 시간 채우기만 빠진다.
      console.warn(
        `[cron/sync] 어제 경험치 채우기 등록 실패(동기화와 무관): ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
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
