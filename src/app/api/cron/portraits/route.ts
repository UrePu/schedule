import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  backfillCharacterPortraits,
  type PortraitBackfillSummary,
} from "@/features/characters/server/portrait-backfill";

/**
 * `GET /api/cron/portraits` — **초상화가 비어 있는 추적 캐릭터를 한 번 훑어 채운다.**
 *
 * 발주 지시(2026-09-02): *"api키로 그냥 가져올수있을텐데? 가져와서 저장해"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 크론 문 뒤에 두는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터당 넥슨 1콜이라 **아무나 두드릴 수 있으면 남의 호출량을 태우는 문**이 된다
 * (`api/cron/sync` 와 같은 판단). 세션 뒤에 둘 수도 있었지만 이 작업은 한 사람의 화면이
 * 아니라 **저장소 전체**를 채우는 일이라, 사용자 동작이 아니라 운영 동작이 맞다.
 *
 * ★ 인증 실패는 **404** 다. 401 은 "이 자리에 무언가 있다"를 알려 줘 두드릴 이유를 만든다.
 * ★ 한 번 돌면 그 뒤로는 부를 것이 없다 — 채워진 행은 대상에서 빠지므로 두 번째 실행은
 *   넥슨을 한 번도 부르지 않는다(`pending: 0`).
 * ★ **정기 크론에 넣지 않았다.** 새 캐릭터의 초상화는 선택 모달이 열릴 때 저장되고
 *   (`/api/nexon/character/basic`), 그 경로로 안 채워지는 것은 "추적만 하고 한 번도
 *   안 본 캐릭터" 뿐이다. 주기적으로 도는 값이 아니라 **필요할 때 한 번** 부르는 값이다.
 */

export const dynamic = "force-dynamic";
/** 45명 × (넥슨 왕복 + 키별 250ms)면 10초를 넘길 수 있다. `cron/sync` 와 같은 값. */
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

    const raw = new URL(request.url).searchParams.get("limit");
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    const limit =
      Number.isInteger(parsed) && parsed > 0 && parsed <= 300 ? parsed : undefined;

    const summary = await backfillCharacterPortraits(
      limit === undefined ? undefined : { limit },
    );
    console.info(
      `[cron/portraits] 대상 ${String(summary.pending)}명 · 호출 ${String(
        summary.attempted,
      )} · 저장 ${String(summary.filled)} · 그림없음 ${String(
        summary.noImage,
      )} · 실패 ${String(summary.failed)} · 남음 ${String(summary.remaining)} · ${String(
        summary.elapsedMs,
      )}ms`,
    );
    return jsonOk<PortraitBackfillSummary>(summary);
  } catch (error) {
    return handleRouteError(error, "api/cron/portraits#GET");
  }
}
