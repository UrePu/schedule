import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchWeeklyIncomeDetail } from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `GET /api/income?weekKey=2026-W33` — 그 주차의 수익 상세 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **비로그인은 401 이다.** 이 화면은 공개면이 아니다
 * ─────────────────────────────────────────────────────────────────────────────
 * 공개 시간표는 "언제 무슨 보스를 간다"까지이고(§2.1), 개인의 **수익 금액**은 거기에
 * 들어가지 않는다. `boss_clears` 와 수익 뷰는 anon 에게 GRANT 자체가 없고
 * (`%meso%` / `%share%` 패턴은 `assert_no_public_sensitive_columns()` 가 감시한다),
 * 이 엔드포인트도 같은 경계를 지킨다.
 *
 * `weekKey` 를 생략하면 **지금이 속한 주차**다 — 주차 경계는 KST 목요일 00:00 이며
 * 계산은 `getWeekKey()` 한 곳뿐이다(DB `public.week_key()` 와 값이 일치하도록 검증됨).
 */

/** `2026-W33` 형태만 받는다. DB CHECK(`^[0-9]{4}-W[0-9]{2}$`)와 같은 모양이다. */
const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

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

    const detail = await fetchWeeklyIncomeDetail(session.uid, weekKey);
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income#GET");
  }
}
