import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  PartiesResponse,
  PartyResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  createParty,
  fetchParties,
} from "@/features/schedule/server/schedule-repo";

/**
 * `GET  /api/schedule/parties` — 볼 수 있는 파티 목록
 * `POST /api/schedule/parties` — 새 파티(세션 필요)
 *
 * ★ **읽기는 비로그인도 200 이다.** 공개 파티만 담겨 나오며 빈 배열일 수 있다.
 *   401 로 접으면 "비로그인도 공개 시간표를 본다"는 요구(CLAUDE.md §2.1)가 무너지고,
 *   TanStack Query 가 에러 상태로 떨어져 화면이 오류 화면이 된다.
 * ★ **쓰기는 세션이 없으면 401.** 그게 "이 파티는 이 사람 것"을 성립시키는 유일한 근거다.
 */

const personIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "사람 식별자 형식이 올바르지 않습니다.",
  );

const createPartySchema = z.object({
  // 비어 있어도 된다 — repo 가 구성원 이름으로 요약해 채운다(`우레푸 외 3명`).
  name: z.string().max(60, "파티 이름은 60자 이하여야 합니다."),
  memberPersonIds: z
    .array(personIdSchema)
    .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    const parties = await fetchParties(session?.uid ?? null);
    return jsonOk<PartiesResponse>({ parties });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties#GET");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, createPartySchema);
    const party = await createParty(session.uid, {
      name: body.name,
      memberPersonIds: body.memberPersonIds,
    });
    return jsonOk<PartyResponse>({ party }, 201);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties#POST");
  }
}
