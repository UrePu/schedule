import type { WeekKey } from "@/types/domain";

import type {
  DashboardData,
  DashboardParty,
} from "../server/dashboard-repo";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 · 내 파티 — **브라우저 쪽 데이터 접근 경계**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 이 파일의 함수만 부른다. 본문은 `/api/dashboard` 와
 * `/api/schedule/parties/mine` 호출이다.
 *
 * ⚠️ **Supabase 를 직접 부르지 않는다.** 수익 뷰와 계획 뷰는 service_role 전용이라
 *    브라우저에는 권한 자체가 없다. 이 파일에는 `fetch` 밖에 없다.
 *
 * ⚠️ **넥슨을 한 번도 타지 않는다.** 두 엔드포인트 모두 우리 DB 만 읽으므로 캐시 키는
 *    `"db"` 네임스페이스이고 `db` 티어(60초)를 쓴다 — 15분 하한의 대상이 아니다.
 *
 * ⚠️ **타입만 서버 repo 에서 가져온다.** `import type` 이라 런타임 코드가 따라오지 않고,
 *    따라서 `server-only` 모듈이 클라이언트 번들로 끌려가지 않는다. 응답 모양이 repo 와
 *    갈라질 수 없다는 점이 그 대가로 얻는 것이다.
 */

interface ApiErrorShape {
  readonly error: { readonly message?: unknown };
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = (body as Partial<ApiErrorShape>).error;
  if (typeof candidate !== "object" || candidate === null) return null;
  const message = (candidate as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * 실패는 `Error` 하나로 접는다. 화면(`ErrorState`)은 상태 코드가 아니라 "실패했다"만
 * 알면 되고, 서버가 준 한국어 문구를 그대로 보여 준다.
 */
async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      extractMessage(body) ??
        `[dashboard] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
    );
  }
  return body as T;
}

/** 대시보드 한 화면분(수익 · 파티 · 체크리스트 · 주간 보스 칸). **넥슨 호출 0건.** */
export function fetchDashboard(weekKey: WeekKey): Promise<DashboardData> {
  const query = new URLSearchParams({ weekKey });
  return request<DashboardData>(`/api/dashboard?${query.toString()}`);
}

/** `GET /api/schedule/parties/mine` */
interface MyPartiesResponse {
  readonly parties: readonly DashboardParty[];
}

/**
 * **내가 속한 파티만.** 공개 파티는 제외된다 — 일정 등록은 구성원만 가능하기 때문이다.
 * `fetchParties()`(features/schedule)와 모집단이 다르므로 캐시 키도 다르다.
 */
export async function fetchMyParties(
  weekKey: WeekKey,
): Promise<readonly DashboardParty[]> {
  const query = new URLSearchParams({ weekKey });
  const body = await request<MyPartiesResponse>(
    `/api/schedule/parties/mine?${query.toString()}`,
  );
  return body.parties;
}
