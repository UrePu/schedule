import type { BossCycle } from "@/types/domain";

import type { CharacterWeeklyProgress } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 13번째 주간 보스 — **누르기 전에 말하기 위한 예고**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 2025-08-21 패치 이후 13번째 주간 보스는 입장 자체가 불가능하다(CLAUDE.md §1).
 * **판정의 소유자는 서버**(`server/boss-plan-repo.ts` 의 `assertWeeklyPlanSlotAvailable`)
 * 이고 그쪽이 400 으로 거절한다. 이 파일은 그 거절을 **미리 보는 눈**일 뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 화면이 미리 봐야 하는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 계획 켜기가 낙관적 업데이트가 되면서(2026-08-18) 서버 거절의 대가가 달라졌다.
 * 낙관적으로 켰다가 400 을 받아 롤백하면 **목록이 켜졌다 꺼진다.** 그 깜빡임은
 * 사용자에게 아무 정보가 아니고 "안 눌렸다"로 읽힌다. 그래서 이 경우만은 낙관적 적용도
 * 호출도 하지 않고, 같은 이유를 즉시 문장으로 보여 준다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙이 두 벌이 되지 않는 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 함수는 **숫자를 하나도 만들지 않는다.** `plannedWeekly` 도 `weeklyLimit` 도 뷰
 * `v_character_weekly_boss_progress` 가 낸 값이고(상한값 자체는 DB 함수
 * `weekly_crystal_sell_limit()` 가 단일 출처다), 여기서는 **비교만** 한다 —
 * `assertWeeklyPlanSlotAvailable()` 이 하는 일과 글자 그대로 같다.
 * 그래서 코드 어디에도 `12` 가 없고, 게임이 상한을 바꿔도 손댈 자리가 없다.
 *
 * ⚠️ **막는 것이 아니라 말하는 것이다.** 버튼은 잠그지 않는다 — 잠그면 이미 상한을
 *    넘겨 있는 사람은 무엇 때문에 잠겼는지 알 수 없다(이 화면의 오래된 결정).
 */

/**
 * 이 조작이 13번째 주간 보스를 켜려는 것인가. 걸리면 사용자에게 보여 줄 문장을,
 * 통과하면 `null` 을 돌려준다.
 *
 * 서버 가드와 **같은 네 분기**다:
 * 1. 주간이 아니면 통과 — 월간·일간은 12 카운터 밖이다(§1).
 * 2. 이미 켜져 있으면 통과 — 슬롯을 새로 먹지 않는다.
 * 3. 진행 상황이 없으면 통과 — 계획이 한 줄도 없다는 뜻이라 상한에 닿을 수 없다.
 * 4. `plannedWeekly < weeklyLimit` 이면 통과, 아니면 거절.
 */
export function weeklySlotBlockReason(input: {
  readonly cycle: BossCycle;
  readonly bossDisplayName: string;
  readonly isAlreadyActive: boolean;
  readonly progress: CharacterWeeklyProgress | null;
}): string | null {
  const { cycle, bossDisplayName, isAlreadyActive, progress } = input;

  if (cycle !== "weekly") return null;
  if (isAlreadyActive) return null;
  if (progress === null) return null;
  // 상한값을 읽지 못한 경우(0 이하)는 막지 않는다 — 서버가 최종 판정을 한다.
  if (progress.weeklyLimit <= 0) return null;
  if (progress.plannedWeekly < progress.weeklyLimit) return null;

  const limit = progress.weeklyLimit;
  return (
    `주간 보스는 캐릭터당 ${String(limit)}개까지만 입장할 수 있어 ` +
    `${String(limit + 1)}번째는 켜도 갈 수 없습니다. ` +
    `지금 ${String(progress.plannedWeekly)}개가 켜져 있어 ` +
    `“${bossDisplayName}” 을(를) 켜지 않았습니다 — ` +
    `이번 주에 가지 않을 보스를 목록에서 먼저 끄고 다시 눌러 주세요. ` +
    `월간 보스는 이 ${String(limit)}개에 들어가지 않습니다.`
  );
}
