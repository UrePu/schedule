import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  deleteGuest,
  setGuestHidden,
} from "@/features/schedule/server/schedule-repo";
import type {
  GuestDeleteResult,
  GuestManageSnapshot,
} from "@/features/schedule/types";

/**
 * `PATCH  /api/schedule/people/guests/{guestId}` — 후보에서 **숨기기 / 되돌리기** (세션 필요)
 * `DELETE /api/schedule/people/guests/{guestId}` — **지우기. 되돌릴 수 없다** (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 동작의 경계 (2026-10-21 발주: *"삭제 할수있게도 해줘. 내 기준 게스트니까."*)
 * ─────────────────────────────────────────────────────────────────────────────
 * · 숨기기 = `guest_profiles.hidden_at` 한 칸. 지난 일정·수익·파티 명단은 그대로다.
 * · 지우기 = 진짜 DELETE. **기록이 0건일 때만** 된다 — `party_participants.guest_id` 가
 *   CASCADE 라 기록이 있는 게스트를 지우면 그 사람의 일정 참여와 분배 몫이 함께 죽는다.
 * · 둘 다 **그 게스트가 든 파티가 전부 내 것**일 때만, 승계된 게스트는 둘 다 안 된다.
 *
 * 판정은 라우트에도 repo 에도 복제하지 않는다 — SQL 함수(`set_guest_hidden` ·
 * `delete_guest_profile`)가 게스트 행을 잠근 뒤 한 번 하고, 그 판정이 화면의 버튼 조건
 * (`guest_manage_states`)과 같은 함수에서 나온다. 두 곳에 두면 반드시 갈라진다.
 *
 * `DELETE` 를 보관이 아닌 **진짜 삭제**에 쓴다. 파티·묶음의 `DELETE` 는 보관인데, 그쪽은
 * 지우면 수익이 죽어서 삭제 경로가 아예 없다. 여기는 숨기기(`PATCH`)가 그 보관 자리를
 * 맡고, 삭제는 잃을 것이 없다고 DB 가 확인한 경우에만 열린다.
 */

const hideSchema = z.object({
  hidden: z.boolean({ error: "숨김 여부(hidden)를 true 또는 false 로 보내 주세요." }),
});

const guestIdSchema = z.uuid("사람 식별자 형식이 올바르지 않습니다.");

function parseGuestId(raw: string): string {
  const parsed = guestIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest("사람 식별자 형식이 올바르지 않습니다.");
  }
  return parsed.data;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ guestId: string }> },
): Promise<Response> {
  try {
    const { guestId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, hideSchema);
    const snapshot = await setGuestHidden(
      session.uid,
      parseGuestId(guestId),
      body.hidden,
    );
    return jsonOk<GuestManageSnapshot>(snapshot);
  } catch (error) {
    return handleRouteError(error, "api/schedule/people/guests/[guestId]#PATCH");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ guestId: string }> },
): Promise<Response> {
  try {
    const { guestId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const result = await deleteGuest(session.uid, parseGuestId(guestId));
    return jsonOk<GuestDeleteResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/schedule/people/guests/[guestId]#DELETE");
  }
}
