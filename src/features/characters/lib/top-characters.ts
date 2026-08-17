import type { GameCharacter } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 선택 모달의 **정렬 · 페이지 나누기** (§2.1.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 예전에는 "레벨 상위 12명 고정"이었다. 실측 계정이 59명이던 시절에는 그것이 로스터
 * 대부분을 덮었지만, **부계정 키를 연결하면서 304명**이 되어 상위 12명은 이제 로스터의
 * 96%를 숨긴다. 그래서 잘라 내는 대신 **페이지로 나눈다.**
 *
 * ★ **페이지 크기 12는 그대로다.** 이 숫자는 레이아웃이 아니라 **넥슨 쿼터**가 정한다:
 *   초상화(`/character/basic`)가 **캐릭터당 1콜**이라 한 페이지를 그리면 정확히 12콜이
 *   나간다. 304명을 한 번에 그리면 개발 키 하루 예산(1,000콜)의 **3분의 1**이 모달 한
 *   번에 사라진다. 페이지를 키우면 그 비용이 곧바로 커진다.
 */

/** 한 페이지에 보여 줄 캐릭터 수. **초상화 호출 수와 같은 값**이다(캐릭터당 1콜). */
export const CHARACTER_PAGE_SIZE = 12;

/**
 * 레벨 내림차순 정렬. **결정론적이어야 한다.**
 *
 * 2차 키를 `localeCompare` 로 두지 않은 이유: 한국어 정렬 결과는 런타임의 ICU 버전과
 * 로케일 데이터에 따라 달라질 수 있다. 서버와 브라우저가 서로 다른 순서를 내면
 * 하이드레이션이 어긋나고, 같은 화면을 두 번 열었을 때 카드 순서가 바뀐다.
 * → **코드 유닛 비교**(`<`/`>`)를 쓴다. 사전순으로 완벽하진 않지만
 *   **어디서 돌려도 같은 결과**가 나오고, 동점 처리는 그것이면 충분하다.
 * → 이름까지 같으면 `ocid` 로 최종 확정한다. 완전 순서가 보장된다.
 *
 * ⚠️ 페이지네이션이 붙으면서 이 **완전 순서**가 더 중요해졌다. 순서가 흔들리면 같은
 *    캐릭터가 1페이지와 2페이지에 동시에 나오거나 어느 페이지에도 안 나올 수 있다.
 */
export function compareByLevelDesc(a: GameCharacter, b: GameCharacter): number {
  if (a.level !== b.level) return b.level - a.level;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.ocid !== b.ocid) return a.ocid < b.ocid ? -1 : 1;
  return 0;
}

/**
 * 전체를 레벨 내림차순으로 정렬한다. 원본 배열을 변형하지 않는다.
 *
 * 레벨순인 이유(§2.1.1): 사람들은 **가장 높은 캐릭터로 보스를 돈다.** 정렬이 레벨
 * 내림차순이면 첫 페이지가 곧 실제 사용 사례이고, 그 아래는 필요할 때 넘겨 보면 된다.
 */
export function sortByLevelDesc(
  characters: readonly GameCharacter[],
): readonly GameCharacter[] {
  return [...characters].sort(compareByLevelDesc);
}

/** 전체 페이지 수. 0명이어도 **1페이지**다 — "0 / 0" 은 사람이 읽을 수 없다. */
export function pageCount(
  total: number,
  size: number = CHARACTER_PAGE_SIZE,
): number {
  return Math.max(1, Math.ceil(total / size));
}

/** 페이지 번호를 유효 범위로 접는다. 목록이 줄어들어도 빈 페이지에 갇히지 않는다. */
export function clampPage(
  page: number,
  total: number,
  size: number = CHARACTER_PAGE_SIZE,
): number {
  return Math.min(Math.max(page, 0), pageCount(total, size) - 1);
}

/**
 * `pageIndex` 번째(0-based) 페이지를 잘라 낸다.
 *
 * **정렬된 배열을 받는 것을 전제로 한다.** 여기서 다시 정렬하지 않는 이유는 호출부가
 * 정렬 결과를 memo 해 두고 페이지만 바꾸기 때문이다 — 페이지를 넘길 때마다 304개를
 * 다시 정렬할 이유가 없다.
 */
export function pageOf<T>(
  sorted: readonly T[],
  pageIndex: number,
  size: number = CHARACTER_PAGE_SIZE,
): readonly T[] {
  const start = pageIndex * size;
  return sorted.slice(start, start + size);
}
