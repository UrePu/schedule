import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { SessionGate, SessionIdentityText } from "@/features/auth/components";
import { loadCurrentUser } from "@/features/auth/server/current-user";
import {
  readSession,
  readSignedInHint,
} from "@/features/auth/server/session";
import { IncomeWorkspace } from "@/features/income/components";
import {
  LEDGER_PAGE_WEEKS,
  calendarLedgerRange,
  kstMonthKey,
  listLedgerRange,
} from "@/features/income/lib/week-range";
import {
  fetchIncomeLedger,
  fetchWeeklyIncomeDetail,
} from "@/features/income/server/income-repo";
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
 * ═════════════════════════════════════════════════════════════════════════════
 * `/` 와 **똑같은 결함이 여기에도 있었다** — 2026-08-18 [동일 적용]
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인 상태인데 `/` 가 랜딩을 그리는 증상의 원인은 **RSC 렌더 경로에서만 세션 쿠키
 * 판정이 null 로 떨어지는 것**이었다(Route Handler 경로는 정상 — 자세한 관측은
 * `app/page.tsx` 주석). 서버에서 로그인 분기를 하는 화면은 저장소에 `/` 와 `/income`
 * 둘뿐이었고, 그래서 이 화면도 로그인 상태에서 "로그인이 필요합니다"를 띄우고 있었다.
 * (`/boss-plans` · `/schedule` 은 서버 분기가 없어 영향이 없다.)
 *
 * 고친 방법도 같다: 서버가 세션을 알면 지금까지처럼 곧바로 원장을 그리고(빠른 경로),
 * 모른다고 하면 그 판정을 최종으로 받아들이지 않고 `SessionGate` 에 넘겨 **클라이언트가
 * 아는 세션이 이기게** 한다. 게이트 뒤에서는 서버가 prefetch 를 못 하므로
 * `IncomeWorkspace` 가 자기 `useQuery` 로 직접 가져온다 — 그 컴포넌트는 캐시가 빌 때의
 * 로딩·에러 분기를 이미 갖고 있다.
 *
 * ⚠️ **금액이 새어 나가지 않는다는 성질은 그대로다.** 서버는 세션이 없으면 원장을 한 줄도
 *    읽지 않고, 게이트가 그리는 `IncomeWorkspace` 는 `GET /api/income` 을 타는데 그
 *    라우트는 여전히 서명 세션 쿠키를 검증한다. 힌트 쿠키는 **인증이 아니다** — 위조하면
 *    스켈레톤을 잠깐 보고 곧바로 안내 화면으로 떨어진다.
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려
 * 있다. 프리렌더되면 둘 다 얼어붙는다.
 */

export const metadata: Metadata = {
  title: "이번 주 수익",
  description:
    "달력과 주차별 내역으로 언제 무슨 보스를 돌았고 얼마를 벌었는지 확인합니다. 입장 인원과 캐릭터는 날짜·주차 상세에서 바로 고칠 수 있고, 등록한 일정은 여기서 클리어로 체크합니다.",
};

export const dynamic = "force-dynamic";

/**
 * 원장 화면의 머리말.
 *
 * ★ 표시 정체성을 **props 가 아니라 캐시**에서 읽는다(§2.4 Rule 1 · `SessionIdentityText`).
 *   예전에는 `user.mainCharacterName` 을 서버에서 내려보냈는데, props 는
 *   `invalidateQueries()` 가 닿지 않는 자리라 부계정 키를 추가해 본캐가 바뀌어도 이
 *   제목만 낡은 채 남았다. 게이트 뒤에서는 애초에 서버가 사용자를 모르기도 한다.
 */
function IncomeHeader({ now }: { readonly now: Date }) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-overline uppercase text-primary">
            <SessionIdentityText fallback="내 수익" />
          </p>
          <h1 className="font-headline text-subhead text-ink">이번 주 수익</h1>
        </div>
        {/* 주간 초기화 시점은 어느 화면에서든 항상 보인다 (§1.4). */}
        <WeekLabel date={now} />
      </div>
      <p className="max-w-3xl text-body-sm text-ink-muted">
        결정석 표시가는 솔로 기준이고 실수령액은 입장 인원으로 나눈 값입니다. 어느
        캐릭터로 돌았는지와 실제 입장 인원은 <strong className="font-semibold text-ink">달력의 날짜</strong>{" "}
        또는 <strong className="font-semibold text-ink">주차별 내역의 &lsquo;수정&rsquo;</strong>
        에서 고칠 수 있습니다 — 인원이 틀리면 그 한 건의 수익이 최대 6배까지
        부풀려집니다. 주간 결정석 12개 상한은 캐릭터당이고, 월간 결정석은 그 카운터에
        들어가지 않아 건수와 금액을 따로 셉니다. 일간 보스는 추적하지 않으므로 이 화면의
        건수·금액에 포함되지 않습니다.
      </p>
    </header>
  );
}

