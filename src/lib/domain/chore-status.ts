/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 필수 숙제 O / X 판정
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구 ①(2026-08-19):
 *   "매일 필수적으로 해야되는게 일퀘 몬파 / 주간 필수적으로 해야되는게 수로 에픽던전"
 *
 * 발주 정정 ②(같은 날, 첫 화면을 보고):
 *   "지하수로는 0점이면 안친거고 점수가 있으면 친거잖아. 일퀘랑 몬파도 o x 로만 표시하고
 *    횟수는 그냥 치워. 에픽던전 주간숙제에 등록 안해놓은거는 그냥 빼버려. 지하수로도 포함"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정정 ②가 바꾼 것 세 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **수로·에픽던전도 넥슨으로 판정된다.** 첫 구현은 `nowCount 193963 / maxCount 0` 을
 *    보고 "상한이 없으니 판정 불가"로 뒀는데, 발주자가 게임 규칙을 알려 줬다 —
 *    **주간 카운터는 주간 리셋으로 0 이 되므로 `nowCount > 0` 자체가 "이번 주에 했다"**
 *    이다. 상한과 비교할 필요가 없었다. 그래서 `?` 와 수동 체크가 필요 없어졌다.
 *    (수동 체크 경로는 정정용으로 남겨 둔다 — 넥슨이 15분 늦으므로 방금 깬 것을 바로
 *     반영하고 싶을 때 쓸 자리가 있다.)
 * 2. **횟수를 표시하지 않는다** — 단 **몬파는 예외**다(정정 ③).
 *    11명 × 4항목이 한 화면에 들어가야 하므로 글자 하나가 비싸다.
 *    (2026-08-20: 봇 `!숙제` 는 여기서 더 나아가 **안 한 항목만** 그린다. 그래서 O/X
 *     표기 자체가 사라졌다 — 적혀 있다는 것이 곧 `todo` 다. 이 모듈은 여전히 `done`/`todo`
 *     **판정**만 소유하고, 그리는 방법은 부르는 쪽이 정한다.)
 * 3. **인게임 스케줄러에 등록하지 않은 항목은 아예 뺀다.** 예전에는 `?` 로 자리를
 *    차지했는데, 안 하기로 한 숙제에 물음표가 붙어 있으면 할 일 목록이 아니라 잡음이다.
 *    → 그래서 `ChoreState` 에 `unknown` 이 없다. 모르는 것은 **줄에서 사라진다.**
 *
 * 발주 정정 ③(같은 날):
 *   "몬파는 횟수를 쓰긴해야되는데 월드당 14회 캐릭터당 7회 제한임. (…) 그래서 몬파는
 *    횟수. 일퀘는 O or X"
 *   → 몬파만 `3/7` 로 되돌렸다. 근거와 상한 계산은 `monsterParkStatus` 머리말에 있다.
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

/** 판정 결과. **`unknown` 이 없다** — 모르는 항목은 목록에서 빠진다(정정 ②-3). */
export type ChoreState = "done" | "todo";

export interface ChoreStatus {
  /** 방에서 쓰는 짧은 이름. 발주자가 쓴 어휘 그대로 — `일퀘` · `몬파` · `수로` · `에픽`. */
  readonly label: string;
  readonly state: ChoreState;
  /**
   * `3/7` 처럼 O/X 대신 보여 줄 진행 표시. **`몬파` 만 갖는다.**
   *
   * 발주 정정(2026-08-19): *"몬파는 횟수를 쓰긴해야되는데 (…) 그래서 몬파는 횟수.
   * 일퀘는 O or X"*. 몬파는 남은 횟수가 곧 할 일의 양이라 O/X 로 접으면 정보가 사라진다.
   */
  readonly detail?: string;
  /**
   * `chore_definitions.slug`. **사람이 직접 체크할 수 있는 항목만** 갖는다.
   *
   * 왜 필요한가: 웹 숙제 화면의 체크박스가 `setChoreManualDone()` 을 부르려면 슬러그가
   * 있어야 하는데, 예전에는 이 타입이 `label`(`수로`)만 실어 화면이 **한글 이름 → 슬러그
   * 표를 다시 만들어야** 했다. 그 표가 두 벌이 되는 순간 봇과 웹이 서로 다른 행을 쓴다.
   *
   * 일간 항목(일퀘 · 몬파)에는 없다. `fetchChoreBoard` 가 수동 체크를 `scope='weekly'`
   * 로만 읽으므로 일간에는 켤 자리 자체가 없고, 없는 것을 있는 척 싣지 않는다.
   */
  readonly slug?: string;
}

/*
 * `choreMark()` (`O` / `X`) 는 **뺐다**(2026-08-20). `!숙제` 가 남은 항목만 그리도록
 * 바뀌면서 유일한 호출자가 사라졌고, 그 화면에서는 `X` 가 안 한 칸마다 붙는 상수라
 * 정보가 0인데 폭만 먹었다. `state` 는 그대로 남아 있으므로 O/X 가 다시 필요해지면
 * 그때 쓰는 쪽에서 만들면 된다 — 쓰이지 않는 표현을 도메인 모듈이 들고 있을 이유는 없다.
 */

/**
 * 일퀘 — 등록된 일일 퀘스트가 **전부** `quest_state = 2` 여야 완료.
 *
 * 17종이 한 줄로 접히므로(`essential-chores.ts`) "몇 개 중 몇 개"는 판정에만 쓰고
 * 화면에는 내보내지 않는다(정정 ②-2). 등록된 일퀘가 하나도 없으면 `null` —
 * 그 캐릭터는 일퀘를 안 하기로 한 것이므로 줄에서 뺀다.
 */
