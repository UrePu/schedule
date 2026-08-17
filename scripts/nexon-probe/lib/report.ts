/**
 * 출력물 작성.
 *
 *  - `<out>/raw/<runId>/*.json`  원본 응답 전량 (gitignore 대상)
 *  - `<out>/latest.json`         관측 요약 (드리프트 비교 기준)
 *  - `Claude/NEXON-API-OBSERVED.md`  사람이 읽는 요약 — **비식별화 필수**
 *
 * 모든 쓰기는 scrubber 를 통과한다. API 키는 어떤 파일에도 들어가지 않는다.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CallResult, Json, Summary } from './types'
import { maskId } from './redact'

export interface Writer {
  readonly rawDir: string
  readonly latestPath: string
  readonly scrub: (text: string) => string
}

/** ocid / account_id 로 보이는 값을 재귀적으로 마스킹한다(사람이 읽는 산출물 전용). */
const ID_KEYS = new Set(['ocid', 'account_id', 'oguild_id'])

export function maskIdsDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => maskIdsDeep(item))
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: Json } = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = ID_KEYS.has(key) && typeof child === 'string' ? maskId(child) : maskIdsDeep(child)
    }
    return out
  }
  return value
}

export async function writeRaw(writer: Writer, index: number, result: CallResult): Promise<void> {
  await mkdir(writer.rawDir, { recursive: true })
  const safeLabel = result.label.replace(/[^a-zA-Z0-9._-]/g, '_')
  const fileName = `${String(index).padStart(2, '0')}-${safeLabel}.json`
  // 요청 헤더는 기록하지 않는다 — 키가 들어있기 때문이다.
  const payload = {
    label: result.label,
    purpose: result.purpose,
    request: { path: result.path, query: result.query },
    response: {
      status: result.status,
      ok: result.ok,
      durationMs: result.durationMs,
      headerNames: result.headerNames,
      rateLimitHeaders: result.rateLimitHeaders,
      body: result.body,
      bodyTextWhenNotJson: result.body === null ? result.bodyText : null,
    },
    error: { name: result.errorName, message: result.errorMessage, network: result.networkError },
    skipped: result.skipped,
    skipReason: result.skipReason,
  }
  await writeFile(path.join(writer.rawDir, fileName), writer.scrub(`${JSON.stringify(payload, null, 2)}\n`), 'utf8')
}

// ── 관측 문서 갱신 규칙 ──────────────────────────────────────────────
//
// 두 가지 요구가 충돌한다.
//   (A) 문서 헤더는 항상 "그 문서를 만든 실행"의 상태를 정확히 말해야 한다.
//   (B) 이미 실측된 결과를, 키 없는 실행이 지워버리면 안 된다.
//
// 해소 규칙: **문서는 정보량이 줄어드는 방향으로 절대 덮어쓰이지 않는다.**
//   - 등급 measured(실측 있음) > placeholder(실측 없음)
//   - placeholder 문서는 어떤 실행이든 현재 상태로 다시 쓴다 → (A) 충족
//   - measured 문서는 실측에 성공한 실행만 갱신할 수 있다 → (B) 충족
//   - 이때 measured 문서의 헤더는 여전히 "그 문서를 만든 실행"을 정확히 말하므로 (A) 도 깨지지 않는다.
// 등급은 문서 첫 줄의 마커로 판정한다. 마커가 없으면 사람이 쓴 문서로 보고 보존한다.

export const DOC_STATE_MARKER = '<!-- nexon-probe:'

export type DocState = 'measured' | 'placeholder' | 'absent'

/** 문서 본문에서 등급을 읽는다. 도구가 만들지 않은 문서는 안전하게 measured 취급(=보존). */
export function parseDocState(text: string | null): DocState {
  if (text === null) return 'absent'
  const head = text.slice(0, 500)
  if (!head.includes(DOC_STATE_MARKER)) return 'measured'
  return head.includes('state=measured') ? 'measured' : 'placeholder'
}

/** 이번 실행이 문서를 덮어써도 되는가. 순수 함수라 단위 점검 대상이다. */
export function mayOverwriteDoc(current: DocState, next: Exclude<DocState, 'absent'>, force: boolean): boolean {
  if (force) return true
  if (current === 'measured' && next === 'placeholder') return false
  return true
}

export interface DocWriteResult {
  readonly written: boolean
  readonly state: Exclude<DocState, 'absent'>
  readonly previous: DocState
  readonly reason: string
}