/**
 * 필수 표기(§1.1) + 이동 링크. **게이트 밖**에 둔다 — 로그인·비로그인 어느 쪽이 그려져도
 * 표기가 정확히 한 번 나와야 하고, 안내 화면에도 "홈으로" 가 필요하기 때문이다.
 * (그래서 아래 안내 카드들은 자기 링크를 따로 갖지 않는다 — 두 번 나오면 그게 더 나쁘다.)
 */
function IncomeFooter() {
  return (
    <footer className="flex flex-col gap-2 border-t border-border pt-6">
      <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
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
  );
}

/** 확정 비로그인. 게이트가 "다시 물어도 비로그인"이라고 판정했을 때만 보인다. */
function SignInNotice() {
  return (
    <Card className="flex flex-col gap-2">
      <CardTitle className="text-body-lg">로그인이 필요합니다</CardTitle>
      <CardDescription>
        수익 금액은 본인만 볼 수 있습니다. 공개 시간표에는 일정만 나가고 메소는 나가지
        않습니다. 홈에서 넥슨 API 키로 로그인해 주세요.
      </CardDescription>
    </Card>
  );
}

export default async function IncomePage() {
  const now = new Date();
  const weekKey = getWeekKey(now);
  const session = await readSession();

  if (session === null) {
    /*
      서버가 "비로그인"이라고 말했다. 예전에는 여기서 끝이었지만, 그 판정이 로그인한
      사람에게도 내려진다는 것이 위 주석의 관측이다 → 게이트에 넘긴다.
      쿠키가 아예 없는 방문자는 `serverHint === false` 라 **서버 HTML 이 곧 안내 화면**
      이고 DB 는 한 줄도 읽지 않는다(비로그인 200 보장, DoD §0.3).
    */
    const signedInHint = await readSignedInHint();

    return (
      <main className={PAGE_SHELL_CLASS}>
        <SessionGate serverHint={signedInHint} fallback={<SignInNotice />}>
          <IncomeHeader now={now} />
          <IncomeWorkspace weekKey={weekKey} nowIso={now.toISOString()} />
        </SessionGate>
        <IncomeFooter />
      </main>
    );
  }

  /*
   * ★ **원장 조회가 계정 조회를 기다리지 않는다** (2026-08-18 성능 작업).
   *   `loadCurrentUser()` 가 돌려주는 `user.id` 는 곧 `session.uid` 다 — 조회에 필요한
   *   값이 이미 쿠키에 있는데도 예전에는 계정 행을 받은 **뒤에야** 원장 조회가 출발했다.
   *   계정 조회는 여전히 필요하다(정지·삭제 판정이 화면 전체를 가른다). 다만 그것은
   *   **관문**이지 입력이 아니므로 나란히 굴린다.
   *
   *   ⚠️ 정지·삭제 계정이면 아래에서 안내 화면을 그리고 이 결과는 **버린다.** 금액이
   *      한 바이트도 밖으로 나가지 않는다는 성질은 그대로다.
   *   ⚠️ 미리 `catch` 를 달아 둔다 — 관문에서 먼저 돌아서면 이 프라미스의 실패를 아무도
   *      안 받는 상태가 되고, 그게 곧 미처리 프라미스 거절이다.
   */
  const detailPromise = fetchWeeklyIncomeDetail(session.uid, weekKey);
  detailPromise.catch(() => {
    /* 실제 오류는 아래 `await detailPromise` 가 던진다. */
  });

  /*
   * ★ **달력과 주차 목록도 여기서 미리 읽는다** (2026-08-19 개편).
   *   그러지 않으면 첫 화면이 빈 달력 → 스켈레톤 → 값 순으로 두 번 깜빡인다.
   *
   *   범위는 워크스페이스의 초기 상태와 **같은 함수**로 만든다(`week-range.ts`) —
   *   한 칸이라도 어긋나면 캐시 키가 달라져 여기서 심은 값이 쓰이지 않고 클라이언트가
   *   같은 데이터를 다시 받는다. 그래서 손으로 계산하는 자리를 아예 두지 않았다.
   *
   *   ⚠️ **넥슨 호출은 여전히 0건이다.** 원장은 전부 우리 DB 다(§1.1).
   */
  const calendarRange = calendarLedgerRange(kstMonthKey(now), weekKey);
  const listRange = listLedgerRange(weekKey, LEDGER_PAGE_WEEKS);
  const calendarPromise = fetchIncomeLedger(
    session.uid,
    calendarRange.from,
    calendarRange.to,
  );
  const listPromise = fetchIncomeLedger(
    session.uid,
    listRange.from,
    listRange.to,
  );
  /*
    미리 `catch` 를 달아 둔다 — 관문(계정 상태)에서 먼저 돌아서면 이 프라미스의 실패를
    아무도 안 받는 상태가 되고, 그게 곧 미처리 프라미스 거절이다.
    ★ **원장 조회가 실패해도 화면을 죽이지 않는다.** 달력은 자기 로딩·오류 상태를 갖고
      있으므로, 심지 못하면 클라이언트가 다시 부르고 실패하면 재시도 버튼을 그린다.
  */
  calendarPromise.catch(() => undefined);
  listPromise.catch(() => undefined);

  /*
    ★ 루트 레이아웃이 이미 부른 값이다. `loadCurrentUser` 가 React `cache()` 로
      요청 범위 메모이제이션을 하므로 여기서는 왕복이 없다.
  */
  const user = await loadCurrentUser();
  if (user === null) {
    /*
      세션 쿠키는 살아 있는데 계정이 정지·삭제됐다. 이것은 **서버가 확실히 아는 사실**
      이므로 게이트로 넘기지 않는다 — 게이트는 "서버가 세션을 못 봤다"를 구제할 뿐이고,
      여기서 게이트를 태우면 죽은 계정이 원장을 다시 조회하려 든다.
      (`GET /api/auth/me` 가 같은 판정을 내리면서 세션·힌트 쿠키를 함께 지운다.)
    */
    return (
      <main className={PAGE_SHELL_CLASS}>
        <Card className="flex flex-col gap-2">
          <CardTitle className="text-body-lg">계정을 사용할 수 없습니다</CardTitle>
          <CardDescription>
            정지되었거나 삭제된 계정입니다. 홈에서 다시 로그인해 주세요.
          </CardDescription>
        </Card>
        <IncomeFooter />
      </main>
    );
  }

  /*
   * ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1). 예전에는 이 원장을 `initial` props
   *   로 내려보냈고, 워크스페이스가 `initialData` 로 받았다 — `initialDataUpdatedAt` 이
   *   없어 그 값이 영영 신선한 것으로 취급되는 자리였다. 이제 요청 범위 QueryClient 에
   *   심어 `dehydrate` 하면 `dataUpdatedAt` 까지 함께 넘어간다.
   *
   * ⚠️ **넥슨 호출 0건.** 결정석 가격도 수익도 넥슨 API 에 존재하지 않는다(§1.1).
   */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    const [detail, calendar, list] = await Promise.all([
      detailPromise,
      /*
        원장 두 벌은 **실패해도 페이지를 죽이지 않는다.** 금액 요약이 살아 있으면
        화면의 핵심은 그려지고, 달력·주차 목록은 자기 오류 상태에서 재시도할 수 있다.
      */
      calendarPromise.then(
        (value) => value,
        () => null,
      ),
      listPromise.then(
        (value) => value,
        () => null,
      ),
    ]);

    queryClient.setQueryData(queryKeys.db.income.detail(weekKey), detail);
    if (calendar !== null) {
      queryClient.setQueryData(
        queryKeys.db.income.ledger(calendarRange.from, calendarRange.to),
        calendar,
      );
    }
    if (list !== null) {
      queryClient.setQueryData(
        queryKeys.db.income.ledger(listRange.from, listRange.to),
        list,
      );
    }
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <IncomeHeader now={now} />

      <HydrationBoundary state={dehydratedState}>
        <IncomeWorkspace weekKey={weekKey} nowIso={now.toISOString()} />
      </HydrationBoundary>

      <IncomeFooter />
    </main>
  );
}
