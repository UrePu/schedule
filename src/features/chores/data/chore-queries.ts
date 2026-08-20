import type { ChoreBoardResponse } from "@/app/api/chores/route";
import type { CharacterChores } from "@/features/bot/server/bot-repo";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 기타 숙제 — **브라우저 쪽 데이터 접근 경계**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 이 파일의 함수만 부른다. 본문은 `/api/chores` 호출이다.
 *
 * ⚠️ **Supabase 를 직접 부르지 않는다.** 숙제 스냅샷은 service_role 로 읽으므로
 *    브라우저에는 권한 자체가 없다. 이 파일에는 `fetch` 밖에 없다.
 * ⚠️ **넥슨을 한 번도 타지 않는다.** 마지막 동기화 결과를 우리 DB 에서 읽을 뿐이라
 *    캐시 키는 `"db"` 네임스페이스이고 `db` 티어(60초)를 쓴다.
 * ⚠️ **타입만 서버에서 가져온다.** `import type` 이라 런타임 코드가 따라오지 않고,
 *    따라서 `server-only` 모듈이 클라이언트 번들로 끌려가지 않는다(대시보드 data 와
 *    같은 규약). 응답 모양이 조립기와 갈라질 수 없다는 점이 그 대가로 얻는 것이다.
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

/** 실패는 `Error` 하나로 접는다. 화면은 서버가 준 한국어 문구를 그대로 보여 준다. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });

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
        `[chores] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
    );
  }
  return body as T;
}

/** 추적 캐릭터별 숙제 판. **넥슨 호출 0건.** */
export async function fetchChoreBoard(): Promise<readonly CharacterChores[]> {
  const body = await request<ChoreBoardResponse>("/api/chores");
  return body.characters;
}

export interface ToggleChoreInput {
  readonly characterId: string;
  /** `chore_definitions.slug`. `ChoreStatus.slug` 가 실어 온 값을 그대로 넘긴다. */
  readonly slug: string;
  readonly done: boolean;
}

/**
 * 수동 체크/해제.
 *
 * ★ 응답이 **판 전체**라 그대로 캐시에 얹으면 된다. 한 줄만 돌려받아 화면에서 합치면
 *   그 합치는 규칙이 서버 조립기와 두 벌이 되고, 완료 판정(수동 우선 · 넥슨 15분 지연)이
 *   갈라진다.
 */
export async function toggleChore(
  input: ToggleChoreInput,
): Promise<readonly CharacterChores[]> {
  const body = await request<ChoreBoardResponse>("/api/chores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return body.characters;
}
