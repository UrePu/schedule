import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { RunSignupResponse } from "@/features/schedule/data/schedule-queries";
import { saveRunSignup } from "@/features/schedule/server/schedule-repo";

/**
 * `PUT /api/schedule/runs/{runId}/signup` — 참가 신청 · 빠지기 · 다시 참가하기 (세션 필요)
 *
 * 본문 `{ characterId: uuid, status: "going" | "maybe" | "declined" }`
 * 응답 `{ participants }` — 그 런의 갱신된 참가자 목록(캐릭터 포함)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `characterId` 가 **필수**인 이유 (§1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 주간 결정석 12개 상한은 **캐릭터당**으로 세어진다. "누가 가는가"만 기록하면 수익을
 * 캐릭터에 귀속시킬 수 없고, 12개 카운터도 세울 수 없다. 그래서 스키마에 이미 있던
 * `run_signups.character_id` 를 여기서 반드시 채운다.
 *
 * ⚠️ **참가 행이 이미 있으면 캐릭터를 덮어쓰지 않는다**(비어 있을 때만 채운다). 캐릭터를 바꾸는 길은
 *    `PUT /api/schedule/runs/participant-character` 하나다 — `saveRunSignup` 머리말.
 *
 * 소유·추적 검증은 `saveRunSignup()`(repo)이 한다 — 처음 신청에서 남의 캐릭터 id 는 **400** 이다.
 * 판정을 라우트에도 복제하지 않는다. 두 곳에 두면 반드시 갈라진다.
 */

const signupSchema = z.object({
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
  status: z.enum(["going", "maybe", "declined"]).default("going"),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, signupSchema);

    const participants = await saveRunSignup(session.uid, {
      runId,
      characterId: body.characterId,
      status: body.status,
    });
    return jsonOk<RunSignupResponse>({ participants });
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]/signup#PUT");
  }
}
