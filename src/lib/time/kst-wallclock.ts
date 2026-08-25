import { KST_OFFSET_MS, formatKst } from "./week";

/**
 * KST 벽시계 ↔ 절대 시각 변환.
 *
 * `week.ts` 는 **주/일 경계**를 다루고, 이 파일은 **하루 안의 분 단위 좌표**를 다룬다.
 * 둘을 한 파일에 섞지 않은 이유는 대응하는 DB 함수가 원래 따로이기 때문이다:
 *
 * | 여기                | DB (마이그레이션 11)                    |
 * |---------------------|-----------------------------------------|
 * | `kstDayKey`         | `public.kst_date(timestamptz) -> date`   |
 * | `kstMoment`         | `public.kst_moment(date, integer)`       |
 * | `kstIsoWeekday`     | `extract(isodow from date)`              |
 *
 * ★ 자정 넘김(22:00~02:00)의 핵심:
 *   `kstMoment(day, 1560)` 은 **자동으로 다음 날 02:00** 이 된다.
 *   가용시간은 `end_minute` 가 1440 을 넘도록 저장되므로(DB-SCHEMA §10-2),
 *   구간을 두 개로 쪼개지 않고도 그대로 절대 시각으로 펼칠 수 있다.
 *
 * KST 는 서머타임이 없는 고정 UTC+9 라 오프셋 산술이 항상 정확하다.
 */

const MINUTE_MS = 60_000;
export const DAY_MINUTES = 1440;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 시각이 속한 KST 달력 날짜 키(`yyyy-MM-dd`). → `public.kst_date(timestamptz)` */
export function kstDayKey(date: Date): string {
  return formatKst(date, "yyyy-MM-dd");
}

/** ISO 요일(1=월 … 7=일). `availability_patterns.weekday` 와 값이 그대로 맞는다. */
export function kstIsoWeekday(date: Date): number {
  return Number.parseInt(formatKst(date, "i"), 10);
}

/**
 * KST 벽시계(날짜 + 자정으로부터의 분) → 절대 시각.
 * → `public.kst_moment(date, integer)`
 *
 * `minutes` 가 1440 을 넘으면 다음 날로 자연스럽게 넘어간다. 음수도 허용한다
 * (해석기가 조회 범위보다 하루 앞에서 시작해야 하는 경우가 있다).
 */
export function kstMoment(dayKey: string, minutes: number): Date {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) {
    throw new RangeError(
      `[time/kst-wallclock] 날짜 키는 yyyy-MM-dd 여야 합니다. 받은 값: ${dayKey}`,
    );
  }

  // Date.UTC 로 만든 값은 "KST 벽시계를 UTC 처럼 다룬" shifted 밀리초다.
  const shiftedMidnight = Date.UTC(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10),
  );

  return new Date(shiftedMidnight - KST_OFFSET_MS + minutes * MINUTE_MS);
}

/** `dayKey` 의 KST 00:00 을 기준으로 한 경과 분. 다음 날이면 1440 이상이 나온다. */
export function minutesFromKstDay(instant: Date, dayKey: string): number {
  return Math.round(
    (instant.getTime() - kstMoment(dayKey, 0).getTime()) / MINUTE_MS,
  );
}

/** KST 기준으로 `days` 일 뒤. KST 는 DST 가 없어 단순 가산이 정확하다. */
export function addKstDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MINUTES * MINUTE_MS);
}

/**
 * 하루 좌표(분)를 `HH:mm` 으로. **1440 이상은 24 를 넘는 시로 표기한다.**
 * 예) 1560 → `26:00`.
 *
 * 자정을 넘겨 `02:00` 으로 되돌리면 "밤 10시부터 새벽 2시까지"라는 한 덩어리가
 * 축 위에서 앞으로 되감긴 것처럼 보인다. 24 를 넘겨 적으면 시간이 계속 흐른다.
 * 익일 여부는 축의 `24:00` 구분선이 함께 알려 준다.
 */
/**
 * `HH:MM` → 자정부터의 분. 형식이 아니면 `null` — **0 으로 떨어뜨리지 않는다.**
 * 0 은 "00:00" 이라는 유효한 답이라, 파싱 실패와 자정을 같은 값으로 만들면
 * 빈 칸으로 등록한 일정이 조용히 자정에 잡힌다.
 *
 * ★ 예전에는 `run-composer` 와 `plan-run-dialog` 가 **각자 한 벌씩** 갖고 있었다.
 *   같은 규칙을 두 곳에 두면 한쪽만 고쳐지고, 그 차이는 "왜 이 화면에서만 안 되지"
 *   로만 드러난다. 마법사가 세 번째 사본을 만들 자리라 여기로 모았다(2026-08-25).
 */
export function minutesFromTimeText(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatDayMinute(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** 사람이 읽는 시각 표기. 1440 이상이면 `익일 02:00` 처럼 풀어 쓴다. */
export function describeDayMinute(minutes: number): string {
  if (minutes >= DAY_MINUTES) {
    return `익일 ${formatDayMinute(minutes - DAY_MINUTES)}`;
  }
  return formatDayMinute(minutes);
}
