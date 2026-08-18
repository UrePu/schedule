/**
 * 보스 마스터 상수 생성기 / 어긋남 검사기.
 *
 * ```
 * pnpm boss-master          # supabase/migrations → src/lib/boss-master/generated.ts 재생성
 * pnpm boss-master:check    # 생성물이 마이그레이션과 같은지만 확인 (쓰지 않는다)
 * ```
 *
 * `--check` 는 `prebuild` 로 걸려 있어 `pnpm build` 가 자동으로 먼저 돌린다.
 * 검사 없이 생성만 두면 다음 게임 패치 때 SQL 과 상수가 **조용히** 갈라진다.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { emit } from './lib/emit'
import { parseBossMaster } from './lib/parse'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const OUTPUT = path.join(ROOT, 'src', 'lib', 'boss-master', 'generated.ts')

/**
 * CRLF → LF.
 *
 * ★ 이 저장소는 `core.autocrlf = true` 다 — 체크아웃하면 생성물이 CRLF 가 된다.
 *   줄바꿈 차이를 어긋남으로 신고하면 검사가 늑대소년이 되어 **진짜 어긋남을 아무도
 *   안 보게 된다.** 내용만 비교한다.
 */
function normalizeEol(text: string): string {
  return text.split('\r\n').join('\n')
}

function usage(): string {
  return [
    '사용법: pnpm boss-master [--check]',
    '',
    '  (인자 없음)  마이그레이션을 읽어 src/lib/boss-master/generated.ts 를 다시 만든다.',
    '  --check      다시 만들지 않고 현재 생성물과 다른지만 확인한다. 다르면 종료 코드 1.',
  ].join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const unknown = argv.filter((a) => a !== '--check' && a !== '--help' && a !== '-h')
  if (unknown.length > 0) {
    console.error(`알 수 없는 옵션: ${unknown.join(' ')}\n\n${usage()}`)
    process.exit(2)
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return
  }

  const check = argv.includes('--check')
  const data = await parseBossMaster(MIGRATIONS)
  const next = emit(data)

  const summary =
    `보스 ${data.bosses.length} · 난이도 ${data.difficulties.length} · ` +
    `가격 ${data.prices.length} · 별칭 ${data.aliases.length}`

  if (!check) {
    await writeFile(OUTPUT, next, 'utf8')
    console.log(`생성 완료: src/lib/boss-master/generated.ts (${summary})`)
    return
  }

  let current: string
  try {
    /*
      ★ 줄바꿈은 **정규화해서 비교한다.** git `core.autocrlf` 나 편집기 설정에 따라
        같은 내용이 CRLF 로 체크아웃될 수 있는데, 그것을 어긋남으로 신고하면 검사가
        늑대소년이 되어 진짜 어긋남을 아무도 안 보게 된다.
    */
    current = normalizeEol(await readFile(OUTPUT, 'utf8'))
  } catch {
    console.error(
      [
        '보스 마스터 상수가 없습니다: src/lib/boss-master/generated.ts',
        '`pnpm boss-master` 로 생성하세요.',
      ].join('\n'),
    )
    process.exit(1)
    return
  }

  if (current === next) {
    console.log(`보스 마스터 상수가 마이그레이션과 일치합니다 (${summary}).`)
    return
  }

  const currentLines = current.split('\n')
  const nextLines = next.split('\n')
  const diffs: string[] = []
  for (let i = 0; i < Math.max(currentLines.length, nextLines.length); i += 1) {
    if (currentLines[i] === nextLines[i]) continue
    diffs.push(`  ${i + 1}행`)
    diffs.push(`    생성물: ${currentLines[i] ?? '(없음)'}`)
    diffs.push(`    SQL   : ${nextLines[i] ?? '(없음)'}`)
    if (diffs.length >= 30) {
      diffs.push('  … (이하 생략)')
      break
    }
  }

  console.error(
    [
      '❌ 보스 마스터 상수가 마이그레이션과 어긋납니다.',
      '',
      ...diffs,
      '',
      'supabase/migrations 가 단일 진실입니다. SQL 을 고친 뒤 `pnpm boss-master` 를 돌려',
      '생성물을 함께 커밋하세요. 생성물만 손으로 고치면 DB 와 화면이 갈라집니다.',
    ].join('\n'),
  )
  process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
