import "server-only";

import {
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";

import { STALE_TIME } from "@/lib/query-keys";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 서버 prefetch → dehydrate (CLAUDE.md §2.4 Rule 1 · Rule 2)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 서버 컴포넌트가 DB 를 읽는 것은 그대로다. 바뀐 것은 **그 결과를 어디에 넣느냐**다.
 * 예전에는 행을 props 로 내려보냈고, props 는 `invalidateQueries()` 가 닿을 수 없는
 * 자리라 뮤테이션 뒤에도 서버 렌더분이 낡은 채 남았다. 이제 결과는 **요청 범위
 * QueryClient** 에 심어 `dehydrate()` 로 직렬화하고, 클라이언트가 `HydrationBoundary`
 * 로 받아 **캐시가 그 데이터의 유일한 주인**이 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Rule 2 를 **구조로** 막는다 — 모듈 레벨 인스턴스는 만들 수가 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버 QueryClient 를 모듈 레벨에 두면 한 사람의 파티·수익이 **다음 방문자에게 그대로
 * 나간다.** 데이터 유출이지 성능 메모가 아니다. 그래서 규율이 아니라 구조로 막았다:
 *
 * 1. **QueryClient 를 export 하지 않는다.** 이 파일이 내보내는 것은 함수 하나뿐이고,
 *    인스턴스는 `dehydrateQueries()` 의 지역 변수로만 존재한다. 호출이 끝나면 밖으로
 *    나가는 것은 **평범한 직렬화 스냅샷**(`DehydratedState`)뿐이라, 호출부가 클라이언트를
 *    붙들어 둘 방법 자체가 없다.
 * 2. **`import "server-only"`** — 이 모듈이 클라이언트 번들에 끌려 들어가면 빌드가 깨진다.
 * 3. 검증도 한 줄이다: `grep -rn "new QueryClient" src` 는 두 곳만 나와야 하고
 *    (`app/providers.tsx` 의 `useState` 팩토리 · 이 파일의 함수 본문) **둘 다 함수
 *    안**이다. 모듈 최상단에 있는 것이 하나라도 보이면 그것이 곧 그 버그다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 prefetch 하고 무엇을 하지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **넥슨 API 는 여기서 부르지 않는다.** prefetch 대상은 **우리 DB 읽기**뿐이다.
 *    넥슨 호출은 캐릭터당 1콜이고 개발 키는 하루 1,000콜이라(§1.1), 페이지 진입마다
 *    도는 서버 prefetch 에 넥슨을 얹으면 화면을 여는 것만으로 예산이 녹는다. 넥슨은
 *    지금까지처럼 **사용자 조작(동기화 버튼)과 자동 동기화 훅**에서만 나간다.
 *
 * 편집기를 열어야만 켜지는 조회(사람 후보 · 특이사항 편집 구간)도 대상이 아니다 —
 * 화면에 쓰이지 않는 요청을 미리 하는 것은 그냥 DB 부하다.
 */

/**
 * 요청 하나짜리 QueryClient 를 만들어 `prefetch` 를 태우고 직렬화 스냅샷을 돌려준다.
 *
 * ```ts
 * const state = await dehydrateQueries(async (qc) => {
 *   qc.setQueryData(queryKeys.db.party.list(), await fetchParties(viewerUserId));
 * });
 * return <HydrationBoundary state={state}>…</HydrationBoundary>;
 * ```
 *
 * ★ `prefetchQuery` 가 아니라 `setQueryData` 를 써도 된다 — 서버 repo 를 직접 부를 때는
 *   그쪽이 정확하다. `dehydrate()` 는 **성공한 쿼리만** 싣기 때문에, 어느 쪽으로 심든
 *   실패는 애초에 클라이언트로 넘어가지 않는다.
 *
 * ★ **`initialData` 를 대신한다.** `initialData` 는 `initialDataUpdatedAt` 을 함께 주지
 *   않으면 그 값이 **영원히 신선한 것으로** 취급된다. 하이드레이션은 `dataUpdatedAt` 을
 *   스냅샷과 함께 실어 보내므로 그 함정이 구조적으로 없다.
 *
 * ★ **비로그인 200 을 깨뜨리지 않는다** (DoD §0.3). 세션이 없을 때 `prefetch` 가 던지면
 *   페이지가 500 이 된다. 그래서 호출부는 세션이 없는 경로에서 아예 이 함수를 부르지
 *   않거나, 세션이 필요한 조회를 `prefetch` 안에서 건너뛴다 — 실패를 여기서 삼켜 버리면
 *   진짜 장애가 빈 화면으로 둔갑하므로 **삼키지 않는다.**
 */
export async function dehydrateQueries(
  prefetch: (queryClient: QueryClient) => void | Promise<void>,
): Promise<DehydratedState> {
  // ★ 요청마다 새로. 이 변수는 함수 밖으로 나가지 않는다 (위 1번).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // 클라이언트 전역 기본값과 같은 티어를 쓴다(`app/providers.tsx`).
        staleTime: STALE_TIME.db,
        retry: false,
      },
    },
  });

  await prefetch(queryClient);

  return dehydrate(queryClient);
}
