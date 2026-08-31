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

import {
  OVERLAY_GAP_HATCH,
  overlapToneClass,
  overlapWindowKey,
  overlayGapBadge,
  overlayGapTitle,
} from "./overlay-grid";
import {
  buildDayRows,
  buildOverlayGapMap,
  computeOverlayAxis,
  pickDragTargetSegment,
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

/** 10분 단위로 스냅한다 — 가로 격자와 같은 값. 분 단위는 보스 일정에서 의미가 없다. */
const STEP_MINUTES = 10;

/** 10분 스냅 + 겹침 구간 안으로 가두기. 끝 시각 자체는 시작점이 될 수 없다. */
function clampToSegmentY(
  minute: number,
  startMinute: number,
  endMinute: number,
): number {
  const snapped = Math.round(minute / STEP_MINUTES) * STEP_MINUTES;
  const last = Math.max(startMinute, endMinute - STEP_MINUTES);
  return Math.min(Math.max(snapped, startMinute), last);
}

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
  /**
   * 겹침 창을 만든 최소 인원. **빈칸의 원인 판정에만** 쓴다 —
   * 가로 격자와 같은 뜻이고 같은 함수(`buildOverlayGapMap`)로 들어간다.
   */
  readonly minCount: number;
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
  minCount,
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
  /** 끌었는가 — 끌고 나서 따라오는 click 을 한 번 삼킨다. */
  const movedHeadRef = useRef(false);
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

  /*
    빈칸 사유. 보고 있는 하루치만 쓰지만 **주 전체를 한 번에** 계산한다 — 요일 칩을
    누를 때마다 다시 도는 것을 막고, 무엇보다 가로 격자와 **같은 입력·같은 함수**라
    두 화면이 같은 상황에서 갈라질 수 없다.
  */
  const gapsByDay = useMemo(
    () =>
      buildOverlayGapMap({
        windows: windowSegments,
        intervals: intervalSegments,
        commitments: commitmentSegments,
        minCount,
      }),
    [windowSegments, intervalSegments, commitmentSegments, minCount],
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
  const dayGaps = gapsByDay.get(dayKey) ?? [];

  /*
    ── 플레이헤드가 가리키는 겹침 ───────────────────────────────────────────
    ★ **탭하기 전에도 선이 있다**(발주 지적 2026-08-25: *"핸드폰에서는 반드시 한번
      터치를 해야 이 라인이 생긴다"*). 고른 것이 없으면 그날 **첫 겹침의 시작**에
      기본으로 놓는다 — 조작할 것이 화면에 있어야 조작할 수 있다는 것을 알게 된다.
      선이 없는 화면은 "여기서 뭘 할 수 있는지"를 아무것도 말해 주지 않았다.
    ⚠️ 기본값은 **화면에만** 있고 부모 상태를 건드리지 않는다. 렌더 중에 부모를 바꾸면
       (effect 로 `onSelectWindow` 호출) 화면을 열기만 해도 선택이 생겨 버린다.
       대신 모달을 여는 모든 경로가 **열기 직전에 시각을 명시적으로 올려 보낸다.**
  */
  const selectedSegment =
    (selectedWindowKey === null
      ? undefined
      : dayWindows.find(
          (segment) => overlapWindowKey(segment.datum) === selectedWindowKey,
        )) ?? dayWindows[0];

  const playheadMinute =
    selectedSegment === undefined
      ? null
      : selectedStartsAt !== null &&
          selectedWindowKey !== null &&
          overlapWindowKey(selectedSegment.datum) === selectedWindowKey
        ? minutesFromKstDay(selectedStartsAt, dayKey)
        : selectedSegment.startMinute;

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
          <div
            /*
              ── 잡을 수 있는 선 ────────────────────────────────────────────
              발주 지시(2026-08-25): *"선자체도 살짝 두껍게 해서 잡을수있게 만들어."*

              ★ 보이는 선은 3px 이지만 **집는 자리는 24px** 이다. 손가락 끝의 접촉면은
                40px 안팎이라, 보이는 두께만큼만 받으면 세 번에 한 번은 빗나간다.
                투명한 여백을 위아래로 두는 것이 굵은 선을 그리는 것보다 낫다 —
                굵게 그리면 그 아래 겹침 밴드를 그만큼 가린다.
              ★ `touch-none` 이 필수다. 없으면 브라우저가 세로 스크롤로 가로채 선이
                따라오다 말고 페이지가 움직인다.
            */
            className={cn(
              "absolute inset-x-0 z-20 flex h-6 -translate-y-1/2 cursor-ns-resize touch-none select-none items-center",
              draggingHead && "cursor-grabbing",
            )}
            style={{ top: `${toAxisPercent(playheadMinute, axis)}%` }}
            onPointerDown={(event) => {
              setDraggingHead(true);
              movedHeadRef.current = false;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!draggingHead) return;
              const grid = gridRef.current;
              if (grid === null) return;
              const rect = grid.getBoundingClientRect();
              if (rect.height <= 0) return;
              movedHeadRef.current = true;
              const ratio = (event.clientY - rect.top) / rect.height;
              const raw =
                axis.startMinute + ratio * (axis.endMinute - axis.startMinute);
              /*
                ★ **누를 때의 구간에 갇히지 않는다**(발주 지적 2026-08-31: *"여기서 저
                  ----- 선이 안내려간다고"*). 예전에는 `selectedSegment` 가 드래그 내내
                  고정이라, 잡힌 일정이 겹침을 18:50 에서 끊으면 선이 거기서 멈췄다.
                  이제 포인터가 가리키는 분 좌표로 **구간을 매번 다시 고른다** — 빈칸
                  위에서는 가장 가까운 구간에 붙는다. 규칙과 그 근거는
                  `lib/overlay-layout.ts` 의 `pickDragTargetSegment` 머리말에 한 번만
                  적혀 있고, 가로 격자가 같은 함수를 쓴다.
                ★ 넘어간 뒤에도 `clampToSegmentY` 는 그대로다 — **구간 밖 시각은 여전히
                  고를 수 없다.** 겹침 밖은 그 사람들이 다 있다는 보장이 없어서, 그대로
                  등록하면 화면이 "가능하다"고 거짓말한 셈이 된다(§1.4).
                ★ 날짜는 바뀌지 않는다. 세로 격자는 하루 안이고 `dayWindows` 가 이미
                  그날치만 담고 있다.
              */
              const target =
                pickDragTargetSegment(dayWindows, raw) ?? selectedSegment;
              onSelectWindow(
                target.datum,
                kstMoment(
                  dayKey,
                  clampToSegmentY(raw, target.startMinute, target.endMinute),
                ),
              );
            }}
            onPointerUp={(event) => {
              setDraggingHead(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => setDraggingHead(false)}
            onClick={() => {
              /* 끌었으면 그 click 은 삼킨다 — 손을 떼자마자 모달이 덮으면 확인할 새가 없다. */
              if (movedHeadRef.current) {
                movedHeadRef.current = false;
                return;
              }
              onSelectWindow(
                selectedSegment.datum,
                kstMoment(dayKey, playheadMinute),
              );
              onOpenComposer();
            }}
          >
            {/*
              시각 라벨이 곧 손잡이다. 왼쪽 눈금 자리에 붙여 격자를 가리지 않는다.
              색은 primary 의 보색인 노랑(§ `--color-playhead`) — 이 격자가 primary
              계열로 뒤덮여 있어 같은 계열의 선은 묻힌다.
            */}
            <span className="relative z-10 shrink-0 rounded-sm bg-playhead px-1 py-px text-overline font-bold tabular-nums text-playhead-edge ring-2 ring-playhead-edge">
              {formatDayMinute(playheadMinute)}
            </span>
            {/* 보이는 선. 라벨 뒤로 이어져 격자를 가로지른다. */}
            <span
              aria-hidden
              className="h-[3px] min-w-0 flex-1 bg-playhead ring-1 ring-playhead-edge"
            />
          </div>
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
          {/*
            ── 빈칸 사유 ──────────────────────────────────────────────────────
            발주 보고(2026-08-31)가 나온 화면이 바로 여기다: *"세로 겹침 ui 기준 중간에
            빈칸이 있으면 바가 서로 연결이 안됨"*.

            ⚠️ **막대를 잇지 않았다.** 빈칸은 데이터가 진짜로 끊긴 자리라, 이으면 아무도
               갈 수 없는 시간이 갈 수 있는 시간으로 그려진다 — §1.4 가 금지한 거짓
               available 이다. 대신 **왜 끊겼는지**를 말한다. 근거와 세 경우의 그리는 법은
               `overlay-grid.tsx` 의 `OVERLAY_GAP_HATCH` 머리말에 한 번만 적혀 있고,
               두 화면이 그 규약과 계산(`buildOverlayGapMap`)을 그대로 공유한다.

            세로 배치라 `box.left → top`, `box.width → height` 로 읽는 것만 다르다.
            겹침 버튼 **앞에** 그려 버튼이 위로 올라오게 둔다.
          */}
          {dayGaps.map((gap) => {
            const box = toAxisBox(gap.startMinute, gap.endMinute, axis);
            const title = overlayGapTitle(gap);
            const badge = overlayGapBadge(gap, box.width);

            return (
              <span
                key={gap.key}
                role="img"
                aria-label={`${activeDay.label} ${title}`}
                title={title}
                style={{
                  top: `${box.left}%`,
                  height: `${box.width}%`,
                  ...(gap.cause === "booked" ? OVERLAY_GAP_HATCH : null),
                }}
                className={cn(
                  "absolute inset-x-0 flex items-center justify-center overflow-hidden rounded-sm",
                  // (a) 전원이 걸림 = 닫힌 상자. (b) 일부만 = 열린 빗금.
                  gap.cause === "booked" && gap.isFullyBlocked
                    ? "border border-secondary"
                    : null,
                )}
              >
                {badge === "" ? null : (
                  <span
                    aria-hidden
                    className="text-overline font-bold text-secondary tabular-nums"
                  >
                    {badge}
                  </span>
                )}
              </span>
            );
          })}

          {dayWindows.map((segment) => {
            const box = toAxisBox(segment.startMinute, segment.endMinute, axis);
            const key = overlapWindowKey(segment.datum);
            const selected = key === selectedWindowKey;
            return (
              <button
                key={segment.key}
                type="button"
                onClick={() => {
                  /*
                    ★ **선에 써 있는 시각이 그대로 들어간다**(발주 지시 2026-08-25:
                      *"겹침 부분을 클릭하면 그냥 바로 그 선에 써있던걸로 시간이
                      들어가는거지"* · *"반드시 그전에 막대에 써있는 시간이 들어가도록"*).

                      누른 자리의 시각을 쓰던 판을 되돌린 것이다. 폰에서는 손가락이
                      가리키는 자리와 사람이 정한 시각이 다르다 — 선을 21:00 으로
                      맞춰 놓고 밴드를 누르면 손가락이 닿은 19:40 이 들어갔다.
                      선이 곧 커서이므로, **커서가 말한 값**이 답이다.
                    ★ 다른 겹침을 눌렀는데 선의 시각이 그 안에 없으면 그 겹침 안으로
                      가둔다 — 그 시각에는 그 사람들이 다 있다는 보장이 없다.
                  */
                  onSelectWindow(
                    segment.datum,
                    kstMoment(
                      dayKey,
                      clampToSegmentY(
                        playheadMinute ?? segment.startMinute,
                        segment.startMinute,
                        segment.endMinute,
                      ),
                    ),
                  );
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
                  overlapToneClass(
                    segment.datum.availableCount,
                    members.length,
                  ),
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
