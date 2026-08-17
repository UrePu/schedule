/** 인자 파싱 및 사용법. */

export interface Options {
  /** 실제로 DB 를 건드린다. 없으면 계획만 출력하고 종료한다. */
  readonly yes: boolean
  /** 시드가 만든 행을 먼저 전부 지우고 다시 넣는다. */
  readonly reset: boolean
  /** 삽입 없이 검증만 수행한다(읽기 전용). */
  readonly verifyOnly: boolean
  readonly help: boolean
}

const KNOWN = new Set(['--yes', '--reset', '--verify-only', '--help', '-h'])

export function parseArgs(argv: readonly string[]): Options {
  const unknown = argv.filter((a) => !KNOWN.has(a))
  if (unknown.length > 0) {
    throw new Error(`알 수 없는 옵션: ${unknown.join(' ')}\n\n${usage()}`)
  }
  return {
    yes: argv.includes('--yes'),
    reset: argv.includes('--reset'),
    verifyOnly: argv.includes('--verify-only'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

export function usage(): string {
  return [
    '개발용 시드 — 실제 Supabase 프로젝트에 화면 확인용 데이터를 넣습니다.',
    '',
    '사용법',
    '  pnpm seed:dev                  계획만 출력 (DB 쓰기 0건)',
    '  pnpm seed:dev --yes            시드 투입 (멱등 — 몇 번을 돌려도 결과가 같습니다)',
    '  pnpm seed:dev --reset --yes    시드가 만든 행만 지우고 다시 넣습니다',
    '  pnpm seed:dev --verify-only    현재 상태 검증만 (읽기 전용)',
    '',
    '안전장치',
    '  - 삭제 대상은 이 스크립트가 만든 고정 UUID 대역(5eed…5eed5eed5eed)의 행뿐입니다.',
    '  - 보스 마스터(bosses / boss_difficulties / boss_aliases / boss_crystal_prices)는',
    '    읽기만 하며 절대 지우지 않습니다.',
    '  - `--yes` 없이는 어떤 쓰기도 하지 않습니다.',
  ].join('\n')
}
