import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { RunCharactersResponse } from "@/features/schedule/data/schedule-queries";
import { fetchMyRunCharacters } from "@/features/schedule/server/schedule-repo";

/**
 * `GET /api/schedule/characters`
 *
 * 응답 `{ characters: RunCharacterOption[] }` — 일정에 데려갈 수 있는 **내 추적 캐릭터**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `is_tracked` 로 좁히는가 (§2.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 추적하지 않는 캐릭터는 인게임 스케줄러와 **동기화되지 않는다.** 그런 캐릭터로 일정을
 * 잡으면 클리어가 관측되지 않아 결정석 수익 집계에 영원히 들어오지 못한다. 즉 후보를
 * 넓히는 것은 편의가 아니라 **조용히 깨지는 데이터**를 만드는 일이다.
 *
 * ⚠️ 비로그인은 **401** 이다. 이 목록은 남의 계정 자산이므로 `/api/auth/me` 처럼
 *    200 `{ user: null }` 로 돌려줄 성질이 아니다. 화면은 세션이 있을 때만 부른다.
 *
 * ★ **넥슨을 부르지 않는다.** 목록의 진실은 우리 DB(`public.characters`)이고,
 *   로그인 때 이미 `/character/list` 1콜로 채워져 있다.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const characters = await fetchMyRunCharacters(session.uid);
    return jsonOk<RunCharactersResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/schedule/characters#GET");
  }
}
