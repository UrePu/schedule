import { DAY_MINUTES, kstMoment } from "@/lib/time/kst-wallclock";

/**
 * 예외 한 행이 지우는 **절대 시각 구간**.
 * 시각이 없으면 그날 00:00~24:00 전체다.
 *
 * 하는 일은 KST 벽시계 분 → 절대 시각 변환뿐인 **순수 함수**라 `lib/` 에 둔다.
 * 데이터 접근 계층(`data/`)에 두면 화면(`overlay-grid.tsx`)이 조회 모듈에 묶인다.
 */
export function exceptionSpan(
  dayKey: string,
  startMinute: number | null,
  endMinute: number | null,
): { readonly startsAt: Date; readonly endsAt: Date } {
  return {
    startsAt: kstMoment(dayKey, startMinute ?? 0),
    endsAt: kstMoment(dayKey, endMinute ?? DAY_MINUTES),
  };
}
