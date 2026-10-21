/**
 * 한국어 조사 고르기 — `은(는)` 같은 괄호 조사 대신 앞 글자의 받침으로 하나를 고른다.
 *
 * 발주자 제보(2026-10-21): `/boss-plans` 안내 문구가 *"메검메 은(는) 본캐 배율의 약
 * 1.08배"* 라고 적었다. 괄호 조사는 사람이 쓴 문장처럼 읽히지 않는다 — 이름은 런타임
 * 값이라 문장을 쓸 때 받침을 알 수 없으니, 그 판정을 여기 한 곳에 둔다.
 *
 * 규칙:
 *   - 끝의 공백은 버리고 본다(`"닉 "` → `"닉"` 으로 판정하고 붙이기도 그 단어에 한다).
 *   - 마지막 글자가 **한글 음절**이면 종성(받침)으로 고른다. `(으)로` 만은 받침이 `ㄹ`
 *     이어도 `로` 다(`서울로`).
 *   - **아라비아 숫자**로 끝나면 읽는 소리로 고른다(`3` 삼 → 받침, `2` 이 → 없음,
 *     `10` 십 · `100` 백 · `1000` 천 · `10000` 만 → 받침; `1`·`7`·`8` 은 ㄹ 받침).
 *   - 그 밖(영문·기호로 끝나는 닉네임)은 판정할 수 없다 — 그때는 괄호 조사를 그대로
 *     돌려준다. 틀린 조사를 단정하는 것보다 괄호가 낫다.
 *   - 환경 중립(React·DOM 없음). 웹과 봇이 같이 쓴다.
 */

export type JosaPair = "은/는" | "이/가" | "을/를" | "와/과" | "으로/로";

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONG_COUNT = 28;

/** 받침 판정 결과. `rieul` 은 `(으)로` 를 가르는 데만 쓴다. */
interface Batchim {
  readonly has: boolean;
  readonly rieul: boolean;
}

const FALLBACK: Record<JosaPair, string> = {
  "은/는": "은(는)",
  "이/가": "이(가)",
  "을/를": "을(를)",
  "와/과": "와(과)",
  "으로/로": "(으)로",
};

/** 숫자 한 자리의 소리 받침 — 영(ㅇ) 일(ㄹ) 이 삼(ㅁ) 사 오 육(ㄱ) 칠(ㄹ) 팔(ㄹ) 구. */
const DIGIT_BATCHIM: Readonly<Record<string, Batchim>> = {
  "0": { has: true, rieul: false },
  "1": { has: true, rieul: true },
  "2": { has: false, rieul: false },
  "3": { has: true, rieul: false },
  "4": { has: false, rieul: false },
  "5": { has: false, rieul: false },
  "6": { has: true, rieul: false },
  "7": { has: true, rieul: true },
  "8": { has: true, rieul: true },
  "9": { has: false, rieul: false },
};

function batchimOf(word: string): Batchim | null {
  const trimmed = word.trimEnd();
  if (trimmed === "") return null;
  const last = trimmed.codePointAt(trimmed.length - 1);
  if (last === undefined) return null;
  if (last >= HANGUL_FIRST && last <= HANGUL_LAST) {
    const jong = (last - HANGUL_FIRST) % JONG_COUNT;
    return { has: jong !== 0, rieul: jong === 8 };
  }
  const digits = /(\d+)$/.exec(trimmed)?.[1];
  if (digits === undefined) return null;
  const lastDigit = digits[digits.length - 1] ?? "";
  if (lastDigit !== "0" || /^0+$/.test(digits)) {
    return DIGIT_BATCHIM[lastDigit] ?? null;
  }
  // 끝이 0 — 십·백·천·만 단위로 읽는다. 넷 다 받침이 있고 ㄹ 은 아니다.
  return { has: true, rieul: false };
}

/** 받침이 있는가. 판정할 수 없으면(영문·기호 끝) `null`. */
export function hasBatchim(word: string): boolean | null {
  return batchimOf(word)?.has ?? null;
}

/** 조사 하나만. `josa("메검메", "은/는")` → `"는"`. */
export function josa(word: string, pair: JosaPair): string {
  const batchim = batchimOf(word);
  if (batchim === null) return FALLBACK[pair];
  switch (pair) {
    case "은/는":
      return batchim.has ? "은" : "는";
    case "이/가":
      return batchim.has ? "이" : "가";
    case "을/를":
      return batchim.has ? "을" : "를";
    case "와/과":
      return batchim.has ? "과" : "와";
    case "으로/로":
      return batchim.has && !batchim.rieul ? "으로" : "로";
  }
}

/**
 * 단어 + 조사. `withJosa("메검메", "은/는")` → `"메검메는"`. 끝 공백은 버린 단어에 붙인다
 * (`"닉 "` → `"닉은"`).
 */
export function withJosa(word: string, pair: JosaPair): string {
  const trimmed = word.trimEnd();
  return `${trimmed}${josa(trimmed, pair)}`;
}
