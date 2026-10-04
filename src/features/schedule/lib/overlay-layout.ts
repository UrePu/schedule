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

/**
 * `toAxisPercent` 의 **역함수** — 축 위의 비율(0~1) → 그 자리의 분, `slotMinutes` 로 끊어 맞춤.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-10-04 — 왜 컴포넌트에서 여기로 내려왔나
 * ─────────────────────────────────────────────────────────────────────────────
 * 투영식이 **두 곳에서 필요해졌다.** 빈 칸을 *눌렀을* 때(등록 시각)와 빈 칸에 마우스를
 * *올렸을* 때(호버 라벨)가 같은 값을 말해야 하기 때문이다 — 라벨이 `21:10` 이라고 띄우고
 * 누르면 `21:00` 이 잡히면 화면이 거짓말을 한다. 그래서 식을 한 벌만 두고 둘이 함께
 * 부른다. 이 모듈의 머리말이 적어 둔 "좌표 투영" 책임에 그대로 들어간다.
 *
 * 비율은 **클램프하지 않고 받는다.** 축 밖(음수·1 초과)으로 들어와도 반환값이
 * `[startMinute, 마지막 칸]` 으로 묶이므로, 커서가 격자를 살짝 벗어난 프레임에서도
 * 값이 튀지 않는다.
 *
 * ★ 끝에서 한 칸을 빼는 이유: 축의 맨 끝(24:30)에 잡으면 블록이 격자 밖에서 시작한다.
 * ⚠️ **상한도 칸에 맞춰 내림한다.** 축 끝이 24:30 이라 그냥 한 칸을 빼면 `24:20` 이
 *    아닌 `24:25` 같은 값이 나올 수 있는데(축 끝이 칸의 배수가 아닐 때), 그건 격자 위의
 *    시각이 아니다 — 맨 아래 몇 px 을 눌렀을 때만 나오는 값이라 눈에 잘 안 띄고,
 *    그래서 더 오래 살아남는 종류의 어긋남이다.
 */
export function snapAxisMinute(
  ratio: number,
  axis: OverlayAxis,
  slotMinutes: number,
): number {
  const span = axis.endMinute - axis.startMinute;
  /*
    ⚠️ `NaN` 을 그냥 통과시키면 `kstMoment(day, NaN)` 이 Invalid Date 가 되어 등록 창이
       `Invalid Date 시작` 을 띄운다. 비율은 `(clientY - top) / height` 로 만들어지므로
       높이가 0인 프레임(아직 레이아웃 전)에서 실제로 나올 수 있는 값이다.
  */
  if (span <= 0 || slotMinutes <= 0 || !Number.isFinite(ratio)) {
    return axis.startMinute;
  }

  const raw = axis.startMinute + ratio * span;
  const snapped = Math.floor(raw / slotMinutes) * slotMinutes;
  const lastSlot =
    Math.floor((axis.endMinute - slotMinutes) / slotMinutes) * slotMinutes;
  return Math.min(Math.max(snapped, axis.startMinute), lastSlot);
}
