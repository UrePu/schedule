/**
 * service_role Supabase 클라이언트.
 *
 * RLS 는 서버 전용 쓰기 모델(CLAUDE.md §2.1 / DB-SCHEMA 난제 1)이라
 * anon 키로는 단 한 행도 넣을 수 없다. 시드는 반드시 service_role 로 수행한다.
 *
 * ⚠️ 이 모듈은 키를 **저장만** 한다. 어떤 경로로도 키를 출력하지 않는다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { SupabaseEnv } from './env'

export type Client = SupabaseClient

export function createServiceRoleClient(env: SupabaseEnv): Client {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
    global: { headers: { 'x-application-name': 'm-schedule-seed-dev' } },
  })
}

/** PostgREST 오류를 사람이 읽을 수 있는 예외로 바꾼다. 키는 담기지 않는다. */
export function raise(context: string, error: { message: string; details?: string | null; hint?: string | null; code?: string | null } | null): void {
  if (error === null) return
  const parts = [`${context} 실패: ${error.message}`]
  if (error.code) parts.push(`code=${error.code}`)
  if (error.details) parts.push(`details=${error.details}`)
  if (error.hint) parts.push(`hint=${error.hint}`)
  throw new Error(parts.join(' | '))
}
