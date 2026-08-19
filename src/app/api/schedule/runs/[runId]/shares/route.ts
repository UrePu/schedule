import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchRunShares,
  resetRunSharesToEqual,
  setRunShares,
} from "@/features/schedule/server/schedule-repo";
import {
  RUN_SHARE_WEIGHT_MAX,
  type RunSharesPayload,
} from "@/features/schedule/types";

/**
 * `GET    /api/schedule/runs/{runId}/shares` — 이 일정의 분배 배율 한 벌 (세션 필요)
 * `PUT    /api/schedule/runs/{runId}/shares` — 사용자 지정 배율 저장 (세션 필요)
 * `DELETE /api/schedule/runs/{runId}/shares` — 균등으로 되돌리기 (세션 필요)
 *
 * 발주 지시(2026-08-19): *"파티 설정할때 분배 배율 설정하는 칸도 있어야함. 단순히 2인이면
 * 1:1 이 아니라 스펙에 차이나는 사람끼리 1:2 분배 하는경우도있음"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 형제 라우트(`.../signup` · `.../runs/[runId]`)와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 401
 *   2) `readJsonBody(request, schema)` (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 상태 전체**를 돌려준다 — 화면이 부분 갱신을 조립하지 않아도 된다
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 왜 `DELETE` 가 "균등으로 되돌리기" 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 지우는 대상은 런이 아니라 **사용자 지정 비율**이다. 지우고 나면 `share_mode` 가
 * `auto_equal` 로 돌아가고 참가자가 바뀔 때마다 균등 재계산이 다시 붙는다 — 즉
 * "이 리소스(사용자 지정 배율)를 없앤다"가 정확히 이 동작이다. `PUT` 에 균등 플래그를
 * 넣는 대안은 같은 요청이 두 가지 일을 하게 만들어 검증 분기가 갈라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 비율은 **일정(run)** 에 붙는다. 파티가 아니다.
 * ─────────────────────────────────────────────────────────────────────────────
 * 결정석 pot 은 그 보스에 **실제로 같이 들어간 사람들**이 나눈다. 6인 파티에서 4명만
 * 간 런이면 그 4명 사이에서 합이 100% 여야 하므로 파티 단위로는 표현할 수 없다.
 * 스키마도 그래서 `run_signups.share_bp` 다.
 *
 * ⚠️ 만분율(`share_bp`) 환산과 잔돈 배분은 **서버도 하지 않는다** — `distribute_meso()`
 *    가 한다. 라우트는 사용자가 친 **가중치**를 그대로 통과시킬 뿐이다.
 */

/**
 * ⚠️ 오류 문구까지 한국어로 못박는다. zod 기본 영문이 `readJsonBody` 를 통해 그대로
 *    화면에 나가기 때문이다(형제 라우트의 같은 주석 참고).
 *
 * `weight` 는 **화면이 100 을 곱해 보낸 정수**다(`RUN_SHARE_WEIGHT_SCALE`).
 * `1 : 2` 는 `100 : 200` 으로, `33.33 : 66.67` 은 `3333 : 6667` 로 온다. 비율은 배율에
 * 불변이라 결과는 같고, `distribute_meso(p_weights integer[])` 가 정수만 받는다.
 */
const setSharesSchema = z.object({
  weights: z
    .array(
      z.object({
        participantId: z.uuid("참가자 식별자 형식이 올바르지 않습니다."),
        weight: z
          .number({ error: "분배 배율 형식이 올바르지 않습니다." })
          .int("분배 배율은 정수로 보내야 합니다.")
          .min(0, "분배 배율은 0 이상이어야 합니다.")
          .max(RUN_SHARE_WEIGHT_MAX, "분배 배율이 너무 큽니다."),
      }),
    )
    .min(1, "분배 배율을 한 명 이상 보내야 합니다.")
    .max(24, "한 일정의 참가자는 24명을 넘을 수 없습니다."),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const payload = await fetchRunShares(session.uid, runId);
    return jsonOk<RunSharesPayload>(payload);
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]/shares#GET");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setSharesSchema);

    const payload = await setRunShares(session.uid, runId, body.weights);
    return jsonOk<RunSharesPayload>(payload);
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]/shares#PUT");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const payload = await resetRunSharesToEqual(session.uid, runId);
    return jsonOk<RunSharesPayload>(payload);
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]/shares#DELETE");
  }
}
