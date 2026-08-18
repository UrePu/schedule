import { z } from "zod";

import { fetchCharacterList } from "@/lib/nexon/client";
import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { resolveNexonProxyContext } from "@/features/auth/server/nexon-proxy";
import type { NexonCharacterListResult } from "@/lib/nexon/types";

/**
 * `GET /api/nexon/character/list[?credentialId=...]`
 *
 * 헤더 `x-nexon-api-key: <사용자 키>` — **이제 선택이다.** 생략하면 서버가 DB 에 보관된
 * 키를 복호화해 쓴다(§2.1.2). `credentialId` 로 **어느 넥슨 계정의 목록인지** 지목할 수
 * 있고, 생략하면 이 사용자의 키 중 하나(주 키 우선)로 부른다.
 *
 * 응답 `{ accounts: [{ accountId, characters[] }], characters[] }`
 *
 * 넥슨 `/maplestory/v1/character/list` **1콜**. 서버 캐시 15분, 호출량은
 * `nexon_api_quota_usage` 에 자격증명·일자별로 적힌다.
 *
 * ⚠️ 이 응답에는 **이미지가 없다.** 초상화는 `/api/nexon/character/basic` 이며
 *    캐릭터당 1콜이라 화면에 보이는 만큼만 부른다(§2.1.1).
 */

const querySchema = z.object({
  credentialId: z.uuid("자격증명 식별자 형식이 올바르지 않습니다.").optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const credentialId = new URL(request.url).searchParams.get("credentialId");
    const parsed = querySchema.safeParse(
      credentialId === null ? {} : { credentialId },
    );
    if (!parsed.success) {
      throw ApiError.badRequest(
        parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.",
      );
    }

    const context = await resolveNexonProxyContext(
      request,
      parsed.data.credentialId === undefined
        ? { kind: "unscoped" }
        : { kind: "credential", credentialId: parsed.data.credentialId },
    );

    const result = await fetchCharacterList(context.apiKey, context.gateway);
    return jsonOk<NexonCharacterListResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/nexon/character/list");
  }
}
