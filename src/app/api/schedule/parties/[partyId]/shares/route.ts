import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchPartyShares,
  resetPartySharesToEqual,
  setPartyShares,
} from "@/features/schedule/server/schedule-repo";
import {
  RUN_SHARE_WEIGHT_MAX,
  type PartySharesPayload,
} from "@/features/schedule/types";

/**
 * `GET    /api/schedule/parties/{partyId}/shares` — 이 파티의 분배 설정 (세션 필요)
 * `PUT    /api/schedule/parties/{partyId}/shares` — 사용자 지정 비율 저장 (세션 필요)
 * `DELETE /api/schedule/parties/{partyId}/shares` — 균등으로 되돌리기 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 런이 아니라 파티인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자(2026-08-19): *"분배를 보스별로 붙이지말고 파티 자체에 설정을 넣어줘"* ·
 * *"분배조율도 파티 설정에 있어야된다고 했잖슴"*.
 *
 * DB 는 이미 그렇게 저장한다(`parties.share_mode` + `party_participants.share_bp`,
 * 마이그레이션 `20260819200000`). 형제 라우트 `runs/{runId}/shares` 는 같은 컬럼에 쓰지만
 * **입구가 일정 카드**라 사용자에게는 보스별 설정처럼 보였다. 이 라우트가 그 입구를
 * 파티 설정으로 옮긴 자리이며, 화면은 이제 이쪽만 부른다.
 *
 * ⚠️ **비율은 정산 값이다.** 세 메서드 모두 세션이 필요하고, repo 가 **파티 구성원인지**
 *    까지 확인한다. 공개 시간표(비로그인)에는 절대 실리지 않는다 — 그 실수가 B-5 였다.
 * ⚠️ 보이지 않는 파티는 **404**. 403 은 "그 파티는 존재한다"를 알려 준다.
 */

/**
 * `weight` 는 **화면이 100 을 곱해 보낸 정수**다(`RUN_SHARE_WEIGHT_SCALE`).
 * `1 : 2` 는 `100 : 200`, `33.33 : 66.67` 은 `3333 : 6667` 로 온다. 비율은 배율에
 * 불변이라 결과가 같고, `distribute_meso(p_weights integer[])` 가 정수만 받는다.
 *
 * 오류 문구를 한국어로 못박는 이유는 형제 라우트와 같다 — zod 기본 영문이
 * `readJsonBody` 를 통해 그대로 화면에 나간다.
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
    .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const payload = await fetchPartyShares(session.uid, partyId);
    return jsonOk<PartySharesPayload>(payload);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/shares#GET");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setSharesSchema);

    const payload = await setPartyShares(session.uid, partyId, body.weights);
    return jsonOk<PartySharesPayload>(payload);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/shares#PUT");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const payload = await resetPartySharesToEqual(session.uid, partyId);
    return jsonOk<PartySharesPayload>(payload);
  } catch (error) {
    return handleRouteError(
      error,
      "api/schedule/parties/[partyId]/shares#DELETE",
    );
  }
}
