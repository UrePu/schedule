import { kstWeekdayKo } from "@/components/domain/kst-format";
import {
  DAY_MINUTES,
  addKstDays,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import type { TimeRange } from "@/types/domain";

/**
 * 겹쳐보기 시간표의 **좌표 계산**. 순수 함수만 두고 렌더는 컴포넌트가 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자정 넘김을 끊지 않기 위한 좌표계 (이 파일의 존재 이유)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 행 = 하루(목→수 7행), 가로축 = 그날 00:00 KST 로부터의 **분**.
 *
 * 핵심은 축을 1440 에서 끊지 않는다는 것이다. 22:00~02:00 구간은
 * `1320 → 1560` 이라는 **하나의 사각형**으로 그려지고, 축에는 `24:00`, `27:00`
 * 같은 눈금이 계속 이어진다. 하루를 24시간에서 자르면 이 구간은 두 행으로
 * 쪼개져 "밤 10시부터 새벽 2시까지"라는 한 덩어리가 화면에서 사라진다
 * (DB 가 굳이 `end_minute > 1440` 을 허용한 이유와 같다 — DB-SCHEMA §10-2).
 *
 * 구간은 **시작 시각이 속한 KST 날짜의 행**에 통째로 배치된다. 그래서 금요일 새벽
 * 02:00 까지 이어지는 구간은 "목요일 행의 오른쪽 끝"에 나타난다 — 사람들이
 * "목요일 밤"이라고 말하는 것과 같은 배치다.
 *
 * 축의 시작/끝은 **그 주에 실제로 등장하는 구간에 맞춰 좁힌다.** 아무도 새벽 4시에
 * 안 하는데 00:00~24:00 을 다 그리면 저녁 시간대가 눈금 몇 픽셀로 뭉갠다.
 */

/** 눈금 간격(분). 3시간마다 축 라벨을 찍는다. */
const TICK_MINUTES = 180;

/** 축이 아무리 좁아도 최소 이만큼은 보여 준다(6시간). */
const MIN_AXIS_SPAN = 360;

export interface DayRow {
  readonly dayKey: string;
  /** ISO 요일 1=월 … 7=일 */
  readonly isoWeekday: number;
  /** 예) `8/13 목` — aria-label·title 처럼 한 덩어리로 읽어야 할 때. */
  readonly label: string;
  /**
   * 예) `목` — **행에서 가장 먼저 읽혀야 하는 값**이다.
   * 스케줄 화면에서 사람은 "며칠"보다 "무슨 요일"로 먼저 생각한다.
   */
  readonly weekdayLabel: string;
  /** 예) `8/13` */
  readonly dateLabel: string;
  readonly isWeekend: boolean;
  /** 이 행의 00:00 KST 절대 시각. */
  readonly dayStart: Date;
}

/** 조회 구간을 하루짜리 행으로 자른다. 주간 범위면 목→수 7행이 나온다. */
export function buildDayRows(range: TimeRange): readonly DayRow[] {
  const rows: DayRow[] = [];
  const lastKey = kstDayKey(new Date(range.to.getTime() - 1));

  let cursor = kstMoment(kstDayKey(range.from), 0);
  for (let guard = 0; guard < 62; guard += 1) {
    const dayKey = kstDayKey(cursor);
    const isoWeekday = kstIsoWeekday(kstMoment(dayKey, 720));
    const weekdayLabel = kstWeekdayKo(cursor);
    const dateLabel = formatKst(cursor, "M/d");
    rows.push({
      dayKey,
      isoWeekday,
      label: `${dateLabel} ${weekdayLabel}`,
      weekdayLabel,
      dateLabel,
      isWeekend: isoWeekday === 6 || isoWeekday === 7,
      dayStart: cursor,
    });
    if (dayKey >= lastKey) break;
    cursor = addKstDays(cursor, 1);
  }

  return rows;
}

export interface RowSegment<T> {
  readonly key: string;
  readonly dayKey: string;
  /** 그날 00:00 KST 기준 분. **1440 을 넘을 수 있다**(자정 넘김). */
  readonly startMinute: number;
  readonly endMinute: number;
  readonly datum: T;
}

interface Instantish {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * 절대 시각 구간을 "시작 날짜 행 + 그날 00:00 기준 분" 좌표로 옮긴다.
 * 구간은 **쪼개지 않는다.** 자정을 넘으면 `endMinute` 가 1440 을 넘을 뿐이다.
 */
export function projectToDayRows<T extends Instantish>(
  items: readonly T[],
  dayKeys: ReadonlySet<string>,
  keyOf: (item: T, index: number) => string,
): readonly RowSegment<T>[] {
  const segments: Array<RowSegment<T>> = [];

  items.forEach((item, index) => {
    const dayKey = kstDayKey(item.startsAt);
    if (!dayKeys.has(dayKey)) return;

    segments.push({
      key: keyOf(item, index),
      dayKey,
      startMinute: minutesFromKstDay(item.startsAt, dayKey),
      endMinute: minutesFromKstDay(item.endsAt, dayKey),
      datum: item,
    });
  });

  return segments;
}

export interface OverlayAxis {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly ticks: readonly number[];
  /** 축이 24:00 을 넘는가 = 자정 넘김 구간이 존재하는가. */
  readonly hasOvernight: boolean;
}

/** 기본 축(18:00~24:00). 표시할 구간이 하나도 없을 때 쓴다. */
const FALLBACK_AXIS: OverlayAxis = {
  startMinute: 18 * 60,
  endMinute: DAY_MINUTES,
  ticks: [18 * 60, 21 * 60, DAY_MINUTES],
  hasOvernight: false,
};

/**
 * 실제로 그려질 구간들에 맞춰 가로축 범위를 정한다.
 *
 * 축은 **모든 행이 공유**한다. 행마다 축이 다르면 세로로 비교할 수 없고,
 * 겹침을 한눈에 본다는 목적 자체가 무너진다.
 */
export function computeOverlayAxis(
  segments: ReadonlyArray<{
    readonly startMinute: number;
    readonly endMinute: number;
  }>,
): OverlayAxis {
  if (segments.length === 0) return FALLBACK_AXIS;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    min = Math.min(min, segment.startMinute);
    max = Math.max(max, segment.endMinute);
  }

  let startMinute = Math.floor(min / TICK_MINUTES) * TICK_MINUTES;
  let endMinute = Math.ceil(max / TICK_MINUTES) * TICK_MINUTES;

  if (endMinute - startMinute < MIN_AXIS_SPAN) {
    endMinute = startMinute + MIN_AXIS_SPAN;
  }
  // 자정 넘김이 있으면 24:00 구분선이 축 안에 들어와야 의미가 산다.
  if (endMinute > DAY_MINUTES && startMinute > DAY_MINUTES - TICK_MINUTES) {
    startMinute = DAY_MINUTES - TICK_MINUTES;
  }

  const ticks: number[] = [];
  for (let m = startMinute; m <= endMinute; m += TICK_MINUTES) {
    ticks.push(m);
  }

  return {
    startMinute,
    endMinute,
    ticks,
    hasOvernight: endMinute > DAY_MINUTES,
  };
}

/** 분 좌표 → 축 위의 백분율(0~100). 축 밖은 잘라 낸다. */
export function toAxisPercent(minute: number, axis: OverlayAxis): number {
  const span = axis.endMinute - axis.startMinute;
  if (span <= 0) return 0;
  const ratio = (minute - axis.startMinute) / span;
  return Math.min(100, Math.max(0, ratio * 100));
}

/** 구간을 축 위의 `left` / `width` 백분율로. 너무 얇아 사라지지 않게 최소 폭을 준다. */
export function toAxisBox(
  startMinute: number,
  endMinute: number,
  axis: OverlayAxis,
): { readonly left: number; readonly width: number } {
  const left = toAxisPercent(startMinute, axis);
  const right = toAxisPercent(endMinute, axis);
  return { left, width: Math.max(right - left, 0.6) };
}
