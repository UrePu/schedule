import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import {
  LoginRequiredGate,
  requireSessionOrLogin,
} from "@/features/auth/server/login-required";
import { fetchMyParties } from "@/features/dashboard/server/dashboard-repo";
import { EtcScreen } from "@/features/etc/components";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getWeekKey } from "@/lib/time/week";

/**
 * `/etc` — 관리 › **기타**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 해체의 **착지점**이다 (2026-08-20)
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시가 관리 무리 셋째 자리를 `etc` 로 지정했고, 남은 대시보드 카드의 행선지를
 * 물었을 때 답이 *"관리 탭으로 통합"* 이었다.
 *
 * 여기에 무엇이 오고 무엇이 오지 않았는지는 `etc-screen.tsx` 머리말에 있다. 요점만:
 * **설정 버튼 넷(추적 캐릭터 · API 키 · 카톡 봇 연결 · 로그아웃)이 이 화면의 존재
 * 이유다** — 대시보드가 사라지면서 그 넷은 앱 어디에도 입구가 없어졌다.
 *
 * `force-dynamic` 이 필수다: 화면이 "누가 보고 있는가"와 "지금이 몇 주차인가"에 달려 있다.
 */

export const metadata: Metadata = {
  title: "기타",
  description:
    "추적 캐릭터와 넥슨 API 키, 카카오톡 봇 연결을 관리하고 내 파티 목록을 확인합니다.",
};

export const dynamic = "force-dynamic";

export default async function EtcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const now = new Date();

  /*
    비로그인은 **로그인 화면으로 보낸다**(발주 2026-11-09 — 예전에는 200 으로 안내 카드를
    그렸다). 힌트 쿠키가 있으면 서버는 판정하지 않고 게이트에 넘긴다 — RSC 결함 방어
    (`features/auth/server/login-required.tsx`). 세션이 null 이면 아래로 DB 접근이 한 줄도
    실행되지 않는다.
  */
  const session = await requireSessionOrLogin("/etc", await searchParams);
  if (session === null) {
    return (
      <main className={PAGE_SHELL_CLASS}>
        <LoginRequiredGate />
      </main>
    );
  }

  const weekKey = getWeekKey(now);

  /*
    ★ **읽기는 여기서, 보관은 캐시에** (§2.4 Rule 1). 파티를 만들거나 터뜨리는
      뮤테이션이 `party.mine` 을 무효화하므로 이 목록이 스스로 따라 움직인다.
    ⚠️ **넥슨 호출 0건.** 우리 DB 읽기 하나뿐이다.
  */
  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(
      queryKeys.db.party.mine(weekKey),
      await fetchMyParties(session.uid, weekKey),
    );
  });

  return (
    <main className={PAGE_SHELL_CLASS}>
      <HydrationBoundary state={dehydratedState}>
        <EtcScreen weekKey={weekKey} now={now} />
      </HydrationBoundary>

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
      </footer>
    </main>
  );
}
