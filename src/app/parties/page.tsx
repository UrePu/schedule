import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WIDE_PAGE_SHELL_CLASS } from "@/components/layout";
import { readSession } from "@/features/auth/server/session";
import { PartyWorkspace } from "@/features/schedule/components";
import {
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
} from "@/features/schedule/server/schedule-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";

/**
 * 파티 관리 — **누구와 무엇을** 가는지 정하는 화면.
 *
 * 서버 컴포넌트가 **첫 파티 기준**의 결과를 미리 읽어 **쿼리 캐시에 심고**
 * (`dehydrateQueries`) 클라이언트가 `HydrationBoundary` 로 인수한다. 그래서:
 * - 첫 HTML 에 이미 목록이 들어 있다(비로그인 열람 · SEO · 즉시 표시).
 * - 파티를 바꾼 뒤부터는 TanStack Query 가 클라이언트에서 조회한다.
 * - **뮤테이션 뒤에는 `invalidateQueries` 만으로 이 값들이 갱신된다** (§2.4 Rule 1).
 *   예전에는 같은 결과를 `initial` props 로 넘겼는데, props 는 무효화가 닿을 수 없는
 *   자리라 서버 렌더분이 낡은 채 남았다.
 *
 * ⚠️ **repo 를 직접 import 한다.** `features/schedule/data` 의 함수는 상대 경로
 *   `fetch("/api/...")` 라 서버에서는 해석되지 않는다. service_role 은 브라우저로 나갈 수
 *   없으므로 읽기 경로가 서버(직접)·클라이언트(Route Handler) 둘로 갈리는 것이 설계다.
 *
 * `force-dynamic` 인 이유: 이 화면이 그리는 목록이 **"누가 보고 있는가"** 에 달려 있다.
 * 빌드 시점에 프리렌더되면 세션에 따라 달라져야 할 목록이 한 벌로 고정된다.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "파티 관리",
  description:
    "같이 보스 갈 사람들로 파티를 만들고, 묶어서 도는 보스와 결정석 분배 배율을 정합니다.",
};

export default async function PartiesPage() {
  // 열람 범위는 세션이 정한다. 비로그인은 공개 파티만 보고, 만들거나 고칠 수 없다.
  const session = await readSession();
  const viewerUserId = session?.uid ?? null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 서버 prefetch → dehydrate (§2.4 Rule 1)
   * ═══════════════════════════════════════════════════════════════════════════
   * 결과를 `initial` props 가 아니라 **워크스페이스가 실제로 쓰는 캐시 키 그대로**
   * 심는다. 키가 같으므로 클라이언트는 "이게 서버가 읽은 그 조합인가"를 다시 판정할
   * 필요가 없고, 뮤테이션은 `invalidateQueries` 만으로 이 값들을 움직인다.
   *
   * ⚠️ **비로그인 200 을 지킨다** (DoD §0.3). 세션이 없어도 여기 있는 조회는 전부
   *    던지지 않는다 — 공개 파티만 나오고, 내 캐릭터 조회는 아예 건너뛴다.
   * ⚠️ **넥슨 호출 0건.** 전부 우리 DB 다.
   *
   * ★ 2026-09-28 — 가용시간(겹쳐보기·패턴)과 런 목록 prefetch 가 **빠졌다.** 이 화면은
   *   그 넷을 한 줄도 그리지 않으므로 읽을 이유가 없었다(§2.4 — 조회는 화면이 실제로
   *   쓰는 것만). 남은 것은 파티 · 첫 파티의 구성원 · 첫 파티의 보스 · 내 캐릭터 넷이다.
   */
  const [parties, runCharacters] = await Promise.all([
    fetchParties(viewerUserId),
    /*
      파티에 데려갈 내 캐릭터. 파티 바의 캐릭터 선택이 첫 페인트부터 채워진다 —
      클라이언트 조회를 기다리면 칸 하나가 스켈레톤으로 시작한다.
    */
    fetchMyRunCharacters(viewerUserId),
  ]);

  const party = parties[0] ?? null;

  const [members, partyBosses] = await Promise.all([
    party
      ? fetchPartyMembers(viewerUserId, party.partyId)
      : Promise.resolve([]),
    /*
      첫 파티가 묶어서 도는 보스.
      ⚠️ 마이그레이션 미적용이면 빈 배열이다(오류가 아니다).
    */
    party ? fetchPartyBosses(viewerUserId, party.partyId) : Promise.resolve([]),
  ]);

  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(queryKeys.db.party.list(), parties);
    if (party !== null) {
      queryClient.setQueryData(
        queryKeys.db.party.members(party.partyId),
        members,
      );
      queryClient.setQueryData(
        queryKeys.db.party.bosses(party.partyId),
        partyBosses,
      );
    }

    /*
      ★ **보스 카탈로그는 심지 않는다.** 코드 상수로 내려가(`@/lib/boss-master`)
        워크스페이스가 직접 읽는다 — 이 화면에서 왕복 3회(카탈로그·별칭·줄임말)와
        직렬화 수십 KB 가 함께 사라졌다.
    */

    if (viewerUserId !== null) {
      queryClient.setQueryData(
        queryKeys.db.characters.forRuns(),
        runCharacters,
      );
    }
  });

  return (
    <main className={WIDE_PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {/*
              ★ 여기 있던 `파티 N개` 는 **뺐다.** 서버가 센 값이라 파티를 새로 만들어도
                따라오지 않았고, 바로 아래 `PartyBar` 가 **쿼리에서 온 같은 목록**으로
                이미 개수를 그린다. 두 자리에 두면 언젠가 서로 다른 말을 한다 (§2.4 Rule 1).
            */}
            <p className="text-overline uppercase text-primary">
              보스 파티 일정
            </p>
            {/*
              ★ 이름을 **일정 짜기** 로 바꿨다 (2026-08-19 발주자: *"이거 일정 짜기?
                계획하기? 이거 이름좀이상하고"*). 예전 이름(`가능 시간 겹쳐보기`)은
                **수단**을 말하고 있었다 — 겹쳐 보는 것은 방법이고, 사람이 여기 와서
                하려는 일은 일정을 잡는 것이다. 둘 중 `일정 짜기` 를 고른 이유는
                `계획하기` 가 보스 계획(`/boss-plans`) 화면과 헷갈리기 때문이다.
            */}
            <h1 className="font-headline text-subhead text-ink">파티 관리</h1>
          </div>
        </div>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          <strong className="font-semibold">누구와 무엇을</strong> 가는지 정하는
          화면입니다. 언제 갈지는{" "}
          <Link
            href="/"
            className="font-semibold text-primary underline-offset-2 hover:underline"
          >
            이번주 일정
          </Link>{" "}
          시간표의 빈 칸을 눌러 정합니다. 파티는 조합별로 따로 두세요 — 보스마다
          같이 가는 사람이 다릅니다.
        </p>
        {viewerUserId === null ? (
          <p className="max-w-3xl rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink-muted">
            로그인하지 않으면 <strong className="font-semibold">공개 파티</strong>
            만 보이고 만들거나 고칠 수 없습니다.
          </p>
        ) : null}
      </header>

      <HydrationBoundary state={dehydratedState}>
        <PartyWorkspace viewerPersonId={viewerUserId} />
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
