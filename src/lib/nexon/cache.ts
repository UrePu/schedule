import "server-only";

/**
 * 넥슨 응답 서버 캐시.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 캐시가 "성능 최적화"가 아니라 **정확성 도구**인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 데이터는 약 15분 지연된다. 15분 안에 다시 물어도 **똑같은 값이 온다.**
 * 즉 이 캐시는 응답을 빠르게 만드는 것이 아니라, *새 정보가 없는 호출로 하루 예산을
 * 태우는 일*을 막는다. TTL 을 15분보다 짧게 잡을 이유가 원리적으로 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 격리 — 이걸 틀리면 남의 캐릭터 목록이 보인다
 * ─────────────────────────────────────────────────────────────────────────────
 * `/character/list` 는 같은 URL 인데 **키마다 결과가 다르다.** 경로만으로 캐시하면
 * A 의 캐릭터 목록이 B 에게 나간다. 그래서 캐시 키에 **키의 SHA-256 해시**를 넣는다.
 * (원문 키는 절대 넣지 않는다 — 메모리 덤프에도 남지 않게 한다.)
 *
 * ⚠️ **프로세스 메모리 캐시다.** 인스턴스가 여러 개면 인스턴스마다 따로 데워진다.
 *    호출량 장부(`nexon_api_quota_usage`)는 DB 라 전역이므로, 캐시 적중률이 낮아도
 *    "얼마나 썼는지"는 정확하게 남는다. 공유 캐시가 필요해지면 이 파일만 바꾼다.
 */

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: unknown;
}

/** 메모리 상한. 넘으면 가장 오래된 항목부터 버린다(삽입 순서 = Map 순회 순서). */
const MAX_ENTRIES = 500;

const store = new Map<string, CacheEntry>();

/**
 * 캐시 키. **키 해시가 반드시 앞에 온다** — 격리 실패를 눈으로 잡기 쉽게.
 * 쿼리는 정렬해 직렬화한다. `?a=1&b=2` 와 `?b=2&a=1` 은 같은 요청이다.
 */
export function buildNexonCacheKey(
  apiKeyHash: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(query ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const serialized = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return `${apiKeyHash}|${path}|${serialized}`;
}

export function getNexonCached<T>(key: string, now = Date.now()): T | undefined {
  const entry = store.get(key);
  if (entry === undefined) return undefined;

  if (entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }

  // LRU 근사: 읽을 때마다 뒤로 보내 오래된 것이 앞에 남게 한다.
  store.delete(key);
  store.set(key, entry);
  return entry.value as T;
}

export function setNexonCached(
  key: string,
  value: unknown,
  ttlMs: number,
  now = Date.now(),
): void {
  if (ttlMs <= 0) return;

  store.delete(key);
  store.set(key, { expiresAt: now + ttlMs, value });

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done === true) break;
    store.delete(oldest.value);
  }
}

/** 테스트·수동 검증용. 프로덕션 경로에서는 부르지 않는다. */
export function clearNexonCache(): void {
  store.clear();
}
