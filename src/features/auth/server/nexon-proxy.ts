import "server-only";

/**
 * 넥슨 프록시의 입구 검사 — **"이 요청을 어떤 키로 부를 것인가"의 단일 구현.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 프록시가 존재하는 이유 (CLAUDE.md §2.1.1) — **CORS 가 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 API 는 어떤 Origin 이든 반사하며 브라우저 직접 호출을 허용한다(검증됨).
 * 그런데도 프록시를 두는 이유는 셋이다 — **호출량 통제 / 캐시 / 키 노출면 축소**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 무엇이 바뀌었나 — **키는 이제 서버가 고른다** (§2.1.2, 2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 브라우저가 헤더로 원문 키를 실어 보내야만 했다. 그런데 넥슨 키는 **그 키를
 * 발급한 계정의 캐릭터만** 읽고(§1.1) 한 사람이 계정을 여러 개 쓰므로(§2.1), 키가 하나도
 * 없는 새 브라우저에서는 자격증명 3건·캐릭터 304명이 전부 보이는데도 **아무것도 동기화되지
 * 않았다.** 목록은 DB 에서 오는데 키는 그 기기에만 있었기 때문이다.
 *
 * 이제 순서가 뒤집힌다:
 *
 * ```
 *   1) 요청이 지목한 대상(캐릭터 / ocid / 자격증명)  →  자격증명 해석
 *        캐릭터·ocid 는 v_character_sync_source 가 이미 조인을 갖고 있다(§2.1.2)
 *   2) 그 자격증명의 원문 키를 **DB 에서 복호화**해 쓴다            ← 기본 경로
 *   3) 서버에 키가 없으면, 브라우저가 보낸 헤더 키로 떨어진다      ← 하위 호환
 *        + 그 호출이 성공하면 그 키를 서버에 보관한다(백필)
 *   4) 둘 다 없으면 `server_key_missing` — **오류가 아니라 상태**다
 * ```
 *
 * **DB 를 먼저 보는 것**이 중요하다. 그래야 브라우저가 엉뚱한 키를 보내도(예: 다른 계정
 * 키만 갖고 있는 기기) 서버가 올바른 키로 바로잡는다. 반대 순서였다면 그 요청은 넥슨까지
 * 나가 `OPENAPI00004` 로 거절당하고 **호출량만 태웠을** 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 이 파일이 강제하는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **세션이 있어야 한다.** 없으면 우리 서버가 아무나 쓰는 공개 넥슨 릴레이가 된다.
 *    (비로그인 열람 경로는 이 프록시를 타지 않는다 — 공개 시간표는 우리 DB 에서 온다.)
 * 2. **대상은 요청자의 것이어야 한다.** 캐릭터·ocid·자격증명 전부 `user_id` 로 좁혀서
 *    찾는다. 남의 자원을 지목하면 여기서 끝난다.
 * 3. **헤더 키를 쓸 때도 그 자격증명의 키여야 한다.** 해시가 대상 자격증명과 다르면
 *    `credential_mismatch` 다 — 넥슨을 부르기 전에 끊어야 호출량이 나가지 않는다.
 *
 * 키를 헤더로 받을 때는 **헤더로만** 받는다. 쿼리에 실으면 액세스 로그와 브라우저
 * 히스토리에 그대로 남는다.
 */

import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { PROXY_API_KEY_HEADER } from "@/lib/nexon/constants";
import { createNexonGateway } from "@/lib/nexon/gateway";
import { hashApiKey, normalizeApiKey } from "@/lib/nexon/key-hash";
import type { NexonEndpointDeps } from "@/lib/nexon/client";

import {
  loadCredentialSecret,
  pickServerUsableCredential,
  storeCredentialApiKey,
  type CredentialSecret,
} from "./credential-keys";
import { ApiError, apiKeySchema } from "./http";
import { readSession } from "./session";

