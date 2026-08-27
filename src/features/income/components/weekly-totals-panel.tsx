"use client";

import { useQuery } from "@tanstack/react-query";

import { ErrorState, Skeleton } from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import type { WeekKey } from "@/types/domain";

import { fetchWeeklyIncomeDetail } from "../data";
import { WeeklyTotalsCard } from "./weekly-totals-card";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 수익 3칸 — **캐시에서 읽는 얇은 껍데기**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-27): *"달력과 기간별 수익 1페이지. 주간 수익용 아까말한거 1페이지"*
 * → 3칸 카드는 **이번 주 현황 화면**(`/boss-status`)으로 갔고, 달력·주차별 내역은
 *   `/income` 에 남았다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 서버가 props 로 내려 주지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 값은 **뮤테이션이 바꾼다** — 동기화가 클리어를 만들면 금액이 움직인다. §2.4 Rule 1:
 * 화면 데이터의 주인은 쿼리 캐시 하나이고, props 로 내려간 값에는 `invalidateQueries`
 * 가 닿지 못한다. 그래서 서버는 **같은 키로 프리페치만** 하고 여기서 캐시를 읽는다.
 *
 * ★ 키가 `/income` 의 상세 조회와 **같다**(`db.income.detail(weekKey)`). 두 화면이
 *   같은 주를 보고 있으면 조회도 한 번이고, 한쪽에서 무효화하면 다른 쪽도 따라온다.
 *   응답의 나머지(원장·캐릭터별 내역)는 여기서 안 쓰지만 버리는 것이 아니라
 *   **같은 캐시에 채워 두는** 것이라, `/income` 으로 넘어갈 때 이미 준비돼 있다.
 */

export interface WeeklyTotalsPanelProps {
  readonly weekKey: WeekKey;
  readonly className?: string;
}

export function WeeklyTotalsPanel({
  weekKey,
  className,
}: WeeklyTotalsPanelProps) {
  const detailQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.income.detail(weekKey)),
    queryFn: async () => (await fetchWeeklyIncomeDetail(weekKey)).detail,
  });

  if (detailQuery.isPending) {
    /* 높이를 카드와 맞춘다 — 스켈레톤이 작으면 도착하는 순간 아래가 통째로 밀린다. */
    return <Skeleton className={className ?? "h-[7.5rem]"} />;
  }

  if (detailQuery.isError) {
    return (
      <ErrorState
        title="이번 주 수익을 불러오지 못했습니다"
        description="잠시 후 다시 시도해 주세요."
        onRetry={() => void detailQuery.refetch()}
        className={className}
      />
    );
  }

  return (
    <WeeklyTotalsCard
      summary={detailQuery.data.crystalSummary}
      className={className}
    />
  );
}
