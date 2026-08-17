import { getAdminDb } from "@/lib/supabase/admin-db";
import { nexonQuotaDayKey, readQuotaSnapshot } from "@/lib/nexon/quota";
import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { QuotaResponse } from "@/features/auth/types";

/**
 * `GET /api/nexon/quota` → 오늘(KST) 이 계정이 쓴 넥슨 호출량.
 *
 * **넥슨을 부르지 않는다.** 우리 장부(`nexon_api_quota_usage`)를 읽을 뿐이다.
 * 이 엔드포인트가 필요한 이유는 단순하다 — 넥슨 응답에는 **잔여 호출량 헤더가 없어서**
 * (실측, 응답 헤더 20종 전수 확인) 우리 장부 말고는 남은 양을 볼 방법이 없다.
 *
 * `devBudgetRemaining` 은 **개발 키(1,000/일) 기준**이다. 서비스 키면 의미가 없는
 * 숫자이므로 경고 표시 용도로만 쓰고, 이 값으로 호출을 막지 않는다(`quota.ts` 참고).
 */
export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const db = getAdminDb();
    const { data: credentials, error } = await db
      .from("user_credentials")
      .select("id, label")
      .eq("user_id", session.uid)
      .order("created_at", { ascending: true });
    if (error !== null) throw error;

    const rows = await Promise.all(
      (credentials ?? []).map(async (credential) => {
        const snapshot = await readQuotaSnapshot(db, credential.id);
        return {
          credentialId: credential.id,
          label: credential.label,
          callCount: snapshot.callCount,
          errorCount: snapshot.errorCount,
          throttledCount: snapshot.throttledCount,
          devBudgetRemaining: snapshot.devBudgetRemaining,
          nearDevBudget: snapshot.nearDevBudget,
        };
      }),
    );

    return jsonOk<QuotaResponse>({
      dayKey: nexonQuotaDayKey(),
      credentials: rows,
    });
  } catch (error) {
    return handleRouteError(error, "api/nexon/quota");
  }
}