export interface NexonProxyContext {
  readonly userId: string;
  readonly credentialId: string;
  readonly apiKey: string;
  readonly apiKeyHash: string;
  readonly db: AdminDb;
  /** 캐시·장부·쿨다운이 끼워진 실행기. 엔드포인트 래퍼에 그대로 넘긴다. */
  readonly gateway: Required<NexonEndpointDeps>;
}

/**
 * 이 요청이 **누구를 위한 호출인가**. 자격증명을 고르는 유일한 근거다.
 *
 * `unscoped` 는 대상이 없는 호출(`/character/list`)뿐이며, 그때만 "이 사용자의 키 중
 * 아무거나 하나"로 떨어진다. 대상이 있는 호출에서 아무 키나 고르는 일은 없다 —
 * 그렇게 하면 넥슨이 거절하면서 우리 호출량만 태운다(§1.0 실측).
 */
export type NexonProxyTarget =
  | { readonly kind: "character"; readonly characterId: string }
  | { readonly kind: "ocid"; readonly ocid: string }
  | { readonly kind: "credential"; readonly credentialId: string }
  | { readonly kind: "unscoped" };

const UNSCOPED: NexonProxyTarget = { kind: "unscoped" };

/** 헤더에 실려 온 원문 키. 없으면 `null`, 형식이 깨졌으면 400. */
function readHeaderApiKey(request: Request): string | null {
  const rawHeader = request.headers.get(PROXY_API_KEY_HEADER);
  if (rawHeader === null || rawHeader.trim() === "") return null;

  const parsed = apiKeySchema.safeParse(rawHeader);
  if (!parsed.success) {
    throw ApiError.badRequest(
      parsed.error.issues[0]?.message ?? "API 키 형식이 올바르지 않습니다.",
    );
  }
  return normalizeApiKey(parsed.data);
}

/** 대상 해석 결과. 자격증명을 특정하지 못한 경우(`unscoped`)만 `null` 이다. */
interface ResolvedTarget {
  readonly credentialId: string;
  /** 화면 문구에 쓸 캐릭터 이름. 자격증명 대상이면 `null`. */
  readonly characterName: string | null;
}

/**
 * 캐릭터 / ocid → 그 캐릭터를 읽을 수 있는 자격증명.
 *
 * 조인은 다시 구현하지 않는다 — `v_character_sync_source` 가 이미
 * `characters.nexon_account_ref → credential_nexon_accounts → user_credentials` 를
 * 갖고 있고, 무효화되지 않은 키 중 최근 검증 순으로 하나를 골라 준다(마이그레이션 12-4).
 * 두 벌로 두면 "동기화 가능"의 정의가 웹과 DB 에서 갈라진다.
 */
async function resolveCharacterCredential(
  db: AdminDb,
  userId: string,
  filter: { readonly column: "character_id" | "ocid"; readonly value: string },
): Promise<ResolvedTarget> {
  const { data, error } = await db
    .from("v_character_sync_source")
    .select("character_id, character_name, credential_id, nexon_account_ref")
    .eq("user_id", userId)
    .eq(filter.column, filter.value)
    .limit(1);

  if (error !== null) throw error;

  const row = (data ?? [])[0];
  if (row === undefined) {
    // 남의 캐릭터이거나 우리 DB 에 없는 캐릭터다. 넥슨을 부를 이유가 없다.
    throw ApiError.badRequest(
      "이 계정에 등록되지 않은 캐릭터입니다. 캐릭터 목록을 새로 불러와 주세요.",
    );
  }

  const name = row.character_name ?? "이 캐릭터";

  if (row.nexon_account_ref === null) {
    /*
     * 출처 기록이 없으면 **어느 키를 써야 하는지 알 수 없다.** 아무 키나 보내면 거절과
     * 함께 호출량만 나가므로 여기서 끊는다. 복구 경로는 키 재확인(= `/character/list`
     * 재동기화)이며, 그 과정에서 `nexon_account_ref` 가 다시 채워진다.
     */
    throw ApiError.credentialMismatch(
      `${name} 이(가) 어느 넥슨 계정에서 왔는지 기록이 없어 어떤 키로 불러야 할지 알 수 없습니다. 계정 · 키 관리에서 키를 다시 입력하면 연결이 복구됩니다.`,
    );
  }

  if (row.credential_id === null) {
    // 계정은 아는데 그 계정에 유효한 키가 하나도 없다. 조치는 "그 계정 키를 등록하라".
    throw ApiError.serverKeyMissing(
      `${name} 이(가) 속한 넥슨 계정에 사용할 수 있는 API 키가 없습니다. 계정 · 키 관리에서 그 계정의 키를 입력해 주세요.`,
    );
  }

  return { credentialId: row.credential_id, characterName: name };
}

