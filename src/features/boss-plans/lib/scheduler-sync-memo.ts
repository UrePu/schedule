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
 * 신선도 가드는 `fetched_at` 을 보는데, 실패하면 스냅샷이 생기지 않으므로 그 캐릭터는
 * **영원히 "한 번도 안 불렀음"** 으로 남는다. 그러면 대시보드에 들어갈 때마다 같은
 * 캐릭터에 같은 호출을 쏘고 같은 거절을 받는다. 개발 키 하루 1,000콜에서 이건 그냥
 * 새는 구멍이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 무엇이 바뀌었나 — **"키가 하나"라는 전제가 사라졌다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 이 파일은 "브라우저에 원문 키는 언제나 하나뿐"이라는 전제 위에 있었고, 그래서
 * 다른 계정 캐릭터의 실패를 **정상 상태로 기억**하는 것이 최선이었다. 이제 저장소가
 * `credentialId → 원문 키` 맵이라 그 전제가 없다(`features/auth/lib/api-key.ts`):
 *
 * - **키가 없는 캐릭터는 애초에 호출되지 않는다.** 호출이 없으니 실패도 없고, 기억할
 *   것도 없다. 그건 실패가 아니라 "키 없음" 상태이며 화면이 따로 표시한다.
 * - **키가 틀린 캐릭터도 호출되지 않는다.** 서버가 넥슨을 부르기 전에 자격증명 ↔ 계정
 *   링크를 확인해 끊는다(`sync-scheduler.ts`).
 *
 * 그래서 이 기억이 남는 경우는 **진짜 알 수 없는 실패**뿐이고, 훨씬 드물게 쓰인다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 기억하는가
 * ─────────────────────────────────────────────────────────────────────────────
 * `캐릭터 → (그때 쓴 자격증명 id, 그 키의 마스킹, 실패 시각)`.
 *
 * ★ **자격증명 id 와 마스킹을 함께** 기억하는 것이 핵심이다. "이 캐릭터는 못 읽는다"는
 *   사실은 **키에 딸린 것**이지 캐릭터에 딸린 것이 아니다. 사용자가 그 계정의 키를
 *   새로 입력하면 마스킹이 달라지고, 그 순간 기억이 무효가 되어 **즉시 다시 시도한다.**
 *   자격증명이 바뀐 경우(캐릭터가 다른 계정으로 재해석됨)도 마찬가지다.
 *
 * ★ 저장되는 값은 `maskApiKey()` 의 출력(`test_5••••••••fb0d`)뿐이다. **원문은 들어가지
 *   않는다.**
 *
 * ★ **수동 버튼은 이 기억을 보지 않는다.** 사용자가 직접 누르는 것은 언제나 통과한다 —
 *   우리가 눈치 못 챈 변화의 탈출구가 필요하기 때문이다. 성공하면 기억을 지운다.
 */

/**
 * `.v2` 인 이유: 항목 모양이 `{mask, at}` → `{credentialId, mask, at}` 로 바뀌었다.
 * 예전 항목은 **자격증명을 모르므로** 새 판정(자격증명 일치)에 쓸 수 없고, 억지로
 * 해석하면 "다른 계정 키로 실패한 기억" 때문에 **올바른 키가 생긴 뒤에도 건너뛰는**
 * 정반대의 사고가 난다. 그래서 통째로 버린다 — 최악의 결과는 캐릭터당 1콜을 한 번 더
 * 쓰는 것뿐이고, 잘못 건너뛰는 쪽이 훨씬 비싸다.
 */
const STORAGE_KEY = "m_schedule.scheduler_sync_skip.v2";

/** 예전 형식. 읽지 않고 **지우기만** 한다(로그아웃 시). */
const LEGACY_STORAGE_KEY = "m_schedule.scheduler_sync_skip";

/**
 * 기억의 유효 기간 — **24시간.**
 *
 * 키가 그대로인 한 결과도 그대로이므로 원리적으로는 무기한이어도 맞다. 그래도 상한을
 * 두는 이유는 우리가 원인을 100% 알지 못하기 때문이다 — 넥슨의 일시적 거절이 섞여 있을
 * 수 있다. 하루에 한 번은 다시 확인해 스스로 회복하되, 그 이상은 태우지 않는다.
 */
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;

interface MemoEntry {
  /** 실패 당시 쓴 자격증명. 이것이 달라지면 기억은 무효다. */
  readonly credentialId: string;
  /** 실패 당시 쓴 키의 마스킹. 원문이 아니다. */
  readonly mask: string;
  /** 실패 시각(epoch ms). */
  readonly at: number;
}

export type SyncFailureMemo = Readonly<Record<string, MemoEntry>>;

const EMPTY: SyncFailureMemo = Object.freeze({});

function isEntry(value: unknown): value is MemoEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.credentialId === "string" &&
    typeof candidate.mask === "string" &&
    typeof candidate.at === "number"
  );
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

/** 이 캐릭터는 이 자격증명의 키로는 읽히지 않더라 — 하고 적어 둔다. 만료 항목도 함께 정리된다. */
export function rememberSyncFailure(
  characterId: string,
  credentialId: string,
  apiKey: string,
  now = Date.now(),
): void {
  write({
    ...readSyncFailureMemo(now),
    [characterId]: { credentialId, mask: maskApiKey(apiKey), at: now },
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
 * 로그아웃 시 통째로 지운다.
 *
 * 남겨 두면 캐릭터 UUID 와 키 마스킹이 그대로 남아 "이 기기를 누가 쓰는가"의 단서가
 * 된다 — 저장된 키를 전부 지우는 것과 같은 이유다. 예전 형식도 함께 지운다.
 */
export function clearSyncFailureMemo(): void {
  if (typeof window === "undefined") return;
  for (const storageKey of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // 무시 — 지우지 못해도 24시간 뒤 만료된다.
    }
  }
}

/**
 * 이번 자동 동기화에서 이 캐릭터를 건너뛸 것인가.
 *
 * 기억이 있고 **그때와 같은 자격증명 · 같은 키**를 쓰고 있을 때만 건너뛴다.
 * 둘 중 하나라도 바뀌었으면 결과가 달라질 수 있으므로 **즉시 다시 시도한다** —
 * 사용자가 방금 그 계정의 키를 넣었는데 기다리게 하면 고친 것이 고쳐 보이지 않는다.
 */
export function isAutoSyncSuppressed(
  characterId: string,
  credentialId: string,
  apiKey: string,
  memo: SyncFailureMemo,
): boolean {
  const entry = memo[characterId];
  if (entry === undefined) return false;
  return (
    entry.credentialId === credentialId && entry.mask === maskApiKey(apiKey)
  );
}
