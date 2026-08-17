/**
 * 넥슨 OpenAPI YAML 을 읽기 위한 **최소 블록 YAML 파서**.
 *
 * 왜 직접 쓰는가: 새 의존성을 추가하면 pnpm-lock.yaml 이 바뀌는데, 이 작업 단위는
 * 그 파일을 건드릴 수 없다. 대신 지원 범위를 좁게 못 박고 실패를 조용히 삼키지 않는다.
 *
 * 지원 범위 (넥슨이 생성하는 YAML 이 실제로 쓰는 문법만)
 *  - 블록 매핑 `key: value` / `key:` + 하위 블록
 *  - 블록 시퀀스 `- item` (부모와 같은 들여쓰기 / 더 깊은 들여쓰기 모두)
 *  - 스칼라: 평문, '작은따옴표', "큰따옴표", true/false/null, 숫자
 *  - 블록 스칼라 `|`, `|-`, `>`, `>-` (내용은 한 덩어리 문자열로만 보관)
 *  - 여러 줄로 이어지는 평문 스칼라 (공백으로 접어서 한 줄로)
 *
 * 미지원 (등장하면 예외를 던진다): 앵커/별칭, 플로우 매핑/시퀀스, 복합 키, 다중 문서
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

interface Line {
  readonly indent: number
  readonly text: string
  readonly lineNo: number
}

export class YamlParseError extends Error {
  readonly lineNo: number

  constructor(message: string, lineNo: number) {
    super(`${message} (line ${String(lineNo)})`)
    this.name = 'YamlParseError'
    this.lineNo = lineNo
  }
}

function toLines(source: string): Line[] {
  const out: Line[] = []
  const raw = source.split(/\r?\n/)
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? ''
    const trimmedRight = line.replace(/\s+$/, '')
    if (trimmedRight.length === 0) continue
    const indent = trimmedRight.length - trimmedRight.trimStart().length
    const text = trimmedRight.trimStart()
    // 줄 전체가 주석인 경우만 버린다. 인라인 `#` 은 설명 텍스트에 흔해서 건드리지 않는다.
    if (text.startsWith('#')) continue
    out.push({ indent, text, lineNo: i + 1 })
  }
  return out
}

/** `key: value` 로 쪼갠다. 콜론+공백 또는 줄 끝 콜론만 구분자로 인정한다. */
function splitKey(text: string): { key: string; rest: string } | null {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = text[i + 1]
      if (next === undefined || next === ' ') {
        return { key: unquote(text.slice(0, i).trim()), rest: text.slice(i + 1).trim() }
      }
    }
  }
  return null
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\')
  }
  return value
}

function scalar(raw: string): YamlValue {
  const value = raw.trim()
  if (value.length === 0) return null
  if (value.startsWith("'") || value.startsWith('"')) return unquote(value)
  if (value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d*\.\d+$/.test(value)) return Number(value)
  return value
}

class Cursor {
  index = 0
  readonly lines: readonly Line[]

  constructor(lines: readonly Line[]) {
    this.lines = lines
  }

  peek(): Line | null {
    return this.lines[this.index] ?? null
  }
  next(): Line | null {
    const line = this.lines[this.index] ?? null
    if (line !== null) this.index += 1
    return line
  }
}

/** `|` / `>` 블록 스칼라 본문을 소비한다. 내용은 검증에 쓰지 않으므로 원문을 합쳐 반환한다. */
function readBlockScalar(cursor: Cursor, parentIndent: number): string {
  const parts: string[] = []
  for (;;) {
    const line = cursor.peek()
    if (line === null || line.indent <= parentIndent) break
    parts.push(line.text)
    cursor.next()
  }
  return parts.join('\n')
}

function parseBlock(cursor: Cursor, indent: number): YamlValue {
  const first = cursor.peek()
  if (first === null) return null

  if (first.text.startsWith('- ') || first.text === '-') {
    return parseSequence(cursor, indent)
  }
  return parseMapping(cursor, indent)
}

function parseSequence(cursor: Cursor, indent: number): YamlValue[] {
  const items: YamlValue[] = []
  for (;;) {
    const line = cursor.peek()
    if (line === null || line.indent !== indent) break
    if (!(line.text.startsWith('- ') || line.text === '-')) break
    cursor.next()
    const inline = line.text === '-' ? '' : line.text.slice(2).trim()
    const follower = cursor.peek()
    const childIndent = follower !== null && follower.indent > line.indent ? follower.indent : line.indent + 2
    if (inline.length === 0) {
      const nested = cursor.peek()
      if (nested !== null && nested.indent > line.indent) items.push(parseBlock(cursor, nested.indent))
      else items.push(null)
      continue
    }
    const kv = splitKey(inline)
    if (kv === null) {
      items.push(scalar(inline))
      continue
    }
    // `- key: value` — 뒤따르는 같은 항목의 나머지 키들과 함께 하나의 매핑으로 묶는다.
    const synthetic: Line[] = [{ indent: childIndent, text: inline, lineNo: line.lineNo }]
    for (;;) {
      const follow = cursor.peek()
      if (follow === null || follow.indent < childIndent) break
      synthetic.push(follow)
      cursor.next()
    }
    items.push(parseMapping(new Cursor(synthetic), childIndent))
  }
  return items
}

function parseMapping(cursor: Cursor, indent: number): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {}
  for (;;) {
    const line = cursor.peek()
    if (line === null || line.indent !== indent) break
    if (line.text.startsWith('- ')) break
    const kv = splitKey(line.text)
    if (kv === null) throw new YamlParseError(`매핑 키를 찾지 못했습니다: ${line.text.slice(0, 40)}`, line.lineNo)
    cursor.next()
    const { key, rest } = kv

    if (rest.startsWith('|') || rest.startsWith('>')) {
      out[key] = readBlockScalar(cursor, indent)
      continue
    }

    if (rest.length === 0) {
      const nested = cursor.peek()
      if (nested === null) {
        out[key] = null
      } else if (nested.indent > indent) {
        out[key] = parseBlock(cursor, nested.indent)
      } else if (nested.indent === indent && (nested.text.startsWith('- ') || nested.text === '-')) {
        out[key] = parseSequence(cursor, indent)
      } else {
        out[key] = null
      }
      continue
    }

    // 인라인 스칼라. 뒤에 더 깊은 들여쓰기 줄이 오면 여러 줄 평문 스칼라의 연속이다.
    let text = rest
    for (;;) {
      const cont = cursor.peek()
      if (cont === null || cont.indent <= indent) break
      text = `${text} ${cont.text}`
      cursor.next()
    }
    out[key] = text === rest ? scalar(rest) : text
  }
  return out
}

/** YAML 문서 하나를 파싱한다. 지원 범위를 벗어나면 `YamlParseError` 를 던진다. */
export function parseYaml(source: string): YamlValue {
  const withoutDirectives = source
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('%') && line.trim() !== '---' && line.trim() !== '...')
    .join('\n')
  const cursor = new Cursor(toLines(withoutDirectives))
  const first = cursor.peek()
  if (first === null) return null
  const value = parseBlock(cursor, first.indent)
  const leftover = cursor.peek()
  if (leftover !== null) {
    throw new YamlParseError(`문서 끝까지 소비하지 못했습니다: ${leftover.text.slice(0, 40)}`, leftover.lineNo)
  }
  return value
}

/** 안전한 하위 탐색 헬퍼 */
export function yamlGet(value: YamlValue, ...keys: readonly string[]): YamlValue {
  let current: YamlValue = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null
    current = current[key] ?? null
  }
  return current
}

export function isYamlObject(value: YamlValue): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
