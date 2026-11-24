/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 드랍 분배 — **경매장 수수료를 두 번 내는 구조**를 풀어 준다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-19):
 *   "!드랍 950 3 3% 이렇게 하면 950억 3인 수수료 3% 로 계산해서 각 파티원들이 얼마
 *    올리면되는지를 계산해주는것임 (…) 950억이 판매되면 950 * 0.97 을 해서 파티장에게
 *    수령되고 이걸 단순히 /3 해서 올리라고 하면 파티장만 수수로 3% 만큼 이득보게 되니
 *    세명이 전부 똑같은 돈을 받도록 해달라는뜻임. 파티원은 3% 의 수수료를 한번 더받잖아"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 단순 나눗셈이 틀리는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 메소는 경매장을 거쳐야 오간다. 그리고 **경매장 수수료는 파는 쪽이 낸다.** 그래서 드랍이
 * 팔릴 때 한 번, 파티원이 파티장에게 몫을 받으려고 물건을 올릴 때 **또 한 번** 떼인다.
 *
 *   드랍 판매    파티장 실수령 R = 총액 × (1 − f)
 *   몫 전달      파티원이 X 에 올리면 파티원 실수령 = X × (1 − f), 파티장은 X 를 지불
 *
 * 여기서 "R 을 n 으로 나눈 값"을 올리라고 하면, 파티장은 그 값을 **그대로** 갖고 파티원은
 * 거기서 수수료를 한 번 더 뗀 값만 갖는다. 파티장만 이득이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 셋이 같아지는 지점
 * ─────────────────────────────────────────────────────────────────────────────
 *   파티장 최종 = R − (n−1)·X
 *   파티원 최종 = (1−f)·X
 *   두 값을 같게 두면
 *     R = (1−f)·X + (n−1)·X = X·(n − f)
 *     **X = R / (n − f)**
 *
 * 검산(950억 · 3인 · 3%):
 *   R = 921.5억,  X = 921.5 / 2.97 = 310.2694…억
 *   파티원 = 310.2694 × 0.97 = 300.9613억
 *   파티장 = 921.5 − 2 × 310.2694 = 300.9613억  ✓
 *
 * ⚠️ **정수 메소로 계산한다.** 억 단위 실수로 굴리면 1메소 단위에서 어긋나고, 실제로
 *    올릴 금액은 사람이 그대로 입력하는 숫자다. 반올림 잔차는 파티장이 흡수한다 —
 *    파티원은 "올리라고 한 금액"을 정확히 올려야 하므로 그쪽을 딱 떨어지게 둔다.
 */

/** 1억 메소. 입력·표시는 억 단위지만 계산은 메소 정수로 한다. */
export const MESO_PER_EOK = 100_000_000;

export interface DropSplitInput {
  /** 드랍이 팔린 총액(메소). */
  readonly grossMeso: number;
  /** 나눌 사람 수(파티장 포함). */
  readonly people: number;
  /** 경매장 수수료율. 3% → `0.03`. */
  readonly feeRate: number;
}

export interface DropSplit {
  /** 파티장이 드랍 판매로 손에 쥔 금액. */
  readonly leaderReceivesMeso: number;
  /** **파티원 한 명이 경매장에 올릴 금액.** 이 숫자가 이 계산의 결론이다. */
  readonly listPriceMeso: number;
  /** 그렇게 했을 때 **모두가** 갖게 되는 금액. */
  readonly eachFinalMeso: number;
}

/*
  ⚠️ `R / n` 로 올렸을 때 파티원이 얼마를 받는지(=흔한 실수의 결과)를 함께 돌려주던
     필드가 있었다. 방에 그 두 줄을 찍지 않기로 해서 **지웠다**(발주 지시 2026-08-19).
     왜 그 금액이 아닌지는 이 파일 머리말이 계속 들고 있으므로 근거는 남아 있다.
     다시 보여 줄 일이 생기면 `Math.round(R / n)` 두 줄이면 된다.
*/

