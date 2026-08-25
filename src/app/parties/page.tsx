import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WIDE_PAGE_SHELL_CLASS } from "@/components/layout";
import { readSession } from "@/features/auth/server/session";
import { ScheduleWorkspace } from "@/features/schedule/components";
import {
  fetchAvailabilityBoard,
  fetchMyAvailabilityPatterns,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
  fetchPartyRuns,
} from "@/features/schedule/server/schedule-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";
import type { PartyMember, TimeRange } from "@/types/domain";

/**
 * 핵심 화면 (CLAUDE.md §1.4) — 일정 짜기(가능 시간 겹쳐보기 + 보스 일정 등록).
 *
 * 서버 컴포넌트가 **기본 선택 상태(전원 · 전원 겹침)** 의 결과를 미리 계산해
 * **쿼리 캐시에 심고**(`dehydrateQueries`) 클라이언트가 `HydrationBoundary` 로 인수한다.
 * 그래서:
 * - 첫 HTML 에 이미 겹침 결과가 들어 있다(비로그인 열람 · SEO · 즉시 표시).
 * - 선택을 바꾼 뒤부터는 TanStack Query 가 클라이언트에서 조회한다.
 * - **뮤테이션 뒤에는 `invalidateQueries` 만으로 이 값들이 갱신된다** (§2.4 Rule 1).
 *   예전에는 같은 결과를 `initial` props 로 넘겼는데, props 는 무효화가 닿을 수 없는
 *   자리라 서버 렌더분이 낡은 채 남았다.
 *
 * ⚠️ **repo 를 직접 import 한다.** `features/schedule/data` 의 함수는 상대 경로
 *   `fetch("/api/...")` 라 서버에서는 해석되지 않는다. service_role 은 브라우저로 나갈 수
 *   없으므로 읽기 경로가 서버(직접)·클라이언트(Route Handler) 둘로 갈리는 것이 설계다.
 *
 * `force-dynamic` 인 이유: 이 화면의 모든 계산이 **"지금이 몇 주차인가"** 와
 * **"누가 보고 있는가"** 에 달려 있다. 빌드 시점에 프리렌더되면 목요일 00:00 KST
 * 초기화가 지나도 주차가 얼어붙고, 세션에 따라 달라져야 할 목록이 한 벌로 고정된다.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "파티 관리",
  description:
    "같이 보스 갈 사람들로 파티를 만들고, 묶어서 도는 보스와 결정석 분배 배율을 정합니다.",
};

export default async function PartiesPage() {
  const now = new Date();
  // 주간 경계는 언제나 목요일 00:00 KST. 계산은 전부 lib/time/week.ts 에 위임한다.
  const range: TimeRange = { from: getWeekStart(now), to: getNextReset(now) };
  const weekKey = getWeekKey(now);

  // 열람 범위는 세션이 정한다. 비로그인은 공개 파티만 보고, 가용시간은 보이지 않는다.
  const session = await readSession();
  const viewerUserId = session?.uid ?? null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 서버 prefetch → dehydrate (§2.4 Rule 1)
   * ═══════════════════════════════════════════════════════════════════════════
   * 읽는 내용은 예전과 **똑같다**. 달라진 것은 결과를 `initial` props 가 아니라
   * **워크스페이스가 실제로 쓰는 캐시 키 그대로** 심는다는 점이다. 키가 같으므로
   * 클라이언트는 "이게 서버가 계산한 그 조합인가"를 다시 판정할 필요가 없고,
   * 뮤테이션은 `invalidateQueries` 만으로 이 값들을 움직인다.
   *
   * ⚠️ **비로그인 200 을 지킨다** (DoD §0.3). 세션이 없어도 여기 있는 조회는 전부
   *    던지지 않는다 — 가용시간·패턴은 `can_view_availability()` 가 빈 결과를 주고
   *    (정책상 비어 있는 것이지 오류가 아니다), 내 캐릭터 조회는 아예 건너뛴다.
   *
   * ⚠️ **넥슨 호출 0건.** 전부 우리 DB 다.
   */
  /*
   * ─────────────────────────────────────────────────────────────────────────
   * 의존이 없는 것은 **동시에 시작한다** (2026-08-18 성능 작업)
   * ─────────────────────────────────────────────────────────────────────────
   * 예전에는 `파티 → 구성원 → 나머지 전부` 의 직렬 3단이었다. 그런데 뒤쪽 묶음
   * 중 **내 반복 패턴**과 **내 캐릭터**는 파티를 전혀 쓰지 않고, **파티 보스**와
   * **런 목록**은 구성원을 쓰지 않는다. 왕복 하나당 고정비가 큰 환경에서 기다릴
   * 이유가 없는 것을 기다리게 두면 그대로 지연이 된다.
   *
   * ★ 2026-08-18 2차 — **겹쳐보기가 런 목록을 기다리던 것을 끊었다.**
   *   겹쳐보기의 입력은 `members` 하나뿐인데, 예전에는 `구성원 ∥ 보스 ∥ 런` 을
   *   **통째로** 기다린 뒤 시작했다. 런 조회는 안쪽이 3단(런 → 분배 가중치 → 분배
   *   계산)이라, 겹쳐보기가 아무 이유 없이 그 뒤에 줄을 서 있었다.
   *
   *   1단: 파티 ∥ 내 패턴 ∥ 내 캐릭터
   *   2단: (구성원 → 겹쳐보기 한 벌)  ∥  파티 보스  ∥  런 목록
   *        └ 겹쳐보기는 **구성원만** 기다린다. 보스·런과는 서로 남이다.
   */
  const [parties, myPatterns, runCharacters] = await Promise.all([
    fetchParties(viewerUserId),
    /*
      내 반복 패턴 **원본**. 첫 페인트에서 "가능 시간 미등록" 안내가 깜빡이지 않게
      하려면 서버에서 함께 실어야 한다. 비로그인은 대상이 없으므로 조회하지 않는다.
    */
    viewerUserId === null
      ? Promise.resolve([])
      : fetchMyAvailabilityPatterns(viewerUserId),
    /*
      일정에 데려갈 내 캐릭터. 등록 폼의 캐릭터 선택이 첫 페인트부터 채워진다 —
      예전에는 이것만 서버에서 안 실어 보내 폼 한 칸이 스켈레톤으로 시작했다.
    */
    fetchMyRunCharacters(viewerUserId),
  ]);

  const party = parties[0] ?? null;

  /*
    구성원 → 겹쳐보기. **이 사슬만** 순서가 있다.

    ⚠️ `members` 를 두 번 `await` 하지 않는다 — 같은 프라미스를 아래에서 다시 기다릴
       뿐이라 왕복은 한 번이다.
  */
  const membersPromise = party
    ? fetchPartyMembers(viewerUserId, party.partyId)
    : Promise.resolve([] as readonly PartyMember[]);

  const boardPromise = membersPromise.then((resolved) => {
    const ids = resolved.map((member) => member.personId);
    /*
      ★ **겹쳐보기 네 조각을 왕복 한 번에 받는다** (마이그레이션 24, 2026-08-18 성능 작업).
        개인 구간 · 겹침 창 · 예외 자국 · "이미 일정 있음" 블록은 같은 사람 집합 ·
        같은 구간의 **한 시점 스냅샷**이다. 예전에는 넷을 따로 물었고, 넷 각각이 앞서
        `can_view_availability` 를 사람 수만큼 돌렸다 — 6인 파티면 요청 28건에 왕복 2단.
        지금은 1건 1단이다. 계산은 그대로 DB 함수들에 있다(§1.4 — 겹쳐보기 로직은 한 곳).
        ⚠️ 마이그레이션 미적용이면 repo 가 옛 4종 호출로 되돌아간다(결과 동일, 왕복만 증가).
    */
    return fetchAvailabilityBoard(
      viewerUserId,
      ids,
      range,
      // 기본값은 **전원**. 다 모여야 하는 창부터 보여 주고, 부족하면 사용자가 k 를 낮춘다.
      Math.max(ids.length, 1),
    );
  });

  const [members, partyBosses, runs, board] = await Promise.all([
    membersPromise,
    /*
      첫 파티가 묶어서 도는 보스. 등록 폼의 체크박스가 첫 페인트에 이미 켜져 있어야
      한다 — 클라이언트 조회를 기다리면 "체크된 것 없음"이 한 번 번쩍인다.
      ⚠️ 마이그레이션 미적용이면 빈 배열이다(오류가 아니다).
    */
    party ? fetchPartyBosses(viewerUserId, party.partyId) : Promise.resolve([]),
    party
      ? fetchPartyRuns(viewerUserId, party.partyId, weekKey)
      : Promise.resolve([]),
    boardPromise,
  ]);

  const personIds = members.map((member) => member.personId);
  const minCount = Math.max(personIds.length, 1);

  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(queryKeys.db.party.list(), parties);
    if (party !== null) {
      queryClient.setQueryData(
        queryKeys.db.party.members(party.partyId),
        members,
      );
    }

    /*
      ★ 사람이 0명이면(비로그인이거나 파티가 없을 때) 워크스페이스가 이 쿼리를
        `enabled: false` 로 끈다. 켜지지 않을 키에 값을 심으면 캐시에 죽은 항목만 남으므로
        조건을 화면과 **똑같이** 맞춘다.
    */
    if (personIds.length > 0) {
      queryClient.setQueryData(
        queryKeys.db.availability.board(personIds, range, minCount),
        board,
      );
    }

    /*
      ★ **보스 카탈로그는 심지 않는다.** 코드 상수로 내려가(`@/lib/boss-master`)
        워크스페이스가 직접 읽는다 — 이 화면에서 왕복 3회(카탈로그·별칭·줄임말)와
        직렬화 수십 KB 가 함께 사라졌다.
    */

    if (party !== null) {
      queryClient.setQueryData(
        queryKeys.db.party.bosses(party.partyId),
        partyBosses,
      );
      queryClient.setQueryData(
        queryKeys.db.runs.list(party.partyId, weekKey),
        runs,
      );
    }

    if (viewerUserId !== null) {
      queryClient.setQueryData(
        queryKeys.db.availability.myPatterns(),
        myPatterns,
      );
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
            href="/schedule"
            className="font-semibold text-primary underline-offset-2 hover:underline"
          >
            일정 관리
          </Link>
          에서 정합니다. 파티는 조합별로 따로 두세요 — 보스마다 같이 가는 사람이
          다릅니다.
        </p>
        {viewerUserId === null ? (
          <p className="max-w-3xl rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink-muted">
            로그인하지 않으면 <strong className="font-semibold">공개 파티</strong>
            만 보이고 만들거나 고칠 수 없습니다.
          </p>
        ) : null}
      </header>

      <HydrationBoundary state={dehydratedState}>
        <ScheduleWorkspace
          mode="parties"
          now={now}
          range={range}
          weekKey={weekKey}
          viewerPersonId={viewerUserId}
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
