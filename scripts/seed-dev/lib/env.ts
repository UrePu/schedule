/**
 * `.env.local` 에서 Supabase 접속 정보를 읽는다.
 *
 * - `.env.local` 은 gitignore 대상이며 **이 도구는 절대 쓰지 않는다(읽기 전용).**
 * - dotenv 의존성을 추가하지 않기 위해 필요한 최소 문법만 직접 파싱한다.
 * - ⚠️ `serviceRoleKey` 는 **어떤 경로로도 출력하지 않는다.** 로그·에러 메시지 포함.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const URL_ENV_NAME = 'NEXT_PUBLIC_SUPABASE_URL'
export const SERVICE_ROLE_ENV_NAME = 'SUPABASE_SERVICE_ROLE_KEY'

/** 탐색 순서 — 앞이 우선 */
const ENV_FILES = ['.env.local', '.env'] as const

export interface SupabaseEnv {
  readonly url: string
  /** ⚠️ 절대 출력하지 말 것. */
  readonly serviceRoleKey: string
  /** 어디서 읽었는지 (값은 담기지 않는다) */
  readonly source: string
}

/** dotenv 최소 문법 파서: `KEY=VALUE`, `export KEY=VALUE`, `#` 주석, 양끝 따옴표 제거. */
export function parseDotenv(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    if (quoted) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function pick(bag: Record<string, string | undefined>, name: string): string | null {
  const value = bag[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export async function loadSupabaseEnv(rootDir: string): Promise<SupabaseEnv> {
  const sources: Array<{ label: string; bag: Record<string, string | undefined> }> = [
    { label: 'process.env', bag: process.env },
  ]

  for (const fileName of ENV_FILES) {
    try {
      const content = await readFile(path.join(rootDir, fileName), 'utf8')
      sources.push({ label: fileName, bag: parseDotenv(content) })
    } catch {
      // 파일이 없어도 문제 아님
    }
  }

  for (const { label, bag } of sources) {
    const url = pick(bag, URL_ENV_NAME)
    const key = pick(bag, SERVICE_ROLE_ENV_NAME)
    if (url !== null && key !== null) {
      return { url, serviceRoleKey: key, source: label }
    }
  }

  throw new Error(missingEnvGuidance(rootDir))
}

export function missingEnvGuidance(rootDir: string): string {
  return [
    'Supabase 접속 정보를 찾지 못했습니다.',
    '',
    `  ${path.join(rootDir, '.env.local')} 에 아래 두 줄이 있어야 합니다.`,
    '',
    `    ${URL_ENV_NAME}=https://<project-ref>.supabase.co`,
    `    ${SERVICE_ROLE_ENV_NAME}=<service role 키>`,
    '',
    '  - service role 키는 Supabase 대시보드 > Project Settings > API 에서 확인합니다.',
    '  - RLS 가 서버 전용 쓰기 모델(CLAUDE.md §2.1)이라 시드는 service role 로만 가능합니다.',
    '  - `.env.local` 은 gitignore 대상이며 이 스크립트는 읽기만 합니다.',
  ].join('\n')
}

/** URL 에서 프로젝트 ref 를 뽑는다. 대상 프로젝트 확인용. */
export function projectRefFromUrl(url: string): string | null {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(url.trim())
  return match?.[1] ?? null
}
