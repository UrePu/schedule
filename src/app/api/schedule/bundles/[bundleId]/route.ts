import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  archivePartyBundle,
  updatePartyBundle,
} from "@/features/schedule/server/schedule-repo";
import type { PartyBundlesResponse } from "@/features/schedule/types";

import { saveBundleSchema } from "../../parties/[partyId]/bundles/route";

/**
 * `PATCH  /api/schedule/bundles/{bundleId}` — 묶음 고치기 (세션 필요)
 * `DELETE /api/schedule/bundles/{bundleId}` — 묶음 **보관** (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 경로에 파티가 없는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음 행이 `party_id` 를 들고 있으므로 id 하나로 파티를 되찾을 수 있다. 경로에 파티를
 * 또 적게 하면 **두 값이 어긋난 요청**이 가능해지고, 어긋났을 때 무엇이 옳은지 정할 방법이
 * 없다. 권한 판정은 되찾은 파티로 한다(`requirePartyMembership`) — 즉 경로가 짧아져도
 * 검사는 한 글자도 줄지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT` 이 아니라 `PATCH` 인 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음은 네 가지(보스 · 이름 · 캐릭터 · 분배)를 들고 있고, 화면은 그중 **한 가지만** 고치는
 * 저장을 실제로 한다(분배만 · 내 캐릭터만). `PUT` 으로 두면 그런 저장마다 나머지 셋을 다시
 * 실어 보내야 하고, 60초 stale 캐시의 값을 되돌려 보내는 순간 **다른 파티원이 방금 넣은
 * 값이 지워진다** — 2026-10-11 에 보스 소요 시간으로 실제로 일어난 사건이다.
 *
 * ⚠️ 스키마는 만들기 라우트와 **같은 것을 가져다 쓴다.** 두 벌로 두면 "만들 때는 저장되는데
 *    고칠 때는 안 되는 칸" 이 반드시 생긴다(repo 가 몸통 하나를 공유하는 것과 같은 근거).
 *
 * ⚠️ **보관이지 삭제가 아니다.** 과거 런이 그 묶음을 가리키고, 그 행이 "이 돈이 왜 이렇게
 *    나뉘었나" 를 설명한다 — 자세한 근거는 `archivePartyBundle` 머리말.
 *    `DELETE` 라는 메서드 이름을 쓰는 것은 **사용자에게 보이는 뜻**(목록에서 사라진다)이
 *    그것이기 때문이고, 파티 해체(`DELETE .../parties/{id}`)가 이미 같은 규약이다.
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bundleId: string }> },
): Promise<Response> {
  try {
    const { bundleId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, saveBundleSchema);
    const bundles = await updatePartyBundle(session.uid, bundleId, body);
    return jsonOk<PartyBundlesResponse>({ bundles });
  } catch (error) {
    return handleRouteError(error, "api/schedule/bundles/[bundleId]#PATCH");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bundleId: string }> },
): Promise<Response> {
  try {
    const { bundleId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const bundles = await archivePartyBundle(session.uid, bundleId);
    return jsonOk<PartyBundlesResponse>({ bundles });
  } catch (error) {
    return handleRouteError(error, "api/schedule/bundles/[bundleId]#DELETE");
  }
}
