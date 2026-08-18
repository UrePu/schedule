import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  PartyBossesResponse,
  PartyBossesSaveResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  fetchPartyBosses,
  setPartyBosses,
} from "@/features/schedule/server/schedule-repo";

/**
 * `GET /api/schedule/parties/{partyId}/bosses` — 이 파티가 묶어서 도는 보스 목록
 * `PUT /api/schedule/parties/{partyId}/bosses` — 목록 **전체 교체**(세션 필요)
 *
 * 발주 요구(원문): *"파티 정보 자체에 보스가 등록된다. 같은 파티에 보스가 여러개
 * 있을수도있고 추가될수도있고 삭제될수도있다."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 추가/삭제 API 를 따로 두지 않았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 순서가 의미를 갖는 목록이라(제목이 그 순서로 만들어진다) 부분 갱신으로 시작하면
 * "3번을 지우고 5번을 2번 자리로" 같은 요청이 곧바로 필요해진다. 화면은 이미 최종
 * 목록을 손에 들고 있으므로 그것을 그대로 보내는 편이 규칙이 하나로 남는다 —
 * `PUT /api/schedule/availability/patterns` 와 같은 판단이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 응답으로 돌려준다 (+ 제목이 바뀐 파티도 함께)
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ★ **읽기는 비로그인도 200 이다.** 공개 파티라면 "무엇을 도는 묶음인가"가 보여야
 *   공개할 이유가 생긴다. 볼 수 없는 파티는 404(존재 여부도 알리지 않는다).
 * ★ 마이그레이션 `20260818120000` 미적용 DB 에서는 읽기가 **빈 배열**이고 쓰기는
 *   "마이그레이션을 적용해 주세요"라는 400 이다. 500 이면 로그에만 남아 아무도 못 고친다.
 */

/**
 * `boss_difficulties.id` 는 `^[a-z0-9][a-z0-9_]{0,59}$` 로 CHECK 돼 있다.
 * 여기서 걸러야 사용자가 한국어 문구를 받는다.
 */
const bossDifficultyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{0,59}$/, "보스 식별자 형식이 올바르지 않습니다.");

const setBossesSchema = z.object({
  /**
   * 배열 **순서가 곧 표시·연속 배치 순서**다. 빈 배열은 "전부 지운다"이며 정상 입력이다.
   * 상한 24 는 DB 함수 `set_party_bosses` 의 상한과 **같은 경계**다.
   */
  bossDifficultyIds: z
    .array(bossDifficultyIdSchema)
    .max(24, "파티에 등록할 수 있는 보스는 24개까지입니다."),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    const bosses = await fetchPartyBosses(session?.uid ?? null, partyId);
    return jsonOk<PartyBossesResponse>({ bosses });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/bosses#GET");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setBossesSchema);
    const result = await setPartyBosses(session.uid, {
      partyId,
      bossDifficultyIds: body.bossDifficultyIds,
    });
    return jsonOk<PartyBossesSaveResponse>(result);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/bosses#PUT");
  }
}