/** 위 규칙에 따라 관측 문서를 쓰거나 보존한다. */
export async function writeObservedDoc(input: {
  readonly docPath: string
  readonly summary: Summary
  readonly diffText: string | null
  readonly scrub: (text: string) => string
  readonly force: boolean
}): Promise<DocWriteResult> {
  const next: Exclude<DocState, 'absent'> = input.summary.observations === null ? 'placeholder' : 'measured'
  let existing: string | null = null
  try {
    existing = await readFile(input.docPath, 'utf8')
  } catch {
    existing = null
  }
  const previous = parseDocState(existing)

  if (!mayOverwriteDoc(previous, next, input.force)) {
    return {
      written: false,
      state: next,
      previous,
      reason:
        '기존 문서에 실측 결과가 있어 보존했습니다. 이번 실행은 실측치가 없어 덮어쓰면 정보가 사라집니다. ' +
        '(정말 덮어쓰려면 --overwrite-doc)',
    }
  }

  await mkdir(path.dirname(input.docPath), { recursive: true })
  await writeFile(input.docPath, input.scrub(renderObservedMarkdown(input.summary, input.diffText)), 'utf8')
  return {
    written: true,
    state: next,
    previous,
    reason: next === 'measured' ? '실측 결과로 갱신했습니다.' : '실측치가 없어 "아직 실측되지 않음" 상태로 갱신했습니다.',
  }
}

export async function readPreviousSummary(latestPath: string): Promise<Json | null> {
  try {
    const text = await readFile(latestPath, 'utf8')
    return JSON.parse(text) as Json
  } catch {
    return null
  }
}

/**
 * 요약을 저장한다. **마스킹을 마친 JSON** 을 받는다 — 이 파일이 다음 실행의 드리프트 비교 기준이므로,
 * 저장본과 비교본이 같은 마스킹 상태여야 헛된 diff 가 나오지 않는다.
 */
export async function writeLatest(writer: Writer, summaryJson: Json): Promise<void> {
  await mkdir(path.dirname(writer.latestPath), { recursive: true })
  await writeFile(writer.latestPath, writer.scrub(`${JSON.stringify(summaryJson, null, 2)}\n`), 'utf8')
}

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

function bullet(values: readonly string[], emptyText = '_(수집 0건)_'): string {
  if (values.length === 0) return emptyText
  return values.map((value) => `\`${value}\``).join(', ')
}

function statusIcon(status: string): string {
  switch (status) {
    case 'answered':
      return '✅ 해소'
    case 'partial':
      return '🟡 부분'
    default:
      return '⬜ 미해소'
  }
}

