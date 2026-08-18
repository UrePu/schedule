import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { PartyMembersResponse } from "@/features/schedule/data/schedule-queries";
import { updateMyPartyCharacter } from "@/features/schedule/server/schedule-repo";

/**
 * `PUT /api/schedule/parties/{partyId}/character` — **이 파티에 데려갈 내 캐릭터**
 *
 * 요청 `{ characterId: string | null }` → 응답 `{ members }` (바뀐 뒤의 로스터 전체)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `.../members` 에 얹지 않았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 옆 경로(`members`)는 **로스터**를 바꾼다 — 누가 들어오고 누가 나가는지, 권한은 "그 파티
 * 구성원 누구나"다. 이 경로가 바꾸는 것은 **내 행 한 줄**이고 권한은 "나만"이다. 같은
 * 경로에 넣으면 "남의 참여 캐릭터도 바꿀 수 있나?"라는 질문이 코드에서 사라지지 않는다.
 * 남이 어느 캐릭터로 갈지는 본인만 아는 정보이고, **받지 않는 값은 위조될 수 없다** —
 * 그래서 본문에 "누구의" 를 적는 자리가 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 돌려준다 — 화면이 부분 갱신을 조립하지 않아도 된다
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ★ `characterId: null` 은 **지정 해제**이며 정상 입력이다.
 * ★ 런 단위 캐릭터(`run_signups.character_id`)는 이 경로가 건드리지 않는다. 파티엔
 *   부캐로 있어도 특정 런만 본캐로 나가는 일이 있어 두 값은 따로 존재한다.
 */

const bodySchema = z.object({
  characterId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "캐릭터 식별자 형식이 올바르지 않습니다.",
    )
    .nullable(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const members = await updateMyPartyCharacter(session.uid, {
      partyId,
      characterId: body.characterId,
    });
    return jsonOk<PartyMembersResponse>({ members });
  } catch (error) {
    return handleRouteError(
      error,
      "api/schedule/parties/[partyId]/character#PUT",
    );
  }
}
