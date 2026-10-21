/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 소요 시간 — **합치기**(총 · 남음)와 **나누기**(총 시간 → 보스별)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 원문(2026-10-21): *"그리고 총 진행 시간도 맨위에 뜨게 바꾸고. !숙제에도 대략적으로
 * 보게 해주고 남은 시간. 아예 총 진행시간을 입력하면 알아서 분배해주는 기능을 넣어주던가"*
 *
 * 보스 **한 판**의 분은 이 파일이 정하지 않는다 — 우선순위(묶음 > 참여자 배율 추정 > 폴백)는
 * `boss-duration-estimate.ts` 의 `resolveBossDuration` 한 곳이 소유하고, 여기는 그 결과를
 * **더하고 · 나누고 · 적는** 일만 한다. 웹(`/boss-plans`)과 봇(`!숙제` 카드·착지·평문 ·
 * `!결정석`)이 같은 수를 말해야 하므로 환경 중립(React·DB 없음)으로 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. "남은 시간"의 모집단 — `countsTowardRemainingTime` 하나
 * ─────────────────────────────────────────────────────────────────────────────
 * `!숙제` 의 "남은 보스"(`fetchRemainingBosses`)와 **같은 집합**이어야 한다. 2026-10-08 에
 * 카드 머리 줄과 줄이 서로 다른 모집단에서 나와 115억 vs 130억이 됐던 사고가 있다.
 * 그 집합은: 켜진 계획 ∧ 이번 주기 미클리어 ∧ 추적 중·사라지지 않은 캐릭터 ∧
 *   **주기 = 주간 또는 시즌**(같은 목요일 시계) ∧ **결정석 시세를 안다**(§1.3 D4 — 시세를
 *   모르는 보스는 `!숙제` 목록에서 빠지므로 시간에서도 빠진다. 그래야 `95건` 과 `약 31시간`
 *   이 같은 95건을 말한다. 2026-10-21 현재 추적 보스 중 시세 미확인은 0건).
 * 앞의 셋(켜짐·미클리어·추적)은 부르는 쪽의 질의가 이미 거르고, 뒤의 둘을 이 함수가 본다.
 * ★ 월간은 빠진다 — `!숙제` 가 주간만 말하고(`RemainingBossScope` 머리말) 월간은 `!검마`
 *   의 것이다. `/boss-plans` 의 "총"도 같은 범위로 센다(총 − 남음 = 이번 주 끝낸 것).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. 나누기 — **본캐 배율의 역수 비율대로** (사람이 고친 값의 비율이 아니다)
 * ─────────────────────────────────────────────────────────────────────────────
 *     무게(보스) = 20 × 110 / (그 줄의 인원 × 파티 효율 × 본캐 배율(보스)), **가두지 않음** ← `ratioWeight`
 *     새 분(보스) = 무게(보스) × 넣은 총 ÷ 무게 합   → 반올림 → 1~20 으로 가둠
 *     → 반올림·가둠으로 생긴 차이를 1분씩 다시 나눠 **합 = 넣은 총** 으로 맞춘다.
 * 소요 시간은 배율에 반비례한다(`boss-duration-estimate.ts` 머리말 1절). 캐릭터 세기 k 는
 * 모든 보스에 같은 배수라 비율에서 지워진다 — 그래서 무게는 본캐 배율만 본다.
 * ★ **가두지 않은 값을 쓴다.** 2026-10-21 첫 판은 가둔 기본 분(계단식)을 무게로 써서, 20 벽에
 *   붙은 상위 보스들(익칼·익대적·하발…)이 전부 같은 무게가 됐다 — 실제로는 배율이 50%~110%
 *   로 두 배 넘게 차이 난다.
 * ★ **왜 "지금 값"이 아니라 배율인가.** 첫 판(같은 날 오후)은 지금 쓰이는 값
 *   (사람이 고친 값 ?? 기본값)의 비율로 나눴다. 그러면 한 보스를 손으로 잘못 넣어 둔 것
 *   (예: 하진힐 20분)이 다음 분배에도 그대로 **비율로 살아남고**, 분배를 여러 번 누를수록
 *   반올림 오차가 쌓인다(경로 의존). 배율의 비율이면 같은 보스 목록 · 같은 총에 **언제나
 *   같은 답**이 나온다. 사람이 고친 값은 분배가 **덮어쓴다** — 화면이 저장 전에
 *   미리보기로 그 사실(지금 → 새 값)을 보여 준다.
 * ★ 비율인 이유(같은 양을 빼지 않는 이유): 캐릭터가 세지면 **모든 보스의 시간이 같은
 *   배수로 줄어** 보스 사이 간격도 같은 비율로 준다. 같은 양을 빼면 1~2분짜리 보스가
 *   바닥(1분)에 먼저 박히고, 박힌 만큼을 다른 보스가 떠안아 순서가 뒤집힌다.
 * ★ 배율이 없는 보스(시세 미확인 — 1절 범위에서는 이미 빠진다)는 `DEFAULT_RUN_MINUTES`
 *   를 무게로 쓴다. `resolveBossDuration` 이 그 보스에 실제로 쓰는 값과 같은 자다.
 * ★ 먼저 **water-filling** — 벽(1·20)에 닿은 칸은 벽에 두고 남은 총을 나머지에 무게
 *   비례로 나눈다(λ 이분 탐색, `scaledIdeal`). 벽에 막힌 몫을 고르게 흩으면 비례가 깨진다.
 * ★ 그다음 정수 맞추기는 **최대 잉여법**이고, 동점·순서는 **무게가 큰 칸 ≥ 작은 칸**을
 *   지키도록 정했다(단조성). 내림한 뒤 모자란 분을 소수부가 큰 칸부터(같으면 무게가 큰
 *   칸부터, 그다음 입력 순서) 1분씩 준다. 상·하한에 닿은 칸은 건너뛴다 — 같은 입력에
 *   같은 답이 나온다.
 * ★ **못 맞추는 총은 저장하지 않는다**: 보스 n 개의 합은 `n × MIN` ~ `n × MAX` 밖으로 못
 *   간다(보스 3개에 100분 → 20 × 3 = 60 이 끝). 그때는 `out-of-range` 와 **가능한 범위**를
 *   돌려주고, 화면은 그 범위를 문장으로 말한다. 첫 판은 전부 벽에 세워 `capped` 로
 *   돌려줬지만, "넣은 값과 다른 합이 저장된다"는 것은 사람이 넣은 숫자를 조용히 바꾸는
 *   일이라 막는 쪽으로 바꿨다(발주 브리프: "범위 밖이면 저장하지 말고 범위를 알려 준다").
 */

