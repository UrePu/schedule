import { handleRouteError, jsonOk } from "@/features/auth/server/http";
import type { BossCatalogResponse } from "@/features/schedule/data/schedule-queries";
import { fetchBossCatalog } from "@/features/schedule/server/schedule-repo";

/**
 * `GET /api/schedule/bosses` — 보스 카탈로그(뷰 `v_boss_catalog` + `boss_aliases`).
 *
 * 보스 마스터는 **공개 데이터**라 세션을 보지 않는다. 그래도 service_role 로 읽는 이유는
 * "브라우저는 Supabase 를 직접 부르지 않는다"(DB-SCHEMA 난제 1)를 이 기능 전체에서
 * 일관되게 유지하기 위해서다 — 한 군데만 예외를 두면 그 예외가 퍼진다.
 *
 * ⚠️ `crystalPriceMeso: null` 은 **미확인**이며 0 이 아니다(§1.3 D4).
 *    화면은 이 값을 "미확인"으로 표시하고 합계에서 제외한다.
 */
export async function GET(): Promise<Response> {
  try {
    const bosses = await fetchBossCatalog();
    return jsonOk<BossCatalogResponse>({ bosses });
  } catch (error) {
    return handleRouteError(error, "api/schedule/bosses#GET");
  }
}
