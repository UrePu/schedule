import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchMyAvailabilityMode,
  setMyAvailabilityMode,
} from "@/features/schedule/server/schedule-repo";
import type { AvailabilityModeState } from "@/types/domain";

/**
 * `GET` — 내 가능시간 방식(행이 없으면 `{ mode: "weekly", chosen: false }`)
 * `PUT` — 방식을 고른다
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 별도 경로인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 주기(`/cycle`)와 같은 이유로 패턴 저장과 묶지 않는다. 방식과 격자는 **실패했을 때의 뜻이
 * 다르다** — 방식만 바뀌고 격자가 안 들어가면 가용시간이 비고(거짓 "불가", 싸다), 격자만
 * 들어가고 방식이 안 바뀌면 안 쓰는 축에 칠해 놓고 가능으로 뜬다(거짓 "가능", 비싸다).
 *
 * ★ `DELETE` 가 없다. 방식은 켜고 끄는 것이 아니라 **둘 중 하나를 고르는 것**이라
 *   "지운다" 는 뜻이 화면에 존재하지 않는다. 되돌리기는 `PUT { mode: "weekly" }` 다.
 *   (행을 지우면 `chosen: false` 로 돌아가는데, 그건 "아직 안 골랐다" 는 다른 사실이다.)
 * ★ 대상은 **언제나 세션 본인**이다. "누구의 방식인가" 를 받는 자리가 없다.
 */

const modeSchema = z.object({
  mode: z.enum(["weekly", "shift"], {
    message: "가능시간 방식은 weekly 또는 shift 여야 합니다.",
  }),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const state = await fetchMyAvailabilityMode(session.uid);
    return jsonOk<AvailabilityModeState>(state);
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/mode#GET");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, modeSchema);
    const state = await setMyAvailabilityMode(session.uid, body.mode);
    return jsonOk<AvailabilityModeState>(state);
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/mode#PUT");
  }
}
