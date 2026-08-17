"use client";

import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { SeatNumber, formatKstShort } from "@/components/domain";
import {
  DAY_MINUTES,
  describeDayMinute,
  formatDayMinute,
} from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  TimeRange,
} from "@/types/domain";

import { exceptionSpan } from "../lib/exception-span";
import {
  buildDayRows,
  computeOverlayAxis,
  projectToDayRows,
  toAxisBox,
  toAxisPercent,
  type DayRow,
  type OverlayAxis,
} from "../lib/overlay-layout";

/**
 * 겹쳐보기 시간표 본체 (§1.4 왼쪽 패널).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 모양인가
 * ─────────────────────────────────────────────────────────────────────────────
 * **행 = 하루, 가로축 = 시각.** 사람을 세로로 쌓아 같은 x 좌표가 같은 시각이 되게 했다.
 * 겹침은 "세로로 막대가 몇 개 겹쳐 있는가"로 바로 읽히고, 그 위에 **겹침 밴드**가
 * 확정된 답("21:00~23:00 · 6명")을 한 줄로 요약한다.
 *
 * 사람마다 색을 다르게 주지 **않았다.** 6색을 새로 만들면 디자인 토큰 밖으로 나가고,
 * 색이 6개면 정작 중요한 신호(겹침 농도)가 묻힌다. 사람 구분은 **이름**이 하고
 * 색 채널은 겹침 인원 하나에만 쓴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 행 라벨은 **이름**이다 (번호가 아니다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 레인 왼쪽에 번호만 찍었는데, 날짜 옆에 맨숫자가 세로로 늘어서니
 * **요일 번호처럼 읽혔다**(실제로 그렇게 읽혔다). 사람의 주 식별자는 이름이고
 * 번호는 카톡에서 부르기 위한 보조 식별자다. 그래서 `③ 미르` 처럼 배지 + 이름으로 둔다.
 * 날짜 거터도 **요일을 가장 크게** 둔다 — 스케줄 화면에서는 "며칠"보다 "무슨 요일"이
 * 먼저 읽혀야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자정 넘김 (22:00~02:00)
 * ─────────────────────────────────────────────────────────────────────────────
 * 가로축을 24:00 에서 끊지 않는다. 축은 `24:00`, `27:00` 으로 이어지고 구간은
 * **하나의 사각형**으로 그려진다. 24:00 위치에는 점선 구분선을 둔다.
 * 하루를 24시간으로 자르면 이 구간이 두 행으로 쪼개져 "밤 10시부터 새벽 2시까지"라는
 * 한 덩어리가 화면에서 사라진다(DB 가 `end_minute > 1440` 을 허용한 이유와 같다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 예외(특이사항)를 어떻게 그리는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 예외는 **뺄셈 전용**이라 해석 결과에는 "짧아졌다"는 사실만 남고 이유가 사라진다(§1.4).
 * 그래서 예외를 **별도 레이어로 그 사람 레인 위에 겹쳐 그린다** — tertiary 점선 블록.
 * 색은 red 가 아니라 tertiary orange 다. red 는 실패·취소 전용이고, 예외는 실패가 아니다(§4).
 */

/** 레인 트랙의 좌측 여백 = 이름 거터 `w-20`(5rem) + `gap-1.5`(0.375rem). */
const LANE_GUTTER = "5.375rem";

/**
 * 겹침 밴드 라벨을 어느 폭부터 보여 줄지. 좁은 창에서 글자가 잘리는 대신
 * 단계적으로 줄인다(`6명` → `6` → 없음). 정보는 `aria-label`·`title` 이 항상 갖는다.
 */
const LABEL_FULL_MIN_WIDTH_PCT = 6;
const LABEL_SHORT_MIN_WIDTH_PCT = 3;

