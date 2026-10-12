/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주차 키 ↔ 실제 시각 — **시각에서 주차를 뽑는 `week.ts` 의 역함수**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `./week` 은 **시각 → 주차**를 안다(`getWeekStart` · `getWeekKey`). 화면들은 그 반대도
 * 필요하다 — `2026-W42` 라는 **키에서 날짜 범위**를 복원해야 달력을 그리고,
 * `10/9(목) ~ 10/15(수)` 를 찍고, 이전/다음 주로 옮길 수 있다.
 *
 * ★ `week.ts` 를 고치지 않는다. 경계 계산은 여전히 `getWeekStart()` 한 곳이 소유하고,
 *   이 파일은 그 위에 얹는 역함수와 **표시용 포맷터**만 갖는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `features/income/lib/week-range.ts` 에서 올라왔나 (2026-10-12)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 함수들은 원래 수익 원장 화면이 혼자 쓰던 것이라 income feature 안에 있었다.
 * 주간 시간표(`/` · schedule feature)에 **주 이동 버튼**이 붙으면서 같은 변환이
 * 필요해졌는데, schedule 이 income 을 import 하면 두 기능이 서로를 보게 된다 —
 * 수익 화면을 고치다가 첫 화면이 깨지는 길이 열린다.
 *
 * 그래서 **주차 키 자체에 대한 지식**(역변환 · 이동 · 라벨)은 여기로 올리고, 달 격자와
 * 원장 조회 범위처럼 **원장 화면의 지식**은 `week-range.ts` 에 남겼다.
 * `week-range.ts` 는 이 파일을 **재수출**하므로 income 쪽 호출부는 한 줄도 바뀌지 않았다.
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
 * (`weekKeyRoundTripOk()` 로 런타임에서도 확인할 수 있게 남겨 둔다.)
 */

import type { WeekKey } from "@/types/domain";

import { kstMoment } from "./kst-wallclock";
import { formatKst, getWeekKey, getWeekStart } from "./week";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WEEK_KEY_PATTERN = /^(\d{4})-W(\d{2})$/;

/**
 * 형식이 `yyyy-Www` 인가. **형식만** 본다 — `2026-W99` 처럼 숫자가 말이 안 되는 값도
 * 통과하므로, 실제 유효성은 `weekKeyRoundTripOk()` 가 판정한다.
 */
export function isWeekKeyFormat(value: string): boolean {
  return WEEK_KEY_PATTERN.test(value);
}

/**
 * `2026-W33` → 그 주의 시작(= 목요일 00:00 KST).
 *
 * 형식이 어긋나면 던진다 — 조용히 오늘로 접으면 화면이 **엉뚱한 주의 금액**을 그 주의
 * 것이라고 말한다. 사용자 입력(쿼리 파라미터)을 접어야 하는 자리는 `parseWeekKeyParam()`
 * 이고, 그 함수가 **던지기 전에** 형식을 걸러 준다.
 */
export function weekStartOfKey(weekKey: WeekKey): Date {
  const match = WEEK_KEY_PATTERN.exec(weekKey);
  if (!match) {
    throw new RangeError(
      `[time/week-key] 주차 키는 yyyy-Www 여야 합니다. 받은 값: ${weekKey}`,
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
    throw new RangeError(`[time/week-key] 주차 키를 해석할 수 없습니다: ${weekKey}`);
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

/** 주차를 `weeks` 만큼 옮긴다(음수면 과거). 달력의 이전/다음, 주 이동 버튼이 쓴다. */
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

/**
 * 두 주차 사이의 간격(주 단위). `weekKey` 가 `baseWeekKey` 보다 미래면 양수다.
 *
 * 주 시작끼리의 차를 재므로 해를 넘어가도(`2026-W52` → `2027-W01`) 정확하다 —
 * 주차 **번호**를 빼면 연말에 틀린다.
 */
export function weekOffsetFrom(weekKey: WeekKey, baseWeekKey: WeekKey): number {
  const diff =
    weekStartOfKey(weekKey).getTime() - weekStartOfKey(baseWeekKey).getTime();
  return Math.round(diff / WEEK_MS);
}

/**
 * 보고 있는 주를 사람 말로. `이번 주` · `다음 주` · `지난 주` · `3주 뒤` · `2주 전`.
 *
 * ★ 화면 문구가 이 한 함수만 보게 하려고 만들었다. 예전에는 머리말·빈 상태·오류 제목이
 *   각자 `"이번 주"` 를 **글자로 박아** 두고 있었는데, 주를 옮길 수 있게 된 순간 그
 *   글자들이 전부 거짓말이 된다(다음 주를 보면서 "이번 주에 잡힌 일정이 없습니다").
 *
 * 조사(助詞)는 붙이지 않는다 — 부르는 쪽이 `…에` · `…의` 를 붙이고, 어느 값이 와도
 * 받침이 없어(주) 조사가 갈리지 않는다.
 */
export function weekScopeLabel(weekKey: WeekKey, baseWeekKey: WeekKey): string {
  const offset = weekOffsetFrom(weekKey, baseWeekKey);
  if (offset === 0) return "이번 주";
  if (offset === 1) return "다음 주";
  if (offset === -1) return "지난 주";
  return offset > 0 ? `${String(offset)}주 뒤` : `${String(-offset)}주 전`;
}

/**
 * 쿼리 파라미터(`?week=2026-W42`) → 실제로 쓸 주차 키.
 *
 * ⚠️ **틀린 값은 조용히 `fallback`(= 이번 주)으로 접는다.** 오류 화면을 띄우지 않는 이유:
 *   · `/` 는 매일 여는 첫 화면이고, 그 자리에 오류를 세우면 앱이 열리지 않는다.
 *   · 사용자가 고칠 수 있는 값이 아니다(오래된 링크, 잘린 URL, 봇).
 *   · `weekStartOfKey()` 는 형식이 틀리면 **던지므로**, 걸러 주지 않으면 서버 500 이다.
 *
 * 두 단계로 본다:
 *   ① 형식(`yyyy-Www`) — 여기서 걸러야 `weekStartOfKey()` 가 던지지 않는다.
 *   ② 왕복(`weekKeyRoundTripOk`) — `2026-W00` · `2026-W99` 처럼 형식은 맞지만 그 해에
 *      존재하지 않는 주차를 걸러낸다. 접지 않으면 1년 뒤 엉뚱한 주를 그 주차라고
 *      우기는 화면이 된다.
 *
 * 배열(`?week=a&week=b`)은 **첫 값만** 본다. 하나만 의미 있는 파라미터에 두 개가 오면
 * 둘 중 하나를 고르는 수밖에 없고, 사람이 손으로 붙이는 쪽은 언제나 앞이다.
 */
export function parseWeekKeyParam(
  value: string | readonly string[] | undefined,
  fallback: WeekKey,
): WeekKey {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw === "") return fallback;
  if (!isWeekKeyFormat(raw)) return fallback;
  if (!weekKeyRoundTripOk(raw)) return fallback;
  return raw;
}
