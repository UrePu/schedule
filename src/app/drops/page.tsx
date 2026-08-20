import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { readSession } from "@/features/auth/server/session";
import { DropRecordForm } from "@/features/income/components";
import { fetchWeeklyIncomeDetail } from "@/features/income/server/income-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getWeekKey } from "@/lib/time/week";

/**
 * `/drops` — 기타 › **드랍 기록**
 *
 * 발주자(2026-08-20): *"드랍 기능도 기타로 넣어줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 상단 바 버튼은 그대로 둔다
 * ─────────────────────────────────────────────────────────────────────────────
 * *"…도"* 라는 지시대로 **더한 것**이지 옮긴 것이 아니다. 둘은 쓰임이 다르다.
 *   · 상단 바 버튼 — 보스를 돌고 나온 **직후**, 지금 보고 있는 화면이 무엇이든 바로.
 *   · 이 페이지   — 나중에 앉아서 적을 때. 내비게이션으로 찾아올 수 있는 자리가 필요하다.
 * 버튼은 좁은 화면에서 가장 먼저 접히는 자리이기도 해서, 그 하나뿐이면 "드랍을 어디서
 * 적더라" 가 된다.
 *
 * ★ **폼은 한 벌이다**(`DropRecordForm`). 다이얼로그와 이 페이지가 같은 컴포넌트를
 *   그린다 — 금액을 다루는 화면을 복사하면 한쪽만 고쳐지는 날이 반드시 온다.
 *
 * `force-dynamic` 이 필수다: "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려 있다.
 */

export const metadata: Metadata = {
  title: "드랍 기록",
  description:
    "보스 드랍의 판매액과 인원을 넣으면 각자 올릴 금액을 계산하고 그 판의 수익으로 기록합니다.",
};

export const dynamic = "force-dynamic";

export default async function DropsPage() {
  const session = await readSession();

  /*
    비로그인은 **리다이렉트하지 않고 200 으로 안내를 그린다**(`/etc` 와 같은 판단).
    세션이 null 이면 아래로 DB 접근이 한 줄도 실행되지 않는다.
  */
  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
          <CardDescription>
            드랍은 내 원장에 남는 기록이라 본인만 적을 수 있습니다. 홈에서 넥슨
            API 키로 로그인해 주세요.
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

  const weekKey = getWeekKey(new Date());

  /*
    ★ **이번 주 일정을 미리 담아 둔다** (§2.4 Rule 1 — 담는 곳은 캐시다). 폼이 여는 즉시
      "어느 판" 목록이 필요한데, 클라이언트에서 받아 오면 페이지를 연 직후 잠깐 빈 칸이
      보인다. 수익 화면과 **같은 키**라 그 화면을 거쳐 왔다면 이미 채워져 있다.
    ⚠️ **넥슨 호출 0건.** 우리 DB 읽기 하나뿐이다.
  */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(
      queryKeys.db.income.detail(weekKey),
      await fetchWeeklyIncomeDetail(session.uid, weekKey),
    );
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-1">
        <p className="text-overline uppercase text-primary">기타</p>
        <h1 className="font-headline text-subhead text-ink">드랍 기록</h1>
        <p className="text-body-sm text-ink-muted">
          카카오톡의 <code className="font-mono text-code">!드랍</code> 과 같은
          계산입니다. 판매액과 인원을 넣으면 각자 얼마를 올려야 모두 같은 금액을
          갖는지 계산하고, 그 판의 수익으로 기록합니다.
        </p>
      </header>

      <HydrationBoundary state={dehydratedState}>
        <Card className="flex flex-col gap-3">
          <DropRecordForm weekKey={weekKey} />
        </Card>
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          기록한 드랍은{" "}
          <Link
            href="/income"
            className="text-primary underline-offset-2 hover:underline"
          >
            결정석 수익
          </Link>{" "}
          화면의 주차별 내역에서 확인하고 고칠 수 있습니다.
        </p>
      </footer>
    </main>
  );
}