export interface OverlayGridProps {
  readonly range: TimeRange;
  /** 그 파티의 구성원 전원. 표시 순서는 번호 오름차순(연속이 아닐 수 있다). */
  readonly members: readonly PartyMember[];
  readonly intervals: readonly AvailabilityInterval[];
  readonly overlapWindows: readonly OverlapWindow[];
  /** 제외 구간(특이사항). 해당 사람 레인 위에 겹쳐 그린다. */
  readonly exceptions: readonly AvailabilityException[];
  readonly selectedWindowKey: string | null;
  readonly onSelectWindow: (window: OverlapWindow) => void;
}

/** 제외 블록 하나 — 사람 레인 위에 그리기 위한 절대 시각 구간. */
interface ExceptionBlock {
  readonly id: string;
  readonly personId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly isAllDay: boolean;
  readonly note: string | null;
}

/** 겹침 인원 비율 → 밴드 색 농도. 클래스 문자열은 정적이어야 하므로 사다리로 둔다. */
function overlapToneClass(count: number, total: number): string {
  const ratio = total > 0 ? count / total : 0;
  if (ratio >= 1) return "bg-overlap-4 text-overlap-4-fg";
  if (ratio >= 0.75) return "bg-overlap-3 text-overlap-3-fg";
  if (ratio >= 0.5) return "bg-overlap-2 text-overlap-2-fg";
  return "bg-overlap-1 text-overlap-1-fg";
}

export function overlapWindowKey(window: OverlapWindow): string {
  return `${window.startsAt.toISOString()}|${window.endsAt.toISOString()}`;
}

function AxisTicks({ axis }: { axis: OverlayAxis }) {
  return (
    <div className="relative h-5">
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          style={{ left: `${toAxisPercent(tick, axis)}%` }}
          className={cn(
            "absolute top-0 -translate-x-1/2 text-body-sm font-medium tabular-nums whitespace-nowrap",
            tick >= DAY_MINUTES ? "text-tertiary" : "text-ink-label",
          )}
        >
          {formatDayMinute(tick)}
        </span>
      ))}
    </div>
  );
}

/** 눈금 세로선 + 자정(24:00) 구분선. 모든 레인 뒤에 한 번만 깔린다. */
function AxisRules({ axis }: { axis: OverlayAxis }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0"
      style={{ left: LANE_GUTTER }}
    >
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          style={{ left: `${toAxisPercent(tick, axis)}%` }}
          className="absolute inset-y-0 w-px bg-border"
        />
      ))}
      {axis.hasOvernight &&
      axis.startMinute < DAY_MINUTES &&
      axis.endMinute > DAY_MINUTES ? (
        <span
          style={{ left: `${toAxisPercent(DAY_MINUTES, axis)}%` }}
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 border-l-2 border-dashed border-tertiary"
        />
      ) : null}
    </div>
  );
}

