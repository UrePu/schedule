import { TRACKED_BOSS_CYCLES } from "@/lib/domain/boss-scope";

import type {
  CharacterBossPlan,
  CharacterPlanResponse,
  CharacterWeeklyProgress,
} from "../types";
import { tallyPlanConflicts } from "./plan-conflict";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 계획의 **낙관적 변환** — 화면이 서버를 기다리지 않고 먼저 반영하는 값
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 파일이 존재하는 이유는 **어긋남을 구조적으로 막기 위해서**다.
 *
 * 계획 화면에는 목록(줄)과 진행 상황 카드(숫자)가 나란히 있고, 둘은 같은 원장에서
 * 나온다. 낙관적으로 줄만 바꾸면 `켜져 있음 12개` 옆에서 `주간 보스 11개` 라고 말하는
 * 화면이 나온다 — **어긋난 숫자는 느린 것보다 나쁘다.**
 *
 * 그래서 여기서는 줄을 고친 다음 **그 줄들로부터 숫자를 다시 센다.** 서버가 하는 일과
 * 같은 순서다:
 *   - 뷰 `v_character_weekly_boss_progress` (마이그레이션 `…_character_boss_plans.sql`)
 *   - repo 의 `tallyTrackedPlans()` (일간 제외분 `*_total` 5개)
 * 두 곳의 집계식을 **한 글자씩 옮겨 적었다.** 아래 `recountProgress()` 의 주석이 어느
 * 줄이 어느 원본에 대응하는지 짚는다.
 *
 * ⚠️ **12개 상한값(`weeklyLimit`)은 옮겨 적지 않는다.** 그것만은 DB 함수
 *    `weekly_crystal_sell_limit()` 가 낸 값이고, 낙관적 변환은 그 값을 **그대로 들고
 *    간다.** 코드에 12 를 적는 순간 규칙이 두 벌이 된다(CLAUDE.md §1).
 *
 * ⚠️ 낙관적 값은 **잠깐이다.** `onSettled` 의 무효화가 곧 서버 값으로 덮으므로, 여기
 *    계산이 뷰와 미세하게 달라도 영구히 남지 않는다. 그래도 옮겨 적은 것이 맞아야
 *    하는 이유는 그 "잠깐" 동안 사용자가 보는 것이 이 값이기 때문이다.
 */

/** 12개 카운터에 들어가는 주기. 뷰의 `cycle = 'weekly'` 필터와 같은 한 줄. */
const WEEKLY_CYCLE = "weekly";

/**
 * 계획 행들로부터 진행 상황을 **다시 센다.**
 *
 * `base` 는 서버가 준 마지막 진행 상황이다. 여기서 가져다 쓰는 것은 두 가지뿐이다.
 * - `weeklyLimit` — DB 함수의 값. 우리가 만들지 않는다.
 * - 신원(`characterId` / `characterName` / `worldName` / `weekKey`) — 계획을 켜고 꺼도
 *   바뀌지 않는다.
 *
 * 나머지는 전부 `plans` 에서 다시 나온다.
 */
export function recountProgress(
  base: CharacterWeeklyProgress,
  plans: readonly CharacterBossPlan[],
): CharacterWeeklyProgress {
  /*
   * 일간은 범위 밖이다(2026-08-18 발주자 지시). 서버 조회가 이미 걸러 보내므로 보통은
   * 한 건도 없지만, 거르는 규칙을 여기서도 같은 상수로 적어 두면 나중에 일간이 다시
   * 들어와도 이 계산이 조용히 틀리지 않는다.
   */
  const tracked = plans.filter((plan) =>
    TRACKED_BOSS_CYCLES.includes(plan.cycle),
  );

  const active = tracked.filter((plan) => plan.isActive);
  const activeWeekly = active.filter((plan) => plan.cycle === WEEKLY_CYCLE);

  // repo `tallyTrackedPlans()` — 켜져 있는 것만 센다.
  const plannedTotal = active.length;
  const clearedTotal = active.filter((plan) => plan.isCleared).length;
  const remainingTotal = plannedTotal - clearedTotal;
  const inactiveTotal = tracked.length - active.length;

  // 뷰의 `filter (where s.is_active and s.cycle = 'weekly' …)` 세 줄.
  const plannedWeekly = activeWeekly.length;
  const clearedWeekly = activeWeekly.filter((plan) => plan.isCleared).length;
  const remainingWeekly = plannedWeekly - clearedWeekly;
  const plannedMonthly = active.filter(
    (plan) => plan.cycle === "monthly",
  ).length;

  // 판정은 `plan-conflict.ts` 하나에만 있다 — repo 도 같은 함수를 부른다.
  const conflicts = tallyPlanConflicts(tracked);

  const weeklyLimit = base.weeklyLimit;

  return {
    ...base,
    plannedTotal,
    plannedWeekly,
    plannedMonthly,
    clearedTotal,
    clearedWeekly,
    remainingTotal,
    remainingWeekly,
    inactiveTotal,
    conflictDivergedCount: conflicts.diverged,
    conflictPendingCount: conflicts.pending,
    // 뷰: `planned_weekly > weekly_crystal_sell_limit()`
    weeklyOverLimit: plannedWeekly > weeklyLimit,
    // 뷰: `greatest(limit - planned_weekly, 0)`
    weeklySlotsRemaining: Math.max(weeklyLimit - plannedWeekly, 0),
  };
}

