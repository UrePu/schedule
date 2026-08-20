import "server-only";

/**
 * 계정 해석 — **"이 키는 누구인가"의 단일 구현.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙 (CLAUDE.md §2.1) — 여기서 벗어나면 계정 탈취가 된다
 * ─────────────────────────────────────────────────────────────────────────────
 * - 로그인은 `sha256(key)` → `resolve_login_by_key_hash()` 한 경로뿐이다.
 *   **주 키든 연결 키든 같은 사람으로 들어온다.** "주 키여야 로그인된다"는 규칙은 없다.
 * - 키 추가는 **세션이 있어야만** 된다. 그게 "이 키를 이 사람에게 붙인다"를 성립시킨다.
 * - **이미 다른 사람에게 묶인 키는 거부한다.** 조용히 소유자를 바꾸는 것이 곧 탈취다.
 *   DB 함수 `attach_nexon_credential()` 이 최종 방어선이고, 여기서는 더 나은 문구를
 *   주기 위해 먼저 확인할 뿐이다. 확인을 지나쳐도 DB 가 막는다.
 * - **원문 키는 AEAD 로 암호화해 DB 에 보관한다** (§2.1.2, 발주자 결정 2026-08-18).
 *   저장은 넥슨이 그 키를 유효하다고 답한 **뒤에만** 일어난다 — 무효한 키를 보관하면
 *   "서버에 키는 있는데 동기화만 조용히 실패하는" 최악의 상태가 된다. 계정 **식별**은
 *   여전히 `api_key_hash` 하나로 하며, 암호문은 서버가 사용자를 대신해 넥슨을 부르기
 *   위한 사본일 뿐 조회 키가 아니다. 평문 저장은 어떤 경우에도 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 호출은 정확히 **1콜**이다 (§2.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * `/character/list` 하나가 키 유효성 검사이자 소유 캐릭터 목록이다.
 * `/v1/id` 는 쓰지 않는다 — 소유를 증명하지 못한다.
 */

import type { AdminDb } from "@/lib/supabase/admin-db";
import { fetchCharacterList } from "@/lib/nexon/client";
import { createNexonGateway } from "@/lib/nexon/gateway";
import { hashApiKey, normalizeApiKey } from "@/lib/nexon/key-hash";
import { recordNexonCall } from "@/lib/nexon/quota";
import type {
  NexonCallOutcome,
  NexonCharacterListResult,
  NexonCharacterSummary,
} from "@/lib/nexon/types";

import type { CredentialSummary, LoginCharacter, SessionUser } from "../types";
import { storeCredentialApiKey } from "./credential-keys";
import { ApiError } from "./http";

const PG_UNIQUE_VIOLATION = "23505";

/** 사용자 표시명 CHECK 는 1~40자다. 넥슨 닉네임은 최대 30자라 잘릴 일이 거의 없다. */
const DISPLAY_NAME_MAX = 40;

/** 캐릭터가 하나도 없는 계정(이론상 가능)의 표시명. */
const FALLBACK_DISPLAY_NAME = "메이플 유저";

// ─────────────────────────────────────────────────────────────────────────────
// 조회
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 세션 사용자 전체 상태.
 *
 * 삭제/정지 계정은 **null 이 아니라 그대로 돌려준다** — 호출부가 401 로 접을지
 * 403 으로 접을지 정한다. 다만 `deleted_at` 이 찍힌 계정은 존재하지 않는 것으로 본다.
 */
