import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { BulkRunRemovalResponse } from "@/features/schedule/data/schedule-queries";
import {
  MAX_BULK_RUN_REMOVAL,
  removePartyRuns,
} from "@/features/schedule/server/schedule-repo";

/**
 * `POST /api/schedule/runs/remove-many` — 연속 일정 **묶음 삭제**
 *
 * 발주자(2026-08-20): *"이거 한번에 삭제하는것좀 만들어줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `DELETE /api/schedule/runs` 가 아니라 POST 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 지울 대상이 **목록**이라 본문이 필요한데, DELETE 의 본문은 스펙상 의미가 정의돼 있지
 * 않고 중간 프록시가 버리는 경우가 있다. 낱개 삭제(`DELETE /runs/{id}`)는 대상이 경로에
 * 있으므로 그대로 둔다 — 규약을 바꾸는 것이 아니라, 본문이 필요한 쪽만 POST 로 받는다.
 *
 * ★ 정적 구간이라 `[runId]` 보다 먼저 매칭된다. 런 id 는 uuid 이므로 충돌하지 않는다.
 * ★ 권한과 취소/삭제 판정은 **낱개와 같은 함수**가 한다(`removePartyRuns` 머리말).
 *   여기서 다시 판단하지 않는다.
 */

const bodySchema = z.object({
  runIds: z
    .array(z.string().uuid("일정을 찾을 수 없습니다."))
    .min(1, "지울 일정이 없습니다.")
    .max(
      MAX_BULK_RUN_REMOVAL,
      `한 번에 ${String(MAX_BULK_RUN_REMOVAL)}건까지만 지울 수 있습니다.`,
    ),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const result = await removePartyRuns(session.uid, body.runIds);

    return jsonOk<BulkRunRemovalResponse>({
      deletedCount: result.deletedCount,
      cancelledCount: result.cancelledCount,
      partyId: result.partyId,
      weekKeys: [...result.weekKeys],
    });
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/remove-many#POST");
  }
}
