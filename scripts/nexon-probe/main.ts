/**
 * 넥슨 오픈 API 실측 탐침 CLI.
 *
 *   pnpm probe                 계획만 출력 (dry-run, 네트워크 요청 0건)
 *   pnpm probe --yes           실제 호출
 *   pnpm probe --yes --diff    이전 실행과 비교해 바뀐 것만 출력 (패치 후 재실행용)
 *   pnpm probe --selftest      네트워크/키 없이 단위 점검
 *
 * 안전 원칙
 *  - 기본이 dry-run 이다. `--yes` 없이는 요청이 한 건도 나가지 않는다(비대화형에서 멈추지 않기 위함).
 *  - 초당 호출 수 스로틀 + 총 호출 예산 하드 스톱 + 429 즉시 중단.
 *  - API 키는 읽기만 하고, 어떤 출력에도 남기지 않는다.
 *  - 키가 없거나 네트워크가 없어도 크래시하지 않고 exit 0 으로 끝난다.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { parseArgs, usage } from './lib/cli'
import type { Options } from './lib/cli'
import { Logger } from './lib/log'
import { API_KEY_ENV_NAME, loadApiKey, missingKeyGuidance } from './lib/env'
import { makeScrubber } from './lib/redact'
import { SPEC_FETCH_ESTIMATE, buildPlan } from './lib/plan'
import { run } from './lib/run'
import { runSelfTest } from './lib/selftest'
import { diffJson, formatChanges } from './lib/diff'
import { maskIdsDeep, readPreviousSummary, toJson, writeLatest, writeObservedDoc, writeRaw } from './lib/report'
import { resolveUnknowns } from './lib/observe'
import type { CallDigest, RunMode, Summary } from './lib/types'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OBSERVED_DOC = path.join(REPO_ROOT, 'Claude', 'NEXON-API-OBSERVED.md')

function runId(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
}

/** 호출을 한 건도 하지 못한 실행의 요약 (키 없음 등). 문서를 "실측 전" 상태로 되돌리는 데 쓴다. */
function emptySummary(input: {
  runId: string
  generatedAt: string
  mode: RunMode
  maxPlannedCalls: number
  options: Options
  specNote: string
}): Summary {
  return {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: input.generatedAt,
    mode: input.mode,
    tool: {
      maxPlannedCalls: input.maxPlannedCalls,
      executedCalls: 0,
      budget: input.options.budget,
      rps: input.options.rps,
      abortedReason: null,
    },
    key: { present: false, valid: null, source: null },
    spec: { indexUrl: '', files: [] },
    calls: [],
    observations: null,
    specComparison: [],
    unknowns: resolveUnknowns(null, input.specNote),
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const log = new Logger()

  if (options.help) {
    log.line(usage())
    return 0
  }

  if (options.errors.length > 0) {
    for (const error of options.errors) log.error(error)
    log.line('')
    log.line(usage())
    return 1
  }

  if (options.selftest) {
    log.line('nexon-probe 단위 점검 (네트워크 없음 / 키 없음 / 실시간 대기 없음)')
    log.line('')
    const ok = await runSelfTest((text) => {
      log.line(text)
    })
    return ok ? 0 : 1
  }

  const lookup = await loadApiKey(REPO_ROOT)
  // 이 시점 이후의 모든 출력은 키를 마스킹한다 (설계상 담기지 않지만 2차 방어선).
  const scrub = makeScrubber([lookup.key])
  log.setScrubber(scrub)

  const plan = buildPlan(options)
  const maxApiCalls = Math.min(plan.length, options.budget)

  log.line('nexon-probe — 넥슨 오픈 API 실측 탐침')
  log.line('')
  log.line(`  모드            ${options.specOnly ? 'spec-only' : options.dryRun ? 'dry-run (실제 요청 0건)' : 'live'}`)
  log.line(`  이번 실행에서 최대 ${String(maxApiCalls)}회 호출합니다. (예산 ${String(options.budget)}회 / 스로틀 ${String(options.rps)}req/s)`)
  if (options.spec) {
    log.line(`  + 넥슨 OpenAPI YAML 정적 파일 약 ${String(SPEC_FETCH_ESTIMATE)}건 — API 키 할당량과 무관합니다.`)
  }
  log.line(`  캐릭터 수       ${String(options.characters)}`)
  log.line(`  출력            ${options.outDir}/  ·  Claude/NEXON-API-OBSERVED.md`)
  log.line(`  캐릭터명        ${options.redactNames ? '마스킹' : '노출 (본인 데이터)'}`)
  log.line('')

  // ── 키 없음: 안내 + 관측 문서 상태 갱신 후 정상 종료 ────────
  //
  // "키가 없다"는 것은 가정이 아니라 **확정된 관측**이므로, 문서가 아직 실측 전이라면
  // 헤더를 현재 상태로 다시 써서 문서가 사실과 어긋나지 않게 한다.
  // 반대로 이미 실측 결과가 든 문서는 절대 건드리지 않는다 (report.writeObservedDoc 의 규칙).
  if (lookup.key === null && !options.specOnly) {
    log.section('API 키를 찾지 못했습니다')
    log.line('')
    log.line(missingKeyGuidance(REPO_ROOT))
    log.line('')
    log.line(`  (찾아본 곳: ${lookup.searched.join(', ')} / 환경변수 이름: ${API_KEY_ENV_NAME})`)
    log.line('')

    const startedAt = new Date()
    const docResult = await writeObservedDoc({
      docPath: OBSERVED_DOC,
      summary: emptySummary({
        runId: runId(startedAt),
        generatedAt: startedAt.toISOString(),
        mode: 'no-key',
        maxPlannedCalls: maxApiCalls,
        options,
        specNote: 'API 키가 없어 실행이 조기 종료되었습니다. 스펙 대조도 수행하지 않았습니다.',
      }),
      diffText: null,
      scrub,
      force: options.overwriteDoc,
    })
    log.line(`  관측 문서       ${docResult.written ? '갱신' : '보존'} — ${docResult.reason}`)
    log.line('')
    log.line('아래는 키 없이도 지금 확인할 수 있는 호출 계획입니다.')
    printPlan(log, options)
    return 0
  }

  // ── dry-run: 계획만 출력, 요청 0건 / 파일 쓰기 0건 ──────────
  //
  // dry-run 의 계약은 "부작용 0" 이다. 관측을 하나도 하지 않았으므로 문서에 쓸 사실도 없다.
  // 여기서 문서를 쓰면 이미 있는 실측 결과를 날릴 위험만 생긴다 → 아무것도 건드리지 않는다.
  if (options.dryRun) {
    log.section('호출 계획 (dry-run — 실제 요청은 나가지 않습니다)')
    printPlan(log, options)
    log.line('')
    log.line('  dry-run 은 파일도 쓰지 않습니다 — Claude/NEXON-API-OBSERVED.md 는 그대로 둡니다.')
    log.line('  실제로 호출하려면 --yes 를 붙이세요:   pnpm probe --yes')
    return 0
  }

  // ── 실제 실행 ───────────────────────────────────────────────
  const startedAt = new Date()
  const id = runId(startedAt)
  const outDir = path.isAbsolute(options.outDir) ? options.outDir : path.join(REPO_ROOT, options.outDir)
  const writer = { rawDir: path.join(outDir, 'raw', id), latestPath: path.join(outDir, 'latest.json'), scrub }

  const previous = await readPreviousSummary(writer.latestPath)

  let outcome: Awaited<ReturnType<typeof run>>
  try {
    outcome = await run(options, log, lookup.key)
  } catch (error) {
    log.error(`탐침 중 예기치 못한 오류: ${error instanceof Error ? error.message : String(error)}`)
    log.line('부분 결과가 있다면 raw/ 에 남아 있습니다. 도구는 정상 종료합니다.')
    return 1
  }

  await mkdir(writer.rawDir, { recursive: true })
  for (let i = 0; i < outcome.calls.length; i += 1) {
    const call = outcome.calls[i]
    if (call === undefined) continue
    await writeRaw(writer, i + 1, call)
  }

  const digests: CallDigest[] = outcome.calls.map((call) => ({
    label: call.label,
    path: call.path,
    status: call.status,
    errorName: call.errorName,
    skipped: call.skipped,
    skipReason: call.skipReason,
  }))

  const summary: Summary = {
    schemaVersion: 1,
    runId: id,
    generatedAt: startedAt.toISOString(),
    mode: options.specOnly ? 'spec-only' : 'live',
    tool: {
      maxPlannedCalls: maxApiCalls,
      executedCalls: outcome.executedCalls,
      budget: options.budget,
      rps: options.rps,
      abortedReason: outcome.abortedReason,
    },
    key: { present: lookup.key !== null, valid: outcome.keyValid, source: lookup.source },
    spec: { indexUrl: outcome.specIndexUrl, files: outcome.specFiles },
    calls: digests,
    observations: outcome.observations,
    specComparison: outcome.specComparison,
    unknowns: outcome.unknowns,
  }

  const summaryJson = maskIdsDeep(toJson(summary))
  await writeLatest(writer, summaryJson)

  let diffText: string | null = null
  if (options.diff) {
    if (previous === null) {
      diffText = '비교할 이전 latest.json 이 없습니다. 이번 실행이 기준선이 됩니다.'
    } else {
      // 이번 실행에서 아예 수집하지 않은 영역은 "사라짐"으로 오인되지 않게 비교에서 뺀다.
      const extraIgnore: RegExp[] = []
      if (!options.spec) extraIgnore.push(/^spec\b/, /^specComparison\b/)
      if (outcome.observations === null) extraIgnore.push(/^observations\b/)
      diffText = formatChanges(diffJson(previous, summaryJson, extraIgnore))
    }
    log.section('드리프트 — 이전 실행 대비 변경점')
    log.line(diffText)
  }

  const docResult = await writeObservedDoc({
    docPath: OBSERVED_DOC,
    summary,
    diffText,
    scrub,
    force: options.overwriteDoc,
  })

  log.section('완료')
  log.line(`  API 호출        ${String(outcome.executedCalls)}회 (예산 ${String(options.budget)}회)`)
  log.line(`  스펙 파일       ${String(outcome.specFetchCount)}건 다운로드`)
  if (outcome.abortedReason !== null) log.warn(`중단됨: ${outcome.abortedReason}`)
  log.line(`  원본            ${path.relative(REPO_ROOT, writer.rawDir)}`)
  log.line(`  요약(기계)      ${path.relative(REPO_ROOT, writer.latestPath)}`)
  log.line(
    `  요약(사람)      ${path.relative(REPO_ROOT, OBSERVED_DOC)} — ${docResult.written ? '갱신' : '보존'}: ${docResult.reason}`,
  )
  log.line('')
  const answered = outcome.unknowns.filter((finding) => finding.status === 'answered').length
  log.line(`  미확인 항목 ${String(answered)}/${String(outcome.unknowns.length)} 해소`)
  for (const finding of outcome.unknowns) {
    if (finding.status === 'unanswered') log.line(`    ⬜ ${finding.id} — ${finding.question}`)
  }
  return 0
}

function printPlan(log: Logger, options: Options): void {
  const budget = options.budget
  const plan = buildPlan(options)
  log.line('')
  for (let i = 0; i < plan.length; i += 1) {
    const call = plan[i]
    if (call === undefined) continue
    const query = Object.entries(call.query)
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    const overBudget = i >= budget ? '  ← 예산 초과로 스킵됨' : ''
    log.line(`  ${String(i + 1).padStart(2)}. GET ${call.path}${query.length > 0 ? `?${query}` : ''}${overBudget}`)
    log.line(`      ${call.purpose}`)
  }
  log.line('')
  log.line(`  합계 ${String(plan.length)}건 (예산 ${String(budget)}건)`)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    // 여기까지 왔다면 도구 자체의 버그다. 그래도 스택을 그대로 뱉지 않고 요약만 남긴다.
    console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
