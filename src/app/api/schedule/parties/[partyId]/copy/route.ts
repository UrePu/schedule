import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { PartyResponse } from "@/features/schedule/data/schedule-queries";
import { copyParty } from "@/features/schedule/server/schedule-repo";

/**
 * `POST /api/schedule/parties/{partyId}/copy` — **파티 복사** (세션 필요)
 *
 * 응답은 `POST /api/schedule/parties` 와 **같은 모양**(`{ party }`)이다. 복사가 만드는
 * 것은 새 파티 하나이고, 화면이 그 다음에 하는 일(선택을 그 파티로 옮기고 편집 창을
 * 연다)도 만들기와 같다 — 응답 모양이 다르면 호출부가 분기를 하나 더 갖는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `POST .../{partyId}/copy` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/schedule/parties` 에 `copyFrom` 을 받는 길도 있었지만, 그 경로는
 * **구성원·보스를 입력으로 받는** 만들기 계약을 이미 갖고 있다(`createPartySchema`).
 * 복사는 그 입력을 **하나도 받지 않는다** — 받으면 "보낸 구성원과 원본 구성원 중
 * 어느 쪽이 이기나" 라는 질문이 생기고, 그 질문의 답은 어느 쪽이든 틀린 쪽이 있다.
 * 자원(`{partyId}`)이 곧 유일한 입력이므로 그것을 경로에 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) **본문이 없다.** 그래서 `readJsonBody` 도 zod 스키마도 없다 — 받지 않는 값은
 *      위조될 수 없다(`.../character` 머리말과 같은 규칙).
 *   3) 생성이므로 **201**
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ★ **권한 판정은 repo 가 한다**(`copyParty` → `requirePartyMembership`). 원본 파티의
 *   구성원이 아니면 거절된다 — 남의 공개 파티는 명단·분배가 공개면에 없는 값이라
 *   복사 대상이 아니다.
 * ★ **런·클리어·수익은 복사되지 않는다.** 그 보장은 이 라우트가 아니라 `copyParty`
 *   가 그 표들을 읽지도 쓰지도 않는다는 사실이 진다(그쪽 머리말의 표 참고).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const party = await copyParty(session.uid, partyId);
    return jsonOk<PartyResponse>({ party }, 201);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/copy#POST");
  }
}
