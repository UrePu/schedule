/**
 * 개발용 시드 — 실제 Supabase 프로젝트에 화면 확인용 데이터를 넣는다.
 *
 *   pnpm seed:dev                  계획만 출력 (DB 쓰기 0건)
 *   pnpm seed:dev --yes            시드 투입 (멱등)
 *   pnpm seed:dev --reset --yes    시드가 만든 행만 지우고 다시 넣는다
 *   pnpm seed:dev --verify-only    현재 상태 검증만 (읽기 전용)
 *
 * ⚠️ 이것은 **개발 편의용 스크립트이지 스키마의 일부가 아니다.**
 *    마이그레이션 파일을 만들지 않으며 스키마를 절대 바꾸지 않는다. 데이터만 넣는다.
 * ⚠️ service_role 키는 어떤 경로로도 출력하지 않는다.
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { countSeedRows, deleteSeedRows, insertUnits, upsertSeedRows } from './lib/apply'
import { parseArgs, usage } from './lib/cli'
import { createServiceRoleClient } from './lib/client'
import { buildDataset, EXCEPTION_NOTES } from './lib/dataset'
import { loadSupabaseEnv, projectRefFromUrl } from './lib/env'
import { BOSS_MASTER_BASELINE, runChecks, type Check } from './lib/verify'
import { formatKst, weekStart } from './lib/week'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** CLAUDE.md §3 이 못박은 대상 프로젝트. 다른 프로젝트면 즉시 멈춘다. */
const EXPECTED_PROJECT_REF = 'hryikreaxngexhjjxfyl'

function line(char = '─', width = 78): string {
  return char.repeat(width)
}