/** 한 행만 바꾸고 진행 상황을 다시 센 번들. `plans` 의 순서는 그대로 둔다. */
function withPatchedPlan(
  bundle: CharacterPlanResponse,
  bossDifficultyId: string,
  patch: (plan: CharacterBossPlan) => CharacterBossPlan,
): CharacterPlanResponse {
  const plans = bundle.plans.map((plan) =>
    plan.bossDifficultyId === bossDifficultyId ? patch(plan) : plan,
  );
  return {
    ...bundle,
    plans,
    progress:
      bundle.progress === null ? null : recountProgress(bundle.progress, plans),
  };
}

/**
 * **켜기 / 끄기** 를 낙관적으로 반영한다.
 *
 * `manualActive` 도 함께 움직이는 것이 중요하다. 그 값이 `되돌리기` 버튼의 표시 조건이고
 * (`manualActive === null` 이면 버튼이 없다), 어긋남 판정(`plan-conflict.ts`)의 입력이다.
 * 서버 함수 `set_character_boss_plan()` 이 `manual_active` 와 `manual_set_at` 을 쓰므로
 * 여기서도 같은 두 칸을 채운다 — `manual_set_at` 이 비면 방금 켠 항목이 "게임 반영 대기"
 * 대신 "진짜 어긋남"으로 판정돼 주황 경고가 뜬다.
 *
 * ★ **꺼져 있던 행이 목록에 없을 수는 없다.** 이 경로로 켜는 새 보스(보스 추가)는 아직
 *   행이 없으므로 여기서 만들 수 없다 — 그 경우는 낙관적 적용 대상이 아니다(호출부가
 *   빈 패치를 돌려준다). 서버가 `planId` 를 만들기 때문이다(§1.4 의 번호 규칙과 같은 결).
 */
export function withPlanActive(
  bundle: CharacterPlanResponse,
  bossDifficultyId: string,
  active: boolean,
  now: string,
): CharacterPlanResponse {
  return withPatchedPlan(bundle, bossDifficultyId, (plan) => ({
    ...plan,
    isActive: active,
    manualActive: active,
    manualSetAt: now,
    /*
     * 트리거가 다시 계산하는 값이라 여기서도 같은 식으로 맞춘다:
     * `has_conflict = (manual_active is not null and manual_active <> api_registered)`.
     */
    hasConflict: plan.apiRegistered !== null && plan.apiRegistered !== active,
  }));
}

/**
 * **인원수 확정**을 낙관적으로 반영한다.
 *
 * ★ `partySize === null` 은 **기본값 1로 되돌리기**다(입력칸을 비웠을 때). 미설정이라는
 *   상태는 2026-08-19 에 사라졌으므로(`character_boss_plans.default_party_size` 가
 *   `NOT NULL DEFAULT 1`) 여기서도 서버와 **같은 값**인 1 로 접는다 — 접지 않으면 낙관적
 *   화면이 잠깐 빈 값을 그렸다가 응답으로 1 이 들어와 숫자가 튄다.
 *
 * 진행 상황 숫자는 인원수에 의존하지 않지만(뷰의 어느 집계식에도 `default_party_size`
 * 가 없다) `withPatchedPlan` 을 그대로 쓴다 — 경로를 하나로 두면 나중에 인원수가
 * 집계에 들어가도 자동으로 따라온다. 재계산 비용은 배열 한 번 훑기다.
 */
export function withPlanPartySize(
  bundle: CharacterPlanResponse,
  bossDifficultyId: string,
  partySize: number | null,
): CharacterPlanResponse {
  return withPatchedPlan(bundle, bossDifficultyId, (plan) => ({
    ...plan,
    defaultPartySize: partySize ?? 1,
  }));
}
