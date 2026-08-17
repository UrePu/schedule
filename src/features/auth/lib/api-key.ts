/**
 * 브라우저에서의 API 키 취급.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 localStorage 인가 (CLAUDE.md §2.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요구가 "키를 다시 입력하게 하지 말 것"이다. 그리고 **원문 키는 DB 에 저장하지
 * 않기로** 되어 있으므로(서버 측 갱신에 옵트인한 경우의 암호화 저장은 예외), 키를 들고
 * 있을 수 있는 곳은 사용자의 브라우저뿐이다. 넥슨 호출이 필요할 때 프록시로 보낸다.
 *
 * 대가는 분명하다 — **XSS 가 나면 키가 새어 나간다.** 세션 쿠키를 httpOnly 로 둔 것과
 * 다른 취급이며, 알고 감수하는 부분이다. 대신:
 * - 키를 **화면에 그대로 그리지 않는다**(`maskApiKey`).
 * - 로그아웃하면 지운다.
 * - 서버는 키를 저장하지 않으므로 **유출 시 재발급 한 번으로 끝난다**(해시가 바뀌어도
 *   `user_nexon_accounts.nexon_account_id` 로 계정을 되찾는다).
 */

/** localStorage 키. 다른 값과 섞이지 않도록 네임스페이스를 붙인다. */
export const API_KEY_STORAGE_KEY = "m_schedule.nexon_api_key";

/**
 * `credentialId → 마스킹된 키` 스냅샷.
 *
 * ⚠️ **여기에는 원문이 들어가지 않는다.** 저장되는 값은 이미 `maskApiKey()` 를 통과한
 *    `test_5••••••••fb0d` 형태뿐이라, 이 항목이 통째로 유출돼도 키를 복원할 수 없다.
 *
 * 왜 필요한가: 서버는 원문 키를 저장하지 않으므로(§2.1.1) **키 목록에 "어느 키인지"를
 * 표시할 방법이 서버 쪽에 없다.** 라벨만으로는 같은 이름을 두 번 붙인 사용자가 구분하지
 * 못한다. 그렇다고 해시를 보여 주면 사용자가 자기 키와 대조할 수 없다.
 * 그래서 **키를 실제로 입력한 그 브라우저**가 마스킹 결과만 남겨 둔다.
 * 다른 기기에서 등록한 키에는 마스킹이 없고, 그건 오류가 아니라 정상 상태다.
 */
const KEY_MASK_STORAGE_KEY = "m_schedule.nexon_key_masks";

/**
 * ★ **서버의 `normalizeApiKey` 와 반드시 같은 결과여야 한다.**
 * 서버가 해시하는 문자열과 브라우저가 보관하는 문자열이 다르면, 같은 키가 두 개의
 * 계정으로 갈라진다. 지금 규칙은 "앞뒤 공백 제거" 하나뿐이다.
 */
export function normalizeApiKeyInput(rawKey: string): string {
  return rawKey.trim();
}

/**
 * 화면에 보여 줄 마스킹 문자열.
 *
 * 앞 6자·뒤 4자만 남긴다. 사용자가 "어느 키인지" 알아보기에는 충분하고,
 * 어깨너머로 읽히거나 스크린샷에 남아도 복원할 수 없는 정도다.
 * 짧은 값은 아예 전부 가린다 — 짧을수록 일부만으로 추측되기 쉽다.
 */
export function maskApiKey(rawKey: string): string {
  const key = normalizeApiKeyInput(rawKey);
  if (key === "") return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}

/** 비어 있지 않은가. **형식(접두사 등)으로 키를 판별하지 않는다** — 유효성은 넥슨이 판정한다. */
export function isApiKeyInputUsable(rawKey: string): boolean {
  return normalizeApiKeyInput(rawKey).length > 0;
}

/**
 * 저장된 키를 읽는다.
 *
 * 사파리 프라이빗 모드 등에서는 localStorage 접근 자체가 던진다.
 * **저장이 안 되는 것은 정상 상태**이므로(키를 다시 입력하면 된다) 조용히 null 을 준다.
 */
export function readStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(API_KEY_STORAGE_KEY);
    if (value === null) return null;
    const normalized = normalizeApiKeyInput(value);
    return normalized === "" ? null : normalized;
  } catch {
    return null;
  }
}

