import { z } from "zod";

import { getAdminDb } from "@/lib/supabase/admin-db";
import {
  addCredentialToUser,
  loadSessionUser,
} from "@/features/auth/server/account";
import {
  ApiError,
  apiKeySchema,
  handleRouteError,
  jsonOk,
  labelSchema,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  AddCredentialResponse,
  CredentialSummary,
} from "@/features/auth/types";

/**
 * 부계정 키 관리.
 *
 * `GET  /api/auth/credentials` → `{ credentials: CredentialSummary[] }`
 * `POST /api/auth/credentials` → `{ user, credentialId, characters[] }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인과 다른 점 — **세션이 반드시 필요하다** (CLAUDE.md §2.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 하나는 그 키를 발급한 넥슨 계정의 캐릭터만 읽는다. 부계정 캐릭터를 보려면 그
 * 계정의 키를 추가로 등록하는 수밖에 없다. 그런데 "이 키를 이 사람에게 붙인다"는
 * 주장은 **이미 그 사람으로 인증돼 있을 때만** 성립한다. 세션 없이 붙일 수 있게 하면
 * 키를 아는 누구나 남의 계정에 자기 계정을 엮을 수 있다.
 *
 * 이미 **다른 계정**에 묶인 키는 409 로 거부한다. 조용히 소유자를 옮기면 계정 탈취다.
 * (계정 병합은 별도의 명시적 절차이며 현재 미구현.)
 */

const addCredentialBodySchema = z.object({
  apiKey: apiKeySchema,
  label: labelSchema,
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const user = await loadSessionUser(getAdminDb(), session.uid);
    if (user === null) throw ApiError.accountUnavailable();

    return jsonOk<{ credentials: readonly CredentialSummary[] }>({
      credentials: user.credentials,
    });
  } catch (error) {
    return handleRouteError(error, "api/auth/credentials#GET");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, addCredentialBodySchema);

    const result = await addCredentialToUser(getAdminDb(), {
      userId: session.uid,
      apiKey: body.apiKey,
      label: body.label ?? null,
    });

    return jsonOk<AddCredentialResponse>(result);
  } catch (error) {
    return handleRouteError(error, "api/auth/credentials#POST");
  }
}
