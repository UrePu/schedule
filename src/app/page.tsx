import { HydrationBoundary } from "@tanstack/react-query";
import { CalendarRange, Coins, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Button, Card, CardDescription, CardTitle } from "@/components/ui";
import { HomeAuthSection } from "@/features/auth/components";
import { loadCurrentUser } from "@/features/auth/server/current-user";
import { Dashboard } from "@/features/dashboard/components";
import { fetchDashboardData } from "@/features/dashboard/server/dashboard-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getWeekKey } from "@/lib/time/week";

/**
 * 앱 진입점 (`/`).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 왜 새 경로가 아니라 `/` 가 갈라지는가
 * ═════════════════════════════════════════════════════════════════════════════
 * 후보는 셋이었다.
 *
 * (A) `/dashboard` 를 새로 만들고 `/` 에서 리다이렉트
 *     → 로그인한 사람은 `/` 를 열 때마다 **한 번 튕긴다.** 북마크·공유 링크가 전부
 *       중간 경유지가 되고, 리다이렉트 판정을 미들웨어에 두면 비로그인 200 보장이
 *       라우팅 계층으로 흩어진다.
 * (B) `/` 는 그대로 두고 클라이언트에서 대시보드로 갈아끼우기
 *     → 첫 페인트가 항상 랜딩이라 **로그인한 사람이 매번 랜딩을 한 번 본다.**
 *       세션 조회가 끝난 뒤에야 바뀌므로 화면이 눈에 띄게 튄다.
 * (C) **`/` 가 서버에서 세션을 보고 두 화면 중 하나를 그린다** ← 채택
 *     → URL 이 하나로 유지되고, 튐도 리다이렉트도 없다.
 *
 * ⚠️ **비로그인 200 은 여전히 구조로 보장된다** (DoD §0.3).
 *    `readSession()` 은 쿠키가 없으면 **던지지 않고 null 을 준다.** 세션이 null 이면
 *    이 아래로 DB 접근이 한 줄도 실행되지 않고 곧장 랜딩을 반환한다. 즉 비로그인 경로의
 *    실패 지점은 예전과 똑같이 0개다. 쿠키가 있어도 계정이 정지·삭제 상태면
 *    (`loadSessionUser` 가 null) **랜딩으로 떨어진다** — 대시보드를 반쯤 그리다 500 이
 *    나는 것보다 낫다.
 *
 * `force-dynamic` 이 필수다: 화면 자체가 "누가 보고 있는가"에 달려 있고, 주차 계산도
 * `new Date()` 에 달려 있다. 프리렌더되면 두 가지가 함께 얼어붙는다.
 */

export const metadata: Metadata = {
  title: "M_Schedule — 메이플스토리 보스 파티 스케줄러",
  description:
    "파티원의 가능 시간을 하나의 시간표로 겹쳐 보고, 겹치는 시간대에 보스 일정을 잡습니다. 결정석 수익은 자동으로 합산됩니다.",
};

export const dynamic = "force-dynamic";

const FEATURES: ReadonlyArray<{
  readonly icon: typeof Users;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Users,
    title: "가능 시간 겹쳐보기",
    body: "요일별 반복 패턴으로 한 번만 등록하면 됩니다. 야근·출장은 그 날짜에서 빼는 특이사항으로 처리하고, 사유는 적지 않아도 됩니다.",
  },
  {
    icon: CalendarRange,
    title: "겹치는 시간에 바로 등록",
    body: "6인이 다 모이지 않아도 됩니다. ‘4명 이상’ 처럼 최소 인원을 낮춰 실제로 갈 수 있는 시간대를 찾습니다.",
  },
  {
    icon: Coins,
    title: "결정석 수익 자동 합산",
    body: "표시가는 솔로 기준이라 실제 수령액은 입장 인원으로 나눕니다. 가격이 확인되지 않은 보스는 0이 아니라 ‘미확인’으로 따로 셉니다.",
  },
];

/** 필수 표기(§1.1). 두 화면 모두에 들어간다. */
function Attribution() {
  return (
    <footer className="flex flex-col gap-2 border-t border-border pt-6">
      <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
    </footer>
  );
}

