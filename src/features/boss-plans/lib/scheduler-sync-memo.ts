"use client";

import { maskApiKey } from "@/features/auth/lib/api-key";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 자동 동기화 **실패 기억** — 같은 실패를 진입할 때마다 반복하지 않는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 필요한가 — 실제 계정에서 확인된 예산 누수
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 사람이 넥슨 계정을 여러 개 쓸 수 있고(§2.1), 계정마다 키가 따로다. 그런데 브라우저
 * localStorage 에 들어 있는 **원문 키는 언제나 하나뿐**이다(`api-key.ts`). 그래서 지금
 * 저장된 키로는 **다른 계정 소속 캐릭터의 스케줄러를 절대 읽을 수 없다** — 넥슨이
 * `OPENAPI00004`(`invalid_parameter`)로 거절한다(§1.0 실측).
 *
 * 신선도 가드는 `fetched_at` 을 보는데, 실패하면 스냅샷이 생기지 않으므로 그 캐릭터는
 * **영원히 "한 번도 안 불렀음"** 으로 남는다. 그러면 대시보드에 들어갈 때마다 같은
 * 캐릭터에 같은 호출을 쏘고 같은 거절을 받는다. 실측 계정 기준 **진입 1회당 3콜**이
 * 아무 소득 없이 나간다 — 개발 키 하루 1,000콜에서 이건 그냥 새는 구멍이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 기억하는가
 * ─────────────────────────────────────────────────────────────────────────────
 * `캐릭터 → (그때 쓰던 키의 마스킹, 실패 시각)`.
 *
 * ★ **마스킹과 함께** 기억하는 것이 핵심이다. "이 캐릭터는 못 읽는다"는 사실은 **키에
 *   딸린 것**이지 캐릭터에 딸린 것이 아니다. 사용자가 부계정 키로 바꿔 로그인하면
 *   마스킹이 달라지고, 그 순간 기억이 무효가 되어 **즉시 다시 시도한다.**
 *
 * ★ 저장되는 값은 `maskApiKey()` 의 출력(`test_5••••••••fb0d`)뿐이다. 원문은 들어가지
 *   않으며, 이는 이미 `m_schedule.nexon_key_masks` 가 쓰는 것과 같은 취급이다.
 *
 * ★ **수동 버튼은 이 기억을 보지 않는다.** 사용자가 직접 누르는 것은 언제나 통과한다 —
 *   키를 바꿨는데 우리가 눈치 못 챈 경우의 탈출구가 필요하기 때문이다.
 *   성공하면 그 캐릭터의 기억을 지운다.
 */

const STORAGE_KEY = "m_schedule.scheduler_sync_skip";

/**
 * 기억의 유효 기간 — **24시간.**
 *
 * 키가 그대로인 한 결과도 그대로이므로 원리적으로는 무기한이어도 맞다. 그래도 상한을
 * 두는 이유는 우리가 원인을 100% 알지 못하기 때문이다 — 넥슨의 일시적 파라미터 거절이
 * 섞여 있을 수 있다. 하루에 한 번은 다시 확인해 스스로 회복하되, 그 이상은 태우지 않는다.
 * (캐릭터당 하루 1콜 = 실측 계정 기준 하루 3콜. 진입마다 3콜과는 자릿수가 다르다.)
 */
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;

interface MemoEntry {
  /** 실패 당시 쓰던 키의 마스킹. 원문이 아니다. */
  readonly mask: string;
  /** 실패 시각(epoch ms). */
  readonly at: number;
}

export type SyncFailureMemo = Readonly<Record<string, MemoEntry>>;

const EMPTY: SyncFailureMemo = Object.freeze({});

function isEntry(value: unknown): value is MemoEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.mask === "string" && typeof candidate.at === "number";
}

/** 저장된 기억. 깨졌거나 만료된 항목은 조용히 버린다 — 없는 것이 정상 상태다. */
export function readSyncFailureMemo(now = Date.now()): SyncFailureMemo {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return EMPTY;
    }
    const result: Record<string, MemoEntry> = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isEntry(entry)) continue;
      if (now - entry.at >= MEMO_TTL_MS) continue;
      result[id] = entry;
    }
    return result;
  } catch {
    return EMPTY;
  }
}

function write(memo: SyncFailureMemo): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memo));
  } catch {
    // 저장 실패는 "다음에 또 시도한다"로 끝난다. 기능이 깨지지는 않는다.
  }
}

/** 이 캐릭터는 지금 키로 읽을 수 없더라 — 하고 적어 둔다. 만료 항목은 함께 정리된다. */
export function rememberSyncFailure(
  characterId: string,
  apiKey: string,
  now = Date.now(),
): void {
  write({
    ...readSyncFailureMemo(now),
    [characterId]: { mask: maskApiKey(apiKey), at: now },
  });
}

/** 성공했으면 기억을 지운다. 자동·수동 어느 경로로 성공했든 마찬가지다. */
export function forgetSyncFailure(characterId: string, now = Date.now()): void {
  const memo = readSyncFailureMemo(now);
  if (!(characterId in memo)) return;
  const next: Record<string, MemoEntry> = { ...memo };
  delete next[characterId];
  write(next);
}

/**
 * 이번 자동 동기화에서 이 캐릭터를 건너뛸 것인가.
 *
 * 기억이 있고 **그때와 같은 키**를 쓰고 있을 때만 건너뛴다. 키가 바뀌었으면 결과도
 * 달라질 수 있으므로 다시 시도한다.
 */
export function isAutoSyncSuppressed(
  characterId: string,
  apiKey: string,
  memo: SyncFailureMemo,
): boolean {
  const entry = memo[characterId];
  if (entry === undefined) return false;
  return entry.mask === maskApiKey(apiKey);
}
