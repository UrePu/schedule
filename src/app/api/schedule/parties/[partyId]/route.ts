import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { archiveParty } from "@/features/schedule/server/schedule-repo";

/**
 * `DELETE /api/schedule/parties/{partyId}` — **파티 해체(터트리기)**
 *
 * 발주 요구(2026-08-20): *"파티 터트리는기능이 없네 처음에 생성한사람이 터트릴수잇는
 * 권한을 줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `DELETE` 인데 행을 지우지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버는 `parties.archived_at` 을 채운다. 메서드가 `DELETE` 인 이유는 **호출자 입장에서
 * 벌어지는 일**이 삭제이기 때문이다 — 그 파티는 모든 목록에서 사라지고 다시 나타나지
 * 않는다(모든 조회가 `archived_at is null` 을 건다).
 *
 * 행을 진짜로 지우지 않는 이유는 `schedule-repo.archiveParty()` 머리말에 있다. 요지는
 * `parties → party_runs → run_drops` 가 전부 `on delete cascade` 라 **드랍 수익 기록이
 * 함께 죽는다**는 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 권한 — **만든 사람만**
 * ─────────────────────────────────────────────────────────────────────────────
 * 구성원 아무나가 아니라 `owner_user_id` 다(발주 요구). 판정은 서버가 하며, 화면이 버튼을
 * 숨기는 것은 **안내이지 방어가 아니다** — 요청은 언제든 직접 만들어 보낼 수 있다.
 *
 * 응답은 다른 쓰기 API 와 달리 컬렉션을 돌려주지 않는다. 바뀐 뒤의 목록은 호출자마다
 * 다르고(`/mine` · 공개 목록 · 봇), 무엇을 돌려줘도 절반은 다시 조회해야 한다.
 * 클라이언트는 무효화로 각자 필요한 것만 다시 읽는다.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    await archiveParty(session.uid, partyId);
    return jsonOk<{ ok: true }>({ ok: true });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]#DELETE");
  }
}
