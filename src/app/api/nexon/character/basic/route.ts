import { z } from "zod";

import { fetchCharacterBasic } from "@/lib/nexon/client";
import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  assertOwnedOcid,
  resolveNexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import type { NexonCharacterBasicResult } from "@/lib/nexon/types";

/**
 * `GET /api/nexon/character/basic?ocid=...`
 *
 * 헤더  `x-nexon-api-key: <사용자 키>`
 * 응답  `{ ocid, characterName, worldName, characterClass, characterLevel, guildName, imageUrl }`
 *
 * **캐릭터당 1콜**이다. 실측 계정이 59명이므로 전부 부르면 하루 예산(1,000)의 6%가
 * 한 번에 날아간다. 그래서 캐릭터 선택 모달은 **보이는 12명분만** 부른다(§2.1.1).
 *
 * ★ `imageUrl: null` 은 **정상 상태**다. 화면은 실루엣을 그리고, 에러로 취급하지 않는다.
 */

const querySchema = z.object({
  ocid: z
    .string()
    .trim()
    .min(1, "ocid 가 필요합니다.")
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "ocid 형식이 올바르지 않습니다."),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = querySchema.safeParse({
      ocid: new URL(request.url).searchParams.get("ocid") ?? "",
    });
    if (!parsed.success) {
      throw ApiError.badRequest(
        parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.",
      );
    }

    /*
     * ★ 대상(ocid)을 먼저 정하고 컨텍스트를 만든다 — 그래야 서버가 **그 캐릭터가 속한
     *   계정의 키**를 DB 에서 꺼내 쓴다(§2.1.2). 부계정 캐릭터의 초상화가 브라우저에
     *   키가 없다는 이유로 실루엣에 머무르지 않게 하는 지점이다.
     */
    const context = await resolveNexonProxyContext(request, {
      kind: "ocid",
      ocid: parsed.data.ocid,
    });

    // 남의 ocid 는 넥슨도 거절하지만(OPENAPI00004), 그 거절은 **호출을 태운 뒤**에 온다.
    await assertOwnedOcid(context, parsed.data.ocid);

    const result = await fetchCharacterBasic(
      context.apiKey,
      parsed.data.ocid,
      context.gateway,
    );
    return jsonOk<NexonCharacterBasicResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/nexon/character/basic");
  }
}
