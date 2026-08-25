"use client";

import { ChevronDown, ChevronUp, Pencil, ScrollText } from "lucide-react";
import { useState } from "react";

import { MesoAmount, Numeric } from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";

import { sortClearsByBoss } from "../lib/clear-order";
import { formatWeekRange } from "../lib/week-range";
import type { WeekLedgerEntry } from "../types";
import { ClearRecordRow } from "./clear-record-row";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주차별 내역 — *"주차별로 32주차엔 얼마 벌었다. 드랍 뭐였다"* (2026-08-19 발주자)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 달력이 "언제"를 답하면 이 목록은 "그 주에 얼마"를 답한다. 둘은 **같은 조회 하나**
 * (`GET /api/income/ledger`)를 보므로 서로 다른 숫자를 말할 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 주간과 월간을 갈라 센다 (2026-08-19 발주자: *"주간 월간은 따로놔야지"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * **12개 상한은 주간에만 걸린다**(§1). 한 줄에 `41건` 이라고만 쓰면 그 숫자가 상한과
 * 비교되는 값인지 아닌지 알 수 없다. 건수도 금액도 주기마다 따로 적고, 합치는 것은
 * 총 수령액 한 줄뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 개별 수정이 여기서도 열린다 (*"개별수정 가능하도록해"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터별 클리어 목록이 화면에서 빠지면서 그쪽에 있던 수정 진입점이 사라졌다.
 * 달력의 날짜 상세와 **이 목록의 `수정` 버튼**이 그 자리를 대신하며, 둘 다 같은 창
 * (`LedgerClearDialog` → `ClearEditRow`)을 연다. 편집기를 새로 만들지 않았다.
 *
 * ⚠️ **숫자를 만들지 않는다.** 주차 합계는 `v_weekly_income` 의 컬럼이고 드랍의 몫은
 *    `v_run_drop_settlement.amount_meso` 다. 화면이 1/n 을 다시 적으면 웹과 카톡 봇의
 *    답이 갈라진다.
 * ⚠️ 문장은 `text-body-sm`(14px) 이상. `text-caption`(12px)은 수치 주석·라벨에만 쓴다(§4).
 */

export interface WeekLedgerListProps {
  /** 최신 주차가 먼저. **기록이 없는 주차는 들어 있지 않다.** */
  readonly weeks: readonly WeekLedgerEntry[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** 더 과거 주차가 남아 있는가. 서버가 준 `earliestWeekKey` 로 판단한 결과. */
  readonly canLoadMore: boolean;
  readonly isLoadingMore: boolean;
  readonly onLoadMore: () => void;
  /**
   * 한 요청의 조회 범위 상한(`LEDGER_MAX_WEEKS`)에 닿았는가.
   *
   * `canLoadMore = false` 의 이유가 **둘**이라 구분해야 한다 — "원장이 끝났다"와 "여기까지가
   * 한 번에 볼 수 있는 최대"는 사용자가 할 일이 다르다. 같은 문장으로 말하면 데이터가
   * 더 있는데도 없다고 거짓말하게 된다.
   */
  readonly atMaxSpan: boolean;
  readonly onEditWeek: (weekKey: string) => void;
  /** 이번 주에는 배지를 붙인다. */
  readonly currentWeekKey: string;
  readonly className?: string;
}

export function WeekLedgerList({
  weeks,
  isLoading,
  isError,
  onRetry,
  canLoadMore,
  isLoadingMore,
  onLoadMore,
  atMaxSpan,
  onEditWeek,
  currentWeekKey,
  className,
}: WeekLedgerListProps) {
  /** 펼친 주차들. 기본은 접힘 — 한 주에 40건이 넘어 전부 펼치면 화면이 스무 개가 된다. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(weekKey: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(weekKey)) next.delete(weekKey);
      else next.add(weekKey);
      return next;
    });
  }

  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-w-0 items-start gap-2">
        <ScrollText aria-hidden size={20} className="mt-0.5 text-secondary" />
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>주차별 내역</CardOverline>
          <CardTitle className="text-body-lg">주차마다 얼마를 벌었나</CardTitle>
        </div>
      </div>

      <p className="text-body-sm text-ink-muted">
        주차는 목요일 00:00 초기화 기준입니다. 주간 결정석 12개 상한은 캐릭터당이며 월간
        결정석은 그 카운터에 들어가지 않아 건수와 금액을 따로 셉니다.
      </p>

      {isError ? (
        <ErrorState
          title="주차별 내역을 불러오지 못했습니다"
          description="아래 목록은 마지막으로 확인된 기록입니다. 잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
          className="py-6"
        />
      ) : null}

      {isLoading && weeks.length === 0 ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : weeks.length === 0 ? (
        /*
          빈 상태 — **"0원을 벌었다"가 아니라 "기록이 없다"** 이다(§0.3).
          오류로 읽히지 않도록 색도 아이콘도 중립이고, 다음에 할 일을 문장으로 말한다.
        */
        <EmptyState
          icon={<ScrollText size={24} />}
          title="아직 기록된 주차가 없습니다"
          description="일정을 클리어로 체크하거나 인게임 스케줄러를 동기화하면 그 주차부터 여기에 쌓입니다."
          className="py-10"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {weeks.map((week) => {
            const isOpen = expanded.has(week.weekKey);
            const unknownCount =
              week.weekly.unknownPriceCount + week.monthly.unknownPriceCount;

            return (
              <li
                key={week.weekKey}
                className="flex flex-col gap-2 rounded-md border border-border bg-background p-pad-md"
              >
                {/* ── 머리줄: 주차 · 기간 · 총액 · 수정 ─────────────────── */}
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-headline text-body font-semibold text-ink">
                        {/* `2026-W33` 은 순수 ASCII 주차 **키**라 통째로 mono 다(§4). */}
                        <Numeric>{week.weekKey}</Numeric>
                      </span>
                      {week.weekKey === currentWeekKey ? (
                        <span className="rounded-full border border-primary px-2 py-0.5 text-caption text-primary">
                          이번 주
                        </span>
                      ) : null}
                    </span>
                    <span className="text-caption text-ink-muted tabular-nums">
                      {formatWeekRange(week.weekKey)}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <MesoAmount
                      value={week.totalIncomeMeso}
                      compact
                      suffix={false}
                      tone="accent"
                      className="font-headline text-body-lg font-semibold"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="cursor-pointer"
                      disabled={week.clears.length === 0}
                      onClick={() => onEditWeek(week.weekKey)}
                    >
                      <Pencil aria-hidden size={14} />
                      수정
                    </Button>
                  </div>
                </div>

                {/* ── 주간 / 월간 / 드랍 — 12개 상한은 주간에만 걸린다 ──── */}
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <dt className="text-caption text-ink-muted">주간 보스</dt>
                    <dd className="flex items-baseline gap-1.5">
                      <span className="text-caption text-ink tabular-nums">
                        <Numeric>{week.weekly.clearCount}</Numeric>건
                      </span>
                      <MesoAmount
                        value={week.weekly.incomeMeso}
                        compact
                        suffix={false}
                        className="text-body-sm font-semibold"
                      />
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <dt className="text-caption text-ink-muted">월간 보스</dt>
                    <dd className="flex items-baseline gap-1.5">
                      <span className="text-caption text-ink tabular-nums">
                        <Numeric>{week.monthly.clearCount}</Numeric>건
                      </span>
                      <MesoAmount
                        value={week.monthly.incomeMeso}
                        compact
                        suffix={false}
                        className="text-body-sm font-semibold"
                      />
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <dt className="text-caption text-ink-muted">드랍</dt>
                    <dd className="flex items-baseline gap-1.5">
                      <span className="text-caption text-ink tabular-nums">
                        <Numeric>{week.drops.length}</Numeric>건
                      </span>
                      <MesoAmount
                        value={week.dropIncomeMeso}
                        compact
                        suffix={false}
                        className="text-body-sm font-semibold"
                      />
                    </dd>
                  </div>
                </dl>

                {/* ── 드랍 내역 (발주 요구: *"드랍 뭐였다"*) ──────────────── */}
                {week.drops.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {week.drops.map((drop) => (
                      <li
                        key={drop.dropId}
                        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-md border border-border bg-surface px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                          {drop.itemName}
                        </span>
                        <span className="shrink-0 text-caption text-ink-muted">
                          {drop.bossDisplayName ?? "일정 미상"}
                        </span>
                        <MesoAmount
                          value={drop.myShareMeso}
                          compact
                          suffix={false}
                          tone="accent"
                          className="min-w-20 shrink-0 justify-end text-body-sm font-semibold"
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* ⚠️ 합계에 들어가지 않은 것들. 위 숫자가 전부라고 읽히면 안 된다. */}
                {unknownCount > 0 ? (
                  <WarningNote>
                    가격 미확인 {unknownCount}건은 이 주차 합계에서 제외했습니다. 0 으로
                    더하지 않습니다.
                  </WarningNote>
                ) : null}

                {week.weeklyOverLimitCount > 0 ? (
                  <WarningNote>
                    캐릭터당 주간 결정석 판매 한도를 넘긴 클리어가{" "}
                    {week.weeklyOverLimitCount}건 있습니다. 넘긴 만큼은 이 합계에서 빠져
                    있습니다.
                  </WarningNote>
                ) : null}

                {week.unsoldDropCount > 0 ? (
                  <p className="text-body-sm text-ink-muted">
                    아직 팔지 않은 드랍 {week.unsoldDropCount}건은 금액이 없어 합계에
                    들어가지 않았습니다.
                  </p>
                ) : null}

                {/* ── 클리어 목록 — 기본 접힘 ─────────────────────────── */}
                {week.clears.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => toggle(week.weekKey)}
                      aria-expanded={isOpen}
                      className="flex cursor-pointer items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-body-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {isOpen ? (
                        <ChevronUp aria-hidden size={14} />
                      ) : (
                        <ChevronDown aria-hidden size={14} />
                      )}
                      클리어 {week.clears.length}건 {isOpen ? "접기" : "보기"}
                    </button>

                    {isOpen ? (
                      <ul className="flex flex-col gap-1.5">
                        {/* 보스 순서는 원장 상세 창과 같은 함수가 정한다(2026-08-25). */}
                        {sortClearsByBoss(week.clears).map((clear) => (
                          <ClearRecordRow key={clear.clearId} clear={clear} />
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/*
        "더 보기" — 서버가 준 `earliestWeekKey` 로 남은 것이 있는지 판단한다. 남은 것이
        없으면 버튼을 숨기고 **끝났다는 사실을 문장으로** 말한다. 비활성 버튼만 남기면
        사용자는 눌러 보고 아무 일도 안 일어나는 것을 확인해야 한다.
      */}
      {canLoadMore ? (
        <Button
          variant="secondary"
          size="sm"
          className="cursor-pointer self-center"
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? "불러오는 중…" : "이전 주차 더 보기"}
        </Button>
      ) : weeks.length > 0 ? (
        <p className="self-center text-body-sm text-ink-muted">
          {atMaxSpan
            ? "한 번에 볼 수 있는 최대 기간까지 표시했습니다. 더 예전 기록은 달력에서 달을 넘겨 확인할 수 있습니다."
            : "기록이 있는 가장 오래된 주차까지 모두 표시했습니다."}
        </p>
      ) : null}
    </Card>
  );
}
