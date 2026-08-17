/**
 * 드리프트 모드(`--diff`) — 이전 `latest.json` 과 이번 관측을 비교해 **바뀐 것만** 뽑는다.
 * 게임 패치 후 재실행해 스펙 변경을 감지하는 것이 목적이다.
 */
import type { Json } from './types'

export interface Change {
  readonly path: string
  readonly kind: 'added' | 'removed' | 'changed'
  readonly before: string | null
  readonly after: string | null
}

/**
 * 실행마다 당연히 달라지는 값들. 비교에서 뺀다.
 * (여기에 없는 것이 바뀌면 그건 진짜 신호다)
 */
export const VOLATILE_PATHS: readonly RegExp[] = [
  /^runId$/,
  /^generatedAt$/,
  /^mode$/,
  /^tool\./,
  /^key\./,
  /^calls\[\d+\]\.(status|skipped|skipReason)$/,
  /^observations\.dateLag\b/,
  /^observations\.weeklyBossClearCounts\b/,
  /^observations\.dateBackfill\[\d+\]\.date$/,
  /^unknowns\[\d+\]\.answer$/,
  /^spec\.files\[\d+\]\.bytes$/,
]

function isVolatile(path: string, extra: readonly RegExp[]): boolean {
  return VOLATILE_PATHS.some((pattern) => pattern.test(path)) || extra.some((pattern) => pattern.test(path))
}

function render(value: Json | undefined): string | null {
  if (value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 두 JSON 트리를 비교한다. 배열은 인덱스 기준으로 본다(순서가 안정적이도록 수집 단계에서 정렬해 둔다).
 * `extraIgnore` 로 이번 실행에서 아예 수집하지 않은 영역(예: --no-spec)을 비교에서 뺄 수 있다.
 */
export function diffJson(
  before: Json | undefined,
  after: Json | undefined,
  extraIgnore: readonly RegExp[] = [],
  prefix = '',
): Change[] {
  const changes: Change[] = []
  const walk = (a: Json | undefined, b: Json | undefined, path: string): void => {
    if (path.length > 0 && isVolatile(path, extraIgnore)) return
    if (a === undefined && b === undefined) return
    if (a === undefined) {
      changes.push({ path, kind: 'added', before: null, after: render(b) })
      return
    }
    if (b === undefined) {
      changes.push({ path, kind: 'removed', before: render(a), after: null })
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const max = Math.max(a.length, b.length)
      for (let i = 0; i < max; i += 1) walk(a[i], b[i], `${path}[${String(i)}]`)
      return
    }
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const next = path.length > 0 ? `${path}.${key}` : key
        walk(a[key], b[key], next)
      }
      return
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ path, kind: 'changed', before: render(a), after: render(b) })
    }
  }
  walk(before, after, prefix)
  return changes.sort((x, y) => x.path.localeCompare(y.path))
}

export function formatChanges(changes: readonly Change[]): string {
  if (changes.length === 0) return '변경 없음 — 이전 실행과 동일합니다.'
  return changes
    .map((change) => {
      switch (change.kind) {
        case 'added':
          return `  + ${change.path} = ${change.after ?? ''}`
        case 'removed':
          return `  - ${change.path} (이전: ${change.before ?? ''})`
        default:
          return `  ~ ${change.path}\n      이전: ${change.before ?? ''}\n      이번: ${change.after ?? ''}`
      }
    })
    .join('\n')
}
