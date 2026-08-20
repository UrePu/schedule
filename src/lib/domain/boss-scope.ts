/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 앱이 다루는 보스 주기 — **일간 보스 제외의 유일한 소유자**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-18): *"일간보스는 추적 안해. 일간보스는 전부 제외"*
 *
 * ── 왜 한 파일인가 ───────────────────────────────────────────────────────────
 * 화면마다 `cycle !== "daily"` 를 적으면 반드시 하나를 빠뜨린다. 규칙은 여기 한 줄이고,
 * **적용 지점은 전부 서버 쿼리 계층**이다. 클라이언트 컴포넌트는 이 판정을 다시 하지
 * 않는다 — 서버가 이미 걸러 준 것만 받는다.
 *
 * ── 거르는 지점 (전부 server-only, 이 목록이 전부다) ─────────────────────────
 *  1. `@/lib/boss-master` 의 `getTrackedBossCatalog()`
 *     → 코드 상수에 `TRACKED_BOSS_CYCLES` 필터.
 *       **보스를 고를 수 있는 모든 화면의 단일 관문**이다(런 작성기, 파티 보스 편집,
 *       계획 추가 모달이 전부 이 함수 하나를 통과한다).
 *       ⚠️ 2026-08-18 에 DB 조회(`v_boss_catalog` + `GET /api/schedule/bosses`)에서
 *          코드 상수로 내려왔다. 거르는 **지점**은 그대로 하나이고 위치만 바뀌었다.
 *  2. `boss-plan-repo` 의 계획 조회 2곳
 *     → `v_character_boss_plan_status` 에 `.in("cycle", TRACKED_BOSS_CYCLES)`.
 *       체크리스트·계획 화면·진행률 집계가 전부 이 행 집합에서 나온다.
 *  3. `sync-scheduler.syncCharacterScheduler()`
 *     → 넥슨 응답의 `bossDaily` 항목을 **저장 전에** 버린다(쓰기 측 차단).
 *  4. `income/server/crystal-scope.ts`
 *     → 이미 쌓인 일간 클리어를 수익·90개 집계에서 뺀다(읽기 측 보정).
 *
 * ── 이미 쌓인 일간 기록은 지우지 않는다 ─────────────────────────────────────
 * 표시와 집계에서 빼는 것으로 충분하다. 과거 데이터 파기는 되돌릴 수 없고 지시받지 않았다.
 * 그래서 (4) 의 보정이 필요하다 — (3) 이 새 유입만 막기 때문이다.
 *
 * ── 12개 카운터는 이 파일과 무관하다 ────────────────────────────────────────
 * `weekly_boss_clear_count` / `weekly_boss_clear_limit_count` 는 넥슨이 세어 준 값이고
 * 일간과 원장이 분리돼 있다(§1). 일간을 빼도 그 숫자는 움직이지 않으며, 움직이면 버그다.
 */

import type { BossCycle } from "@/types/domain";

/** 이 앱이 추적하는 주기. PostgREST `.in()` 에 그대로 넘긴다. */
export const TRACKED_BOSS_CYCLES: readonly BossCycle[] = ["weekly", "monthly"];

/** 범위 밖 주기. 지금은 일간 하나뿐이지만 목록으로 둬야 판정이 한 군데 남는다. */
export const UNTRACKED_BOSS_CYCLES: readonly BossCycle[] = ["daily"];

/**
 * **확실히 일간인 것만** true 다.
 *
 * `null`(주기 미상)은 false 다. `boss_clears.cycle` 은 클리어 전까지 비어 있고, 넥슨이
 * 새 주기를 추가하면 매핑이 null 로 떨어진다. 모르는 것을 일간으로 단정해 지우면
 * 사용자의 기록이 조용히 사라진다 — 모를 때는 남기는 쪽이 안전하다.
 */
export function isUntrackedBossCycle(
  cycle: BossCycle | null | undefined,
): boolean {
  return cycle === "daily";
}

/** 위의 반대. 주기 미상은 **추적 대상**으로 본다(같은 이유). */
export function isTrackedBossCycle(
  cycle: BossCycle | null | undefined,
): boolean {
  return !isUntrackedBossCycle(cycle);
}

/**
 * 넥슨 스케줄러 원문 `cycle`(`bossDaily` / `bossWeekly` / `bossMonthly`, §1.0)이
 * 일간인가. 동기화가 **매핑 RPC 를 부르기 전에** 거르는 데 쓴다 — 매핑까지 간 다음에
 * 버리면 항목마다 DB 왕복이 한 번씩 낭비된다.
 *
 * ⚠️ 넥슨 호출 수는 줄지 않는다. 스케줄러는 캐릭터당 1콜이고 응답에 전부 실려 온다.
 *    줄어드는 것은 **DB 왕복과 저장량**이다.
 */
export function isUntrackedNexonCycle(rawCycle: string | null): boolean {
  return rawCycle === "bossDaily";
}

/**
 * 화면이 "우리 숫자는 실제보다 낮다"를 말할 때 쓰는 문장 (§1.3 D2).
 *
 * 일간이 범위 밖이라 90개 천장 집계는 **하한값**이다. 천장 경고가 조용히 과소 보고하면
 * 없느니만 못하므로, 경고를 그리는 화면은 이 문장을 반드시 함께 그린다.
 */
export const TRACKED_SCOPE_NOTE =
  "일간 보스는 추적하지 않습니다. 아래 숫자는 주간·월간 보스만 센 값이라 실제 결정석 개수보다 낮습니다.";

/**
 * "이번 주기 안에 이미 잡았다"를 그 보스의 **주기 이름으로** 말한다.
 *
 * 발주자(2026-08-20): *"익스트림 검은마법사. 하드검은마법사 월간은 태그를 이번주 완료가
 * 아니라 이번달 완료로 변경해야."*
 *
 * 배지 문구를 `이번 주 완료` 로 못박아 두면 **월간 보스에서 거짓말이 된다** — 검은 마법사는
 * 한 달에 한 번이라, 주가 바뀌어도 배지는 계속 켜져 있어야 맞고 그 사실을 문구가 말해야
 * 한다. 판정(`isCleared`)은 이미 주기별로 이뤄지고 있었고, 화면 문구만 따라가지 못했다.
 *
 * ★ 문구를 여기 두는 이유: 같은 배지가 두 화면(보스 계획 · 일정 등록 폼)에 있다. 한쪽만
 *   고치면 같은 보스가 화면마다 다른 말을 한다.
 */
export function clearedPeriodLabel(cycle: BossCycle): string {
  if (cycle === "monthly") return "이번 달 완료";
  if (cycle === "daily") return "오늘 완료";
  return "이번 주 완료";
}
