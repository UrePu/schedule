"use client";

import { useMemo, useRef, useState } from "react";

import { participantLabel } from "@/lib/domain/participant-label";
import {
  DAY_MINUTES,
  formatDayMinute,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  RunCommitment,
  TimeRange,
} from "@/types/domain";

import { overlapToneClass, overlapWindowKey } from "./overlay-grid";
import { SelectionStartMarker } from "./selection-start-marker";
import {
  buildDayRows,
  computeOverlayAxis,
  projectToDayRows,
  toAxisBox,
  toAxisPercent,
  type DayRow,
  type OverlayAxis,
} from "../lib/overlay-layout";
import { exceptionSpan } from "../lib/exception-span";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 좁은 화면용 겹쳐보기 — **시간이 세로로 흐르고, 하루씩 본다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"반응형때는 세로 배치로 변경해줘"* → 선택지 중
 * **"시간축을 세로로 (하루씩)"**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 축을 돌리는가 — 가로축은 **폭이 모자란 순간 정보를 잃는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 가로 배치에서는 하루가 `이름칸 + 시간축` 을 가로로 나눠 쓴다. 360px 에서는 시간축에
 * 234px 밖에 남지 않아 이름이 `더…` 로 잘리고 막대가 몇 픽셀짜리가 된다. 실측 화면에서
 * 금요일의 겹침 네 덩어리가 서로 구분되지 않았다.
 *
 * 축을 세로로 돌리면 **긴 쪽(스크롤 가능한 세로)** 이 시간축이 된다. 시간은 아무리 길어도
 * 스크롤로 이어 볼 수 있지만 가로는 그럴 수 없다 — 화면 밖에 있는 사람의 막대는
 * "세로로 겹침을 읽는다"는 이 표의 작동 원리와 정면으로 충돌하기 때문이다.
 *
 * ★ 방향이 `/`(이번 주 일정) 시간표와 **같다**. 두 화면이 같은 주의 같은 시간을 반대
 *   방향으로 그리면 머릿속에서 매번 돌려 읽어야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 하루씩 보는 대신 **요일 칩**을 둔다
 * ─────────────────────────────────────────────────────────────────────────────
 * 7일 × (겹침 + 인원수) 열을 360px 에 넣으면 열 하나가 30px 이 된다. 그래서 한 번에
 * 하루만 그리고 요일은 칩으로 넘긴다.
 * ★ 칩에 **겹침이 있는 날인지 표시한다**(점). 하루씩 보면 "다른 날은 어떤가"가 안 보이는데,
 *   그걸 모르면 칩을 하나하나 눌러 봐야 한다. 점 하나가 그 탐색을 없앤다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇이 그대로인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 겹침 밴드 · 개인 레인 · 제외(특이사항) · 이미 잡힌 일정 — **네 층이 전부 남는다.**
 * 축만 돌았을 뿐 읽는 방식은 같다. 색 규약도 그대로다: 제외는 tertiary 점선(사람이 안
 * 된다고 말한 시간), 잡힌 일정은 secondary 실선(이미 쓰기로 한 시간).
 */

/** 1분당 세로 픽셀. 3시간 눈금이 90px 간격이 되어 라벨이 겹치지 않는다. */
const MINUTE_PX = 0.5;
/** 축이 아무리 짧아도 이만큼은 그린다 — 한 시간짜리 축은 읽을 수가 없다. */
const MIN_TRACK_PX = 260;

export interface OverlayDayGridProps {
  readonly range: TimeRange;
  readonly members: readonly PartyMember[];
  readonly intervals: readonly AvailabilityInterval[];
  readonly overlapWindows: readonly OverlapWindow[];
  readonly exceptions: readonly AvailabilityException[];
  readonly commitments: readonly RunCommitment[];
  readonly selectedWindowKey: string | null;
  readonly onSelectWindow: (window: OverlapWindow, startsAt?: Date) => void;
  /** 고른 시작 시각. `▶────` 막대가 여기서 뻗는다. */
  readonly selectedStartsAt: Date | null;
  /** 겹침을 **클릭**했다 — 등록 모달을 연다(가로 격자와 같은 규약). */
  readonly onOpenComposer: () => void;
}

