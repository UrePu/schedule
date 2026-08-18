import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨 API 키 봉투 암호화 — AES-256-GCM (CLAUDE.md §2.1.2)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 DB 에 저장하는가, 그리고 왜 평문이 아닌가
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 키는 **그 키를 발급한 계정의 캐릭터만** 읽는다(§1.1). 원문을 브라우저
 * localStorage 에만 두었더니, 새 브라우저로 로그인한 사용자는 자격증명 3건과 캐릭터
 * 304명을 **목록으로는 전부 보면서** 부계정 캐릭터를 하나도 동기화하지 못했다 —
 * 보낼 키가 그 기기에 없었기 때문이다. 그래서 원문을 서버가 보관한다(발주자 결정,
 * 2026-08-18).
 *
 * 다만 **평문은 금지**다. 스키마가 그렇게 규정하고 있고(`encrypted_api_key bytea`,
 * "평문 금지"), 이유도 분명하다 — 평문 저장은 DB 덤프 한 번이 곧 **살아 있는 자격증명
 * 더미**가 된다는 뜻이다. 복호화는 서버가 알아서 하므로 사용 편의는 평문과 완전히 같고,
 * 비용은 호출당 마이크로초 단위다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 암호문 형식 — **하나의 bytea 안에 전부 담는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * ```
 *   오프셋   길이   내용
 *   ------   ----   ----------------------------------------------------------
 *   0        1      형식 버전 (0x01)
 *   1        12     IV / nonce  — 레코드마다 새로 뽑는다
 *   13       16     GCM 인증 태그
 *   29       n      암호문
 * ```
 *
 * 이렇게 정한 이유:
 * - **한 칸에 담는다.** IV·태그를 별도 컬럼으로 쪼개면 세 값이 따로 놀 수 있고, 한 값만
 *   갱신되는 부분 실패가 생긴다. 봉투 하나면 원자적으로 바뀐다.
 * - **고정 길이 접두사 → 길이 필드가 필요 없다.** 뒤에 남은 전부가 암호문이다.
 * - **IV 는 12바이트.** GCM 의 고유 크기라 구현이 추가 유도를 하지 않는다(다른 길이는
 *   내부적으로 GHASH 를 한 번 더 돈다). 매 레코드 `randomBytes(12)` 이며 재사용은
 *   GCM 에서 치명적이라 절대 상수를 쓰지 않는다.
 * - **태그를 암호문 앞에 둔다.** `createDecipheriv` 는 `final()` 전에 태그를 알아야
 *   하는데, 뒤에 두면 전체를 다 읽고 잘라내야 한다. 앞에 두면 슬라이스 두 번이면 끝난다.
 * - **AAD = `버전 바이트 || keyId`.** 세대 라벨을 인증 데이터로 묶었으므로, 다른 세대의
 *   키로 복호화를 시도하면 태그 검증에서 실패한다. 형식 버전도 같은 이유로 묶는다 —
 *   나중에 형식이 바뀌어도 옛 레코드를 새 규칙으로 해석하는 사고가 나지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 마스터키 관리 — **환경변수. Vault 가 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 앱은 이미 서버 전용 비밀(`SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`)을 환경변수로
 * 다룬다. Supabase Vault 를 하나 더 얹으면 운영 경로가 둘로 갈라지는데, 그 대가로 얻는
 * 것이 없다 — Vault 를 여는 열쇠도 결국 어딘가에 있어야 한다.
 *
 * **키 세대(rotation)** 는 `encryption_key_id` 컬럼이 담당한다. 지금 값은 `"v1"` 이고,
 * 회전할 때는 아래 `KEY_GENERATIONS` 에 새 세대를 한 줄 더하고 `CURRENT_KEY_ID` 를 옮기면
 * 된다. 옛 레코드는 옛 세대 키로 계속 복호화되고, 사용자가 키를 다시 넣을 때마다 새
 * 세대로 자연스럽게 이동한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 마스터키가 없으면 **즉시, 분명하게 실패한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 조용히 평문으로 떨어지는 폴백은 없다. 그런 폴백은 "동작하는 것처럼 보이는 유출"이고,
 * 배포에서 환경변수 하나를 빠뜨린 것을 아무도 눈치채지 못한 채 몇 달이 지나간다.
 */