/** 사람이 읽는 관측 문서를 만든다. 여기 들어가는 값은 전부 마스킹을 거친 것이어야 한다. */
export function renderObservedMarkdown(summary: Summary, diffText: string | null): string {
  const observations = summary.observations
  const state: Exclude<DocState, 'absent'> = observations === null ? 'placeholder' : 'measured'
  const lines: string[] = []

  // 갱신 규칙 판정용 마커. 첫 줄에 두어 싸게 읽는다. 지우지 말 것.
  lines.push(`${DOC_STATE_MARKER} state=${state}; runId=${summary.runId}; mode=${summary.mode} -->`)
  lines.push('# 넥슨 오픈 API 실측 관측 결과')
  lines.push('')
  lines.push('> 이 문서는 `pnpm probe` 가 **자동 생성**합니다. 손으로 고치지 마세요.')
  lines.push('> 값의 근거는 `.nexon-probe-out/raw/<runId>/*.json` (gitignore 대상) 에 있습니다.')
  lines.push('>')
  lines.push('> **갱신 규칙 — 이 문서는 정보량이 줄어드는 방향으로 절대 덮어쓰이지 않습니다.**')
  lines.push('> - 아래 헤더는 항상 **이 문서를 만든 실행**의 상태를 말합니다.')
  lines.push('> - 실측 결과가 담긴 문서는 **실측에 성공한 실행만** 갱신할 수 있습니다.')
  lines.push('>   키가 없거나 무효인 실행은 이 문서를 건드리지 않고 보존합니다 (`--overwrite-doc` 로만 강제 가능).')
  lines.push('> - 아직 실측 전(=이 표시가 남아 있는 상태)이라면 어떤 실행이든 현재 상태로 다시 씁니다.')
  lines.push('> - `--dry-run`(기본 모드)은 **이 문서를 절대 쓰지 않습니다.** 요청도 파일 쓰기도 0건입니다.')
  lines.push('')
  lines.push(`- 실행 ID: \`${summary.runId}\``)
  lines.push(`- 생성 시각: ${summary.generatedAt}`)
  lines.push(`- 모드: \`${summary.mode}\``)
  lines.push(
    `- 호출: 계획 ${String(summary.tool.maxPlannedCalls)}회 / 실행 ${String(summary.tool.executedCalls)}회 / 예산 ${String(summary.tool.budget)}회 / 스로틀 ${String(summary.tool.rps)}req/s`,
  )
  if (summary.tool.abortedReason !== null) lines.push(`- ⚠️ 중단됨: ${summary.tool.abortedReason}`)
  lines.push(`- API 키: ${summary.key.present ? `있음 (출처 \`${summary.key.source ?? '?'}\`)` : '**없음**'}${summary.key.valid === null ? '' : summary.key.valid ? ' / 유효' : ' / **무효**'}`)
  lines.push('')
  lines.push('**비식별화**: API 키는 어떤 값에도 포함되지 않습니다. `ocid` / `account_id` 는 앞 6자만 남겼습니다.')
  lines.push('')

  if (observations === null) {
    lines.push('---')
    lines.push('')
    lines.push('## ⚠️ 아직 실측되지 않았습니다')
    lines.push('')
    lines.push(
      summary.key.present
        ? '유효한 API 키로 호출하지 못해 본문이 비어 있습니다. 키를 확인하고 아래를 실행하면 이 문서가 채워집니다.'
        : '이 저장소에 **NEXON API 키가 없습니다.** 키를 넣고 아래를 실행하면 이 문서가 채워집니다.',
    )
    lines.push('')
    lines.push('```bash')
    lines.push('# .env.local 에  NEXON_API_KEY=발급받은키  한 줄 추가 후')
    lines.push('pnpm probe --yes')
    lines.push('```')
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## 미확인 항목 해소 현황')
  lines.push('')
  lines.push('| 항목 | 질문 | 상태 | 실측 결과 |')
  lines.push('|---|---|---|---|')
  for (const finding of summary.unknowns) {
    lines.push(
      `| \`${finding.id}\` | ${escapeCell(finding.question)} | ${statusIcon(finding.status)} | ${escapeCell(finding.answer)} |`,
    )
  }
  lines.push('')

  if (observations !== null) {
    lines.push('---')
    lines.push('')
    lines.push('## 계정 / 캐릭터')
    lines.push('')
    lines.push(`- \`account_list\` 길이: **${String(observations.accountCount)}**`)
    lines.push(`- 계정 식별자(마스킹): ${bullet(observations.accountIdsMasked)}`)
    lines.push(`- 캐릭터 총 ${String(observations.characterCount)}명 (계정별 ${observations.charactersPerAccount.join(', ')})`)
    lines.push(`- 월드: ${bullet(observations.worlds)}`)
    lines.push(
      `- 스케줄러 응답 있음 ${String(observations.schedulerCharacters)}명 / 비어 있음(미접속 추정) ${String(observations.schedulerEmpty)}명`,
    )
    lines.push('')

    lines.push('## `boss_contents[]` 실제 값')
    lines.push('')
    lines.push(`- 수집한 보스 항목: **${String(observations.bossEntryCount)}건**`)
    lines.push(`- \`difficulty\` 값 집합: ${bullet(observations.bossDifficulties)}`)
    lines.push(`- \`cycle\` 값 집합: ${bullet(observations.bossCycles)}`)
    lines.push(`- \`content_name\` (${String(observations.bossContentNames.length)}종): ${bullet(observations.bossContentNames)}`)
    lines.push(`- \`weekly_boss_clear_count\`: ${observations.weeklyBossClearCounts.join(', ') || '_(없음)_'}`)
    lines.push(`- \`weekly_boss_clear_limit_count\`: **${observations.weeklyBossClearLimitCounts.join(', ') || '_(없음)_'}**`)
    lines.push('')

    lines.push('## `daily_contents[]` / `weekly_contents[]` 실제 값')
    lines.push('')
    lines.push(`- daily \`type\`: ${bullet(observations.dailyTypes)}`)
    lines.push(`- daily \`quest_state\`: ${bullet(observations.dailyQuestStates)}`)
    lines.push(`- daily \`content_name\` (${String(observations.dailyContentNames.length)}종): ${bullet(observations.dailyContentNames)}`)
    lines.push(`- weekly \`type\`: ${bullet(observations.weeklyTypes)}`)
    lines.push(`- weekly \`quest_state\`: ${bullet(observations.weeklyQuestStates)}`)
    lines.push(`- weekly \`content_name\` (${String(observations.weeklyContentNames.length)}종): ${bullet(observations.weeklyContentNames)}`)
    lines.push('')

    lines.push('## 플래그 필드의 실제 타입')
    lines.push('')
    if (observations.flagKinds.length === 0) lines.push('_(수집 0건)_')
    else {
      lines.push('| 필드 | JS 타입 | 관측된 값 |')
      lines.push('|---|---|---|')
      for (const kind of observations.flagKinds) {
        lines.push(`| \`${kind.field}\` | ${kind.jsTypes.map((type) => `\`${type}\``).join(', ')} | ${bullet(kind.values)} |`)
      }
    }
    lines.push('')

    lines.push('## 데이터 지연 실측')
    lines.push('')
    lines.push('> 응답 `date` 는 KST 일 단위(시·분 0)입니다. 아래 차이는 "지연"이 아니라 **기준일 00:00 부터 관측 시각까지의 경과**를 포함합니다.')
    lines.push('')
    lines.push('| 캐릭터 | 응답 date | 관측 시각(UTC) | 차이(h) |')
    lines.push('|---|---|---|---|')
    for (const entry of observations.dateLag) {
      lines.push(
        `| ${entry.characterMasked} | \`${entry.responseDate ?? '(없음)'}\` | ${entry.observedAt} | ${entry.lagHours === null ? '-' : String(entry.lagHours)} |`,
      )
    }
    lines.push('')

    if (observations.dateBackfill.length > 0) {
      lines.push('## `date` 소급 조회 범위')
      lines.push('')
      lines.push('| date | 며칠 전 | HTTP | error.name | 본문 있음 |')
      lines.push('|---|---|---|---|---|')
      for (const entry of observations.dateBackfill) {
        lines.push(
          `| \`${entry.date}\` | ${entry.daysAgo === null ? '-' : String(entry.daysAgo)} | ${String(entry.status ?? '-')} | ${entry.errorName ?? '-'} | ${entry.hasPayload ? 'O' : 'X'} |`,
        )
      }
      lines.push('')
    }

    lines.push('## 에러 형태 실측')
    lines.push('')
    lines.push('| 탐침 | 상황 | HTTP | error.name | error.message |')
    lines.push('|---|---|---|---|---|')
    for (const probe of observations.errorProbes) {
      lines.push(
        `| \`${probe.label}\` | ${escapeCell(probe.description)} | ${String(probe.httpStatus ?? '-')} | \`${probe.errorName ?? '-'}\` | ${escapeCell(probe.errorMessage ?? '-')} |`,
      )
    }
    lines.push('')

    lines.push('## 응답 헤더')
    lines.push('')
    lines.push(`- 관측된 헤더: ${bullet(observations.responseHeaderNames)}`)
    const rateKeys = Object.keys(observations.rateLimitHeaders)
    lines.push(
      `- 잔여 호출량 관련 헤더: ${rateKeys.length === 0 ? '**없음** → 남은 할당량은 우리가 직접 세야 합니다.' : bullet(rateKeys)}`,
    )
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## 넥슨 OpenAPI 스펙 대조')
  lines.push('')
  lines.push(`스펙 목록 출처: ${summary.spec.indexUrl} 의 \`__NEXT_DATA__\` → \`fileUrl\``)
  lines.push('')
  if (summary.spec.files.length === 0) lines.push('_(스펙을 받지 않았습니다)_')
  else {
    lines.push('| id | 분류 | 파일명 (타임스탬프 = 개정 신호) | sha256(앞12) | 파싱 |')
    lines.push('|---|---|---|---|---|')
    for (const file of summary.spec.files) {
      lines.push(
        `| ${String(file.id)} | ${file.categoryName} | \`${file.fileName}\` | \`${file.sha256.slice(0, 12)}\` | ${file.parsed ? 'O' : `X (${escapeCell(file.parseError ?? '')})`} |`,
      )
    }
  }
  lines.push('')

  if (summary.specComparison.length > 0) {
    lines.push('### 스펙 ↔ 실제 응답 차이')
    lines.push('')
    for (const comparison of summary.specComparison) {
      lines.push(`#### \`${comparison.apiPath}\` — 스키마 \`${comparison.schemaName ?? '?'}\``)
      lines.push('')
      if (comparison.note !== null) {
        lines.push(`- ${comparison.note}`)
        lines.push('')
        continue
      }
      lines.push(`- 스펙에 있는데 응답에 없음: ${bullet(comparison.missingInResponse, '_없음_')}`)
      lines.push(`- 응답에 있는데 스펙에 없음: ${bullet(comparison.extraInResponse, '_없음_')}`)
      lines.push(
        `- 타입 불일치: ${
          comparison.typeMismatch.length === 0
            ? '_없음_'
            : comparison.typeMismatch.map((item) => `\`${item.path}\` 스펙=${item.spec} 실제=${item.observed}`).join(', ')
        }`,
      )
      lines.push('')
    }
  }

  if (diffText !== null) {
    lines.push('---')
    lines.push('')
    lines.push('## 이전 실행 대비 변경점 (드리프트)')
    lines.push('')
    lines.push('```')
    lines.push(diffText)
    lines.push('```')
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('Data based on NEXON Open API')
  lines.push('')
  return lines.join('\n')
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
