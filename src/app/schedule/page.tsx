import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { WIDE_PAGE_SHELL_CLASS } from "@/components/layout";
import { readSession } from "@/features/auth/server/session";
import { ScheduleWorkspace } from "@/features/schedule/components";
import {
  fetchAvailability,
  fetchAvailabilityExceptions,
  fetchAvailabilityOverlap,
  fetchMyAvailabilityPatterns,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
  fetchPartyRuns,
  fetchPersonRunCommitments,
} from "@/features/schedule/server/schedule-repo";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";
import type { TimeRange } from "@/types/domain";

/**
 * 핵심 화면 (CLAUDE.md §1.4) — 가능 시간 겹쳐보기 + 보스 일정 등록.
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
  title: "가능 시간 겹쳐보기",
  description:
    "파티원을 고르면 각자의 가능 시간이 겹쳐 보이고, 겹치는 시간대를 골라 보스 일정을 등록합니다.",
};

export default async function SchedulePage() {
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
   *   1단: 파티 ∥ 내 패턴 ∥ 내 캐릭터
   *   2단: 구성원 ∥ 파티 보스 ∥ 런 목록      (파티 id 가 필요하다)
   *   3단: 가용시간 4종                        (사람 목록이 필요하다)
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
  const [members, partyBosses, runs] = await Promise.all([
    party
      ? fetchPartyMembers(viewerUserId, party.partyId)
      : Promise.resolve([]),
    /*
      첫 파티가 묶어서 도는 보스. 등록 폼의 체크박스가 첫 페인트에 이미 켜져 있어야
      한다 — 클라이언트 조회를 기다리면 "체크된 것 없음"이 한 번 번쩍인다.
      ⚠️ 마이그레이션 미적용이면 빈 배열이다(오류가 아니다).
    */
    party ? fetchPartyBosses(viewerUserId, party.partyId) : Promise.resolve([]),
    party
      ? fetchPartyRuns(viewerUserId, party.partyId, weekKey)
      : Promise.resolve([]),
  ]);

  const personIds = members.map((member) => member.personId);
  // 기본값은 **전원**. 다 모여야 하는 창부터 보여 주고, 부족하면 사용자가 k 를 낮춘다.
  const minCount = Math.max(personIds.length, 1);

  const dehydratedState = await dehydrateQueries(async (queryClient) => {
    queryClient.setQueryData(queryKeys.db.party.list(), parties);
    if (party !== null) {
      queryClient.setQueryData(
        queryKeys.db.party.members(party.partyId),
        members,
      );
    }

    const [intervals, overlap, exceptions, commitments] = await Promise.all([
      fetchAvailability(viewerUserId, personIds, range),
      fetchAvailabilityOverlap(viewerUserId, personIds, range, minCount),
      fetchAvailabilityExceptions(viewerUserId, personIds, range),
      /*
        이미 등록된 런이 잡아먹은 시간. 겹침 결과에서는 이미 빠져 있고, 이 조회는
        그 사실을 **"이미 일정 있음" 으로 보여 주기 위한** 것이다 — 첫 페인트에서
        블록이 한 박자 늦게 나타나면 "방금 없던 게 생겼다"로 읽힌다.
        ⚠️ 마이그레이션 미적용이면 빈 배열이다(오류가 아니다).
      */
      fetchPersonRunCommitments(viewerUserId, personIds, range),
    ]);

    /*
      ★ 사람이 0명이면(비로그인이거나 파티가 없을 때) 워크스페이스가 그 세 쿼리를
        `enabled: false` 로 끈다. 켜지지 않을 키에 값을 심으면 캐시에 죽은 항목만 남으므로
        조건을 화면과 **똑같이** 맞춘다.
    */
    if (personIds.length > 0) {
      queryClient.setQueryData(
        queryKeys.db.availability.resolve(personIds, range),
        intervals,
      );
      queryClient.setQueryData(
        queryKeys.db.availability.overlap(personIds, range, minCount),
        overlap,
      );
      queryClient.setQueryData(
        queryKeys.db.availability.exceptions(personIds, range),
        exceptions,
      );
      queryClient.setQueryData(
        queryKeys.db.availability.commitments(personIds, range),
        commitments,
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
            <h1 className="font-headline text-subhead text-ink">
              가능 시간 겹쳐보기
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* 주차는 항상 "~8/20 목 00:00 초기화" 형태로 명시한다 (§1.4). */}
            <WeekLabel date={now} />
          </div>
        </div>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          가능 시간은 <strong className="font-semibold">요일별 반복 패턴</strong>
          으로 한 번만 등록하고, 야근·출장 같은 일회성 변경은{" "}
          <strong className="font-semibold">
            그 날짜에서 빼는 특이사항(제외)
          </strong>
          으로 처리합니다. 매주 다시 입력할 필요가 없고, 사유는 적지 않아도
          됩니다. 아래{" "}
          <strong className="font-semibold">내 가능 시간 설정</strong> 버튼에서
          요일별 격자를 끌어 칠하면 됩니다.
        </p>
        {viewerUserId === null ? (
          /*
            가용시간은 생활 패턴이라 `can_view_availability()` 가 열람자 없이는 무조건
            false 다 — 비로그인에게는 **정책상** 비어 있다. 에러가 아니라 정상 상태이므로
            경고(빨강)가 아닌 안내 톤으로 알린다 (§4: 빨강은 실패·취소 전용).
          */
          <p className="max-w-3xl rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink-muted">
            로그인하지 않으면 <strong className="font-semibold">공개 파티</strong>
            와 그 일정만 보입니다. 가능 시간은 생활 패턴이라 본인·친구·같은 파티
            구성원에게만 공개되므로, 아래 겹쳐보기는 비어 있습니다.
          </p>
        ) : null}
      </header>

      <HydrationBoundary state={dehydratedState}>
        <ScheduleWorkspace
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