function dailyQuestStatus(daily: readonly SchedulerChore[]): ChoreStatus | null {
  const quests = daily.filter(isDailyQuestChore);
  if (quests.length === 0) return null;
  const done = quests.every((chore) => chore.questState === QUEST_STATE_DONE);
  return { label: "일퀘", state: done ? "done" : "todo" };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 몬파 — **캐릭터당 7회**가 상한이다 (넥슨 `maxCount 14` 는 월드 상한)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자 설명(2026-08-19): *"월드당 14회 캐릭터당 7회 제한임. 챌린저스 월드에서 7회를
 * 해도 크로아에서 14회를 더 할수있지만 한캐릭에 14번은 안되고 나눠서 14번임."*
 *
 * 즉 넥슨이 주는 `maxCount = 14` 는 **그 월드의 주간 상한**이고, 한 캐릭터가 도달할 수
 * 있는 최대는 7 이다. 그래서 `now >= maxCount` 로 판정하면 **어떤 캐릭터도 영원히 완료가
 * 되지 않는다** — 7 이 최대인데 14 를 기다리기 때문이다.
 *
 * 실측이 이 설명과 맞는다: 라이브 스냅샷에서 `nowCount` 의 최댓값이 정확히 **7** 이었고
 * (`maxCount` 는 전부 14), 그 이상은 한 번도 관측되지 않았다. 즉 `nowCount` 는 **그
 * 캐릭터 자신의 횟수**다.
 *
 * ⚠️ 월드 합계(14 중 몇)는 여기서 계산하지 않는다. 같은 월드의 다른 캐릭터 몫을 합쳐야
 *    하는데 그건 캐릭터 한 명을 보는 이 함수의 입력 밖이고, 발주 요구도 캐릭터별 줄이다.
 */
const MONSTER_PARK_PER_CHARACTER = 7;

function monsterParkStatus(daily: readonly SchedulerChore[]): ChoreStatus | null {
  const chore = daily.find(isMonsterParkChore);
  if (chore === undefined) return null;

  const now = chore.nowCount ?? 0;
  // 넥슨이 캐릭터 상한보다 작은 값을 주면 그쪽을 믿는다(패치로 줄어들 수 있다).
  const max = chore.maxCount;
  const cap =
    max !== null && max > 0
      ? Math.min(max, MONSTER_PARK_PER_CHARACTER)
      : MONSTER_PARK_PER_CHARACTER;

  return {
    label: "몬파",
    state: now >= cap ? "done" : "todo",
    detail: `${String(now)}/${String(cap)}`,
  };
}

/**
 * 주간 항목(수로 · 에픽) — **`nowCount > 0` 이면 이번 주에 했다.**
 *
 * 발주자 확인 사항이다. 주간 카운터는 KST 목요일 리셋으로 0 이 되므로, 값이 있다는 것
 * 자체가 이번 주 수행 기록이다. `maxCount` 는 이 판정에 쓰지 않는다 — 수로는 길드 점수라
 * 상한 개념이 없고 에픽던전은 상한이 0 으로 온다.
 *
 * 여러 개가 잡히면(에픽던전 3종) **하나라도 했으면 완료**로 본다. 발주 표기가
 * `에픽던전 O / X` 한 칸이지 던전별 세 칸이 아니기 때문이다.
 */
function weeklyCountStatus(
  label: string,
  pattern: string,
  weekly: readonly SchedulerChore[],
  manualDone: boolean | undefined,
  slug: string,
): ChoreStatus | null {
  const matches = weekly.filter((chore) =>
    chore.contentName.replace(/\s+/gu, "").includes(pattern),
  );
  // 인게임에 등록하지 않았으면 할 일이 아니다 — 줄에서 뺀다(정정 ②-3).
  if (matches.length === 0) return null;

  // 사람이 직접 체크했으면 그것이 이긴다. 넥슨은 15분 늦으므로 방금 깬 것을 반영할 길.
  if (manualDone !== undefined) {
    return { label, slug, state: manualDone ? "done" : "todo" };
  }

  const done = matches.some((chore) => (chore.nowCount ?? 0) > 0);
  return { label, slug, state: done ? "done" : "todo" };
}

export interface ChoreStatusInput {
  readonly dailyChores: readonly SchedulerChore[];
  readonly weeklyChores: readonly SchedulerChore[];
  /** 사람이 직접 체크한 주간 항목 슬러그 → 완료 여부. 넥슨 판정보다 우선한다. */
  readonly manualBySlug: ReadonlyMap<string, boolean>;
}

export interface CharacterChoreStatus {
  /** 등록하지 않은 항목은 **들어 있지 않다.** 길이가 캐릭터마다 다를 수 있다. */
  readonly daily: readonly ChoreStatus[];
  readonly weekly: readonly ChoreStatus[];
}

/** 한 캐릭터의 필수 숙제 상태. 등록한 것만 담긴다. */
export function resolveChoreStatus(
  input: ChoreStatusInput,
): CharacterChoreStatus {
  const daily = [
    dailyQuestStatus(input.dailyChores),
    monsterParkStatus(input.dailyChores),
  ].filter((status): status is ChoreStatus => status !== null);

  const weekly = [
    weeklyCountStatus(
      "수로",
      "지하수로",
      input.weeklyChores,
      input.manualBySlug.get("underground-waterway"),
      "underground-waterway",
    ),
    weeklyCountStatus(
      "에픽",
      "에픽던전",
      input.weeklyChores,
      input.manualBySlug.get("epic-dungeon"),
      "epic-dungeon",
    ),
  ].filter((status): status is ChoreStatus => status !== null);

  return { daily, weekly };
}