export default async function HomePage() {
  const now = new Date();

  /*
    ★ 계정 조회는 **요청당 한 번**이다. 루트 레이아웃이 이미 같은 함수를 불렀고
      `loadCurrentUser` 는 React `cache()` 로 감싸 있어 두 번째 호출은 왕복이 없다
      (`features/auth/server/current-user.ts`). null 이면 아래 DB 호출이 한 줄도
      실행되지 않는다 — 비로그인 200 보장은 그대로다.
  */
  const user = await loadCurrentUser();

  {
    if (user !== null) {
      const weekKey = getWeekKey(now);

      /*
       * ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1).
       *   서버가 DB 를 읽는 것은 그대로다 — 바뀐 것은 결과를 props 가 아니라 요청 범위
       *   QueryClient 에 심는다는 점이다. 그래야 클리어 체크·계획 끄기 같은 뮤테이션이
       *   `invalidateQueries` 만으로 이 숫자들을 움직인다.
       *
       *   `fetchDashboardData()` 한 번으로 **두 키를 함께** 채운다. 체크리스트는 그 결과에
       *   이미 들어 있으므로 다시 읽을 이유가 없고, 그러면서도 체크리스트 쿼리는 독립적으로
       *   무효화·재조회될 수 있다(동기화 버튼이 그 하나만 갱신한다).
       *
       *   ⚠️ **넥슨 호출 0건.** prefetch 대상은 우리 DB 읽기뿐이다(§1.1 — 캐릭터당 1콜을
       *      페이지 진입마다 태우면 개발 키 하루 1,000콜이 순식간에 녹는다).
       */
      const dehydratedState = await dehydrateQueries(async (queryClient) => {
        const data = await fetchDashboardData(user.id, weekKey);
        queryClient.setQueryData(
          queryKeys.db.dashboard.summary(weekKey),
          data,
        );
        queryClient.setQueryData(
          queryKeys.db.bossPlans.checklist(),
          data.checklist,
        );
        /*
          ★ 세션 키는 **루트 레이아웃이 심는다** (`app/layout.tsx`). 여기서 다시 심으면
            같은 값을 두 번 직렬화해 보내게 된다 — 표시 정체성(본캐 닉네임)의 주인은
            여전히 캐시 하나다.
        */
      });

      return (
        <main className={PAGE_SHELL_CLASS}>
          <HydrationBoundary state={dehydratedState}>
            <Dashboard weekKey={weekKey} now={now} />
          </HydrationBoundary>
          <Attribution />
        </main>
      );
    }
    // 계정이 없거나 정지·삭제 상태 → 아래 랜딩으로 떨어진다. 로그인 폼이 다시 보이고,
    // 다시 로그인하면 서버가 상태를 판정해 알맞은 문구를 준다.
  }

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-4">
        <p className="text-overline uppercase text-primary">M_Schedule</p>
        <h1 className="font-headline text-headline text-ink">
          파티원 시간이 겹치는 지점을
          <br />한 화면에서 찾습니다
        </h1>
        <p className="max-w-2xl text-body-lg text-ink-muted">
          메이플스토리 보스 파티 스케줄러입니다. 인게임 스케줄러는 체크리스트라
          &lsquo;몇 시에 되는지&rsquo;가 없습니다. 그 시간표를 여기서 만듭니다.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Link href="/schedule">
            <Button size="lg">가능 시간 겹쳐보기 →</Button>
          </Link>
          {/* 주간 초기화 시점은 어느 화면에서든 항상 보인다 (§1.4). */}
          <WeekLabel date={now} />
        </div>
      </header>

      <section aria-label="주요 기능" className="grid gap-3 sm:grid-cols-3">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <Card key={feature.title} className="flex flex-col gap-2">
              <Icon aria-hidden size={20} className="text-primary" />
              <CardTitle className="text-body-lg">{feature.title}</CardTitle>
              <CardDescription>{feature.body}</CardDescription>
            </Card>
          );
        })}
      </section>

      {/*
        로그인 구획은 **클라이언트 컴포넌트**다. 로그인에 성공하면 스스로
        `window.location.replace("/")` 로 문서를 다시 적재하고, 그 서버 렌더에서
        위쪽 대시보드 분기가 선택된다. (예전에는 `router.refresh()` + 1.5초 감시
        타이머였는데, 트랜지션이 커밋되기 전까지 랜딩이 그대로 남는 경우가 있어
        확정적인 재적재로 바꿨다 — 근거는 `home-auth-section.tsx` 주석.)
      */}
      <HomeAuthSection />

      <Attribution />
    </main>
  );
}
