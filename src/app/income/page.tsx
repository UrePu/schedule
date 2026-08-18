import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { loadCurrentUser } from "@/features/auth/server/current-user";
import { readSession } from "@/features/auth/server/session";
import { IncomeWorkspace } from "@/features/income/components";
import { fetchWeeklyIncomeDetail } from "@/features/income/server/income-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getWeekKey } from "@/lib/time/week";

/**
 * `/income` — 이번 주 수익 상세 (§1.2 2순위).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 **비로그인 열람 대상이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 공개 시간표가 공개하는 것은 "언제 무슨 보스를 간다"까지이고(§2.1), 개인의 **수익
 * 금액**은 거기에 들어가지 않는다. `boss_clears` 와 수익 뷰는 anon 에게 GRANT 자체가
 * 없고(`%meso%` · `%share%` 패턴은 `assert_no_public_sensitive_columns()` 가 감시한다),
 * 이 페이지도 같은 경계를 지킨다.
 *
 * 다만 **리다이렉트하지 않고 200 으로 안내 화면을 그린다.** `/boss-plans` 와 같은
 * 판단이다 — 리다이렉트는 북마크와 공유 링크를 중간 경유지로 만들고, 실패 지점을
 * 라우팅 계층으로 흩어 놓는다.
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려
 * 있다. 프리렌더되면 둘 다 얼어붙는다.
 */

export const metadata: Metadata = {
  title: "이번 주 수익",
  description:
    "이번 주 결정석·드랍 수익을 캐릭터별로 확인하고, 입장 인원을 고쳐 실수령액을 바로잡습니다. 등록한 일정은 여기서 클리어로 체크합니다.",
};

export const dynamic = "force-dynamic";

export default async function IncomePage() {
  const now = new Date();
  const session = await readSession();

  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
          <CardDescription>
            수익 금액은 본인만 볼 수 있습니다. 공개 시간표에는 일정만 나가고 메소는
            나가지 않습니다. 홈에서 넥슨 API 키로 로그인해 주세요.
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

  /*
    ★ 루트 레이아웃이 이미 부른 값이다. `loadCurrentUser` 가 React `cache()` 로
      요청 범위 메모이제이션을 하므로 여기서는 왕복이 없다.
  */
  const user = await loadCurrentUser();
  if (user === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">계정을 사용할 수 없습니다</CardTitle>
          <CardDescription>
            정지되었거나 삭제된 계정입니다. 홈에서 다시 로그인해 주세요.
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

  const weekKey = getWeekKey(now);

  /*
   * ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1). 예전에는 이 원장을 `initial` props
   *   로 내려보냈고, 워크스페이스가 `initialData` 로 받았다 — `initialDataUpdatedAt` 이
   *   없어 그 값이 영영 신선한 것으로 취급되는 자리였다. 이제 요청 범위 QueryClient 에
   *   심어 `dehydrate` 하면 `dataUpdatedAt` 까지 함께 넘어간다.
   *
   * ⚠️ **넥슨 호출 0건.** 결정석 가격도 수익도 넥슨 API 에 존재하지 않는다(§1.1).
   */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(
      queryKeys.db.income.detail(weekKey),
      await fetchWeeklyIncomeDetail(user.id, weekKey),
    );
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-overline uppercase text-primary">
              {user.mainCharacterName ?? user.displayName}
            </p>
            <h1 className="font-headline text-subhead text-ink">
              이번 주 수익
            </h1>
          </div>
          {/* 주간 초기화 시점은 어느 화면에서든 항상 보인다 (§1.4). */}
          <WeekLabel date={now} />
        </div>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          결정석 표시가는 솔로 기준이고 실수령액은 입장 인원으로 나눈 값입니다. 어느
          캐릭터로 돌았는지와 실제 입장 인원은 &lsquo;클리어 수정&rsquo;에서 고칠 수
          있습니다 — 인원이 틀리면 그 한 건의 수익이 최대 6배까지 부풀려집니다. 주간
          결정석 12개 상한은 캐릭터당이고, 월간 결정석은 그 카운터에 들어가지 않습니다.
          일간 보스는 추적하지 않으므로 이 화면의 건수·금액에 포함되지 않습니다.
        </p>
      </header>

      <HydrationBoundary state={dehydratedState}>
        <IncomeWorkspace weekKey={weekKey} />
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
        <div className="flex flex-wrap gap-4">
          <Link
            href="/"
            className="text-body-sm text-primary underline-offset-2 hover:underline"
          >
            ← 홈으로
          </Link>
          <Link
            href="/schedule"
            className="text-body-sm text-primary underline-offset-2 hover:underline"
          >
            일정 화면 →
          </Link>
        </div>
      </footer>
    </main>
  );
}
