import "server-only";

import { buildServerNexonContext } from "@/features/auth/server/nexon-proxy";
import type { NexonProxyContext } from "@/features/auth/server/nexon-proxy";
import {
  fetchCharacterBasic,
  fetchCharacterOcidByName,
  isInvalidOcidError,
} from "@/lib/nexon/client";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이름만으로 생김새 찾기 — **ocid 가 없는 사람의 얼굴**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-03): *"각각 다른사람 api를 사용하지말고. 내 api 로 파티원들의 이미지를
 * 가져오는식으로 ocid 가져오려고 하지말고 캐릭터 생긴거만 검색하는방법을 가져와"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 형제 파일과의 경계 — **입구가 무엇이냐로 갈린다**
 * ─────────────────────────────────────────────────────────────────────────────
 *   `portrait-backfill.ts`  → **ocid 를 이미 아는 캐릭터.** 우리 DB 의 `characters` 행이
 *                              대상이고, 결과는 `characters.image_url` 에 적힌다.
 *   **이 파일**              → **화면이 `characters` 행에 닿을 수 없는 참가자.** 파티
 *                              게스트가 대상이고, 결과는 `character_looks` 에 적힌다.
 *
 * ⚠️ 경계는 **이름**이 아니라 **참가자**로 긋는다(2026-09-03 정정 — `backfillGuestPortraits`
 *    머리말). 같은 이름의 `characters` 행이 우리 DB 에 있어도 그 행이 **남의 것**이면
 *    게스트의 얼굴 자리는 그 행에 닿지 못하고, 형제 파일이 아무리 채워도 실루엣으로 남는다.
 *
 * 둘은 같은 화면(파티 고르기)의 같은 얼굴 자리를 채우지만 섞으면 안 된다 — 전자는
 * 캐릭터 1콜, 후자는 이름 **2콜**(`/id` + `/character/basic`)이고, 후자에만 **"지금 이
 * 이름으로는 캐릭터를 볼 수 없다"**(이름 없음 · 죽은 ocid)는 정상 결과가 존재한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이름만으로 되는가 — 2026-09-03 실측
 * ─────────────────────────────────────────────────────────────────────────────
 * `GET /maplestory/v1/id?character_name=<이름>` 에는 **소유권 검사가 없다.** 우리 키 하나로
 * 남의 캐릭터 ocid 가 나오고, 그 ocid 로 `/character/basic` 이 200 을 준다. 월드를 넘기지
 * 않았는데 제니스·오로라가 각각 나왔다 — `/id` 는 전 월드를 훑고 KMS 캐릭터명은 전역
 * 고유라, **월드를 물어볼 필요가 없다.**
 *
 * §1.1 의 *"자신의 계정에 속한 캐릭터만 조회가 가능합니다"* 는 **스케줄러**에 걸린 문장이지
 * 이 두 경로에 걸린 문장이 아니다(2026-09-02 정정과 같은 근거).
 *
 * ★ 그래서 **키는 아무 것이나 하나면 된다.** "그 사람의 키"를 찾을 필요가 없고, 애초에
 *   게스트는 우리 쪽에 키가 없다. 키를 서버가 쓸 수 있는지의 판정은
 *   `buildServerNexonContext` 가 갖는다 — 여기서 다시 만들지 않는다.
 * ★ **같은 키로는 직렬 + 250ms**, 키가 여럿이면 키끼리 병렬(`portrait-backfill` 과 같은
 *   규칙). 간격 없이 연속으로 부르면 429 가 난다(개발 키 초당 5, 실측).
 * ★ 한 이름의 실패가 나머지를 막지 않는다.
 */

/** 같은 키로 나가는 호출 사이의 최소 간격. 개발 키 초당 5콜 → 250ms(초당 4콜). */
const KEY_INTERVAL_MS = 250;

