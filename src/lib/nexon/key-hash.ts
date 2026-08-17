import "server-only";

import { createHash } from "node:crypto";

/**
 * API 키의 SHA-256 해시. **DB 에는 이 값만 들어간다** (CLAUDE.md §2.1.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정규화가 계약의 일부다
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용자는 키를 복사·붙여넣기 하므로 앞뒤 공백과 개행이 자주 섞인다.
 * 해시 전에 정규화하지 않으면 **같은 키가 두 개의 계정을 만든다.**
 * 그래서 정규화는 여기 한 곳에만 있고, 넥슨에 보낼 때도 같은 정규화 결과를 쓴다.
 * (해시한 키와 실제로 호출한 키가 다르면 장부와 현실이 갈라진다.)
 */
export function normalizeApiKey(rawKey: string): string {
  return rawKey.trim();
}

/** 정규화된 키의 SHA-256 (소문자 hex 64자). `user_credentials.api_key_hash` 와 같은 값. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(normalizeApiKey(rawKey), "utf8").digest("hex");
}
