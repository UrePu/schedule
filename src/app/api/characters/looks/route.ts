import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { lookupCharacterLooksByName } from "@/features/characters/server/name-portrait-lookup";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/characters/looks` — **이름만 아는 사람의 생김새를 채운다** (세션 필요)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-09-03): *"내 api 로 파티원들의 이미지를 가져오는식으로"*.
 *
 * 파티에는 우리 DB 에 `characters` 행이 없는 게스트가 올라온다. 그 사람에게는 ocid 가
 * 없어 기존 초상화 경로(`portrait-backfill`)가 닿지 못하고, 그래서 파티 고르기 화면에서
 * 계속 실루엣으로 남았다. 이 경로가 `character_looks` 캐시를 채우고, 화면은 그 캐시를
 * **다음 조회에서** 읽는다(`schedule-repo.withCachedLooks`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 렌더가 아니라 **여기서** 채우는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이름 하나에 넥슨 **2콜**(`/id` + `/character/basic`)이 들고, 같은 키로는 250ms 간격을
 * 둬야 한다(§1.0 — 개발 키 초당 5). 서버 렌더 도중에 부르면 파티 목록을 여는 데 초 단위가
 * 걸린다. 그래서 읽기 경로는 **DB 조회만** 하고, 채우는 일은 사용자가 모달을 열 때
 * 클라이언트가 이 경로를 한 번 부른 뒤 파티 쿼리를 무효화하는 쪽이 진다
 * (§2.4 규칙 1 — 화면 데이터의 주인은 쿼리 캐시, 규칙 3 — `router.refresh()` 는 데이터용이
 * 아니다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 세션이 필요한가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 경로는 **넥슨 할당량을 쓴다.** 비로그인에게 열어 두면 이름만 바꿔 가며 두드리는
 * 것만으로 저장소의 하루 예산(개발 키 1,000콜)을 태울 수 있다. 읽기 경로
 * (`GET /api/schedule/parties`)가 비로그인 200 인 것과 의도적으로 다르다 — 그쪽은 우리
 * DB 만 읽고, 이쪽은 밖으로 나간다.
 *
 * ⚠️ **API 키는 응답에도 로그에도 싣지 않는다.** 어느 키를 썼는지는 서버가 고르는 일이고
 *    (`name-portrait-lookup.openContexts`), 호출자가 알 이유가 없다. 응답은 개수뿐이다.
 */

/**
 * 한 번에 물을 수 있는 이름 수.
 *
 * 이름당 2콜 × 250ms 라 20개면 이미 10초다(`name-portrait-lookup.RENDER_PATH_LIMIT` 과
 * 같은 값). 더 필요하면 다음 번에 부르면 된다 — 이 경로는 화면을 막지 않는다.
 */
const MAX_NAMES = 20;

/** `character_looks.character_name` 의 CHECK(btrim · 1~40자)와 같은 값. */
const MAX_NAME_LENGTH = 40;

/**
 * 모양만 본다 — **배열인가, 20개 이하인가, 원소가 문자열인가.**
 *
 * 개별 이름의 길이는 여기서 거절하지 않고 **아래에서 버린다.** 파티원 이름 20개 중
 * 하나가 41자라고 나머지 19개를 못 채울 이유가 없고, 호출자(모달)는 그 400 을 사용자에게
 * 보여 주지도 않는다. 반대로 배열이 아니거나 200개가 오는 것은 호출자의 버그이므로 400 이다.
 */
const lookupSchema = z.object({
  names: z
    .array(z.string())
    .max(MAX_NAMES, `이름은 한 번에 ${String(MAX_NAMES)}개까지입니다.`),
});

export interface CharacterLooksResponse {
  /** 실제로 조회에 쓴 이름 수(정규화 후). 요청한 개수와 다를 수 있다. */
  readonly requested: number;
  /** 초상화를 얻은 이름 수. */
  readonly filled: number;
  /**
   * 찾았지만 초상화가 없었거나 넥슨에 그런 이름이 없던 수.
   *
   * **오류가 아니다.** 사람이 캐릭터명 대신 별명을 적었을 때의 정상적인 답이며, 화면은
   * 그때도 실루엣과 이름을 그린다(§2.1.1).
   */
  readonly missing: number;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, lookupSchema);

    // 다듬고, 빈 이름과 제약을 넘는 길이는 버린다. 중복도 여기서 접는다.
    const names = [
      ...new Set(
        body.names
          .map((name) => name.trim())
          .filter((name) => name !== "" && name.length <= MAX_NAME_LENGTH),
      ),
    ];

    const looks = await lookupCharacterLooksByName(names);

    let filled = 0;
    let missing = 0;
    for (const look of looks.values()) {
      if (look.imageUrl === null) missing += 1;
      else filled += 1;
    }

    return jsonOk<CharacterLooksResponse>({
      requested: names.length,
      filled,
      missing,
    });
  } catch (error) {
    return handleRouteError(error, "api/characters/looks#POST");
  }
}
