/**
 * 넥슨 응답의 값 표현을 우리 도메인 값으로 옮기는 변환기.
 *
 * 세 가지가 전부 **실측으로 확정**됐다 (CLAUDE.md §1.0).
 * 여기 있는 규칙을 다른 곳에서 다시 구현하지 말 것 — 화면·봇·동기화가 갈라진다.
 */

import type { Database } from "@/types/database";

import { NexonApiError } from "./errors";

type BossCycle = Database["public"]["Enums"]["boss_cycle"];
type BossDifficultyTier = Database["public"]["Enums"]["boss_difficulty_tier"];

/**
 * 넥슨의 불리언은 **문자열 `"true"` / `"false"`** 다. 진짜 불리언이 아니다.
 *
 * 이것을 모르면 `if (boss.complete_flag)` 가 `"false"` 에서도 참이 된다 —
 * 즉 **안 깬 보스를 전부 깬 것으로 집계**한다. 그래서 파서를 한 곳에 둔다.
 *
 * 관측된 값 집합: `"true"`, `"false"` (boss/daily/weekly 의 모든 플래그 필드).
 * 진짜 불리언도 받아 주지만, 그 밖의 값은 **던진다** — 조용히 false 로 처리하면
 * 스펙 드리프트가 "아무도 보스를 안 깼다"로 위장되기 때문이다.
 */
export function parseNexonFlag(value: unknown): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value === "boolean") return value;

  throw new NexonApiError({
    kind: "schema_mismatch",
    detail: `예상하지 못한 플래그 값: ${JSON.stringify(value)} (실측 값은 "true" / "false" 뿐)`,
  });
}

/** 값이 없을 수도 있는 플래그. 없으면 null 이며 던지지 않는다. */
export function parseOptionalNexonFlag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return parseNexonFlag(value);
}

/**
 * `cycle` 은 camelCase 에 `boss` 접두사가 붙어 있다 — 우리 `boss_cycle` enum 과 다르다.
 * 매핑하지 않고 그대로 넣으면 enum 위반으로 INSERT 가 통째로 실패한다.
 */
const CYCLE_MAP: Readonly<Record<string, BossCycle>> = {
  bossDaily: "daily",
  bossWeekly: "weekly",
  bossMonthly: "monthly",
};

/**
 * 넥슨 `cycle` → `boss_cycle`. 모르는 값이면 **null** 이다.
 *
 * 던지지 않는 이유: 새 주기가 추가돼도 나머지 보스 동기화는 계속돼야 한다.
 * 호출부는 null 을 `nexon_unmapped_contents` 로 기록해 사람이 보게 만든다.
 */
export function nexonCycleToBossCycle(value: string | null): BossCycle | null {
  if (value === null) return null;
  return CYCLE_MAP[value] ?? null;
}

/**
 * `difficulty` 는 소문자 영문이라 우리 `boss_difficulty_tier` enum 과 **이미 일치**한다.
 * 그래도 검증은 한다 — 일치한다는 사실이 계약이 되려면 어긋남을 잡아야 한다.
 */
const DIFFICULTY_TIERS: readonly BossDifficultyTier[] = [
  "easy",
  "normal",
  "chaos",
  "hard",
  "extreme",
];

export function nexonDifficultyToTier(
  value: string | null,
): BossDifficultyTier | null {
  if (value === null) return null;
  return DIFFICULTY_TIERS.find((tier) => tier === value) ?? null;
}
