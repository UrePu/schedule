import type { SchedulerChore } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 숙제 — **발주자 지정 필수 항목**만 펼치고 나머지는 접는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구: *"주간 숙제 간소화 해. (…) 주간 숙제 필수로 보여줄 거 **에픽던전,
 * 지하수로** 이거만 보여줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 지우지 않고 접는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 필터가 **캐릭터마다 다른 개수**를 만든다. 실측에서 한 캐릭터는 등록 숙제가 7개, 다른
 * 캐릭터는 15개였다. 여기서 나머지를 완전히 버리면 "내가 등록해 둔 무릉도장이 왜 안
 * 보이지"가 되고, 그때 사용자는 **앱이 데이터를 잃었다고 믿는다.** 접기는 그 오해를
 * 만들지 않으면서 기본 화면의 잡음을 없앤다. 접힌 개수를 버튼에 적어 존재를 항상 알린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 매칭 기준 — 넥슨 `weekly_contents[].content_name` **실측 문자열**
 * ─────────────────────────────────────────────────────────────────────────────
 * 출처: `Claude/NEXON-API-OBSERVED.md` 의 weekly 22종 목록(2026-08-17 실측).
 * 넥슨을 다시 부르지 않았다.
 *
 *   에픽 던전 : 하이마운틴 · 에픽 던전 : 앵글러 컴퍼니 · 에픽 던전 : 악몽선경
 *   [길드] 지하 수로
 *
 * **접두어 매칭**이다(정확 일치가 아니다):
 * - `에픽 던전` 계열은 패치마다 새 던전이 늘어난다. 세 개를 통째로 박아 두면 다음 던전이
 *   추가된 날 조용히 빠진다. `에픽 던전` 으로 시작하는 것을 전부 잡는다.
 * - `[길드] 지하 수로` 는 대괄호 접두어 표기가 흔들릴 수 있어(`[길드]` 유무) **부분 문자열**
 *   `지하 수로` 로 잡는다. 같은 주간 목록의 다른 22종 중 이 문자열을 포함하는 것은 없다.
 * - 공백 차이(`에픽던전` / `지하수로`)에 대비해 **비교 전에 공백을 제거**한다.
 *
 * ⚠️ **이 배열이 유일한 정의 지점이다.** 화면 어디에도 보스·숙제 이름을 다시 적지 않는다.
 *    나중에 늘어나면 여기에만 한 줄 추가한다.
 */
export const ESSENTIAL_CHORE_PATTERNS: readonly string[] = [
  // 발주자 지정 필수 항목 ①: 에픽 던전 계열 (하이마운틴 / 앵글러 컴퍼니 / 악몽선경 …)
  "에픽던전",
  // 발주자 지정 필수 항목 ②: 길드 지하 수로
  "지하수로",
];

/** 공백을 지우고 비교한다 — `에픽 던전 : 하이마운틴` 과 `에픽던전:하이마운틴` 이 같아야 한다. */
function normalize(value: string): string {
  return value.replace(/\s+/gu, "");
}

/** 이 숙제가 발주자 지정 필수 항목인가. */
export function isEssentialChore(chore: SchedulerChore): boolean {
  const name = normalize(chore.contentName);
  return ESSENTIAL_CHORE_PATTERNS.some((pattern) => name.includes(pattern));
}

export interface SplitChores {
  /** 항상 펼쳐 보이는 필수 항목. */
  readonly essential: readonly SchedulerChore[];
  /** 기본은 접혀 있고 "더 보기"로 펼친다. 버리지 않는다. */
  readonly rest: readonly SchedulerChore[];
}

/**
 * 등록된 주간 숙제를 **필수 / 나머지**로 가른다.
 *
 * 입력은 이미 `registered = true` 로 걸러진 목록이다(`boss-plan-repo.toWeeklyChores`).
 * 순서는 넥슨이 준 순서를 그대로 유지한다 — 우리가 재정렬하면 인게임 목록과 눈이 안 맞는다.
 */
export function splitChores(chores: readonly SchedulerChore[]): SplitChores {
  const essential: SchedulerChore[] = [];
  const rest: SchedulerChore[] = [];
  for (const chore of chores) {
    if (isEssentialChore(chore)) essential.push(chore);
    else rest.push(chore);
  }
  return { essential, rest };
}