export function OverlayGrid({
  range,
  members,
  intervals,
  overlapWindows,
  exceptions,
  selectedWindowKey,
  onSelectWindow,
}: OverlayGridProps) {
  const dayRows = useMemo<readonly DayRow[]>(
    () => buildDayRows(range),
    [range],
  );

  const dayKeySet = useMemo(
    () => new Set(dayRows.map((row) => row.dayKey)),
    [dayRows],
  );

  const intervalSegments = useMemo(
    () =>
      projectToDayRows(
        intervals,
        dayKeySet,
        (item, index) => `${item.personId}-${index}`,
      ),
    [intervals, dayKeySet],
  );

  const windowSegments = useMemo(
    () =>
      projectToDayRows(overlapWindows, dayKeySet, (item) =>
        overlapWindowKey(item),
      ),
    [overlapWindows, dayKeySet],
  );

  const exceptionBlocks = useMemo<readonly ExceptionBlock[]>(
    () =>
      exceptions.map((exception) => {
        const span = exceptionSpan(
          exception.dayKey,
          exception.startMinute,
          exception.endMinute,
        );
        return {
          id: exception.id,
          personId: exception.personId,
          startsAt: span.startsAt,
          endsAt: span.endsAt,
          isAllDay:
            exception.startMinute === null && exception.endMinute === null,
          note: exception.note,
        };
      }),
    [exceptions],
  );

  const exceptionSegments = useMemo(
    () => projectToDayRows(exceptionBlocks, dayKeySet, (item) => item.id),
    [exceptionBlocks, dayKeySet],
  );

  const exceptionDayKeys = useMemo(
    () => new Set(exceptionSegments.map((segment) => segment.dayKey)),
    [exceptionSegments],
  );

  // 축은 개인 구간과 겹침 창을 **모두** 담아야 한다. 어느 한쪽이라도 잘리면 거짓말이 된다.
  // 제외 블록은 축을 정의하지 않는다 — 하루 전체 제외가 축을 00:00~24:00 로 벌리기 때문이다.
  const axis = useMemo(
    () => computeOverlayAxis([...intervalSegments, ...windowSegments]),
    [intervalSegments, windowSegments],
  );

  const total = members.length;

  return (
    <div className="overflow-x-auto">
      {/* 모바일에서 눈금·이름이 뭉개지지 않도록 최소 폭을 주고 가로 스크롤한다. */}
      <div className="min-w-[48rem]">
        {/* 축 눈금 */}
        <div className="flex items-end gap-2 pb-1">
          <div className="w-16 shrink-0" />
          <div className="flex min-w-0 flex-1 gap-1.5">
            <span className="w-20 shrink-0" />
            <div className="min-w-0 flex-1">
              <AxisTicks axis={axis} />
            </div>
          </div>
        </div>

        {dayRows.map((row) => {
          const rowWindows = windowSegments.filter(
            (segment) => segment.dayKey === row.dayKey,
          );
          const hasException = exceptionDayKeys.has(row.dayKey);

          return (
            <div
              key={row.dayKey}
              className={cn(
                "flex gap-2 border-t border-border py-2.5",
                row.isWeekend && "bg-neutral-50",
              )}
            >
              {/* 날짜 거터 — 요일이 가장 먼저 읽혀야 한다. */}
              <div className="w-16 shrink-0 pt-0.5">
                <p className="flex items-center gap-1 whitespace-nowrap">
                  <span
                    className={cn(
                      "text-body-lg font-bold",
                      row.isWeekend ? "text-tertiary" : "text-ink",
                    )}
                  >
                    {row.weekdayLabel}
                  </span>
                  {hasException ? (
                    <span
                      title="특이사항(제외 시간)이 있는 날입니다"
                      className="inline-flex text-tertiary"
                    >
                      <TriangleAlert aria-hidden size={14} />
                      <span className="sr-only">특이사항 있음</span>
                    </span>
                  ) : null}
                </p>
                <p className="text-body-sm text-ink-label tabular-nums whitespace-nowrap">
                  {row.dateLabel}
                </p>
              </div>

              {/* 레인 영역 */}
              <div className="relative min-w-0 flex-1">
                <AxisRules axis={axis} />

                {/* 겹침 밴드 — 이 화면의 답이 여기 있다. */}
                <div className="relative flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="w-20 shrink-0 text-right text-caption font-semibold text-ink-label"
                  >
                    겹침
                  </span>
                  <div className="relative h-8 min-w-0 flex-1 rounded-sm bg-neutral-100">
                    {rowWindows.map((segment) => {
                      const window = segment.datum;
                      const box = toAxisBox(
                        segment.startMinute,
                        segment.endMinute,
                        axis,
                      );
                      const key = overlapWindowKey(window);
                      const label = `${formatKstShort(window.startsAt)} ~ ${formatKstShort(window.endsAt)}`;
                      const text =
                        box.width >= LABEL_FULL_MIN_WIDTH_PCT
                          ? `${window.availableCount}명`
                          : box.width >= LABEL_SHORT_MIN_WIDTH_PCT
                            ? `${window.availableCount}`
                            : "";

                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => onSelectWindow(window)}
                          aria-pressed={selectedWindowKey === key}
                          aria-label={`${label} · ${window.availableCount}명 가능. 이 시간대로 일정 등록`}
                          title={`${label} · ${window.availableCount}명 가능`}
                          style={{ left: `${box.left}%`, width: `${box.width}%` }}
                          className={cn(
                            "absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-sm",
                            "text-body-sm font-bold tabular-nums whitespace-nowrap transition duration-200",
                            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                            "hover:brightness-95",
                            overlapToneClass(window.availableCount, total),
                            selectedWindowKey === key &&
                              "ring-2 ring-primary ring-offset-1",
                          )}
                        >
                          {text}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 개인 레인 — 번호 순. 라벨은 이름이 주, 번호가 보조다. */}
                <div className="mt-1.5 flex flex-col gap-1">
                  {members.map((member) => {
                    const personSegments = intervalSegments.filter(
                      (segment) =>
                        segment.dayKey === row.dayKey &&
                        segment.datum.personId === member.personId,
                    );
                    const personExceptions = exceptionSegments.filter(
                      (segment) =>
                        segment.dayKey === row.dayKey &&
                        segment.datum.personId === member.personId,
                    );

                    const availableText =
                      personSegments.length === 0
                        ? "가능 시간 없음"
                        : personSegments
                            .map(
                              (segment) =>
                                `${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ");
                    const excludedText =
                      personExceptions.length === 0
                        ? ""
                        : ` · 제외 ${personExceptions
                            .map((segment) =>
                              segment.datum.isAllDay
                                ? "이 날 전체"
                                : `${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ")}`;
                    const description = `${member.displayName} · ${availableText}${excludedText}`;

                    return (
                      <div
                        key={member.personId}
                        className="flex items-center gap-1.5"
                      >
                        <span className="flex w-20 shrink-0 items-center gap-1 overflow-hidden">
                          <SeatNumber
                            seatNo={member.seatNo}
                            size="sm"
                            tone="muted"
                          />
                          <span
                            title={member.displayName}
                            className="truncate text-body-sm text-ink-label"
                          >
                            {member.displayName}
                          </span>
                        </span>
                        <div
                          role="img"
                          aria-label={`${row.label} ${description}`}
                          className="relative h-5 min-w-0 flex-1 rounded-sm bg-neutral-100"
                        >
                          {personSegments.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );

                            return (
                              <span
                                key={segment.key}
                                title={`${member.displayName} · ${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)}${
                                  segment.datum.note
                                    ? ` · ${segment.datum.note}`
                                    : ""
                                }`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm bg-available"
                              />
                            );
                          })}

                          {/*
                            제외 구간 — 패턴에서 깎여 나간 자리. 해석 결과에는 없는 정보라
                            예외 조회 결과로 따로 겹쳐 그린다.
                          */}
                          {personExceptions.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );

                            return (
                              <span
                                key={segment.key}
                                title={`${member.displayName} · ${
                                  segment.datum.isAllDay
                                    ? `${row.label} 전체 제외`
                                    : `${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)} 제외`
                                }${segment.datum.note ? ` · ${segment.datum.note}` : ""}`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm border border-dashed border-tertiary bg-excluded"
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 범례. 색만으로 정보를 전달하지 않도록 텍스트를 함께 둔다. */
export function OverlayLegend({
  total,
  minCount,
  hasOvernight,
}: {
  total: number;
  minCount: number;
  hasOvernight: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body-sm text-ink-label">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-overlap-4" />전원{" "}
        {total}명
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-overlap-3" />
        다수
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-overlap-1" />
        최소 {minCount}명
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-available" />
        개인 가능시간
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-3 rounded-sm border border-dashed border-tertiary bg-excluded"
        />
        제외된 시간(특이사항)
      </span>
      {hasOvernight ? (
        <span className="inline-flex items-center gap-1.5 text-tertiary">
          <span
            aria-hidden
            className="h-3 w-0 border-l-2 border-dashed border-tertiary"
          />
          24:00 이후는 익일 — 구간은 끊지 않고 이어 그립니다
        </span>
      ) : null}
    </div>
  );
}
