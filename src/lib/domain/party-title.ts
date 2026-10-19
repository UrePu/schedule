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

import { GENERATED_BOSS_DIFFICULTIES } from "@/lib/boss-master";

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

// ─────────────────────────────────────────────────────────────────────────────
// 이름이 보스와 **어긋났다**는 사실 — 2026-10-17 발주 신고
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 왜 "이름을 다시 짓는" 대신 "어긋났다고 말하는" 쪽을 만들었나
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 파티원 신고(2026-10-17, 풍무고불빠따): *"진듄더 세카데 4인을 익검4인으로 변경해서
 * 일정 넣을려고하니까 보스일정에 안나옴요"*. 라이브 실측 — 보스는 **검은 마법사 하나**
 * 인데 묶음 이름은 `진듄더 익세하카하적` 이었다. 2단계 이행이 `parties.name_is_custom`
 * 을 묶음에 그대로 복사했고, 사람들이 파티 이름을 손으로 지어 왔으므로 **거의 모든
 * 묶음이 `name_is_custom = true`** 가 됐다 → 보스를 바꿔도 이름이 영원히 안 바뀐다.
 *
 * 그렇다고 **일괄로 다시 지을 수는 없다.** `은월 익검 2인(돌먹)` 의 `은월` · `(돌먹)` 은
 * 사람이 손으로 넣은 정보이고 자동 이름(`익검 2인`)은 그것을 **잃는다** — 이 프로젝트가
 * 애초에 풀려는 문제가 그것이다. 그래서 이름은 건드리지 않고, **거짓말을 하고 있다는
 * 사실만** 화면이 말한다. 고치는 결정은 사람이 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 판정 규칙 — **"이름이 말하는 보스가 이 묶음에 없다"** 하나뿐이다
 * ─────────────────────────────────────────────────────────────────────────────
 * `name !== autoName` 으로 판정하면 `은월 익검 2인(돌먹)` 이 전부 걸린다. 그건 어긋남이
 * 아니라 **덧붙인 정보**다. 실제로 거짓인 경우는 하나다 — 이름이 **보스 줄임말을
 * 적고 있는데 그 보스가 묶음에 없는** 것. `진듄더 익세하카하적` 은 `익세`(익스 세렌) ·
 * `하카`(하드 카링)를 적고 있지만 묶음에는 검은 마법사뿐이므로 걸리고,
 * `은월 익검 2인(돌먹)` 은 적고 있는 `익검` 이 실제로 있으므로 안 걸린다.
 *
 * ★ **보스 그룹**으로 비교한다(난이도까지 보지 않는다). 이름이 `하카` 인데 묶음에
 *   `노카`(노말 카링)가 있으면 난이도는 틀렸지만 **보스는 거기 있다** — 그 차이는
 *   목록의 보스 얼굴(`BossIcon` 이 난이도별 그림을 쓴다)이 이미 말하고, 여기서까지
 *   경고하면 "그 보스 자체가 없다"는 신고의 본체가 잔소리에 묻힌다.
 * ★ **보스가 없는 묶음은 판정하지 않는다.** 기준이 없고, 그 상태는 이미 목록이 주황
 *   한 줄로 말한다(`등록된 보스가 없어 이 묶음으로는 일정을 잡을 수 없습니다`).
 *   경고 두 개를 겹쳐 쌓지 않는다.
 * ★ **자동 이름은 애초에 판정하지 않는다**(호출부가 `name_is_custom` 으로 가른다).
 *   자동 이름은 보스에서 만들어지므로 어긋날 수 없다.
 *
 * ⚠️ 줄임말 표의 주인은 여전히 `boss_difficulties.short_name`(→ `@/lib/boss-master`)이다.
 *    이 파일 머리말이 금지한 것은 **규칙으로 줄임말을 지어내는 것**이고, 생성된 표를
 *    읽어 글자를 찾는 것은 그 금지에 해당하지 않는다.
 */

