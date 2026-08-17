import type { MesoOrUnknown } from "@/types/domain";

/**
 * 결정석 개인 수령액 = `floor(솔로 기준가 / 입장 시점 파티 인원)`.
 *
 * 근거(CLAUDE.md §1 · DB-SCHEMA 난제 5 R1): 마스터에 적힌 가격은 **전부 솔로 기준**이며
 * 게임은 입장 인원으로 1/n 을 나눠 지급한다. 인원을 빼먹으면 수익이 **최대 6배 과대
 * 계상**된다. DB 도 `crystal_share_meso` 를 같은 식으로 스냅샷한다.
 *
 * ★ 가격이 `null`(미확인)이면 결과도 `null` 이다 (§1.3 D4).
 *   `0` 으로 떨어뜨리면 "0메소를 벌었다"는 사실 주장이 되어 수익을 조용히 축소한다.
 *   화면은 이 `null` 을 반드시 "미확인"으로 표시하고 합계에서 제외해야 한다.
 */
export function crystalShareMeso(
  soloPriceMeso: MesoOrUnknown,
  partySize: number,
): MesoOrUnknown {
  if (soloPriceMeso === null) return null;
  if (!Number.isFinite(partySize) || partySize < 1) return null;
  return Math.floor(soloPriceMeso / Math.trunc(partySize));
}
