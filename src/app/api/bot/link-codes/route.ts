import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { issueLinkCode } from "@/features/bot/server/link";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotLinkCode } from "@/features/bot/types";

/**
 * `POST /api/bot/link-codes` — 6자리 연결 코드 발급. **세션 인증.**
 *
 * `member_link`   : 방에서 `!연결 <코드>` 로 내 계정을 밝힌다.
 * `channel_pair`  : 방 하나를 서버에 처음 붙인다(클라이언트가 `/api/bot/pair` 로 소모).
 *
 * ⚠️ **원문 코드는 이 응답에만 존재한다.** 서버는 SHA-256 해시만 보관하므로 다시 볼 수
 *    없고, 다시 발급하면 **이전 코드는 즉시 죽는다**(동시 1개). 초대 링크·API 키와
 *    같은 기조다.
 * ★ `GET` 이 없는 것도 같은 이유다 — 되돌려 줄 원문이 서버에 없다.
 */

const bodySchema = z.object({
  kind: z.enum(["member_link", "channel_pair"]),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const code = await issueLinkCode(
      getAdminDb(),
      { kind: body.kind, userId: session.uid },
      new Date(),
    );

    return jsonOk<BotLinkCode>(code, 201);
  } catch (error) {
    return handleRouteError(error, "api/bot/link-codes#POST");
  }
}
