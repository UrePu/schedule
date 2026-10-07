import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 공유 링크 토큰 — **서명 하나. 표도 마이그레이션도 없다.**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-07): *"주소로 만들어서 보내는게 나을거같은데 !숙제 부분이 생각보다
 * 보기 힘든거같아서 저렇게 사진으로보내면 개편하잖아"* — 카톡이 링크 미리보기로 그림을
 * 띄우려면 **크롤러가 세션 없이** 그 주소를 열 수 있어야 한다. 쿠키가 없으므로 주소
 * 자체가 자격증명이고, **토큰이 유일한 자물쇠**다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 DB 가 아니라 서명인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 세션(`features/auth/server/session.ts`)과 런너 서명(`features/bot/server/signature.ts`)이
 * 이미 같은 문제를 같은 방식으로 풀어 놨다 — **상태를 저장하지 않고 HMAC 으로 묶는다.**
 * 여기서는 그 선택이 더 분명하다. 토큰이 사는 시간은 길어야 **한 주**이고(아래 참조),
 * 폐기할 일이 생기면 `SESSION_SECRET` 교체 하나로 전부 죽는다. 주마다 쌓이고 주마다
 * 쓸모없어지는 행을 표에 적립할 이유가 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키는 **`SESSION_SECRET` 에서 파생한다 — 새 환경변수를 만들지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 그대로 쓰지 않고 **파생**하는 이유는 영역 분리(domain separation)다. 같은 키로 두
 *   가지를 서명하면, 한쪽 형식이 다른 쪽 형식의 앞부분과 겹치는 날 **한쪽 토큰을 다른 쪽
 *   토큰으로 재생**할 수 있다. 지금은 형식이 달라 우연히 안전할 뿐이고, 그 "우연히"에
 *   세션 위조를 걸어 둘 수는 없다. 파생 라벨을 바꾸면 이 링크만 전부 무효가 된다.
 * ★ 새 비밀을 만들지 않은 이유: 비밀이 늘면 **배포마다 빠뜨릴 자리가 하나 는다.** 빠뜨리면
 *   `requireEnv` 가 던져 `!숙제` 전체가 죽는다. 이미 반드시 설정되는 값(없으면 로그인이
 *   아예 안 된다)에 얹는 쪽이 운영에서 덜 깨진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 토큰 모양 — **51자**
 * ─────────────────────────────────────────────────────────────────────────────
 *   "1" + base64url( uid(16) ‖ exp(4) ‖ scope(1) ‖ mac(16) )   = 1 + 50자
 *
 * - `uid` 는 `app_users.id`(UUID)의 **원시 16바이트**다. 하이픈 섞인 36자 문자열을 그대로
 *   담으면 토큰이 두 배가 되고, 카톡 한 줄에서 주소가 두 줄로 접힌다.
 * - `exp` 는 epoch 초 **uint32 BE**(2106년까지). 만료는 토큰 **안**에 있다 — 주소에
 *   쿼리로 붙이면 사용자가 고칠 수 있고, 그러면 만료가 아니다.
 * - `scope` 는 `weekly`/`monthly` 1바이트. **지금은 `weekly` 만 발급한다**(§아래).
 * - `mac` 은 HMAC-SHA256 을 **앞 16바이트로 자른 것**이다. 자르기는 RFC 2104 가 허용하는
 *   방식이고 128비트는 위조에 2^128 을 요구한다. 32바이트를 다 싣는 값은 토큰 22자인데,
 *   그 22자가 사 주는 보안은 "2^128 이 모자랄 때"뿐이라 사실상 0이다.
 *
 * ⚠️ **payload 는 비밀이 아니다.** base64url 을 풀면 누구나 uid 와 만료를 읽을 수 있다.
 *    서명이 지키는 것은 *기밀*이 아니라 *위조*다. uid 는 UUID 라 그 자체로 아무 문도 열지
 *    못하고, 토큰 없이는 어떤 화면도 열리지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 만료 = **다음 주간 초기화(KST 목요일 00:00)**
 * ─────────────────────────────────────────────────────────────────────────────
 * 담고 있는 것이 "이번 주 남은 보스"라서, 초기화를 넘기면 그림이 **틀린 말**이 된다.
 * 틀린 그림을 계속 보여 주느니 링크가 닫히는 편이 낫다 — 닫히면 사람은 `!숙제` 를 다시
 * 친다. ⚠️ 수요일 밤에 친 링크는 수명이 몇 분일 수 있다. 그게 정확한 동작이다.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { requireEnv } from "@/lib/env";
import { formatKst, getNextReset } from "@/lib/time/week";

/** 토큰 버전. 서명 대상에 함께 들어가므로 버전만 바꿔치기할 수 없다. */
const TOKEN_VERSION = "1";

