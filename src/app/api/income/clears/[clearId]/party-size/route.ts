import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  fetchWeeklyIncomeDetail,
  updateClearPartySize,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `PUT /api/income/clears/{clearId}/party-size` — 입장 인원 수정 (세션 필요)
 *
 * 본문 `{ partySize: 1..24 }` · 응답 `{ detail }` — 다시 계산된 **화면 전체**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 엔드포인트가 필요한가 (§1.3 D3)
 * ─────────────────────────────────────────────────────────────────────────────
 * 결정석 표시가는 **솔로 기준**이고 실수령액은 `floor(가격 / 파티 인원)` 이다. 넥슨 API
 * 에는 파티 정보가 아예 없어서(§1.1) 관측만으로 만들어진 클리어는 인원이 DB 기본값
 * **1** 로 들어간다 — 6인 파티 보스라면 그 한 건이 **6배**로 잡힌다. D3 는 인원을
 * "실제로 들어간 인원"으로 정의하고 **사용자가 고칠 수 있어야 한다**고 못박았는데
 * 그 수단이 없었다. 이 라우트가 그 수단이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 상한은 **막지 않는다** (§1.3 D5)
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기서 검사하는 것은 DB CHECK 범위(1~24)뿐이고 보스별 `max_party` 와는 대조하지
 * 않는다. `max_party = 6` 값 대부분이 개별 출처가 아니라 세대 규칙에서 유도된 값이라,
 * 실제 파티가 그 값을 넘는데 저장이 거부되면 사용자가 앱을 못 쓴다. 초과는 화면이
 * **경고**로 처리한다.
 *
 * 소유권 판정은 `updateClearPartySize()` 가 한다 — 남의 기록·없는 기록 모두 **404** 다.
 * 라우트에 복제하지 않는다. 두 곳에 두면 반드시 갈라진다.
 */

const partySizeSchema = z.object({
  partySize: z
    .number({ error: "파티 인원을 입력해 주세요." })
    .int("파티 인원은 정수여야 합니다.")
    .min(PARTY_SIZE_MIN, `파티 인원은 ${PARTY_SIZE_MIN}명 이상이어야 합니다.`)
    .max(PARTY_SIZE_MAX, `파티 인원은 ${PARTY_SIZE_MAX}명 이하여야 합니다.`),
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

    const body = await readJsonBody(request, partySizeSchema);
    await updateClearPartySize(session.uid, clearId, body.partySize);

    const detail = await fetchWeeklyIncomeDetail(
      session.uid,
      body.weekKey ?? getWeekKey(new Date()),
    );
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(
      error,
      "api/income/clears/[clearId]/party-size#PUT",
    );
  }
}
