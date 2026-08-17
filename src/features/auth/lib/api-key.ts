/**
 * 브라우저에서의 API 키 취급 — **자격증명마다 하나씩, 전부 보관한다.**
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
 * - 로그아웃하면 **전부** 지운다.
 * - 서버는 키를 저장하지 않으므로 **유출 시 재발급 한 번으로 끝난다**(해시가 바뀌어도
 *   `user_nexon_accounts.nexon_account_id` 로 계정을 되찾는다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 왜 "하나"가 아니라 **맵**인가 — 실측으로 드러난 결함
 * ─────────────────────────────────────────────────────────────────────────────
 * §2.1 은 **한 사람이 넥슨 계정을 여러 개 갖는다**고 규정하고, 넥슨 키는 **그 키를 발급한
 * 계정의 캐릭터만** 읽는다(§1.1). 그런데 예전 구현은 원문 키를 `m_schedule.nexon_api_key`
 * **한 칸**에만 넣었다. 그래서 계정 3개를 등록한 실계정에서 다른 두 계정의 캐릭터는
 * 어떤 키를 보내도 넥슨이 `OPENAPI00004` 로 거절했고, 동기화가 **영원히** 실패했다.
 *
 * 그래서 저장 단위를 **`credentialId → 원문 키`** 로 바꾼다. 호출할 때는 그 캐릭터가
 * 속한 계정의 키를 골라 보낸다(해석 경로는 서버가 응답에 실어 주는 `credentialId`).
 *
 * ⚠️ **마스킹 스냅샷은 더 이상 따로 저장하지 않는다.** 원문 맵에서 그때그때 파생한다 —
 *    두 벌로 두면 반드시 갈라지고, 실제로 "마스킹은 있는데 키는 없는" 상태가 화면에서
 *    구분되지 않는 원인이었다. 예전 형식은 **읽기 전용 호환**으로만 남는다(아래 참고).
 */

/** 원문 키 맵. `{ credentialId: rawKey }` 형태의 JSON. */
export const API_KEY_MAP_STORAGE_KEY = "m_schedule.nexon_api_keys";

/**
 * 예전 형식(단일 키 / 마스킹 스냅샷). **읽기 전용 호환**이며 새로 쓰지 않는다.
 *
 * 이미 로그인해 둔 사용자가 이 배포 후 재로그인 없이도 그대로 쓸 수 있어야 한다.
 * 단일 키는 그 자체로는 "어느 자격증명의 것인지" 모르므로, **예전 마스킹 스냅샷과
 * 대조해** 소속을 복원한다(마스킹은 결정론적 함수라 대조가 성립한다).
 */
const LEGACY_SINGLE_KEY_STORAGE_KEY = "m_schedule.nexon_api_key";
const LEGACY_KEY_MASK_STORAGE_KEY = "m_schedule.nexon_key_masks";

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

// ─────────────────────────────────────────────────────────────────────────────
// 스냅샷 — 원문 맵과 마스킹 맵을 **한 번에** 만든다
// ─────────────────────────────────────────────────────────────────────────────

/** `credentialId → 원문 키`. **이 객체는 절대 화면에 렌더되지 않는다.** */
export type CredentialKeyMap = Readonly<Record<string, string>>;

/**
 * `credentialId → 마스킹된 키`.
 *
 * ⚠️ 여기에는 원문이 들어가지 않는다. 값은 전부 `maskApiKey()` 의 출력이다.
 *    값이 없는 자격증명은 "이 브라우저에 그 키가 없다"는 **정상 상태**이며,
 *    그 캐릭터의 동기화는 실패가 아니라 "키 없음"으로 표시된다.
 */
export type CredentialKeyMasks = Readonly<Record<string, string>>;

interface KeySnapshot {
  readonly keys: CredentialKeyMap;
  readonly masks: CredentialKeyMasks;
  /**
   * 원문 키를 실제로 들고 있는 자격증명 id (사전순).
   *
   * ★ `masks` 로 판정하면 안 된다 — 마스킹에는 예전 형식의 잔재가 섞일 수 있고,
   *   그 항목은 **표시만 되고 호출은 못 하는** 상태다. "동기화할 수 있는가"의 판정은
   *   언제나 이 목록이 한다.
   */
  readonly ids: readonly string[];
}

/** 서버 렌더·저장소 접근 실패 시의 값. **항상 같은 참조여야 한다**(하이드레이션). */
const EMPTY_SNAPSHOT: KeySnapshot = Object.freeze({
  keys: Object.freeze({}) as CredentialKeyMap,
  masks: Object.freeze({}) as CredentialKeyMasks,
  ids: Object.freeze([]) as readonly string[],
});

export const EMPTY_CREDENTIAL_KEY_MAP: CredentialKeyMap = EMPTY_SNAPSHOT.keys;
export const EMPTY_CREDENTIAL_KEY_MASKS: CredentialKeyMasks =
  EMPTY_SNAPSHOT.masks;
export const EMPTY_CREDENTIAL_ID_LIST: readonly string[] = EMPTY_SNAPSHOT.ids;

