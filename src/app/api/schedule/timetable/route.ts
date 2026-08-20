import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchMyTimetable } from "@/features/schedule/server/timetable-repo";
import type { TimetableResponse } from "@/features/schedule/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `GET /api/schedule/timetable?weekKey=2026-W33` — **내가 가는 런만** (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 비로그인이 401 인가 — 공개 시간표(`/schedule`)와 다른 물건이다
 * ─────────────────────────────────────────────────────────────────────────────
 * `/schedule` 의 겹쳐보기는 **파티의** 시간표라 공개면에 실린다. 이쪽은 "**내가** 어느
 * 캐릭터로 어디에 간다"이고, 그건 세션 없이는 대상 자체가 정의되지 않는다. 물어볼 사람이
 * 없는 질문이라 빈 배열이 아니라 401 이다.
 *
 * `weekKey` 를 생략하면 지금이 속한 주차다(KST 목 00:00 경계).
 */

/** DB CHECK(`^[0-9]{4}-W[0-9]{2}$`)와 같은 모양. */
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

    const runs = await fetchMyTimetable(session.uid, weekKey);
    return jsonOk<TimetableResponse>({ runs });
  } catch (error) {
    return handleRouteError(error, "api/schedule/timetable#GET");
  }
}