export function OverlayDayGrid({
  range,
  members,
  intervals,
  overlapWindows,
  exceptions,
  commitments,
  selectedWindowKey,
  onSelectWindow,
  selectedStartsAt,
  onOpenComposer,
}: OverlayDayGridProps) {
  const dayRows = useMemo<readonly DayRow[]>(
    () => buildDayRows(range),
    [range],
  );
  const dayKeySet = useMemo(
    () => new Set(dayRows.map((row) => row.dayKey)),
    [dayRows],
  );

  /**
   * 보고 있는 날. **인덱스가 아니라 `dayKey`** 로 들고 있는다 — 주차를 넘기면 배열이
   * 통째로 갈리는데, 인덱스로 들고 있으면 "3번째 날"이라는 무의미한 값이 남는다.
   */
  const [activeDayKey, setActiveDayKey] = useState<string | null>(null);
  const [draggingHead, setDraggingHead] = useState(false);
  /** 손잡이 드래그의 기준 높이. 격자 전체가 축이다. */
  const gridRef = useRef<HTMLDivElement>(null);

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

  const exceptionSegments = useMemo(
    () =>
      projectToDayRows(
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
            note: exception.note,
          };
        }),
        dayKeySet,
        (item) => item.id,
      ),
    [exceptions, dayKeySet],
  );

  const commitmentSegments = useMemo(
    () =>
      projectToDayRows(
        commitments,
        dayKeySet,
        (item, index) => `${item.personId}-${item.runId}-${index}`,
      ),
    [commitments, dayKeySet],
  );

  /*
    축은 **주 전체**로 한 번 계산한다. 날마다 다시 재면 요일을 바꿀 때마다 눈금이
    움직여, 같은 높이가 어제와 다른 시각을 뜻하게 된다 — 하루씩 보는 화면에서 그건
    비교 자체를 불가능하게 만든다(가로 배치가 축을 모든 행에 공유하는 것과 같은 이유).
  */
  const axis = useMemo(
    () =>
      computeOverlayAxis([
        ...intervalSegments,
        ...windowSegments,
        ...commitmentSegments,
      ]),
    [intervalSegments, windowSegments, commitmentSegments],
  );

  /** 겹침이 하나라도 있는 날 — 요일 칩의 점. */
  const daysWithOverlap = useMemo(
    () => new Set(windowSegments.map((segment) => segment.dayKey)),
    [windowSegments],
  );

  /*
    기본 선택은 **겹침이 있는 첫 날**이다. 그냥 첫 날을 고르면 대개 아무것도 없는 날을
    열게 되고, 사용자는 "왜 비었지" 를 먼저 묻게 된다. 아무 날에도 겹침이 없으면 첫 날.
  */
  const activeDay =
    dayRows.find((row) => row.dayKey === activeDayKey) ??
    dayRows.find((row) => daysWithOverlap.has(row.dayKey)) ??
    dayRows[0];

  if (activeDay === undefined) return null;

  const dayKey = activeDay.dayKey;
  const trackPx = Math.max(
    (axis.endMinute - axis.startMinute) * MINUTE_PX,
    MIN_TRACK_PX,
  );

  const dayWindows = windowSegments.filter(
    (segment) => segment.dayKey === dayKey,
  );

  /** 플레이헤드가 가리키는 겹침 — 손잡이를 끌 때 이 구간 안으로 가둔다. */
  const selectedSegment =
    selectedWindowKey === null
      ? undefined
      : dayWindows.find(
          (segment) => overlapWindowKey(segment.datum) === selectedWindowKey,
        );

  const playheadMinute =
    selectedStartsAt === null || selectedSegment === undefined
      ? null
      : minutesFromKstDay(selectedStartsAt, dayKey);

  return (
    <div className="flex flex-col gap-3">
      {/* ── 요일 칩 ─────────────────────────────────────────────────────── */}
      <ul
        role="tablist"
        aria-label="요일 선택"
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {dayRows.map((row) => {
          const active = row.dayKey === dayKey;
          return (
            <li key={row.dayKey} className="shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveDayKey(row.dayKey)}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-md border px-2.5 py-1.5 transition duration-200",
                  active
                    ? "border-primary bg-primary-subtle"
                    : "border-border bg-surface",
                )}
              >
                <span
                  className={cn(
                    "text-body-sm font-bold",
                    active ? "text-primary" : "text-ink",
                  )}
                >
                  {row.weekdayLabel}
                </span>
                <span className="text-overline tabular-nums text-ink-muted">
                  {row.dateLabel}
                </span>
                {/*
                  겹침이 있는 날 표시. **자리는 언제나 차지한다** — 점이 없는 날만 높이가
                  줄면 칩 줄이 들쭉날쭉해져 그 자체가 잡음이 된다.
                */}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    daysWithOverlap.has(row.dayKey)
                      ? "bg-primary"
                      : "bg-transparent",
                  )}
                />
                {daysWithOverlap.has(row.dayKey) ? (
                  <span className="sr-only">(겹치는 시간 있음)</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ── 열 머리글 ───────────────────────────────────────────────────── */}
      <div className="flex gap-1.5">
        <span className="w-11 shrink-0" />
        <span className="flex-1 text-center text-caption font-semibold text-ink-label">
          겹침
        </span>
        {members.map((member) => (
          <span
            key={member.personId}
            className="flex-1 truncate text-center text-caption text-ink-muted"
            title={participantLabel(member)}
          >
            {/*
              열이 좁아 이름을 다 못 쓴다. **번호를 앞세운다** — 카톡에서 부르는 그
              번호라(§1.4) 이름이 잘려도 누구인지 가리킬 수 있다.
            */}
            {member.seatNo} {member.displayName}
          </span>
        ))}
      </div>

      {/* ── 격자 ────────────────────────────────────────────────────────── */}
      <div
        className="relative flex gap-1.5"
        style={{ height: `${trackPx}px` }}
        ref={gridRef}
      >
        {/*
          ── 플레이헤드 ──────────────────────────────────────────────────────
          영상 편집기의 재생 헤드(발주 지시 2026-08-25). 세로 배치에서는 시간이
          아래로 흐르므로 **가로선**이 되고, 손잡이는 왼쪽 시각 눈금 자리에 붙는다.
          격자 전체를 가로질러 모든 사람 열을 한 번에 자른다 — "이 시각에 누가 되는가"가
          한 줄로 읽힌다.
        */}
        {playheadMinute === null || selectedSegment === undefined ? null : (
          <>
            <SelectionStartMarker
              orientation="y"
              axis={axis}
              startMinute={playheadMinute}
              showLabel={false}
            />
            <button
              type="button"
              aria-label={`시작 시각 ${formatDayMinute(playheadMinute)} — 끌어서 옮기기`}
              className={cn(
                "absolute left-0 z-20 -translate-y-1/2 cursor-ns-resize touch-none select-none",
                "rounded-sm bg-primary px-1 py-px text-overline font-bold tabular-nums text-white ring-2 ring-surface",
              )}
              style={{ top: `${toAxisPercent(playheadMinute, axis)}%` }}
              onPointerDown={(event) => {
                setDraggingHead(true);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!draggingHead) return;
                const grid = gridRef.current;
                if (grid === null) return;
                const rect = grid.getBoundingClientRect();
                if (rect.height <= 0) return;
                const ratio = (event.clientY - rect.top) / rect.height;
                const raw =
                  axis.startMinute + ratio * (axis.endMinute - axis.startMinute);
                /* 10분 스냅 + 겹침 안쪽으로 가둔다 — 가로 격자와 같은 규칙. */
                const snapped = Math.round(raw / 10) * 10;
                const last = Math.max(
                  selectedSegment.startMinute,
                  selectedSegment.endMinute - 10,
                );
                const next = Math.min(
                  Math.max(snapped, selectedSegment.startMinute),
                  last,
                );
                onSelectWindow(selectedSegment.datum, kstMoment(dayKey, next));
              }}
              onPointerUp={(event) => {
                setDraggingHead(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => setDraggingHead(false)}
            >
              {formatDayMinute(playheadMinute)}
            </button>
          </>
        )}
        {/* 시각 눈금 */}
        <div className="relative w-11 shrink-0">
          {axis.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-caption tabular-nums text-ink-muted"
              style={{ top: `${toAxisPercent(tick, axis)}%` }}
            >
              {formatDayMinute(tick)}
            </span>
          ))}
        </div>

        {/* 겹침 열 */}
        <Track axis={axis} isOvernightBoundaryVisible>
          {dayWindows.map((segment) => {
            const box = toAxisBox(segment.startMinute, segment.endMinute, axis);
            const key = overlapWindowKey(segment.datum);
            const selected = key === selectedWindowKey;
            return (
              <button
                key={segment.key}
                type="button"
                onClick={() => {
                  onSelectWindow(segment.datum);
                  // 고르는 것과 여는 것이 한 동작(발주 지시 2026-08-25).
                  onOpenComposer();
                }}
                title={`${formatDayMinute(segment.startMinute)}~${formatDayMinute(segment.endMinute)} · ${segment.datum.availableCount}명 가능`}
                className={cn(
                  /*
                    ★ 농도 사다리는 **가로 격자와 같은 함수**가 정한다. 여기서 임의의
                      알파(`primary/60` 같은)를 쓰면 같은 인원수가 화면 폭에 따라 다른
                      색으로 보이고, 다크 모드에서 네 단계가 뭉갠다(§4).
                  */
                  "absolute inset-x-0 flex items-center justify-center rounded-sm text-overline font-bold tabular-nums transition duration-200",
                  overlapToneClass(segment.datum.availableCount, members.length),
                  selected ? "ring-2 ring-primary" : null,
                )}
                style={{ top: `${box.left}%`, height: `${box.width}%` }}
              >
                {/* 3% 미만은 글자가 들어갈 자리가 없다 — 막대만 그린다. */}
                {box.width >= 6 ? segment.datum.availableCount : null}
              </button>
            );
          })}
        </Track>

        {/* 사람 열 */}
        {members.map((member) => (
          <Track key={member.personId} axis={axis}>
            {intervalSegments
              .filter(
                (segment) =>
                  segment.dayKey === dayKey &&
                  segment.datum.personId === member.personId,
              )
              .map((segment) => {
                const box = toAxisBox(
                  segment.startMinute,
                  segment.endMinute,
                  axis,
                );
                return (
                  <span
                    key={segment.key}
                    className="absolute inset-x-0 rounded-sm bg-available"
                    style={{ top: `${box.left}%`, height: `${box.width}%` }}
                  />
                );
              })}

            {/*
              제외 — tertiary **점선**. 사람이 "그날은 안 된다"고 말한 시간이라 가능
              막대 위에 겹쳐 그린다. red 가 아닌 이유는 실패가 아니기 때문이다(§4).
            */}
            {exceptionSegments
              .filter(
                (segment) =>
                  segment.dayKey === dayKey &&
                  segment.datum.personId === member.personId,
              )
              .map((segment) => {
                const box = toAxisBox(
                  segment.startMinute,
                  segment.endMinute,
                  axis,
                );
                return (
                  <span
                    key={segment.key}
                    title={segment.datum.note ?? "특이사항(제외)"}
                    className="absolute inset-x-0 rounded-sm border border-dashed border-tertiary bg-excluded"
                    style={{ top: `${box.left}%`, height: `${box.width}%` }}
                  />
                );
              })}

            {/*
              이미 잡힌 일정 — secondary **실선**. 제외와 원인이 다르고 사용자가 할 일도
              다르다(패턴 수정 vs 일정 수정)라 색을 가른다.
            */}
            {commitmentSegments
              .filter(
                (segment) =>
                  segment.dayKey === dayKey &&
                  segment.datum.personId === member.personId,
              )
              .map((segment) => {
                const box = toAxisBox(
                  segment.startMinute,
                  segment.endMinute,
                  axis,
                );
                return (
                  <span
                    key={segment.key}
                    title={`${segment.datum.shortName} · 이미 잡힌 일정`}
                    className="absolute inset-x-0 rounded-sm bg-secondary"
                    style={{ top: `${box.left}%`, height: `${box.width}%` }}
                  />
                );
              })}
          </Track>
        ))}
      </div>

      {dayWindows.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          {activeDay.label}에는 겹치는 시간이 없습니다. 위에서 다른 요일을 눌러
          보세요.
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** 한 열. 눈금 가로선을 깔고 그 위에 막대를 절대 배치한다. */
function Track({
  axis,
  isOvernightBoundaryVisible = false,
  children,
}: {
  readonly axis: OverlayAxis;
  readonly isOvernightBoundaryVisible?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="relative h-full min-w-0 flex-1 rounded-md bg-neutral-100">
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          aria-hidden
          className="absolute inset-x-0 h-px bg-border"
          style={{ top: `${toAxisPercent(tick, axis)}%` }}
        />
      ))}
      {/*
        자정 구분선. 축이 24:00 을 넘을 때만 의미가 있고, 겹침 열에만 그린다 —
        모든 열에 그으면 선이 여섯 줄이 되어 정작 눈금과 구분되지 않는다.
      */}
      {isOvernightBoundaryVisible &&
      axis.hasOvernight &&
      axis.startMinute < DAY_MINUTES &&
      axis.endMinute > DAY_MINUTES ? (
        <span
          aria-hidden
          className="absolute inset-x-0 h-px bg-ink-muted"
          style={{ top: `${toAxisPercent(DAY_MINUTES, axis)}%` }}
        />
      ) : null}
      {children}
    </div>
  );
}
