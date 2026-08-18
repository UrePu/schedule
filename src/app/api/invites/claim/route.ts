import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { InviteClaimResponse } from "@/features/invites/data/invite-api";
import { claimInvite } from "@/features/invites/server/invite-repo";

/**
 * `POST /api/invites/claim` — 초대 링크로 **게스트를 내 계정에 승계**
 *
 * 요청 `{ token }` → 응답 `{ result: { movedParticipants, mergedParticipants, partyNames } }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 토큰을 **본문**으로 받는가 (경로 파라미터가 아니라)
 * ─────────────────────────────────────────────────────────────────────────────
 * 토큰은 이 사람이 낀 **모든 파티**를 넘기는 비밀이다. 경로나 쿼리에 실으면 접근 로그·
 * 프록시 로그·`Referer` 헤더에 그대로 남는다. 본문은 그 셋 어디에도 기록되지 않는다.
 * (초대 페이지 `/invite/[token]` 의 주소 자체에는 토큰이 있지만, 그건 사람이 링크를
 *  열어야 하는 이상 피할 수 없는 표면이고 — 서버 쪽 표면은 여기서 줄인다.)
 *
 * ★ **세션이 필요하다.** 승계는 "이 참가 이력을 이 계정 것으로 만든다"는 동작이라
 *   받는 계정이 확정돼 있어야 한다. 비로그인은 401 이고, 화면은 그 앞에 로그인 폼을 둔다.
 * ★ 남의 게스트를 가로챌 수 없다 — 토큰 증명 없이는 아무것도 일어나지 않고, 이미 다른
 *   계정이 쓴 토큰은 409 로 거절된다(repo 가 판정하고 사용자 문구를 만든다).
 */

const bodySchema = z.object({
  token: z
    .string({ error: "초대 링크가 올바르지 않습니다." })
    .trim()
    .min(1, "초대 링크가 올바르지 않습니다.")
    .max(200, "초대 링크가 올바르지 않습니다."),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const result = await claimInvite(session.uid, body.token);
    return jsonOk<InviteClaimResponse>({ result });
  } catch (error) {
    return handleRouteError(error, "api/invites/claim#POST");
  }
}
