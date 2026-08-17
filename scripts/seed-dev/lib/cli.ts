/** 인자 파싱 및 사용법. */

export interface Options {
  /** 실제로 DB 를 건드린다. 없으면 계획만 출력하고 종료한다. */
  readonly yes: boolean
  /** 시드가 만든 행을 먼저 전부 지우고 다시 넣는다. */
  readonly reset: boolean
  /**
   * **삭제 전용.** 시드가 만든 행을 지우고 **다시 넣지 않는다.**
   *
   * `--reset` 과 다르다 — `--reset` 은 지운 뒤 곧바로 되넣으므로 "목데이터를 없앤다"는
   * 목적에는 쓸 수 없다. 실사용자가 쓰는 DB 에서 개발용 시드만 걷어낼 때 쓴다.
   */
  readonly purge: boolean
  /** 삽입 없이 검증만 수행한다(읽기 전용). */
  readonly verifyOnly: boolean
  readonly help: boolean
}

const KNOWN = new Set([
  '--yes',
  '--reset',
  '--purge',
  '--verify-only',
  '--help',
  '-h',
])

export function parseArgs(argv: readonly string[]): Options {
  const unknown = argv.filter((a) => !KNOWN.has(a))
  if (unknown.length > 0) {
    throw new Error(`알 수 없는 옵션: ${unknown.join(' ')}\n\n${usage()}`)
  }
  const purge = argv.includes('--purge')
  const reset = argv.includes('--reset')
  // 두 모드는 정반대의 결과("되넣는다" vs "안 넣는다")를 내므로 함께 쓰면 무엇을
  // 의도했는지 알 수 없다. 조용히 하나를 이기게 두면 사고가 난다 — 그냥 거절한다.
  if (purge && reset) {
    throw new Error(
      ['`--purge` 와 `--reset` 은 함께 쓸 수 없습니다.', '', usage()].join('\n'),
    )
  }
  if (purge && argv.includes('--verify-only')) {
    throw new Error(
      ['`--purge` 와 `--verify-only` 는 함께 쓸 수 없습니다.', '', usage()].join('\n'),
    )
  }
  return {
    yes: argv.includes('--yes'),
    reset,
    purge,
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
    '  pnpm seed:dev --purge          삭제 계획만 출력 (DB 쓰기 0건)',
    '  pnpm seed:dev --purge --yes    시드가 만든 행을 지우고 **다시 넣지 않습니다**',
    '  pnpm seed:dev --verify-only    현재 상태 검증만 (읽기 전용)',
    '',
    '안전장치',
    '  - 삭제 대상은 이 스크립트가 만든 고정 UUID 대역(5eed…5eed5eed5eed)의 행뿐입니다.',
    '  - 삭제는 `like` 조건절이 아니라 **id 열거**로 수행합니다. 우연히 같은 대역을 쓰는',
    '    실사용자 행이 있어도 열거 목록에 없으면 손이 닿지 않습니다.',
    '  - `--purge` 는 지우기 전에 **행 전체를 JSON 으로 백업**하고 경로를 출력합니다.',
    '  - 보스 마스터(bosses / boss_difficulties / boss_aliases / boss_crystal_prices)는',
    '    읽기만 하며 절대 지우지 않습니다.',
    '  - `--yes` 없이는 어떤 쓰기도 하지 않습니다.',
  ].join('\n')
}
