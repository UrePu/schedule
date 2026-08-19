import { HydrationBoundary } from "@tanstack/react-query";
import { CalendarRange, Coins, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Button, Card, CardDescription, CardTitle } from "@/components/ui";
import { HomeAuthSection, SessionGate } from "@/features/auth/components";
import { loadCurrentUser } from "@/features/auth/server/current-user";
import { readSignedInHint } from "@/features/auth/server/session";
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
 * ═════════════════════════════════════════════════════════════════════════════
 * 그런데 (C) 의 전제가 깨졌다 — 2026-08-18 관측
 * ═════════════════════════════════════════════════════════════════════════════
 * (C) 는 "서버가 세션을 정확히 판정한다"에 기대고 있었고, 그 전제가 실제로 깨졌다.
 *
 *   증상: **로그인 상태에서 `/` 를 열면 랜딩이 나온다.** 그런데 같은 화면 아래쪽의
 *         계정 패널은 **"로그인됨 · 더저"** 로 정상 표시된다. 로컬 dev(3000), 로컬
 *         프로덕션 빌드, Vercel 에서 모두 재현. `/boss-plans` 와 `/schedule` 은 멀쩡한데
 *         그 둘은 서버에서 로그인 분기를 하지 않고 클라이언트가 그린다.
 *   해석: **RSC 렌더 경로에서만 세션 쿠키 판정이 null 로 떨어지고, Route Handler
 *         (`GET /api/auth/me`) 경로에서는 정상이다.** 근본 원인 추적은 별건이다.
 *
 * 그래서 (C) 를 버리지 않고 **아래를 한 겹 깐다**: 서버가 사용자를 알면 지금까지처럼
 * 곧바로 대시보드다(빠른 경로 · 깜빡임 0). 서버가 모른다고 말하면 그 판정을 최종으로
 * 받아들이지 않고 `SessionGate` 에 넘겨 **클라이언트가 아는 세션이 이기게** 한다.
 * 게이트는 힌트 쿠키가 있으면 랜딩 대신 스켈레톤을 그리며 `/api/auth/me` 를 기다린다.
 *
 * ⚠️ 서버가 모르는 경로에서는 **대시보드 데이터를 prefetch 하지 못한다** — 누구 것을
 *    읽어야 할지 모르니 당연하다. 그때 `Dashboard` 는 자기 `useQuery` 로 직접 가져오고,
 *    캐시가 빌 때의 로딩·에러 분기를 이미 스스로 갖고 있다(`dashboard.tsx`).
 * ⚠️ **넥슨 호출은 어느 경로에서도 0건이다**(§1.1 — 캐릭터당 1콜, 개발 키 하루 1,000콜).
 *
 * ⚠️ **비로그인 200 은 여전히 구조로 보장된다** (DoD §0.3).
 *    `readSession()` 은 쿠키가 없으면 **던지지 않고 null 을 준다.** 세션이 null 이면
 *    이 아래로 DB 접근이 한 줄도 실행되지 않는다 — 게이트를 거쳐도 마찬가지다. 게이트가
 *    서버에서 하는 일은 힌트 쿠키를 읽는 것 하나뿐이고, 쿠키가 없는 방문자에게는
 *    랜딩이 **즉시** 그려진다(기다리지 않는다). 쿠키가 있어도 계정이 정지·삭제 상태면
 *    `/api/auth/me` 가 `{ user: null }` 을 주므로 결국 랜딩으로 떨어진다.
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
    title: "일정 짜기",
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

/** 필수 표기(§1.1). `main` 안에 **정확히 한 번**만 놓인다. */
function Attribution() {
  return (
    <footer className="flex flex-col gap-2 border-t border-border pt-6">
      <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
    </footer>
  );
}

/**
 * 비로그인 화면.
 *
 * ★ `main` 도 `Attribution` 도 **여기에 없다.** 예전에는 랜딩과 대시보드가 각각 자기
 *   `main`/`Attribution` 을 들고 있었는데, 이제 두 화면이 게이트를 통해 같은 자리에
 *   꽂히므로 껍데기가 중복되면 표기가 두 번 나온다(§1.1 은 표기를 요구하지, 두 번을
 *   요구하지 않는다). 껍데기는 `HomePage` 한 곳이 소유한다.
 */
function Landing({ now }: { readonly now: Date }) {
  return (
    <>
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
            <Button size="lg">일정 짜러 가기 →</Button>
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

        ★ 재적재된 서버 렌더에서 세션 판정이 또 실패하더라도, 이제는 게이트가 받아
          대시보드를 그린다. 이 흐름이 막다른 길이 되지 않는 이유다.
      */}
      <HomeAuthSection />
    </>
  );
}

export default async function HomePage() {
  const now = new Date();
  // 순수 계산이다 — DB 도 넥슨도 타지 않으므로 비로그인 경로에서도 안전하다.
  const weekKey = getWeekKey(now);

  /*
    ★ 계정 조회는 **요청당 한 번**이다. 루트 레이아웃이 이미 같은 함수를 불렀고
      `loadCurrentUser` 는 React `cache()` 로 감싸 있어 두 번째 호출은 왕복이 없다
      (`features/auth/server/current-user.ts`). null 이면 아래 DB 호출이 한 줄도
      실행되지 않는다 — 비로그인 200 보장은 그대로다.
  */
  const user = await loadCurrentUser();

  if (user !== null) {
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
      queryClient.setQueryData(queryKeys.db.dashboard.summary(weekKey), data);
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

  /*
    여기까지 왔다는 것은 서버가 "이 요청은 비로그인"이라고 판정했다는 뜻이다. 예전에는
    그것으로 끝이었고 랜딩을 그렸다 — 그런데 그 판정이 **로그인한 사람에게도 내려진다**는
    것이 위 주석의 관측이다. 그래서 판정을 게이트에 넘긴다.

    ⚠️ 힌트 쿠키는 **인증이 아니다.** 위조해도 얻는 것은 "랜딩 대신 스켈레톤을 잠깐
       본다"뿐이고, 실제 데이터는 세션 쿠키를 검증하는 API 만 준다. 서버가 이 쿠키를
       근거로 권한을 주는 곳은 한 곳도 없다.
    ⚠️ 쿠키가 아예 없는 방문자는 `serverHint === false` 라 **서버 HTML 이 곧 랜딩**이다 —
       비로그인 첫 페인트에 스켈레톤이 끼어들지 않는다.
  */
  const signedInHint = await readSignedInHint();

  return (
    <main className={PAGE_SHELL_CLASS}>
      <SessionGate serverHint={signedInHint} fallback={<Landing now={now} />}>
        <Dashboard weekKey={weekKey} now={now} />
      </SessionGate>
      <Attribution />
    </main>
  );
}