/**
 * 양성 캐시 TTL — **7일.**
 *
 * ⚠️ §1.1 의 **15분은 스케줄러 데이터 규칙이지 초상화 규칙이 아니다.** 그쪽은 "이 캐릭터가
 *    오늘 무엇을 깼는가"라서 시간이 지나면 실제로 값이 변한다. 여기서 담는 것은 초상화 ·
 *    월드 · 직업 · 레벨이고, 이것들은 **본인이 치장을 바꾸거나 렙업할 때만** 변한다.
 *
 * 7일로 잡은 근거는 비용이다. 이름 하나 갱신에 **2콜**이 들고 개발 키는 하루 1,000콜이다
 * (§1.0). TTL 을 하루로 두면 게스트 30명짜리 저장소가 매일 60콜을 고정으로 쓰는데, 그 대가로
 * 얻는 것은 "일주일 전 레벨" 대신 "어제 레벨"뿐이다. 얼굴 타일에 그 차이는 보이지 않는다.
 */
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 음성 캐시 재시도 주기 — **7일.**
 *
 * ★ **이것이 이 모듈의 핵심 방어선이다.** "이 이름으로는 지금 캐릭터를 볼 수 없다"에는
 *   **원인이 둘** 있고, 둘 다 넥슨의 **정상 응답**이다(2026-09-03 실측):
 *     ① **그런 이름 없음** — `/id` 가 400 `OPENAPI00004`. 사람이 별명("동생", "형")을
 *        적었을 때 나온다.
 *     ② **죽은 ocid** — `/id` 는 **200** 인데 그 ocid 로 부른 `/character/basic` 이 400
 *        `OPENAPI00003`. 이름 검색은 살아 있지만 캐릭터는 볼 수 없는 상태다(삭제·이관).
 *   게이트웨이 캐시(`lib/nexon/gateway.ts`)는 **성공 응답만** 담으므로 둘 다 하나도
 *   막아 주지 못한다. 음성 캐시가 없으면 그 이름 하나가 **화면을 열 때마다 2콜씩 영원히**
 *   나간다.
 * ★ 그렇다고 영구히 포기하지도 않는다. 사람이 파티원 이름을 고칠 수 있고, 캐릭터명은
 *   실제로 바뀔 수 있다(닉네임 변경권). 7일이면 "고쳤는데 일주일째 실루엣"이 되지 않으면서
 *   오타 하나가 태우는 호출량은 연 100콜 아래로 묶인다.
 */
const NEGATIVE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 한 번에 넥슨에 물을 수 있는 최대 이름 수.
 *
 * 이름당 2콜이라 `portrait-backfill` 의 60보다 낮게 잡는다 — 40이면 80콜, 하루 예산의 8%다.
 * 남은 것은 `remaining` 이 말해 주므로 더 필요하면 한 번 더 부르면 된다.
 */
const DEFAULT_LIMIT = 40;

/**
 * 화면 렌더 경로(`lookupCharacterLooksByName`)가 한 번에 새로 부를 수 있는 최대 이름 수.
 *
 * 크론보다 훨씬 작다. 이 자리는 **사람이 기다리는 자리**이고, 20개면 이미
 * 20 × 2콜 × 250ms = 10초다. 여기서 못 채운 이름은 실루엣으로 그려지고 크론이 마저 채운다.
 */
const RENDER_PATH_LIMIT = 20;

/** 캐릭터명 제약(`character_looks.character_name`, `guest_profiles.display_name`)과 같은 값. */
const MAX_NAME_LENGTH = 40;

/** 한 번의 훑기에서 쓸 키의 최대 개수. 키끼리는 병렬이라 이 값이 곧 동시 실행 폭이다. */
const MAX_CONTEXTS = 4;

/** 이름 하나의 생김새. `character_looks` 한 행을 화면이 쓰는 모양으로 접은 것. */
export interface CharacterLook {
  /** btrim 된 캐릭터명. 조회에 쓴 키 그대로다. */
  readonly characterName: string;
  readonly worldName: string | null;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
  /** ★ `null` 은 **정상 상태**다(§2.1.1). 화면은 실루엣을 그린다. */
  readonly imageUrl: string | null;
  /**
   * 넥슨이 **이 이름으로는 캐릭터를 보여 주지 못했다.** 원인은 둘이고 화면에서는 같다:
   * 그런 이름이 없거나(`/id` 400 `OPENAPI00004`), 이름은 찾히는데 그 ocid 가 죽었거나
   * (`/character/basic` 400 `OPENAPI00003`).
   *
   * **오류가 아니다.** 둘 다 넥슨이 정상적으로 답해 준 사실이며, 화면은 이때도 실루엣과
   * 이름만 그린다. 다시 부를 이유가 없다는 신호다.
   */
  readonly missing: boolean;
}

