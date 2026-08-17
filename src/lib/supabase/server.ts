import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { requireEnv } from "@/lib/env";

/**
 * 서버 컴포넌트 / Route Handler / Server Action 용 Supabase 클라이언트.
 * anon key + 쿠키 세션을 사용하므로 RLS 정책이 그대로 적용된다.
 */
export async function createServerSupabaseClient() {
  const url = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const anonKey = requireEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // 서버 컴포넌트에서는 쿠키를 쓸 수 없다.
          // 세션 갱신은 미들웨어/Route Handler 가 담당하므로 여기서는 무시한다.
        }
      },
    },
  });
}

/**
 * service_role 키를 쓰는 관리자 클라이언트. **RLS 를 우회한다.**
 * 서버 전용 배치·웹훅 처리처럼 정말 필요한 곳에서만 사용할 것.
 */
export function createAdminSupabaseClient() {
  const url = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const serviceRoleKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export type ServerSupabaseClient = Awaited<
  ReturnType<typeof createServerSupabaseClient>
>;
export type AdminSupabaseClient = ReturnType<typeof createAdminSupabaseClient>;
