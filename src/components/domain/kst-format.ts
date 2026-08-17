import { formatKst } from "@/lib/time/week";

/**
 * KST 요일/시각 표기 헬퍼.
 *
 * date-fns 의 `EEE` 토큰은 로케일을 주지 않으면 영어("Thu")를 내놓는다.
 * UI 전체가 한국어이므로 요일만 ISO 요일 번호(1=월 … 7=일)로 뽑아 직접 매핑한다.
 * 로케일 번들을 끌어오지 않아 번들 크기에도 이득이다.
 */

const WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"] as const;

/** KST 기준 한국어 요일 한 글자. */
export function kstWeekdayKo(date: Date): string {
  const isoDay = Number.parseInt(formatKst(date, "i"), 10);
  return WEEKDAY_KO[isoDay - 1] ?? "";
}

/** 예) "8/20 목 00:00" — 초기화 시점 표기에 쓴다. */
export function formatKstShort(date: Date): string {
  return `${formatKst(date, "M/d")} ${kstWeekdayKo(date)} ${formatKst(date, "HH:mm")}`;
}

/** 예) "2026-08-20 목 00:00" — title 속성 등 정확한 시각 노출용. */
export function formatKstFull(date: Date): string {
  return `${formatKst(date, "yyyy-MM-dd")} ${kstWeekdayKo(date)} ${formatKst(date, "HH:mm")}`;
}
