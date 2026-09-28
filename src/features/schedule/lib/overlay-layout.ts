import { kstWeekdayKo } from "@/components/domain/kst-format";
import {
  addKstDays,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import type { TimeRange } from "@/types/domain";

/**
 * 주간 시간표의 **좌표 계산**. 순수 함수만 두고 렌더는 컴포넌트가 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자정 넘김을 끊지 않기 위한 좌표계 (이 파일의 존재 이유)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 칸 = 하루(목→수 7칸), 축 = 그날 00:00 KST 로부터의 **분**.
 *
 * 핵심은 축을 1440 에서 끊지 않는다는 것이다. 22:00~02:00 구간은 `1320 → 1560` 이라는
 * **하나의 사각형**으로 그려지고, 축에는 `24:00`, `27:00` 같은 눈금이 계속 이어진다.
 * 하루를 24시간에서 자르면 이 구간은 두 칸으로 쪼개져 "밤 10시부터 새벽 2시까지"라는
 * 한 덩어리가 화면에서 사라진다(DB 가 굳이 `end_minute > 1440` 을 허용한 이유와 같다 —
 * DB-SCHEMA §10-2).
 *
 * 구간은 **시작 시각이 속한 KST 날짜의 칸**에 통째로 배치된다. 그래서 금요일 새벽
 * 02:00 까지 이어지는 구간은 "목요일 칸의 아래 끝"에 나타난다 — 사람들이 "목요일 밤"
 * 이라고 말하는 것과 같은 배치다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-09-28 — **축을 데이터에 맞춰 좁히던 계산이 전부 없어졌다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `computeOverlayAxis` · `computeScopedOverlayAxis` · `axisOverflowOf` · `toAxisBox` ·
 * `pickDragTargetSegment` · `buildOverlayGapMap` 은 전부 **겹쳐보기 격자 전용**이었고,
 * 그 화면이 삭제되면서 부르는 곳이 사라졌다.
 *
 * 남은 소비자(주간 일정표 `/` · `/boss-plans` 의 일정 모달)는 축을 **고정**으로 쓴다
 * (18:00~24:30, `week-timetable.tsx`). 그 화면의 목적이 "주마다 같은 자리에 같은 시간"
 * 이라 데이터를 따라 축이 움직이면 오히려 손해이기 때문이다 — 새벽 4시 일정 하나 때문에
 * 저녁 시간대가 통째로 사라지던 것이 그 화면이 고정 축으로 바꾼 이유였다.
 *
 * 그래서 남는 것은 **칸 만들기 · 좌표 투영 · 백분율 환산** 셋뿐이다.
 */

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

/** 분 좌표 → 축 위의 백분율(0~100). 축 밖은 잘라 낸다. */
export function toAxisPercent(minute: number, axis: OverlayAxis): number {
  const span = axis.endMinute - axis.startMinute;
  if (span <= 0) return 0;
  const ratio = (minute - axis.startMinute) / span;
  return Math.min(100, Math.max(0, ratio * 100));
}