export function storeApiKey(rawKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      API_KEY_STORAGE_KEY,
      normalizeApiKeyInput(rawKey),
    );
  } catch {
    // 저장에 실패해도 이번 세션은 그대로 쓸 수 있다. 다음에 다시 입력하면 된다.
  }
  emitStoredApiKeyChange();
}

export function clearStoredApiKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // 무시 — 지우지 못해도 세션 쿠키는 이미 사라졌다.
  }
  emitStoredApiKeyChange();
}

// ─────────────────────────────────────────────────────────────────────────────
// 자격증명별 마스킹 스냅샷 — **원문은 들어가지 않는다**
// ─────────────────────────────────────────────────────────────────────────────

export type CredentialKeyMasks = Readonly<Record<string, string>>;

const EMPTY_MASKS: CredentialKeyMasks = Object.freeze({});

/*
 * `useSyncExternalStore` 는 스냅샷이 **참조까지 같아야** 한다. 매번 새 객체를 만들어
 * 돌려주면 리액트가 "바뀌었다"고 판단해 무한 렌더에 빠진다. 그래서 원문 문자열이
 * 그대로면 이전에 만든 객체를 그대로 재사용한다.
 */
let maskCacheRaw: string | null = null;
let maskCacheValue: CredentialKeyMasks = EMPTY_MASKS;

/** 저장된 마스킹 맵. 깨진 값은 조용히 버린다 — 없는 것이 정상 상태이기 때문이다. */
export function readCredentialKeyMasks(): CredentialKeyMasks {
  if (typeof window === "undefined") return EMPTY_MASKS;
  try {
    const raw = window.localStorage.getItem(KEY_MASK_STORAGE_KEY);
    if (raw === null) return EMPTY_MASKS;
    if (raw === maskCacheRaw) return maskCacheValue;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return EMPTY_MASKS;
    }
    const result: Record<string, string> = {};
    for (const [id, mask] of Object.entries(parsed as Record<string, unknown>)) {
      // 값이 문자열이 아니면 버린다. 그리고 **불릿이 없는 값은 저장하지 않는다** —
      // 어떤 경로로든 원문이 흘러 들어온 흔적이면 그대로 화면에 그리지 않기 위해서다.
      if (typeof mask === "string" && mask.includes("•")) result[id] = mask;
    }
    maskCacheRaw = raw;
    maskCacheValue = result;
    return result;
  } catch {
    return EMPTY_MASKS;
  }
}

/**
 * 방금 입력한 키의 **마스킹 결과만** 그 자격증명 id 아래 기록한다.
 * 원문을 넘겨받지만 저장하는 것은 `maskApiKey()` 의 출력뿐이다.
 */
export function rememberCredentialKeyMask(
  credentialId: string,
  rawKey: string,
): void {
  if (typeof window === "undefined") return;
  const masked = maskApiKey(rawKey);
  if (masked === "") return;
  try {
    const next = { ...readCredentialKeyMasks(), [credentialId]: masked };
    window.localStorage.setItem(KEY_MASK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장 실패는 표시 편의가 사라질 뿐이라 기능에 영향이 없다.
  }
  emitStoredApiKeyChange();
}

/** 로그아웃 시 함께 지운다. 마스킹만 남아 있어도 "누가 쓰던 기기인가"의 단서가 된다. */
export function clearCredentialKeyMasks(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY_MASK_STORAGE_KEY);
  } catch {
    // 무시.
  }
  emitStoredApiKeyChange();
}

// ─────────────────────────────────────────────────────────────────────────────
// 외부 저장소 구독 — React 가 localStorage 변화를 알아채는 유일한 경로
// ─────────────────────────────────────────────────────────────────────────────
//
// localStorage 는 React 상태가 아니라 **외부 저장소**다. 그래서 `useEffect` 로 읽어
// `setState` 하는 대신 `useSyncExternalStore` 로 구독한다(그 방식은 마운트마다 추가
// 렌더를 유발하고, 서버 렌더 결과와도 어긋난다).
//
// `storage` 이벤트는 **다른 탭**의 변경만 알려 준다. 같은 탭에서 우리가 바꾼 것은
// 직접 알려야 하므로 로컬 리스너 집합을 함께 둔다.

const listeners = new Set<() => void>();

function emitStoredApiKeyChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeStoredApiKey(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", listener);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", listener);
    }
  };
}
