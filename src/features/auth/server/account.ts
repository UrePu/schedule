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
 * - **원문 키는 DB 에 저장하지 않는다.** 이 파일 어디에도 `apiKey` 를 쓰는 INSERT 가 없다.
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
  const { data: user, error: userError } = await db
    .from("app_users")
    .select(
      "id, display_name, main_character_name, main_world_name, status, deleted_at",
    )
    .eq("id", userId)
    .maybeSingle();

  if (userError !== null) throw userError;
  if (user === null || user.deleted_at !== null) return null;

  const { data: credentialRows, error: credentialError } = await db
    .from("user_credentials")
    .select("id, label, is_primary, invalidated_at, last_validated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (credentialError !== null) throw credentialError;

  const { data: characterRows, error: characterError } = await db
    .from("characters")
    .select("id, is_tracked, nexon_account_ref")
    .eq("user_id", userId);

  if (characterError !== null) throw characterError;

  const characters = characterRows ?? [];

  /*
   * 키별 "연결된 넥슨 계정 수 / 캐릭터 수".
   *
   * `characters` 는 **키가 아니라 계정**을 가리킨다(키 재발급이 캐릭터를 고아로 만들지
   * 않게 하려고 그렇게 설계했다 — R2-F). 그래서 키 → 계정(`credential_nexon_accounts`)
   * → 캐릭터(`characters.nexon_account_ref`) 두 단계를 거친다.
   * 왕복은 **키 개수와 무관하게 1회**다 — 사용자당 키가 여러 개여도 한 번에 읽는다.
   */
  const credentialIds = (credentialRows ?? []).map((row) => row.id);
  const { data: linkRows, error: linkError } =
    credentialIds.length === 0
      ? { data: [], error: null }
      : await db
          .from("credential_nexon_accounts")
          .select("credential_id, nexon_account_ref")
          .in("credential_id", credentialIds);

  if (linkError !== null) throw linkError;

  const charactersPerAccount = new Map<string, number>();
  for (const row of characters) {
    if (row.nexon_account_ref === null) continue;
    charactersPerAccount.set(
      row.nexon_account_ref,
      (charactersPerAccount.get(row.nexon_account_ref) ?? 0) + 1,
    );
  }

  const accountsPerCredential = new Map<string, string[]>();
  for (const row of linkRows ?? []) {
    const list = accountsPerCredential.get(row.credential_id) ?? [];
    list.push(row.nexon_account_ref);
    accountsPerCredential.set(row.credential_id, list);
  }

  const credentials: CredentialSummary[] = (credentialRows ?? []).map((row) => {
    const accountRefs = accountsPerCredential.get(row.id) ?? [];
    return {
      id: row.id,
      label: row.label,
      isPrimary: row.is_primary,
      isInvalidated: row.invalidated_at !== null,
      lastValidatedAt: row.last_validated_at,
      nexonAccountCount: accountRefs.length,
      characterCount: accountRefs.reduce(
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

  const userId =
    existing?.user_id ?? (await createUser(db, list.characters));
  const isNewAccount = existing === null;

  let credentialId: string;
  if (existing === null) {
    credentialId = await attachCredential(db, {
      userId,
      apiKeyHash,
      label: input.label,
      makePrimary: true,
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
