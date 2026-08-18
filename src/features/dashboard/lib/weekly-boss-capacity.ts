/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 주간 보스 **칸 계산** — 분모는 언제나 `추적 캐릭터 수 × 캐릭터당 상한`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-18): *"주간보스 최대 12개로 되어잇는데 이것도 그냥 간단하게
 * 추적되는 캐릭터 6개 면 6 * 12 해서 72개 최대로 해."* 그리고
 * *"천장90개로 하지말고 현재 선택된 캐릭터 갯수 위주로 몇개 보스 돌아야하는지."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 고쳐야 했던 결함
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면에 **`주간 보스 40 / 12건`** 이 찍혀 있었다. 분자는 사용자의 **모든 캐릭터를
 * 합산**한 값인데 분모는 **캐릭터 하나**의 상한이었다. 12개 상한은 캐릭터당이므로(§1)
 * 합산 분자에는 합산 분모가 붙어야 한다. 실측(2026-08-18, 추적 7명): 분모 84.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 왜 체크리스트의 `clearedWeekly` 를 쓰지 않는가 — 원장이 둘이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 같은 주에 대해 두 뷰가 **다른 값**을 낸다(실측):
 *   `v_character_weekly_boss_progress.cleared_weekly`  합계 36
 *   `v_weekly_crystal_income_by_character.weekly_clear_count` 합계 40
 * 앞의 것은 **켜져 있는 계획에 매칭된 클리어만** 세고, 뒤의 것은 결정석 원장의 클리어를
 * 전부 센다. 12칸을 실제로 소진하는 것은 **계획 여부와 무관한 클리어**이므로 이 계산은
 * 뒤쪽(결정석 원장)을 쓴다. 앞쪽을 쓰면 "계획에 없던 보스를 잡았다"가 칸을 먹지 않은 것처럼
 * 보여 남은 개수를 과대 보고한다 — 스케줄링에서 과대 보고는 못 가는 일정을 잡게 만든다.
 * 이 선택 덕분에 수익 카드의 `주간 보스` 카운터와 **같은 숫자**가 되고, 두 카드가
 * 갈라질 수 없다.
 *
 * ★ **12를 코드에 박지 않는다.** 상한의 단일 출처는 DB 의 `weekly_crystal_sell_limit()`
 *   이고 뷰가 `weekly_sell_limit` 컬럼으로 실어 준다. 그 행이 없을 때만 계획 뷰의
 *   `weeklyLimit`, 그다음 넥슨의 `weekly_boss_clear_limit_count` 로 내려간다.
 *   전부 없으면 `null`(모름)이다 — 12를 지어내지 않는다.
 *
 * ★ **캐릭터마다 상한이 다를 수 있다고 가정하지 않는다.** `weekly_crystal_sell_limit()`
 *   은 인자 없는 상수 함수라 모든 캐릭터가 같은 값을 받는다. 캐릭터별로 다른 상한을
 *   들고 다니면 코드만 복잡해지고 실제로 갈라질 일이 없다.
 */

import type { CharacterChecklist } from "@/features/boss-plans/types";

/** 결정석 원장이 센 캐릭터 한 명의 이번 주 주간 클리어. ← `v_weekly_crystal_income_by_character` */
export interface WeeklyBossClearRow {
  readonly characterId: string;
  readonly weeklyClearCount: number;
  /** ← `weekly_sell_limit`. **상한의 1순위 출처**다. */
  readonly weeklySellLimit: number | null;
}

/** 추적 캐릭터 한 명이 이번 주에 몇 칸을 남겼는가. */
export interface CharacterWeeklyBossSlots {
  readonly characterId: string;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly clearedWeekly: number;
  /** 남은 칸. 상한을 모르면 `null` — 0 이 아니다. */
  readonly remaining: number | null;
}

/** 대시보드가 "몇 개 더 돌아야 하는가"를 그릴 때 쓰는 값 전부. */
export interface WeeklyBossCapacity {
  /** 추적 중인 캐릭터 수. **0 이면 분모가 0 이라 비율을 그리지 않는다.** */
  readonly trackedCount: number;
  /** 캐릭터당 상한(보통 12). 출처가 하나도 없으면 `null`. */
  readonly perCharacterLimit: number | null;
  /**
   * `trackedCount × perCharacterLimit`. 상한을 모르거나 **추적이 0명이면 `null`** 이다.
   *
   * ★ 추적 0명에서 `0` 을 내지 않는 것이 중요하다. `0` 도 숫자라서 화면이 그대로
   *   `0 / 0` 을 그리고, 그건 분모가 없다는 사실이 아니라 "상한이 0"이라는 거짓말이다.
   *   `null` 이면 화면이 분모 없는 표시로 갈라진다.
   */
  readonly limitTotal: number | null;
  /** 추적 캐릭터가 이번 주에 잡은 주간 보스 합계. 분자다. */
  readonly clearedTotal: number;
  /** `limitTotal − clearedTotal`(음수는 0). 상한을 모르면 `null`. */
  readonly remainingTotal: number | null;
  /** 상한을 이미 채운 캐릭터가 있는가. 경고 문구의 근거. */
  readonly overLimitCount: number;
  /** 추적 캐릭터별 남은 칸. 남은 것이 많은 순 → 이름 순. */
  readonly characters: readonly CharacterWeeklyBossSlots[];
  /**
   * **추적하지 않는 캐릭터**의 이번 주 주간 클리어 수.
   *
   * 0 이 아니면 화면이 말해야 한다: 그 클리어는 결정석 수익에는 들어가지만 이 칸 계산의
   * 분자·분모 어디에도 없다(그 캐릭터의 12칸이 분모에 없으므로 분자에서도 빼는 것이 맞다).
   */
  readonly untrackedClearedCount: number;
}