/*
 * `useSyncExternalStore` 는 스냅샷이 **참조까지 같아야** 한다. 매번 새 객체를 만들어
 * 돌려주면 리액트가 "바뀌었다"고 판단해 무한 렌더에 빠진다. 그래서 저장소의 원시
 * 문자열이 그대로면 이전에 만든 객체를 그대로 재사용한다.
 *
 * ★ 서명에 **세 칸을 전부** 넣는다. 예전 형식도 읽기 때문에, 그중 하나만 바뀌어도
 *   결과가 달라질 수 있다.
 * ★ 구분자로 이어 붙이지 않고 `JSON.stringify(배열)` 을 쓴다. 저장된 값은 사용자 입력에서
 *   온 임의의 문자열이라, 어떤 구분자를 골라도 그 문자가 값 안에 들어 있을 수 있고 그러면
 *   서로 다른 상태가 **같은 서명**이 되어 스냅샷이 갱신되지 않는다. 배열 직렬화에는 그
 *   함정이 없다.
 */
let snapshotSignature: string | null = null;
let snapshotValue: KeySnapshot = EMPTY_SNAPSHOT;

function readItem(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    // 사파리 프라이빗 모드 등에서는 접근 자체가 던진다. **없는 것이 정상 상태**다.
    return null;
  }
}

/** 문자열 → 문자열 맵으로만 좁힌다. 깨진 값은 조용히 버린다. */
function parseStringRecord(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") result[id] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function buildSnapshot(
  rawKeys: string | null,
  rawLegacyKey: string | null,
  rawLegacyMasks: string | null,
): KeySnapshot {
  const keys: Record<string, string> = {};
  for (const [id, value] of Object.entries(parseStringRecord(rawKeys))) {
    const normalized = normalizeApiKeyInput(value);
    if (normalized !== "") keys[id] = normalized;
  }

  const legacyMasks = parseStringRecord(rawLegacyMasks);

  /*
   * 예전 형식 복원 — 단일 키 1개를 **마스킹 대조**로 자격증명에 되붙인다.
   * 대조에 실패하면(마스킹 스냅샷이 없는 기기) 그냥 버린다. 소속을 모르는 키를
   * 아무 캐릭터에나 쓰면 넥슨 호출만 태우고 거절당하기 때문이다.
   */
  const legacyKey =
    rawLegacyKey === null ? "" : normalizeApiKeyInput(rawLegacyKey);
  if (legacyKey !== "") {
    const legacyMask = maskApiKey(legacyKey);
    for (const [id, mask] of Object.entries(legacyMasks)) {
      if (mask === legacyMask && keys[id] === undefined) {
        keys[id] = legacyKey;
        break;
      }
    }
  }

  /*
   * 마스킹은 **원문 맵에서 파생**한다. 예전 마스킹 스냅샷은 "이 기기에서 등록했지만
   * 원문은 남지 않은" 자격증명의 표시용으로만 뒤에 덧붙인다 — 그 항목은 키가 없으므로
   * 화면이 "키 없음"으로 그려야 하고, 그 판정은 마스킹이 아니라 `keys` 가 한다.
   */
  const masks: Record<string, string> = { ...legacyMasks };
  for (const [id, value] of Object.entries(keys)) masks[id] = maskApiKey(value);

  return { keys, masks, ids: Object.keys(keys).sort() };
}

