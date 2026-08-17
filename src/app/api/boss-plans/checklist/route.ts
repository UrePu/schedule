import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { fetchWeeklyChecklist } from "@/features/boss-plans/server/boss-plan-repo";
import type { ChecklistResponse } from "@/features/boss-plans/types";

/**
 * `GET /api/boss-plans/checklist` — 대시보드 첫 화면의 주간 체크리스트 (§1.1.1)
 *
 * 응답 `{ characters: CharacterChecklist[] }` — 추적 캐릭터마다 한 섹션.
 *
 * ★ **넥슨을 부르지 않는다.** 캐릭터당 1콜이라 화면을 열 때마다 도는 배치는 하루 예산을
 *   태운다(개발 키 1,000콜). 최신화는 `POST /api/boss-plans/sync` 를 사용자가 눌렀을
 *   때만 일어나고, 이 엔드포인트는 그 결과가 담긴 **우리 DB** 만 읽는다.
 *
 * ⚠️ 비로그인은 **200 + 빈 배열**이다. 401 이 아닌 이유는 대시보드 자체가 세션이 있을
 *    때만 렌더되는 화면이라, 여기서 401 을 주면 로그아웃 직후 화면에 에러 UI 가 번쩍이기
 *    때문이다. "볼 것이 없다"는 정상 상태이며 빈 상태로 표현한다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) {
      return jsonOk<ChecklistResponse>({ characters: [] });
    }

    const characters = await fetchWeeklyChecklist(session.uid);
    return jsonOk<ChecklistResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/checklist#GET");
  }
}
