import { DAY_MINUTES, describeDayMinute } from "@/lib/time/kst-wallclock";
import type {
  AvailabilityPattern,
  AvailabilityPatternInput,
  IsoWeekday,
} from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 격자(칠하기) ↔ 반복 패턴 행 변환 — **순수 함수만** 둔다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 "요일 × 30분 칸"을 칠하고, DB 는 `(weekday, start_minute, end_minute)` 행을
 * 저장한다. 그 사이를 잇는 규칙이 여기 한 곳에만 있어야 저장·복원이 왕복에서 어긋나지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 자정을 넘겨도 **한 줄이다** (CLAUDE.md §1.4 · DB-SCHEMA §10-2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 격자의 세로축을 **24:00 에서 끊지 않는다.** 한 요일 열은 `00:00 ~ 30:00`
 * (= 익일 06:00) 까지 60칸이며, 수요일 22:00 에서 익일 02:00 까지 이어 칠하면
 * `{weekday: 3, start: 1320, end: 1560}` **한 줄**이 나온다.
 * 24:00 에서 끊으면 사용자의 한 덩어리 의도가 두 줄로 쪼개지고, 화면에 되돌려 줄 때
 * 다시 합쳐야 한다 — 그 합치기는 반드시 어딘가에서 틀린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 열은 **요일이거나 교대 주기 칸**이다 (2026-08-20 · 마이그레이션 33)
 * ─────────────────────────────────────────────────────────────────────────────
 * 교대 근무는 요일이 아니라 N일 주기로 돈다. 격자 자체는 두 경우에 완전히 같은 모양이라
 * (열 × 30분 칸), 이 모듈은 열을 **번호**로만 다루고 그 번호의 뜻은 `PatternAxis` 가 쥔다.
 *   · 요일축  — 열 번호 = ISO 요일 1…7, 자정 넘김은 다음 요일로
 *   · 주기축  — 열 번호 = 주기 칸 0…N-1, 자정 넘김은 다음 칸으로(마지막 칸은 0번으로 돈다)
 * 두 축을 한 함수로 처리하지 않으면 "주기에서만 자정 넘김이 틀리는" 버그가 반드시 난다.
 *
 * 축의 끝을 30:00 으로 잡은 이유: DB 의 `end_minute` 상한은 2880(익일 24:00)이지만,
 * 실제로 사람이 "그날 밤"이라고 부르는 범위는 익일 새벽까지다. 60칸이면 세로 스크롤이
 * 감당 가능하고, 그보다 긴 구간(예: 12:00~익일 08:00)은 격자로 표현하지 않고
 * **손대지 않고 보존**한다(`splitByGridFit`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 24:00 이후에서 시작하는 칠은 **다음 요일로 정규화한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 수요일 열의 24:00~26:00 만 칠하면 그것은 사실 **목요일 00:00~02:00** 이다.
 * DB CHECK 도 `start_minute <= 1439` 라 그대로 저장할 수 없다. 그래서 요일을 한 칸
 * 밀고 1440 을 빼서 저장한다 — 표현이 바뀔 뿐 가리키는 순간은 완전히 같다.
 */

/** 격자 한 칸 = 30분. 이 값이 곧 저장 해상도다. */
export const SLOT_MINUTES = 30;

/** 격자 세로축의 끝(분). 1800 = 30:00 = 익일 06:00. */
export const GRID_END_MINUTE = 1800;

/** 한 요일 열의 칸 수(60). */
export const SLOT_COUNT = GRID_END_MINUTE / SLOT_MINUTES;

/** 24:00 경계에 해당하는 칸 번호(48). 이 칸부터는 **익일**이다. */
export const MIDNIGHT_SLOT = DAY_MINUTES / SLOT_MINUTES;

/** 한 구간이 넘을 수 없는 길이(분). DB `availability_patterns_max_span` 과 같은 값. */
export const MAX_SPAN_MINUTES = DAY_MINUTES;

/**
 * 저장 가능한 패턴 줄 수 상한. 60칸을 한 칸 걸러 칠하면 열당 30줄이 최대다.
 * 열은 요일 7개이거나 주기 칸 최대 28개(`availability_cycles.cycle_days` 상한)다.
 */
export const MAX_CYCLE_DAYS = 28;
export const MAX_PATTERN_ROWS = MAX_CYCLE_DAYS * 30;

// ─────────────────────────────────────────────────────────────────────────────
// 축 — 열 번호의 뜻
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 격자의 열이 무엇인지. **이 모듈 밖에서 열 번호를 해석하지 말 것** — 요일축은 1부터,
 * 주기축은 0부터라 한 군데서만 다뤄야 off-by-one 이 안 생긴다.
 */
export interface PatternAxis {
  readonly kind: "weekday" | "cycle";
  /** 열 개수. 요일축 7, 주기축 cycleDays. */
  readonly size: number;
}

export const WEEKDAY_AXIS: PatternAxis = { kind: "weekday", size: 7 };

export function cycleAxis(cycleDays: number): PatternAxis {
  return { kind: "cycle", size: cycleDays };
}

/** 이 패턴 줄이 붙어 있는 열 번호. 축이 어느 쪽이든 하나만 채워져 있다. */
export function patternColumn(pattern: AvailabilityPatternInput): number {
  return pattern.weekday ?? pattern.cycleDay ?? 0;
}

/** 열 번호 + 시각 → 저장할 패턴 줄. 축에 맞는 필드만 채우고 나머지는 `null` 이다. */
export function columnToPattern(
  axis: PatternAxis,
  column: number,
  startMinute: number,
  endMinute: number,
): AvailabilityPatternInput {
  return axis.kind === "weekday"
    ? { weekday: column as IsoWeekday, cycleDay: null, startMinute, endMinute }
    : { weekday: null, cycleDay: column, startMinute, endMinute };
}

/** 자정을 넘긴 칠이 넘어갈 다음 열. 요일축은 1~7 을, 주기축은 0~N-1 을 순환한다. */
function nextColumn(axis: PatternAxis, column: number): number {
  return axis.kind === "weekday"
    ? (column % 7) + 1
    : (column + 1) % Math.max(axis.size, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 칸 키
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 칸 하나의 키. `"3:44"` = 수요일(ISO 3) 22:00 칸.
 *
 * 배열 인덱스가 아니라 **ISO 요일 번호**를 쓴다. 표시 순서는 주간 초기화(목요일)에 맞춰
 * 회전하지만 데이터의 요일 번호는 회전하면 안 되기 때문이다.
 */
export function slotKey(weekday: number, slot: number): string {
  return `${weekday}:${slot}`;
}

/** 칸 번호 → 그 칸이 시작하는 분. */
export function slotStartMinute(slot: number): number {
  return slot * SLOT_MINUTES;
}

/** 칸 번호 → 사람이 읽는 시각(`22:00` · `익일 02:00`). */
export function slotLabel(slot: number): string {
  return describeDayMinute(slotStartMinute(slot));
}

/** 분 → 그 분을 포함하는 칸 번호(내림). */
export function minuteToSlot(minute: number): number {
  return Math.floor(minute / SLOT_MINUTES);
}

// ─────────────────────────────────────────────────────────────────────────────
// 패턴 → 칸
// ─────────────────────────────────────────────────────────────────────────────

/** 이 구간을 격자 위에 **손실 없이** 그릴 수 있는가. */
export function fitsGrid(interval: AvailabilityPatternInput): boolean {
  return (
    interval.startMinute >= 0 &&
    interval.endMinute > interval.startMinute &&
    interval.endMinute <= GRID_END_MINUTE &&
    interval.startMinute % SLOT_MINUTES === 0 &&
    interval.endMinute % SLOT_MINUTES === 0
  );
}

/**
 * 저장된 패턴을 **격자에 그릴 것**과 **격자 밖이라 손대지 않을 것**으로 가른다.
 *
 * ★ 격자 밖 구간을 조용히 잘라 저장하면 사용자가 등록한 적 없는 축소가 일어난다.
 *   30분 격자에 맞지 않거나(예: 21:10 시작) 30:00 을 넘는 구간은 **그대로 보존**하고,
 *   화면은 "이 화면에서는 편집할 수 없는 구간"으로 따로 보여 준다.
 */
export function splitByGridFit(patterns: readonly AvailabilityPattern[]): {
  readonly editable: readonly AvailabilityPattern[];
  readonly preserved: readonly AvailabilityPattern[];
} {
  const editable: AvailabilityPattern[] = [];
  const preserved: AvailabilityPattern[] = [];
  for (const pattern of patterns) {
    (fitsGrid(pattern) ? editable : preserved).push(pattern);
  }
  return { editable, preserved };
}

/** 패턴 목록 → 칠해진 칸 집합. 격자 밖으로 나가는 부분은 잘라 낸다. */
export function patternsToSlots(
  patterns: readonly AvailabilityPatternInput[],
): ReadonlySet<string> {
  const slots = new Set<string>();
  for (const pattern of patterns) {
    const first = Math.max(0, minuteToSlot(pattern.startMinute));
    const last = Math.min(SLOT_COUNT, Math.ceil(pattern.endMinute / SLOT_MINUTES));
    for (let slot = first; slot < last; slot += 1) {
      slots.add(slotKey(patternColumn(pattern), slot));
    }
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// 칸 → 패턴
// ─────────────────────────────────────────────────────────────────────────────

interface MutableInterval {
  column: number;
  startMinute: number;
  endMinute: number;
}

/** 한 열 안에서 겹치거나 맞닿은 구간을 합친다. 합칠 수 있는 것을 두 줄로 두지 않는다. */
function mergeWithinColumn(intervals: readonly MutableInterval[]): MutableInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMinute - b.startMinute);
  const merged: MutableInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, interval.endMinute);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

/**
 * 칠해진 칸 → 저장할 패턴 줄.
 *
 * 1. 요일별로 **연속된 칸을 하나의 구간으로 합친다** — 그래서 22:00~02:00 이 한 줄이 된다.
 * 2. 24:00(=1440) 이후에서 시작하는 구간은 **다음 요일로 옮긴다.** 가리키는 순간은 같고
 *    DB CHECK(`start_minute <= 1439`)를 만족한다.
 * 3. 옮기고 나서 같은 요일 안에서 다시 겹칠 수 있으므로 한 번 더 합친다.
 */
export function slotsToPatterns(
  slots: ReadonlySet<string>,
  axis: PatternAxis = WEEKDAY_AXIS,
): readonly AvailabilityPatternInput[] {
  const byColumn = new Map<number, number[]>();
  for (const key of slots) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    const column = Number.parseInt(key.slice(0, separator), 10);
    const slot = Number.parseInt(key.slice(separator + 1), 10);
    if (!Number.isInteger(column) || !Number.isInteger(slot)) continue;
    const list = byColumn.get(column);
    if (list === undefined) byColumn.set(column, [slot]);
    else list.push(slot);
  }

  // (1) 연속 칸 합치기
  const raw: MutableInterval[] = [];
  for (const [column, list] of byColumn) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    let runStart = sorted[0];
    let previous = sorted[0];
    for (let index = 1; index <= sorted.length; index += 1) {
      const slot = sorted[index];
      if (slot === previous + 1) {
        previous = slot;
        continue;
      }
      raw.push({
        column,
        startMinute: slotStartMinute(runStart),
        endMinute: slotStartMinute(previous + 1),
      });
      runStart = slot;
      previous = slot;
    }
  }

  // (2) 24:00 이후 시작 → 다음 열로 정규화
  const normalized = raw.map((interval) => {
    if (interval.startMinute < DAY_MINUTES) return interval;
    return {
      column: nextColumn(axis, interval.column),
      startMinute: interval.startMinute - DAY_MINUTES,
      endMinute: interval.endMinute - DAY_MINUTES,
    } satisfies MutableInterval;
  });

  // (3) 정규화로 새로 생긴 겹침 합치기
  const grouped = new Map<number, MutableInterval[]>();
  for (const interval of normalized) {
    const list = grouped.get(interval.column);
    if (list === undefined) grouped.set(interval.column, [interval]);
    else list.push(interval);
  }

  const result: AvailabilityPatternInput[] = [];
  for (const [column, list] of grouped) {
    for (const interval of mergeWithinColumn(list)) {
      result.push(
        columnToPattern(axis, column, interval.startMinute, interval.endMinute),
      );
    }
  }

  return result.sort(
    (a, b) =>
      patternColumn(a) - patternColumn(b) || a.startMinute - b.startMinute,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 검증
// ─────────────────────────────────────────────────────────────────────────────

export interface PatternViolation {
  /** 문제가 난 열 번호. 요일축이면 ISO 요일, 주기축이면 칸 번호다. */
  readonly column: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly reason: string;
}

/**
 * DB CHECK 와 **같은 경계**로 먼저 거른다. 서버도 다시 검증하지만, 여기서 걸러야
 * 사용자가 "어느 열이 문제인지" 즉시 알 수 있다(서버 400 은 그것을 말해 주지 못한다).
 */
export function validatePatterns(
  patterns: readonly AvailabilityPatternInput[],
): readonly PatternViolation[] {
  const violations: PatternViolation[] = [];
  for (const pattern of patterns) {
    const reason =
      pattern.endMinute <= pattern.startMinute
        ? "끝이 시작보다 빠릅니다."
        : pattern.endMinute - pattern.startMinute > MAX_SPAN_MINUTES
          ? "한 구간은 24시간을 넘을 수 없습니다."
          : pattern.startMinute < 0 || pattern.startMinute > DAY_MINUTES - 1
            ? "시작 시각이 하루 범위를 벗어납니다."
            : pattern.endMinute > 2 * DAY_MINUTES
              ? "끝 시각이 저장 가능한 범위를 벗어납니다."
              : null;
    if (reason !== null) {
      violations.push({
        column: patternColumn(pattern),
        startMinute: pattern.startMinute,
        endMinute: pattern.endMinute,
        reason,
      });
    }
  }
  return violations;
}

/** 두 칸 집합이 같은가. "저장하지 않은 변경이 있는가"를 판정한다. */
export function slotSetsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

/** `22:00 ~ 익일 02:00` 처럼 한 구간을 사람이 읽는 문장으로. */
export function describeInterval(
  interval: AvailabilityPatternInput,
): string {
  return `${describeDayMinute(interval.startMinute)} ~ ${describeDayMinute(interval.endMinute)}`;
}
