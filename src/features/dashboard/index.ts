/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 기능에는 **화면이 없다** — 여러 화면이 함께 쓰는 **집계 읽기**만 남았다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-20 발주 지시로 대시보드 화면이 해체되면서 컴포넌트는 전부 이사했다:
 *   `AccountSettingsButton` `MyPartiesCard` `WeekSummaryCard` → `@/features/etc`
 *   `WeeklyIncomeCard` `UpcomingRunsCard` `Dashboard`         → 삭제(아래)
 *
 * 그런데 `server/dashboard-repo.ts` 는 **남는다.** 이름이 대시보드일 뿐 실제로는
 * "여러 화면이 공유하는 집계 읽기"이고, 지금 이 순간 다섯 곳이 쓴다:
 *   `fetchCrystalIncomeSummary` → 카톡 `!결정석` · 수익 화면
 *   `fetchWeeklyIncome`         → `income-repo`
 *   `fetchMyParties`            → `/boss-plans` · `GET /api/schedule/parties/mine`
 * 이름을 바꾸면 다섯 곳이 함께 움직여야 하는데, 그 이름이 지금 아무것도 오도하지
 * 않으므로(디렉터리가 화면을 주장하지 않는다) 값을 치를 이유가 없다.
 *
 * ⚠️ 서버 전용 코드(`./server/*`)는 **여기서 내보내지 않는다.** 클라이언트 컴포넌트가
 *    이 배럴을 import 했을 때 `server-only` 모듈이 딸려 들어가면 빌드가 깨진다.
 *    서버 컴포넌트는 `@/features/dashboard/server/dashboard-repo` 로 직접 import 한다.
 */

/**
 * 칸 계산은 순수 함수라 클라이언트에 실려도 새는 것이 없다 — 타입만 공개한다.
 * 계산 자체(`buildWeeklyBossCapacity`)는 서버 repo 만 부르므로 배럴에 올리지 않는다.
 */
export type {
  CharacterWeeklyBossSlots,
  WeeklyBossCapacity,
} from "./lib/weekly-boss-capacity";
