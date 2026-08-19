/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 필수 숙제 O / X 판정 — **넥슨이 답할 수 있는 것과 없는 것을 가른다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(원문, 2026-08-19):
 *   "매일 필수적으로 해야되는게 일퀘 몬파 / 주간 필수적으로 해야되는게 수로 에픽던전
 *    캐릭터별로 (…) 일일퀘스트 O / X · 주간숙제 수로 O / X | 에픽던전 O / X"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 넥슨이 완료 여부를 주는 항목은 **4개 중 2개뿐이다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 라이브 스냅샷을 항목별로 집계해 확인한 사실(2026-08-19):
 *
 *   | 항목     | type       | 넥슨이 주는 값             | 판정                       |
 *   |----------|------------|----------------------------|----------------------------|
 *   | 일퀘     | `quest`    | `questState` 0 · 1 · 2     | ✅ `2` = 완료              |
 *   | 몬파     | `contents` | `nowCount 7 / maxCount 14` | ✅ `now >= max`            |
 *   | 수로     | `contents` | `nowCount 193963 / max 0`  | ❌ 길드 **점수**, 상한 없음 |
 *   | 에픽던전 | `contents` | `nowCount 5 / max 0`       | ❌ 상한이 0                |
 *
 * 그래서 `nowCount >= maxCount` 를 전 항목에 그냥 적용하면 **수로와 에픽던전은 `0 >= 0`
 * 이라 언제나 완료로 나온다.** 아무것도 안 한 캐릭터가 O 로 보이는 쪽이, 모른다고 말하는
 * 쪽보다 훨씬 나쁘다 — 그 O 를 믿고 그 주 숙제를 건너뛰게 된다.
 *
 * 이 파일은 그 경계를 타입으로 만든다. 판정 결과는 `done` / `todo` / `unknown` 세 가지이며
 * **`unknown` 을 `todo` 로 뭉개지 않는다.** §1.3 D4 가 가격 `null` 을 0 으로 더하지 않는
 * 것과 같은 규칙이다.
 *
 * `unknown` 인 두 항목은 `chore_completions.manual_done` 으로 사람이 체크한다. 그 표가
 * 처음부터 `manual_done` / `api_done` / `effective_done` 을 따로 들고 있는 이유가 이것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `lib/domain/` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 봇 `!숙제` 와 웹 주간 체크리스트가 **같은 판정**을 써야 한다. 한쪽이 O 라고 한 것을
 * 다른 쪽이 X 로 그리면 둘 다 못 믿게 된다. `participant-label.ts` · `run-grouping.ts` 와
 * 같은 이유로 여기 있다.
 */

import {
  isDailyQuestChore,
  isMonsterParkChore,
  isEssentialChore,
} from "@/features/boss-plans/lib/essential-chores";
import type { SchedulerChore } from "@/features/boss-plans/types";

/**
 * 넥슨 `quest_state` 의 완료값.
 *
 * 실측(2026-08-19)에서 일일 퀘스트는 `0` → `1` → `2` 로 움직였다. 0 = 미수락,
 * 1 = 진행 중, 2 = 완료로 읽는다. **`1` 을 완료로 세지 않는다** — 수락만 하고 안 깬 것을
 * 했다고 말하면 그날 숙제를 놓친다.
 */
export const QUEST_STATE_DONE = 2;

/** 판정 결과. `unknown` 은 **모른다**이며 `todo` 가 아니다. */
export type ChoreState = "done" | "todo" | "unknown";

export interface ChoreStatus {
  /** 표시용 이름. `일일퀘스트` · `몬스터파크` · `지하수로` · `에픽던전`. */
  readonly label: string;
  readonly state: ChoreState;
  /**
   * 진행 표시(`3/8`). 셀 수 있을 때만 채운다.
   * `unknown` 인 항목도 넥슨이 준 숫자가 있으면 실어 보낸다 — 사람이 판단할 재료는 준다.
   */
  readonly progress: string | null;
}

/** `O` / `X` / `?` — 평문 한 줄에 쓰는 기호. */
export function choreMark(state: ChoreState): string {
  if (state === "done") return "O";
  if (state === "todo") return "X";
  return "?";
}

/**
 * 일퀘 — 등록된 일일 퀘스트 **전부**가 `quest_state = 2` 여야 완료.
 *
 * 17종이 한 줄로 접히므로(`essential-chores.ts`) 몇 개 중 몇 개인지를 함께 낸다.
 * 등록된 일퀘가 하나도 없으면 그 캐릭터는 일퀘를 안 하는 것이므로 `unknown` 이 아니라
 * **해당 없음**에 가깝다 — 여기서는 `unknown` 으로 두고 표시하는 쪽이 `-` 로 접는다.
 */