async function resolveTarget(
  db: AdminDb,
  userId: string,
  target: NexonProxyTarget,
): Promise<ResolvedTarget | null> {
  switch (target.kind) {
    case "character":
      return resolveCharacterCredential(db, userId, {
        column: "character_id",
        value: target.characterId,
      });
    case "ocid":
      return resolveCharacterCredential(db, userId, {
        column: "ocid",
        value: target.ocid,
      });
    case "credential": {
      const { data, error } = await db
        .from("user_credentials")
        .select("id")
        .eq("id", target.credentialId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error !== null) throw error;
      if (data === null) {
        throw ApiError.badRequest(
          "이 계정에 등록되지 않은 API 키입니다. 계정 · 키 관리에서 먼저 추가해 주세요.",
        );
      }
      return { credentialId: data.id, characterName: null };
    }
    case "unscoped":
      return null;
  }
}

/** 이 해시의 키가 **이 사용자에게** 등록돼 있는가. 실패 문구를 가르는 데만 쓴다. */
async function isKeyRegisteredToUser(
  db: AdminDb,
  userId: string,
  apiKeyHash: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("user_credentials")
    .select("id")
    .eq("api_key_hash", apiKeyHash)
    .eq("user_id", userId)
    .maybeSingle();
  if (error !== null) throw error;
  return data !== null;
}

/** 대상별 "서버에 키가 없다" 문구. 무엇을 하면 되는지까지 말한다(§2.1.2). */
function serverKeyMissingMessage(characterName: string | null): string {
  const subject =
    characterName === null
      ? "이 계정의"
      : `${characterName} 이(가) 속한 넥슨 계정의`;
  return (
    `${subject} API 키가 서버에 저장돼 있지 않습니다. ` +
    `계정 · 키 관리에서 그 키를 한 번 입력하면, 이후에는 어느 브라우저에서든 자동으로 불러옵니다.`
  );
}

/**
 * 세션 + 대상 → **넥슨을 부를 준비가 끝난 컨텍스트.**
 *
 * @param target 대상이 없는 호출만 생략한다. 캐릭터를 다루는 경로가 생략하면
 *   "브라우저가 보낸 키"에만 의존하게 되어, 이 수정이 고치려는 결함으로 되돌아간다.
 */
