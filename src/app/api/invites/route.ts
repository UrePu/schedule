import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { GuestInviteResponse } from "@/features/invites/data/invite-api";
import { issueGuestInvite } from "@/features/invites/server/invite-repo";

/**
 * `POST /api/invites` — 게스트 한 명의 **초대 링크 발급**
 *
 * 요청 `{ guestPersonId }` → 응답 `{ invite: { token, guestDisplayName, partyNames } }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /api/schedule/availability/patterns` 와 동일하게
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) 마지막 catch 는 `handleRouteError`
 *
 * ★ **GET 이 없다.** 발급된 토큰 원문은 서버에 남지 않으므로(§ repo 주석) "내가 만든
 *   링크 다시 보기" 라는 조회가 성립하지 않는다. 잃어버렸으면 재발급이고, 재발급하면
 *   이전 링크는 죽는다 — 화면이 그렇게 안내한다.
 * ★ 권한 판정(같은 파티인가)은 repo 가 한다. 여기서 두 번 하지 않는다.
 */

const bodySchema = z.object({
  guestPersonId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "사람 식별자 형식이 올바르지 않습니다.",
    ),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const invite = await issueGuestInvite(session.uid, body.guestPersonId);
    return jsonOk<GuestInviteResponse>({ invite }, 201);
  } catch (error) {
    return handleRouteError(error, "api/invites#POST");
  }
}
