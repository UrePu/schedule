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
 * `member_link` : 방에서 `!연결 <코드>` 로 내 계정을 밝힌다. **이제 이것 하나뿐이다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28: **방 코드 두 종류가 내려갔다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `channel_pair`(파티방 붙이기) · `direct_pair`(개인톡 붙이기)는 `!페어링` 의 재료였고,
 * 방 개념이 사라지면서 소모할 곳이 없어졌다(`POST /api/bot/pair` 도 함께 삭제). 허용
 * 명단(`bot_direct_grants`) 확인도 그 두 종류에만 걸려 있던 것이라 같이 빠진다 — 표는
 * 남지만 읽는 코드는 없다.
 *
 * ⚠️ 그래도 `kind` 를 요청 본문에서 받는다. 하나뿐인 값을 굳이 받는 이유는 **DB enum 에
 *    옛 값이 그대로 남아 있기 때문**이다. 조회·발급이 `kind` 로 좁히지 않으면 과거에
 *    발급된 방 코드가 `!연결` 에 섞여 들어올 수 있다. 여기서 `member_link` 만 받는 것이
 *    그 경계의 바깥쪽 절반이고, `link.ts` 의 `findUsableCode(kind)` 가 안쪽 절반이다.
 *
 * ⚠️ **원문 코드는 이 응답에만 존재한다.** 서버는 SHA-256 해시만 보관하므로 다시 볼 수
 *    없고, 다시 발급하면 **이전 코드는 즉시 죽는다**(동시 1개). 초대 링크·API 키와
 *    같은 기조다.
 * ★ `GET` 이 없는 것도 같은 이유다 — 되돌려 줄 원문이 서버에 없다.
 */

const bodySchema = z.object({
  kind: z.enum(["member_link"]),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const db = getAdminDb();

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