/** 봉투 형식 버전. 형식이 바뀌면 이 값을 올리고 옛 값도 계속 읽을 수 있게 둔다. */
const FORMAT_VERSION = 0x01;

/** GCM 의 고유 nonce 크기. 다른 값을 쓰면 구현이 추가 유도를 돈다. */
const IV_LENGTH = 12;

/** GCM 인증 태그(128비트). 이 태그가 곧 "변조되지 않았다"의 증명이다. */
const TAG_LENGTH = 16;

const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

const ALGORITHM = "aes-256-gcm";

/** AES-256 이므로 마스터키는 **정확히 32바이트**여야 한다. */
const MASTER_KEY_BYTES = 32;

/**
 * 키 세대 → 그 세대의 마스터키가 들어 있는 환경변수 이름.
 *
 * 회전 절차: (1) 여기 새 줄을 더한다 (2) `CURRENT_KEY_ID` 를 옮긴다 (3) 옛 줄은
 * **지우지 않는다** — 아직 옛 세대로 암호화된 레코드가 남아 있다.
 */
const KEY_GENERATIONS: Readonly<Record<string, string>> = {
  v1: "API_KEY_ENCRYPTION_KEY",
};

/** 지금 암호화에 쓰는 세대. `user_credentials.encryption_key_id` 에 그대로 들어간다. */
const CURRENT_KEY_ID = "v1";

/**
 * 이 모듈이 던지는 유일한 에러.
 *
 * `reason` 으로 **설정 문제**와 **데이터 문제**를 가른다. 둘은 조치가 완전히 다르다 —
 * 전자는 운영자가 환경변수를 고쳐야 하고(모든 사용자가 영향), 후자는 그 레코드 하나가
 * 못 쓰게 된 것이라 사용자가 키를 다시 넣으면 끝난다.
 */
export class ApiKeyCipherError extends Error {
  readonly reason: "config" | "data";

  constructor(reason: "config" | "data", message: string) {
    super(message);
    this.name = "ApiKeyCipherError";
    this.reason = reason;
  }
}

/** 파싱 결과 캐시. 요청마다 base64 를 다시 디코딩할 이유가 없다. */
const masterKeyCache = new Map<string, Buffer>();

/**
 * 세대 라벨 → 마스터키(32바이트).
 *
 * ★ **없거나 길이가 틀리면 던진다.** 여기서 조용히 넘어가는 경로는 존재하지 않는다.
 */
function resolveMasterKey(keyId: string): Buffer {
  const cached = masterKeyCache.get(keyId);
  if (cached !== undefined) return cached;

  const envName = KEY_GENERATIONS[keyId];
  if (envName === undefined) {
    throw new ApiKeyCipherError(
      "config",
      `[api-key-cipher] 알 수 없는 암호화 키 세대입니다: ${keyId}. ` +
        `KEY_GENERATIONS 에 그 세대의 환경변수를 등록해 주세요.`,
    );
  }

  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") {
    throw new ApiKeyCipherError(
      "config",
      `[api-key-cipher] 환경변수 ${envName} 가 설정되지 않았습니다. ` +
        `넥슨 API 키를 암호화해 보관하려면 반드시 필요합니다. ` +
        `생성: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`,
    );
  }

  // Node 의 base64 디코더는 base64url 알파벳(-, _)도 그대로 받는다.
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new ApiKeyCipherError(
      "config",
      `[api-key-cipher] ${envName} 는 base64(url) 로 인코딩된 ${MASTER_KEY_BYTES}바이트여야 하는데 ` +
        `${key.length}바이트로 해석됐습니다.`,
    );
  }

  masterKeyCache.set(keyId, key);
  return key;
}

