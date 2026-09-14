import {
  refreshUserCharacterInventory,
  type CharacterRefreshSummary,
} from "@/features/auth/server/account";
import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { RefreshCharactersResponse } from "@/features/characters/data/character-queries";
import { getAdminDb } from "@/lib/supabase/admin-db";

import { loadTrackableCharacters } from "../route";

/**
 * `POST /api/characters/refresh` — 넥슨에서 **캐릭터 목록을 다시 받는다.**
 *
 * 본문 없음 · 응답 `{ summary, characters }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `GET /api/characters` 와 **다른 문이다. 그쪽을 고쳐 넥슨을 부르게 하지 말 것.**
 * ─────────────────────────────────────────────────────────────────────────────
 * 목록 조회가 넥슨을 부르지 않는 것은 의도된 설계다(§2.1.1) — 모달이 열릴 때마다 같은
 * 데이터에 쿼터만 태우기 때문이다. 새로고침은 그 설계를 유지한 채 **사용자가 명시적으로
 * 누를 때만** 도는 별도 경로로 붙인다. 화면 진입·폴링에서 부르면 안 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 비용: **자격증명 1개당 1콜** (캐릭터당이 아니다)
 * ─────────────────────────────────────────────────────────────────────────────
 * `/character/list` 한 번이 그 키가 보는 계정의 캐릭터 전부를 준다. 실측 자격증명 수는
 * 사용자당 1~3개이므로 **한 번 누르면 최대 3콜**이다(개발 키 하루 1,000콜). 캐릭터가
 * 304명이어도 3콜이다. 초상화(`/character/basic`)가 캐릭터당 1콜인 것과 혼동하지 말 것 —
 * 그 경고는 이 호출의 것이 아니다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 연타 방어 — **같은 사용자의 짧은 간격 중복 호출은 같은 결과를 나눠 쓴다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 경로는 게이트웨이 캐시를 **일부러 우회하므로**(§1.1 — 명시적 새로고침) 캐시가
 * 연타를 막아 주지 않는다. 버튼을 세 번 누르면 넥슨 호출도 세 배가 된다.
 * 그래서 진행 중인 새로고침의 **약속(Promise)** 자체를 사용자별로 들고 있다가, 그 사이에
 * 들어온 요청에 같은 것을 돌려준다. 끝난 뒤로도 `REFRESH_REUSE_MS` 동안은 같은 결과를
 * 재사용한다 — 그 창 안에서 넥슨이 다른 답을 줄 리가 없다(데이터는 최대 15분 지연된다).
 *
 * 429 로 거절하지 않는 이유: 연타는 **사용자의 실수가 아니라 조급함**이고, 같은 답을 주는
 * 것이 그 조급함에 대한 정확한 응답이다. 오류로 만들면 화면이 실패를 그리게 된다.
 *
 * ⚠️ 이 맵은 **프로세스 메모리**다(게이트웨이의 쿨다운 맵과 같은 한계). 서버리스에서
 *    인스턴스가 갈리면 방어가 한 번 비껴간다. 그래도 두는 이유는 연타가 **한 사람이
 *    몇 초 안에** 하는 일이라 같은 인스턴스로 들어올 가능성이 높기 때문이다.
 */
const REFRESH_REUSE_MS = 10_000;

interface InFlightRefresh {
  readonly promise: Promise<CharacterRefreshSummary>;
  /**
   * 이 시각까지는 같은 결과를 재사용한다.
   *
   * ★ **진행 중에는 `Infinity` 다.** 유한한 값을 넣으면 키 3개 × 넥슨 왕복이 그 시간을
   *   넘는 순간 다음 요청의 `pruneExpired` 가 **아직 돌고 있는 엔트리를 지우고**, 두 번째
   *   전체 새로고침이 겹쳐 돈다(최대 6콜). 버튼의 `disabled` 는 그 탭 하나만 막으므로
   *   탭이 둘이면 그대로 통과한다 — 경계는 서버여야 한다.
   */
  expiresAt: number;
}

const inFlight = new Map<string, InFlightRefresh>();

function pruneExpired(now: number): void {
  for (const [userId, entry] of inFlight) {
    if (entry.expiresAt <= now) inFlight.delete(userId);
  }
}

function runRefresh(userId: string): Promise<CharacterRefreshSummary> {
  const now = Date.now();
  pruneExpired(now);

  const existing = inFlight.get(userId);
  if (existing !== undefined) return existing.promise;

  const promise = refreshUserCharacterInventory(getAdminDb(), userId);
  /*
   * 진행 중에는 **만료되지 않는다**(`Infinity`). 끝난 뒤에야 **끝난 시각 기준**으로
   * 재사용 창을 연다. 실패는 재사용하지 않는다 — 다시 눌러 볼 수 있어야 한다.
   */
  const entry: InFlightRefresh = {
    promise,
    expiresAt: Number.POSITIVE_INFINITY,
  };
  inFlight.set(userId, entry);

  void promise.then(
    () => {
      entry.expiresAt = Date.now() + REFRESH_REUSE_MS;
    },
    () => {
      inFlight.delete(userId);
    },
  );

  return promise;
}

export async function POST(): Promise<Response> {
  try {
    const session = await readSession();
    // 남의 캐릭터를 넥슨에 물어볼 수는 없다. 비로그인은 401 (`GET` 과 같은 규약).
    if (session === null) throw ApiError.unauthenticated();

    const summary = await runRefresh(session.uid);

    /*
     * 갱신된 목록을 함께 돌려준다. 화면이 `GET /api/characters` 를 한 번 더 부르지 않아도
     * 되고(넥슨 호출은 아니지만 왕복은 왕복이다), 무엇보다 **요약과 목록이 같은 시점의
     * 스냅샷**이 된다 — 따로 받으면 "1명 사라짐"이라고 말하면서 목록에는 표시가 없는
     * 순간이 생긴다.
     */
    const characters = await loadTrackableCharacters(getAdminDb(), session.uid);

    return jsonOk<RefreshCharactersResponse>({ summary, characters });
  } catch (error) {
    return handleRouteError(error, "api/characters/refresh#POST");
  }
}
