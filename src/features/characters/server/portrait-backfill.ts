import "server-only";

import { buildServerNexonContext } from "@/features/auth/server/nexon-proxy";
import { fetchCharacterBasic, isInvalidOcidError } from "@/lib/nexon/client";
import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 초상화 백필 — **한 번 부르고 적어 두면 그다음은 공짜다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-02): *"api키로 그냥 가져올수있을텐데? 가져와서 저장해"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 필요했나
 * ─────────────────────────────────────────────────────────────────────────────
 * `characters.image_url` 이 **1,116행 전부 비어 있었다**(실측 2026-09-02). 캐릭터 선택
 * 모달이 카드마다 `/character/basic` 을 부르면서도 결과를 화면에만 쓰고 흘려보냈기
 * 때문이다. 그 라우트는 이제 응답을 저장하지만(같은 날 수정), 그건 **누군가 그 모달을
 * 열어야** 채워진다. 이미 있는 캐릭터를 채우려면 한 번 훑어 주는 작업이 따로 필요하다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 예산 — 캐릭터당 1콜이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 개발 키는 하루 1,000콜이고(§1.0) 추적 캐릭터는 실측 45명이다. 한 번 돌면 4.5% 를 쓰고
 * **그 뒤로는 0** 이다 — 이미 채워진 행은 건너뛰므로 두 번째 실행은 아무것도 부르지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **`/character/basic` 은 남의 캐릭터도 부를 수 있다** (2026-09-02 실측으로 정정)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음 이 파일은 *"내 키로 남의 캐릭터는 못 부른다"* 고 적어 두고 캐릭터마다 **그 주인의
 * 키**를 꺼내 썼다. 그 전제가 틀렸다 — 발주자가 지적했고(*"각자 자신의 API 가 아니여도
 * 다른사람 캐릭터 사진을 가져올수있어"*) 실제로 호출해 확인했다:
 *
 *   `GET /character/basic?ocid=<죠린의 쌍욱>` + **내 키** → 200, `character_image` 정상
 *
 * §1.1 의 *"자신의 계정에 속한 캐릭터만 조회가 가능합니다"* 는 **스케줄러**
 * (`/scheduler/character-state`)에 대한 문장이고, 실측된 `OPENAPI00004` 도 그 엔드포인트의
 * 것이다. 캐릭터 기본 정보는 ocid 만 있으면 누구 것이든 열린다(랭킹·조회 사이트가 그걸 쓴다).
 * 우리 `assertOwnedOcid` 는 넥슨의 제약이 아니라 **우리가 건 제약**이다.
 *
 * ★ 그래서 키는 **아무 것이나 하나면 된다.** 그 캐릭터 주인의 키를 먼저 쓰되(호출량을
 *   각자 계정에 나눠 지우는 편이 공평하다), 못 꺼내면 **다른 사용자의 키로 대신 부른다.**
 *   예전에는 그 자리에서 `failed` 로 세고 포기했는데, 그건 넥슨이 막아서가 아니라 우리가
 *   막은 것이었다 — 키를 안 넣은 사람의 캐릭터가 영영 실루엣으로 남을 이유가 없다.
 * ★ 키를 서버가 쓸 수 있는지는 `allow_server_side_use` 가 정하고, 그 판정은
 *   `buildServerNexonContext` 가 갖는다 — 여기서 다시 묻지 않는다.
 * ★ **대상은 추적 캐릭터 + 파티에 올라온 캐릭터**다. 파티원이 데려가는 캐릭터는 내
 *   추적 목록에 없으므로(남의 캐릭터다) 추적만 훑으면 파티 고르기 화면이 계속 실루엣이다.
 * ★ **`image_url` 이 비어 있는 것만** 부른다. 이미 있는 그림을 새로 받는 것은 초상화가
 *   바뀌었을 때뿐이고, 그건 선택 모달이 열릴 때 갱신된다.
 * ★ **키별로 직렬, 키끼리는 병렬**(`nightly-sync` 와 같은 규칙). 초당 한도는 키마다 따로
 *   걸리므로 서로 다른 키를 기다릴 이유가 없고, 같은 키는 간격을 벌려야 429 가 안 난다.
 * ★ 한 캐릭터의 실패가 나머지를 막지 않는다. 45명 중 하나가 넘어져 전부 멈추면 다시
 *   돌릴 때 성공했던 것까지 다시 부르게 된다.
 * ★ **죽은 ocid 는 실패가 아니라 기록이다** (2026-09-03 추가). `/character/basic` 이
 *   400 `OPENAPI00003` 으로 거절하는 ocid 가 실제로 존재한다 — 그 캐릭터는 지금 볼 수
 *   없다. 예전에는 이것을 `failed` 로 세고 행을 하나도 건드리지 않았는데, 대상 조건이
 *   `image_url is null` 이라 **그 캐릭터가 크론이 돌 때마다 영원히 1콜씩 다시 나갔다.**
 *   이제 `ocid` 를 비워 "다시 해석해야 하는 캐릭터"로 표시하고(`ocid_refreshed_at` 갱신)
 *   대상에서 빠지게 한다. 되살리는 경로는 이미 있다 — 캐릭터 선택 모달이 `/character/list`
 *   로 목록을 다시 받으면 `(character_name, world_name)` 으로 같은 행을 찾아 ocid 를 다시
 *   채운다(`features/auth/server/account.ts` 의 `byName` 폴백). `invalid_id` 의 안내 문구
 *   (*"캐릭터 선택을 한 번 열어 목록을 새로 받아 주세요"*)가 가리키는 바로 그 경로다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 형제 파일 — `name-portrait-lookup.ts` 와의 경계 (2026-09-03)
 * ─────────────────────────────────────────────────────────────────────────────
 * 얼굴을 채우는 서버 경로는 이제 둘이고, **입구가 무엇이냐로 갈린다.**
 *
 *   **이 파일**              → **ocid 를 이미 아는 캐릭터.** 대상은 우리 DB 의 `characters`
 *                              행이고, 결과는 `characters.image_url` 에 적힌다. 1콜.
 *   `name-portrait-lookup.ts` → **이름밖에 모르는 사람.** `characters` 행도 ocid 도 없는
 *                              파티 게스트가 대상이고(`party_participants.character_id`
 *                              가 null), 결과는 `character_looks` 에 적힌다. **2콜**
 *                              (`/id` 로 이름 → ocid, 그다음 `/character/basic`).
 *
 * 같은 화면(파티 고르기)의 같은 얼굴 자리를 채우지만 섞으면 안 된다 — 비용이 배로 다르고,
 * 후자에만 **"그런 이름 없음"이라는 정상 결과**가 존재한다(사람이 별명을 적을 수 있다).
 * 그래서 후자는 음성 캐시(`character_looks.missing_at`)를 갖고 이 파일은 갖지 않는다.
 */

/** 같은 키로 나가는 호출 사이의 최소 간격. 개발 키 초당 5콜 → 250ms(초당 4콜). */
const KEY_INTERVAL_MS = 250;

/**
 * 한 번에 부를 수 있는 최대 캐릭터 수.
 *
 * 추적 45명을 한 번에 덮으면서도, 실수로 반복 호출됐을 때 하루 예산이 통째로 날아가지는
 * 않는 선이다. 남은 것은 `remaining` 이 말해 주므로 더 필요하면 한 번 더 부르면 된다.
 */
const DEFAULT_LIMIT = 60;

export interface PortraitBackfillSummary {
  /** 초상화가 비어 있는 추적 캐릭터 수(이번 실행 전 기준). */
  readonly pending: number;
  /** 실제로 넥슨을 부른 수. */
  readonly attempted: number;
  /** 그림을 받아 저장한 수. */
  readonly filled: number;
  /**
   * 불렀지만 얼굴을 못 얻은 수. **오류가 아니다**(§2.1.1). 둘을 함께 센다:
   * 넥슨이 초상화를 주지 않았거나, ocid 가 죽어(`OPENAPI00003`) 지금은 볼 수 없거나.
   * 둘 다 기록이 남아 **다음 훑기가 다시 부르지 않는다.**
   */
  readonly noImage: number;
  /**
   * 키를 못 꺼냈거나 호출이 실패한 수(무효 키·할당량·점검·네트워크·DB 쓰기 실패).
   *
   * ⚠️ **죽은 ocid 는 여기 세지 않는다** — 그것은 실패가 아니라 "지금 이 캐릭터를 볼 수
   *    없다"는 정상 응답이고, `noImage` 로 센다. 실패로 세면 아무것도 기록되지 않아
   *    매 훑기마다 같은 캐릭터를 다시 부르게 된다.
   */
  readonly failed: number;
  /** 상한에 걸려 이번에 못 부른 수. */
  readonly remaining: number;
  readonly elapsedMs: number;
}

interface Target {
  readonly characterId: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly ocid: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillCharacterPortraits(options?: {
  readonly limit?: number;
}): Promise<PortraitBackfillSummary> {
  const startedAt = Date.now();
  const db = getAdminDb();
  const limit = options?.limit ?? DEFAULT_LIMIT;

  /*
    ★ **조인을 다시 만들지 않는다.** `v_character_sync_source` 가 캐릭터 → 넥슨 계정 →
      자격증명 짝을 이미 갖고 있다(§2.1.2). 여기서 손으로 이으면 그 규칙이 두 벌이 된다.
  */
  /*
    대상은 두 갈래다(머리말):
      ① 내가 추적하는 캐릭터 — 내 화면 어디서나 쓴다.
      ② **파티에 올라온 캐릭터** — 남의 것이라 ① 에 없다. 파티 고르기 화면이 파티원
         얼굴을 그리려면 이쪽이 채워져야 한다.
    둘을 합친 뒤 `image_url` 이 비어 있는 것만 남긴다.
  */
  const [trackedResult, partyResult] = await Promise.all([
    db.from("characters").select("id").eq("is_tracked", true).is("image_url", null),
    db
      .from("party_participants")
      .select("character_id")
      .not("character_id", "is", null)
      .is("left_at", null),
  ]);
  if (trackedResult.error !== null) {
    throw new Error(`추적 캐릭터 조회 실패: ${trackedResult.error.message}`);
  }
  if (partyResult.error !== null) {
    throw new Error(`파티 구성원 조회 실패: ${partyResult.error.message}`);
  }

  const partyCharacterIds = [
    ...new Set(
      (partyResult.data ?? []).flatMap((row) =>
        row.character_id === null ? [] : [row.character_id],
      ),
    ),
  ];

  /*
    파티 쪽은 id 만 알고 `image_url` 은 모르므로 한 번 더 묻는다. 위 추적 조회에 `or` 로
    합칠 수도 있지만, PostgREST 의 `or` 안에서 `in` 목록을 문자열로 만들면 id 에 쉼표가
    없다는 가정이 생긴다 — UUID 라 지금은 참이지만, 그 가정을 코드에 심을 이유가 없다.
  */
  const partyMissing =
    partyCharacterIds.length === 0
      ? []
      : ((
          await db
            .from("characters")
            .select("id")
            .in("id", partyCharacterIds)
            .is("image_url", null)
        ).data ?? []);

  const missingIds = [
    ...new Set([
      ...(trackedResult.data ?? []).map((row) => row.id),
      ...partyMissing.map((row) => row.id),
    ]),
  ];
  if (missingIds.length === 0) {
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

  const { data: sources, error: sourceError } = await db
    .from("v_character_sync_source")
    .select("character_id,user_id,credential_id,ocid")
    .in("character_id", missingIds);
  if (sourceError !== null) {
    throw new Error(`동기화 원본 조회 실패: ${sourceError.message}`);
  }

  const targets: Target[] = [];
  for (const row of sources ?? []) {
    const { character_id: characterId, user_id: userId } = row;
    const credentialId = row.credential_id;
    const ocid = row.ocid;
    if (
      characterId === null ||
      userId === null ||
      credentialId === null ||
      ocid === null
    ) {
      continue;
    }
    targets.push({ characterId, userId, credentialId, ocid });
  }

  const batch = targets.slice(0, limit);
  const byCredential = new Map<string, Target[]>();
  for (const target of batch) {
    byCredential.set(target.credentialId, [
      ...(byCredential.get(target.credentialId) ?? []),
      target,
    ]);
  }

  let filled = 0;
  let noImage = 0;
  let failed = 0;

  /*
    ★ **키를 먼저 전부 연 다음에 부른다.** 자기 키를 못 꺼낸 묶음은 **아무 키나 하나**로
      대신 부르는데(위 머리말), 그 "아무 키"를 호출 도중에 고르면 누가 먼저 열리느냐에
      따라 결과가 달라진다 — 같은 입력에 다른 답이 나오는 코드는 재현이 안 된다.
      그래서 여는 단계와 부르는 단계를 나눈다. 여는 것은 DB 왕복이라 나란히 해도 된다.
  */
  const groups = [...byCredential.values()].filter((list) => list.length > 0);
  const contexts = await Promise.all(
    groups.map(async (list) => {
      const first = list[0];
      if (first === undefined) return null;
      return buildServerNexonContext({
        db,
        userId: first.userId,
        credentialId: first.credentialId,
      });
    }),
  );
  const sharedContext = contexts.find((entry) => entry !== null) ?? null;

  await Promise.all(
    groups.map(async (list, groupIndex) => {
      const context = contexts[groupIndex] ?? sharedContext;
      if (context === null) {
        // 열린 키가 저장소에 하나도 없다. 부를 방법 자체가 없는 상태다.
        failed += list.length;
        return;
      }

      for (const [index, target] of list.entries()) {
        if (index > 0) await sleep(KEY_INTERVAL_MS);
        try {
          let basic: Awaited<ReturnType<typeof fetchCharacterBasic>>;
          try {
            basic = await fetchCharacterBasic(
              context.apiKey,
              target.ocid,
              context.gateway,
            );
          } catch (error) {
            /*
              ★ **죽은 ocid(`OPENAPI00003`)만** 여기서 접는다. 무효 키(`OPENAPI00005`) ·
                할당량(`OPENAPI00007`) · 점검 · 네트워크는 그대로 던져서 `failed` 로
                남긴다 — 그것들은 "이 캐릭터를 볼 수 없다"가 아니라 "지금 우리가 부를 수
                없다"이고, ocid 를 지워 버리면 키가 잠깐 막힌 사이에 멀쩡한 캐릭터가
                동기화 대상에서 통째로 빠진다. 판별은 `lib/nexon/client.ts` 의
                `isInvalidOcidError` 하나가 갖는다.
              ★ ocid 를 비우면 이 행은 `v_character_sync_source` 에서 빠져 다음 훑기의
                대상이 아니게 된다 — 그것이 영원한 재시도를 끊는 유일한 장치다.
                `image_url` 은 건드리지 않는다. 예전에 받아 둔 그림이 있다면 지금 ocid 가
                죽었다고 그 얼굴이 틀려지는 것은 아니다.
            */
            if (!isInvalidOcidError(error)) throw error;
            const { error: clearError } = await db
              .from("characters")
              .update({ ocid: null, ocid_refreshed_at: new Date().toISOString() })
              .eq("id", target.characterId);
            if (clearError !== null) failed += 1;
            else noImage += 1;
            continue;
          }
          const { error } = await db
            .from("characters")
            .update({
              image_url: basic.imageUrl,
              character_level: basic.characterLevel,
              character_class: basic.characterClass,
              guild_name: basic.guildName,
            })
            .eq("id", target.characterId);
          if (error !== null) {
            failed += 1;
            continue;
          }
          if (basic.imageUrl === null) noImage += 1;
          else filled += 1;
        } catch (error) {
          failed += 1;
          console.warn(
            `[portrait-backfill] ${target.characterId} 실패: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }),
  );

  return {
    pending: targets.length,
    attempted: batch.length,
    filled,
    noImage,
    failed,
    remaining: Math.max(0, targets.length - batch.length),
    elapsedMs: Date.now() - startedAt,
  };
}
