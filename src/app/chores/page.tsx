import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { readSession } from "@/features/auth/server/session";
import { fetchChoreBoard } from "@/features/bot/server/bot-repo";
import { ChoreBoard } from "@/features/chores/components";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * `/chores` — 현황 › **기타 숙제**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 지금까지 **웹에 없던** 화면이다
 * ═════════════════════════════════════════════════════════════════════════════
 * 숙제는 카톡 `!숙제` 로만 볼 수 있었다. 발주 지시(2026-08-20)의 새 구조가 현황 무리
 * 셋째 자리에 이 화면을 지정하면서 웹 판을 만들었다.
 *
 * "기타"인 이유는 §1.2 의 가치 순서 그대로다 — 보스 일정(1)과 결정석 수익(2)이 이 앱의
 * 본체이고 주간 숙제는 **5순위**다. 이름이 그 사실을 숨기지 않는 편이 낫다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기서 **동기화하지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 숙제 판은 넥슨 스케줄러 스냅샷에서 나오는데, 그 스냅샷을 새로 받는 일(캐릭터당 1콜)은
 * 보스 현황 화면의 동기화 버튼이 이미 한다. 두 화면이 각자 동기화하면 같은 데이터를
 * 두 번 받으면서 개발 키 하루 1,000콜을 두 배로 태운다(§1.1). 그래서 이 화면은
 * **읽기와 수동 체크만** 한다.
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려 있다.
 */

export const metadata: Metadata = {
  title: "기타 숙제",
  description:
    "추적 중인 캐릭터의 일퀘 · 몬스터파크 · 지하수로 · 에픽던전 진행 상황을 확인하고 직접 체크합니다.",
};

export const dynamic = "force-dynamic";

export default async function ChoresPage() {
  const now = new Date();
  const session = await readSession();

  /*
    비로그인은 **리다이렉트하지 않고 200 으로 안내를 그린다** (`/boss-plans` 와 같은
    판단). 세션이 null 이면 아래로 DB 접근이 한 줄도 실행되지 않는다.
  */
  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
          <CardDescription>
            숙제는 본인 계정의 캐릭터만 볼 수 있습니다. 홈에서 넥슨 API 키로
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
    ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1). 체크 뮤테이션이 응답으로 받은
      판을 같은 키에 얹으므로, 서버가 심은 값과 클라이언트가 갱신하는 값의 주인이 하나다.
    ⚠️ **넥슨 호출 0건** (위 머리말).
  */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(
      queryKeys.db.chores.board(),
      await fetchChoreBoard(getAdminDb(), session.uid, now),
    );
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-overline uppercase text-primary">현황</p>
            <h1 className="font-headline text-subhead text-ink">기타 숙제</h1>
          </div>
          <WeekLabel date={now} />
        </div>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          인게임 스케줄러에 <strong className="font-semibold">등록한 항목만</strong>{" "}
          나옵니다 — 목록에 없으면 안 한 것이 아니라 할 일이 아닙니다. 주간 항목은
          직접 체크할 수 있고, 그 체크는{" "}
          <strong className="font-semibold">넥슨 판정보다 우선</strong>합니다(넥슨
          데이터는 약 15분 늦습니다). 진행 상황을 최신으로 당기려면{" "}
          <Link
            href="/boss-status"
            className="text-primary underline-offset-2 hover:underline"
          >
            계정 보스 현황
          </Link>
          에서 동기화하세요.
        </p>
      </header>

      <HydrationBoundary state={dehydratedState}>
        <ChoreBoard />
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
      </footer>
    </main>
  );
}
