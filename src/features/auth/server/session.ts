import "server-only";

/**
 * 세션 — **서명 쿠키**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 Supabase Auth 가 아닌가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 앱의 신원은 넥슨 API 키의 SHA-256 해시다. Supabase Auth 세션은 쓰지 않기로
 * 이미 못박혀 있고(DB-SCHEMA 난제 1), 그래서 `auth.uid()` 는 **항상 null** 이며
 * 모든 쓰기는 Route Handler + service_role 로만 들어간다. 브라우저가 들고 있어야 할
 * 것은 "이 요청이 어느 `app_users.id` 인가" 하나뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 DB 세션 테이블이 아닌가
 * ─────────────────────────────────────────────────────────────────────────────
 * 스키마에 세션 테이블이 없다(34개 테이블 중 하나도). 새로 만들려면 마이그레이션이
 * 필요한데 이번 작업 범위가 아니고, 무엇보다 **요청마다 DB 왕복이 하나 늘어난다.**
 * 서명 토큰이면 검증이 HMAC 한 번이다.
 *
 * 그 대가는 명확하다 — **서버가 개별 세션을 즉시 폐기할 수 없다.**
 * 대신 두 가지로 위험을 좁혔다:
 * - 만료를 토큰 안에 넣어 30일로 못박는다(쿠키 만료만 믿지 않는다. 쿠키 `Max-Age`는
 *   클라이언트가 지우면 그만이라 **위조 방지 경계가 아니다**).
 * - `SESSION_SECRET` 을 교체하면 **모든** 세션이 한 번에 무효가 된다(전역 킬 스위치).
 * 계정 정지/삭제는 `GET /api/auth/me` 가 `app_users.status` 와 `deleted_at` 을 매번
 * 확인하므로, 토큰이 살아 있어도 정지된 계정은 즉시 막힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 토큰 형식
 * ─────────────────────────────────────────────────────────────────────────────
 *   v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 * JWT 를 쓰지 않은 이유: 알고리즘 협상(`alg: none` 류)이 필요 없고 라이브러리도
 * 늘리지 않기 위해서다. 알고리즘은 코드에 고정되어 있어 협상 자체가 없다.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { requireEnv } from "@/lib/env";

export const SESSION_COOKIE_NAME = "m_schedule_session";

/** 세션 수명. 재로그인은 저장된 키 한 번이면 끝나므로 길게 잡을 이유가 없다. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";

/** 서명 키 최소 길이. 짧은 시크릿은 서명이 있으나 마나다. */
const MIN_SECRET_LENGTH = 32;

export interface SessionPayload {
  /** `app_users.id` */
  readonly uid: string;
  /** 발급 시각 (epoch seconds) */
  readonly iat: number;
  /** 만료 시각 (epoch seconds) */
  readonly exp: number;
}

function sessionSecret(): string {
  const secret = requireEnv("SESSION_SECRET", process.env.SESSION_SECRET);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[auth/session] SESSION_SECRET 이 너무 짧습니다(${secret.length}자). ` +
        `${MIN_SECRET_LENGTH}자 이상이어야 합니다. ` +
        `생성: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  return secret;
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url");
}

/** 같은 길이일 때만 상수시간 비교. 길이가 다르면 비교할 것도 없이 불일치다. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function signSessionToken(
  userId: string,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = {
    uid: userId,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };
  const body = `${TOKEN_VERSION}.${toBase64Url(JSON.stringify(payload))}`;
  return `${body}.${sign(body)}`;
}

/**
 * 토큰 검증. 실패 사유를 구분하지 않고 **전부 null** 이다.
 * (만료인지 위조인지 알려 주면 공격자에게 정보를 준다.)
 */
export function verifySessionToken(
  token: string,
  now: Date = new Date(),
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [version, encodedPayload, signature] = parts;
  if (version !== TOKEN_VERSION) return null;

  if (!safeEquals(signature, sign(`${version}.${encodedPayload}`))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.uid !== "string" || record.uid === "") return null;
  if (typeof record.iat !== "number" || typeof record.exp !== "number")
    return null;
  if (record.exp <= Math.floor(now.getTime() / 1000)) return null;

  return { uid: record.uid, iat: record.iat, exp: record.exp };
}

/** 현재 요청의 세션. 없으면 null 이며 **던지지 않는다** — 비로그인은 정상 상태다. */
export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (raw === undefined || raw === "") return null;
  return verifySessionToken(raw);
}

/**
 * `secure` 플래그를 요청의 프로토콜에서 정한다.
 *
 * `NODE_ENV` 로 가르지 않는 이유는 `src/lib/env-flags.ts` 와 같다 — 빌드 시점에 굳어
 * 되돌릴 수 없기 때문이다. 반대로 항상 `secure: true` 로 두면 **로컬 http 에서 쿠키가
 * 저장되지 않아** 로그인 자체가 동작하지 않는다. 실제 연결 방식을 보는 것이 정답이다.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) {
    return forwarded.split(",")[0].trim() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function writeSessionCookie(
  userId: string,
  options: { readonly secure: boolean },
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, signSessionToken(userId), {
    httpOnly: true,
    secure: options.secure,
    // lax: 우리 API 는 동일 출처에서만 불리고, strict 로 두면 외부 링크로 들어온
    // 첫 화면이 항상 비로그인으로 보인다.
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
