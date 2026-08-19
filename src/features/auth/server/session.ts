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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 **힌트** 쿠키 — 인증 수단이 아니다
 * ─────────────────────────────────────────────────────────────────────────────
 * 값은 `"1"` 하나뿐이고 **신원 정보를 한 바이트도 담지 않는다.** 목적은 단 하나,
 * "이 브라우저는 자기가 로그인돼 있다고 믿는다"를 **클라이언트 JS 가 읽을 수 있게**
 * 하는 것이다. 그래서 `httpOnly: false` 다 — 세션 쿠키(httpOnly)는 원래 목적대로
 * JS 에서 보이지 않게 남는다.
 *
 * ⚠️ **서버는 이 쿠키를 근거로 아무 권한도 주지 않는다.** 누구나 개발자 도구에서
 *    `document.cookie = "m_schedule_signed_in=1"` 을 칠 수 있다. 그렇게 해서 얻는
 *    최대 효과는 **랜딩 대신 스켈레톤을 잠깐 보는 것**이며, 그 뒤 `/api/auth/me` 가
 *    `{ user: null }` 을 돌려주면 곧바로 비로그인 화면으로 떨어진다. 서버가 신뢰하는
 *    것은 오직 서명된 `m_schedule_session` 뿐이다(`verifySessionToken`).
 *
 * 왜 필요한가(2026-08-18 관측): 로그인 상태에서 `/` 를 열면 랜딩이 나오는데 같은 화면의
 * 계정 패널은 "로그인됨"으로 뜬다. 즉 **RSC 렌더에서는 세션 판정이 null 인데 Route
 * Handler(`/api/auth/me`)에서는 정상**이다. 근본 원인과 별개로, 클라이언트가 아는 세션이
 * 이기게 하려면 "기다릴 가치가 있는가"를 첫 페인트 시점에 알아야 한다. 이 쿠키가 그 답이다.
 */
export const SIGNED_IN_HINT_COOKIE_NAME = "m_schedule_signed_in";

/** 힌트 쿠키의 유일한 값. 다른 값은 전부 "없음"과 같이 취급한다. */
export const SIGNED_IN_HINT_VALUE = "1";

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

/**
 * 힌트 쿠키가 붙어 있는가. **권한 판정에 쓰면 안 된다**(위 주석 참고) — 서버 렌더가
 * 첫 페인트에 랜딩 대신 스켈레톤을 그릴지 정하는 데만 쓴다.
 *
 * 이 값을 `SessionGate` 의 SSR 스냅샷으로 넘기면, RSC 세션 판정이 실패한 요청에서도
 * **랜딩 HTML 이 애초에 만들어지지 않아** 하이드레이션 전 깜빡임이 사라진다.
 * `cookies()` 자체가 비어 오는 환경이면 그냥 false 가 되고, 그때는 클라이언트가
 * 마운트 직후 `document.cookie` 로 같은 판정을 내린다 — 어느 쪽이든 결과는 같다.
 */
export async function readSignedInHint(): Promise<boolean> {
  const store = await cookies();
  return store.get(SIGNED_IN_HINT_COOKIE_NAME)?.value === SIGNED_IN_HINT_VALUE;
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

/**
 * 세션 쿠키와 **힌트 쿠키를 함께** 심는다.
 *
 * 둘을 한 함수에 묶어 둔 이유는 단순하다 — 따로 두면 언젠가 한쪽만 부르는 경로가 생기고,
 * 그 순간 "세션은 있는데 힌트는 없다"(깜빡임 복귀) 또는 "힌트만 남았다"(로그아웃했는데
 * 스켈레톤이 한 번 뜬다)가 된다. 호출부(`/api/auth/login`)는 지금까지처럼 이 함수 하나만
 * 부르면 되고 수정이 필요 없다.
 */
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
  store.set(SIGNED_IN_HINT_COOKIE_NAME, SIGNED_IN_HINT_VALUE, {
    // ★ **의도적으로 httpOnly 가 아니다.** 클라이언트 JS 가 읽어야 존재 이유가 있다.
    //   담긴 정보는 `"1"` 뿐이라 읽혀서 새어 나갈 것이 없다.
    httpOnly: false,
    secure: options.secure,
    sameSite: "lax",
    path: "/",
    // 세션과 **같은 수명**. 힌트가 세션보다 오래 살면 만료된 사람이 스켈레톤을 한 번
    // 더 보게 되고, 짧으면 아직 로그인된 사람이 랜딩을 본다.
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** 세션 쿠키와 힌트 쿠키를 **둘 다** 지운다. 하나만 지우면 위 짝이 깨진다. */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  store.set(SIGNED_IN_HINT_COOKIE_NAME, "", {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
