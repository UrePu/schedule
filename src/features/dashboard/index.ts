/**
 * 대시보드 기능의 공개 표면.
 *
 * ⚠️ 서버 전용 코드(`./server/*`)는 **여기서 내보내지 않는다.** 클라이언트 컴포넌트가
 *    이 배럴을 import 했을 때 `server-only` 모듈이 딸려 들어가면 빌드가 깨진다.
 *    서버 컴포넌트는 `@/features/dashboard/server/dashboard-repo` 로 직접 import 한다.
 */

export {
  AccountSettingsButton,
  Dashboard,
  MyPartiesCard,
  WeekSummaryCard,
  WeeklyIncomeCard,
} from "./components";
export type {
  AccountSettingsButtonProps,
  DashboardProps,
  MyPartiesCardProps,
  WeekSummaryCardProps,
  WeeklyIncomeCardProps,
} from "./components";
