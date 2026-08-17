import { createBrowserClient } from "@supabase/ssr";

import { requireEnv } from "@/lib/env";

/**
 * 브라우저(클라이언트 컴포넌트)용 Supabase 클라이언트.
 * anon key 만 사용하므로 모든 접근은 RLS 정책의 통제를 받는다.
 */
export function createBrowserSupabaseClient() {
  const url = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const anonKey = requireEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  return createBrowserClient(url, anonKey);
}

export type BrowserSupabaseClient = ReturnType<
  typeof createBrowserSupabaseClient
>;