/**
 * @throws 인원이 1 미만이거나 수수료가 0 미만·1 이상이면 던진다. 부르는 쪽이 먼저 거른다.
 */
export function computeDropSplit(input: DropSplitInput): DropSplit {
  const { grossMeso, people, feeRate } = input;
  if (!Number.isFinite(grossMeso) || grossMeso < 0) {
    throw new Error("판매 금액이 올바르지 않습니다.");
  }
  if (!Number.isInteger(people) || people < 1) {
    throw new Error("인원이 올바르지 않습니다.");
  }
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error("수수료율이 올바르지 않습니다.");
  }

  const keep = 1 - feeRate;
  const leaderReceivesMeso = Math.floor(grossMeso * keep);

  // 혼자면 주고받을 일이 없다. 올릴 금액이라는 개념 자체가 없으므로 0 이다.
  if (people === 1) {
    return {
      leaderReceivesMeso,
      listPriceMeso: 0,
      eachFinalMeso: leaderReceivesMeso,
    };
  }

  // X = R / (n − f)
  const listPriceMeso = Math.round(leaderReceivesMeso / (people - feeRate));
  // 파티원이 실제로 손에 쥐는 값. 파티장 몫은 잔차를 흡수하므로 이쪽을 기준으로 삼는다.
  const eachFinalMeso = Math.floor(listPriceMeso * keep);

  return { leaderReceivesMeso, listPriceMeso, eachFinalMeso };
}

/*
 * ═════════════════════════════════════════════════════════════════════════════
 * 비율 분배 — 같은 이중 수수료 구조에서 "똑같이" 대신 **"w₀ : w₁ : … 비율대로"**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-11-23): `!분배 950 37` · `!분배 950 3:7` 처럼 인원 자리에 비율을 적으면
 * 3:7 로 나눠 각자 올릴 금액을 알려 준다. **첫 숫자가 판매자**(드랍을 팔아 메소를 받은
 * 사람)이고, 이어서 친 순서대로 파티원1 · 파티원2 … 다(답장 호칭과 같다).
 *
 * 구조는 위와 같다 — 판매 때 한 번, 몫을 넘길 때 또 한 번 수수료가 떼인다. 다른 것은
 * "모두 같게" 가 "각자 가중치에 비례하게" 로 바뀐 것뿐이다.
 *
 *   판매자(w₀) 실수령 R = 총액 × (1 − f)
 *   파티원 i(w_i, i ≥ 1) 가 X_i 에 올리면 그 사람 실수령 = (1 − f)·X_i, 판매자는 X_i 를 지불
 *
 *   판매자 최종  = R − Σ X_i
 *   파티원 i 최종 = (1−f)·X_i
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 각 최종이 가중치에 비례하는 지점
 * ─────────────────────────────────────────────────────────────────────────────
 *   W = Σ w (판매자 포함 전부), 공통 비례상수를 k 라 두면
 *     (1−f)·X_i   = k·w_i           →  X_i = k·w_i / (1−f)
 *     R − Σ X_i   = k·w₀
 *   둘째 식에 첫째를 넣으면
 *     R = k·w₀ + k·(W − w₀)/(1−f)
 *     (1−f)·R = k·((1−f)·w₀ + W − w₀) = k·(W − f·w₀)
 *   그래서 D = W − f·w₀ 로 두면
 *     k = (1−f)·R / D,   **X_i = R·w_i / D**
 *
 * ★ 가중치가 전부 1 이면 W = n, w₀ = 1 이라 D = n − f — 위의 X = R/(n−f) 그대로다.
 *   코드도 **반드시 그 형태**(`W − f × w₀`, `R × w_i / D`)로 계산한다. 그래야 1:1:…:1 이
 *   `computeDropSplit` 과 **비트 단위로** 같아진다(W 는 정수 합이라 정확하고, `f × 1` 과
 *   `R × 1` 은 부동소수점에서도 그대로다). 식을 `R / (D / w_i)` 처럼 바꾸면 이 성질이 깨진다.
 *
 * 검산(950억 · 3:7 · 3%):
 *   R = 921.5억,  D = 10 − 0.03 × 3 = 9.91
 *   X = 921.5 × 7 / 9.91 = 650.9082…억   (65,090,817,356 메소)
 *   판매자 = 921.5 − 650.9082 = 270.5918…억
 *   파티원 = 650.9082 × 0.97  = 631.3809…억
 *   270.5918 / 3 = 90.197… = 631.3809 / 7  ✓  (= k = 0.97 × 921.5 / 9.91)
 *
 * ⚠️ 정수 메소 · 잔차 원칙은 위와 같다. 파티원 몫(X_i)은 반올림해 **딱 떨어지게** 두고,
 *    그 반올림 잔차(최대 (n−1)/2 메소)는 판매자가 흡수한다. 그래서 판매자 이상적 몫
 *    (1−f)·R·w₀/D 가 잔차보다 작으면 판매자 최종이 **0 이나 음수**가 된다. 수수료 입력이
 *    99.99% 까지 열려 있어(`parseFeeRate`) 0.01억에서도 R 이 몇 메소로 떨어질 수 있고, 실측
 *    최저가 **−2 메소**였다. 그때도 합(판매자 + Σ X_i = R)은 정확히 맞고, 답장 표시는
 *    `formatEok` 이 0.01억 단위로 반올림하므로 `0억` 이다. 보통 수수료(0~10%)의 0.01억
 *    이상에서는 판매자 몫이 잔차보다 수천 배 커서 생기지 않는다.
 */