import { getBossEntry } from "@/lib/boss-master";
import {
  type CharacterBossDuration,
  type CharacterBossMinutes,
  characterRowMinutes,
  normalizePartySize,
  partyRatioFactor,
  relativeDurationWeight,
} from "@/lib/domain/boss-duration-estimate";
import {
  DEFAULT_RUN_MINUTES,
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
} from "@/lib/domain/run-grouping";
import type { BossCycle } from "@/types/domain";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 모집단 · 한 보스의 분
// ─────────────────────────────────────────────────────────────────────────────

/** 주간 시간 합에 드는 주기인가. 시즌은 주간과 같은 목요일 시계다(§1). */
export function isWeeklyTimeCycle(cycle: BossCycle): boolean {
  return cycle === "weekly" || cycle === "season";
}

/**
 * ★ **"남은 시간"·"총 시간"에 드는 보스인가** — 머리말 1절. 켜짐·미클리어·추적은 부르는
 *   쪽이 거른다(총 시간은 미클리어 조건만 빼고 같은 함수를 쓴다).
 */
export function countsTowardRemainingTime(input: {
  readonly cycle: BossCycle;
  readonly crystalPriceMeso: number | null;
}): boolean {
  return isWeeklyTimeCycle(input.cycle) && input.crystalPriceMeso !== null;
}