export async function loadSessionUser(
  db: AdminDb,
  userId: string,
): Promise<SessionUser | null> {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 왕복 4회 → **1회** (2026-08-18 성능 작업)
   * ═══════════════════════════════════════════════════════════════════════════
   * 이 함수는 이제 **모든 화면**에서 돈다 — 루트 레이아웃이 세션을 캐시에 심기
   * 때문이다. 그래서 여기의 직렬 왕복 하나하나가 네 화면 전부의 비용이 된다.
   * 실측: 원격 Supabase 왕복 1회 ≈ 78ms, 그런데 `/api/auth/me` 가 0.30초였다.
   *
   * 고친 것은 둘이다.
   * 1. **세 조회는 서로를 기다릴 이유가 없다** — 전부 `user_id` 하나로 갈린다.
   *    직렬로 두면 그냥 3배 기다린다.
   * 2. `credential_nexon_accounts` 는 예전에 **키 목록을 받은 뒤에** 물었다(4단째).
   *    PostgREST 임베딩으로 키 조회 안에 넣으면 그 단계가 통째로 사라진다.
   *    ⚠️ FK(`credential_nexon_accounts.credential_id → user_credentials.id`)가
   *       관계 탐지의 근거다. FK 가 사라지면 이 임베딩도 함께 깨진다.
   */
  const [userResult, credentialResult, characterResult] = await Promise.all([
    db
      .from("app_users")
      .select(
        "id, display_name, main_character_name, main_world_name, status, deleted_at",
      )
      .eq("id", userId)
      .maybeSingle(),
    db
      .from("user_credentials")
      /*
       * `allow_server_side_use` 만 읽는다. **암호문(`encrypted_api_key`)은 읽지 않는다** —
       * 이 함수의 결과는 그대로 `/api/auth/me` 응답이 되므로, 암호문을 여기로 끌어오는
       * 순간 한 줄 실수로 응답에 실릴 수 있는 자리에 놓이게 된다. "서버가 부를 수 있는가"는
       * CHECK 제약 덕분에 이 불리언 하나로 정확히 판정된다(§2.1.2).
       */
      .select(
        "id, label, is_primary, invalidated_at, last_validated_at, allow_server_side_use, credential_nexon_accounts(nexon_account_ref)",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db
      .from("characters")
      .select("id, is_tracked, nexon_account_ref")
      .eq("user_id", userId),
  ]);

  const { data: user, error: userError } = userResult;
  if (userError !== null) throw userError;
  if (user === null || user.deleted_at !== null) return null;

  const { data: credentialRows, error: credentialError } = credentialResult;
  if (credentialError !== null) throw credentialError;

  const { data: characterRows, error: characterError } = characterResult;
  if (characterError !== null) throw characterError;

  const characters = characterRows ?? [];

  /* 임베딩 결과를 예전 `linkRows` 모양으로 펴서 아래 계산을 그대로 쓴다. */
  const linkRows: readonly {
    readonly credential_id: string;
    readonly nexon_account_ref: string;
  }[] = (credentialRows ?? []).flatMap((row) =>
    row.credential_nexon_accounts.map((link) => ({
      credential_id: row.id,
      nexon_account_ref: link.nexon_account_ref,
    })),
  );

  /*
   * 키별 "연결된 넥슨 계정 수 / 캐릭터 수".
   *
   * `characters` 는 **키가 아니라 계정**을 가리킨다(키 재발급이 캐릭터를 고아로 만들지
   * 않게 하려고 그렇게 설계했다 — R2-F). 그래서 키 → 계정(`credential_nexon_accounts`)
   * → 캐릭터(`characters.nexon_account_ref`) 두 단계를 거친다.
   * 왕복은 **키 개수와 무관하게 1회**다 — 사용자당 키가 여러 개여도 한 번에 읽는다.
   */
  const charactersPerAccount = new Map<string, number>();
  for (const row of characters) {
    if (row.nexon_account_ref === null) continue;
    charactersPerAccount.set(
      row.nexon_account_ref,
      (charactersPerAccount.get(row.nexon_account_ref) ?? 0) + 1,
    );
  }

  const accountsPerCredential = new Map<string, string[]>();
  for (const row of linkRows) {
    const list = accountsPerCredential.get(row.credential_id) ?? [];
    list.push(row.nexon_account_ref);
    accountsPerCredential.set(row.credential_id, list);
  }

  /*
   * ★ 계정별 **유효한** 키 수 — "이 키를 지우면 무엇이 멈추는가"의 근거.
   *
   *   `character_is_syncable(user_id, account_ref)` 와 **같은 조건**을 TS 로 옮긴 것이다:
   *   그 계정에 붙은 키 중 `invalidated_at is null` 인 것이 하나라도 있으면 동기화된다.
   *   두 곳에 같은 규칙이 있는 것은 위험하지만, DB 함수는 "지금 상태"만 답할 뿐
   *   "이 키를 지우면?"이라는 가정 질문에 답하지 못한다. 조건이 한 줄이라 옮겼고,
   *   바뀔 때 함께 고치라고 여기에 적어 둔다.
   */
  const validCredentialsPerAccount = new Map<string, number>();
  const invalidatedCredentialIds = new Set(
    (credentialRows ?? [])
      .filter((row) => row.invalidated_at !== null)
      .map((row) => row.id),
  );
  for (const row of linkRows) {
    if (invalidatedCredentialIds.has(row.credential_id)) continue;
    validCredentialsPerAccount.set(
      row.nexon_account_ref,
      (validCredentialsPerAccount.get(row.nexon_account_ref) ?? 0) + 1,
    );
  }

  const credentials: CredentialSummary[] = (credentialRows ?? []).map((row) => {
    const accountRefs = accountsPerCredential.get(row.id) ?? [];
    const isInvalidated = row.invalidated_at !== null;

    /*
     * 이 키가 **마지막 유효 키**인 계정만 센다.
     *
     * - 같은 계정에 다른 유효한 키가 있으면 지워도 그 계정은 계속 동기화된다 → 0.
     * - 이 키가 이미 무효화 상태라면 지워도 상태가 바뀌지 않는다 → 0.
     *   (무효화된 키는 애초에 `validCredentialsPerAccount` 에 세지 않았다.)
     */
    const strandedRefs = isInvalidated
      ? []
      : accountRefs.filter(
          (ref) => (validCredentialsPerAccount.get(ref) ?? 0) <= 1,
        );

    return {
      id: row.id,
      label: row.label,
      isPrimary: row.is_primary,
      isInvalidated,
      lastValidatedAt: row.last_validated_at,
      // 서버가 이 키를 대신 부를 수 있는가. 화면의 "키 없음" 경고는 이 값이 false 일 때만.
      hasServerKey: row.allow_server_side_use,
      nexonAccountCount: accountRefs.length,
      characterCount: accountRefs.reduce(
        (sum, ref) => sum + (charactersPerAccount.get(ref) ?? 0),
        0,
      ),
      strandedAccountCount: strandedRefs.length,
      strandedCharacterCount: strandedRefs.reduce(
        (sum, ref) => sum + (charactersPerAccount.get(ref) ?? 0),
        0,
      ),
    };
  });

  return {
    id: user.id,
    displayName: user.display_name,
    mainCharacterName: user.main_character_name,
    mainWorldName: user.main_world_name,
    status: user.status,
    credentials,
    characterCount: characters.length,
    trackedCharacterCount: characters.filter((row) => row.is_tracked).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 캐릭터/계정 동기화
// ─────────────────────────────────────────────────────────────────────────────

interface CharacterUpsertRow {
  id?: string;
  user_id: string;
  character_name: string;
  world_name: string | null;
  ocid: string;
  ocid_refreshed_at: string;
  character_class: string | null;
  character_level: number | null;
  nexon_account_ref: string | null;
}

// 구분자로 NUL 을 쓴다. 캐릭터명·월드명에 절대 들어갈 수 없는 문자라
// "가" + "나다" 와 "가나" + "다" 가 같은 키가 되는 사고를 원천 차단한다.
// 소스에는 이스케이프로 적는다 — 원시 NUL 바이트가 들어가면 grep 등이 이 파일을
// 바이너리로 취급해 코드 검색에서 조용히 빠진다(실제로 겪었다).
const CHARACTER_KEY_SEPARATOR = "\u0000";

function characterKey(name: string, world: string | null): string {
  return `${name}${CHARACTER_KEY_SEPARATOR}${world ?? ""}`;
}

/**
 * 넥슨 계정 1개를 우리 쪽에 붙인다.
 *
 * ⚠️ `user_nexon_accounts.nexon_account_id` 는 **전역 유니크**다(사용자별이 아니다).
 *    그래서 같은 넥슨 계정이 이미 **다른 앱 사용자**에게 붙어 있으면 여기서 멈춘다.
 *    upsert 로 덮으면 남의 계정을 조용히 가져오는 셈이 된다 —
 *    `attach_nexon_credential` 이 키에 대해 막는 것과 정확히 같은 이유다.
 */
async function resolveNexonAccountRef(
  db: AdminDb,
  userId: string,
  nexonAccountId: string,
): Promise<string> {
  const { data: existing, error: selectError } = await db
    .from("user_nexon_accounts")
    .select("id, user_id")
    .eq("nexon_account_id", nexonAccountId)
    .maybeSingle();

  if (selectError !== null) throw selectError;

  if (existing !== null) {
    if (existing.user_id !== userId) throw ApiError.keyOwnedByOtherAccount();

    const { error: touchError } = await db
      .from("user_nexon_accounts")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (touchError !== null) throw touchError;

    return existing.id;
  }

  const { data: inserted, error: insertError } = await db
    .from("user_nexon_accounts")
    .insert({ user_id: userId, nexon_account_id: nexonAccountId })
    .select("id")
    .single();

  if (insertError !== null) {
    if (insertError.code === PG_UNIQUE_VIOLATION) {
      throw ApiError.keyOwnedByOtherAccount();
    }
    throw insertError;
  }

  return inserted.id;
}

/**
 * 이 키가 소유한 넥슨 계정·캐릭터를 우리 DB 에 반영한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 단순 upsert 가 아닌가 — **개명과 ocid 가변성**
 * ─────────────────────────────────────────────────────────────────────────────
 * `characters` 의 유니크 키는 `(user_id, character_name, world_name)` 인데
 * **ocid 에도 부분 유니크 인덱스**가 걸려 있다. 캐릭터가 개명하면 이름 기준 upsert 는
 * *새 행*을 만들려 하고, 그 순간 옛 행이 들고 있던 같은 ocid 와 충돌해 로그인 전체가
 * 유니크 위반으로 죽는다. 게다가 그렇게 만든 새 행은 **과거 클리어 기록과 끊긴다.**
 *
 * → 그래서 **ocid 를 먼저 보고 그 행을 따라간다.** 개명은 같은 행의 이름 변경이다.
 *   ocid 로 못 찾으면 이름+월드로 찾고(옛 데이터에 ocid 가 비어 있을 수 있다),
 *   그래도 없을 때만 새로 만든다.
 *
 * 갱신은 `id` 기준 upsert 한 번으로 묶어 **캐릭터 59명이 왕복 59번이 되지 않게** 한다.
 * `is_main` / `is_tracked` 는 payload 에서 **일부러 뺐다** — PostgREST 는 보낸 컬럼만
 * 갱신하므로, 빼는 것만으로 사용자의 선택이 로그인마다 초기화되는 것을 막는다.
 */
export async function syncCredentialInventory(
  db: AdminDb,
  input: {
    readonly userId: string;
    readonly credentialId: string;
    readonly list: NexonCharacterListResult;
  },
): Promise<readonly string[]> {
  const now = new Date().toISOString();
  const accountRefs: string[] = [];

  const { data: existingRows, error: existingError } = await db
    .from("characters")
    .select("id, ocid, character_name, world_name")
    .eq("user_id", input.userId);

  if (existingError !== null) throw existingError;

  const byOcid = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of existingRows ?? []) {
    if (row.ocid !== null) byOcid.set(row.ocid, row.id);
    byName.set(characterKey(row.character_name, row.world_name), row.id);
  }

  const updates: CharacterUpsertRow[] = [];
  const inserts: CharacterUpsertRow[] = [];

  for (const account of input.list.accounts) {
    let accountRef: string | null = null;

    if (account.accountId !== null && account.accountId !== "") {
      accountRef = await resolveNexonAccountRef(
        db,
        input.userId,
        account.accountId,
      );
      accountRefs.push(accountRef);

      // 키 ↔ 계정은 M:N 이다. `account_list` 가 배열이고, 키를 재발급하면
      // 같은 계정에 새 credential 이 또 붙기 때문이다(DB-SCHEMA 난제 11-2).
      const { error: linkError } = await db
        .from("credential_nexon_accounts")
        .upsert(
          {
            credential_id: input.credentialId,
            nexon_account_ref: accountRef,
            last_seen_at: now,
          },
          { onConflict: "credential_id,nexon_account_ref" },
        );
      if (linkError !== null) throw linkError;
    }

    for (const character of account.characters) {
      const base: CharacterUpsertRow = {
        user_id: input.userId,
        character_name: character.characterName,
        world_name: character.worldName,
        ocid: character.ocid,
        ocid_refreshed_at: now,
        character_class: character.characterClass,
        character_level: character.characterLevel,
        nexon_account_ref: accountRef,
      };

      const existingId =
        byOcid.get(character.ocid) ??
        byName.get(characterKey(character.characterName, character.worldName));

      if (existingId === undefined) {
        inserts.push(base);
      } else {
        updates.push({ ...base, id: existingId });
      }
    }
  }

  if (updates.length > 0) {
    const { error } = await db
      .from("characters")
      .upsert(updates, { onConflict: "id" });
    if (error !== null) throw error;
  }

  if (inserts.length > 0) {
    const { error } = await db.from("characters").insert(inserts);
    if (error !== null) throw error;
  }

  return accountRefs;
}

/** 이 자격증명이 볼 수 있는 캐릭터 목록. 캐릭터 선택 모달이 그대로 쓴다. */
export async function loadCredentialCharacters(
  db: AdminDb,
  userId: string,
  accountRefs: readonly string[],
): Promise<readonly LoginCharacter[]> {
  const query = db
    .from("characters")
    .select(
      "id, ocid, character_name, world_name, character_class, character_level, is_main, is_tracked",
    )
    .eq("user_id", userId)
    .order("character_level", { ascending: false, nullsFirst: false });

  const { data, error } =
    accountRefs.length > 0
      ? await query.in("nexon_account_ref", [...accountRefs])
      : await query;

  if (error !== null) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    ocid: row.ocid ?? "",
    characterName: row.character_name,
    worldName: row.world_name,
    characterClass: row.character_class,
    characterLevel: row.character_level,
    isMain: row.is_main,
    isTracked: row.is_tracked,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 로그인 / 키 추가
// ─────────────────────────────────────────────────────────────────────────────

/** 레벨이 가장 높은 캐릭터. 사람들은 본캐로 보스를 돈다(§2.1.1). */
function pickHeadlineCharacter(
  characters: readonly NexonCharacterSummary[],
): NexonCharacterSummary | null {
  return characters.reduce<NexonCharacterSummary | null>((best, current) => {
    if (best === null) return current;
    return (current.characterLevel ?? 0) > (best.characterLevel ?? 0)
      ? current
      : best;
  }, null);
}

interface KeyValidation {
  readonly list: NexonCharacterListResult;
  /** 실제로 넥슨을 부른 결과. 캐시 적중이면 비어 있다. */
  readonly unattributedCalls: readonly NexonCallOutcome[];
}

/** 키 1개를 넥슨에 확인한다. **정확히 1콜.** */
async function validateApiKey(
  db: AdminDb,
  apiKey: string,
  apiKeyHash: string,
  credentialId: string | null,
): Promise<KeyValidation> {
  const unattributedCalls: NexonCallOutcome[] = [];

  const gateway = createNexonGateway({
    apiKey,
    apiKeyHash,
    credentialId,
    db,
    onUnattributedCall: (outcome) => unattributedCalls.push(outcome),
  });

  const list = await fetchCharacterList(apiKey, gateway);
  return { list, unattributedCalls };
}

export interface LoginResult {
  readonly user: SessionUser;
  readonly credentialId: string;
  readonly isNewAccount: boolean;
  readonly characters: readonly LoginCharacter[];
}

/**
 * 키로 로그인한다. 계정이 없으면 그 자리에서 만든다.
 *
 * ★ 새로 만든 캐릭터는 전부 **`is_tracked = false`** 다(컬럼 기본값).
 *   추적은 옵트인이다 — 실측 계정이 59명인데 전부 동기화하면 스케줄러 호출만으로
 *   하루 예산의 6%를 매번 태운다(§2.1.1).
 */
/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 키 해시가 안 맞을 때의 **두 번째 관문 — 넥슨 계정 id**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"어느 API 키를 가져오던 같은사람으로 찍힐수있게 하면 좋을거같은데.
 * 어차피 전부 넥슨 어카운트 id 가 메인아님?"*
 *
 * CLAUDE.md §2.1 이 이미 이렇게 적어 두었다 — *"`account_list[].account_id` 를 보조
 * 식별자로 저장한다: 사용자가 API 키를 재발급하면 SHA-256 해시가 바뀌어 계정을 잃게
 * 되기 때문이다"*. 그런데 **로그인 경로에는 그 폴백이 없었다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 없을 때 실제로 벌어지던 일 (실데이터로 확인, 2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * 해시가 안 맞으면 `createUser()` 로 **새 사용자를 먼저 만들고**, 그다음
 * `syncCredentialInventory` → `resolveNexonAccountRef` 가 "그 넥슨 계정은 이미 남의
 * 것"이라며 던진다. 결과는 **로그인 실패 + 본캐도 캐릭터도 없는 빈 `app_users` 찌꺼기.**
 * 실제로 그런 행이 둘 남아 있었다(`main_character_name is null`, 넥슨 계정 0개).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 판정이 해시만큼 강한가
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨은 그 계정의 주인에게만 키를 발급한다. 즉 **"account_list 에 X 가 들어 있는 키를
 * 내밀 수 있다" = "X 를 지배한다"** 이고, 이는 등록된 키를 내미는 것과 같은 증명이다.
 * 게다가 `user_nexon_accounts.nexon_account_id` 가 **전역 유니크**라 넥슨 계정 하나는
 * 앱 사용자 하나에만 붙는다 — 이 조회가 두 사람을 가리킬 구조적 여지가 없다.
 *
 * ⚠️ 그래도 **여러 명이 나오면 던진다.** 한 키가 여러 넥슨 계정을 본다는 것이 실측이고
 *    (죠린의 키 하나가 12개를 본다), 그 계정들이 서로 다른 앱 사용자에게 나뉘어 붙어
 *    있을 가능성이 0은 아니다. 그때 아무나 고르면 그것이 계정 탈취다.
 * ⚠️ 이 완화는 **로그인에만** 적용된다. 로그인한 채로 남의 계정에 묶인 키를 *추가*하는
 *    것은 §2.1 그대로 계속 거절한다(`resolveNexonAccountRef`).
 */
async function resolveUserByNexonAccounts(
  db: AdminDb,
  accountIds: readonly string[],
): Promise<string | null> {
  if (accountIds.length === 0) return null;

  const { data, error } = await db
    .from("user_nexon_accounts")
    .select("user_id, app_users!inner(status, deleted_at)")
    .in("nexon_account_id", [...accountIds]);
  if (error !== null) throw error;

  const owners = [
    ...new Set(
      (data ?? []).flatMap((row) =>
        row.app_users?.deleted_at === null ? [row.user_id] : [],
      ),
    ),
  ];

  if (owners.length === 0) return null;
  // 둘 이상이면 고르지 않는다(머리말).
  if (owners.length > 1) throw ApiError.keyOwnedByOtherAccount();

  const owner = owners[0];
  const status = (data ?? []).find((row) => row.user_id === owner)?.app_users
    ?.status;
  if (status !== "active") throw ApiError.accountUnavailable();

  return owner;
}

export async function loginWithApiKey(
  db: AdminDb,
  input: { readonly apiKey: string; readonly label: string | null },
): Promise<LoginResult> {
  const apiKey = normalizeApiKey(input.apiKey);
  const apiKeyHash = hashApiKey(apiKey);

  const { data: resolved, error: resolveError } = await db.rpc(
    "resolve_login_by_key_hash",
    { p_api_key_hash: apiKeyHash },
  );
  if (resolveError !== null) throw resolveError;

  const existing = resolved?.[0] ?? null;

  if (existing !== null && existing.account_status !== "active") {
    throw ApiError.accountUnavailable();
  }

  // ★ 넥슨 호출은 여기 한 번뿐이다.
  const { list, unattributedCalls } = await validateApiKey(
    db,
    apiKey,
    apiKeyHash,
    existing?.credential_id ?? null,
  );

  /*
   * ★ **해시가 안 맞으면 넥슨 계정 id 로 한 번 더 찾는다** (키 재발급 복구).
   *   여기서 찾아지면 새 사용자를 만들지 않는다 — 예전에는 만들고 나서 넥슨 계정 충돌로
   *   던져 빈 계정만 남겼다(`resolveUserByNexonAccounts` 머리말).
   *
   *   `validateApiKey` **뒤**에 있어야 한다. 넥슨이 준 `account_list` 가 있어야 조회할
   *   대상이 생기기 때문이고, 그 호출은 어차피 로그인마다 한 번 나가므로 왕복이 늘지 않는다.
   */
  const recoveredUserId =
    existing !== null
      ? null
      : await resolveUserByNexonAccounts(
          db,
          /*
            `accountId` 는 **null 일 수 있다** — 넥슨이 `account_list[].account_id` 를
            빼고 주는 경우가 타입에 열려 있다. 그런 항목은 식별에 쓸 수 없으므로 버린다.
            (전부 null 이면 빈 배열이 되어 조회 자체를 건너뛴다 = 예전 동작 그대로.)
          */
          list.accounts.flatMap((account) =>
            account.accountId === null ? [] : [account.accountId],
          ),
        );

  const userId =
    existing?.user_id ??
    recoveredUserId ??
    (await createUser(db, list.characters));
  // 복구된 계정은 **새 계정이 아니다** — 본캐를 다시 정하면 안 된다(아래 `assignMainCharacter`).
  const isNewAccount = existing === null && recoveredUserId === null;

  let credentialId: string;
  if (existing === null) {
    /*
     * ★ 복구인 경우 **기존 키를 덮지 않고 새 키를 하나 더 붙인다.**
     *   옛 키의 해시를 갈아 끼우는 쪽이 깔끔해 보이지만, 한 사람이 키를 여러 개 쓰고
     *   그 키들이 같은 넥슨 계정을 함께 볼 수 있다(실측: 한 키가 12개 계정을 본다).
     *   그때 덮어쓰면 **아직 살아 있는 다른 키를 죽인다.** 붙이는 쪽은 되돌릴 수 있고,
     *   못 쓰게 된 옛 키는 설정 화면에서 지우면 된다.
     * ★ `makePrimary` 도 복구일 때는 **false** 다. primary 는 본캐를 가진 키를 뜻하는데
     *   (§2.1) 어느 쪽이 그건지 여기서 알 방법이 없다. 모르면 건드리지 않는다.
     */
    credentialId = await attachCredential(db, {
      userId,
      apiKeyHash,
      label: input.label,
      makePrimary: recoveredUserId === null,
    });
  } else {
    credentialId = existing.credential_id;
    const { error } = await db
      .from("user_credentials")
      .update({
        // 키가 다시 통과했으므로 무효화 표시를 푼다(§난제 11-3: 캐릭터는 지우지 않는다).
        invalidated_at: null,
        last_validated_at: new Date().toISOString(),
        ...(input.label !== null ? { label: input.label } : {}),
      })
      .eq("id", credentialId);
    if (error !== null) throw error;
  }

  /*
   * ★ **원문 키를 암호화해 보관한다** (§2.1.2).
   *
   *   바로 위에서 `/character/list` 가 200 으로 답했으므로 이 키는 **지금 유효하다.**
   *   그 확인 뒤에만 저장하는 것이 규칙이다 — 무효한 키를 넣어 두면 다음 진입부터
   *   "서버에 키는 있는데 동기화만 실패"라는, 사용자가 원인을 알 수 없는 상태가 된다.
   *
   *   이 한 줄이 없으면 새 브라우저에서 이 계정의 캐릭터가 영원히 동기화되지 않는다.
   *   마스터키 설정 오류는 **던진다** — 조용히 건너뛰면 저장된 줄 알고 넘어간다.
   */
  await storeCredentialApiKey(db, credentialId, apiKey);

  // 가입 순서 때문에 장부에 못 적었던 호출을 이제 흘려보낸다.
  for (const outcome of unattributedCalls) {
    await recordNexonCall(db, credentialId, outcome);
  }

  const accountRefs = await syncCredentialInventory(db, {
    userId,
    credentialId,
    list,
  });

  if (isNewAccount) {
    await assignMainCharacter(db, userId, list.characters);
  }

  const { error: loginStampError } = await db
    .from("app_users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", userId);
  if (loginStampError !== null) throw loginStampError;

  const user = await loadSessionUser(db, userId);
  if (user === null) throw ApiError.accountUnavailable();

  return {
    user,
    credentialId,
    isNewAccount,
    characters: await loadCredentialCharacters(db, userId, accountRefs),
  };
}

/**
 * 로그인한 사람에게 **부계정 키**를 붙인다.
 *
 * 이 경로만 세션을 요구한다. 로그인은 세션 없이 되지만 키 추가는 안 된다 —
 * "이 키를 이 사람에게 붙인다"는 주장이 세션 없이는 성립하지 않기 때문이다(§2.1).
 */
export async function addCredentialToUser(
  db: AdminDb,
  input: {
    readonly userId: string;
    readonly apiKey: string;
    readonly label: string | null;
  },
): Promise<{
  readonly user: SessionUser;
  readonly credentialId: string;
  readonly characters: readonly LoginCharacter[];
}> {
  const apiKey = normalizeApiKey(input.apiKey);
  const apiKeyHash = hashApiKey(apiKey);

  const { data: owner, error: ownerError } = await db
    .from("user_credentials")
    .select("id, user_id")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();
  if (ownerError !== null) throw ownerError;

  // DB 함수도 막지만, 여기서 먼저 걸러야 사용자에게 쓸 만한 문구를 줄 수 있다.
  if (owner !== null && owner.user_id !== input.userId) {
    throw ApiError.keyOwnedByOtherAccount();
  }

  const { list, unattributedCalls } = await validateApiKey(
    db,
    apiKey,
    apiKeyHash,
    owner?.id ?? null,
  );

  const credentialId = await attachCredential(db, {
    userId: input.userId,
    apiKeyHash,
    label: input.label,
    makePrimary: false,
  });

  /*
   * ★ 부계정 키야말로 서버 보관의 이유다 (§2.1.2).
   *
   *   실계정에서 새 브라우저로 로그인하면 자격증명 3건(`주 계정`/`바이트`/`콜라`)과
   *   캐릭터 304명이 전부 보이는데도 부계정 두 곳은 하나도 동기화되지 않았다 —
   *   보낼 키가 그 기기에 없었기 때문이다. 이 줄이 그 구멍을 메운다.
   *   위 `validateApiKey` 가 방금 넥슨에게 유효성을 확인받았으므로 저장해도 안전하다.
   */
  await storeCredentialApiKey(db, credentialId, apiKey);

  for (const outcome of unattributedCalls) {
    await recordNexonCall(db, credentialId, outcome);
  }

  const accountRefs = await syncCredentialInventory(db, {
    userId: input.userId,
    credentialId,
    list,
  });

  const user = await loadSessionUser(db, input.userId);
  if (user === null) throw ApiError.accountUnavailable();

  return {
    user,
    credentialId,
    characters: await loadCredentialCharacters(
      db,
      input.userId,
      accountRefs,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 키 삭제
// ─────────────────────────────────────────────────────────────────────────────

/** 승격 후보를 고르는 데 필요한 최소 컬럼. */
interface CredentialRankRow {
  readonly id: string;
  readonly is_primary: boolean;
  readonly invalidated_at: string | null;
  readonly last_validated_at: string | null;
  readonly created_at: string;
}

const CREDENTIAL_RANK_COLUMNS =
  "id, is_primary, invalidated_at, last_validated_at, created_at";

export interface DeleteCredentialResult {
  readonly user: SessionUser;
  readonly deletedCredentialId: string;
  readonly promotedCredentialId: string | null;
}

/**
 * 등록된 키 1개를 지운다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 무엇이 사라지고 무엇이 남는가 — 이 구분이 이 함수의 전부다
 * ─────────────────────────────────────────────────────────────────────────────
 * **사라진다** (행 삭제 + FK `on delete cascade`):
 *   - `user_credentials` 행 자체 → `api_key_hash`·`encrypted_api_key`·`encryption_key_id`
 *     ·`consent_at` 이 **같은 행**이므로 서버에 보관된 암호문도 함께 사라진다(§2.1.2).
 *     별도 삭제문이 필요 없다.
 *   - `credential_nexon_accounts` 링크 행 (키 ↔ 넥슨 계정)
 *   - `nexon_api_quota_usage` 그 키의 호출량 장부
 *
 * **남는다**:
 *   - `user_nexon_accounts` — 넥슨 계정 자체. 캐릭터가 가리키는 것이 이쪽이다.
 *   - `characters` 전부. 그래서 **클리어·수익·파티 이력이 하나도 날아가지 않는다.**
 *     그 계정에 유효한 키가 없어지면 트리거(`refresh_character_sync_state`)가
 *     `sync_state` 를 `no_valid_key` 로 내릴 뿐이고, 읽기는 계속 된다.
 *   - 그래서 **같은 키를 다시 등록하면 원래대로 돌아온다** — 링크가 다시 생기고
 *     트리거가 `syncable` 로 되돌린다. 화면은 이 사실을 사용자에게 말해야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 마지막 남은 키는 거부한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인이 `sha256(키)` 한 경로뿐이라(§2.1) 키를 전부 지우면 **다시 들어갈 문이
 * 없어진다.** 데이터는 전부 남아 있는데 접근만 불가능해지는, 사용자가 스스로 복구할 수
 * 없는 상태다. 그래서 여기서 막는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 트랜잭션이 없다 — 그래서 **삭제 → 승격** 순서다
 * ─────────────────────────────────────────────────────────────────────────────
 * PostgREST 를 통해서는 두 문장을 한 트랜잭션에 묶을 수 없다(묶으려면 DB 함수가
 * 필요한데 이번 작업에 마이그레이션을 넣지 않는다). 순서를 뒤집어 먼저 승격하면
 * `user_credentials_one_primary_per_user` 부분 유니크 인덱스에 걸려 **삭제 전에
 * 실패**한다. 그래서 지우고 나서 올린다.
 *
 * 그 사이에서 실패하면 최악의 결과는 "주 키가 없는 상태"인데, §2.1 상 주 키는 **표시
 * 정체성의 출처일 뿐 로그인 자격과 무관**하므로 로그인·동기화 어느 것도 막히지 않는다.
 * 게다가 본캐를 다시 지정하면 트리거(`characters_sync_main_identity`)가 주 키를 알아서
 * 되돌려 놓는다. 반대 순서의 실패("키는 남았는데 삭제가 안 됨")보다 훨씬 가볍다.
 */
export async function deleteCredentialFromUser(
  db: AdminDb,
  input: { readonly userId: string; readonly credentialId: string },
): Promise<DeleteCredentialResult> {
  /*
   * 소유 판정과 "마지막 키인가" 판정을 **한 번의 왕복**으로 함께 한다.
   * `user_id` 로 좁혀 읽으므로 남의 키는 애초에 결과에 없고, 그래서 404 로 접힌다.
   */
  const { data: rows, error } = await db
    .from("user_credentials")
    .select(CREDENTIAL_RANK_COLUMNS)
    .eq("user_id", input.userId);

  if (error !== null) throw error;

  const all: readonly CredentialRankRow[] = rows ?? [];
  const target = all.find((row) => row.id === input.credentialId) ?? null;
  // 없는 키와 남의 키를 같은 답으로 접는다(존재 여부가 새어 나가지 않게).
  if (target === null) throw ApiError.credentialNotFound();
  if (all.length <= 1) throw ApiError.lastCredential();

  const { data: deleted, error: deleteError } = await db
    .from("user_credentials")
    .delete()
    // ★ `user_id` 조건을 여기서도 반복한다. 위 확인과 이 문장 사이에 다른 요청이
    //   끼어들 수 있으므로, 실제로 지우는 문장 자체가 소유를 다시 못박아야 한다.
    .eq("id", input.credentialId)
    .eq("user_id", input.userId)
    .select("id");

  if (deleteError !== null) throw deleteError;
  // 동시에 두 번 눌린 경우. 이미 없어졌다는 뜻이므로 404 가 정확하다.
  if ((deleted ?? []).length === 0) throw ApiError.credentialNotFound();

  const remaining = all.filter((row) => row.id !== input.credentialId);
  /*
   * 주 키를 지웠으면 승격한다. 지운 것이 주 키가 아니어도 **남은 키에 주 키가 하나도
   * 없으면** 함께 고친다 — 과거 데이터 드리프트로 그런 상태가 되어 있을 수 있고,
   * 그 상태를 그대로 두면 목록에 "주 키" 배지가 영원히 없다.
   */
  const needsPromotion =
    target.is_primary || !remaining.some((row) => row.is_primary);

  const promotedCredentialId = needsPromotion
    ? await promotePrimaryCredential(db, input.userId, remaining)
    : null;

  const user = await loadSessionUser(db, input.userId);
  if (user === null) throw ApiError.accountUnavailable();

  return {
    user,
    deletedCredentialId: input.credentialId,
    promotedCredentialId,
  };
}

/**
 * 남은 키 중 하나를 주 키로 올린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 선정 기준 — 위에서부터 순서대로 (근거)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **본캐가 속한 넥슨 계정의 키.** §2.1 이 주 키를 "본캐가 속한 계정의 키"로
 *    정의하므로, 그 정의를 만족하는 후보가 있으면 다른 기준을 볼 이유가 없다.
 *    DB 트리거 `characters_sync_main_identity` 가 본캐 변경 시 고르는 것과 **같은
 *    기준**이다 — 두 경로가 다른 답을 내면 본캐를 한 번 바꾸는 것만으로 주 키가
 *    튀어 오른다.
 * 2. **무효화되지 않은 키.** 무효화된 키를 정체성의 출처로 삼을 이유가 없다.
 * 3. **최근에 검증된 키** (`last_validated_at` 내림차순, 없는 값은 뒤로).
 *    같은 이유로 트리거·`pickServerUsableCredential` 과 정렬이 일치한다.
 * 4. **먼저 등록된 키** (`created_at` 오름차순), 마지막으로 `id` — **결정론**을 위해서다.
 *    같은 입력에 매번 다른 키가 뽑히면 사용자는 "주 키" 배지가 이유 없이 옮겨 다니는
 *    것을 보게 된다.
 *
 * @returns 승격된 키 id. 올릴 대상이 없으면 `null`.
 */
async function promotePrimaryCredential(
  db: AdminDb,
  userId: string,
  remaining: readonly CredentialRankRow[],
): Promise<string | null> {
  if (remaining.length === 0) return null;

  // 본캐가 속한 넥슨 계정. `characters_one_main_per_user` 부분 유니크라 최대 1행이다.
  const { data: mainRow, error: mainError } = await db
    .from("characters")
    .select("nexon_account_ref")
    .eq("user_id", userId)
    .eq("is_main", true)
    .maybeSingle();

  if (mainError !== null) throw mainError;
  const mainAccountRef = mainRow?.nexon_account_ref ?? null;

  const mainAccountCredentials = new Set<string>();
  if (mainAccountRef !== null) {
    const { data: links, error: linkError } = await db
      .from("credential_nexon_accounts")
      .select("credential_id")
      .eq("nexon_account_ref", mainAccountRef)
      .in(
        "credential_id",
        remaining.map((row) => row.id),
      );
    if (linkError !== null) throw linkError;
    for (const row of links ?? []) mainAccountCredentials.add(row.credential_id);
  }

  const rank = (row: CredentialRankRow): readonly [number, number, string] => [
    mainAccountCredentials.has(row.id) ? 0 : 1,
    row.invalidated_at === null ? 0 : 1,
    // 문자열 비교로 최신이 앞에 오도록 뒤집는다. ISO-8601 은 사전순 = 시간순이다.
    row.last_validated_at ?? "",
  ];

  const winner = [...remaining].sort((a, b) => {
    const [aMain, aValid, aSeen] = rank(a);
    const [bMain, bValid, bSeen] = rank(b);
    if (aMain !== bMain) return aMain - bMain;
    if (aValid !== bValid) return aValid - bValid;
    // 최근 검증이 앞으로. 빈 문자열("검증 이력 없음")은 자연히 뒤로 밀린다.
    if (aSeen !== bSeen) return aSeen < bSeen ? 1 : -1;
    if (a.created_at !== b.created_at)
      return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0];

  const { error: updateError } = await db
    .from("user_credentials")
    .update({ is_primary: true })
    .eq("id", winner.id)
    .eq("user_id", userId);

  if (updateError !== null) throw updateError;
  return winner.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

async function createUser(
  db: AdminDb,
  characters: readonly NexonCharacterSummary[],
): Promise<string> {
  const headline = pickHeadlineCharacter(characters);
  const displayName = (headline?.characterName ?? FALLBACK_DISPLAY_NAME).slice(
    0,
    DISPLAY_NAME_MAX,
  );

  const { data, error } = await db
    .from("app_users")
    .insert({ display_name: displayName })
    .select("id")
    .single();

  if (error !== null) throw error;
  return data.id;
}

async function attachCredential(
  db: AdminDb,
  input: {
    readonly userId: string;
    readonly apiKeyHash: string;
    readonly label: string | null;
    readonly makePrimary: boolean;
  },
): Promise<string> {
  const { data, error } = await db.rpc("attach_nexon_credential", {
    p_user_id: input.userId,
    p_api_key_hash: input.apiKeyHash,
    ...(input.label !== null ? { p_label: input.label } : {}),
    p_make_primary: input.makePrimary,
  });

  if (error !== null) {
    // 함수가 `unique_violation` 으로 던지는 유일한 경우 = 남의 계정에 묶인 키.
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw ApiError.keyOwnedByOtherAccount();
    }
    throw error;
  }

  return data;
}

/**
 * 최초 가입자의 본캐를 정한다 — **레벨이 가장 높은 캐릭터**.
 *
 * 확정이 아니라 **기본값**이다. 표시 정체성이 본캐 닉네임이라(§2.1) 계정이 만들어지는
 * 순간 이름 없는 상태로 둘 수 없고, 그렇다고 사용자에게 먼저 물으면 가입이 두 단계가 된다.
 * 캐릭터 선택 모달에서 언제든 바꿀 수 있다.
 *
 * `characters.is_main` 을 켜면 트리거가 `app_users` 의 본캐 스냅샷과 주 키를 함께 옮긴다
 * (DB-SCHEMA 난제 11-5). 그래서 여기서는 스냅샷을 직접 쓰지 않는다.
 */
async function assignMainCharacter(
  db: AdminDb,
  userId: string,
  characters: readonly NexonCharacterSummary[],
): Promise<void> {
  const headline = pickHeadlineCharacter(characters);
  if (headline === null) return;

  const { data, error } = await db
    .from("characters")
    .select("id")
    .eq("user_id", userId)
    .eq("ocid", headline.ocid)
    .maybeSingle();

  if (error !== null) throw error;
  if (data === null) return;

  const { error: updateError } = await db
    .from("characters")
    .update({ is_main: true })
    .eq("id", data.id);
  if (updateError !== null) throw updateError;
}
