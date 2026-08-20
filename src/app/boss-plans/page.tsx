import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { readSession } from "@/features/auth/server/session";
import { BossPlanWorkspace } from "@/features/boss-plans/components";
import {
  fetchCharacterPlanBundle,
  fetchWeeklyChecklist,
} from "@/features/boss-plans/server/boss-plan-repo";
import { fetchMyParties } from "@/features/dashboard/server/dashboard-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";

/**
 * `/boss-plans` — 캐릭터별 "매주 가는 보스" 편집 (DB-SCHEMA 난제 16).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 **비로그인 열람 대상이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 열람 범위가 `can_view_character_plans()` 로 **본인만**에 못박혀 있다(난제 16-6) —
 * 친구에게도, 같은 파티 구성원에게도 열지 않는다. 그래서 비로그인에게 보여 줄 내용이
 * 애초에 없다.
 *
 * 다만 **리다이렉트하지 않고 200 으로 안내 화면을 그린다.** 리다이렉트는 북마크와 공유
 * 링크를 중간 경유지로 만들고, 실패 지점을 라우팅 계층으로 흩어 놓는다. 홈(`/`)이
 * 세션에 따라 두 화면을 그리는 것과 같은 판단이다.
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려 있다.
 */

export const metadata: Metadata = {
  title: "매주 가는 보스",
  description:
    "캐릭터마다 매주 도는 보스를 난이도까지 지정해 관리하고, 이번 주 진행 상황과 주간 12개 상한을 확인합니다.",
};

export const dynamic = "force-dynamic";

