/** CLI 인자 파싱. 의존성 없이 직접 파싱한다(옵션 수가 적고 형태가 단순하다). */
import { DEFAULT_CALL_BUDGET, DEFAULT_REQUESTS_PER_SECOND, DEV_KEY_LIMIT_PER_SECOND } from './governor'

export interface Options {
  readonly help: boolean
  readonly selftest: boolean
  /** true 면 실제 호출. 없으면 dry-run 이 기본이다(비대화형에서 멈추지 않기 위함). */
  readonly yes: boolean
  readonly dryRun: boolean
  readonly budget: number
  readonly characters: number
  readonly rps: number
  readonly redactNames: boolean
  /** 넥슨 OpenAPI YAML 대조 수행 여부 */
  readonly spec: boolean
  /** 스펙 대조만 수행 (API 키 호출 0건) */
  readonly specOnly: boolean
  /** 이전 latest.json 과 비교해 바뀐 것만 출력 */
  readonly diff: boolean
  /** 실측 결과가 담긴 관측 문서를, 실측치 없는 실행으로도 강제로 덮어쓴다 */
  readonly overwriteDoc: boolean
  /** 길드 경유 타 계정 ocid 탐침 수행 여부 */
  readonly crossAccount: boolean
  /** `date` 소급 조회 범위 탐침 수행 여부 */
  readonly dateProbe: boolean
  readonly outDir: string
  readonly errors: readonly string[]
}

const USAGE = `
넥슨 오픈 API 실측 탐침 도구 (nexon-probe)

  pnpm probe [옵션]

기본 동작은 **dry-run** 입니다. 실제 호출은 --yes 를 붙여야 나갑니다.

옵션
  --yes                 실제로 호출합니다 (없으면 계획만 출력, 요청 0건)
  --dry-run             명시적 dry-run (기본값)
  --budget N            총 호출 예산 하드 스톱 (기본 ${String(DEFAULT_CALL_BUDGET)})
  --characters N        상태를 조회할 캐릭터 수 (기본 3, 레벨 내림차순)
  --rps N               초당 최대 호출 수 (기본 ${String(DEFAULT_REQUESTS_PER_SECOND)}, 개발 키 한도는 ${String(DEV_KEY_LIMIT_PER_SECOND)})
  --redact-names        캐릭터명을 마스킹해서 기록 (기본은 노출 — 본인 데이터)
  --no-spec             넥슨 OpenAPI YAML 대조를 건너뜁니다
  --spec-only           스펙 대조만 수행 (API 키 호출 0건, --yes 필요)
  --no-cross-account    길드 경유 "타 계정 ocid" 에러 탐침을 건너뜁니다
  --no-date-probe       스케줄러 date 소급 조회 범위 탐침을 건너뜁니다
  --diff                이전 latest.json 과 비교해 **바뀐 것만** 출력 (패치 후 재실행용)
  --overwrite-doc       실측 결과가 든 관측 문서를 실측치 없는 실행으로도 강제로 덮어씁니다
  --out DIR             출력 디렉터리 (기본 .nexon-probe-out)
  --selftest            네트워크/키 없이 스로틀·예산·마스킹·파서 단위 점검
  -h, --help            이 도움말

출력
  <out>/raw/<timestamp>/*.json   원본 응답 전량 (gitignore 대상)
  <out>/latest.json              관측 요약 (기계 판독형, 드리프트 비교 기준)
  Claude/NEXON-API-OBSERVED.md   사람이 읽는 요약 (ocid 마스킹 적용)

관측 문서 갱신 규칙 — 정보량이 줄어드는 방향으로는 절대 덮어쓰지 않습니다
  · --dry-run (기본) 은 문서를 쓰지 않습니다. 요청 0건 / 파일 쓰기 0건.
  · 키가 없거나 무효인 실행은, 문서가 아직 "실측 전" 상태일 때만 헤더를 현재 상태로 갱신합니다.
  · 이미 실측 결과가 담긴 문서는 실측에 성공한 실행만 갱신합니다 (--overwrite-doc 로 강제 가능).

API 키
  .env.local 의 NEXON_API_KEY 를 읽습니다. 키가 없으면 안내만 출력하고 정상 종료합니다.
  키는 어떤 출력에도 기록되지 않습니다.
`.trim()

export function usage(): string {
  return USAGE
}

function readNumber(raw: string | undefined, name: string, errors: string[], fallback: number): number {
  if (raw === undefined) {
    errors.push(`${name} 에 값이 필요합니다.`)
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${name} 값이 올바르지 않습니다: ${raw}`)
    return fallback
  }
  return parsed
}

export function parseArgs(argv: readonly string[]): Options {
  const errors: string[] = []
  let help = false
  let selftest = false
  let yes = false
  let dryRun = false
  let budget = DEFAULT_CALL_BUDGET
  let characters = 3
  let rps = DEFAULT_REQUESTS_PER_SECOND
  let redactNames = false
  let spec = true
  let specOnly = false
  let diff = false
  let overwriteDoc = false
  let crossAccount = true
  let dateProbe = true
  let outDir = '.nexon-probe-out'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '--selftest':
        selftest = true
        break
      case '--yes':
        yes = true
        break
      case '--dry-run':
        dryRun = true
        break
      case '--redact-names':
        redactNames = true
        break
      case '--no-spec':
        spec = false
        break
      case '--spec-only':
        specOnly = true
        break
      case '--no-cross-account':
        crossAccount = false
        break
      case '--no-date-probe':
        dateProbe = false
        break
      case '--diff':
        diff = true
        break
      case '--overwrite-doc':
        overwriteDoc = true
        break
      case '--budget':
        budget = Math.floor(readNumber(argv[i + 1], '--budget', errors, budget))
        i += 1
        break
      case '--characters':
        characters = Math.floor(readNumber(argv[i + 1], '--characters', errors, characters))
        i += 1
        break
      case '--rps':
        rps = readNumber(argv[i + 1], '--rps', errors, rps)
        i += 1
        break
      case '--out': {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('-')) errors.push('--out 에 디렉터리 경로가 필요합니다.')
        else outDir = value
        i += 1
        break
      }
      default:
        errors.push(`알 수 없는 옵션: ${arg ?? ''}`)
    }
  }

  if (rps > DEV_KEY_LIMIT_PER_SECOND) {
    errors.push(
      `--rps ${String(rps)} 는 개발 키 한도 ${String(DEV_KEY_LIMIT_PER_SECOND)}/초를 넘습니다. ${String(DEV_KEY_LIMIT_PER_SECOND)} 이하로 주세요.`,
    )
  }

  return {
    help,
    selftest,
    yes: yes && !dryRun,
    dryRun: dryRun || !yes,
    budget,
    characters,
    rps,
    redactNames,
    spec: spec || specOnly,
    specOnly,
    diff,
    overwriteDoc,
    crossAccount,
    dateProbe,
    outDir,
    errors,
  }
}