function readSnapshot(): KeySnapshot {
  if (typeof window === "undefined") return EMPTY_SNAPSHOT;

  const rawKeys = readItem(API_KEY_MAP_STORAGE_KEY);
  const rawLegacyKey = readItem(LEGACY_SINGLE_KEY_STORAGE_KEY);
  const rawLegacyMasks = readItem(LEGACY_KEY_MASK_STORAGE_KEY);

  const signature = JSON.stringify([rawKeys, rawLegacyKey, rawLegacyMasks]);
  if (signature === snapshotSignature) return snapshotValue;

  snapshotValue = buildSnapshot(rawKeys, rawLegacyKey, rawLegacyMasks);
  snapshotSignature = signature;
  return snapshotValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// 읽기
// ─────────────────────────────────────────────────────────────────────────────

/** 저장된 원문 키 전부. `useSyncExternalStore` 의 스냅샷이므로 참조가 안정적이다. */
export function readStoredApiKeys(): CredentialKeyMap {
  return readSnapshot().keys;
}

/** 표시용 마스킹 맵. 원문은 들어 있지 않다. */
export function readCredentialKeyMasks(): CredentialKeyMasks {
  return readSnapshot().masks;
}

/** 원문 키를 실제로 들고 있는 자격증명 id. "동기화 가능한가"의 유일한 판정 근거다. */
export function readStoredCredentialIds(): readonly string[] {
  return readSnapshot().ids;
}

/**
 * **그 자격증명의 키**를 고른다. 없으면 `null` — 이것이 "키 없음" 상태의 정의다.
 *
 * ★ 없다고 해서 아무 키나 대신 보내지 않는다. 다른 계정의 키를 보내면 넥슨이
 *   `OPENAPI00004` 로 거절하며(§1.0 실측), 그 거절은 **우리 호출량을 태운 뒤에** 온다.
 */
export function readStoredApiKeyFor(credentialId: string | null): string | null {
  if (credentialId === null) return null;
  return readStoredApiKeys()[credentialId] ?? null;
}

/**
 * 자격증명을 특정할 수 없는 자리에서 쓰는 "아무 키".
 *
 * 쓰이는 곳은 **로그인 폼 하나**다 — §2.1 에 따라 어느 연결 키로 로그인해도 같은 사람이
 * 되므로, 저장된 키가 하나라도 있으면 재입력을 요구할 이유가 없다.
 * 동기화·초상화처럼 **대상이 정해진 호출에는 절대 쓰지 않는다.**
 *
 * 선택은 `credentialId` 사전순으로 **결정론적**이다. 매번 다른 키가 뽑히면
 * "저장된 키" 표시가 새로고침마다 바뀌어 사용자가 혼란스럽다.
 */
export function readAnyStoredApiKey(): string | null {
  const snapshot = readSnapshot();
  const first = snapshot.ids[0];
  return first === undefined ? null : (snapshot.keys[first] ?? null);
}

/** 이 브라우저가 원문 키를 들고 있는 자격증명인가. 화면의 "키 없음" 판정 지점. */
export function hasStoredApiKeyFor(credentialId: string | null): boolean {
  return readStoredApiKeyFor(credentialId) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기
// ─────────────────────────────────────────────────────────────────────────────

/** @returns 실제로 저장됐는가. 실패해도 이번 세션은 그대로 쓸 수 있다. */
function writeKeyMap(next: Record<string, string>): boolean {
  try {
    window.localStorage.setItem(API_KEY_MAP_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    // 저장 용량 초과·프라이빗 모드 등. 다음에 다시 입력하면 된다.
    return false;
  }
}

/**
 * 방금 검증된 키를 **그 자격증명 아래** 보관한다.
 *
 * 로그인·키 추가 두 경로에서 부른다. 둘 다 서버가 "이 키는 유효하고 이 자격증명이다"라고
 * 답한 **뒤에** 부르므로, 틀린 키가 저장돼 다음 진입에서 호출을 태우는 일이 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 단일 키 칸의 은퇴 — **승격된 뒤에만** 지운다
 * ─────────────────────────────────────────────────────────────────────────────
 * `readStoredApiKeys()` 는 이미 예전 단일 키를 자격증명에 되붙인 결과를 준다. 그래서
 * 그 결과를 그대로 저장하면 예전 키가 **맵으로 승격**된다. 승격이 확인된 뒤에야 예전
 * 칸을 지운다 — 순서를 뒤집거나 저장 성공을 확인하지 않으면, 저장이 실패한 브라우저에서
 * **키가 통째로 사라진다.**
 *
 * 조건이 "방금 넣은 값과 같을 때"가 아니라 "맵 어딘가에 그 값이 있을 때"인 이유:
 * 부계정 키를 추가하는 순간에도 본계정의 예전 키는 함께 승격되므로, 값이 달라도 이미
 * 안전하다. 예전 조건은 그 경우를 놓쳐 예전 칸이 계속 남았다.
 */
export function rememberCredentialKey(
  credentialId: string,
  rawKey: string,
): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeApiKeyInput(rawKey);
  if (normalized === "" || credentialId === "") return;

  const next = { ...readStoredApiKeys(), [credentialId]: normalized };
  const stored = writeKeyMap(next);

  const legacy = readItem(LEGACY_SINGLE_KEY_STORAGE_KEY);
  if (legacy !== null && stored) {
    const legacyValue = normalizeApiKeyInput(legacy);
    // ★ 맵에 그 값이 실제로 들어 있을 때만 지운다. 아니면 유일한 사본을 잃는다.
    if (Object.values(next).includes(legacyValue)) {
      try {
        window.localStorage.removeItem(LEGACY_SINGLE_KEY_STORAGE_KEY);
      } catch {
        // 못 지워도 동작에는 영향이 없다 — 같은 값이 맵에도 들어 있다.
      }
    }
  }

  emitStoredApiKeyChange();
}

/** 자격증명 하나의 키만 잊는다. "이 기기에서만 이 키를 지운다"에 해당한다. */
export function forgetCredentialKey(credentialId: string): void {
  if (typeof window === "undefined") return;
  const current = readStoredApiKeys();
  if (current[credentialId] === undefined) return;

  const next: Record<string, string> = { ...current };
  delete next[credentialId];
  writeKeyMap(next);
  emitStoredApiKeyChange();
}

/**
 * 로그아웃 — **저장된 키를 전부** 지운다. 예전 형식의 잔재까지 함께 지운다.
 * 마스킹만 남아 있어도 "누가 쓰던 기기인가"의 단서가 되므로 남기지 않는다.
 */
export function clearStoredApiKeys(): void {
  if (typeof window === "undefined") return;
  for (const storageKey of [
    API_KEY_MAP_STORAGE_KEY,
    LEGACY_SINGLE_KEY_STORAGE_KEY,
    LEGACY_KEY_MASK_STORAGE_KEY,
  ]) {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // 무시 — 지우지 못해도 세션 쿠키는 이미 사라졌다.
    }
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
