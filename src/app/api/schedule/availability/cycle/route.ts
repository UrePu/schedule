import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { AvailabilityCycleResponse } from "@/features/schedule/data/schedule-queries";
import { MAX_CYCLE_DAYS } from "@/features/schedule/lib/pattern-slots";
import {
  clearMyAvailabilityCycle,
  fetchMyAvailabilityCycle,
} from "@/features/schedule/server/schedule-repo";
import { setMyAvailabilityCycle } from "@/features/schedule/server/schedule-repo";

/**
 * `GET`    — 내 교대 주기(없으면 `cycle: null`)
 * `PUT`    — 주기를 켜거나 바꾼다
 * `DELETE` — 주기를 끈다(= 요일 패턴으로 돌아간다)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 별도 경로인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 패턴과 함께 저장하지 않는다. 주기를 바꾸는 것과 격자를 칠하는 것은 **실패했을 때의 뜻이
 * 다르다** — 주기만 바뀌고 격자가 안 들어가면 가용시간이 비고(거짓 "불가", 싸다),
 * 격자만 들어가고 주기가 안 바뀌면 엉뚱한 날짜에 가능으로 뜬다(거짓 "가능", 비싸다).
 * 두 쓰기를 한 요청에 묶으면 후자를 만들 수 있는 순서가 반드시 생긴다.
 *
 * ★ 대상은 **언제나 세션 본인**이다. "누구의 주기인가"를 받는 자리가 없다.
 */

const cycleSchema = z.object({
  cycleDays: z
    .number()
    .int()
    .min(2, "주기는 2일 이상이어야 합니다.")
    .max(MAX_CYCLE_DAYS, `주기는 ${String(MAX_CYCLE_DAYS)}일을 넘을 수 없습니다.`),
  /** 주기 0번 칸의 KST 날짜. `yyyy-MM-dd` 만 받는다 — 순간이 아니라 달력 날짜다. */
  anchorDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "기준 날짜 형식이 올바르지 않습니다."),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const cycle = await fetchMyAvailabilityCycle(session.uid);
    return jsonOk<AvailabilityCycleResponse>({ cycle });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/cycle#GET");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, cycleSchema);
    const cycle = await setMyAvailabilityCycle(session.uid, {
      cycleDays: body.cycleDays,
      anchorDate: body.anchorDate,
    });
    return jsonOk<AvailabilityCycleResponse>({ cycle });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/cycle#PUT");
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    await clearMyAvailabilityCycle(session.uid);
    return jsonOk<AvailabilityCycleResponse>({ cycle: null });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/cycle#DELETE");
  }
}
