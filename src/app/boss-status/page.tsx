import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { readSession } from "@/features/auth/server/session";
import { WeeklyChecklist } from "@/features/boss-plans/components";
import { WeeklyTotalsPanel } from "@/features/income/components";
import { fetchWeeklyIncomeDetail } from "@/features/income/server/income-repo";
import { fetchWeeklyChecklist } from "@/features/boss-plans/server/boss-plan-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { getWeekKey } from "@/lib/time/week";
import { queryKeys } from "@/lib/query-keys";

/**
 * `/boss-status` — 현황 › **계정 보스 현황**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드에서 **이사 온** 화면이다 (2026-08-20)
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시로 대시보드가 해체되면서, 그 안에 세 번째 구획으로 눌려 있던 주간
 * 체크리스트가 자기 경로를 얻었다. 컴포넌트(`WeeklyChecklist`)는 **한 줄도 바뀌지
 * 않았다** — 자기 쿼리와 자기 동기화 버튼을 이미 스스로 갖고 있었기 때문이다
 * (§2.4 Rule 1 을 지키고 있던 덕에 이사가 공짜였다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `/boss-plans` 와 무엇이 다른가 — **보는 곳 / 고치는 곳**
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기는 "이번 주에 어디까지 했나"를 읽는 화면이고, `/boss-plans` 는 "매주 어디를
 * 갈 건가"를 고치는 화면이다. 그래서 하나는 **현황**, 하나는 **관리** 무리에 있다
 * (`nav-routes.ts` 머리말의 가르는 축).
 *
 * ⚠️ 여기 `보스 N/12` 는 **캐릭터 하나**를 그리므로 그대로 옳다. 합산 분모가 필요한
 *    자리는 `tracked × 12` 를 쓴다(§1.1.1 — 화면에 `40 / 12건` 이 나갔던 사고).
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려 있다.
 */

export const metadata: Metadata = {
  title: "이번 주 현황",
  description:
    "추적 중인 캐릭터마다 이번 주 보스 진행 상황과 주간 12개 상한을 확인합니다.",
};

export const dynamic = "force-dynamic";

export default async function BossStatusPage() {
  const now = new Date();
  const session = await readSession();

  /*
    비로그인은 **리다이렉트하지 않고 200 으로 안내를 그린다.** 리다이렉트는 북마크와
    공유 링크를 중간 경유지로 만들고, 실패 지점을 라우팅 계층으로 흩어 놓는다
    (`/boss-plans` 와 같은 판단). 세션이 null 이면 아래로 DB 접근이 한 줄도 없다.
  */
  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
          <CardDescription>
            보스 현황은 본인 계정의 캐릭터만 볼 수 있습니다. 홈에서 넥슨 API 키로
            로그인해 주세요.
          </CardDescription>
          <Link
            href="/"
            className="text-body-sm text-primary underline-offset-2 hover:underline"
          >
            ← 이번 주 일정으로
          </Link>
        </Card>
      </main>
    );
  }

  /*
    ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1). 동기화 버튼이 체크리스트 안에
      있고 그 결과로 갱신돼야 하는 것도 이 목록이라, 소유를 나누면 무효화 대상이 둘로
      갈라진다.
    ⚠️ **넥슨 호출 0건.** 우리 DB 의 마지막 동기화 결과를 읽을 뿐이다. 실제 동기화
       (캐릭터당 1콜)는 사용자가 버튼을 누를 때만 나간다(§1.1 — 개발 키 하루 1,000콜).
  */
  const weekKey = getWeekKey(now);

  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    /*
      두 조회를 **나란히** 올린다. 서로를 기다릴 이유가 없고, 직렬로 두면 첫 화면이
      느린 쪽만큼 늦어진다.
      ★ 수익 상세는 `/income` 과 **같은 키**로 심는다(§2.4 Rule 5 — 키 팩토리가 소유).
        두 화면이 같은 주를 보면 조회도 한 번이고, 한쪽 무효화가 다른 쪽에 닿는다.
    */
    const [checklist, detail] = await Promise.all([
      fetchWeeklyChecklist(session.uid),
      fetchWeeklyIncomeDetail(session.uid, weekKey),
    ]);
    queryClient.setQueryData(queryKeys.db.bossPlans.checklist(), checklist);
    queryClient.setQueryData(queryKeys.db.income.detail(weekKey), detail);
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-overline uppercase text-primary">현황</p>
            <h1 className="font-headline text-subhead text-ink">
              이번 주 현황
            </h1>
          </div>
          <WeekLabel date={now} />
        </div>
        {/*
          ── 설명을 한 줄로 줄였다 (2026-08-27 발주자: *"UI 가 너무 안좋아"*) ──────
          예전에는 12개 상한 규칙을 세 줄로 풀어 썼는데, 그 규칙은 **매번 읽히지 않는다.**
          아래 카드가 캐릭터마다 `N/12` 를 직접 보여 주므로 규칙은 화면이 이미 말하고
          있고, 문단은 그 위에서 자리만 먹었다. 갈 곳(계획 편집)만 남긴다.
        */}
        <p className="text-body-sm text-ink-muted">
          매주 갈 보스는{" "}
          <Link
            href="/boss-plans"
            className="text-primary underline-offset-2 hover:underline"
          >
            캐릭별 보스 관리
          </Link>
          에서, 지난 기록은{" "}
          <Link
            href="/income"
            className="text-primary underline-offset-2 hover:underline"
          >
            기간별 수익
          </Link>
          에서 봅니다.
        </p>
      </header>

      <HydrationBoundary state={dehydratedState}>
        {/*
          ── 맨 위 = 수익 3칸, 그 아래 = 캐릭터별 진행 ────────────────────────
          발주 지시(2026-08-27): *"맨위에 3개 들어간 폼 하나"* + *"계정 보스 현황에서
          보스 진행 내역과 각 캐릭터 별로 얼마씩 남았는지"*.

          두 덩어리가 한 화면에 있어야 하는 이유는 **하나의 질문에 함께 답하기 때문**이다 —
          "이번 주 얼마 벌었고 얼마가 남았나". 예전에는 번 돈은 `/income`, 남은 것은
          `/boss-status` 라 두 화면을 오가며 머릿속에서 더해야 했다.
        */}
        <WeeklyTotalsPanel weekKey={weekKey} />
        <WeeklyChecklist />
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
      </footer>
    </main>
  );
}
