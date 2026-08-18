import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { loadSessionUser } from "@/features/auth/server/account";
import { readSession } from "@/features/auth/server/session";
import {
  fetchDashboardData,
  type DashboardData,
} from "@/features/dashboard/server/dashboard-repo";
import { getAdminDb } from "@/lib/supabase/admin-db";
import { getWeekKey } from "@/lib/time/week";

/**
 * `GET /api/dashboard?weekKey=2026-W33` — 대시보드 한 화면분 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 엔드포인트가 새로 필요한가
 * ─────────────────────────────────────────────────────────────────────────────
 * 대시보드는 지금까지 서버 컴포넌트가 `fetchDashboardData()` 를 부르고 그 결과를 **props
 * 로** 내려보냈다. props 는 `invalidateQueries()` 가 닿을 수 없는 자리라, 클리어를 체크해도
 * 계획을 꺼도 대시보드의 수익·12칸은 새로고침 전까지 낡은 값 그대로였다 (§2.4 Rule 1).
 *
 * 캐시가 화면을 소유하려면 **클라이언트가 다시 받아 올 경로**가 있어야 한다. 서버 repo 는
 * service_role 이라 브라우저가 직접 부를 수 없으므로, 다른 화면과 똑같이 Route Handler 를
 * 둔다. 서버 컴포넌트는 이제 같은 repo 를 불러 **쿼리 캐시에 심고**(prefetch), 이 경로는
 * 그 뒤의 재조회를 담당한다.
 *
 * ⚠️ **넥슨을 부르지 않는다.** `fetchDashboardData` 는 우리 DB 만 읽는다. 동기화(캐릭터당
 *    1콜)는 사용자가 버튼을 누를 때와 자동 동기화 훅에서만 나간다 (§1.1.1 · §1.1).
 *
 * ⚠️ **비로그인은 401 이다.** 수익 금액과 캐릭터별 진행 상황은 공개면이 아니다(§2.1).
 *    이 쿼리는 대시보드가 렌더될 때만(=세션이 있을 때만) 마운트되므로 401 이 화면에
 *    번쩍일 자리가 없다 — `/api/income` 과 같은 경계다.
 */

/** `2026-W33` 형태만 받는다. DB CHECK(`^[0-9]{4}-W[0-9]{2}$`)와 같은 모양이다. */
const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    /*
     * 계정 상태를 여기서도 본다. 정지·삭제된 계정에 수익 원장을 돌려주면, 화면은 이미
     * 랜딩으로 떨어졌는데 API 만 계속 답하는 상태가 된다.
     */
    const user = await loadSessionUser(getAdminDb(), session.uid);
    if (user === null || user.status !== "active") {
      throw ApiError.unauthenticated();
    }

    const raw = new URL(request.url).searchParams.get("weekKey");
    const parsed = raw === null ? null : weekKeySchema.safeParse(raw);
    if (parsed !== null && !parsed.success) {
      throw ApiError.badRequest("주차 형식이 올바르지 않습니다. (예: 2026-W33)");
    }
    const weekKey = parsed === null ? getWeekKey(new Date()) : parsed.data;

    const data = await fetchDashboardData(user.id, weekKey);
    return jsonOk<DashboardData>(data);
  } catch (error) {
    return handleRouteError(error, "api/dashboard#GET");
  }
}