export interface GuestPortraitBackfillSummary {
  /** 채워야 할 이름 수(이번 실행 전 기준). */
  readonly pending: number;
  /** 실제로 넥슨에 물어본 이름 수. **호출 수가 아니다** — 이름 하나가 최대 2콜이다. */
  readonly attempted: number;
  /** 초상화를 받아 저장한 수. */
  readonly filled: number;
  /**
   * 얼굴을 못 그리게 됐지만 **오류가 아닌** 수. 셋을 함께 센다:
   * 찾았는데 초상화가 없음 · 그런 이름 없음(`OPENAPI00004`) · 죽은 ocid(`OPENAPI00003`).
   * 셋 다 `character_looks` 에 행이 남았으므로 **다음 훑기가 다시 부르지 않는다.**
   */
  readonly noImage: number;
  /**
   * 호출이 **실패한** 수(무효 키·할당량·점검·네트워크·DB 쓰기 실패).
   *
   * ⚠️ 여기 세어진 이름은 캐시에 아무것도 안 적혔으므로 **다음 훑기가 다시 부른다.**
   *    그래서 "볼 수 없다"가 확정된 경우를 이쪽에 넣으면 안 된다 — 그게 영원한 재시도다.
   */
  readonly failed: number;
  /** 상한에 걸려 이번에 못 부른 수. */
  readonly remaining: number;
  readonly elapsedMs: number;
}

/**
 * `character_looks` 에서 읽는 칸.
 *
 * `ocid` 는 **읽지 않는다.** 화면이 쓰지 않고, 갱신할 때는 어차피 `/id` 를 다시 부르기
 * 때문이다(이름이 그대로여도 ocid 는 바뀔 수 있다 — §1.1). 저장만 해 두고 읽지 않는 값이다.
 */
const LOOK_COLUMNS =
  "character_name,world_name,character_class,character_level,image_url,fetched_at,missing_at";

interface LookRow {
  readonly character_name: string;
  readonly world_name: string | null;
  readonly character_class: string | null;
  readonly character_level: number | null;
  readonly image_url: string | null;
  readonly fetched_at: string | null;
  readonly missing_at: string | null;
}

interface FetchCounts {
  attempted: number;
  filled: number;
  noImage: number;
  failed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toLook(row: LookRow): CharacterLook {
  return {
    characterName: row.character_name,
    worldName: row.world_name,
    characterClass: row.character_class,
    characterLevel: row.character_level,
    imageUrl: row.image_url,
    // 찾은 적이 있으면 그쪽이 진실이다. `missing_at` 은 그보다 오래된 기록일 수 있다.
    missing: row.fetched_at === null && row.missing_at !== null,
  };
}

/**
 * 다듬은 이름. 빈 문자열과 제약을 넘는 길이는 **여기서 버린다.**
 *
 * DB 가 `character_name = btrim(character_name)` 과 1~40자를 CHECK 로 못박고 있으므로,
 * 정규화하지 않고 넘기면 upsert 가 통째로 실패한다. 그리고 넥슨도 40자를 넘는 이름을
 * 찾아 줄 리 없다 — 부르기 전에 거르는 편이 1콜 싸다.
 */
function normalizeNames(names: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) continue;
    out.add(trimmed);
  }
  return [...out];
}

/** 이 행을 다시 물어봐야 하는가. */
function isStale(row: LookRow, now: number): boolean {
  if (row.fetched_at !== null) {
    return now - Date.parse(row.fetched_at) > POSITIVE_TTL_MS;
  }
  if (row.missing_at !== null) {
    return now - Date.parse(row.missing_at) > NEGATIVE_RETRY_MS;
  }
  // CHECK 제약상 도달할 수 없다. 도달했다면 아는 것이 없다는 뜻이므로 물어본다.
  return true;
}

