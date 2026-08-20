import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { PartyMembersResponse } from "@/features/schedule/data/schedule-queries";
import {
  fetchPartyMembers,
  updatePartyRoster,
} from "@/features/schedule/server/schedule-repo";

/**
 * `GET /api/schedule/parties/{partyId}/members` — 그 파티의 구성원
 * `PUT /api/schedule/parties/{partyId}/members` — 로스터 편집(세션 필요)
 *
 * ★ 보이지 않는 파티는 **404** 다. 403 은 "그 파티는 존재한다"를 알려 주므로
 *   비공개 파티를 id 로 훑어 낼 수 있게 된다 — repo 가 404 로 통일한다.
 * ★ 번호(`member_no`)는 **절대 재배열하지 않는다** (§1.4). 빠진 번호는 빈 채로 둔다.
 */

const personIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "사람 식별자 형식이 올바르지 않습니다.",
  );

/** 경계는 DB CHECK(`guest_profiles.display_name` 1~40자)와 같은 값이다. */
const guestNameSchema = z
  .string()
  .trim()
  .min(1, "닉네임을 입력해 주세요.")
  .max(40, "닉네임은 40자 이하여야 합니다.");

const rosterSchema = z.object({
  memberPersonIds: z
    .array(personIdSchema)
    .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
  /**
   * **새로** 만들어 넣을 게스트의 닉네임. 이미 파티에 있는 게스트는 `guest_profiles.id`
   * 를 가진 `PersonId` 이므로 `memberPersonIds` 쪽으로 들어온다 — 여기 또 적으면 같은
   * 사람이 번호를 두 개 갖게 된다.
   */
  guestNames: z
    .array(guestNameSchema)
    .max(24, "한 번에 추가할 수 있는 게스트는 24명까지입니다.")
    .optional(),
  /**
   * 파티 이름. **보내지 않으면 건드리지 않는다**(`undefined` ≠ 빈 문자열).
   * 빈 문자열은 "자동 제목으로 되돌리기"라 유효한 입력이므로 `min(1)` 을 걸지 않는다.
   * 상한은 DB CHECK(`parties.name` 1~60자)와 같은 값이다.
   */
  name: z.string().max(60, "파티 이름은 60자 이하여야 합니다.").optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    const members = await fetchPartyMembers(session?.uid ?? null, partyId);
    return jsonOk<PartyMembersResponse>({ members });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/members#GET");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, rosterSchema);
    const members = await updatePartyRoster(session.uid, {
      partyId,
      memberPersonIds: body.memberPersonIds,
      guestNames: body.guestNames,
      name: body.name,
    });
    return jsonOk<PartyMembersResponse>({ members });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/members#PUT");
  }
}