export async function resolveNexonProxyContext(
  request: Request,
  target: NexonProxyTarget = UNSCOPED,
): Promise<NexonProxyContext> {
  const session = await readSession();
  if (session === null) throw ApiError.unauthenticated();

  const db = getAdminDb();
  const userId = session.uid;
  const headerKey = readHeaderApiKey(request);

  const resolved = await resolveTarget(db, userId, target);

  // ── 대상이 자격증명을 특정한 경우 — **DB 키가 우선이다** ────────────────────
  if (resolved !== null) {
    const secret = await loadCredentialSecret(db, resolved.credentialId);
    if (secret === null) {
      // 방금 조회한 자격증명이 사라졌다 = 우리 쪽 경합. 사용자가 할 일은 없다.
      throw ApiError.internal();
    }

    if (secret.rawKey !== null) {
      return buildContext({ db, userId, secret, apiKey: secret.rawKey });
    }

    // ── 서버에 키가 없다 → 브라우저가 보낸 키로 떨어진다(하위 호환) ──────────
    if (headerKey !== null) {
      const headerHash = hashApiKey(headerKey);
      if (headerHash !== secret.apiKeyHash) {
        /*
         * 보낸 키가 이 대상의 자격증명 것이 아니다. 넥슨도 `OPENAPI00004` 로 거절하지만
         * **그 거절은 우리 호출량을 태운 뒤에** 온다(§1.0 실측).
         *
         * ★ 여기서 원인을 한 번 더 가른다. "다른 계정의 키다"와 "아예 등록되지 않은
         *   키다"는 조치가 다르다 — 전자는 맞는 키를 고르는 것이고, 후자는 그 키를 먼저
         *   등록하거나 새로 발급받는 것이다. 뭉뚱그리면 사용자는 멀쩡한 키를 의심하며
         *   시간을 쓴다. 이 조회는 **실패 경로에서만** 일어나므로 정상 호출을 늦추지 않는다.
         */
        throw (await isKeyRegisteredToUser(db, userId, headerHash))
          ? ApiError.credentialMismatch(
              resolved.characterName === null
                ? "보낸 API 키가 이 요청의 넥슨 계정 키가 아닙니다. 계정 · 키 관리에서 그 계정의 키를 입력해 주세요."
                : `${resolved.characterName} 은(는) 다른 넥슨 계정의 캐릭터라 지금 보낸 키로는 불러올 수 없습니다. 계정 · 키 관리에서 그 계정의 API 키를 입력해 주세요.`,
            )
          : ApiError.badRequest(
              "보낸 API 키가 이 계정에 등록되어 있지 않습니다. 계정 · 키 관리에서 먼저 추가해 주세요.",
            );
      }
      return buildContext({
        db,
        userId,
        secret,
        apiKey: headerKey,
        // 이 호출이 성공하면 그때 보관한다 — 성공이 곧 "지금 유효하다"의 증명이다.
        backfill: true,
      });
    }

    throw ApiError.serverKeyMissing(
      serverKeyMissingMessage(resolved.characterName),
    );
  }

  // ── 대상이 없는 호출(`/character/list`) ────────────────────────────────────
  if (headerKey !== null) {
    const apiKeyHash = hashApiKey(headerKey);
    const { data: credential, error } = await db
      .from("user_credentials")
      .select("id, user_id")
      .eq("api_key_hash", apiKeyHash)
      .maybeSingle();
    if (error !== null) throw error;

    if (credential === null) {
      throw ApiError.badRequest(
        "이 API 키는 현재 계정에 등록되어 있지 않습니다. 먼저 키를 추가해 주세요.",
      );
    }
    /*
     * 남의 계정에 묶인 키는 거부한다. 원문 키를 아는 사람은 넥슨을 직접 부를 수 있으니
     * 비밀이 새는 것은 아니지만, 남의 자격증명 앞으로 호출량이 쌓이면 장부가 거짓이 된다.
     */
    if (credential.user_id !== userId) throw ApiError.keyOwnedByOtherAccount();

    const secret = await loadCredentialSecret(db, credential.id);
    if (secret === null) throw ApiError.internal();

    return buildContext({
      db,
      userId,
      secret,
      apiKey: headerKey,
      backfill: secret.rawKey === null,
    });
  }

  const fallback = await pickServerUsableCredential(db, userId);
  if (fallback !== null && fallback.rawKey !== null) {
    return buildContext({ db, userId, secret: fallback, apiKey: fallback.rawKey });
  }

  throw ApiError.serverKeyMissing(serverKeyMissingMessage(null));
}