/** 음수·비유한값을 0 으로 접는다. `numeric` 문자열 파싱은 호출부(repo)가 끝낸다. */
function toNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 캐릭터당 상한을 정한다. 뷰 → 계획 뷰 → 넥슨 순으로 내려가고, 전부 없으면 `null`.
 *
 * 첫 번째로 **양수**를 주는 출처를 쓴다. 0 은 "상한 없음"이 아니라 "아직 값이 없다"이며,
 * 0 을 상한으로 채택하면 분모가 0 이 되어 화면이 `40 / 0` 을 그린다.
 */
function resolvePerCharacterLimit(
  checklist: readonly CharacterChecklist[],
  rows: readonly WeeklyBossClearRow[],
): number | null {
  for (const row of rows) {
    if (row.weeklySellLimit !== null && row.weeklySellLimit > 0) {
      return row.weeklySellLimit;
    }
  }
  for (const entry of checklist) {
    const limit = entry.progress?.weeklyLimit ?? 0;
    if (limit > 0) return limit;
  }
  for (const entry of checklist) {
    const limit = entry.snapshot?.weeklyBossClearLimitCount ?? null;
    if (limit !== null && limit > 0) return limit;
  }
  return null;
}

/**
 * 추적 명단(체크리스트)과 결정석 원장의 캐릭터별 주간 클리어를 합쳐 칸 계산을 낸다.
 *
 * **추적 명단이 분모의 유일한 근거다.** 클리어가 0인 추적 캐릭터도 12칸을 갖고 있으므로
 * 반드시 목록에 남고(그 캐릭터가 곧 "더 돌아야 하는" 대상이다), 추적하지 않는 캐릭터는
 * 클리어가 있어도 분모에 12칸을 주지 않는다.
 */
export function buildWeeklyBossCapacity(
  checklist: readonly CharacterChecklist[],
  rows: readonly WeeklyBossClearRow[],
): WeeklyBossCapacity {
  const clearedByCharacter = new Map<string, number>();
  for (const row of rows) {
    clearedByCharacter.set(
      row.characterId,
      (clearedByCharacter.get(row.characterId) ?? 0) +
        toNonNegative(row.weeklyClearCount),
    );
  }

  const perCharacterLimit = resolvePerCharacterLimit(checklist, rows);
  const trackedCount = checklist.length;
  /*
   * ★ **추적 0명이면 분모가 없다** — `0` 이 아니라 `null` 이다. 곱셈 결과를 그대로 쓰면
   *   `0` 이 나오고 화면이 `0 / 0` 을 그린다. 0으로 나누는 코드가 없어도 사람이 읽기에는
   *   이미 깨진 화면이고, 그때 사용자가 해야 할 일은 비율을 보는 것이 아니라
   *   **캐릭터를 고르는 것**이다. 그 동선은 카드가 빈 상태로 안내한다.
   */
  const limitTotal =
    perCharacterLimit === null || trackedCount === 0
      ? null
      : trackedCount * perCharacterLimit;

  let clearedTotal = 0;
  let overLimitCount = 0;
  const characters: CharacterWeeklyBossSlots[] = checklist.map((entry) => {
    const cleared = clearedByCharacter.get(entry.character.characterId) ?? 0;
    clearedTotal += cleared;
    const remaining =
      perCharacterLimit === null
        ? null
        : Math.max(perCharacterLimit - cleared, 0);
    if (perCharacterLimit !== null && cleared >= perCharacterLimit) {
      overLimitCount += 1;
    }
    return {
      characterId: entry.character.characterId,
      characterName: entry.character.name,
      worldName: entry.character.worldName,
      clearedWeekly: cleared,
      remaining,
    };
  });

  /*
   * 남은 것이 많은 캐릭터가 먼저다 — 이 카드는 "무엇을 더 해야 하는가"를 답하는
   * 자리이므로 할 일이 많은 쪽이 위로 와야 한다. 동률은 이름 순이라 목록이 흔들리지 않는다.
   */
  characters.sort(
    (a, b) =>
      (b.remaining ?? 0) - (a.remaining ?? 0) ||
      a.characterName.localeCompare(b.characterName, "ko-KR"),
  );

  const trackedIds = new Set(
    checklist.map((entry) => entry.character.characterId),
  );
  let untrackedClearedCount = 0;
  for (const [characterId, cleared] of clearedByCharacter) {
    if (!trackedIds.has(characterId)) untrackedClearedCount += cleared;
  }

  return {
    trackedCount,
    perCharacterLimit,
    limitTotal,
    clearedTotal,
    remainingTotal:
      limitTotal === null ? null : Math.max(limitTotal - clearedTotal, 0),
    overLimitCount,
    characters,
    untrackedClearedCount,
  };
}