/** 비율 한 칸의 범위와 칸 수. 사람이 방에서 치는 비율이라 두 자리면 충분하다. */
export const SHARE_RATIO_MIN_PARTS = 2;
export const SHARE_RATIO_MAX_PARTS = 6;
export const SHARE_RATIO_MAX_WEIGHT = 99;

/** 비율 구분자로 읽는 글자들 — 전각 콜론 · 슬래시(`3/7`). 어디에 있든 `:` 로 접는다. */
const SHARE_RATIO_SEPARATORS = /[：/]/gu;

/**
 * `대`(`3대7` · `3대3대4`)는 **숫자와 숫자 사이에 있을 때만** 구분자다.
 *
 * ⚠️ 처음에는 `대` 를 위 목록에 넣어 어디서든 `:` 로 바꿨다. 그러자 금액 뒤에 보스를 적은
 *    `!분배 950 대적자 3` · `!드랍 950 하대 3` 이 `:적자` · `하:` 가 되어 **비율 오류**를 받았다
 *    (그전에는 사용법이었다). 보스 이름에 `대` 가 흔하므로 숫자 사이만 본다 — `대적자` · `하대` ·
 *    `대` · `3대` · `대3` 은 그대로 남아 비율이 아니고(`null`), 기존 인원 해석에서 사용법으로 간다.
 * 앞 숫자를 잡아 `$1:` 로 되돌려 쓰고 뒤 숫자는 앞보기로만 본다 — 소비하지 않으므로
 * `3대3대4` 의 가운데 3 이 두 번째 `대` 의 앞 숫자로 다시 잡힌다.
 */
const SHARE_RATIO_DAE = /(\d)대(?=\d)/gu;

/** 전각 숫자 `０`~`９` → ASCII. **이 파서 안에서만** 쓴다(`parseEok` · `parseFeeRate` 는 그대로). */
const FULLWIDTH_DIGIT = /[０-９]/gu;
const FULLWIDTH_DIGIT_OFFSET = "０".charCodeAt(0) - "0".charCodeAt(0);