async function readLooks(
  db: AdminDb,
  names: readonly string[],
): Promise<Map<string, LookRow>> {
  const byName = new Map<string, LookRow>();
  if (names.length === 0) return byName;

  const { data, error } = await db
    .from("character_looks")
    .select(LOOK_COLUMNS)
    .in("character_name", [...names]);
  if (error !== null) {
    throw new Error(`생김새 캐시 조회 실패: ${error.message}`);
  }
  for (const row of data ?? []) byName.set(row.character_name, row);
  return byName;
}

/**
 * 서버가 대신 쓸 수 있는 키 컨텍스트를 최대 `MAX_CONTEXTS` 개 연다.
 *
 * ★ **누구의 키인지는 상관없다.** 이 조회는 소유권과 무관하므로(머리말) "그 캐릭터
 *   주인의 키"를 고르는 절차 자체가 없다. 여러 개를 여는 이유는 권한이 아니라 **속도**다 —
 *   초당 한도는 키마다 따로 걸리므로 키가 둘이면 250ms 간격을 둘이 나눠 진다.
 * ★ 순서는 **결정론적**이어야 한다. 매번 다른 키가 뽑히면 게이트웨이 캐시 키
 *   (`apiKeyHash` 기반)가 흔들려 같은 응답을 다시 받아 온다.
 */
