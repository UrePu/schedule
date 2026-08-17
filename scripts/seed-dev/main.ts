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
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  auditSeedRange,
  countBossMaster,
  countSeedRows,
  deleteSeedRows,
  dumpSeedRows,
  insertUnits,
  upsertSeedRows,
} from './lib/apply'
import { parseArgs, usage } from './lib/cli'
import { createServiceRoleClient, type Client } from './lib/client'
import { buildDataset, EXCEPTION_NOTES, type Dataset } from './lib/dataset'
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

  // ── 삭제 전용 모드 ──────────────────────────────────────────────────────────
  // `--reset` 은 지운 뒤 곧바로 되넣으므로 "목데이터를 없앤다"는 목적에 쓸 수 없다.
  if (options.purge) {
    return purge(client, data, options.yes)
  }

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

/** 백업 파일이 쌓이는 곳. `.gitignore` 에 올라가 있다 — 남의 닉네임이 들어 있다. */
const BACKUP_DIR = path.join(ROOT_DIR, '.seed-backups')

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 삭제 전용 모드 — 시드를 걷어내고 **다시 넣지 않는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 DB 에는 실사용자 데이터가 섞여 있다. 그래서 순서가 중요하다:
 *
 *   1. 감사 — 테이블마다 전체 / 삭제 대상 / **대역 고아**를 센다.
 *   2. 고아가 하나라도 있으면 **멈춘다.** 열거 목록 밖의 `5eed…` 행은 우리가 만든 것인지
 *      확신할 수 없고, 확신 없이 지우는 것이 사고다.
 *   3. `--yes` 가 없으면 여기서 끝. 표만 보여 준다.
 *   4. 지우기 전에 행 전체를 JSON 으로 남긴다.
 *   5. 열거된 id 로만 삭제한다.
 *   6. 다시 세어서 **남은 행 = 전체 − 삭제 대상**임을 확인하고, 보스 마스터가
 *      1행도 변하지 않았음을 확인한다.
 */
