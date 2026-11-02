import { kstDayKey, kstMoment } from "./kst-wallclock";
import { getWeekStart } from "./week";

/**
 * 주간·월간 초기화 직후 **넥슨 응답을 믿지 않는 시간** — 20분.
 *
 * 넥슨 데이터는 최대 ~15분 늦는다(CLAUDE.md §1.1). 그래서 초기화 직후의 응답은 `date` 는 새
 * 날인데 `complete_flag` 는 초기화 전 값일 수 있고, 동기화는 주차를 그 `date` 로 정하므로
 * **지난주 클리어가 새 주의 클리어로 기록된다.** 수익이 이중으로 잡히고, 동기화는 `true` 만
 * 쓰므로 나중에 값이 false 로 돌아와도 저절로 복구되지 않는다.
 * 넥슨이 그 시간에 실제로 낡은 값을 주는지는 아직 관측하지 못했다(`Claude/NEXON-API-OBSERVED.md`
 * `NEXON-API#5`). 틀렸을 때의 값이 커서 관측 전까지 믿지 않는다. 15분 + 여유 5분이다.
 */
const RESET_WINDOW_MS = 20 * 60 * 1000;

/**
 * 지금이 KST 목요일 00:00~00:20 또는 KST 매월 1일 00:00~00:20 인가. 끝은 포함하지 않는다.
 *
 * ★ 경계 계산은 기존 KST 유틸에 맡긴다 — 목요일 규칙은 `getWeekStart` 하나가 소유한다.
 */
export function isInResetWindow(now: Date): boolean {
  const at = now.getTime();
  const monthStart = kstMoment(`${kstDayKey(now).slice(0, 7)}-01`, 0);
  return (
    at - getWeekStart(now).getTime() < RESET_WINDOW_MS ||
    at - monthStart.getTime() < RESET_WINDOW_MS
  );
}
