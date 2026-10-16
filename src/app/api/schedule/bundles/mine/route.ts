import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchMyBundles } from "@/features/schedule/server/schedule-repo";
import type { MyBundlesResponse } from "@/features/schedule/types";

/**
 * `GET /api/schedule/bundles/mine` — **내 모든 파티의 활성 보스 묶음** (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 라우트가 존재하는 이유는 **고르는 횟수** 하나다 (§1.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 일정표의 빈 칸을 누르면 **묶음 하나**를 고르고 끝이어야 한다. 파티별 라우트
 * (`.../parties/{id}/bundles`)만 있으면 화면이 "파티를 고른 뒤 묶음을 고르는" 2단이 되거나
 * 파티 수만큼 왕복을 돌게 된다(실측 활성 파티 34개 → 34건). 평평한 목록 **한 번**이
 * 그 둘을 모두 없앤다.
 *
 * ★ 어느 파티의 묶음인지는 `partyName` 이 말한다. 묶음 이름이 보스 줄임말
 *   (`익세 하대 하카 3인`)이라 그것만으로는 구분되지 않는다 — 실측된 파티 이름이 서로
 *   구분되지 않아 얼굴을 넣었던 것과 같은 문제다.
 * ★ **남의 공개 파티는 담지 않는다.** 서버가 구성원만 일정을 잡게 하므로 목록에 두면
 *   눌러 봐야 403 이다(repo 가 `members.length > 0` 으로 가른다).
 *
 * ⚠️ 정적 세그먼트 `mine` 이 형제 `[bundleId]` 보다 **먼저 잡힌다**(Next.js 라우팅 규칙).
 *    `parties/mine` 과 `parties/[partyId]` 가 이미 같은 짝이다.
 * ⚠️ 비로그인은 **401** 이다. 빈 배열로 답하고 싶어지지만, 그러면 화면이 "묶음이 없다" 와
 *    "로그인하지 않았다" 를 구별할 수 없다. 일정 잡기 창은 애초에 세션이 있을 때만 열린다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const bundles = await fetchMyBundles(session.uid);
    return jsonOk<MyBundlesResponse>({ bundles });
  } catch (error) {
    return handleRouteError(error, "api/schedule/bundles/mine#GET");
  }
}