function dailyQuestStatus(daily: readonly SchedulerChore[]): ChoreStatus {
  const quests = daily.filter(isDailyQuestChore);
  if (quests.length === 0) {
    return { label: "일일퀘스트", state: "unknown", progress: null };
  }
  const done = quests.filter(
    (chore) => chore.questState === QUEST_STATE_DONE,
  ).length;
  return {
    label: "일일퀘스트",
    state: done === quests.length ? "done" : "todo",
    progress: `${String(done)}/${String(quests.length)}`,
  };
}

/**
 * 몬파 — `nowCount / maxCount`.
 *
 * `maxCount` 가 0 이거나 없으면 비교가 성립하지 않으므로 `unknown` 이다. 실측에서는
 * 14 로 안정적이었지만, 0 이 오는 날 `0 >= 0` 으로 완료를 만들지 않도록 막아 둔다.
 */
function countedStatus(
  label: string,
  chore: SchedulerChore | undefined,
): ChoreStatus {
  if (chore === undefined) return { label, state: "unknown", progress: null };

  const now = chore.nowCount ?? 0;
  const max = chore.maxCount;
  if (max === null || max <= 0) {
    return { label, state: "unknown", progress: null };
  }
  return {
    label,
    state: now >= max ? "done" : "todo",
    progress: `${String(now)}/${String(max)}`,
  };
}

export interface ChoreStatusInput {
  readonly dailyChores: readonly SchedulerChore[];
  readonly weeklyChores: readonly SchedulerChore[];
  /**
   * 사람이 직접 체크한 항목의 `slug` 집합 (`chore_completions.manual_done`).
   * 넥슨이 판정할 수 없는 **수로 · 에픽던전**이 이걸로 결정된다.
   */
  readonly manualDoneSlugs: ReadonlySet<string>;
}

export interface CharacterChoreStatus {
  readonly daily: readonly ChoreStatus[];
  readonly weekly: readonly ChoreStatus[];
}

/**
 * 한 캐릭터의 필수 숙제 4종 상태.
 *
 * 주간 두 항목은 넥슨이 답하지 못하므로 **수동 체크가 유일한 판정 근거**다. 체크가 없으면
 * `todo` 로 둔다 — 주간 숙제는 "안 했으면 해야 하는 것"이 기본값이고, 여기서 `unknown` 을
 * 내면 매주 물음표만 네 개 뜨는 화면이 된다. 대신 **넥슨이 준 숫자를 progress 로 함께**
 * 실어 보내 사람이 스스로 판단할 재료를 남긴다.
 */
export function resolveChoreStatus(
  input: ChoreStatusInput,
): CharacterChoreStatus {
  const daily: ChoreStatus[] = [
    dailyQuestStatus(input.dailyChores),
    countedStatus(
      "몬스터파크",
      input.dailyChores.find(isMonsterParkChore),
    ),
  ];

  const essentialWeekly = input.weeklyChores.filter(isEssentialChore);
  const weekly: ChoreStatus[] = [
    manualStatus("지하수로", "underground-waterway", essentialWeekly, input),
    manualStatus("에픽던전", "epic-dungeon", essentialWeekly, input),
  ];

  return { daily, weekly };
}

/** 슬러그별 이름 조각. `essential-chores.ts` 의 패턴과 같은 어휘를 쓴다. */
const WEEKLY_SLUG_PATTERN: Record<string, string> = {
  "underground-waterway": "지하수로",
  "epic-dungeon": "에픽던전",
};

function manualStatus(
  label: string,
  slug: string,
  weekly: readonly SchedulerChore[],
  input: ChoreStatusInput,
): ChoreStatus {
  const pattern = WEEKLY_SLUG_PATTERN[slug] ?? label;
  const matches = weekly.filter((chore) =>
    chore.contentName.replace(/\s+/gu, "").includes(pattern),
  );

  // 인게임 스케줄러에 등록조차 안 했으면 할 일이 아니다 — `-` 로 접히도록 unknown 을 낸다.
  if (matches.length === 0) {
    return { label, state: "unknown", progress: null };
  }

  // 넥슨 숫자는 판정에 쓰지 않고 **참고로만** 붙인다(수로 nowCount 는 길드 점수다).
  const observed = matches.reduce((sum, chore) => sum + (chore.nowCount ?? 0), 0);
  return {
    label,
    state: input.manualDoneSlugs.has(slug) ? "done" : "todo",
    progress: observed > 0 ? String(observed) : null,
  };
}
