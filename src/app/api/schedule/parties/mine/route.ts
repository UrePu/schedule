import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchMyParties,
  type DashboardParty,
} from "@/features/dashboard/server/dashboard-repo";
import { getWeekKey } from "@/lib/time/week";

/**
 * `GET /api/schedule/parties/mine?weekKey=2026-W33` — **내가 속한 파티만** (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `GET /api/schedule/parties` 와 의도적으로 다르다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그쪽은 "볼 수 있는 것"이라 **남의 공개 파티까지** 준다. 일정 등록은 파티 구성원만 할 수
 * 있어서(서버가 403 으로 거른다) 등록 후보 목록에 공개 파티가 섞이면 사용자는 고를 수
 * 없는 것을 고르게 된다. 그래서 계획 화면(`/boss-plans`)의 일정 모달은 이 경로를 쓴다.
 *
 * 예전에는 서버 컴포넌트가 `fetchMyParties()` 를 불러 **props 로** 내려보냈다. 그러면
 * 파티를 새로 만들거나 일정을 잡아도 그 화면의 목록은 새로고침 전까지 낡은 채였다
 * (§2.4 Rule 1). 이제 캐시가 소유하고, 재조회는 이 경로가 받는다.
 *
 * ⚠️ **넥슨 호출 0건.** 우리 DB(`parties` · `party_participants` · `party_runs`)만 읽는다.
 * ⚠️ 세션이 없으면 401 이다 — "내 파티"는 세션 없이 정의되지 않는다.
 *
 * `weekKey` 가 인자인 이유: 응답에 **그 주의 일정 건수**(`runCountThisWeek`)가 실린다.
 * 주차 경계는 KST 목요일 00:00 이고 계산은 `getWeekKey()` 한 곳뿐이다.
 */

/** `2026-W33` 형태만 받는다. DB CHECK(`^[0-9]{4}-W[0-9]{2}$`)와 같은 모양이다. */
const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

export interface MyPartiesResponse {
  readonly parties: readonly DashboardParty[];
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const raw = new URL(request.url).searchParams.get("weekKey");
    const parsed = raw === null ? null : weekKeySchema.safeParse(raw);
    if (parsed !== null && !parsed.success) {
      throw ApiError.badRequest("주차 형식이 올바르지 않습니다. (예: 2026-W33)");
    }
    const weekKey = parsed === null ? getWeekKey(new Date()) : parsed.data;

    const parties = await fetchMyParties(session.uid, weekKey);
    return jsonOk<MyPartiesResponse>({ parties });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/mine#GET");
  }
}
