import { z } from "zod";

import { handleRouteError, jsonOk, readJsonBody } from "@/features/auth/server/http";
import { resolveNexonProxyContext } from "@/features/auth/server/nexon-proxy";
import { syncCharacterScheduler } from "@/features/boss-plans/server/sync-scheduler";
import type { SyncResult } from "@/features/boss-plans/types";

/**
 * `POST /api/boss-plans/sync` — 인게임 스케줄러 → 우리 저장소 (**캐릭터당 1콜**)
 *
 * 헤더 `x-nexon-api-key: <사용자 키>` · 본문 `{ characterId }`
 * 응답 `SyncResult` (반영 건수 + **실제로 소비한 넥슨 호출 수**)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 엔드포인트가 지키는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * - **호출자는 둘, 폴링은 없다** (§1.1.1). 대시보드 진입 시 자동 1회와 수동 새로고침
 *   버튼이다. 캐릭터당 1콜이고 개발 키는 하루 1,000콜이라, 자동 경로는 **신선도 가드**를
 *   통과한 캐릭터만 보낸다(마지막 호출이 넥슨 지연 창 15분 안이면 건너뜀). 가드는
 *   클라이언트에 있고 수동 버튼은 그것을 우회한다 — 이 라우트는 받은 만큼 정직하게 부른다.
 * - **추적 캐릭터만 대상**이다(§2.1.1). 판정은 `syncCharacterScheduler` 안에 있다.
 * - **키는 헤더로만** 받는다. 쿼리에 실으면 액세스 로그와 브라우저 히스토리에 원문이 남는다.
 *   세션·키 소유 검증은 `resolveNexonProxyContext()` 가 하고, 호출량은 그 게이트웨이가
 *   `nexon_api_quota_usage` 에 적는다 — 캐시(15분) 적중은 호출이 아니므로 적히지 않는다.
 * - **미매핑 보스가 있어도 성공이다.** `nexon_unmapped_contents` 에 남고 건수만 보고한다.
 */

const syncSchema = z.object({
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
});

export async function POST(request: Request): Promise<Response> {
  try {
    // 세션 + 키 등록 여부 + 키 소유자 일치를 한 번에 확인한다.
    const context = await resolveNexonProxyContext(request);
    const body = await readJsonBody(request, syncSchema);

    const result = await syncCharacterScheduler(context, body.characterId);
    return jsonOk<SyncResult>(result);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/sync#POST");
  }
}
