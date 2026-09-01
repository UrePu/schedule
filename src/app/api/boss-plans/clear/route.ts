import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchWeeklyChecklist } from "@/features/boss-plans/server/boss-plan-repo";
import type { ChecklistResponse } from "@/features/boss-plans/types";
import { setPlanClear } from "@/features/income/server/income-repo";

/**
 * `PUT /api/boss-plans/clear` — **12칸을 눌러 클리어로 표시 / 해제** (세션 필요)
 *
 * 본문 `{ characterId, bossDifficultyId, cleared }` · 응답 `{ characters }` — 체크리스트 전체
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시 2026-08-31 — *"이번주 현황에서 클릭하면 클리어 판정 되게 해줘"*
 * ─────────────────────────────────────────────────────────────────────────────
 * `/boss-status` 는 지금까지 **읽기 전용**이었다. 잡은 것을 반영하는 길이 둘뿐이었는데
 * 둘 다 이 화면에서는 닿지 않는다 —
 *   · 넥슨 동기화: ~15분 지연(§1.1)이고, 월간 보스는 스케줄러 응답에 없는 경우가 있다.
 *   · 시간표의 클리어 체크: **등록한 일정**이 있어야 한다(`setRunClear`).
 * 그래서 계획만 있고 일정이 없는 보스는 잡아도 원장에 들어갈 길이 없었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `/api/income/*` 이 아니라 여기인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 쓰는 대상은 `boss_clears`(수익 원장)지만, **부르는 화면과 돌려줄 데이터는 체크리스트**다.
 * 다른 쓰기 API 와 같은 규약(§ `party-size/route.ts` 머리말)대로 *바뀐 뒤의 컬렉션 전체*를
 * 응답으로 주려면 여기가 그 컬렉션의 집이다. 실제 쓰기 규칙은 `setPlanClear()` 가 갖고
 * 있고 그 함수는 `setRunClear()` 바로 옆에 산다 — 원장 규칙이 갈라지지 않게.
 *
 * ★ **넥슨 호출 0건.** 우리 DB 에만 쓴다.
 * ★ 권한·검증은 전부 `setPlanClear()` 가 한다 — 남의 캐릭터는 404(존재조차 알리지 않는다).
 */

const setClearSchema = z.object({
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
  bossDifficultyId: z
    .string()
    .trim()
    .min(1, "보스 항목이 필요합니다.")
    .max(64, "보스 항목 형식이 올바르지 않습니다."),
  cleared: z.boolean({ error: "클리어 여부를 지정해 주세요." }),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setClearSchema);
    await setPlanClear(
      session.uid,
      body.characterId,
      body.bossDifficultyId,
      body.cleared,
    );

    const characters = await fetchWeeklyChecklist(session.uid);
    return jsonOk<ChecklistResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/clear#PUT");
  }
}
