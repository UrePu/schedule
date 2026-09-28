import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 런너 인증 — **설치 토큰 하나 + HMAC 서명**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28 에 무엇이 바뀌었나
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 **방마다 시크릿**이 있었고, 스키마가 해시만 보관하는 탓에 원문을
 * `BOT_SIGNING_SECRET` 에서 채널·세대별로 파생해 쓰고(그 값을 저장된 해시와 맞을 때까지
 * 0..64 세대를 훑어 되찾고) 회전까지 그 위에 얹혀 있었다. 방 개념이 사라지면서 **그
 * 구조 전체가 근거를 잃었다** — 방이 없으면 방별 시크릿도, 방별 회전도 없다.
 *
 * 남은 것은 하나다: **`BOT_RUNNER_TOKEN` 이 곧 HMAC 키다.**
 *   - 런너가 설치될 때 사람이 한 번 적는다(스크립트 상단 `CONFIG.RUNNER_TOKEN`).
 *   - 서버는 환경변수로 갖는다. DB 에는 아무 시크릿도 없다.
 *   - 토큰을 교체하면 **모든 런너가 한 번에 무효**가 된다(전역 킬 스위치).
 *   → `SESSION_SECRET` 과 정확히 같은 기조다(`features/auth/server/session.ts`).
 *
 * ★ **서명을 없애지 않았다.** 토큰만 확인하고 끝내면 요청을 한 번 캡처한 쪽이 그것을
 *   영구히 재생할 수 있다. 서명 + 타임스탬프 창(±300초) + nonce 1회성이 그 창을
 *   "300초 안에 한 번"으로 줄인다. 토큰은 키이고 서명은 요청 하나를 그 키로 묶는
 *   장치이므로, 둘은 서로를 대신하지 못한다.
 *
 * ⚠️ 토큰 원문은 **로그·응답에 절대 나가지 않는다.** 길이 검사 실패 메시지에도 값이
 *    아니라 길이만 싣는다.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { requireEnv } from "@/lib/env";

/** 서명 버전. 경로가 아니라 서명 문자열에 박아 두면 계약 변경을 한눈에 구분할 수 있다. */
const SIGNATURE_VERSION = "v1";

/** 토큰 최소 길이. 짧은 시크릿은 서명이 있으나 마나다(`session.ts` 와 같은 기준). */
const MIN_TOKEN_LENGTH = 32;

/** 타임스탬프 허용 오차(초). 양방향 ±300초. */
export const TIMESTAMP_WINDOW_SECONDS = 300;

/**
 * 런너 설치 토큰. **이것이 HMAC 키다.**
 *
 * ⚠️ 없거나 짧으면 **던진다.** 설정 누락은 잠기는 쪽으로 실패해야 한다 — 통과시키면
 *    배포 직후에 누구나 `!드랍` 으로 수익 원장에 쓸 수 있는 무방비 창이 생긴다.
 */
export function runnerToken(): string {
  const token = requireEnv("BOT_RUNNER_TOKEN", process.env.BOT_RUNNER_TOKEN);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `[bot/signature] BOT_RUNNER_TOKEN 이 너무 짧습니다(${String(token.length)}자). ` +
        `${String(MIN_TOKEN_LENGTH)}자 이상이어야 합니다. ` +
        `생성: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  return token;
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

/**
 * 런너 요청의 서명을 검증한다. 맞으면 `true`.
 *
 * ★ **실패 카운터·임시 정지가 없다.** 예전에는 채널마다 `signature_failure_count` 를
 *   올려 20회에 10분 잠갔는데, 잠글 대상(채널)이 사라졌다. 남는 선택지는 "전역으로
 *   잠근다"뿐이고 그건 **아무나 틀린 서명을 20번 보내면 봇 전체를 끌 수 있다**는 뜻이라
 *   훨씬 나쁘다. 무차별 대입 방어는 토큰 공간(32자 이상)과 타임스탬프 창이 갖는다.
 * ★ 순서가 중요하다: **타임스탬프를 먼저 본다.** 창 밖이면 HMAC 계산 자체가 낭비다.
 */
export function verifyRunnerSignature(
  base: string,
  presented: string,
  timestamp: number,
  now: Date,
): boolean {
  if (!timestampWithinWindow(timestamp, now)) {
    console.warn("[bot] 서명 검증 실패: 타임스탬프가 허용 창을 벗어났습니다.");
    return false;
  }
  if (signatureEquals(computeSignature(runnerToken(), base), presented)) return true;
  console.warn("[bot] 서명 검증 실패: 서명이 일치하지 않습니다.");
  return false;
}
