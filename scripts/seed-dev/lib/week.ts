/**
 * KST 주간 경계 — **목요일 00:00 (Asia/Seoul)**.
 *
 * DB 의 `public.week_key(timestamptz)` / `public.week_start(timestamptz)` 와
 * 값이 일치해야 한다. 알고리즘은 그쪽과 동일하다:
 *
 * - KST 는 DST 가 없는 고정 UTC+9 이므로 순수 산술로 계산할 수 있다.
 * - epoch day 0 (1970-01-01) 이 **목요일**이라, `ms + 9h` 를 604800000 으로 절삭하면
 *   곧바로 그 주의 목요일 00:00 KST 가 나온다.
 * - 그 목요일의 `ceil(dayOfYear / 7)` 이 ISO 주차와 정확히 일치한다
 *   (연중 n번째 목요일의 doy 는 항상 `firstThuDoy + 7(n-1)`).
 *
 * ⚠️ 날짜를 하드코딩하지 않는다. 항상 실행 시점의 `now` 에서 계산한다.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000
export const WEEK_MS = 7 * DAY_MS

/** 주 시작(그 주 목요일 00:00 KST)의 절대 시각. */
export function weekStart(now: Date): Date {
  const shifted = now.getTime() + KST_OFFSET_MS
  return new Date(Math.floor(shifted / WEEK_MS) * WEEK_MS - KST_OFFSET_MS)
}

/** `2026-W33` 형태. DB `week_key()` 와 같은 값이 나와야 한다. */
export function weekKey(ts: Date): string {
  const start = weekStart(ts)
  // 주 시작을 "KST 달력 날짜"로 옮긴 뒤 UTC 게터로 읽는다 (로컬 타임존 영향 제거).
  const kstCalendar = new Date(start.getTime() + KST_OFFSET_MS)
  const year = kstCalendar.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const dayOfYear = Math.floor((kstCalendar.getTime() - jan1) / DAY_MS) + 1
  const week = Math.ceil(dayOfYear / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** 주 시작으로부터 `dayOffset` 일(0=목 … 6=수), `minute` 분 뒤의 절대 시각. */
export function kstMoment(start: Date, dayOffset: number, minute: number): Date {
  return new Date(start.getTime() + dayOffset * DAY_MS + minute * 60_000)
}

/** 주 시작으로부터 `dayOffset` 일째의 **KST 달력 날짜** (`YYYY-MM-DD`). */
export function kstDate(start: Date, dayOffset: number): string {
  const kstCalendar = new Date(start.getTime() + dayOffset * DAY_MS + KST_OFFSET_MS)
  const y = kstCalendar.getUTCFullYear()
  const m = String(kstCalendar.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kstCalendar.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 주 시작 기준 일 오프셋 → 사람이 읽는 요일 이름. */
export const DAY_LABELS = ['목', '금', '토', '일', '월', '화', '수'] as const

/** ISO 요일(1=월 … 7=일) → 주 시작(목) 기준 오프셋. */
export function isoWeekdayToOffset(isoWeekday: number): number {
  // 목(4)=0, 금(5)=1, 토(6)=2, 일(7)=3, 월(1)=4, 화(2)=5, 수(3)=6
  return (isoWeekday - 4 + 7) % 7
}

/** `2026-08-20T12:00+09:00` 같은 사람이 읽는 KST 표기. */
export function formatKst(ts: Date): string {
  const c = new Date(ts.getTime() + KST_OFFSET_MS)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())} ` +
    `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())} KST`
  )
}