/**
 * 인원 자리 토큰 → 비율. 세 갈래를 **구분해서** 돌려준다.
 *
 *  · `number[]` — 비율이다. `[0]` 이 판매자, 이어서 친 순서대로 파티원1 · 파티원2 ….
 *  · `"invalid"` — **구분자가 있는데** 비율로 읽히지 않는다. 범위 밖(`0:5` · `3:100` · 일곱
 *    칸)이든 모양이 틀렸든(`3:7:` · `3::7` · `:3:7` · `3:7%` · `3.5:6.5` · 띄어 쓴 `3: 7` 의
 *    첫 토막 `3:`) 마찬가지다. 비율을 적으려던 것이 분명하므로 인원으로 되돌려 읽지 않고
 *    비율 오류를 알린다.
 *  · `null` — 비율 모양이 아니다. 부르는 쪽이 기존 인원 해석을 그대로 쓴다.
 *
 * ⚠️ **구분자가 하나라도 있으면 `null` 을 돌려주지 않는다**(2026-11-23 교차 검증). 처음에는
 *    엄격한 정규식에 맞지 않으면 `null` 이었는데, 그러면 부르는 쪽의 `parseInt` 가 `3:7:` 을
 *    **3인**으로 읽었다(콜론에서 읽기를 멈춘다) — `!분배` 는 엉뚱한 3인 균등을 답했고,
 *    연결된 계정의 `!드랍` 은 그 3인 균등을 **원장에 기록했다.** 잘못 적은 비율이 조용히 다른
 *    계산이 되는 것이 비율 오류 한 줄보다 훨씬 비싸다.
 *
 * 구분자형: 전각 숫자를 ASCII 로 바꾸고, **숫자 사이의** `대` 와 어디에 있든 `：` · `/` 를
 *   `:` 로 바꾼 뒤 `3:7` · `3:3:4`. 칸 2~6, 각 1~99. 소수 비율은 받지 않는다.
 *   숫자 사이가 아닌 `대`(`대적자` · `하대` · `3대`)는 구분자가 아니므로 `null` 이다.
 * 숫자만: `37` · `334` — **0 없는 2~6자리이고 12 보다 클 때만** 각 자리가 한 사람이다.
 *   `11` · `12` 는 지금처럼 인원수다(12인 파티가 있다). `20` · `100` 처럼 0 이 든 숫자는
 *   비율이 될 수 없으므로(0 몫은 없다) 인원으로 읽혀 기존 "최대 12" 안내로 간다.
 */
export function parseShareRatio(
  token: string | undefined,
): readonly number[] | "invalid" | null {
  if (token === undefined) return null;
  // 순서가 뜻을 갖는다: 전각 숫자를 먼저 바꿔야 `３대７` 의 `대` 가 숫자 사이로 보인다.
  const key = token
    .replace(FULLWIDTH_DIGIT, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET),
    )
    .replace(SHARE_RATIO_DAE, "$1:")
    .replace(SHARE_RATIO_SEPARATORS, ":");

  if (key.includes(":")) {
    if (!/^\d+(?::\d+)+$/u.test(key)) return "invalid";
    const weights = key.split(":").map(Number);
    if (
      weights.length < SHARE_RATIO_MIN_PARTS ||
      weights.length > SHARE_RATIO_MAX_PARTS ||
      weights.some(
        (weight) =>
          !Number.isInteger(weight) || weight < 1 || weight > SHARE_RATIO_MAX_WEIGHT,
      )
    ) {
      return "invalid";
    }
    return weights;
  }

  if (/^[1-9]{2,6}$/u.test(key) && Number(key) > 12) {
    return [...key].map(Number);
  }
  return null;
}

export interface WeightedDropSplitInput {
  /** 드랍이 팔린 총액(메소). */
  readonly grossMeso: number;
  /** 각자의 몫 비율. **`[0]` 이 판매자**, 이어서 친 순서대로 파티원1 · 파티원2 …. 양의 정수. */
  readonly weights: readonly number[];
  /** 경매장 수수료율. 3% → `0.03`. */
  readonly feeRate: number;
}

