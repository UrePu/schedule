/**
 * 마이그레이션 SQL 에서 `values (...)` 튜플 목록을 뽑아내는 **최소 토크나이저**.
 *
 * ── 왜 정규식이 아닌가 ───────────────────────────────────────────────────────
 * 시드 SQL 의 주석에는 한글 문장이 들어 있고 그 안에 따옴표·괄호가 섞인다
 * (`-- ★ 규칙은 '노벨'. 노멀 벨로나(주간)와 충돌해…`). 정규식으로 자르면 그런 줄
 * 하나가 파서를 통째로 어긋나게 만들고, **그 어긋남은 조용하다** — 별칭 몇 개가
 * 사라진 상태로 그럴듯한 결과가 나온다. 문자열 리터럴 상태를 추적하며 한 글자씩
 * 걷는 쪽이 짧고 확실하다.
 *
 * 이 파일은 도구 전용이며 애플리케이션 코드(`src/`)에서 import 하지 않는다.
 */

/** SQL 리터럴 하나. `null` 은 "없음"이며 빈 문자열이 아니다. */
export type SqlValue = string | number | boolean | null

/**
 * `--` 줄 주석과 `/* *\/` 블록 주석을 지운다. **문자열 리터럴 안은 건드리지 않는다.**
 *
 * 지운 자리는 같은 길이의 공백으로 바꾸지 않는다 — 위치 정보를 쓰지 않으므로
 * 그냥 없앤다. 줄바꿈은 남겨 둬야 뒤에 오는 토큰이 붙지 않는다.
 */
export function stripComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]

    // 문자열 리터럴: '' 는 이스케이프된 따옴표 한 개다.
    if (ch === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }

    // 달러 인용($$ … $$) — do 블록이 통째로 들어 있다. 안쪽은 손대지 않는다.
    if (ch === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2)
      const j = end === -1 ? sql.length : end + 2
      out += sql.slice(i, j)
      i = j
      continue
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/**
 * `from` 위치부터 시작해 **최상위 괄호 그룹**을 연달아 읽는다.
 * 그룹과 그룹 사이에 쉼표·공백만 허용하며, 다른 토큰이 나오면 거기서 멈춘다.
 * (`on conflict` · `) as v(...)` 가 자연스럽게 종료 조건이 된다.)
 *
 * 돌려주는 것은 **괄호를 벗긴 안쪽 문자열** 목록이다.
 */
export function readTupleList(sql: string, from: number): readonly string[] {
  const tuples: string[] = []
  let i = from

  for (;;) {
    while (i < sql.length && /[\s,]/.test(sql[i] as string)) i += 1
    if (sql[i] !== '(') break

    let depth = 0
    const start = i
    while (i < sql.length) {
      const ch = sql[i]
      if (ch === "'") {
        i += 1
        while (i < sql.length) {
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              i += 2
              continue
            }
            break
          }
          i += 1
        }
        i += 1
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          i += 1
          break
        }
      }
      i += 1
    }
    tuples.push(sql.slice(start + 1, i - 1))
  }

  return tuples
}

/** 튜플 안쪽 문자열을 최상위 쉼표로 자른다(문자열·중첩 괄호 존중). */
export function splitFields(tuple: string): readonly string[] {
  const fields: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < tuple.length) {
    const ch = tuple[i]
    if (ch === "'") {
      i += 1
      while (i < tuple.length) {
        if (tuple[i] === "'") {
          if (tuple[i + 1] === "'") {
            i += 2
            continue
          }
          break
        }
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      fields.push(tuple.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  fields.push(tuple.slice(start))
  return fields.map((f) => f.trim())
}

/**
 * 리터럴 하나를 JS 값으로. 시드가 실제로 쓰는 형태만 받는다 —
 * 모르는 형태는 **던진다**. 조용히 null 로 떨어뜨리면 가격이 사라진 줄 모른다.
 */
export function parseLiteral(raw: string): SqlValue {
  const text = raw.trim()

  // `null::text` 처럼 캐스트가 붙은 형태.
  const noCast = text.replace(/::[a-z_ ]+$/i, '').trim()

  if (/^null$/i.test(noCast)) return null
  if (/^true$/i.test(noCast)) return true
  if (/^false$/i.test(noCast)) return false

  // `timestamptz '2026-06-18 00:00+09'` → ISO 순간
  const ts = /^timestamptz\s+'([^']*)'$/i.exec(noCast)
  if (ts !== null) return toIsoInstant(ts[1] as string)

  if (/^'/.test(noCast) && /'$/.test(noCast)) {
    return noCast.slice(1, -1).replace(/''/g, "'")
  }

  if (/^-?\d+$/.test(noCast)) return Number(noCast)
  if (/^-?\d+\.\d+$/.test(noCast)) return Number(noCast)

  throw new Error(`알 수 없는 SQL 리터럴: ${raw}`)
}

/**
 * `2026-06-18 00:00+09` → `2026-06-17T15:00:00.000Z`.
 *
 * ⚠️ 오프셋이 없으면 **던진다.** 시드의 모든 시각은 `+09` 를 명시하고 있고, 오프셋
 * 없는 문자열을 로컬 시간으로 읽으면 개발자 PC 의 시간대가 가격 적용 시점을
 * 바꿔 버린다(§1: 주 경계는 KST 고정).
 */
export function toIsoInstant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2})(?::?(\d{2}))?$/.exec(
    text.trim(),
  )
  if (match === null) {
    throw new Error(`시간대 오프셋이 없는 타임스탬프: ${text}`)
  }
  const [, date, time, hh, mm] = match
  const iso = `${date}T${time.length === 5 ? `${time}:00` : time}${hh}:${mm ?? '00'}`
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`해석할 수 없는 타임스탬프: ${text}`)
  }
  return parsed.toISOString()
}
