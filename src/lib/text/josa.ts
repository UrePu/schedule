/**
 * 한국어 조사 고르기 — `은(는)` 같은 괄호 조사 대신 앞 글자의 받침으로 하나를 고른다.
 *
 * 발주자 제보(2026-10-21): `/boss-plans` 안내 문구가 *"메검메 은(는) 본캐 배율의 약
 * 1.08배"* 라고 적었다. 괄호 조사는 사람이 쓴 문장처럼 읽히지 않는다 — 이름은 런타임
 * 값이라 문장을 쓸 때 받침을 알 수 없으니, 그 판정을 여기 한 곳에 둔다.
 *
 * 규칙:
 *   - 마지막 글자가 **한글 음절**이면 종성(받침)으로 고른다. `(으)로` 만은 받침이 `ㄹ`
 *     이어도 `로` 다(`서울로`).
 *   - 한글이 아니면(영문·숫자·기호로 끝나는 닉네임) 판정할 수 없다 — 그때는 괄호 조사를
 *     그대로 돌려준다. 틀린 조사를 단정하는 것보다 괄호가 낫다.
 *   - 환경 중립(React·DOM 없음). 웹과 봇이 같이 쓴다.
 */

export type JosaPair = "은/는" | "이/가" | "을/를" | "와/과" | "으로/로";

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONG_COUNT = 28;
/** 종성 인덱스 8 = `ㄹ`. */
const JONG_RIEUL = 8;

const FALLBACK: Record<JosaPair, string> = {
  "은/는": "은(는)",
  "이/가": "이(가)",
  "을/를": "을(를)",
  "와/과": "와(과)",
  "으로/로": "(으)로",
};

/** 마지막 글자의 종성 인덱스(0 = 받침 없음). 한글 음절이 아니면 `null`. */
function lastJongIndex(word: string): number | null {
  const trimmed = word.trimEnd();
  const last = trimmed.codePointAt(trimmed.length - 1);
  if (last === undefined || last < HANGUL_FIRST || last > HANGUL_LAST) return null;
  return (last - HANGUL_FIRST) % JONG_COUNT;
}

/** 받침이 있는가. 한글 음절로 끝나지 않으면 `null`(모른다). */
export function hasBatchim(word: string): boolean | null {
  const jong = lastJongIndex(word);
  return jong === null ? null : jong !== 0;
}

/** 조사 하나만. `josa("메검메", "은/는")` → `"는"`. */
export function josa(word: string, pair: JosaPair): string {
  const jong = lastJongIndex(word);
  if (jong === null) return FALLBACK[pair];
  const withBatchim = jong !== 0;
  switch (pair) {
    case "은/는":
      return withBatchim ? "은" : "는";
    case "이/가":
      return withBatchim ? "이" : "가";
    case "을/를":
      return withBatchim ? "을" : "를";
    case "와/과":
      return withBatchim ? "과" : "와";
    case "으로/로":
      return withBatchim && jong !== JONG_RIEUL ? "으로" : "로";
  }
}

/** 단어 + 조사. `withJosa("메검메", "은/는")` → `"메검메는"`. */
export function withJosa(word: string, pair: JosaPair): string {
  return `${word}${josa(word, pair)}`;
}
