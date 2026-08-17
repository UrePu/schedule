import { formatInTimeZone } from "date-fns-tz";

/**
 * 메이플스토리 주간/일간 초기화 경계 유틸.
 *
 * 도메인 상수 (CLAUDE.md §1):
 * - 주간 초기화: 매주 **목요일 00:00 KST (Asia/Seoul)**
 * - 일간 초기화: 매일 **00:00 KST**
 *
 * 구현 원칙:
 * - 저장은 UTC(Date/timestamptz), 경계 계산은 항상 KST 로 한다. UTC 로 계산하지 않는다.
 * - KST 는 서머타임이 없는 **고정 UTC+9** 이므로 오프셋 가산 후 절삭하는 방식이 안전하다.
 *   (오프셋이 변하는 타임존이라면 이 방식은 쓸 수 없다.)
 * - 1970-01-01(epoch day 0)이 **목요일**이라는 성질을 이용해 주 경계를 절삭한다.
 */

export const KST_TIME_ZONE = "Asia/Seoul";

/** KST 고정 오프셋 (UTC+9). 서머타임 없음. */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function assertValidDate(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("[time/week] 유효하지 않은 Date 가 전달되었습니다.");
  }
}

/** 실제 시각 → KST 벽시계를 UTC 처럼 다루기 위한 shifted 밀리초. */
function toKstShifted(date: Date): number {
  assertValidDate(date);
  return date.getTime() + KST_OFFSET_MS;
}

/** shifted 밀리초 → 실제 시각. */
function fromKstShifted(shifted: number): Date {
  return new Date(shifted - KST_OFFSET_MS);
}

/**
 * 주어진 시각이 속한 주의 시작(= 직전 목요일 00:00 KST)을 돌려준다.
 * 입력이 정확히 목요일 00:00 KST 이면 그 시각 자신을 돌려준다.
 */
export function getWeekStart(date: Date): Date {
  const shifted = toKstShifted(date);
  // epoch day 0 = 1970-01-01 = 목요일 → WEEK_MS 로 절삭하면 목요일 00:00 KST.
  return fromKstShifted(Math.floor(shifted / WEEK_MS) * WEEK_MS);
}

/**
 * 다음 주간 초기화 시각(= 다음 목요일 00:00 KST).
 * 입력이 정확히 목요일 00:00 KST 이면 7일 뒤를 돌려준다.
 */
export function getNextReset(date: Date): Date {
  return new Date(getWeekStart(date).getTime() + WEEK_MS);
}

/**
 * 주어진 시각이 속한 일간 주기의 시작(= 직전 00:00 KST).
 */
export function getDailyReset(date: Date): Date {
  const shifted = toKstShifted(date);
  return fromKstShifted(Math.floor(shifted / DAY_MS) * DAY_MS);
}

/**
 * 주간 식별 문자열. 예) `2026-W33`
 *
 * 목요일 경계 기준이며 ISO-8601 주차와 값이 일치한다.
 * (ISO 는 "그 주의 목요일이 속한 해"를 주차의 해로 삼으므로,
 *  목요일 시작 주와 자연스럽게 맞물린다.)
 *
 * 같은 주의 모든 시각은 같은 키를, 목요일 00:00 KST 를 넘기면 다른 키를 돌려준다.
 */
export function getWeekKey(date: Date): string {
  const weekStart = getWeekStart(date);
  const year = Number.parseInt(
    formatInTimeZone(weekStart, KST_TIME_ZONE, "yyyy"),
    10,
  );

  const jan1Shifted = Date.UTC(year, 0, 1);
  const dayOfYear =
    Math.round((toKstShifted(weekStart) - jan1Shifted) / DAY_MS) + 1;
  // 목요일의 dayOfYear 는 항상 (첫 목요일 + 7n) 이므로 ceil(dayOfYear / 7) 이 ISO 주차와 같다.
  const week = Math.ceil(dayOfYear / 7);

  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 두 시각이 같은 주간 초기화 구간에 속하는지 판정한다. */
export function isSameWeek(a: Date, b: Date): boolean {
  return getWeekStart(a).getTime() === getWeekStart(b).getTime();
}

/** KST 기준으로 포맷한다. 표시용 문자열은 항상 이 함수를 경유한다. */
export function formatKst(date: Date, pattern = "yyyy-MM-dd HH:mm"): string {
  assertValidDate(date);
  return formatInTimeZone(date, KST_TIME_ZONE, pattern);
}