export interface WeightedDropSplit {
  /** 판매자가 드랍 판매로 손에 쥔 금액(R). */
  readonly leaderReceivesMeso: number;
  /** **파티원별 올릴 금액.** `[0]` = 파티원1(`weights[1]`), `[1]` = 파티원2 …. 길이 n−1. */
  readonly listPricesMeso: readonly number[];
  /** 각자 최종 금액. **`[0]` = 판매자**, 이어서 `weights` 순서(파티원1 · 파티원2 …). 길이 n. */
  readonly finalsMeso: readonly number[];
}

/**
 * 비율대로 나눈다. 유도는 위 블록 주석.
 *
 * @throws 가중치가 비었거나 양의 정수가 아니거나, 금액·수수료가 `computeDropSplit` 기준으로
 *   올바르지 않으면 던진다. 부르는 쪽이 먼저 거른다(`parseShareRatio`).
 */
export function computeWeightedDropSplit(
  input: WeightedDropSplitInput,
): WeightedDropSplit {
  const { grossMeso, weights, feeRate } = input;
  if (!Number.isFinite(grossMeso) || grossMeso < 0) {
    throw new Error("판매 금액이 올바르지 않습니다.");
  }
  if (
    weights.length < 1 ||
    weights.some((weight) => !Number.isInteger(weight) || weight < 1)
  ) {
    throw new Error("비율이 올바르지 않습니다.");
  }
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error("수수료율이 올바르지 않습니다.");
  }

  const keep = 1 - feeRate;
  const leaderReceivesMeso = Math.floor(grossMeso * keep);

  // 길이 ≥ 1 은 위에서 확인했다.
  const sellerWeight = weights[0];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // D = W − f × w₀. **이 형태 그대로** — 전부 1 이면 `people - feeRate` 와 같은 값이 된다.
  const denominator = totalWeight - feeRate * sellerWeight;

  // X_i = R × w_i / D. 곱이 먼저다 — w_i = 1 이면 `R / (n − f)` 와 같은 연산이 된다.
  const listPricesMeso = weights
    .slice(1)
    .map((weight) => Math.round((leaderReceivesMeso * weight) / denominator));
  const listedTotal = listPricesMeso.reduce((sum, price) => sum + price, 0);

  const finalsMeso = [
    // 반올림 잔차는 판매자가 흡수한다 — 파티원은 "올리라고 한 금액"을 정확히 올린다.
    leaderReceivesMeso - listedTotal,
    ...listPricesMeso.map((price) => Math.floor(price * keep)),
  ];

  return { leaderReceivesMeso, listPricesMeso, finalsMeso };
}

/**
 * 메소 → `310.27억`. 소수 2자리까지 쓰고 뒤의 0 은 접는다.
 *
 * 발주자가 `955.5억` 처럼 소수로 적겠다고 했으므로 표시도 같은 어휘를 쓴다.
 */
export function formatEok(meso: number): string {
  const eok = meso / MESO_PER_EOK;
  const rounded = Math.round(eok * 100) / 100;
  return `${String(rounded)}억`;
}

/**
 * `950` · `955.5` · `950억` → 메소 정수.
 *
 * 억 단위 입력만 받는다. 방에서 `95000000000` 을 치는 사람은 없고, 자릿수를 세다 틀리는
 * 쪽이 훨씬 흔하다.
 */
export function parseEok(token: string | undefined): number | null {
  if (token === undefined) return null;
  const key = token.replace(/[\s,]/gu, "").replace(/억$/u, "");
  if (!/^\d+(?:\.\d+)?$/u.test(key)) return null;
  const value = Number(key);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * MESO_PER_EOK);
}

/** `3%` · `3` · `0` → 0.03 · 0.03 · 0. **`%` 없이 적어도 퍼센트로 읽는다.** */
export function parseFeeRate(token: string | undefined): number | null {
  if (token === undefined) return null;
  const key = token.replace(/\s/gu, "").replace(/%$/u, "");
  if (!/^\d+(?:\.\d+)?$/u.test(key)) return null;
  const percent = Number(key);
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) return null;
  return percent / 100;
}
