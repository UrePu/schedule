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

    /*
      ═══════════════════════════════════════════════════════════════════════════
      **받아 온 초상화를 버리지 않고 저장한다** (발주 지시 2026-09-02: *"api 가져와서
      못넣어?"*)
      ═══════════════════════════════════════════════════════════════════════════
      실측(2026-09-02): `characters.image_url` 이 **1,116행 전부 비어 있었다.** 캐릭터
      선택 모달이 카드마다 이 라우트를 부르면서도 결과를 화면에만 쓰고 흘려보냈기
      때문이다. 그래서 초상화가 필요한 다른 화면(파티 고르기 등)은 쓸 그림이 없었고,
      쓰려면 그 화면이 **또 넥슨을 불러야** 했다 — 캐릭터당 1콜, 하루 1,000콜 예산에서
      감당할 수 없는 값이다.

      한 번 부른 것을 적어 두면 그 뒤로는 **공짜**다. 이 라우트는 이미 호출을 태웠으므로
      저장에 드는 추가 비용은 DB 쓰기 한 번뿐이다.

      ★ **소유 확인 뒤에만** 쓴다(`assertOwnedOcid` 위). `user_id` 까지 조건에 넣어
        남의 행에 손댈 수 없게 한다 — 조건이 둘이면 ocid 가 재발급돼 겹쳐도 안전하다.
      ★ 레벨·직업·길드도 함께 갱신한다. 같은 응답에 들어 있고, 이 값들은 게임에서 계속
        변한다 — 초상화만 새로 적고 레벨은 옛것으로 두면 한 행 안에서 시점이 갈린다.
      ★ **실패해도 응답은 그대로 나간다.** 저장은 부수 효과이고 사용자가 요청한 것은
        초상화다. 여기서 던지면 그림을 받아 놓고도 화면이 실루엣이 된다.
    */
    {
      const { error } = await context.db
        .from("characters")
        .update({
          image_url: result.imageUrl,
          character_level: result.characterLevel,
          character_class: result.characterClass,
          guild_name: result.guildName,
        })
        .eq("ocid", parsed.data.ocid)
        .eq("user_id", context.userId);
      if (error !== null) {
        console.warn(`[api/nexon/character/basic] 초상화 저장 실패: ${error.message}`);
      }
    }

    return jsonOk<NexonCharacterBasicResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/nexon/character/basic");
  }
}
