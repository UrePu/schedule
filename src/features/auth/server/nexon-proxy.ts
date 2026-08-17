import "server-only";

/**
 * 넥슨 프록시의 입구 검사.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 프록시가 존재하는 이유 (CLAUDE.md §2.1.1) — **CORS 가 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 API 는 어떤 Origin 이든 반사하며 브라우저 직접 호출을 허용한다(검증됨).
 * 그런데도 프록시를 두는 이유는 셋이다 — **호출량 통제 / 캐시 / 키 노출면 축소**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 이 파일이 강제하는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **세션이 있어야 한다.** 없으면 우리 서버가 아무나 쓰는 공개 넥슨 릴레이가 된다.
 *    (비로그인 열람 경로는 이 프록시를 타지 않는다 — 공개 시간표는 우리 DB 에서 온다.)
 * 2. **키가 이 계정에 등록돼 있어야 한다.** 등록된 키만 통과시켜야 호출량을 자격증명에
 *    귀속시킬 수 있다. 귀속되지 않는 호출은 장부에 남지 않고, 남지 않는 호출은 통제할 수 없다.
 * 3. **남의 계정에 묶인 키는 거부한다.** 원문 키를 아는 사람은 넥슨을 직접 부를 수 있으니
 *    비밀이 새는 것은 아니지만, 남의 자격증명 앞으로 호출량이 쌓이면 장부가 거짓이 된다.
 *
 * 키는 **헤더로만** 받는다. 쿼리에 실으면 액세스 로그와 브라우저 히스토리에 그대로 남는다.
 */

import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { PROXY_API_KEY_HEADER } from "@/lib/nexon/constants";
import { createNexonGateway } from "@/lib/nexon/gateway";
import { hashApiKey, normalizeApiKey } from "@/lib/nexon/key-hash";
import type { NexonEndpointDeps } from "@/lib/nexon/client";

import { ApiError, apiKeySchema } from "./http";
import { readSession } from "./session";

export interface NexonProxyContext {
  readonly userId: string;
  readonly credentialId: string;
  readonly apiKey: string;
  readonly apiKeyHash: string;
  readonly db: AdminDb;
  /** 캐시·장부·쿨다운이 끼워진 실행기. 엔드포인트 래퍼에 그대로 넘긴다. */
  readonly gateway: Required<NexonEndpointDeps>;
}

export async function resolveNexonProxyContext(
  request: Request,
): Promise<NexonProxyContext> {
  const session = await readSession();
  if (session === null) throw ApiError.unauthenticated();

  const rawHeader = request.headers.get(PROXY_API_KEY_HEADER);
  if (rawHeader === null || rawHeader.trim() === "") {
    throw ApiError.badRequest(
      `넥슨 API 키가 없습니다. \`${PROXY_API_KEY_HEADER}\` 헤더로 보내 주세요.`,
    );
  }

  const parsedKey = apiKeySchema.safeParse(rawHeader);
  if (!parsedKey.success) {
    throw ApiError.badRequest(
      parsedKey.error.issues[0]?.message ?? "API 키 형식이 올바르지 않습니다.",
    );
  }

  const apiKey = normalizeApiKey(parsedKey.data);
  const apiKeyHash = hashApiKey(apiKey);
  const db = getAdminDb();

  const { data: credential, error } = await db
    .from("user_credentials")
    .select("id, user_id")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();
  if (error !== null) throw error;

  if (credential === null) {
    throw ApiError.badRequest(
      "이 API 키는 현재 계정에 등록되어 있지 않습니다. 먼저 키를 추가해 주세요.",
    );
  }
  if (credential.user_id !== session.uid) {
    throw ApiError.keyOwnedByOtherAccount();
  }

  return {
    userId: session.uid,
    credentialId: credential.id,
    apiKey,
    apiKeyHash,
    db,
    gateway: createNexonGateway({
      apiKey,
      apiKeyHash,
      credentialId: credential.id,
      db,
    }),
  };
}

/**
 * `ocid` 가 이 사용자의 캐릭터인지 확인한다.
 *
 * 넥슨도 남의 계정 ocid 를 `OPENAPI00004` 로 거절하지만(실측), **그 거절은 우리 호출량을
 * 이미 태운 뒤에 온다.** 우리 DB 에서 먼저 막으면 호출 자체가 나가지 않는다.
 */
export async function assertOwnedOcid(
  context: NexonProxyContext,
  ocid: string,
): Promise<void> {
  const { data, error } = await context.db
    .from("characters")
    .select("id")
    .eq("user_id", context.userId)
    .eq("ocid", ocid)
    .maybeSingle();

  if (error !== null) throw error;
  if (data === null) {
    throw ApiError.badRequest(
      "이 계정에 등록되지 않은 캐릭터입니다. 캐릭터 목록을 새로 불러와 주세요.",
    );
  }
}