/**
 * 캐릭터 맥락(묶음 없음)에서 보스 한 판의 분 — **그 줄의 인원으로 친 시간**. `/boss-plans`
 * 와 `!숙제` 가 **같은 함수**로 낸다(= 사람이 넣은 값 ?? 20×110/(n × k × 본캐 배율) —
 * `boss-duration-estimate.ts` 머리말 3절 `characterRowMinutes`).
 * ★ `bossMinutes` 는 그 캐릭터의 **모든** 사람 값이어야 한다 — k 를 거기서 읽는다.
 * ★ `rowPartySize` = 그 줄의 인원(`character_boss_plans.default_party_size`). 1 이면 솔로.
 */
export function characterBossMinutes(
  bossDifficultyId: string,
  bossMinutes: CharacterBossMinutes | null,
  rowPartySize: number,
): number {
  return characterRowMinutes(bossDifficultyId, bossMinutes, rowPartySize);
}

/** 계획 줄들 → 그 캐릭터의 사람 값 지도. **켜짐과 무관하게** 전부(서버 `loadCharacterBossMinutes` 와 같다). */
export function bossMinutesFromPlans(
  plans: readonly DurationPlanLike[],
): CharacterBossMinutes {
  const out: Record<string, CharacterBossDuration> = {};
  for (const plan of plans) {
    if (plan.durationMinutes !== null) {
      out[plan.bossDifficultyId] = {
        minutes: plan.durationMinutes,
        partySize: normalizePartySize(plan.defaultPartySize),
      };
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 적기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `약 45분` · `약 2시간` · `약 3시간 20분`. **"약"을 늘 붙인다** — 기본값은 배율 어림이고,
 * 사람이 고친 값도 "보통 이 정도"다. 0 이하는 `약 0분`(부르는 쪽이 대개 빈 상태로 가른다).
 */
export function formatApproxDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `약 ${String(minutes)}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `약 ${String(hours)}시간`
    : `약 ${String(hours)}시간 ${String(rest)}분`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 합치기 — 캐릭터 하나의 총 · 남음
// ─────────────────────────────────────────────────────────────────────────────

/** `summarizeCharacterDurations` 가 읽는 계획 한 줄의 최소 모양(`CharacterBossPlan` 이 맞는다). */
export interface DurationPlanLike {
  /** 그 줄의 인원(`character_boss_plans.default_party_size`). 없거나 비정상이면 1. */
  readonly defaultPartySize: number;
  readonly bossDifficultyId: string;
  readonly isActive: boolean;
  readonly isCleared: boolean;
  /** 사람이 고친 값(그 줄의 인원으로 친 시간). `null` = 추정(k 보정 ?? 본캐 기본값)을 따른다. */
  readonly durationMinutes: number | null;
}

export interface CharacterDurationSummary {
  /** 1절 범위의 켜진 보스 수(이번 주 클리어 포함). 분배의 대상이 이 보스들이다. */
  readonly count: number;
  /** 그 보스들의 분 합. */
  readonly totalMinutes: number;
  /** 그중 이번 주 미클리어 수 — `!숙제` 의 "남은 N개"와 같은 모집단. */
  readonly remainingCount: number;
  /** 그중 이번 주 미클리어의 분 합 — `!숙제` 의 `totalMinutes` 와 같은 규칙. */
  readonly remainingMinutes: number;
  /** 분배 대상 보스 id. 입력 순서 그대로. */
  readonly bossDifficultyIds: readonly string[];
}

/**
 * ★ **캐릭터 하나의 "총 진행 시간"과 "남은 시간"** — 머리말 1절의 모집단을 한 번만 적는다.
 *   `!숙제`(`bot-repo.fetchRemainingBosses`)와 **같은 판정**이다:
 *     켜짐(`isActive`) ∧ 보스 마스터에 있음 ∧ 주간·시즌(마스터의 주기) ∧ 시세를 앎
 *     → 분은 `characterBossMinutes`(캐릭터 값 > k 보정 추정 > 본캐 기본값).
 *   봇은 거기에 미클리어를 더해 거르고, 여기는 그것을 `remaining*` 로 따로 센다.
 * ★ 주기와 시세는 **보스 마스터에서** 읽는다(봇과 같은 출처). 계획 행의 `cycle` 은 뷰가 낸
 *   값이라 보통 같지만, 같은 답을 내야 하는 두 곳이 서로 다른 칸을 보면 언젠가 갈라진다.
 * ★ 추적 해제·사라진 캐릭터는 부르는 쪽이 거른다(체크리스트 명단 · 봇의 임베드 조건).
 */
export function summarizeCharacterDurations(
  plans: readonly DurationPlanLike[],
  now?: Date,
  /**
   * 그 캐릭터의 **모든** 사람 값(꺼 둔 계획 포함) — 세기 k 를 읽는 모집단. 생략하면
   * `plans` 에서 만든다. `plans` 가 켜진 것만 담은 목록이면(체크리스트) 반드시 넘겨야
   * 봇(`fetchRemainingBosses` — 임베드가 전부 싣는다)·서버와 같은 k 가 나온다.
   */
  allBossMinutes?: CharacterBossMinutes,
): CharacterDurationSummary {
  let count = 0;
  let totalMinutes = 0;
  let remainingCount = 0;
  let remainingMinutes = 0;
  const ids: string[] = [];
  // k 는 켜짐과 무관하게 그 캐릭터의 모든 사람 값에서 읽는다(서버와 같은 모집단).
  const bossMinutes = allBossMinutes ?? bossMinutesFromPlans(plans);
  for (const plan of plans) {
    if (!plan.isActive) continue;
    const entry = getBossEntry(plan.bossDifficultyId, now);
    if (entry === undefined) continue;
    if (
      !countsTowardRemainingTime({
        cycle: entry.cycle,
        crystalPriceMeso: entry.crystalPriceMeso,
      })
    ) {
      continue;
    }
    const minutes = characterBossMinutes(
      plan.bossDifficultyId,
      bossMinutes,
      plan.defaultPartySize,
    );
    count += 1;
    totalMinutes += minutes;
    ids.push(plan.bossDifficultyId);
    if (!plan.isCleared) {
      remainingCount += 1;
      remainingMinutes += minutes;
    }
  }
  return {
    count,
    totalMinutes,
    remainingCount,
    remainingMinutes,
    bossDifficultyIds: ids,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 나누기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **분배의 무게 = 본캐 배율의 역수(가두지 않음)**(머리말 2절). 사람이 고친 값은 **읽지 않는다.**
 *   배율이 없는 보스는 `DEFAULT_RUN_MINUTES` — `resolveBossDuration` 의 마지막 방어선과 같은 자.
 */
export function ratioWeight(bossDifficultyId: string, partySize = 1): number {
  // 그 줄의 인원 n 이면 시간 ∝ 1/(n × 효율(n) × 본캐 배율). 캐릭터 세기는 넣지 않는다 —
  // 총 시간 나누기는 "보스 사이의 기본 모양"을 늘이고 줄이는 일이라 사람 값을 읽지 않는다.
  const weight = relativeDurationWeight(bossDifficultyId);
  return weight === null ? DEFAULT_RUN_MINUTES : weight / partyRatioFactor(partySize);
}

export interface DurationShare {
  readonly id: string;
  /**
   * 비율의 무게. 화면·서버는 `ratioWeight(id)`(본캐 배율의 역수)를 넣는다 — 머리말 2절.
   * 함수가 무게를 주입받는 이유는 가짜 표로 검증하기 위해서다.
   */
  readonly weight: number;
}

export type DurationDistribution =
  | {
      /** 합이 넣은 값과 정확히 같다. 벽 안의 총이면 언제나 이것이다. */
      readonly kind: "exact";
      readonly minutes: ReadonlyMap<string, number>;
      readonly total: number;
    }
  | {
      readonly kind: "invalid";
      /**
       * - `empty` = 나눌 보스가 없다
       * - `not-positive` = 1 이상의 정수가 아니다
       * - `out-of-range` = `minTotal ~ maxTotal`(보스 수 × 1~20) 밖이다 — **저장하지 않는다**
       */
      readonly reason: "empty" | "not-positive" | "out-of-range";
      /** 이 보스 목록으로 만들 수 있는 합의 범위. `empty` 면 0. */
      readonly minTotal: number;
      readonly maxTotal: number;
    };

export interface DurationBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * 무게 비례 나누기의 실수값 — **스케일 λ 를 이분 탐색**해 `Σ clamp(λ·무게, min, max) = 총`
 * 이 되게 한다(water-filling 과 같은 답). 넣은 총이 `n × min ~ n × max` 안이라는 것은
 * 부르는 쪽이 이미 확인했다.
 * ★ 왜 이분 탐색인가(2026-10-21 재작업 2): 라운드마다 넘친 칸·모자란 칸을 고정하는 방식은
 *   한 라운드에 두 방향을 함께 고정하면 하한 고정 뒤 상한 칸을 다시 보지 않아, 전 칸이 고정된
 *   뒤 남은 차이를 무게 없이 1분씩 흩었다 → 익칼 19 < 노림 20 역전(총 86). λ 하나로 모든
 *   칸을 정하면 `clamp(λ·w)` 가 w 에 대해 단조라 **무게가 큰 칸 ≥ 작은 칸**이 구조로 보장된다.
 */
function scaledIdeal(
  weights: readonly number[],
  total: number,
  bounds: DurationBounds,
): number[] {
  const clampTo = (value: number) =>
    Math.min(bounds.max, Math.max(bounds.min, value));
  const sumAt = (lambda: number) =>
    weights.reduce((sum, weight) => sum + clampTo(lambda * weight), 0);
  const minWeight = Math.min(...weights);
  let lo = 0;
  let hi = bounds.max / minWeight; // 이 λ 에서 전 칸이 상한 — 합이 최대.
  for (let step = 0; step < 200; step += 1) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) < total) lo = mid;
    else hi = mid;
  }
  return weights.map((weight) => clampTo(hi * weight));
}

/**
 * ★ **나누기의 유일한 구현**(머리말 2절). 경계는 기본이 `RUN_DURATION_MIN/MAX` — 숫자를
 *   여기에 다시 적지 않는다(하한이 5 → 1 로 바뀐 날 이 파일은 고칠 것이 없었다).
 */
export function distributeBossDurations(
  items: readonly DurationShare[],
  requestedTotal: number,
  bounds: DurationBounds = { min: RUN_DURATION_MIN, max: RUN_DURATION_MAX },
): DurationDistribution {
  const n = items.length;
  const minTotal = n * bounds.min;
  const maxTotal = n * bounds.max;
  if (n === 0) {
    return { kind: "invalid", reason: "empty", minTotal: 0, maxTotal: 0 };
  }
  if (!Number.isInteger(requestedTotal) || requestedTotal < 1) {
    return { kind: "invalid", reason: "not-positive", minTotal, maxTotal };
  }
  // 벽 밖이면 저장할 답이 없다 — 범위를 돌려주고 부르는 쪽이 말한다.
  if (requestedTotal > maxTotal || requestedTotal < minTotal) {
    return { kind: "invalid", reason: "out-of-range", minTotal, maxTotal };
  }

  const clamp = (value: number) =>
    Math.min(bounds.max, Math.max(bounds.min, value));

  // 무게가 0 이하인 칸(있을 수 없지만)은 1 로 본다 — 0 으로 나누지 않게.
  const weights = items.map((item) =>
    Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
  );
  /*
    ★ **water-filling**(2026-10-21 교차 검증 · 재작업 2). 벽(1·20)에 닿은 칸은 벽에 두고 남은
      총을 나머지에 무게 비례로 나눈 실수값 — `scaledIdeal`(λ 이분 탐색). 예전에는 한 번
      나눈 뒤 가두고 벽에 막혀 남은 양을 1분 걸음이 **고르게** 흩어 5보스 총 60 에서
      하세렌·하루시드·이지윌이 7·7·6 으로 같아졌다(배율은 수십 배 차이).
  */
  const ideal = scaledIdeal(weights, requestedTotal, bounds);

  /*
    ★ **정수로 맞추기 — 최대 잉여법 + 단조성**. 먼저 내림(벽 안이라 min 이상이다), 모자란
      분은 **소수부가 큰 칸부터**, 같으면 **무게가 큰 칸부터** 1분씩 준다. 무게가 큰 칸 a 와
      작은 칸 b 에서 이상값은 a ≥ b 이므로: 내림이 a > b 면 b 가 1 받아도 a 를 넘지 못하고,
      내림이 같으면 a 의 소수부 ≥ b 의 소수부라 a 가 먼저 받는다 → **a ≥ b 가 언제나 유지된다.**
    ★ 모자란 분 수 = Σ 소수부(정수)이고 소수부가 0 보다 큰 칸은 그보다 많거나 같으므로,
      상한에 붙은 칸(소수부 0)을 건드리지 않고 끝난다. 부동소수점 오차로 넘치거나 모자라는
      극단은 아래 방어 걸음이 같은 순서 규칙으로 맞춘다.
  */
  const values = ideal.map((value) => clamp(Math.floor(value + 1e-9)));
  const order = ideal
    .map((value, index) => ({
      index,
      frac: value - (values[index] ?? 0),
      weight: weights[index] ?? 0,
    }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.index - b.index);

  let total = values.reduce((sum, value) => sum + value, 0);
  /*
    모자라면 순서 앞에서부터(+1), 넘치면 뒤에서부터(−1) — **한 칸에 한 번씩** 차례로 간다.
    (같은 칸에 거듭 주면 단조성이 깨진다.) 벽에 닿은 칸은 건너뛴다. 정상이면 한 바퀴 안에
    끝나고, 바깥 반복은 부동소수점 극단을 위한 방어선이다.
  */
  for (
    let round = 0;
    total !== requestedTotal && round <= bounds.max - bounds.min;
    round += 1
  ) {
    const up = total < requestedTotal;
    const sequence = up ? order : [...order].reverse();
    for (const { index } of sequence) {
      if (total === requestedTotal) break;
      const value = values[index] ?? 0;
      if (up ? value >= bounds.max : value <= bounds.min) continue;
      values[index] = value + (up ? 1 : -1);
      total += up ? 1 : -1;
    }
  }
  // 방어선 — 벽 검사 덕에 닿지 않는다. 닿으면 넣은 총을 만들 수 없다는 뜻이다.
  if (total !== requestedTotal) {
    return { kind: "invalid", reason: "out-of-range", minTotal, maxTotal };
  }

  return {
    kind: "exact",
    minutes: new Map(items.map((item, index) => [item.id, values[index] ?? 0])),
    total,
  };
}

/**
 * 화면·서버가 부르는 입구 — 보스 id 목록과 총을 받아 **(줄의 인원 × 본캐 배율)의 역수
 * 비율로** 나눈다. `partySizeOf` 는 그 줄의 인원(생략하면 전부 1인).
 */
export function distributeByRatio(
  bossDifficultyIds: readonly string[],
  requestedTotal: number,
  partySizeOf: (bossDifficultyId: string) => number = () => 1,
): DurationDistribution {
  return distributeBossDurations(
    bossDifficultyIds.map((id) => ({ id, weight: ratioWeight(id, partySizeOf(id)) })),
    requestedTotal,
  );
}
