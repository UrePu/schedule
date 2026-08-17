import { fetchCharacterList } from "@/lib/nexon/client";
import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { resolveNexonProxyContext } from "@/features/auth/server/nexon-proxy";
import type { NexonCharacterListResult } from "@/lib/nexon/types";

/**
 * `GET /api/nexon/character/list`
 *
 * 헤더  `x-nexon-api-key: <사용자 키>`   ← 쿼리가 아니라 **헤더**다
 * 응답  `{ accounts: [{ accountId, characters[] }], characters[] }`
 *
 * 넥슨 `/maplestory/v1/character/list` **1콜**. 서버 캐시 15분, 호출량은
 * `nexon_api_quota_usage` 에 자격증명·일자별로 적힌다.
 *
 * ⚠️ 이 응답에는 **이미지가 없다.** 초상화는 `/api/nexon/character/basic` 이며
 *    캐릭터당 1콜이라 화면에 보이는 만큼만 부른다(§2.1.1).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const context = await resolveNexonProxyContext(request);
    const result = await fetchCharacterList(context.apiKey, context.gateway);
    return jsonOk<NexonCharacterListResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/nexon/character/list");
  }
}
