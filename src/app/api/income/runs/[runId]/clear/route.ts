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
  setRunClear,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `PUT /api/income/runs/{runId}/clear` — 등록한 일정을 클리어로 표시 / 해제 (세션 필요)
 *
 * 본문 `{ cleared: boolean, weekKey?: string }` · 응답 `{ detail }` — 화면 전체
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자 요구의 2순위 기능이다 (§1.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"등록해두고 클리어 하면 체크 → 그 주의 수익으로 자동 합산."* 체크가 켜지는 순간
 * `boss_clears` 에 그 주차의 행이 생기고, 트리거가 그 시점 시세로 pot 과 내 몫을 찍는다.
 * 합산은 `v_weekly_income` 이 이미 하고 있으므로 **우리가 더할 것이 없다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 관측을 덮어쓰지 않는다 (DB-SCHEMA 난제 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * 우리는 `manual_cleared` / `manual_set_at` 두 컬럼만 쓴다. 두 출처가 다르면
 * `has_conflict` 가 켜지고 화면이 **어느 쪽이 반영됐는지** 보여 준다. 조용히 한쪽을
 * 지우면 사용자는 자기 체크가 왜 사라졌는지 알 수 없다.
 *
 * 권한·검증은 전부 `setRunClear()` 가 한다 — 파티 밖이면 404(존재조차 알리지 않는다),
 * 참여(going)가 아니면 403, 캐릭터 미지정이면 400. 라우트에 복제하지 않는다.
 */

const clearSchema = z.object({
  cleared: z.boolean({ error: "클리어 여부를 지정해 주세요." }),
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, clearSchema);
    await setRunClear(session.uid, runId, body.cleared);

    const detail = await fetchWeeklyIncomeDetail(
      session.uid,
      body.weekKey ?? getWeekKey(new Date()),
    );
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income/runs/[runId]/clear#PUT");
  }
}