/** 서명 키 최소 길이. `session.ts` 와 같은 기준이다 — 짧은 시크릿은 서명이 있으나 마나다. */
const MIN_SECRET_LENGTH = 32;

/**
 * 파생 라벨. **바꾸면 발급된 링크가 전부 무효가 된다.**
 * 세션 토큰과 같은 비밀에서 나오지만 같은 키가 아니라는 사실을 이 문자열이 보장한다.
 */
const KEY_INFO = "m_schedule/share-link/v1";

const UID_BYTES = 16;
const EXP_BYTES = 4;
const SCOPE_BYTES = 1;
const MAC_BYTES = 16;
const BODY_BYTES = UID_BYTES + EXP_BYTES + SCOPE_BYTES;
const TOKEN_BYTES = BODY_BYTES + MAC_BYTES;

/** base64url(37바이트) = 50자. 앞의 버전 한 글자를 더해 **51자**. */
export const SHARE_TOKEN_LENGTH = 1 + Math.ceil((TOKEN_BYTES * 8) / 6);

/**
 * 어느 목록을 담은 링크인가.
 *
 * ★ **지금 발급되는 것은 `weekly`(`!숙제`) 뿐이다.** `monthly`(`!검마`)를 바이트로 미리
 *   잡아 둔 이유는, 나중에 붙일 때 **토큰 형식을 바꾸지 않기 위해서**다. 형식이 바뀌면
 *   그날 돌아다니던 링크가 전부 404 가 된다. 1바이트를 미리 비워 두는 값이 그보다 싸다.
 */
export type ShareScope = "weekly" | "monthly";

const SCOPE_CODE: Record<ShareScope, number> = { weekly: 1, monthly: 2 };
const SCOPE_BY_CODE = new Map<number, ShareScope>([
  [1, "weekly"],
  [2, "monthly"],
]);

export interface ShareClaim {
  /** `app_users.id` */
  readonly userId: string;
  readonly scope: ShareScope;
  /** 만료 시각(epoch 초). 화면이 "언제까지 유효한가"를 말할 수 있게 함께 돌려준다. */
  readonly expiresAt: Date;
}

/**
 * 서명 키. `SESSION_SECRET` → HMAC(라벨) → 32바이트.
 *
 * ⚠️ 없거나 짧으면 **던진다.** 설정 누락은 잠기는 쪽으로 실패해야 한다 — 통과시키면
 *    아무나 토큰을 찍어 남의 숙제를 열 수 있는 창이 생긴다(`signature.ts` 와 같은 기조).
 */
