import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  CharacterListResponse,
  TrackableCharacter,
} from "@/features/characters/data/character-queries";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";

/**
 * `GET /api/characters`
 *
 * 응답 `{ characters: TrackableCharacter[] }` — 세션 사용자의 `public.characters` 전부.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **넥슨을 부르지 않는다** (§2.1.1 — 쿼터가 설계를 정한다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 시점에 서버가 `/character/list` 를 **1콜** 불러 이 테이블에 전부 upsert 해
 * 두었다(`syncCredentialInventory`). 캐릭터 선택 모달이 열릴 때마다 같은 엔드포인트를
 * 다시 부르면 **같은 데이터에 개발 키 예산만 태운다**(1,000콜/일).
 * 게다가 넥슨 응답에는 우리 PK 가 없어서, 추적 대상을 저장하려면 어차피 이 테이블의
 * `id` 가 필요하다. 그래서 목록의 유일한 출처는 우리 DB 다.
 *
 * 넥슨을 타는 것은 **초상화뿐**이며(`/api/nexon/character/basic`, 캐릭터당 1콜)
 * 화면에 보이는 상위 12명분만 나간다.
 *
 * ⚠️ 비로그인은 **401** 이다. `/api/auth/me` 가 200 `{user:null}` 인 것과 다른데,
 *    그쪽은 "비로그인 열람"이 정상 경로인 반면 이 목록은 남의 계정 자산이기 때문이다.
 *    화면은 `kind === "unauthenticated"` 를 에러가 아니라 "로그인 필요" 상태로 그린다.
 */

/**
 * 화면이 필요로 하는 컬럼만. `*` 로 긁지 않는 이유는, 나중에 추가되는 민감 컬럼이
 * 조용히 응답에 실려 나가는 사고가 정확히 그렇게 일어나기 때문이다(§0.3 의 `share_bp`).
 */
const CHARACTER_COLUMNS =
  "id, ocid, character_name, world_name, character_class, character_level, is_main, is_tracked, image_url";

/**
 * 세션 사용자의 캐릭터 전체.
 *
 * `features/auth/server/account.ts` 의 `loadCredentialCharacters` 와 형제지만 그쪽은
 * **방금 등록한 키의 계정으로 좁히고** `image_url` 을 싣지 않는다. 선택 모달은 사용자의
 * 캐릭터 전부를 봐야 하므로(키가 여러 개일 수 있다 — §2.1) 여기서 따로 읽는다.
 */
export async function loadTrackableCharacters(
  db: AdminDb,
  userId: string,
): Promise<readonly TrackableCharacter[]> {
  const [listResult, sourceResult] = await Promise.all([
    db
      .from("characters")
      .select(CHARACTER_COLUMNS)
      .eq("user_id", userId)
      // 최종 정렬은 화면(`pickTopCharacters`)이 결정론적으로 다시 한다. 여기서 정렬하는
      // 것은 응답이 매번 같은 순서로 보이게 하기 위한 것뿐이다.
      .order("character_level", { ascending: false, nullsFirst: false })
      .order("character_name", { ascending: true }),
    /*
     * 캐릭터 → 그 캐릭터를 읽을 수 있는 자격증명. 조인은 뷰가 이미 갖고 있다
     * (`characters.nexon_account_ref → credential_nexon_accounts → user_credentials`).
     * **원문 키는 이 뷰에도 없다** — 나가는 것은 id 와 라벨뿐이다.
     */
    db
      .from("v_character_sync_source")
      .select("character_id,credential_id")
      .eq("user_id", userId),
  ]);

  if (listResult.error !== null) throw listResult.error;
  if (sourceResult.error !== null) throw sourceResult.error;

  const credentialByCharacter = new Map<string, string>();
  for (const row of sourceResult.data ?? []) {
    // 뷰 컬럼은 전부 nullable 이다. 둘 중 하나라도 비면 "동기화 불가"다.
    if (row.character_id === null || row.credential_id === null) continue;
    credentialByCharacter.set(row.character_id, row.credential_id);
  }

  return (listResult.data ?? []).map((row) => ({
    id: row.id,
    // `ocid` 는 널일 수 있지만(옛 행) 초상화 호출의 유일한 열쇠다.
    // 빈 문자열이면 화면이 초상화 조회를 건너뛰고 실루엣을 그린다 — 정상 상태다.
    ocid: row.ocid ?? "",
    characterName: row.character_name,
    worldName: row.world_name,
    characterClass: row.character_class,
    characterLevel: row.character_level,
    isMain: row.is_main,
    isTracked: row.is_tracked,
    imageUrl: row.image_url,
    credentialId: credentialByCharacter.get(row.id) ?? null,
  }));
}

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const characters = await loadTrackableCharacters(getAdminDb(), session.uid);

    return jsonOk<CharacterListResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/characters#GET");
  }
}