export default async function BossPlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const now = new Date();
  const session = await readSession();

  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
          <CardDescription>
            보스 계획은 본인만 볼 수 있습니다. 친구에게도, 같은 파티 구성원에게도
            공개되지 않습니다. 홈에서 넥슨 API 키로 로그인해 주세요.
          </CardDescription>
          <Link
            href="/"
            className="text-body-sm text-primary underline-offset-2 hover:underline"
          >
            ← 홈으로
          </Link>
        </Card>
      </main>
    );
  }

  const params = await searchParams;
  const requested = params.characterId;
  const initialCharacterId =
    typeof requested === "string" && requested !== "" ? requested : null;

  const weekKey = getWeekKey(now);
  const range = { from: getWeekStart(now), to: getNextReset(now) };

  /*
   * ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1).
   *   예전에는 추적 캐릭터 명단과 내 파티를 props 로 내려보냈다. 그래서 캐릭터를 추가·해제
   *   하거나 파티를 만들어도 이 화면은 새로고침 전까지 낡은 목록을 보여 줬다.
   *
   *   심는 것은 넷이다:
   *   1) **체크리스트** — 캐릭터 명단이 여기서 갈라져 나온다(두 번째 명단을 만들지 않는다).
   *   2) **내 파티** — 일정 등록은 구성원만 가능하므로 공개 파티는 후보가 아니다.
   *      `schedule-repo.fetchParties()` 는 남의 공개 파티까지 주므로 쓰지 않는다.
   *   3) **선택된 캐릭터의 계획** — 이것을 빠뜨리면 화면의 본문이 스켈레톤으로 시작한다.
   *      선택 규칙(`?characterId=` → 없으면 명단 첫 행)을 워크스페이스와 **똑같이** 계산해야
   *      키가 맞는다.
   *
   * ⚠️ **넥슨 호출 0건.** 전부 우리 DB 다. 동기화(캐릭터당 1콜)는 사용자가 버튼을 누를
   *    때만 나간다(§1.1 — 개발 키 하루 1,000콜).
   *
   * ★ 주 범위(`range`)는 **데이터가 아니라 렌더 기준점**이라 props 로 남는다. 클라이언트에서
   *   `new Date()` 로 만들면 SSR 결과와 어긋나 하이드레이션이 깨진다.
   */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    /*
      ★ **보스 마스터는 더 이상 여기 없다.** 게임 패치 때만 바뀌는 값이라 코드 상수로
        내려갔다(`@/lib/boss-master`) — 화면이 직접 import 하므로 심을 것도, 실어
        보낼 것도 없다. 이 화면에서만 왕복 3회(카탈로그·별칭·줄임말)가 사라졌다.
    */
    /*
      ★ **`?characterId=` 가 있으면 계획 묶음이 체크리스트를 기다리지 않는다**
        (2026-08-18 성능 작업). 선택 규칙은 `?characterId=` → 없으면 명단 첫 행인데,
        앞쪽 경우에는 **명단이 답에 아무 영향을 주지 않는다.** 그런데도 예전에는
        체크리스트를 통째로 기다린 뒤 시작해 왕복 한 단계가 그대로 붙었다.
        보스 현황 화면의 캐릭터 카드에서 넘어오는 경로가 정확히 이 경우다.

        ⚠️ 선택 규칙 자체는 한 글자도 바뀌지 않았다 — 워크스페이스와 **똑같이** 계산해야
           키가 맞는다.
      */
    const [checklist, myParties, presetBundle] = await Promise.all([
      fetchWeeklyChecklist(session.uid),
      fetchMyParties(session.uid, weekKey),
      initialCharacterId === null
        ? Promise.resolve(null)
        : fetchCharacterPlanBundle(session.uid, initialCharacterId),
    ]);

    queryClient.setQueryData(queryKeys.db.bossPlans.checklist(), checklist);
    queryClient.setQueryData(queryKeys.db.party.mine(weekKey), myParties);

    const selectedId =
      initialCharacterId ?? checklist[0]?.character.characterId ?? null;
    if (selectedId !== null) {
      queryClient.setQueryData(
        queryKeys.db.bossPlans.character(selectedId),
        presetBundle ?? (await fetchCharacterPlanBundle(session.uid, selectedId)),
      );
    }
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {/*
              ★ 여기 있던 `추적 캐릭터 N명` 은 **워크스페이스 안으로 옮겼다.** 명단이
                이제 쿼리 소유라, 서버 렌더가 센 숫자를 헤더에 박아 두면 캐릭터를 추가·
                해제한 뒤 목록과 숫자가 서로 다른 말을 하게 된다 (§2.4 Rule 1).
            */}
            <p className="text-overline uppercase text-primary">
              캐릭터별 계획
            </p>
            <h1 className="font-headline text-subhead text-ink">
              매주 가는 보스
            </h1>
          </div>
          <WeekLabel date={now} />
        </div>
        {/*
          ⚠️ **일간 보스는 앱 범위 밖이다**(2026-08-18 발주자 지시, `@/lib/domain/boss-scope`).
             서버 쿼리에서 이미 빠지므로 이 화면에 "일간"이라는 말이 나올 자리가 없다 —
             주간 체크리스트가 같은 이유로 이미 그 낱말을 지웠다.
        */}
        <p className="max-w-3xl text-body-sm text-ink-muted">
          인게임 스케줄러에 등록한 보스를 그대로 불러옵니다. 여기서 켜고 끈 값은{" "}
          <strong className="font-semibold">
            다음 동기화가 덮어쓰지 않습니다
          </strong>
          . 주간 보스는 캐릭터당 12개까지만 입장할 수 있고, 월간 보스는 그 카운터
          밖입니다. 보스마다 <strong className="font-semibold">인원수</strong>를
          적어 두면 이후 기록되는 클리어의 결정석이 그 수로 나뉩니다.
        </p>
      </header>

      <HydrationBoundary state={dehydratedState}>
        <BossPlanWorkspace
          initialCharacterId={initialCharacterId}
          weekKey={weekKey}
          range={range}
        />
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
        <Link
          href="/"
          className="text-body-sm text-primary underline-offset-2 hover:underline"
        >
          ← 홈으로
        </Link>
      </footer>
    </main>
  );
}
