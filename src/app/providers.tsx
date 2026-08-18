"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, type ReactNode } from "react";

import { ToastProvider } from "@/components/ui/toast";
import { IS_DEV_TOOLS_ENABLED } from "@/lib/env-flags";
import { STALE_TIME } from "@/lib/query-keys";

/**
 * 서버 상태 규약 (CLAUDE.md §2 · §2.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 전역 기본값은 **`db` 티어**다 — 티어 표의 값을 그대로 가져온다
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 `60 * 1000` 을 다시 적으면 티어 표(`lib/query-keys.ts`)와 갈라질 수 있는 두 번째
 * 출처가 생긴다. 그래서 `STALE_TIME.db` 를 그대로 쓴다. 나머지 세 티어
 * (`session` · `bossMaster` · `nexon`) 는 쿼리마다 헬퍼로 **덮어쓴다** — 기본값을
 * 그대로 쓰는 쿼리도 `dbQueryOptions()` 를 스프레드해서 "이건 db 티어"라고 말한다.
 *
 * - `refetchOnWindowFocus false` — 탭 전환마다 재조회하지 않는다. 신선도는 폴링이 아니라
 *   **뮤테이션 후 무효화**가 책임진다(§2.4 Rule 1). 특히 넥슨 쪽은 포커스마다 다시 물으면
 *   같은 값에 쿼터만 탄다.
 * - `retry 1` — 프록시 실패 시 한 번만. 파괴적 mutation 은 각자 `retry: 0` 으로 못박는다.
 * - **`gcTime` 은 건드리지 않는다.** 넥슨 응답만 비싸고, 그건 `nexonQueryOptions()` 가
 *   따로 늘려 준다.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.db,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  /*
   * ★ **요청마다 하나** (§2.4 Rule 2). `useState` 로 감싸 렌더 간 재생성을 막으면서도,
   *   모듈 레벨 싱글턴이 아니라 **컴포넌트 인스턴스에 매인다.** 서버에서 이 트리를 렌더할
   *   때도 요청마다 새 클라이언트가 만들어지므로, 한 사람의 파티·수익이 다음 방문자에게
   *   실려 나갈 수 없다. 서버 prefetch 쪽 대칭 규칙은 `lib/query/server-cache.ts` 에 있다.
   */
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {/*
        ★ **낙관적 업데이트의 롤백 알림이 여기 산다** (`@/lib/query/optimistic`).
          QueryClientProvider **안**이어야 한다 — 알림을 띄우는 쪽이 뮤테이션이고,
          그 뮤테이션은 이 클라이언트에 매여 있다. 밖에 두면 배선은 되지만
          "캐시를 되돌렸다"와 "그 사실을 말한다"가 서로 다른 생명주기에 놓인다.
      */}
      <ToastProvider>{children}</ToastProvider>
      {/*
        Devtools 도 **화면에 보이는 개발 도구**라 같은 게이트를 쓴다.
        `NODE_ENV` 로 가르면 빌드 환경이 오염됐을 때 배포물에 굳는다
        (src/lib/env-flags.ts). 켜려면 .env.local 에 NEXT_PUBLIC_DEV_TOOLS=1.
      */}
      {IS_DEV_TOOLS_ENABLED ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      ) : null}
    </QueryClientProvider>
  );
}