/** 줄임말 → 그 줄임말이 가리킬 수 있는 **보스 그룹** id 들. 실측 78개 전부 2글자다. */
const BOSS_GROUPS_BY_SHORT_NAME: ReadonlyMap<string, ReadonlySet<string>> =
  (() => {
    const out = new Map<string, Set<string>>();
    for (const entry of GENERATED_BOSS_DIFFICULTIES) {
      if (entry.shortName === null) continue;
      const bucket = out.get(entry.shortName) ?? new Set<string>();
      bucket.add(entry.bossId);
      out.set(entry.shortName, bucket);
    }
    return out;
  })();

/**
 * 줄임말 길이들, **긴 것부터.** 지금은 전부 2글자지만 시드가 3글자를 넣는 날
 * `익검마` 를 `익검` 으로 잘라 읽지 않게 한다 — 최장 일치가 아니면 긴 줄임말이
 * 짧은 줄임말로 오인되고, 그 오인이 곧 거짓 경고다.
 */
const SHORT_NAME_LENGTHS: readonly number[] = [
  ...new Set([...BOSS_GROUPS_BY_SHORT_NAME.keys()].map((key) => key.length)),
].sort((a, b) => b - a);

/**
 * 이름이 적고 있지만 이 묶음에 **없는** 보스 줄임말. 어긋남이 없으면 빈 배열.
 *
 * @param name            묶음(또는 파티) 이름. 사람이 적은 이름일 때만 부른다.
 * @param bossGroupIds    이 묶음이 실제로 도는 보스들의 **그룹** id (`bosses.id`).
 */
export function findStaleBossMentions(
  name: string,
  bossGroupIds: readonly string[],
): readonly string[] {
  // 기준이 없으면 판정하지 않는다(머리말).
  if (bossGroupIds.length === 0) return [];

  const present = new Set(bossGroupIds);
  const stale: string[] = [];
  const seen = new Set<string>();

  for (let at = 0; at < name.length; at += 1) {
    for (const length of SHORT_NAME_LENGTHS) {
      if (at + length > name.length) continue;
      const slice = name.slice(at, at + length);
      const groups = BOSS_GROUPS_BY_SHORT_NAME.get(slice);
      if (groups === undefined) continue;

      /*
        그 줄임말이 가리킬 수 있는 보스가 **하나라도** 묶음에 있으면 거짓이 아니다.
        (같은 두 글자가 두 보스를 가리키는 경우를 위한 것이다 — 지금 시드에는 없지만
         충돌이 생기면 "있는데 없다고 말하는" 거짓 경고가 더 비싸다.)
      */
      let found = false;
      for (const group of groups) {
        if (present.has(group)) {
          found = true;
          break;
        }
      }
      if (!found && !seen.has(slice)) {
        seen.add(slice);
        stale.push(slice);
      }
      // 맞춘 글자는 **소비한다.** 겹쳐 읽으면 같은 두 글자가 두 번 세어진다.
      at += length - 1;
      break;
    }
  }

  return stale;
}

/**
 * 어긋남을 사람에게 말하는 **한 문장** — 목록·일정 잡기 창이 같은 말을 쓴다.
 *
 * 원인(이름이 가리키는 보스가 없다)과 **할 수 있는 일**(이름 칸을 비우면 자동으로
 * 돌아간다)을 둘 다 말한다. 하나만 말하면 사용자가 할 수 있는 것이 없다 —
 * `CLEAR_WONT_LINK_REASON` 이 세운 그 규칙이다.
 */
export function describeStaleBossMentions(
  staleShortNames: readonly string[],
  autoName: string,
): string {
  return `이름이 가리키는 ${staleShortNames.join(" · ")} 이(가) 이 묶음에 없습니다. 실제 보스는 ${autoName} 입니다.`;
}

/** 이어서 고치는 길. 묶음을 고칠 수 있는 자리(파티 관리)에서만 쓴다. */
export const STALE_BOSS_MENTION_FIX =
  "편집에서 묶음 이름을 비우고 저장하면 보스에 맞는 자동 이름으로 돌아갑니다. 직접 적은 이름을 그대로 두고 싶으면 그냥 두셔도 됩니다.";