/** AAD — 형식 버전과 키 세대를 인증 데이터로 묶는다. 둘 중 하나만 달라도 복호화가 실패한다. */
function buildAad(keyId: string): Buffer {
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    Buffer.from(keyId, "utf8"),
  ]);
}

export interface EncryptedApiKey {
  /** 위 표의 봉투 전체. `user_credentials.encrypted_api_key` 에 그대로 들어간다. */
  readonly payload: Buffer;
  /** `user_credentials.encryption_key_id` 에 함께 저장할 세대 라벨. */
  readonly keyId: string;
}

/**
 * 원문 키 → 봉투.
 *
 * 마스터키가 없으면 **던진다.** 호출부는 이 예외를 삼키지 말 것 — 삼키면 "저장했다고
 * 생각했는데 안 되어 있는" 상태가 되고, 그건 새 브라우저에서 조용히 실패하는 동기화로
 * 돌아온다.
 */
export function encryptApiKey(rawKey: string): EncryptedApiKey {
  if (rawKey === "") {
    throw new ApiKeyCipherError("data", "[api-key-cipher] 빈 키는 암호화하지 않습니다.");
  }

  const keyId = CURRENT_KEY_ID;
  const masterKey = resolveMasterKey(keyId);
  // ★ 레코드마다 새로 뽑는다. GCM 에서 nonce 재사용은 곧 키 노출이다.
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(buildAad(keyId));

  const ciphertext = Buffer.concat([
    cipher.update(rawKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    payload: Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, tag, ciphertext]),
    keyId,
  };
}

/**
 * 봉투 → 원문 키.
 *
 * ★ **태그가 맞지 않으면 던진다.** GCM 을 고른 이유가 정확히 이것이다 — 누군가 DB 의
 *   암호문을 한 바이트라도 바꾸면 복호화가 조용히 쓰레기를 뱉는 대신 실패한다.
 *   (CBC 였다면 패딩이 우연히 맞을 때 쓰레기가 그대로 넥슨 헤더로 나갔을 것이다.)
 *
 * @param payload  저장된 봉투
 * @param keyId    그 레코드의 `encryption_key_id`
 */
export function decryptApiKey(payload: Buffer, keyId: string): string {
  if (payload.length <= HEADER_LENGTH) {
    throw new ApiKeyCipherError(
      "data",
      `[api-key-cipher] 암호문이 너무 짧습니다(${payload.length}바이트). 최소 ${HEADER_LENGTH + 1}바이트가 필요합니다.`,
    );
  }

  const version = payload[0];
  if (version !== FORMAT_VERSION) {
    throw new ApiKeyCipherError(
      "data",
      `[api-key-cipher] 알 수 없는 암호문 형식 버전입니다: ${String(version)}.`,
    );
  }

  const masterKey = resolveMasterKey(keyId);
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = payload.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(buildAad(keyId));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // 원문 메시지에는 아무 정보가 없고, 원인은 언제나 "변조 또는 다른 마스터키"다.
    throw new ApiKeyCipherError(
      "data",
      "[api-key-cipher] 인증 태그 검증에 실패했습니다. 암호문이 변조되었거나 다른 마스터키로 암호화된 레코드입니다.",
    );
  }
}

/**
 * 마스터키 설정이 살아 있는가. **키 자체는 돌려주지 않는다.**
 *
 * 진단(설정 누락을 로그에 한 줄 남기기)에만 쓴다. 이 값으로 분기해 평문으로 떨어지는
 * 코드를 쓰지 말 것 — 그 폴백이 금지된 것 자체다.
 */
export function isApiKeyEncryptionConfigured(): boolean {
  try {
    resolveMasterKey(CURRENT_KEY_ID);
    return true;
  } catch {
    return false;
  }
}
