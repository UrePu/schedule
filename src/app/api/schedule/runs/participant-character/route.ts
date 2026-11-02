import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  changeRunParticipantCharacter,
  fetchRunParticipantCharacters,
} from "@/features/schedule/server/schedule-repo";
import type {
  ChangeRunParticipantCharacterResult,
  RunCharacterCandidatesResponse,
} from "@/features/schedule/types";

/**
 * `/api/schedule/runs/participant-character` — 일정 상세에서 **그 사람이 데려가는 캐릭터**
 * (나 + 같은 파티원. 세션 필요)
 *
 * - `GET ?runIds=a,b&participantId=x` → `{ characters: RunCharacterCandidate[] }` 고를 수 있는 후보
 * - `PUT { runIds, participantId, characterId }` → 바꾼다
 *
 * ⚠️ `GET` 은 **남의 로스터를 내주는 유일한 경로다.** 그래서 요청자가 그 일정의 파티 구성원이고
 *    대상이 그 일정의 참가자일 때만 열리고, 나가는 칸은 이름 · 직업 · 레벨 · 초상화 · 이번 주기에
 *    그 보스를 깼다는 말(과 돌려보낼 우리 쪽 id)뿐이다. 판정과 칸 고르기는 repo 가 한다.
 *
 * ★ 런이 경로가 아니라 목록인 이유: 상세 창의 한 칸은 **묶음 하나**다. 런마다 나누면 셋째 보스에서
 *   막혔을 때 앞의 둘만 바뀐 채로 남고, 후보 줄의 "이번 주 카칼·노벨 클리어함" 도 말할 수 없다.
 * ★ 정적 구간이라 `[runId]` 보다 먼저 매칭된다(`remove-many` 와 같다). 런 id 는 uuid 다.
 * ★ **넥슨을 부르지 않는다.** 초상화는 이미 DB 에 저장된 URL 이고 없으면 실루엣이다(§2.1.1).
 */

/** 한 묶음의 보스 수 상한(`MAX_PARTY_BOSSES`)보다 넉넉히. 묶음이 이만큼 커질 일은 없다. */
const MAX_RUNS = 30;

const runIdsSchema = z
  .array(z.uuid("일정을 찾을 수 없습니다."))
  .min(1, "바꿀 일정이 없습니다.")
  .max(MAX_RUNS, `한 번에 ${String(MAX_RUNS)}건까지만 바꿀 수 있습니다.`);
const participantIdSchema = z.uuid("이 일정에 참가한 사람이 아닙니다.");

const bodySchema = z.object({
  runIds: runIdsSchema,
  participantId: participantIdSchema,
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const { searchParams } = new URL(request.url);
    const query = z
      .object({ runIds: runIdsSchema, participantId: participantIdSchema })
      .safeParse({
        runIds: (searchParams.get("runIds") ?? "").split(",").filter(Boolean),
        participantId: searchParams.get("participantId"),
      });
    /* 형식이 틀린 값은 DB 까지 가면 22P02 → 500 이다. 없는 것과 같은 답으로 접는다. */
    if (!query.success) {
      throw ApiError.badRequest("이 일정에 참가한 사람이 아닙니다.");
    }

    const characters = await fetchRunParticipantCharacters(
      session.uid,
      query.data.runIds,
      query.data.participantId,
    );
    return jsonOk<RunCharacterCandidatesResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/participant-character#GET");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);
    const result = await changeRunParticipantCharacter(session.uid, body);
    return jsonOk<ChangeRunParticipantCharacterResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/participant-character#PUT");
  }
}
