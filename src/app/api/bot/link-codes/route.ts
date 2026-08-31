import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { isDirectGranted } from "@/features/bot/server/bot-repo";
import { issueLinkCode } from "@/features/bot/server/link";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotLinkCode } from "@/features/bot/types";

/**
 * `POST /api/bot/link-codes` — 6자리 연결 코드 발급. **세션 인증.**
 *
 * `member_link`   : 방에서 `!연결 <코드>` 로 내 계정을 밝힌다.
 * `channel_pair`  : 파티방 하나를 서버에 처음 붙인다(클라이언트가 `/api/bot/pair` 로 소모).
 * `direct_pair`   : **개인톡** 방을 붙인다(2026-08-31). 소모 경로는 같고, 그렇게 열린
 *                   채널만 `bot_channels.kind = 'direct'` 가 되어 그 사람의 **모든**
 *                   일정 알림을 받는다.
 *
 * ⚠️ `direct_pair` 는 **허용 명단(`bot_direct_grants`)에 있는 사람만** 발급받는다
 *    (발주 지시 2026-08-31: *"개인톡으로 몇명만 가능하도록"*). 개인톡 방 하나는 그
 *    사람의 일정 전부를 흘려보내는 통로라 아무나 열어서는 안 된다. 명단은 여기 말고도
 *    **페어링 시점과 발송 대상 조회에서 다시** 본다 — 한 곳만 보면 명단에서 빼도 이미
 *    열린 방으로 알림이 계속 나간다.
 *
 * ⚠️ **원문 코드는 이 응답에만 존재한다.** 서버는 SHA-256 해시만 보관하므로 다시 볼 수
 *    없고, 다시 발급하면 **이전 코드는 즉시 죽는다**(동시 1개). 초대 링크·API 키와
 *    같은 기조다.
 * ★ `GET` 이 없는 것도 같은 이유다 — 되돌려 줄 원문이 서버에 없다.
 */

const bodySchema = z.object({
  kind: z.enum(["member_link", "channel_pair", "direct_pair"]),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const db = getAdminDb();

    if (body.kind === "direct_pair" && !(await isDirectGranted(db, session.uid))) {
      /*
        여기서는 **명확히 말한다.** 로그인한 본인의 요청이고 상대가 코드를 찍어 보는
        쪽이 아니므로, 감출 것이 없고 감추면 "왜 안 되는지 모르는 버튼"이 된다.
        (페어링 라우트는 반대로 404 로 접는다 — 그쪽은 세션이 없다.)
      */
      throw ApiError.badRequest("개인톡 알림 사용 권한이 없습니다.");
    }

    const code = await issueLinkCode(
      db,
      { kind: body.kind, userId: session.uid },
      new Date(),
    );

    return jsonOk<BotLinkCode>(code, 201);
  } catch (error) {
    return handleRouteError(error, "api/bot/link-codes#POST");
  }
}