async function purge(client: Client, data: Dataset, confirmed: boolean): Promise<number> {
  console.log('삭제 전용 모드 (--purge) — 지운 뒤 **다시 넣지 않습니다**')
  console.log(line('═'))
  console.log('')

  const before = await auditSeedRange(client, data)
  const bossBefore = await countBossMaster(client)

  console.log('삭제 전 상태')
  console.log(line())
  console.log(
    `  ${pad('테이블', 26)}${pad('전체', 8)}${pad('삭제 대상', 12)}${pad('대역 고아', 12)}삭제 후 남음`,
  )
  for (const row of before) {
    console.log(
      `  ${pad(row.table, 26)}${pad(String(row.total), 8)}${pad(String(row.enumerated), 12)}` +
        `${pad(String(row.orphanIds.length), 12)}${row.total - row.enumerated}`,
    )
  }
  console.log(line())
  const totalBefore = before.reduce((s, r) => s + r.total, 0)
  const targetTotal = before.reduce((s, r) => s + r.enumerated, 0)
  const orphanTotal = before.reduce((s, r) => s + r.orphanIds.length, 0)
  console.log(
    `  ${pad('합계', 26)}${pad(String(totalBefore), 8)}${pad(String(targetTotal), 12)}` +
      `${pad(String(orphanTotal), 12)}${totalBefore - targetTotal}`,
  )
  console.log('')
  console.log('  "삭제 후 남음" 이 실사용자 데이터입니다. 이 값은 삭제로 줄어들지 않습니다.')
  console.log('')

  console.log('보스 마스터 (읽기 전용 — 이 값이 변하면 사고입니다)')
  console.log(line())
  for (const [table, count] of Object.entries(BOSS_MASTER_BASELINE)) {
    const actual = bossBefore[table] ?? 0
    console.log(`  ${pad(table, 26)}${pad(String(actual), 8)}기준값 ${count}`)
  }
  console.log('')

  if (orphanTotal > 0) {
    console.error('✗ 열거 목록에 없는 시드 대역 행이 있습니다. 자동으로 지우지 않습니다.')
    console.error('')
    for (const row of before) {
      for (const id of row.orphanIds) {
        console.error(`    ${pad(row.table, 26)}${id}`)
      }
    }
    console.error('')
    console.error('  옛 버전 시드가 남았거나, 실사용자 행이 같은 대역을 쓰고 있습니다.')
    console.error('  어느 쪽인지 사람이 확인한 뒤 처리하세요.')
    return 1
  }

  if (targetTotal === 0) {
    console.log('✓ 지울 시드 행이 없습니다. DB 에는 아무것도 쓰지 않았습니다.')
    return 0
  }

  if (!confirmed) {
    console.log('계획만 출력했습니다. DB 에는 아무것도 쓰지 않았습니다.')
    console.log('실행하려면 `--yes` 를 붙이세요:')
    console.log('  pnpm seed:dev --purge --yes')
    return 0
  }

  // ── 백업 ────────────────────────────────────────────────────────────────────
  const snapshot = await dumpSeedRows(client, data)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const backupPath = path.join(BACKUP_DIR, `seed-purge-${stamp}.json`)
  await mkdir(BACKUP_DIR, { recursive: true })
  const payload = JSON.stringify(
    {
      purgedAt: new Date().toISOString(),
      weekKey: data.weekKey,
      note: '개발용 시드 삭제 직전 스냅샷. 되돌리려면 `pnpm seed:dev --yes` 가 더 쉽다.',
      tables: snapshot,
    },
    null,
    2,
  )
  await writeFile(backupPath, payload, 'utf8')
  const backedUp = Object.values(snapshot).reduce((s, rows) => s + rows.length, 0)
  console.log('백업')
  console.log(line())
  console.log(`  ${backedUp}행을 저장했습니다.`)
  console.log(`  ${backupPath}`)
  console.log('  되돌리기: `pnpm seed:dev --yes` (시드는 결정론적이라 같은 데이터가 들어갑니다)')
  console.log('')

  if (backedUp !== targetTotal) {
    console.error(`✗ 백업 행 수(${backedUp})가 삭제 대상(${targetTotal})과 다릅니다. 중단합니다.`)
    return 1
  }

  // ── 삭제 ────────────────────────────────────────────────────────────────────
  console.log('삭제 중…')
  const deleted = await deleteSeedRows(client, data)
  for (const r of deleted) {
    if (r.count > 0) console.log(`  - ${pad(r.table, 26)}${r.count}행 삭제`)
  }
  const deletedTotal = deleted.reduce((s, r) => s + r.count, 0)
  console.log(`  총 ${deletedTotal}행 삭제`)
  console.log('')

  // ── 삭제 후 확인 ────────────────────────────────────────────────────────────
  const after = await auditSeedRange(client, data)
  const bossAfter = await countBossMaster(client)
  const beforeByTable = new Map(before.map((r) => [r.table, r]))

  console.log('삭제 후 상태')
  console.log(line())
  console.log(`  ${pad('테이블', 26)}${pad('전체', 8)}${pad('남은 시드', 12)}판정`)

  let failed = 0
  for (const row of after) {
    const prev = beforeByTable.get(row.table)
    const expected = (prev?.total ?? 0) - (prev?.enumerated ?? 0)
    const ok = row.total === expected && row.enumerated === 0 && row.orphanIds.length === 0
    if (!ok) failed += 1
    console.log(
      `  ${pad(row.table, 26)}${pad(String(row.total), 8)}${pad(String(row.enumerated), 12)}` +
        `${ok ? '✓' : `✗ 기대 ${expected}행`}`,
    )
  }
  console.log(line())

  for (const [table, count] of Object.entries(BOSS_MASTER_BASELINE)) {
    const ok = (bossAfter[table] ?? 0) === count
    if (!ok) failed += 1
    console.log(`  ${pad(table, 26)}${pad(String(bossAfter[table] ?? 0), 8)}${ok ? '✓' : `✗ 기준값 ${count}`}`)
  }
  console.log('')

  if (failed > 0) {
    console.error(`✗ ${failed}개 항목이 기대와 다릅니다. 백업 파일로 복구를 검토하세요.`)
    return 1
  }

  console.log('✓ 시드 삭제 완료. 남은 행은 전부 실데이터입니다.')
  return 0
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
