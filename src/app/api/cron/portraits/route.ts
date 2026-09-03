import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  backfillGuestPortraits,
  type GuestPortraitBackfillSummary,
} from "@/features/characters/server/name-portrait-lookup";
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 단계를 **이어서** 돌린다 (2026-09-03)
 * ─────────────────────────────────────────────────────────────────────────────
 *   ① `backfillCharacterPortraits` — ocid 를 아는 캐릭터. 캐릭터당 **1콜**.
 *   ② `backfillGuestPortraits`     — 이름밖에 모르는 파티 게스트. 이름당 **2콜**
 *                                    (`/id` → `/character/basic`), `character_looks` 에 적힌다.
 *
 * ★ **둘은 대상이 겹치지 않는다.** ① 은 `characters` 행(ocid 를 아는 캐릭터), ② 는
 *   `party_participants.user_id` 가 null 인 **게스트**만 본다. 게스트는 화면에서
 *   `characters` 행에 닿을 경로 자체가 없어서(임베딩도 본캐 폴백도 안 걸린다) ① 이 아무리
 *   돌아도 얼굴이 안 나온다 — 그래서 ② 가 이름으로 다시 부른다.
 *   ⚠️ 예전 주석은 *"② 가 ① 이 채우는 이름을 대상에서 뺀다"* 고 적혀 있었고 코드도 그랬다.
 *      그 판정이 결함이었다(2026-09-03 실측): 이름이 `characters` 에 있다는 것과 **이
 *      참가자가 그 행에 닿을 수 있다**는 것은 다른 질문이라, 남의 캐릭터와 이름이 같은
 *      게스트 7명이 영구 실루엣으로 남았다. 판정은 이제 참가자 단위다.
 * ★ 그래도 `Promise.all` 이 아니다 — 나란히 돌리면 넥슨 초당 한도를 서로 밀치고,
 *   한쪽이 터졌을 때 어느 쪽 요약이 비어 있는지 읽기 어려워진다.
 * ★ **응답의 최상위 필드 이름은 그대로다.** ① 의 요약이 최상위에 펼쳐지고 ② 는 `guests`
 *   아래로 들어간다. 기존 호출부가 읽던 `filled`·`remaining` 등이 자리를 옮기지 않는다.
 */

export const dynamic = "force-dynamic";
/** 45명 × (넥슨 왕복 + 키별 250ms)면 10초를 넘길 수 있다. `cron/sync` 와 같은 값. */
export const maxDuration = 60;

/**
 * 응답 본문.
 *
 * ★ ① 의 요약을 **최상위에 그대로 펼친다.** 감싸면 `filled`·`remaining` 같은 필드가
 *   한 칸 아래로 내려가 기존 호출부가 조용히 깨진다. ② 는 새 필드라 그런 사정이 없다.
 */
type PortraitCronSummary = PortraitBackfillSummary & {
  readonly guests: GuestPortraitBackfillSummary;
};

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

    const guests = await backfillGuestPortraits(
      limit === undefined ? undefined : { limit },
    );
    console.info(
      `[cron/portraits] 게스트 대상 ${String(guests.pending)}명 · 조회 ${String(
        guests.attempted,
      )} · 저장 ${String(guests.filled)} · 그림없음 ${String(
        guests.noImage,
      )} · 실패 ${String(guests.failed)} · 남음 ${String(guests.remaining)} · ${String(
        guests.elapsedMs,
      )}ms`,
    );

    return jsonOk<PortraitCronSummary>({ ...summary, guests });
  } catch (error) {
    return handleRouteError(error, "api/cron/portraits#GET");
  }
}
