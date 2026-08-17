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

const rosterSchema = z.object({
  memberPersonIds: z
    .array(personIdSchema)
    .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
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
    });
    return jsonOk<PartyMembersResponse>({ members });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/members#PUT");
  }
}
