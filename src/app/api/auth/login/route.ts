import { z } from "zod";

import { getAdminDb } from "@/lib/supabase/admin-db";
import { loginWithApiKey } from "@/features/auth/server/account";
import {
  apiKeySchema,
  handleRouteError,
  jsonOk,
  labelSchema,
  readJsonBody,
} from "@/features/auth/server/http";
import {
  isSecureRequest,
  writeSessionCookie,
} from "@/features/auth/server/session";
import type { LoginResponse } from "@/features/auth/types";

/**
 * `POST /api/auth/login`
 *
 * 요청  `{ apiKey: string, label?: string }`
 * 응답  `{ user, credentialId, isNewAccount, characters[] }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 계약
 * ─────────────────────────────────────────────────────────────────────────────
 * - **넥슨 호출은 정확히 1건**(`/character/list`). 키 유효성과 소유 캐릭터를 동시에 얻는다.
 * - 이미 등록된 키면 **그 계정으로 로그인**한다. 주 키인지 연결 키인지 묻지 않는다(§2.1).
 * - 처음 보는 키면 그 자리에서 계정을 만들고, 캐릭터는 전부 `is_tracked = false` 로 넣는다.
 * - 성공 시 httpOnly 세션 쿠키를 심는다. **원문 키는 응답에도 DB 에도 없다.**
 * - 무효 키는 401 `{ error: { kind: "invalid_key" } }` 다. **500 이 아니다.**
 */

const loginBodySchema = z.object({
  apiKey: apiKeySchema,
  label: labelSchema,
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, loginBodySchema);
    const db = getAdminDb();

    const result = await loginWithApiKey(db, {
      apiKey: body.apiKey,
      label: body.label ?? null,
    });

    await writeSessionCookie(result.user.id, {
      secure: isSecureRequest(request),
    });

    const response: LoginResponse = {
      user: result.user,
      credentialId: result.credentialId,
      isNewAccount: result.isNewAccount,
      characters: result.characters,
    };
    return jsonOk(response);
  } catch (error) {
    return handleRouteError(error, "api/auth/login");
  }
}