function shareSigningKey(): Buffer {
  const secret = requireEnv("SESSION_SECRET", process.env.SESSION_SECRET);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[share/token] SESSION_SECRET 이 너무 짧습니다(${String(secret.length)}자). ` +
        `${String(MIN_SECRET_LENGTH)}자 이상이어야 합니다.`,
    );
  }
  return createHmac("sha256", secret).update(KEY_INFO, "utf8").digest();
}

function macOf(body: Buffer): Buffer {
  return createHmac("sha256", shareSigningKey())
    .update(TOKEN_VERSION, "utf8")
    .update(body)
    .digest()
    .subarray(0, MAC_BYTES);
}

/** UUID 문자열 → 16바이트. 모양이 아니면 `null`(발급 쪽 버그를 조용히 넘기지 않는다). */
function uuidToBytes(value: string): Buffer | null {
  const hex = value.replace(/-/gu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * 링크 토큰을 만든다. 만료는 **다음 주간 초기화**다.
 *
 * ★ 만료를 인자로 받지 않는다. 받는 순간 "이 화면만 한 달짜리로" 같은 요청이 들어오고,
 *   그러면 초기화 뒤에도 살아 있는 — 즉 **틀린 숫자를 말하는** 링크가 생긴다.
 */
export function signShareToken(
  userId: string,
  scope: ShareScope,
  now: Date = new Date(),
): string {
  const uid = uuidToBytes(userId);
  if (uid === null) {
    throw new Error("[share/token] userId 가 UUID 형식이 아닙니다.");
  }

  const expiresAt = getNextReset(now);
  const body = Buffer.alloc(BODY_BYTES);
  uid.copy(body, 0);
  body.writeUInt32BE(Math.floor(expiresAt.getTime() / 1000), UID_BYTES);
  body.writeUInt8(SCOPE_CODE[scope], UID_BYTES + EXP_BYTES);

  return TOKEN_VERSION + Buffer.concat([body, macOf(body)]).toString("base64url");
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 공유 링크 **한 줄** — 주소 조립은 여기 한 곳이다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-07): *"설명없애서 바로보기에서 딱 이미지처럼 나오게 해 환산 처럼
 * 링크 보내기로"* — `!숙제` 답장은 **URL 한 줄**이 전부다. 그러면 카톡이 만드는 미리보기
 * 카드가 곧 답장이 된다(`bot/server/commands.ts` `handleScouter` 머리말의 실측:
 * *"카드는 URL 만 든 메시지에서 가장 확실히 뜬다 — 텍스트가 섞이면 생략되는 경우가 있다."*).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 끝에 `?t=HHmmss`(KST)를 붙인다 — **도배 방지와 카드를 함께 살리는 유일한 길**
 * ─────────────────────────────────────────────────────────────────────────────
 * 토큰은 (사용자, 주차, 범위)에 대해 **결정적**이다. 그래서 같은 주에 `!숙제` 를 두 번
 * 치면 답장이 글자 하나까지 같고, 그 순간 라우트의 `differentiate()`(`bot/lib/plaintext.ts`)
 * 가 도배 방지로 `· HH:mm` 을 덧붙인다 — **메시지가 URL 단독이 아니게 되어 카드가 사라진다.**
 * `!환산` 은 *"같은 닉네임을 연속으로 두 번 치는 일이 드물다"* 며 그 접미사를 감수했지만,
 * `!숙제` 는 **진행을 확인하려고 반복해서 치는 명령**이라 그 가정이 성립하지 않는다.
 * → 글자를 덧붙이는 대신 **주소 자체가 달라지게** 한다. 쿼리가 붙은 메시지는 여전히
 *   URL 단독이라 카드가 뜨고, 직전 답장과는 다른 문자열이라 도배 방지가 발동하지 않는다.
 *
 * ★ 값이 **시각**인 이유: 사람이 봐도 뜻이 있다 — 방에 남은 주소를 보고 "몇 시에 뽑은
 *   그림인가"를 읽을 수 있다. 난수였다면 그 자리는 그냥 쓰레기다.
 * ★ **초까지 넣는다.** 분까지만 넣으면 1분 안에 두 번 친 경우가 그대로 같은 문자열이
 *   되는데, 하필 그게 이 명령에서 가장 흔한 반복이다(막 잡고 와서 다시 확인).
 * ★ 곁가지 이득: 카카오는 주소별로 미리보기를 캐시한다. 쿼리가 다르면 **새로 긁으므로**
 *   방금 잡은 보스가 빠진 옛 그림이 다시 뜨는 일이 없다.
 *
 * ⚠️ **자격증명은 토큰에만 있다.** `t` 는 서명 대상이 아니고 만료와도 무관하다 —
 *    `/s/[token]` 과 `/s/[token]/card.png` 는 둘 다 `params` 만 읽고 쿼리를 **보지 않으므로**,
 *    사용자가 `t` 를 고쳐도 바뀌는 것이 없다. 만료를 쿼리로 내보내지 않는 이유는 이 파일
 *    머리말과 같다 — 쿼리는 사용자가 고칠 수 있고, 고칠 수 있는 만료는 만료가 아니다.
 */
export function buildShareUrl(
  origin: string,
  userId: string,
  scope: ShareScope,
  now: Date = new Date(),
): string {
  const token = signShareToken(userId, scope, now);
  return `${origin}/s/${token}?t=${formatKst(now, "HHmmss")}`;
}

/**
 * 토큰을 푼다. **위조든 만료든 `null` 하나로 접는다.**
 *
 * ★ 둘을 구분해 알려 주면 공격자가 "서명은 맞는데 만료됐다"를 신호로 쓸 수 있고, 무엇보다
 *   호출부가 둘을 다른 화면으로 가르고 싶어진다. 사용자가 할 일은 어느 쪽이든 같다 —
 *   **`!숙제` 를 다시 친다.** 그래서 라우트는 둘 다 404 로 접는다.
 * ★ 길이부터 본다. 틀린 길이는 HMAC 을 계산할 가치도 없다.
 */
export function verifyShareToken(
  token: string,
  now: Date = new Date(),
): ShareClaim | null {
  if (token.length !== SHARE_TOKEN_LENGTH) return null;
  if (token[0] !== TOKEN_VERSION) return null;

  // base64url 밖의 글자가 섞이면 Buffer 가 조용히 버린다 → 길이로 걸러진다.
  const raw = Buffer.from(token.slice(1), "base64url");
  if (raw.length !== TOKEN_BYTES) return null;

  const body = raw.subarray(0, BODY_BYTES);
  const presented = raw.subarray(BODY_BYTES);
  const expected = macOf(body);
  // 길이가 같음이 보장된 자리에서만 상수시간 비교를 쓴다.
  if (!timingSafeEqual(presented, expected)) return null;

  const expiresAt = new Date(body.readUInt32BE(UID_BYTES) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;

  const scope = SCOPE_BY_CODE.get(body.readUInt8(UID_BYTES + EXP_BYTES));
  if (scope === undefined) return null;

  return {
    userId: bytesToUuid(body.subarray(0, UID_BYTES)),
    scope,
    expiresAt,
  };
}