function buildContext(input: {
  readonly db: AdminDb;
  readonly userId: string;
  readonly secret: CredentialSecret;
  readonly apiKey: string;
  readonly backfill?: boolean;
}): NexonProxyContext {
  const { db, userId, secret, apiKey } = input;
  const credentialId = secret.credentialId;

  /*
   * ★ **백필** — 브라우저가 들고 있던 키를 서버에 올린다 (§2.1.2).
   *
   *   기존 사용자는 localStorage 에만 키를 갖고 있고, 그대로 두면 "계정 · 키 관리에서
   *   같은 키를 한 번 더 입력"하기 전까지 새 기기에서 계속 실패한다. 그런데 그 키는
   *   **바로 지금 이 요청에 쓰이고 있으므로**, 호출이 200 으로 돌아온 순간이 곧
   *   "이 키는 유효하다"의 증명이다. 검증 전용 호출을 따로 내지 않고 그 순간을 쓴다.
   *
   *   한 요청 안에서 여러 번 불릴 수 있으므로 `stored` 플래그로 한 번만 저장한다.
   */
  let stored = input.backfill !== true;

  return {
    userId,
    credentialId,
    apiKey,
    apiKeyHash: secret.apiKeyHash,
    db,
    gateway: createNexonGateway({
      apiKey,
      apiKeyHash: secret.apiKeyHash,
      credentialId,
      db,
      ...(stored
        ? {}
        : {
            onCallSucceeded: async () => {
              if (stored) return;
              stored = true;
              await storeCredentialApiKey(db, credentialId, apiKey);
            },
          }),
    }),
  };
}

/**
 * `ocid` 가 이 사용자의 캐릭터인지 확인한다.
 *
 * 넥슨도 남의 계정 ocid 를 `OPENAPI00004` 로 거절하지만(실측), **그 거절은 우리 호출량을
 * 이미 태운 뒤에** 온다. 우리 DB 에서 먼저 막으면 호출 자체가 나가지 않는다.
 *
 * ⚠️ `resolveNexonProxyContext(request, { kind: "ocid" })` 를 지난 요청에서는 이미
 *    같은 사실이 확인돼 있다. 그래도 남겨 둔다 — 이 함수는 **대상 없이** 컨텍스트를 만든
 *    경로에서도 불리며, 방어선을 지우는 것보다 한 번 더 확인하는 편이 싸다.
 */
export async function assertOwnedOcid(
  context: NexonProxyContext,
  ocid: string,
): Promise<void> {
  const { data, error } = await context.db
    .from("characters")
    .select("id")
    .eq("user_id", context.userId)
    .eq("ocid", ocid)
    .maybeSingle();

  if (error !== null) throw error;
  if (data === null) {
    throw ApiError.badRequest(
      "이 계정에 등록되지 않은 캐릭터입니다. 캐릭터 목록을 새로 불러와 주세요.",
    );
  }
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * **세션 없이** 넥슨을 부를 컨텍스트 — 예약 동기화 전용
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"매일 저녁 23시 55분에 동기화를 돌린다"* — 밤에 도는 작업에는
 * 브라우저가 없다. 그래서 세션 대신 **DB 에 저장된 키**(AEAD 복호화)로 컨텍스트를 만든다.
 *
 * ★ 이 함수는 **누구인지 묻지 않는다.** 부르는 쪽이 이미 "이 캐릭터는 이 자격증명의
 *   것"임을 알고 있어야 하며(`v_character_sync_source` 가 그 짝을 준다), 그 판정을 여기서
 *   다시 하지 않는다. 그래서 **크론처럼 자기 자신이 신뢰 경계인 호출자만** 써야 한다 —
 *   요청에서 온 값을 그대로 넘기면 남의 키로 남의 캐릭터를 부르는 문이 된다.
 * ★ 서버 저장 키가 없으면(`rawKey === null`) `null` 이다. 옛 사용자는 브라우저에만 키가
 *   있을 수 있고(§2.1.2), 그건 오류가 아니라 **밤에는 건너뛴다**는 뜻이다.
 */
export async function buildServerNexonContext(input: {
  readonly db: AdminDb;
  readonly userId: string;
  readonly credentialId: string;
}): Promise<NexonProxyContext | null> {
  const secret = await loadCredentialSecret(input.db, input.credentialId);
  if (secret === null || secret.rawKey === null) return null;

  return buildContext({
    db: input.db,
    userId: input.userId,
    secret,
    apiKey: secret.rawKey,
  });
}