function pad(text: string, width: number): string {
  // 한글은 폭이 2 이므로 대략적으로 보정한다 (표 정렬용, 정확도보다 가독성 목적).
  const visual = Array.from(text).reduce(
    (sum, ch) => sum + (/[ᄀ-ᇿ㄰-㆏가-힣　-〿＀-￯]/.test(ch) ? 2 : 1),
    0,
  )
  return text + ' '.repeat(Math.max(0, width - visual))
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }

  const now = new Date()
  const start = weekStart(now)
  const data = buildDataset(now, start)

  const env = await loadSupabaseEnv(ROOT_DIR)
  const ref = projectRefFromUrl(env.url)

  console.log(line('═'))
  console.log('M_Schedule 개발용 시드')
  console.log(line('═'))
  console.log(`대상 프로젝트 : ${ref ?? '(URL 형식을 해석하지 못함)'}`)
  console.log(`접속 정보 출처 : ${env.source}  (키는 출력하지 않습니다)`)
  console.log(`현재 시각      : ${formatKst(now)}`)
  console.log(`주간 경계      : ${formatKst(start)} (목요일 00:00 KST) · 주차 ${data.weekKey}`)
  console.log('')

  if (ref !== EXPECTED_PROJECT_REF) {
    console.error(
      [
        `✗ 대상 프로젝트가 다릅니다. 기대: ${EXPECTED_PROJECT_REF} / 실제: ${ref ?? '?'}`,
        '',
        '  CLAUDE.md §3 이 지정한 프로젝트에만 시드를 넣습니다.',
        '  `.env.local` 의 NEXT_PUBLIC_SUPABASE_URL 을 확인하세요.',
      ].join('\n'),
    )
    return 1
  }

  const client = createServiceRoleClient(env)

  // ── 계획 출력 ───────────────────────────────────────────────────────────────
  const units = insertUnits(data)
  const existing = await countSeedRows(client, data)
  const existingByTable = new Map(existing.map((r) => [r.table, r.count]))
  const existingTotal = existing.reduce((sum, r) => sum + r.count, 0)

  console.log('넣을 데이터 (테이블별 행 수)')
  console.log(line())
  console.log(`  ${pad('테이블', 26)}${pad('넣을 행', 10)}현재 시드 행`)
  for (const unit of units) {
    console.log(
      `  ${pad(unit.table, 26)}${pad(String(unit.rows.length), 10)}${existingByTable.get(unit.table) ?? 0}`,
    )
  }
  console.log(line())
  console.log(
    `  ${pad('합계', 26)}${pad(String(units.reduce((s, u) => s + u.rows.length, 0)), 10)}${existingTotal}`,
  )
  console.log('')

  console.log('파괴 범위')
  console.log(line())
  if (options.reset) {
    console.log('  --reset 지정됨 → 아래 행을 **삭제한 뒤** 다시 넣습니다.')
  } else {
    console.log('  삭제 없음. 같은 id 에 대한 upsert 만 수행합니다(멱등).')
  }
  console.log(
    `  삭제 대상은 이 스크립트가 만든 고정 UUID ${existingTotal}건뿐입니다 (5eed…5eed5eed5eed).`,
  )
  console.log('  조건절이 아니라 **id 열거**로 지우므로 실사용자 행에는 손이 닿지 않습니다.')
  console.log('  보스 마스터는 읽기 전용입니다 — 기대 행 수:')
  for (const [table, count] of Object.entries(BOSS_MASTER_BASELINE)) {
    console.log(`    ${pad(table, 24)}${count}`)
  }
  console.log('')

  console.log('심어 두는 엣지 케이스')
  console.log(line())
  for (const note of EXCEPTION_NOTES) {
    console.log(`  · ${note.label}`)
    console.log(`      ${note.why}`)
  }
  console.log('  · 균등이 아닌 분배 33 : 67 (칼로스 런, share_mode = manual)')
  console.log('  · 가격 미확인 보스(노멀 벨로나) 일정 1건 + 클리어 2건 → 수익 합계에서 제외')
  console.log('  · 미판매 드랍 1건 (sale_amount_meso = null)')
  console.log('  · 일정이 0건인 파티 1개 / 빠진 참가자 번호(4번) / 승계 대기 게스트 1명')
  console.log('')

  if (options.verifyOnly) {
    return report(await runChecks(client, data))
  }

  if (!options.yes) {
    console.log('계획만 출력했습니다. DB 에는 아무것도 쓰지 않았습니다.')
    console.log('실행하려면 `--yes` 를 붙이세요:')
    console.log(options.reset ? '  pnpm seed:dev --reset --yes' : '  pnpm seed:dev --yes')
    return 0
  }

  // ── 실행 ────────────────────────────────────────────────────────────────────
  if (options.reset) {
    console.log('삭제 중…')
    const deleted = await deleteSeedRows(client, data)
    const total = deleted.reduce((s, r) => s + r.count, 0)
    for (const r of deleted) {
      if (r.count > 0) console.log(`  - ${pad(r.table, 26)}${r.count}행 삭제`)
    }
    console.log(`  총 ${total}행 삭제`)
    console.log('')
  }

  console.log('삽입 중…')
  const inserted = await upsertSeedRows(client, data)
  for (const r of inserted) {
    console.log(`  + ${pad(r.table, 26)}${r.count}행`)
  }
  console.log('')

  return report(await runChecks(client, data))
}

function report(checks: readonly Check[]): number {
  const failed = checks.filter((c) => !c.ok)
  console.log('검증 (실제 DB 조회)')
  console.log(line())
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`)
    if (!check.ok) {
      console.log(`      기대: ${check.expected}`)
      console.log(`      실제: ${check.actual}`)
    }
    if (check.note !== undefined && !check.ok) {
      console.log(`      근거: ${check.note}`)
    }
  }
  console.log(line())
  console.log(`  ${checks.length - failed.length} / ${checks.length} 통과`)

  if (failed.length > 0) {
    console.log('')
    console.log('✗ 실패한 검증이 있습니다.')
    return 1
  }
  console.log('')
  console.log('✓ 시드 완료.')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error('')
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
