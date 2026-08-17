/**
 * `.env.local` 에서 `NEXON_API_KEY` 를 읽는다.
 *
 * - `.env.local` 은 gitignore 대상이며 **이 도구는 절대 쓰지 않는다(읽기 전용).**
 * - dotenv 의존성을 추가하지 않기 위해 필요한 최소 문법만 직접 파싱한다.
 * - 반환값에 키 원문이 들어있으므로, 호출 측은 이 값을 로깅해서는 안 된다.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const API_KEY_ENV_NAME = 'NEXON_API_KEY'

/** 탐색 순서 — 앞이 우선 */
const ENV_FILES = ['.env.local', '.env'] as const

export interface KeyLookup {
  /** 키 원문. 없으면 null. **절대 출력하지 말 것.** */
  readonly key: string | null
  /** 어디서 읽었는지 (예: `.env.local`, `process.env`). 값은 담기지 않는다. */
  readonly source: string | null
  /** 실제로 찾아본 위치 목록 (안내 메시지에 쓴다) */
  readonly searched: readonly string[]
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

/** 키를 찾는다. 파일이 없거나 읽기에 실패해도 예외를 던지지 않는다. */
export async function loadApiKey(rootDir: string): Promise<KeyLookup> {
  const searched: string[] = ['process.env']
  const fromProcess = process.env[API_KEY_ENV_NAME]
  if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) {
    return { key: fromProcess.trim(), source: 'process.env', searched }
  }

  for (const fileName of ENV_FILES) {
    const filePath = path.join(rootDir, fileName)
    searched.push(fileName)
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    const parsed = parseDotenv(content)
    const value = parsed[API_KEY_ENV_NAME]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { key: value.trim(), source: fileName, searched }
    }
  }

  return { key: null, source: null, searched }
}

/** 키가 없을 때 사용자에게 보여줄 안내문 (키 값은 물론 등장하지 않는다). */
export function missingKeyGuidance(rootDir: string): string {
  const envLocal = path.join(rootDir, '.env.local')
  return [
    'NEXON API 키를 찾지 못했습니다. 아직 발급받지 않았다면 아래 순서로 진행하세요.',
    '',
    '  1) https://openapi.nexon.com 에 넥슨 ID 로 로그인',
    '  2) 내 애플리케이션 > 애플리케이션 등록 > 게임 "메이플스토리" 선택',
    '     - 애플리케이션 타입은 "개발 단계" 로 충분합니다 (5건/초, 1,000건/일).',
    '  3) 등록 즉시 발급된 API Key 를 애플리케이션 상세 페이지에서 복사',
    `  4) ${envLocal} 파일에 아래 한 줄을 추가 (따옴표 없이)`,
    '',
    `       ${API_KEY_ENV_NAME}=발급받은키`,
    '',
    '     - `.env.local` 은 gitignore 대상이라 커밋되지 않습니다.',
    '     - 이 도구는 `.env.local` 을 읽기만 하며 절대 수정하지 않습니다.',
    '     - 참고용 형식은 `.env.local.example` 에 있습니다.',
    '  5) 다시 실행:  pnpm probe --yes',
    '',
    '키 없이도 아래는 지금 바로 됩니다.',
    '  pnpm probe                 # 호출 계획만 출력 (네트워크 요청 0건)',
    '  pnpm probe --selftest      # 스로틀/예산/마스킹/파서 단위 점검',
  ].join('\n')
}
