/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 묶음 제목 — **조합 규칙의 유일한 소유자**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 원문(2026-08-18): *"한번 생성된 묶음은 보스 이미지, 이름 줄임말(앞글자
 * 익스트림세렌 = 익세 ) 로 줄여서 만약 익스 세렌 , 하드대적자 , 하드 카링을 2명이서
 * 하면 묶음 제목이 익세 하대 하카 2인 이 되는거임."*
 *
 * → `익세 하대 하카 2인`
 *
 * ── 왜 SQL 이 아니라 TS 인가 ─────────────────────────────────────────────────
 * 가용시간 해석·결정석 분배는 DB 함수 하나에 두었다(웹과 봇이 같은 답을 내야 하므로).
 * 제목은 다르다 — **저장할 값을 만드는 서버 코드**와 **체크할 때마다 즉시 갱신되는
 * 화면 미리보기**가 둘 다 필요하고, 봇도 결국 우리 TS 서버(`POST /api/bot/command`,
 * CLAUDE.md §2.2)를 지난다. SQL 에도 같은 함수를 두면 그때부터 구현이 두 벌이 된다.
 * 그래서 조합 규칙은 **이 파일 하나**이고, `schedule-repo`(쓰기)와 편집 다이얼로그
 * (미리보기)가 똑같이 이것을 부른다.
 *
 * ── 줄임말은 여기서 만들지 않는다 ────────────────────────────────────────────
 * `boss_difficulties.short_name` 컬럼이 원본이다(마이그레이션 22). 규칙("난이도 첫 글자
 * + 보스명 마지막 단어 첫 글자")으로 런타임 추론하지 않는 이유는 그 규칙이 안전하지
 * 않기 때문이다 — `검은 마법사`는 규칙대로면 `익마`이지만 실제 호칭은 `익검마`이고,
 * `하드 진 힐라`와 `하드 힐라`는 둘 다 `하힐`로 충돌한다. 예외는 시드에서 교정돼 있고,
 * 여기서 다시 추측하면 그 교정이 무의미해진다.
 *
 * ★ 줄임말이 없으면(마이그레이션 미적용) 호출자가 **보스 전체 이름**을 대신 넘긴다.
 *   제목이 길어질 뿐 틀리지 않는다. 규칙으로 지어내는 것보다 낫다.
 */

/** `parties.name` CHECK 는 `length(btrim(name)) between 1 and 60` 이다. */
export const PARTY_NAME_MAX_LENGTH = 60;

/**
 * 보스 줄임말 + 인원으로 묶음 제목을 만든다.
 *
 * - `["익세","하대","하카"]`, 2 → `익세 하대 하카 2인`
 * - `[]`, 2 → `null` (보스가 없으면 제목을 만들 재료가 없다. 호출자가 다른 규칙으로 넘어간다)
 *
 * ⚠️ **60자를 넘으면 잘라 낸다.** DB CHECK 가 그 경계이고, 넘긴 채로 INSERT 하면
 *   PostgreSQL 의 영어 제약 위반 메시지가 500 으로 접혀 사용자에게 아무 말도 못 한다.
 *   잘라 낼 때는 보스를 통째로 버리고 `외 N개` 로 요약한다 — 글자 중간에서 자르면
 *   `익세 하대 하` 처럼 존재하지 않는 보스 이름이 만들어진다.
 */
export function buildPartyTitle(
  shortNames: readonly string[],
  capacity: number,
): string | null {
  const names = shortNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;

  const people = Number.isFinite(capacity)
    ? Math.min(Math.max(Math.trunc(capacity), 1), 24)
    : 1;
  const suffix = `${people}인`;

  const full = `${names.join(" ")} ${suffix}`;
  if (full.length <= PARTY_NAME_MAX_LENGTH) return full;

  /*
    길면 앞에서부터 넣을 수 있는 만큼만 넣고 나머지는 개수로 말한다.
    최소한 첫 보스 하나는 남긴다 — `외 12개 6인` 은 아무것도 알려 주지 않는다.
  */
  for (let kept = names.length - 1; kept >= 1; kept -= 1) {
    const rest = names.length - kept;
    const candidate = `${names.slice(0, kept).join(" ")} 외 ${rest}개 ${suffix}`;
    if (candidate.length <= PARTY_NAME_MAX_LENGTH) return candidate;
  }

  // 첫 보스 이름 하나로도 넘치는 경우(줄임말 대신 전체 이름이 들어온 극단). 마지막 수단.
  return `${names[0]} 외 ${names.length - 1}개 ${suffix}`.slice(
    0,
    PARTY_NAME_MAX_LENGTH,
  );
}

/**
 * 화면이 "제목이 왜 이렇게 되는지"를 설명할 때 쓰는 한 문장.
 *
 * §1.4 는 `member_no` 같은 **관리 번호**를 재배열하지 못하게 한다. 보스 순서는 관리
 * 번호가 아니라 표시 순서라 바꿔도 되지만, **바꾸면 제목이 따라 바뀐다** — 그 사실을
 * 사용자가 모르면 "왜 이름이 바뀌었지"가 된다. 그래서 문구를 한 곳에 둔다.
 */
export const PARTY_TITLE_HINT =
  "보스를 추가·삭제하거나 순서를 바꾸면 제목이 따라 바뀝니다. 직접 적으면 그 이름이 고정됩니다.";
