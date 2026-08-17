import type { Metadata } from "next";
import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { readSession } from "@/features/auth/server/session";
import { ScheduleWorkspace } from "@/features/schedule/components";
import {
  fetchAvailability,
  fetchAvailabilityExceptions,
  fetchAvailabilityOverlap,
  fetchBossCatalog,
  fetchParties,
  fetchPartyMembers,
  fetchPartyRuns,
} from "@/features/schedule/server/schedule-repo";
import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";
import type { TimeRange } from "@/types/domain";

/**
 * 핵심 화면 (CLAUDE.md §1.4) — 가능 시간 겹쳐보기 + 보스 일정 등록.
 *
 * 서버 컴포넌트가 **기본 선택 상태(전원 · 전원 겹침)** 의 결과를 미리 계산해
 * 클라이언트 워크스페이스에 넘긴다. 그래서:
 * - 첫 HTML 에 이미 겹침 결과가 들어 있다(비로그인 열람 · SEO · 즉시 표시).
 * - 선택을 바꾼 뒤부터는 TanStack Query 가 클라이언트에서 조회한다.
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

  // 파티는 **여러 개**다. 첫 파티를 기준으로 서버에서 미리 계산해 첫 페인트를 채운다.
  const parties = await fetchParties(viewerUserId);
  const party = parties[0] ?? null;
  const members = party
    ? await fetchPartyMembers(viewerUserId, party.partyId)
    : [];
  const personIds = members.map((member) => member.personId);
  // 기본값은 **전원**. 다 모여야 하는 창부터 보여 주고, 부족하면 사용자가 k 를 낮춘다.
  const minCount = Math.max(personIds.length, 1);

  const [intervals, overlap, exceptions, bosses, runs] = await Promise.all([
    fetchAvailability(viewerUserId, personIds, range),
    fetchAvailabilityOverlap(viewerUserId, personIds, range, minCount),
    fetchAvailabilityExceptions(viewerUserId, personIds, range),
    fetchBossCatalog(),
    party
      ? fetchPartyRuns(viewerUserId, party.partyId, weekKey)
      : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-[92rem] flex-col gap-4 px-4 py-section-mobile md:px-6 md:py-section-tablet">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-overline uppercase text-primary">
              파티 {parties.length}개
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
          됩니다.
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

      <ScheduleWorkspace
        now={now}
        range={range}
        weekKey={weekKey}
        viewerPersonId={viewerUserId}
        initial={{
          parties,
          partyId: party?.partyId ?? null,
          members,
          personIds,
          minCount,
          intervals,
          overlap,
          exceptions,
          bosses,
          runs,
        }}
      />

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
