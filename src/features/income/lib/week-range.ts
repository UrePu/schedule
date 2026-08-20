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
 * ★ 달력 격자는 **월요일에 시작한다** — 보통 달력처럼 (2026-08-19 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자: *"캘린더부분 표시는 일반적인 달력과 같게좀 해줘라 이건 헷갈릴거같아."*
 * 이어서: *"월요일시작으로 해 나는그게 편해."*
 *
 * 이전 버전은 회계 단위(목 00:00 KST 리셋)에 맞춰 격자 자체를 **목~수**로 돌려 두었다.
 * 한 줄이 정확히 한 주가 되는 장점은 있었지만, 8월 1일이 토요일 칸에 놓이는 달력은 사람이
 * 읽는 그 어떤 달력과도 달라서 **날짜를 찾는 일 자체가 어려워진다.** 회계 편의보다 날짜를
 * 찾는 쪽이 먼저다.
 *
 * 시작 요일은 화면의 `M`/`S` 버튼으로 바꾼다(발주자 2026-08-19: *"옆에 버튼 넣어서 맨앞이
 * 일요일에오는 캘린더로 변환할수있게 해"*). 기본은 월요일이고 선택은 브라우저에 남는다 —
 * `week-start-preference.ts`. **격자 배열만** 바뀌고 주차·수익 계산은 그대로다.
 *
 * 그래서 격자는 `월 화 수 목 금 토 일` 로 되돌리고, 주간 경계는 **목요일 칸**이 진다:
 *   · 목요일 칸의 `W33` 배지 → "여기서 이번 주가 시작한다". 배지에 마우스를 올리면 그 주
 *     목~수 7칸이 함께 강조된다(상시 표시하던 세로선은 격자를 조각내서 걷어냈다)
 *   · 줄 단위 합계는 격자에서 뺀다. 한 줄이 두 주차에 걸치므로 줄 옆 합계가 더는 성립하지
 *     않는다 — 주차 합계는 **격자 아래 주차 칩**과 주차별 내역 카드가 답한다.
 * 그래서 `CalendarDay` 가 자기 **주차(`weekKey`)** 와 **주 시작 여부(`weekStart`)** 를
 * 직접 들고 다닌다 — 줄이 아니라 칸이 주차를 안다.
 */

import {
  addKstDays,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { formatKst, getWeekKey, getWeekStart } from "@/lib/time/week";
import type { WeekKey } from "@/types/domain";

import {
  DEFAULT_WEEK_START,
  WEEK_START_CHOICES,
  type WeekStartChoice,
} from "./week-start-preference";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WEEK_KEY_PATTERN = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

/** ISO 요일(1=월 … 7=일)에서 목요일. 주간 초기화가 일어나는 날이다(§1). */
const THURSDAY = 4;

/**
 * 달력 머리글. 기본은 **월요일 시작**(발주자 2026-08-19)이고, 화면의 `M`/`S` 버튼이
 * 일요일 시작으로 바꿀 수 있다 — `week-start-preference.ts` 참고.
 *
 * ★ 이 선택은 **격자 배열만** 바꾼다. 주차 계산은 목요일 경계 그대로다(§1).
 */
export function calendarWeekdays(
  weekStart: WeekStartChoice = DEFAULT_WEEK_START,
): readonly string[] {
  return weekStart === "sun"
    ? ["일", "월", "화", "수", "목", "금", "토"]
    : ["월", "화", "수", "목", "금", "토", "일"];
}

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

/** `2026-W33` → `W33`. 달력 칸과 주차 칩에 붙는 짧은 라벨. */
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

/**
 * 주차 키 → 그 주에 해당하는 **월간 주기의 달 키**.
 *
 * 인게임 월간 초기화는 달력 1일이라, 월간 보스 집계는 주차가 아니라 달로 세야 한다
 * (2026-08-20 발주자: *"저번주에 월간 잡은걸 안보여주면 어떡함"*).
 *
 * ★ **이번 주를 보고 있으면 "이번 달"은 말 그대로 오늘이 속한 달이다.** 화면의 타일이
 *   그 이름을 달고 있으므로, 주 시작(목요일)이 지난달이더라도 오늘 기준이 맞다.
 * ⚠️ 지난 주차는 그 주가 **시작한 목요일**이 속한 달로 센다. 달을 걸친 주(예: 7/30 목 ~
 *    8/5 수)는 어느 쪽으로 세도 절반이 다른 달이라 정답이 없다 — 주의 정체성이 있는
 *    시작 쪽을 택하고, 이 근사를 여기 적어 둔다.
 */
export function monthKeyOfWeek(weekKey: WeekKey, now: Date = new Date()): string {
  if (weekKey === getWeekKey(now)) return kstMonthKey(now);
  return kstMonthKey(weekStartOfKey(weekKey));
}

/** `2026-08` → `8월`. 타일 라벨처럼 폭이 좁은 자리용. */
export function shortMonthLabel(monthKey: string): string {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) return monthKey;
  return `${String(Number.parseInt(match[2], 10))}월`;
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
  /** 그 달 밖의 날인가. 줄이 달을 넘나들기 때문에 반드시 생긴다. */
  readonly outside: boolean;
  /**
   * 이 날이 속한 **회계 주차**(목 00:00 KST 리셋 기준).
   *
   * 격자가 월요일부터라 한 줄이 두 주차에 걸친다 — 그래서 주차를 아는 단위는 줄이 아니라
   * **칸**이다. 화면은 이 값으로 목요일 칸에 `W33` 을 찍고 주차 칩을 만든다.
   */
  readonly weekKey: WeekKey;
  /** 주간 초기화가 일어나는 날(목요일)인가. 여기서 새 주차가 시작한다. */
  readonly weekStart: boolean;
}

/** 달력 한 줄 = 선택한 시작 요일부터 **7칸**(보통 달력). */
export interface CalendarWeek {
  /** 줄 식별자 = 그 줄 첫 칸의 날짜 키. 회계 주차가 아니다. */
  readonly rowKey: string;
  /** 시작 요일부터 7칸. */
  readonly days: readonly CalendarDay[];
}

/**
 * 그 날이 속한 줄의 첫 날 00:00 KST.
 *
 * ISO 요일은 1=월 … 7=일. 월요일 시작이면 월요일이 0 칸, 일요일 시작이면 일요일이 0 칸이
 * 되도록 뒤로 물린다(`% 7` 이 일요일 7 을 0 으로 접는다).
 */
function rowStart(date: Date, weekStart: WeekStartChoice): Date {
  const midnight = kstMoment(kstDayKey(date), 0);
  const isoWeekday = kstIsoWeekday(midnight);
  const back = weekStart === "sun" ? isoWeekday % 7 : isoWeekday - 1;
  return addKstDays(midnight, -back);
}

/**
 * 그 달의 달력 줄 목록. 시작 요일이 어느 쪽이든 달 경계에서 앞뒤 달의 날이 딸려 온다.
 *
 * 딸려 온 날을 지우지 않는 이유: 그 칸에도 클리어 기록이 있을 수 있고, 빈 칸으로 두면
 * "그 날엔 안 돌았다"로 읽힌다. 대신 `outside` 로 점선 처리한다.
 */
export function monthCalendarWeeks(
  monthKey: string,
  weekStart: WeekStartChoice = DEFAULT_WEEK_START,
): readonly CalendarWeek[] {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) return [];

  const first = kstMoment(`${monthKey}-01`, 0);
  // 다음 달 1일의 하루 전 = 이 달 마지막 날. 말일 계산을 손으로 하지 않는다.
  const last = new Date(
    kstMoment(`${shiftMonthKey(monthKey, 1)}-01`, 0).getTime() - DAY_MS,
  );

  const weeks: CalendarWeek[] = [];
  let cursor = rowStart(first, weekStart);
  const lastRowStart = rowStart(last, weekStart);

  // 방어 상한: 달 격자는 아무리 길어도 6줄을 넘지 않는다(무한 루프를 코드로 막는다).
  for (let index = 0; index < 6; index += 1) {
    const days: CalendarDay[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const dayKey = kstDayKey(addKstDays(cursor, offset));
      // 주차 판정은 **정오(720분)** 기준 — 00:00 은 경계에서 하루가 밀릴 여지가 남는다.
      const noon = kstMoment(dayKey, 720);
      days.push({
        dayKey,
        outside: !dayKey.startsWith(`${monthKey}-`),
        weekKey: getWeekKey(noon),
        weekStart: kstIsoWeekday(noon) === THURSDAY,
      });
    }
    weeks.push({ rowKey: kstDayKey(cursor), days });

    if (cursor.getTime() >= lastRowStart.getTime()) break;
    cursor = new Date(cursor.getTime() + WEEK_MS);
  }

  return weeks;
}

/**
 * 격자가 건드리는 주차를 **오래된 순서**로. 격자 아래 주차 칩이 이 순서로 늘어선다.
 *
 * 칸이 날짜순이라 주차도 날짜순으로 나오고, 이어지는 중복만 걷어 내면 된다.
 */
export function calendarWeekKeys(
  weeks: readonly CalendarWeek[],
): readonly WeekKey[] {
  const keys: WeekKey[] = [];
  for (const week of weeks) {
    for (const day of week.days) {
      if (keys[keys.length - 1] !== day.weekKey) keys.push(day.weekKey);
    }
  }
  return keys;
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

/**
 * 달력이 그 달을 그리기 위해 필요한 주차 범위.
 *
 * ★ **줄이 아니라 칸의 주차**를 본다. 한 줄이 두 주차에 걸치므로(월요일 시작이면 월~수가
 *   같은 줄 목요일보다 한 주 앞선다) 줄 하나를 주차 하나로 보고 범위를 잡으면 첫 줄
 *   앞머리 며칠의 클리어가 조회되지 않아 달력에서만 조용히 사라진다.
 *
 * ★★ **주 시작 요일 선택을 인자로 받지 않는다 — 두 배치를 모두 덮는 합집합이다.**
 *    시작 요일은 localStorage 에 있고 **서버는 그 값을 모른다.** 범위가 선택에 따라
 *    달라지면 서버가 prefetch 한 캐시 키와 클라이언트가 요청하는 키가 갈리고, 첫 화면이
 *    빈 달력으로 깜빡인 뒤 같은 데이터를 다시 받아 온다(§2.4 Rule 1 이 막으려는 바로 그
 *    증상). 넉넉해야 최대 한 주가 더 붙을 뿐이고, 그 대가로 서버·클라이언트가 **항상**
 *    같은 키를 본다.
 */
export function calendarLedgerRange(
  monthKey: string,
  fallbackWeekKey: WeekKey,
): { readonly from: WeekKey; readonly to: WeekKey } {
  const keys = WEEK_START_CHOICES.flatMap((choice) =>
    calendarWeekKeys(monthCalendarWeeks(monthKey, choice)),
  );
  if (keys.length === 0) return { from: fallbackWeekKey, to: fallbackWeekKey };

  // `yyyy-Www` 는 주차가 2자리로 채워져 있어 사전순 = 시간순이다(연도가 앞에 온다).
  const sorted = [...keys].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/** 주차 목록이 보고 있는 범위. `weeksBack` 주 전부터 이번 주까지. */
export function listLedgerRange(
  weekKey: WeekKey,
  weeksBack: number,
): { readonly from: WeekKey; readonly to: WeekKey } {
  return { from: shiftWeekKey(weekKey, -(weeksBack - 1)), to: weekKey };
}
