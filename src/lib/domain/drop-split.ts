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
  /** 흔히 하는 실수 — `R / n` 을 올렸을 때 파티원이 받는 금액. 비교용. */
  readonly naiveMemberMeso: number;
  /** 그 실수로 파티장이 더 갖게 되는 금액. */
  readonly naiveLeaderGainMeso: number;
}

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
      naiveMemberMeso: leaderReceivesMeso,
      naiveLeaderGainMeso: 0,
    };
  }

  // X = R / (n − f)
  const listPriceMeso = Math.round(leaderReceivesMeso / (people - feeRate));
  // 파티원이 실제로 손에 쥐는 값. 파티장 몫은 잔차를 흡수하므로 이쪽을 기준으로 삼는다.
  const eachFinalMeso = Math.floor(listPriceMeso * keep);

  const naiveListPrice = Math.round(leaderReceivesMeso / people);
  const naiveMemberMeso = Math.floor(naiveListPrice * keep);

  return {
    leaderReceivesMeso,
    listPriceMeso,
    eachFinalMeso,
    naiveMemberMeso,
    naiveLeaderGainMeso: naiveListPrice - naiveMemberMeso,
  };
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
