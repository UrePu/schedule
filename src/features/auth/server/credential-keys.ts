import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 자격증명 ↔ 원문 넥슨 키의 **서버 보관소** (CLAUDE.md §2.1.2)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 파일이 메우는 구멍
 * ─────────────────────────────────────────────────────────────────────────────
 * `user_credentials` 는 처음부터 `encrypted_api_key` / `encryption_key_id` /
 * `allow_server_side_use` / `consent_at` 네 칸을 갖고 있었는데(마이그레이션 20260817090100),
 * **애플리케이션이 그 칸을 한 번도 읽거나 쓰지 않았다.** 그래서 원문 키는 브라우저
 * localStorage 에만 있었고, 새 기기로 로그인한 사용자는 자격증명 3건이 다 보이는데도
 * 부계정 캐릭터를 영원히 동기화하지 못했다. 여기가 그 칸을 실제로 쓰는 유일한 곳이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 네 컬럼은 **함께** 채운다 — CHECK 제약이 그렇게 요구한다
 * ─────────────────────────────────────────────────────────────────────────────
 * `user_credentials_server_use_requires_key` 는
 * `allow_server_side_use = true` 면 `encrypted_api_key`·`encryption_key_id`·`consent_at`
 * 이 **모두** 있어야 한다고 강제한다. 하나만 빠뜨린 UPDATE 는 DB 가 거부한다. 그래서
 * 이 파일의 UPDATE 는 언제나 네 칸을 한 문장에 담는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 이 컬럼들은 **service_role 전용**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * anon·authenticated 의 GRANT 에 들어가면 `assert_no_public_sensitive_columns()` 가
 * 마이그레이션을 실패시킨다. 이 모듈이 `AdminDb`(service_role)만 받는 이유이고,
 * `import "server-only"` 가 클라이언트 번들 유입을 빌드 시점에 막는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 원문 키는 이 파일 밖으로 **응답에 실려 나가지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 돌려주는 곳은 넥슨 프록시 하나뿐이고, 거기서도 넥슨 요청 헤더로만 쓰인다. 로그에도
 * 절대 남기지 않는다 — 이 파일의 어떤 `console.*` 도 키나 암호문을 인자로 받지 않는다.
 */

import {
  ApiKeyCipherError,
  decryptApiKey,
  encryptApiKey,
} from "@/lib/crypto/api-key-cipher";
import { normalizeApiKey } from "@/lib/nexon/key-hash";
import type { AdminDb } from "@/lib/supabase/admin-db";

/**
 * PostgREST 의 `bytea` 표현은 Postgres 의 hex 출력 형식 그대로다 — `\x` 접두사 + 소문자 hex.
 * 읽을 때도 쓸 때도 같은 문자열이므로 변환은 이 두 함수가 전부다.
 */
function toByteaLiteral(payload: Buffer): string {
  return `\\x${payload.toString("hex")}`;
}

function fromByteaLiteral(value: string): Buffer {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(hex, "hex");
}

/**
 * 이 자격증명의 원문 키를 **암호화해** 저장한다.
 *
 * ★ 호출 전제: **그 키가 방금 넥슨에게 유효하다고 확인받았을 것.** 무효한 키를 저장하면
 *   "서버에 키가 있는데 동기화만 조용히 실패하는" 최악의 상태가 된다. 그래서 호출부는
 *   `/character/list` 검증(로그인·키 추가) 또는 실제 호출 성공(프록시 백필) 뒤에만 부른다.
 *
 * ★ `consent_at` 은 **최초 1회만** 찍는다. 같은 키를 다시 넣는 것은 재확인이지 새 동의가
 *   아니고, 감사 로그로서 의미 있는 값은 "언제 처음 허용했는가"다.
 *
 * ★ 마스터키 설정 오류는 **던진다.** 삼키면 저장된 줄 알았던 키가 없는 채로 흘러간다.
 */
export async function storeCredentialApiKey(
  db: AdminDb,
  credentialId: string,
  rawKey: string,
): Promise<void> {
  const normalized = normalizeApiKey(rawKey);
  if (normalized === "") return;

  const { data: existing, error: readError } = await db
    .from("user_credentials")
    .select("id, consent_at")
    .eq("id", credentialId)
    .maybeSingle();

  if (readError !== null) throw readError;
  // 자격증명이 사라졌다면 저장할 대상이 없다. 이건 호출 순서 문제이지 사용자 문제가 아니다.
  if (existing === null) return;

  const { payload, keyId } = encryptApiKey(normalized);

  const { error } = await db
    .from("user_credentials")
    .update({
      encrypted_api_key: toByteaLiteral(payload),
      encryption_key_id: keyId,
      allow_server_side_use: true,
      consent_at: existing.consent_at ?? new Date().toISOString(),
    })
    .eq("id", credentialId);

  if (error !== null) throw error;
}

