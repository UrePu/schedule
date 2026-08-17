/**
 * 비식별화 유틸.
 *
 * 규칙
 * - API 키는 어떤 출력에도 절대 등장하지 않는다. 그래서 `makeScrubber` 를 만들어
 *   **파일에 쓰기 직전 / 콘솔에 찍기 직전** 마지막 관문으로 통과시킨다.
 *   (설계상 애초에 키를 담지 않지만, 실수로 담겼을 때를 막는 2차 방어선이다.)
 * - `ocid` / `account_id` 는 앞 6자만 남긴다.
 * - 캐릭터명은 기본 노출(본인 데이터). `--redact-names` 일 때만 마스킹한다.
 */

const DEFAULT_ID_KEEP = 6

/** 식별자를 앞 `keep` 자만 남기고 마스킹한다. 길이는 보존 정보로 남겨둔다. */
export function maskId(value: string, keep: number = DEFAULT_ID_KEEP): string {
  if (value.length === 0) return ''
  if (value.length <= keep) return `${value}…(len=${String(value.length)})`
  return `${value.slice(0, keep)}…(len=${String(value.length)})`
}

/** 캐릭터명 마스킹: 첫 글자만 남긴다. */
export function maskName(value: string): string {
  if (value.length === 0) return ''
  if (value.length === 1) return '*'
  return `${value.slice(0, 1)}${'*'.repeat(value.length - 1)}`
}

/**
 * 비밀 문자열들을 `***REDACTED***` 로 치환하는 함수를 만든다.
 * 빈 문자열/짧은 문자열은 오탐이 커서 무시한다.
 */
export function makeScrubber(secrets: readonly (string | null | undefined)[]): (text: string) => string {
  const targets = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= 8)
    .sort((a, b) => b.length - a.length)
  if (targets.length === 0) return (text) => text
  return (text) => {
    let out = text
    for (const secret of targets) out = out.split(secret).join('***REDACTED***')
    return out
  }
}

/** 문자열 배열을 정렬 + 중복 제거해 안정적인 집합 표현으로 만든다(드리프트 비교 안정성). */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ko'))
}

/** 숫자 배열을 정렬 + 중복 제거 */
export function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}
