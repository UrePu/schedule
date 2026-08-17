"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, type ReactNode } from "react";

import { IS_DEV_TOOLS_ENABLED } from "@/lib/env-flags";

/**
 * 서버 상태 규약 (CLAUDE.md §2):
 * - staleTime 60초 — 보스 스케줄은 초 단위로 흔들릴 필요가 없다.
 * - refetchOnWindowFocus false — 탭 전환마다 재조회하지 않는다.
 * - retry 1 — 넥슨 API 프록시 실패 시 한 번만 재시도한다.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // useState 로 감싸 요청/렌더 간 QueryClient 재생성을 막는다.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
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
