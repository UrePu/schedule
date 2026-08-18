import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 채널 인증 — **HMAC 서명 + 파생 시크릿**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 시크릿을 **파생**하는가 (이 파일에서 가장 중요한 결정)
 * ─────────────────────────────────────────────────────────────────────────────
 * 스키마는 `bot_channels.secret_hash` 를 **64 hex** 로 못박아 두었다. 즉 서버는
 * 원문 시크릿을 저장하지 않는다. 그런데 **HMAC 검증에는 키 원문이 필요하다.**
 * 이 모순의 해법은 셋뿐이다.
 *
 *   (a) `secret_hash` 자체를 HMAC 키로 쓴다 → DB 한 번 새면 **누구나 서명을 위조**한다.
 *       "해시만 보관"이라는 말이 사실상 무의미해진다.
 *   (b) 원문을 암호화해 보관한다 → 넣을 컬럼이 없다. **새 마이그레이션은 금지**다.
 *   (c) **서버 마스터키에서 채널마다 결정적으로 파생한다.** ← 우리가 고른 것
 *
 * (c) 는 `SESSION_SECRET` 과 정확히 같은 기조다(`features/auth/server/session.ts`):
 * 비밀은 **환경변수 한 곳**에 있고, DB 에는 그것을 확인할 해시만 남는다. DB 덤프
 * 하나로는 아무 서명도 만들 수 없고, `BOT_SIGNING_SECRET` 을 교체하면 **모든 채널이
 * 한 번에 무효**가 된다(전역 킬 스위치).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 회전을 세대(generation)로 표현하고, 세대는 **탐색으로 되찾는다**
 * ─────────────────────────────────────────────────────────────────────────────
 *   secret(g) = "whsec_" + base64url(HMAC(master, "<channelId>:<g>"))
 *
 * 세대 번호를 담을 컬럼이 없으므로, 저장된 `secret_hash` 와 일치하는 `g` 를
 * **0..MAX 까지 훑어서 찾는다.** 회전은 채널 수명 동안 손에 꼽을 만큼만 일어나므로
 * 탐색 비용은 해시 수십 번(마이크로초)이고, 찾은 결과는 프로세스 안에 캐시한다.
 * `previous_secret_hash` 도 같은 방법으로 되찾으므로 **회전 유예 기간이 그대로 성립**한다.
 *
 * ⚠️ 세대 상한(`MAX_GENERATION`)을 넘긴 채널은 회전할 수 없다. 그때는 방을 다시
 *    페어링한다 — 64회 회전이면 매달 한 번 돌려도 5년이다.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { requireEnv } from "@/lib/env";

/** 서명 버전. 경로가 아니라 서명 문자열에 박아 두면 계약 변경을 한눈에 구분할 수 있다. */
const SIGNATURE_VERSION = "v1";

/** 마스터키 최소 길이. 짧은 시크릿은 서명이 있으나 마나다(session.ts 와 같은 기준). */
const MIN_MASTER_LENGTH = 32;

/** 회전 세대 상한. 넘으면 재페어링. */
export const MAX_GENERATION = 64;

/** 타임스탬프 허용 오차(초). 양방향 ±300초. */
export const TIMESTAMP_WINDOW_SECONDS = 300;

function masterSecret(): string {
  const secret = requireEnv("BOT_SIGNING_SECRET", process.env.BOT_SIGNING_SECRET);
  if (secret.length < MIN_MASTER_LENGTH) {
    throw new Error(
      `[bot/signature] BOT_SIGNING_SECRET 이 너무 짧습니다(${String(secret.length)}자). ` +
        `${String(MIN_MASTER_LENGTH)}자 이상이어야 합니다. ` +
        `생성: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  return secret;
}

/** 채널 시크릿 원문. **로그·응답에 절대 싣지 않는다** — 페어링/회전 응답이 유일한 출구다. */
export function deriveChannelSecret(channelId: string, generation: number): string {
  const mac = createHmac("sha256", masterSecret())
    .update(`${channelId}:${String(generation)}`, "utf8")
    .digest("base64url");
  return `whsec_${mac}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * 저장된 해시에 대응하는 원문 시크릿을 되찾는다. 없으면 `null`
 * (마스터키가 바뀌었거나, 세대 상한을 넘었거나, 해시가 우리 것이 아니다).
 */
const secretCache = new Map<string, string>();
const SECRET_CACHE_MAX = 512;

export function resolveSecretByHash(
  channelId: string,
  secretHash: string,
): string | null {
  const cacheKey = `${channelId}:${secretHash}`;
  const cached = secretCache.get(cacheKey);
  if (cached !== undefined) return cached;

  for (let generation = 0; generation <= MAX_GENERATION; generation += 1) {
    const candidate = deriveChannelSecret(channelId, generation);
    if (hashSecret(candidate) === secretHash) {
      // 무한정 자라지 않게 가장 오래된 것부터 버린다(정확한 LRU 가 필요할 규모가 아니다).
      if (secretCache.size >= SECRET_CACHE_MAX) {
        const oldest = secretCache.keys().next().value;
        if (oldest !== undefined) secretCache.delete(oldest);
      }
      secretCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  return null;
}

/** 저장된 해시의 세대 번호. 회전할 때 `g + 1` 을 만들기 위해 필요하다. */
export function findGeneration(channelId: string, secretHash: string): number | null {
  for (let generation = 0; generation <= MAX_GENERATION; generation += 1) {
    if (hashSecret(deriveChannelSecret(channelId, generation)) === secretHash) {
      return generation;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 서명 문자열
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 결정적 JSON. **키를 정렬**하므로 클라이언트와 서버가 같은 바이트를 만든다.
 *
 * 원문 바이트(raw body)를 해싱하지 않는 이유: 클라이언트마다 JSON 직렬화의 공백·키
 * 순서가 다르고, 그 차이를 맞추라고 요구하면 붙일 수 있는 클라이언트가 줄어든다.
 * **의미가 같으면 서명도 같아야** 한다.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface SignatureBaseInput {
  readonly timestamp: number;
  readonly nonce: string;
  readonly method: string;
  /** 쿼리스트링을 **포함한** 경로. GET 은 쿼리가 곧 요청 내용이다. */
  readonly path: string;
  /** 본문이 없으면 빈 문자열의 해시. */
  readonly bodyHash: string;
}

/** `{timestamp}.{nonce}.{METHOD}.{path}.{sha256(body)}` */
export function signatureBase(input: SignatureBaseInput): string {
  return [
    String(input.timestamp),
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
  ].join(".");
}

export function computeSignature(secret: string, base: string): string {
  const mac = createHmac("sha256", secret).update(base, "utf8").digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

/** **상수시간 비교.** 길이가 다르면 비교할 것도 없다. */
export function signatureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 서버 시각 대비 허용 창 안인가. 밖이면 401(재생 공격 1차 방어). */
export function timestampWithinWindow(timestamp: number, now: Date): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  return drift <= TIMESTAMP_WINDOW_SECONDS;
}
