/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주차 키 ↔ 실제 시각, 그리고 **달력 격자** — 서버와 브라우저가 같은 파일을 본다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `@/lib/time/week` 은 **시각 → 주차**를 안다(`getWeekStart` · `getWeekKey`). 원장 화면은
 * 그 반대가 필요하다 — `2026-W33` 이라는 **키에서 날짜 범위**를 복원해야 달력을 그리고
 * `8/13(목) ~ 8/19(수)` 를 찍을 수 있다.
 *
 * ★ `week.ts` 를 고치지 않는다. 다른 화면들이 이미 쓰고 있고 이 파일이 필요로 하는 것은
 *   그 위에 얹는 역함수뿐이다 — **경계 계산은 여전히 `getWeekStart()` 한 곳이 소유한다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 역함수가 성립하는 근거
 * ─────────────────────────────────────────────────────────────────────────────
 * `getWeekKey()` 는 주 시작(= 그 주의 목요일 00:00 KST)의 연도를 주차의 연도로 삼고,
 * `week = ceil(dayOfYear / 7)` 로 번호를 매긴다. 한 해의 모든 목요일은 `dayOfYear` 가
 * 7로 나눈 나머지가 같으므로, 첫 목요일의 `dayOfYear` 를 `d1(1~7)` 이라 하면
 *
 *     그 해 n번째 목요일의 dayOfYear = 7·(n − 1) + d1
 *
 * 이고 `ceil((7·(n−1) + d1) / 7) = n` (∵ 1 ≤ d1 ≤ 7) 이라 번호가 정확히 n 이 된다.
 * 즉 **`weekStartOfKey(getWeekKey(t)) === getWeekStart(t)`** 가 항등식이다.
 * (이 성질은 `week-range.test` 대신 `weekKeyRoundTripOk()` 로 런타임에서도 확인할 수 있게
 *  남겨 두었다 — 개발 중 콘솔 경고로 드러난다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 달력의 한 줄은 **목요일에 시작한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 앱의 회계 단위는 주(목 00:00 KST 리셋)다. 일요일 시작 격자에 주차 구분선을 덧그리면
 * 한 줄이 두 주에 걸치고, 줄 옆의 "이번 주 합계"가 어느 줄의 합인지 알 수 없게 된다.
 * 그래서 **격자 자체를 목~수로 돌린다.** 그러면 한 줄 = 정확히 한 주이고, 줄 왼쪽의
 * 주차 라벨(`W33`)과 합계가 그 줄 전체를 가리킨다 — 구분선을 덧그릴 필요조차 없다.
 * 요일 머리글이 `목 금 토 일 월 화 수` 로 나오는 것이 곧 경계 표시다.
 */

import { addKstDays, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { formatKst, getWeekKey, getWeekStart } from "@/lib/time/week";
import type { WeekKey } from "@/types/domain";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WEEK_KEY_PATTERN = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

/** 달력 머리글. **목요일이 한 주의 첫 칸**이다(위 머리말). */
export const WEEK_START_WEEKDAYS = ["목", "금", "토", "일", "월", "화", "수"] as const;

/**
 * `2026-W33` → 그 주의 시작(= 목요일 00:00 KST).
 *
 * 형식이 어긋나면 던진다 — 조용히 오늘로 접으면 화면이 **엉뚱한 주의 금액**을 그 주의
 * 것이라고 말한다.
 */
export function weekStartOfKey(weekKey: WeekKey): Date {
  const match = WEEK_KEY_PATTERN.exec(weekKey);
  if (!match) {
    throw new RangeError(
      `[income/week-range] 주차 키는 yyyy-Www 여야 합니다. 받은 값: ${weekKey}`,
    );
  }
  const week = Number.parseInt(match[2], 10);

  // 그 해 1월 1일 00:00 KST 가 속한 주의 목요일. 1월 1일보다 앞이면 다음 목요일이 첫째다.
  const jan1 = kstMoment(`${match[1]}-01-01`, 0);
  const thursdayOfJan1Week = getWeekStart(jan1);
  const firstThursday =
    thursdayOfJan1Week.getTime() < jan1.getTime()
      ? new Date(thursdayOfJan1Week.getTime() + WEEK_MS)
      : thursdayOfJan1Week;

  const start = new Date(firstThursday.getTime() + (week - 1) * WEEK_MS);
  if (Number.isNaN(start.getTime())) {
    throw new RangeError(`[income/week-range] 주차 키를 해석할 수 없습니다: ${weekKey}`);
  }
  return start;
}

/** 그 주의 끝 = 다음 목요일 00:00 KST. **배타 경계**다(이 시각은 다음 주에 속한다). */
export function weekEndOfKey(weekKey: WeekKey): Date {
  return new Date(weekStartOfKey(weekKey).getTime() + WEEK_MS);
}

/** 왕복이 성립하는가. 개발 중 회귀를 드러내기 위한 자기검증이다. */
export function weekKeyRoundTripOk(weekKey: WeekKey): boolean {
  return getWeekKey(weekStartOfKey(weekKey)) === weekKey;
}

/** 주차를 `weeks` 만큼 옮긴다(음수면 과거). 달력의 이전/다음, "더 보기"가 쓴다. */
export function shiftWeekKey(weekKey: WeekKey, weeks: number): WeekKey {
  return getWeekKey(new Date(weekStartOfKey(weekKey).getTime() + weeks * WEEK_MS));
}

/** `2026-W33 · 8/13(목) ~ 8/19(수)` 의 뒷부분. 끝은 **포함**해서 보여 준다(수요일). */
export function formatWeekRange(weekKey: WeekKey): string {
  const start = weekStartOfKey(weekKey);
  const lastDay = new Date(start.getTime() + 6 * DAY_MS);
  return `${formatKst(start, "M/d")}(목) ~ ${formatKst(lastDay, "M/d")}(수)`;
}

/** `2026-W33` → `W33`. 달력 줄 옆에 붙는 짧은 라벨. */
export function shortWeekLabel(weekKey: WeekKey): string {
  const match = WEEK_KEY_PATTERN.exec(weekKey);
  return match ? `W${match[2]}` : weekKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// 달 격자
// ─────────────────────────────────────────────────────────────────────────────

/** `2026-08` — KST 달력 기준의 달 키. */
export function kstMonthKey(date: Date): string {
  return formatKst(date, "yyyy-MM");
}

/** `2026-08` → `2026년 8월`. */
export function formatMonthKey(monthKey: string): string {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) return monthKey;
  return `${match[1]}년 ${String(Number.parseInt(match[2], 10))}월`;
}

/** 달 키를 `months` 만큼 옮긴다. */
export function shiftMonthKey(monthKey: string, months: number): string {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) return monthKey;
  const total =
    Number.parseInt(match[1], 10) * 12 + (Number.parseInt(match[2], 10) - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 달력 한 칸. */
export interface CalendarDay {
  /** `yyyy-MM-dd` (KST). 클리어를 이 키로 묶는다. */
  readonly dayKey: string;
  /** 그 달 밖의 날인가. 주가 달을 넘나들기 때문에 반드시 생긴다. */
  readonly outside: boolean;
}

/** 달력 한 줄 = **정확히 한 주**. */
export interface CalendarWeek {
  readonly weekKey: WeekKey;
  /** 목→수 순서로 7칸. */
  readonly days: readonly CalendarDay[];
}

/**
 * 그 달을 덮는 주 목록. **한 줄이 한 주(목~수)** 라 달 경계에서 앞뒤 날이 딸려 온다.
 *
 * 딸려 온 날을 지우지 않는 이유: 줄 옆에 붙는 주 합계가 **그 주 전체**의 합인데 칸 일부를
 * 비워 두면 합계와 칸의 합이 달라 보인다. 대신 `outside` 로 흐리게 그린다.
 */
export function monthCalendarWeeks(monthKey: string): readonly CalendarWeek[] {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) return [];

  const first = kstMoment(`${monthKey}-01`, 0);
  // 다음 달 1일의 하루 전 = 이 달 마지막 날. 말일 계산을 손으로 하지 않는다.
  const last = new Date(kstMoment(`${shiftMonthKey(monthKey, 1)}-01`, 0).getTime() - DAY_MS);

  const weeks: CalendarWeek[] = [];
  let cursor = getWeekStart(first);
  const lastWeekStart = getWeekStart(last);

  // 방어 상한: 한 달은 아무리 길어도 6주를 넘지 않는다(무한 루프를 코드로 막는다).
  for (let index = 0; index < 6; index += 1) {
    const days: CalendarDay[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addKstDays(cursor, offset);
      const dayKey = kstDayKey(day);
      days.push({ dayKey, outside: !dayKey.startsWith(`${monthKey}-`) });
    }
    weeks.push({ weekKey: getWeekKey(cursor), days });

    if (cursor.getTime() >= lastWeekStart.getTime()) break;
    cursor = new Date(cursor.getTime() + WEEK_MS);
  }

  return weeks;
}

/** `2026-08-17` → `17`. 달력 칸의 날짜 숫자. */
export function dayOfMonthLabel(dayKey: string): string {
  return String(Number.parseInt(dayKey.slice(8, 10), 10));
}

// ─────────────────────────────────────────────────────────────────────────────
// 원장 조회 범위 — **서버 prefetch 와 클라이언트 쿼리가 같은 함수를 쓴다**
// ─────────────────────────────────────────────────────────────────────────────
//
// 범위가 한 칸이라도 어긋나면 캐시 키가 달라지고, 서버가 심어 둔 값이 **쓰이지 않은 채**
// 클라이언트가 같은 데이터를 다시 받아 온다(첫 화면이 빈 달력으로 깜빡인다).
// 그래서 두 곳 모두 아래 두 함수만 쓴다. 손으로 계산하는 자리를 만들지 않는다.

/** 주차 목록의 첫 페이지 길이이자 "더 보기" 한 번의 증가폭. */
export const LEDGER_PAGE_WEEKS = 6;

/**
 * 한 번의 요청이 조회할 수 있는 주차 수 상한. 26주(반년)면 "더 보기"로 충분히 거슬러 간다.
 *
 * ★ **서버(Route Handler)와 화면이 같은 값을 봐야 한다.** 서버만 알고 있으면 화면이
 *   상한을 넘겨 요청하고 400 을 받는데, 사용자에게는 "더 보기를 눌렀더니 목록이
 *   사라졌다"로 보인다. `income-repo` 도 이 상수를 가져다 쓴다.
 */
export const LEDGER_MAX_WEEKS = 26;

/** 달력이 그 달을 그리기 위해 필요한 주차 범위. */
export function calendarLedgerRange(
  monthKey: string,
  fallbackWeekKey: WeekKey,
): { readonly from: WeekKey; readonly to: WeekKey } {
  const grid = monthCalendarWeeks(monthKey);
  return {
    from: grid[0]?.weekKey ?? fallbackWeekKey,
    to: grid[grid.length - 1]?.weekKey ?? fallbackWeekKey,
  };
}

/** 주차 목록이 보고 있는 범위. `weeksBack` 주 전부터 이번 주까지. */
export function listLedgerRange(
  weekKey: WeekKey,
  weeksBack: number,
): { readonly from: WeekKey; readonly to: WeekKey } {
  return { from: shiftWeekKey(weekKey, -(weeksBack - 1)), to: weekKey };
}
