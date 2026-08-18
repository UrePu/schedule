import { z } from "zod";

import { fetchSchedulerCharacterState } from "@/lib/nexon/client";
import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  assertOwnedOcid,
  resolveNexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import type { NexonSchedulerStateResult } from "@/lib/nexon/types";

/**
 * `GET /api/nexon/scheduler/character-state?ocid=...&date=YYYY-MM-DD`
 *
 * 헤더  `x-nexon-api-key: <사용자 키>`
 * 응답  정규화된 스케줄러 상태 (`bosses[]` 의 플래그는 **불리언**, `cycle` 은 우리 enum)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 엔드포인트가 조용히 틀리기 쉬운 지점 두 개 (둘 다 여기서 막았다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **플래그가 문자열 `"true"` / `"false"`** 다. 그대로 쓰면 `"false"` 가 참이라
 *    안 깬 보스가 전부 깬 것으로 집계된다. `parseNexonFlag` 이 경계에서 접는다.
 * 2. **`cycle` 은 `bossWeekly` 같은 camelCase** 라 우리 `boss_cycle` enum 과 다르다.
 *    매핑하지 않으면 INSERT 가 enum 위반으로 죽는다.
 *
 * `date` 는 **7일 전까지 확인**됐고 30일 전은 `OPENAPI00004` 로 거절된다(실측).
 * 정확한 경계는 미측정이라 여기서 범위를 강제하지 않고 넥슨의 판정을 그대로 전달한다.
 *
 * ★ **빈 응답은 "그날 접속하지 않았다"이며 에러가 아니다**(§1.1).
 *   `bosses: []` 로 내려가고 화면은 빈 상태를 그린다.
 */

const querySchema = z.object({
  ocid: z
    .string()
    .trim()
    .min(1, "ocid 가 필요합니다.")
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "ocid 형식이 올바르지 않습니다."),
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date 는 YYYY-MM-DD 형식이어야 합니다.")
    .optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const date = params.get("date");
    const parsed = querySchema.safeParse({
      ocid: params.get("ocid") ?? "",
      ...(date !== null ? { date } : {}),
    });
    if (!parsed.success) {
      throw ApiError.badRequest(
        parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.",
      );
    }

    /*
     * ★ **쿼리를 먼저 읽고 대상을 넘긴다** (§2.1.2). 서버가 그 ocid 의 계정 키를 DB 에서
     *   꺼내 쓰므로, 브라우저에 키가 하나도 없어도 이 호출은 성립한다. 헤더 키는 서버에
     *   아직 키가 없을 때의 하위 호환 경로로만 쓰인다.
     */
    const context = await resolveNexonProxyContext(request, {
      kind: "ocid",
      ocid: parsed.data.ocid,
    });

    await assertOwnedOcid(context, parsed.data.ocid);

    const result = await fetchSchedulerCharacterState(
      context.apiKey,
      parsed.data.ocid,
      parsed.data.date !== undefined ? { date: parsed.data.date } : undefined,
      context.gateway,
    );
    return jsonOk<NexonSchedulerStateResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/nexon/scheduler/character-state");
  }
}