/** 자격증명 1건의 서버 보관 상태. **원문은 필요할 때만 복호화한다.** */
export interface CredentialSecret {
  readonly credentialId: string;
  /** 로그인 식별에 쓰는 SHA-256. 브라우저가 보낸 키가 이 자격증명의 것인지 대조한다. */
  readonly apiKeyHash: string;
  /** 서버가 대신 부를 수 있는 원문 키. 저장돼 있지 않거나 복호화에 실패하면 `null`. */
  readonly rawKey: string | null;
}

interface CredentialSecretRow {
  readonly id: string;
  readonly api_key_hash: string;
  readonly encrypted_api_key: string | null;
  readonly encryption_key_id: string | null;
  readonly allow_server_side_use: boolean;
}

const SECRET_COLUMNS =
  "id, api_key_hash, encrypted_api_key, encryption_key_id, allow_server_side_use";

/**
 * 저장된 봉투 → 원문. **실패는 예외가 아니라 `null`** 이다.
 *
 * 복호화가 깨지는 경우는 마스터키 미설정·세대 회전 실수·레코드 변조뿐이고, 셋 다 그
 * 자격증명 하나가 "서버에 키 없음" 상태로 떨어지는 것으로 충분히 표현된다(화면에 이미
 * 그 상태와 조치가 있다). 여기서 던지면 대시보드 전체가 오류 화면이 된다.
 */
function decodeSecret(row: CredentialSecretRow): CredentialSecret {
  const base = { credentialId: row.id, apiKeyHash: row.api_key_hash };

  if (
    !row.allow_server_side_use ||
    row.encrypted_api_key === null ||
    row.encryption_key_id === null
  ) {
    return { ...base, rawKey: null };
  }

  try {
    const raw = decryptApiKey(
      fromByteaLiteral(row.encrypted_api_key),
      row.encryption_key_id,
    );
    return { ...base, rawKey: raw === "" ? null : raw };
  } catch (error) {
    // ★ 로그에 암호문도 키도 넣지 않는다. 남기는 것은 자격증명 id 와 원인 분류뿐이다.
    const reason =
      error instanceof ApiKeyCipherError ? error.reason : "unknown";
    console.error(
      `[credential-keys] 자격증명 ${row.id} 의 키를 복호화하지 못했습니다 (원인: ${reason}).`,
    );
    return { ...base, rawKey: null };
  }
}

/** 자격증명 하나의 해시 + (있다면) 복호화된 원문. 없는 자격증명이면 `null`. */
export async function loadCredentialSecret(
  db: AdminDb,
  credentialId: string,
): Promise<CredentialSecret | null> {
  const { data, error } = await db
    .from("user_credentials")
    .select(SECRET_COLUMNS)
    .eq("id", credentialId)
    .maybeSingle();

  if (error !== null) throw error;
  if (data === null) return null;
  return decodeSecret(data);
}

/**
 * 이 사용자의 자격증명 중 **서버가 대신 부를 수 있는 키를 가진** 것 하나.
 *
 * 대상이 특정되지 않은 호출(`/character/list` 처럼 자격증명을 안 받은 경우)의 마지막
 * 선택지다. 순서는 **주 키 우선 → 최근 검증 순** 이며, 결정론적이어야 한다 —
 * 매번 다른 키가 뽑히면 캐시 키(`apiKeyHash`)가 흔들려 같은 응답을 다시 받아 온다.
 */
export async function pickServerUsableCredential(
  db: AdminDb,
  userId: string,
): Promise<CredentialSecret | null> {
  const { data, error } = await db
    .from("user_credentials")
    .select(SECRET_COLUMNS)
    .eq("user_id", userId)
    .is("invalidated_at", null)
    .eq("allow_server_side_use", true)
    .order("is_primary", { ascending: false })
    .order("last_validated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error !== null) throw error;

  for (const row of data ?? []) {
    const secret = decodeSecret(row);
    if (secret.rawKey !== null) return secret;
  }
  return null;
}

/**
 * 이 사용자의 자격증명 중 **서버에 키가 보관된** 것의 id 집합.
 *
 * 화면이 "이 브라우저에 키가 없다"를 경고로 그릴지 말지를 여기서 가른다 — 서버가 들고
 * 있으면 그건 경고할 일이 아니라 **정상**이기 때문이다.
 *
 * ⚠️ `allow_server_side_use` 만 본다. 복호화까지 해 보지 않는 이유는 이 판정이 목록
 *    화면에서 자격증명 수만큼 불리기 때문이고, CHECK 제약이 "true 면 암호문이 있다"를
 *    이미 보장하기 때문이다. 마스터키가 어긋난 예외적 상황에서는 실제 호출이 그때
 *    "서버에 키 없음"으로 떨어지며, 그 문구가 조치를 안내한다.
 */
export async function loadServerKeyCredentialIds(
  db: AdminDb,
  userId: string,
): Promise<ReadonlySet<string>> {
  const { data, error } = await db
    .from("user_credentials")
    .select("id")
    .eq("user_id", userId)
    .eq("allow_server_side_use", true);

  if (error !== null) throw error;
  return new Set((data ?? []).map((row) => row.id));
}
