import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchChoreBoard,
  setChoreManualDone,
  type CharacterChores,
} from "@/features/bot/server/bot-repo";
import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * `/api/chores` — 주간 숙제 판 (세션 필요)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 카톡 `!숙제` 와 **같은 조립기**를 쓴다
 * ═════════════════════════════════════════════════════════════════════════════
 * 읽기는 `fetchChoreBoard()`, 쓰기는 `setChoreManualDone()` 이며 둘 다 봇이 이미 쓰던
 * 함수다. 웹용으로 다시 짜면 "웹에서는 했다는데 봇은 안 했다고 한다"가 반드시 생긴다 —
 * 완료 판정(수동 체크가 넥슨보다 우선 · 15분 지연 보정)이 조립기 안에 들어 있기 때문이다.
 *
 * ⚠️ **넥슨 호출 0건.** 마지막 동기화 스냅샷을 읽을 뿐이다. 동기화는 보스 현황 화면의
 *    버튼이 담당한다(§1.1 — 캐릭터당 1콜, 개발 키 하루 1,000콜).
 * ⚠️ 완료 결과 컬럼(`effective_done`)은 **DB 트리거가 정한다.** 앱이 덮으면 규칙이
 *    두 벌이 된다(`bot-repo.setChoreManualDone` 주석).
 */

export interface ChoreBoardResponse {
  readonly characters: readonly CharacterChores[];
}

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const characters = await fetchChoreBoard(
      getAdminDb(),
      session.uid,
      new Date(),
    );
    return jsonOk<ChoreBoardResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/chores#GET");
  }
}

/**
 * 수동 체크/해제.
 *
 * 응답은 **판 전체**다. 한 줄만 돌려주면 화면이 나머지를 낙관적으로 붙들고 있어야 하고,
 * 그 사이 다른 기기에서 바뀐 값과 어긋난다. 판이 작아(추적 캐릭터 × 4줄) 통째로 주는
 * 비용이 그 위험보다 싸다.
 */
const toggleSchema = z.object({
  characterId: z.string().uuid(),
  /** `chore_definitions.slug`. 정의에 없는 값이면 아래에서 404 로 떨어진다. */
  slug: z.string().min(1).max(64),
  done: z.boolean(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = toggleSchema.parse((await request.json()) as unknown);
    const db = getAdminDb();
    const now = new Date();

    /*
      ★ **남의 캐릭터를 체크할 수 없다.** `setChoreManualDone` 은 `user_id` 를 그대로
        쓰므로 그 자체로는 남의 행을 만들지 않지만, 확인하지 않으면 존재하지 않는
        (내 것이 아닌) 캐릭터 id 로 행이 생겨 판에 유령 줄이 남는다.
    */
    const owned = await db
      .from("characters")
      .select("id")
      .eq("user_id", session.uid)
      .eq("id", body.characterId)
      .limit(1);
    if (owned.error !== null) {
      console.error(`[api/chores] 캐릭터 확인: ${owned.error.message}`);
      throw ApiError.internal();
    }
    if ((owned.data ?? []).length === 0) {
      /*
        없는 캐릭터와 **남의 캐릭터**를 같은 답으로 접는다 — 갈라 주면 uuid 를 훑어
        남의 캐릭터 존재 여부를 확인할 수 있게 된다(`credentialNotFound` 와 같은 판단).
      */
      throw ApiError.badRequest("내 캐릭터가 아닙니다.");
    }

    const applied = await setChoreManualDone(
      db,
      {
        userId: session.uid,
        characterId: body.characterId,
        slug: body.slug,
        done: body.done,
      },
      now,
    );
    if (!applied) throw ApiError.badRequest("그런 숙제 항목이 없습니다.");

    const characters = await fetchChoreBoard(db, session.uid, now);
    return jsonOk<ChoreBoardResponse>({ characters });
  } catch (error) {
    return handleRouteError(error, "api/chores#POST");
  }
}
