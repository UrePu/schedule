import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchWeeklyIncomeDetail,
  updateClearCharacter,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `PUT /api/income/clears/{clearId}/character` — 클리어의 귀속 캐릭터 변경 (세션 필요)
 *
 * 본문 `{ characterId }` · 응답 `{ detail }` — 다시 만든 **화면 전체**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 엔드포인트가 필요한가 (§1)
 * ─────────────────────────────────────────────────────────────────────────────
 * "이 보스를 **어느 캐릭터로** 도는가"가 수익 원장의 1층이다. 주간 결정석 12개 상한이
 * **캐릭터당**이므로, 캐릭터가 틀리면 금액은 맞아도 **어느 캐릭터가 12개를 다 썼는지**가
 * 틀린다 — 그게 사용자가 다음 주 계획을 세울 때 보는 숫자다.
 *
 * ★ 금액은 이 변경으로 움직이지 않는다. 분배는 사람(`user_id`) 단위이고, 내 캐릭터끼리
 *   옮기는 것은 사람을 바꾸지 않는다. 재계산도 재스냅샷도 일어나지 않는다.
 *
 * 소유·추적·중복 판정은 전부 `updateClearCharacter()` 안에 있다. 라우트에 복제하지
 * 않는다 — 두 곳에 두면 반드시 갈라진다(`party-size` 라우트와 같은 규약).
 */

const characterSchema = z.object({
  characterId: z
    .string({ error: "캐릭터를 선택해 주세요." })
    .uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
  /** 응답으로 다시 그릴 주차. 생략하면 지금 주차다. 화면이 보고 있는 주차를 넘긴다. */
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ clearId: string }> },
): Promise<Response> {
  try {
    const { clearId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, characterSchema);
    await updateClearCharacter(session.uid, clearId, body.characterId);

    const detail = await fetchWeeklyIncomeDetail(
      session.uid,
      body.weekKey ?? getWeekKey(new Date()),
    );
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income/clears/[clearId]/character#PUT");
  }
}
