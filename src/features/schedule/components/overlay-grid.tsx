"use client";

import { TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState, type PointerEvent } from "react";

import { Numeric, SeatNumber, formatKstShort } from "@/components/domain";
import {
  DAY_MINUTES,
  describeDayMinute,
  formatDayMinute,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { participantLabel } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  RunCommitment,
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 좁은 화면(360px) — **줄이지 않고 접는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 앱의 핵심(§1.4)이라 **정보를 잃는 축소는 금지**다. 예전에는 폭에 상관없이
 * `min-w-[48rem]`(768px) 를 걸고 가로 스크롤에 맡겼는데, 360px 기기에서 실제로 보이는
 * 부분은 전체의 **38%** 였다. 가로 스크롤은 "세로로 겹침을 읽는다"는 이 표의 작동
 * 원리와 정면으로 충돌한다 — 화면 밖에 있는 사람의 막대는 겹쳐 볼 수가 없다.
 *
 * 그래서 가로로 줄이는 대신 **가로로 쓰던 것을 세로로 접었다.** 바뀌는 것은 두 가지뿐이다.
 *   1. **날짜 거터가 행 위로 올라간다.** `목 8/20` 이 왼쪽 고정 열(w-16, 64px)이 아니라
 *      그 날 묶음의 머리글 한 줄이 된다 → 시간축에 64px 이 통째로 돌아온다.
 *   2. **이름 거터가 w-20 → w-14 로 좁아진다**(80px → 56px). 이름은 원래도
 *      `truncate` + `title` 이었으므로 표현 방식이 바뀌지 않는다.
 * 남는 시간축은 360px 기준 **234px**(= 296 − 56 − 6). 저녁 시간대(18:00~27:00)라면
 * 3시간 눈금이 78px 간격으로 찍혀 눈금 라벨이 겹치지 않는다.
 *
 * ★ **행·레인·축·겹침밴드·예외 블록 중 사라지는 것은 하나도 없다.** 요일 × 시각 격자와
 *   "세로로 몇 개가 겹치는가"라는 읽기 방식이 그대로 유지된다. 접는 것과 지우는 것은
 *   다르며, 여기서 한 것은 접는 쪽이다.
 * ★ `md`(768px) 이상에서는 예전 동작이 **그대로**다 — `min-w-[48rem]` 과 가로 스크롤이
 *   다시 붙는다. 2단 레이아웃의 왼쪽 칸은 1024px 화면에서도 768px 이 안 되기 때문이다.
 */

/*
 * 레인 트랙의 좌측 여백(= 이름 거터 폭 + `gap-1.5`)은 **폭에 따라 달라진다.**
 *   좁은 폭: `w-14`(3.5rem) + 0.375rem = 3.875rem
 *   md 이상: `w-20`(5rem)   + 0.375rem = 5.375rem
 * 눈금 세로선(`AxisRules`)은 절대 배치라 이 값을 인라인 style 로 알아야 하는데,
 * 인라인 style 에는 미디어 쿼리를 쓸 수 없다. 그래서 값을 **CSS 변수**
 * `--lane-gutter` 로 내려 준다 — 변수는 상속되므로 브레이크포인트마다 한 번만
 * 선언하면 되고, 거터 폭과 눈금선이 갈라질 수 없다.
 */

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
  /**
   * **이미 등록된 보스 일정이 잡아먹은 시간.**
   *
   * ★ 겹침 밴드(`overlapWindows`)에서는 이 구간이 **이미 빠져 있다**(DB
   *   `availability_overlap` 이 뺀다). 그런데 개인 레인의 막대는 여전히 전체를 그리므로,
   *   이 블록을 겹쳐 그리지 않으면 "막대는 가능이라는데 겹침은 왜 없지?" 가 된다.
   *   조용히 줄어드는 것이 가장 나쁜 경우라, **무엇이 막았는지를 이름과 함께** 보인다.
   * ★ 제외(특이사항) 블록과 같은 레이어 방식이지만 **색이 다르다** — 제외는 tertiary
   *   점선(사람이 안 된다고 말한 시간), 이것은 secondary 실선(이미 쓰기로 한 시간).
   *   둘은 원인이 다르고 사용자가 할 일도 다르다(패턴 수정 vs 일정 수정).
   */
  readonly commitments: readonly RunCommitment[];
  readonly selectedWindowKey: string | null;
  /**
   * 겹침을 골랐다. **`startsAt` 이 오면 그 시각**, 없으면 겹침의 시작 시각이다.
   *
   * 두 번째 인자가 생긴 이유는 드래그다(위 `DRAG_STEP_MINUTES` 머리말) — 넓은 겹침
   * 안에서 시작점을 옮길 수 있어야 하고, 그 값은 겹침 자체가 아니라 **포인터 위치**에서
   * 나온다. 클릭은 여전히 인자 없이 부른다.
   */
  readonly onSelectWindow: (window: OverlapWindow, startsAt?: Date) => void;
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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 겹침 막대 드래그 — **시작 시각을 그 자리에서 미세 조정한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"겹침 에서 누르는곳 있잖아. 거기 마우스 올리고 드래그하면 시간을
 * 세세하게 오른쪽으로 넘길수있게 해줘."*
 *
 * 그전에는 막대를 누르면 **언제나 그 겹침의 시작 시각**이 등록 폼에 들어갔다. 21:00~24:00
 * 처럼 넓은 겹침에서 22시에 시작하고 싶으면 폼의 시각 칸을 손으로 고쳐야 했다.
 *
 * ★ **클릭 동작은 그대로 둔다.** 눌렀다 떼면 예전처럼 겹침의 시작 시각이다. 드래그로
 *   실제로 움직였을 때만 그 지점의 시각을 쓴다 — 익숙한 조작을 바꾸지 않으면서 새 조작을
 *   더한다. (드래그 뒤에 따라오는 `click` 은 아래 `movedRef` 가 한 번 삼킨다.)
 * ★ 10분 단위로 스냅한다. 분 단위로 붙으면 21:07 같은 값이 나오고, 보스 일정에서 그
 *   정밀도는 의미가 없다.
 */
const DRAG_STEP_MINUTES = 10;

/**
 * 포인터 위치 → 축 위의 분 좌표.
 *
 * 기준은 막대 자신이 아니라 **레인 전체**(막대의 부모)다. 막대는 겹침 구간만큼만
 * 차지하므로 그 안에서 비율을 재면 축이 아니라 그 구간의 비율이 나온다.
 * 레인을 못 찾으면 `null` — 조용히 0분으로 접으면 엉뚱한 시각이 등록 폼에 들어간다.
 */
function pointerMinute(
  event: PointerEvent<HTMLButtonElement>,
  axis: OverlayAxis,
): number | null {
  const lane = event.currentTarget.parentElement;
  if (lane === null) return null;
  const rect = lane.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const ratio = (event.clientX - rect.left) / rect.width;
  return axis.startMinute + ratio * (axis.endMinute - axis.startMinute);
}

/** 10분 단위로 스냅하고 겹침 구간 안으로 가둔다. */
function clampToSegment(
  minute: number,
  startMinute: number,
  endMinute: number,
): number {
  const snapped = Math.round(minute / DRAG_STEP_MINUTES) * DRAG_STEP_MINUTES;
  /*
    끝 시각 자체는 시작점이 될 수 없다 — 길이 0 짜리 일정이 된다. 한 칸 앞을 상한으로
    두되, 겹침이 한 칸보다 짧으면 시작점은 그 구간의 시작 하나뿐이다.
  */
  const last = Math.max(startMinute, endMinute - DRAG_STEP_MINUTES);
  return Math.min(Math.max(snapped, startMinute), last);
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
            /*
              ★ 타임테이블 눈금(`21:00`). 가로축에 일정 간격으로 찍히므로 자릿수 폭이
                제각각이면 눈금이 중심에서 흔들린다. `formatDayMinute` 는 ASCII 전용
                (`HH:mm`)이라 통째로 등폭이어도 한글이 섞이지 않는다.
                `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
            */
            /*
              좁은 폭에서는 12px 로 내려간다. 축이 넓어지면 눈금이 7개까지 늘어나는데,
              234px 짜리 레인에서 14px `HH:mm`(~42px)은 서로 겹친다. 12px 은 §4 가
              **수치 주석**에 허용한 크기이고, 이것은 문장이 아니라 눈금이다.
            */
            "font-mono absolute top-0 -translate-x-1/2 text-caption font-medium tabular-nums whitespace-nowrap md:text-body-sm",
            // 익일 눈금도 읽는 글자니 `tertiary-ink` — 12px 라 큰 텍스트 예외가 없고,
            // 면용 `tertiary` 로는 background 대비 3.77:1 로 AA 미달이었다.
            tick >= DAY_MINUTES ? "text-tertiary-ink" : "text-ink-label",
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
      style={{ left: "var(--lane-gutter)" }}
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
  commitments,
  selectedWindowKey,
  onSelectWindow,
}: OverlayGridProps) {
  /**
   * 지금 드래그 중인 막대의 키. `null` 이면 드래그가 아니다.
   * `movedRef` 는 **실제로 움직였는가** 를 기억해, 드래그 뒤 따라오는 `click` 이 시작
   * 시각으로 되돌려 놓는 것을 막는다(포인터를 떼면 브라우저가 click 을 한 번 더 쏜다).
   */
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /**
   * 커서 옆에 띄우는 시각 표시.
   *
   * 처음에는 **드래그 중에만** 떴다 (2026-08-19 발주자: *"클릭후 드래그할때 마우스쪽에
   * 팝업? 으로 몇시인지를 보여줘야 하고"*). 2026-08-20 에 **가리키기만 해도** 뜨도록
   * 넓혔다 (*"겹침 호버링시 시간이 추가정보로 나와야 되는데 클릭한채로 말고"*).
   *
   * 왜 그게 맞는가: 이 표시가 답하는 질문은 *"여기를 누르면 몇 시가 되는가"* 이고, 그건
   * **누르기 전에** 알아야 쓸모가 있다. 누른 뒤에만 보여 주면 사용자는 일단 눌러 보고
   * 확인한 다음 취소하거나 끌어서 고쳐야 했다 — 미리 보기가 미리 보이지 않았던 셈이다.
   *
   * 좌표는 **뷰포트 기준**(`position: fixed`)이다. 막대 안에 넣으면 폭이 좁을 때 잘리고
   * 격자가 밀릴 때 함께 밀린다 — 커서를 따라다니는 표시는 커서와 같은 좌표계에 둔다.
   */
  const [dragHint, setDragHint] = useState<{
    readonly x: number;
    readonly y: number;
    readonly text: string;
  } | null>(null);
  const movedRef = useRef(false);

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

  /**
   * 이미 잡힌 일정 블록. 같은 사람이 같은 시각에 두 파티의 런에 걸려 있을 수 있으므로
   * (그 자체가 사용자가 봐야 할 사실이다) 키에 `runId` 를 함께 넣는다.
   */
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
    축은 개인 구간과 겹침 창을 **모두** 담아야 한다. 어느 한쪽이라도 잘리면 거짓말이 된다.
    제외 블록은 축을 정의하지 않는다 — 하루 전체 제외가 축을 00:00~24:00 로 벌리기 때문이다.

    ★ 잡힌 일정(`commitmentSegments`)은 **축을 정의한다.** 가능 시간 밖에 잡아 둔 런이
      실제로 있을 수 있고(패턴을 나중에 줄인 경우), 그것이 축 밖으로 밀려나면 화면에서
      사라진다 — 겹침이 왜 없는지 말해 주려고 만든 블록이 정작 안 보이게 된다.
      제외와 달리 이 구간은 사용자가 **직접 만든 짧은 구간**이라 축을 하루로 벌리지 않는다.
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

  const total = members.length;

  return (
    <div className="overflow-x-auto">
      {/* 모바일에서 눈금·이름이 뭉개지지 않도록 최소 폭을 주고 가로 스크롤한다. */}
      <div className="[--lane-gutter:3.875rem] md:min-w-[48rem] md:[--lane-gutter:5.375rem]">
        {/* 축 눈금 */}
        <div className="flex items-end gap-2 pb-1">
          {/* 날짜 거터 자리. 좁은 폭에서는 날짜가 행 위로 올라가므로 이 칸이 없다. */}
          <div className="hidden w-16 shrink-0 md:block" />
          <div className="flex min-w-0 flex-1 gap-1.5">
            <span className="w-14 shrink-0 md:w-20" />
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
                "flex flex-col gap-1 border-t border-border py-2.5 md:flex-row md:gap-2",
                row.isWeekend && "bg-neutral-50",
              )}
            >
              {/* 날짜 거터 — 요일이 가장 먼저 읽혀야 한다. */}
              <div className="flex shrink-0 items-baseline gap-1.5 md:w-16 md:flex-col md:items-start md:gap-0 md:pt-0.5">
                <p className="flex items-center gap-1 whitespace-nowrap">
                  <span
                    className={cn(
                      "text-body-lg font-bold",
                      // 주말 강조는 글자니 `tertiary-ink` — 면용 `tertiary` 는 라이트에서 3.77:1 로 AA 미달.
                      row.isWeekend ? "text-tertiary-ink" : "text-ink",
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
                {/*
                  요일 레인의 날짜(`8/20`). 요일 행이 세로로 쌓이는 좌측 고정 열이라
                  `8/2` 와 `8/20` 의 폭이 다르면 열이 들쭉날쭉해진다. `dateLabel` 은
                  `M/d` 라 ASCII 전용이다(요일 한글은 바로 위 `weekdayLabel` 이 맡는다).
                */}
                <p className="text-body-sm text-ink-label tabular-nums whitespace-nowrap">
                  <Numeric>{row.dateLabel}</Numeric>
                </p>
              </div>

              {/* 레인 영역 */}
              <div className="relative min-w-0 flex-1">
                <AxisRules axis={axis} />

                {/* 겹침 밴드 — 이 화면의 답이 여기 있다. */}
                <div className="relative flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="w-14 shrink-0 text-right text-caption font-semibold text-ink-label md:w-20"
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
                          onClick={() => {
                            /*
                              드래그로 이미 시각을 정했으면 이 click 은 삼킨다 — 안 그러면
                              손을 떼는 순간 겹침 시작 시각으로 되돌아간다.
                            */
                            if (movedRef.current) {
                              movedRef.current = false;
                              return;
                            }
                            onSelectWindow(window);
                          }}
                          onPointerDown={(event) => {
                            movedRef.current = false;
                            setDraggingKey(key);
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                          }}
                          onPointerMove={(event) => {
                            const minute = pointerMinute(event, axis);
                            if (minute === null) return;
                            /*
                              겹침 **안쪽**으로만 붙인다. 밖으로 나간 시각은 그 자리에
                              사람이 다 있다는 보장이 없어서, 그대로 등록하면 화면이
                              "가능하다"고 거짓말한 셈이 된다.
                            */
                            const snapped = clampToSegment(
                              minute,
                              segment.startMinute,
                              segment.endMinute,
                            );
                            /*
                              `26:00` 처럼 24 를 넘겨 적는다(`describeDayMinute`) — 자정을
                              넘긴 시각을 `02:00` 으로 되돌리면 어느 날인지 사라진다.
                            */
                            const hint = {
                              x: event.clientX,
                              y: event.clientY,
                              text: describeDayMinute(snapped),
                            };

                            if (draggingKey === key) {
                              setDragHint(hint);
                              /*
                                ★ `movedRef` 는 **드래그일 때만** 세운다. 가리키기만 한
                                  것으로 세우면 뒤따르는 `click` 이 삼켜져 한 번 눌러도
                                  선택이 안 된다.
                              */
                              movedRef.current = true;
                              onSelectWindow(
                                window,
                                kstMoment(row.dayKey, snapped),
                              );
                              return;
                            }

                            /*
                              ★ 끌지 않아도 **가리키는 자리의 시각**을 보여 준다.
                                마우스에서만 한다 — 터치·펜에는 "가리키기"가 없고, 손가락을
                                댄 순간은 이미 드래그라 위 분기가 맡는다.
                              ★ 상태만 바꾸고 선택은 건드리지 않는다. 가리켰다고 등록 폼의
                                시각이 바뀌면 마우스가 스쳐 지나가기만 해도 값이 흔들린다.
                            */
                            if (event.pointerType !== "mouse") return;
                            setDragHint(hint);
                          }}
                          onPointerLeave={() => {
                            // 드래그 중이면 포인터 캡처로 계속 따라오므로 지우지 않는다.
                            if (draggingKey === key) return;
                            setDragHint(null);
                          }}
                          onPointerUp={(event) => {
                            event.currentTarget.releasePointerCapture(
                              event.pointerId,
                            );
                            setDraggingKey(null);
                            setDragHint(null);
                          }}
                          onPointerCancel={() => {
                            setDraggingKey(null);
                            setDragHint(null);
                          }}
                          aria-pressed={selectedWindowKey === key}
                          aria-label={`${label} · ${window.availableCount}명 가능. 누르면 이 시간대로 일정 등록, 좌우로 끌면 시작 시각 조정`}
                          title={`${label} · ${window.availableCount}명 가능
누르면 시작 시각, 좌우로 끌면 ${DRAG_STEP_MINUTES}분 단위로 조정`}
                          style={{
                            left: `${box.left}%`,
                            width: `${box.width}%`,
                            /*
                              세로 스크롤은 살리고 가로 끌기만 우리가 가져간다. `none` 으로
                              막으면 모바일에서 막대 위에서 시작한 페이지 스크롤이 죽는다.
                            */
                            touchAction: "pan-y",
                          }}
                          className={cn(
                            "absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-sm",
                            /*
                              ★ `cursor-ew-resize` 였다(발주 지적 2026-08-20: *"커서도 그냥
                                포인터로 변경"*). 좌우 화살표 커서는 **크기 조절 손잡이**를
                                뜻하는 관용이라 "이 막대의 폭을 늘린다"로 읽힌다. 실제로 하는
                                일은 **누르면 그 시각이 선택되는 것**이고, 끌기는 그 위에
                                얹힌 미세 조정이다. 주된 동작이 클릭이면 커서도 클릭을
                                가리켜야 한다.
                            */
                            "cursor-pointer text-body-sm font-bold tabular-nums whitespace-nowrap transition duration-200",
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
                    const personCommitments = commitmentSegments.filter(
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
                    /*
                      `더저(메검메)` — 부캐로 참여 중이면 그 사실이 왼쪽 이름에도 보여야
                      한다. 조합 규칙은 `lib/domain/participant-label.ts` 가 소유한다.
                      한 줄 텍스트(툴팁·`aria-label`)에는 합쳐진 문자열을 쓴다.
                    */
                    /*
                      "이미 일정 있음"도 한 줄 설명에 넣는다. 화면 읽어 주기(`aria-label`)
                      만 쓰는 사람에게 이 정보가 빠지면, 왜 겹침이 없는지 알 길이 없다.
                    */
                    const bookedText =
                      personCommitments.length === 0
                        ? ""
                        : ` · 이미 일정 ${personCommitments
                            .map(
                              (segment) =>
                                `${segment.datum.shortName} ${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ")}`;
                    const label = participantLabel(member);
                    const description = `${label} · ${availableText}${excludedText}${bookedText}`;

                    return (
                      <div
                        key={member.personId}
                        className="flex items-center gap-1.5"
                      >
                        <span className="flex w-14 shrink-0 items-center gap-1 overflow-hidden md:w-20">
                          <SeatNumber
                            seatNo={member.seatNo}
                            size="sm"
                            tone="muted"
                          />
                          <span
                            title={label}
                            className="truncate text-body-sm text-ink-label"
                          >
                            {label}
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
                                title={`${label} · ${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)}${
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
                                title={`${label} · ${
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

                          {/*
                            이미 등록된 일정 — **겹침에서 빠진 이유**가 여기 보인다.
                            제외 블록보다 뒤에 그려 위로 올라오게 둔다. 둘이 겹치는 경우
                            (제외한 시간에 잡힌 런)는 그 자체가 이상 신호라 더 강한 쪽이
                            보여야 한다.
                          */}
                          {personCommitments.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );

                            return (
                              <span
                                key={segment.key}
                                title={`${label} · ${segment.datum.shortName} ${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)} · 이미 일정 있음`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm bg-secondary"
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

      {/*
        ── 드래그 중 시각 표시 (2026-08-19 발주자) ─────────────────────────────
        *"클릭후 드래그할때 마우스쪽에 팝업? 으로 몇시인지를 보여줘야 하고"*

        커서 **위쪽**에 띄운다 — 아래에 두면 손가락(모바일)이나 커서 자신이 가린다.
        `pointer-events-none` 이라 이 표시가 드래그를 가로채지 않는다.
        `aria-hidden` 인 이유: 같은 사실을 등록 폼의 시각 칸이 이미 **값으로** 들고 있고,
        드래그는 포인터 조작이라 스크린 리더 사용자에게는 이 표시가 도달하지 않는다.
      */}
      {dragHint === null ? null : (
        <div
          aria-hidden
          style={{ left: dragHint.x, top: dragHint.y - 12 }}
          className={cn(
            "pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full",
            "rounded-md border border-border-strong bg-surface px-2 py-1 shadow-medium",
            "text-body-sm font-semibold text-ink tabular-nums",
          )}
        >
          {dragHint.text}
        </div>
      )}
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
        <span aria-hidden className="size-3 rounded-sm bg-overlap-4" />
        전원 {total}명
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
      {/*
        ★ 겹침 계산에서 **빠진** 시간. 색만으로 말하지 않도록 글자를 함께 둔다 —
          이 항목이 없으면 사용자는 겹침이 줄어든 이유를 알 방법이 없다.
      */}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-secondary" />
        이미 일정 있음(겹침에서 제외)
      </span>
      {hasOvernight ? (
        /*
          §4: 주황은 **보더가 지고 문장은 잉크**다. 예전에는 범례 문장 자체가
          `text-tertiary` 였고 라이트에서 3.77:1 로 AA 미달이었다. 옆 범례들과도
          글자색이 달라 일관성이 없었다 — 이제 부모의 `ink-label` 을 따른다.
        */
        <span className="inline-flex items-center gap-1.5">
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