async function openContexts(db: AdminDb): Promise<readonly NexonProxyContext[]> {
  const { data, error } = await db
    .from("user_credentials")
    .select("id,user_id")
    .is("invalidated_at", null)
    .eq("allow_server_side_use", true)
    .order("is_primary", { ascending: false })
    .order("last_validated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(MAX_CONTEXTS * 3);
  if (error !== null) {
    throw new Error(`서버 사용 가능 키 조회 실패: ${error.message}`);
  }

  const contexts: NexonProxyContext[] = [];
  for (const row of data ?? []) {
    if (contexts.length >= MAX_CONTEXTS) break;
    // 복호화까지 해 봐야 실제로 쓸 수 있는지 안다. 못 열리는 키는 조용히 건너뛴다.
    const context = await buildServerNexonContext({
      db,
      userId: row.user_id,
      credentialId: row.id,
    });
    if (context !== null) contexts.push(context);
  }
  return contexts;
}

/**
 * **"이 이름으로는 지금 캐릭터를 볼 수 없다"를 적는다.**
 *
 * ★ **아무것도 적지 않고 지나가면 안 된다.** 그러면 다음 화면에서 또 2콜이 나간다 —
 *   그 반복을 끊는 것이 이 표의 존재 이유의 절반이다(마이그레이션 머리말).
 * ★ `fetched_at` 을 **null 로 덮는다.** 예전에 찾았던 이름이 지금은 안 보인다면(닉네임
 *   변경 · 캐릭터 삭제) 옛 얼굴을 계속 보여 주는 것이 아니라 모른다고 말해야 맞다.
 * ★ `ocid` 도 **null 로 덮는다.** 죽은 ocid 를 남겨 두면 다음 갱신이 그걸로 `/id` 1콜을
 *   아끼려 들 수 있는데, 그건 이미 400 을 받은 값이다.
 */
async function storeMissing(
  db: AdminDb,
  characterName: string,
): Promise<LookRow | null> {
  const row: LookRow = {
    character_name: characterName,
    world_name: null,
    character_class: null,
    character_level: null,
    image_url: null,
    fetched_at: null,
    missing_at: new Date().toISOString(),
  };
  const { error } = await db
    .from("character_looks")
    .upsert({ ...row, ocid: null }, { onConflict: "character_name" });
  return error === null ? row : null;
}

/**
 * 이름 하나 → 넥슨 2콜 → `character_looks` 한 행.
 *
 * 돌려주는 값은 저장까지 끝난 행이고, 저장에 실패하면 `null` 이다(호출부가 `failed` 로 센다).
 */
async function fetchAndStoreOne(
  db: AdminDb,
  context: NexonProxyContext,
  characterName: string,
): Promise<LookRow | null> {
  const ocid = await fetchCharacterOcidByName(
    context.apiKey,
    characterName,
    context.gateway,
  );

  // ① 그런 이름이 없다(`/id` 400 `OPENAPI00004`). 정상 응답이므로 그대로 적는다.
  if (ocid === null) return storeMissing(db, characterName);

  /*
    ② **`/id` 는 200 인데 `/character/basic` 이 400 `OPENAPI00003` 인 ocid 가 있다.**
       지휘 측 실측(2026-09-03, 실제 호출):

         GET /id?character_name=구해야됨            → 200 {"ocid":"2690b2ff8dc65197…"}
         GET /character/basic?ocid=2690b2ff8dc65197… → 400 OPENAPI00003

       캐릭터 삭제·이관 등으로 죽은 ocid 로 보인다(§1.0 의 "bad ocid → OPENAPI00003" 과
       일치). 이것은 **실패가 아니라 "지금은 이 캐릭터를 볼 수 없다"** 이므로 ① 과 똑같이
       `missing_at` 을 적는다. 예전에는 이 경우를 `failed` 로만 세고 행을 하나도 쓰지
       않아서, 그 이름이 크론이 돌 때마다 · 모달을 열 때마다 2콜씩 영원히 다시 나갔다.

    ⚠️ **`OPENAPI00003` 만** 그렇게 접는다. 무효 키(`OPENAPI00005`) · 할당량
       (`OPENAPI00007`) · 점검 · 네트워크 오류는 **던져서 `failed` 로 남긴다** — 그것들은
       "이 캐릭터를 볼 수 없다"가 아니라 "지금 우리가 부를 수 없다"이고, 음성 캐시에 박으면
       키가 잠깐 막힌 사이에 멀쩡한 캐릭터가 7일간 실루엣이 된다.
       판별은 `lib/nexon/client.ts` 의 `isInvalidOcidError` 하나가 갖는다.
  */
  let basic: Awaited<ReturnType<typeof fetchCharacterBasic>>;
  try {
    basic = await fetchCharacterBasic(context.apiKey, ocid, context.gateway);
  } catch (error) {
    if (isInvalidOcidError(error)) return storeMissing(db, characterName);
    throw error;
  }

  const row: LookRow = {
    character_name: characterName,
    world_name: basic.worldName,
    character_class: basic.characterClass,
    character_level: basic.characterLevel,
    image_url: basic.imageUrl,
    fetched_at: new Date().toISOString(),
    // 찾았으므로 "없음" 기록은 지운다. 남겨 두면 두 사실이 동시에 참인 행이 된다.
    missing_at: null,
  };
  const { error } = await db
    .from("character_looks")
    .upsert({ ...row, ocid }, { onConflict: "character_name" });
  return error === null ? row : null;
}

/**
 * 이름 묶음을 넥슨에 물어 캐시에 적는다. **키별 직렬 + 250ms, 키끼리 병렬.**
 *
 * 돌려주는 맵에는 이번에 성공한 것만 담긴다 — 실패한 이름은 캐시에 아무것도 적히지
 * 않았으므로 다음 실행이 다시 시도한다.
 */
async function fetchAndStore(
  db: AdminDb,
  names: readonly string[],
): Promise<{ readonly rows: Map<string, LookRow>; readonly counts: FetchCounts }> {
  const rows = new Map<string, LookRow>();
  const counts: FetchCounts = {
    attempted: names.length,
    filled: 0,
    noImage: 0,
    failed: 0,
  };
  if (names.length === 0) return { rows, counts };

  const contexts = await openContexts(db);
  if (contexts.length === 0) {
    // 서버가 쓸 수 있는 키가 저장소에 하나도 없다. 부를 방법 자체가 없는 상태다.
    counts.failed = names.length;
    return { rows, counts };
  }

  // 키 수만큼 묶음을 나눈다. 라운드로빈이라 이름 순서와 무관하게 고르게 갈린다.
  const shards: string[][] = contexts.map(() => []);
  for (const [index, name] of names.entries()) {
    shards[index % contexts.length]?.push(name);
  }

  await Promise.all(
    shards.map(async (shard, shardIndex) => {
      const context = contexts[shardIndex];
      if (context === undefined) return;

      for (const [index, name] of shard.entries()) {
        if (index > 0) await sleep(KEY_INTERVAL_MS);
        try {
          const row = await fetchAndStoreOne(db, context, name);
          if (row === null) {
            counts.failed += 1;
            continue;
          }
          rows.set(name, row);
          /*
            초상화가 없는 행은 셋 중 하나다 — 찾았는데 그림이 없거나, 그런 이름이 없거나,
            ocid 가 죽었거나. **셋 다 행이 남았으므로 `failed` 가 아니다**(다음 훑기가
            다시 부르지 않는다). `failed` 는 아래 `catch` 만 센다.
          */
          if (row.image_url === null) counts.noImage += 1;
          else counts.filled += 1;
        } catch (error) {
          counts.failed += 1;
          /*
            ★ **이름을 로그에 남긴다.** 캐릭터명은 게임 안에서 공개된 값이라 비밀이 아니고,
              어떤 이름이 넘어졌는지 모르면 재현할 방법이 없다. 키는 `NexonApiError` 가
              구조적으로 담지 못한다(생성자가 키를 받지 않는다).
          */
          console.warn(
            `[name-portrait-lookup] ${name} 실패: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }),
  );

  return { rows, counts };
}

/**
 * **이름 → 생김새.** 캐시에 있으면 캐시로, 없거나 오래됐으면 넥슨 2콜로 채운 뒤 돌려준다.
 *
 * ★ 캐시에 있는 이름은 **넥슨을 부르지 않는다.** TTL 은 7일이라(위 상수) 실제로 다시
 *   부르는 일은 드물다.
 * ★ 새로 부를 이름은 `RENDER_PATH_LIMIT` 개까지만이다. 이 함수는 사람이 기다리는
 *   자리에서 불리므로, 상한을 넘긴 이름은 **이번에는 실루엣**이고 크론이 마저 채운다.
 * ★ 넥슨이 통째로 실패해도(할당량·점검) **던지지 않는다.** 얼굴 하나 못 그리는 것이
 *   화면 전체를 못 그리는 것보다 낫다. 그 경우 캐시에 있던 값만 담긴 맵이 나온다.
 */
export async function lookupCharacterLooksByName(
  names: readonly string[],
): Promise<ReadonlyMap<string, CharacterLook>> {
  const wanted = normalizeNames(names);
  const result = new Map<string, CharacterLook>();
  if (wanted.length === 0) return result;

  const db = getAdminDb();
  const cached = await readLooks(db, wanted);
  const now = Date.now();

  const toFetch: string[] = [];
  for (const name of wanted) {
    const row = cached.get(name);
    if (row === undefined) {
      toFetch.push(name);
      continue;
    }
    result.set(name, toLook(row));
    if (isStale(row, now)) toFetch.push(name);
  }

  if (toFetch.length > 0) {
    try {
      const { rows } = await fetchAndStore(db, toFetch.slice(0, RENDER_PATH_LIMIT));
      for (const [name, row] of rows) result.set(name, toLook(row));
    } catch (error) {
      console.warn(
        `[name-portrait-lookup] 조회 건너뜀: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

/**
 * **파티에 올라온 게스트의 생김새를 훑어 채운다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 대상은 **게스트 참가자**다 — 판정 축은 이름이 아니라 **참가자**다 (2026-09-03 정정)
 * ─────────────────────────────────────────────────────────────────────────────
 * `party_participants` 중 `character_id` 도 `user_id` 도 없는 행, 즉 **게스트**의
 * `display_name` 이 대상이다.
 *
 * ⚠️ 처음 이 함수는 *"`characters` 에 그 이름이 있으면 형제 파일(`portrait-backfill`)의
 *    몫이니 빼자"* 며 **이름으로** 대상을 걸렀다. 그 전제가 틀렸다. 운영 DB 실측
 *    (2026-09-03): `is_guest ∧ name_in_characters ∧ ¬own_char` 인 참가자가 **7명**
 *    (풍무고불빠따 · 롤츔늡등구쬈 · 바이부라 · 실남 · 죠뢴 · 죠린 · 킴잔라).
 *
 *    **"이름이 우리 DB 에 있다"와 "이 참가자가 그 행에 닿을 수 있다"는 전혀 다른
 *    질문이다.** 게스트 행은 `character_id` 도 `user_id` 도 null 이라
 *    `schedule-repo.memberBriefsOf` 에서 `characters` 임베딩(`character_id` 필요)도,
 *    본캐 폴백(`mainByUser`, `user_id` 필요)도 **둘 다 안 걸린다.** 그 `characters` 행은
 *    **남의 것**이고 화면이 거기 닿을 경로가 아예 없다 — 형제 파일이 그 행의 `image_url`
 *    을 채워 줘도 이 게스트의 얼굴은 영영 안 나온다. 발주자가 처음 보여 준 스크린샷의
 *    실루엣(풍무고불빠따)이 정확히 이 경우였다.
 *
 * ★ 그래서 이름 대조 질의는 **없앴다.** 대신:
 *     - `user_id` 가 **null 인 참가자(게스트)** → 본캐 폴백이 없으므로 **항상** 대상이다.
 *       그 이름이 `characters` 에 있든 없든 상관없다.
 *     - `user_id` 가 **있는 참가자** → `mainByUser` 본캐 폴백이 화면에서 답을 주므로
 *       뺀다(그 `characters` 행은 형제 파일이 채운다).
 * ★ 여기서 더 빼는 것 하나: 캐시가 아직 신선한 이름 — 다시 물어봐야 같은 답이다.
 *
 * 추가 비용은 최초 1회 7이름 × 2콜 = 14콜이고, 그 뒤로는 캐시라 0이다.
 */
export async function backfillGuestPortraits(options?: {
  readonly limit?: number;
}): Promise<GuestPortraitBackfillSummary> {
  const startedAt = Date.now();
  const db = getAdminDb();
  const limit = options?.limit ?? DEFAULT_LIMIT;

  /*
    ★ **`user_id` 가 판정 축이다.** `character_id` 가 없는 참가자 중에서도 `user_id` 가
      있는 쪽은 화면이 본캐 폴백으로 답을 주므로(`schedule-repo.memberBriefsOf`) 여기서
      2콜을 쓸 이유가 없다. 남는 것이 게스트이고, 게스트에게는 그 폴백이 없다.
      `user_id` 를 함께 읽는 이유는 이 축이 행 모양에 드러나 있어야 하기 때문이다.
  */
  const { data: participants, error: participantError } = await db
    .from("party_participants")
    .select("display_name,user_id")
    .is("character_id", null)
    .is("user_id", null)
    .is("left_at", null);
  if (participantError !== null) {
    throw new Error(`파티 구성원 조회 실패: ${participantError.message}`);
  }

  const names = normalizeNames(
    (participants ?? []).map((row) => row.display_name),
  );
  if (names.length === 0) {
    return {
      pending: 0,
      attempted: 0,
      filled: 0,
      noImage: 0,
      failed: 0,
      remaining: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /*
    캐시가 신선한 이름은 건너뛴다. **이것이 유일한 추가 필터다** — 예전에 있던
    `characters` 이름 대조는 머리말의 이유로 지웠다(그 대조는 "이 참가자가 그 행에 닿을
    수 있는가"가 아니라 "이 이름이 우리 DB 에 있는가"를 물어서, 게스트 7명을 영구
    실루엣으로 만들었다).
  */
  const cached = await readLooks(db, names);
  const now = Date.now();
  const targets = names.filter((name) => {
    const row = cached.get(name);
    return row === undefined || isStale(row, now);
  });

  const batch = targets.slice(0, limit);
  const { counts } = await fetchAndStore(db, batch);

  return {
    pending: targets.length,
    attempted: counts.attempted,
    filled: counts.filled,
    noImage: counts.noImage,
    failed: counts.failed,
    remaining: Math.max(0, targets.length - batch.length),
    elapsedMs: Date.now() - startedAt,
  };
}
