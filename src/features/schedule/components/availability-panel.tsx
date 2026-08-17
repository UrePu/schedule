"use client";

import { CalendarRange, TriangleAlert, UserRoundX } from "lucide-react";
import { useMemo } from "react";

import { WeekLabel, kstWeekdayKo } from "@/components/domain";
import {
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  FilterChip,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import {
  describeDayMinute,
  formatDayMinute,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  TimeRange,
} from "@/types/domain";

import { OverlayGrid, OverlayLegend } from "./overlay-grid";

/**
 * 왼쪽 패널 — 선택한 사람들의 가능 시간을 겹쳐 보여 준다 (§1.4).
 *
 * 로딩(Skeleton) / 빈 상태(선택 없음 · 겹침 없음) / 에러(재시도)를 모두 여기서 가른다.
 * "겹치는 시간이 없다"는 **오류가 아니라 사실**이므로 ErrorState 가 아니라 EmptyState 다.
 */

export interface AvailabilityPanelProps {
  readonly now: Date;
  readonly range: TimeRange;
  /** 선택된 파티원 (seatNo 오름차순). */
  readonly members: readonly PartyMember[];
  readonly intervals: readonly AvailabilityInterval[];
  readonly overlapWindows: readonly OverlapWindow[];
  readonly exceptions: readonly AvailabilityException[];
  /** 파티원 전체 이름 조회용(예외 메모에 이름을 붙인다). */
  readonly memberNameById: ReadonlyMap<string, string>;
  /** `"all"` = 전원. 숫자면 "k명 이상". */
  readonly minCountChoice: number | "all";
  readonly effectiveMinCount: number;
  readonly onMinCountChange: (choice: number | "all") => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly selectedWindowKey: string | null;
  readonly onSelectWindow: (window: OverlapWindow) => void;
  /** 지금 보고 있는 파티 이름. 번호·구성원이 어느 파티 것인지 밝힌다. */
  readonly partyName: string | null;
}

function dayLabel(dayKey: string): string {
  const noon = kstMoment(dayKey, 720);
  return `${formatKst(noon, "M/d")} ${kstWeekdayKo(noon)}`;
}

/**
 * 예외는 **뺄셈 전용**이므로 문구도 "제외"로만 쓴다 (§1.4).
 * "이 시간만 가능" 같은 덧셈 표현을 쓰면 없는 기능을 있는 것처럼 말하게 된다.
 */
function describeException(exception: AvailabilityException): string {
  if (exception.startMinute === null || exception.endMinute === null) {
    return "이 날 전체 제외";
  }
  return `${formatDayMinute(exception.startMinute)}~${describeDayMinute(exception.endMinute)} 제외`;
}

export function AvailabilityPanel({
  now,
  range,
  members,
  intervals,
  overlapWindows,
  exceptions,
  memberNameById,
  minCountChoice,
  effectiveMinCount,
  onMinCountChange,
  isLoading,
  isError,
  onRetry,
  selectedWindowKey,
  onSelectWindow,
  partyName,
}: AvailabilityPanelProps) {
  const total = members.length;

  /** 선택 인원에 맞춰 필터 후보를 만든다. 전원 → N-1 → … → 2. */
  const choices = useMemo<ReadonlyArray<number | "all">>(() => {
    const list: Array<number | "all"> = ["all"];
    for (let k = total - 1; k >= 2; k -= 1) list.push(k);
    return list;
  }, [total]);

  const sortedExceptions = useMemo(
    () => [...exceptions].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    [exceptions],
  );

  const hasOvernight = useMemo(
    () =>
      intervals.some(
        (interval) =>
          formatKst(interval.startsAt, "yyyy-MM-dd") !==
          formatKst(interval.endsAt, "yyyy-MM-dd"),
      ),
    [intervals],
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <CalendarRange aria-hidden size={18} className="text-primary" />
            <CardTitle className="text-body-lg">가능 시간 겹쳐보기</CardTitle>
          </div>
          <p className="text-body-sm text-ink-muted">
            {partyName ? (
              <>
                <strong className="font-semibold text-ink-label">
                  {partyName}
                </strong>{" "}
                구성원의{" "}
              </>
            ) : null}
            반복 패턴에서 특이사항을 뺀 결과입니다. 겹침 막대를 누르면 오른쪽
            일정 등록에 시간이 채워집니다.
          </p>
        </div>
        <WeekLabel date={now} />
      </div>

      {/* N명 중 k명 이상 필터 — 6인이 다 안 모여도 4명이면 가는 경우가 흔하다. */}
      <div className="flex flex-wrap items-center gap-2">
        <span id="min-count-label" className="text-body-sm text-ink-label">
          최소 인원
        </span>
        <div
          role="group"
          aria-labelledby="min-count-label"
          className="flex flex-wrap gap-1.5"
        >
          {choices.map((choice) => (
            <FilterChip
              key={String(choice)}
              selected={minCountChoice === choice}
              onClick={() => onMinCountChange(choice)}
              disabled={total === 0}
            >
              {choice === "all" ? `전원 ${total}명` : `${choice}명 이상`}
            </FilterChip>
          ))}
        </div>
      </div>

      {isError ? (
        <ErrorState
          title="가능 시간을 불러오지 못했습니다"
          description="가용시간 조회는 열람 권한 검사를 거칩니다. 잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<UserRoundX size={24} />}
          title="이 파티에 구성원이 없습니다"
          description="위에서 파티를 고르거나 구성원을 추가하면 각자의 가능 시간이 여기에 겹쳐서 표시됩니다."
        />
      ) : isLoading ? (
        <SkeletonGroup label="가능 시간을 불러오는 중">
          {[0, 1, 2, 3, 4, 5, 6].map((index) => (
            <div key={index} className="flex gap-2">
              <Skeleton className="h-14 w-14 shrink-0" />
              <Skeleton className="h-14 flex-1" />
            </div>
          ))}
        </SkeletonGroup>
      ) : (
        <div className="flex flex-col gap-3">
          {overlapWindows.length === 0 ? (
            <EmptyState
              title={`${effectiveMinCount}명 이상 겹치는 시간이 없습니다`}
              description="최소 인원을 낮추거나 파티원 구성을 바꿔 보세요. 아래에는 각자의 가능 시간이 그대로 표시됩니다."
              className="py-6"
            />
          ) : null}

          <OverlayGrid
            range={range}
            members={members}
            intervals={intervals}
            overlapWindows={overlapWindows}
            exceptions={exceptions}
            selectedWindowKey={selectedWindowKey}
            onSelectWindow={onSelectWindow}
          />

          <OverlayLegend
            total={total}
            minCount={effectiveMinCount}
            hasOvernight={hasOvernight}
          />

          {sortedExceptions.length > 0 ? (
            <section
              aria-label="특이사항"
              className="flex flex-col gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3"
            >
              <h3 className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-chip-soon-fg">
                <TriangleAlert aria-hidden size={14} />
                특이사항 — 평소 패턴에서 아래 시간이 제외됩니다 (사유는 선택
                사항입니다)
              </h3>
              <ul className="flex flex-col gap-1">
                {sortedExceptions.map((exception) => (
                  <li
                    key={exception.id}
                    className="text-body-sm text-ink-label"
                  >
                    <span className="font-semibold tabular-nums">
                      {dayLabel(exception.dayKey)}
                    </span>
                    {" · "}
                    <span className="font-semibold">
                      {memberNameById.get(exception.personId) ?? "알 수 없음"}
                    </span>
                    {" — "}
                    {describeException(exception)}
                    {exception.note ? (
                      <span className="text-ink-muted">
                        {" · "}
                        {exception.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
