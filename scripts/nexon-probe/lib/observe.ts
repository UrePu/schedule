/**
 * 조사 문서의 「미확인 / 불확실 항목」을 실측치로 채우기 위한 수집·요약 로직.
 *
 * 여기서 나오는 `Observations` 가 그대로 `latest.json` 과 관측 문서의 본문이 된다.
 */
import { maskId, maskName, sortedUnique, sortedUniqueNumbers } from './redact'
import type {
  DateBackfillResult,
  ErrorProbeResult,
  FlagKind,
  DateLag,
  Json,
  Observations,
  UnknownFinding,
} from './types'
import type { CharacterState } from './schemas'

/** 관측치를 모으는 누적기. 응답을 하나씩 먹여 넣고 마지막에 `finish()` 한다. */
export class ObservationCollector {
  private accountCount = 0
  private readonly accountIds: string[] = []
  private readonly charactersPerAccount: number[] = []
  private characterCount = 0
  private readonly worlds: string[] = []
  private schedulerCharacters = 0
  private schedulerEmpty = 0
  private readonly bossDifficulties: string[] = []
  private readonly bossCycles: string[] = []
  private readonly bossContentNames: string[] = []
  private bossEntryCount = 0
  private readonly dailyContentNames: string[] = []
  private readonly dailyTypes: string[] = []
  private readonly dailyQuestStates: string[] = []
  private readonly weeklyContentNames: string[] = []
  private readonly weeklyTypes: string[] = []
  private readonly weeklyQuestStates: string[] = []
  private readonly weeklyBossClearCounts: number[] = []
  private readonly weeklyBossClearLimitCounts: number[] = []
  private readonly flagTypes = new Map<string, Set<string>>()
  private readonly flagValues = new Map<string, Set<string>>()
  private readonly dateLag: DateLag[] = []
  private readonly dateBackfill: DateBackfillResult[] = []
  private readonly headerNames = new Set<string>()
  private readonly rateLimitHeaders: Record<string, string> = {}
  private readonly errorProbes: ErrorProbeResult[] = []
  private readonly redactNames: boolean

  constructor(redactNames: boolean) {
    this.redactNames = redactNames
  }

  private label(name: string | null | undefined): string {
    if (typeof name !== 'string' || name.length === 0) return '(이름 없음)'
    return this.redactNames ? maskName(name) : name
  }

  addAccountList(accounts: readonly { accountId: string | null; characters: readonly { name: string | null; world: string | null }[] }[]): void {
    this.accountCount = accounts.length
    for (const account of accounts) {
      if (account.accountId !== null) this.accountIds.push(maskId(account.accountId))
      this.charactersPerAccount.push(account.characters.length)
      this.characterCount += account.characters.length
      for (const character of account.characters) {
        if (typeof character.world === 'string' && character.world.length > 0) this.worlds.push(character.world)
      }
    }
  }

  addHeaders(names: readonly string[], rateLimit: Readonly<Record<string, string>>): void {
    for (const name of names) this.headerNames.add(name)
    for (const [key, value] of Object.entries(rateLimit)) this.rateLimitHeaders[key] = value
  }

  private noteFlag(field: string, value: Json | undefined): void {
    if (value === undefined || value === null) return
    const types = this.flagTypes.get(field) ?? new Set<string>()
    types.add(typeof value)
    this.flagTypes.set(field, types)
    const values = this.flagValues.get(field) ?? new Set<string>()
    values.add(typeof value === 'string' ? value : JSON.stringify(value))
    this.flagValues.set(field, values)
  }

  /** 스케줄러 응답 1건을 반영한다. `observedAt` 은 호출 시각(ms). */
  addCharacterState(state: CharacterState, observedAt: number): void {
    const bosses = state.boss_contents ?? []
    const dailies = state.daily_contents ?? []
    const weeklies = state.weekly_contents ?? []
    const empty = bosses.length === 0 && dailies.length === 0 && weeklies.length === 0

    if (empty) this.schedulerEmpty += 1
    else this.schedulerCharacters += 1

    for (const boss of bosses) {
      this.bossEntryCount += 1
      if (typeof boss.difficulty === 'string') this.bossDifficulties.push(boss.difficulty)
      if (typeof boss.cycle === 'string') this.bossCycles.push(boss.cycle)
      if (typeof boss.content_name === 'string') this.bossContentNames.push(boss.content_name)
      this.noteFlag('boss_contents[].registration_flag', boss.registration_flag ?? undefined)
      this.noteFlag('boss_contents[].complete_flag', boss.complete_flag ?? undefined)
    }
    for (const entry of dailies) {
      if (typeof entry.content_name === 'string') this.dailyContentNames.push(entry.content_name)
      if (typeof entry.type === 'string') this.dailyTypes.push(entry.type)
      if (entry.quest_state !== null && entry.quest_state !== undefined) this.dailyQuestStates.push(String(entry.quest_state))
      this.noteFlag('daily_contents[].registration_flag', entry.registration_flag ?? undefined)
    }
    for (const entry of weeklies) {
      if (typeof entry.content_name === 'string') this.weeklyContentNames.push(entry.content_name)
      if (typeof entry.type === 'string') this.weeklyTypes.push(entry.type)
      if (entry.quest_state !== null && entry.quest_state !== undefined) this.weeklyQuestStates.push(String(entry.quest_state))
      this.noteFlag('weekly_contents[].registration_flag', entry.registration_flag ?? undefined)
    }

    if (typeof state.weekly_boss_clear_count === 'number') this.weeklyBossClearCounts.push(state.weekly_boss_clear_count)
    if (typeof state.weekly_boss_clear_limit_count === 'number') {
      this.weeklyBossClearLimitCounts.push(state.weekly_boss_clear_limit_count)
    }

    const responseDate = typeof state.date === 'string' ? state.date : null
    this.dateLag.push({
      characterMasked: this.label(state.character_name),
      responseDate,
      observedAt: new Date(observedAt).toISOString(),
      lagHours: computeLagHours(responseDate, observedAt),
    })
  }

  addDateBackfill(result: DateBackfillResult): void {
    this.dateBackfill.push(result)
  }

  addErrorProbe(result: ErrorProbeResult): void {
    this.errorProbes.push(result)
  }

  finish(): Observations {
    const flagKinds: FlagKind[] = [...this.flagTypes.keys()].sort().map((field) => ({
      field,
      jsTypes: [...(this.flagTypes.get(field) ?? [])].sort(),
      values: [...(this.flagValues.get(field) ?? [])].sort(),
    }))

    return {
      accountCount: this.accountCount,
      accountIdsMasked: this.accountIds,
      characterCount: this.characterCount,
      charactersPerAccount: this.charactersPerAccount,
      worlds: sortedUnique(this.worlds),
      schedulerCharacters: this.schedulerCharacters,
      schedulerEmpty: this.schedulerEmpty,
      bossDifficulties: sortedUnique(this.bossDifficulties),
      bossCycles: sortedUnique(this.bossCycles),
      bossContentNames: sortedUnique(this.bossContentNames),
      bossEntryCount: this.bossEntryCount,
      dailyContentNames: sortedUnique(this.dailyContentNames),
      dailyTypes: sortedUnique(this.dailyTypes),
      dailyQuestStates: sortedUnique(this.dailyQuestStates),
      weeklyContentNames: sortedUnique(this.weeklyContentNames),
      weeklyTypes: sortedUnique(this.weeklyTypes),
      weeklyQuestStates: sortedUnique(this.weeklyQuestStates),
      weeklyBossClearCounts: sortedUniqueNumbers(this.weeklyBossClearCounts),
      weeklyBossClearLimitCounts: sortedUniqueNumbers(this.weeklyBossClearLimitCounts),
      flagKinds,
      dateLag: this.dateLag,
      dateBackfill: this.dateBackfill,
      responseHeaderNames: [...this.headerNames].sort(),
      rateLimitHeaders: this.rateLimitHeaders,
      errorProbes: this.errorProbes,
    }
  }
}

/** 응답 `date`(예: `2026-08-17T00:00+09:00`)와 관측 시각의 차이를 시간 단위로 계산 */
export function computeLagHours(responseDate: string | null, observedAt: number): number | null {
  if (responseDate === null) return null
  const parsed = Date.parse(responseDate)
  if (Number.isNaN(parsed)) return null
  return Math.round(((observedAt - parsed) / 3_600_000) * 100) / 100
}

/** `YYYY-MM-DD` (KST 기준) 문자열을 만든다. */
export function kstDateString(at: Date, daysAgo = 0): string {
  const kstMs = at.getTime() + 9 * 3_600_000 - daysAgo * 86_400_000
  return new Date(kstMs).toISOString().slice(0, 10)
}

function describeSet(values: readonly string[]): string {
  if (values.length === 0) return '(수집 0건)'
  return values.map((value) => `\`${value}\``).join(', ')
}

const KEY_FORMAT_ANSWER =
  '이 도구는 키를 절대 출력·판별·저장하지 않는다는 원칙에 따라 형식을 조사하지 않습니다. ' +
  '접두사로 키 종류를 판별하는 로직은 애초에 넣지 않기로 한 결정(research-NEXON-API #8)이 유효합니다.'

/**
 * API 호출로는 원리적으로 답할 수 없는 항목들.
 * 조사 문서의 14건과 1:1을 유지하기 위해 "왜 이 도구로는 못 채우는지"를 명시적으로 남긴다.
 */
function outOfScopeFindings(): UnknownFinding[] {
  return [
    {
      id: 'NEXON-API#9',
      question: '"타인에게 제공 가능한 API Key" 허용 목록에 스케줄러 API 가 포함되는지 (법적 리스크의 핵심)',
      status: 'unanswered',
      answer:
        'API 호출로 답할 수 없습니다. 넥슨 OpenAPI 사이트에 로그인해 「내 애플리케이션」/공지사항을 직접 확인하거나 help_openapi@nexon.co.kr 에 문의해야 합니다.',
    },
    {
      id: 'NEXON-API#10',
      question: '프렌즈 프로그램(게임 데이터 활용 로그인) 신규 신청의 승인 기준·소요 기간',
      status: 'unanswered',
      answer: 'API 호출로 답할 수 없습니다. 넥슨 지원 > 프렌즈 프로그램 신청 절차를 통해서만 확인 가능합니다.',
    },
    {
      id: 'NEXON-API#14',
      question: '결정석 가격 정보의 공식 출처',
      status: 'unanswered',
      answer:
        'API 전역에 결정석/메소 가격 필드가 없다는 사실은 스펙 대조로 재확인됩니다. 다른 형태의 공식 제공 여부는 API 범위 밖입니다.',
    },
  ]
}

/**
 * 조사 문서의 미확인 항목과 관측치를 1:1로 이어 붙인다.
 * 번호는 `Claude/research-NEXON-API.md` 「미확인 / 불확실 항목」의 순번과 같다.
 */
export function resolveUnknowns(observations: Observations | null, specNote: string): UnknownFinding[] {
  const unresolved = (id: string, question: string, reason: string): UnknownFinding => ({
    id,
    question,
    status: 'unanswered',
    answer: reason,
  })

  if (observations === null) {
    const reason = '유효한 API 키로 호출하지 못해 실측하지 못했습니다.'
    return [
      unresolved('NEXON-API#1', 'boss_contents[].difficulty / cycle 의 실제 값 문자열', reason),
      unresolved('NEXON-API#2', 'daily_contents / weekly_contents 의 content_name 전체 목록', reason),
      unresolved('NEXON-API#3', '스케줄러 API 의 데이터 지연·갱신 기준', reason),
      unresolved('NEXON-API#4', '스케줄러 API 의 date 소급 조회 가능 범위', reason),
      unresolved('NEXON-API#5', '주간 초기화 시점의 리셋 동작', reason),
      unresolved('NEXON-API#6', '타 계정 ocid 로 스케줄러 호출 시 에러 코드', reason),
      unresolved('NEXON-API#7', '존재하지 않는 캐릭터명으로 /v1/id 호출 시 에러 코드', reason),
      unresolved('NEXON-API#8', 'API 키의 실제 형식', KEY_FORMAT_ANSWER),
      unresolved('NEXON-API#11', 'OPENAPI00008 / OPENAPI00012 의 의미', reason),
      unresolved('NEXON-API#12', '응답 헤더의 잔여 호출량 헤더 존재 여부', reason),
      unresolved('NEXON-API#13', 'character/list 가 복수 계정을 반환하는 조건', reason),
      unresolved('BOSS-DATA#R7', 'weekly_boss_clear_limit_count 실제 값(12 인가)', reason),
      unresolved('FLAG-TYPE', 'registration_flag / complete_flag 가 문자열 "true"/"false" 인지 불리언인지', reason),
      ...outOfScopeFindings(),
      { id: 'SPEC-DRIFT', question: '넥슨 OpenAPI YAML 원본과 실제 응답의 차이', status: 'unanswered', answer: specNote },
    ]
  }

  const findings: UnknownFinding[] = []

  findings.push({
    id: 'NEXON-API#1',
    question: 'boss_contents[].difficulty / cycle 의 실제 값 문자열',
    status: observations.bossEntryCount > 0 ? 'answered' : 'unanswered',
    answer:
      observations.bossEntryCount > 0
        ? `difficulty = ${describeSet(observations.bossDifficulties)} / cycle = ${describeSet(observations.bossCycles)} (보스 항목 ${String(observations.bossEntryCount)}건 기준). ` +
          `주의: 이 캐릭터들이 스케줄러에 등록한 보스만 나옵니다. 전체 값 집합이라는 보장은 없습니다.`
        : 'boss_contents 가 비어 있어 값을 수집하지 못했습니다(캐릭터 미접속이거나 스케줄러 미등록).',
  })

  findings.push({
    id: 'NEXON-API#2',
    question: 'daily_contents / weekly_contents 의 content_name / type / quest_state 실제 값',
    status: observations.dailyContentNames.length + observations.weeklyContentNames.length > 0 ? 'answered' : 'unanswered',
    answer:
      `daily type = ${describeSet(observations.dailyTypes)}, daily quest_state = ${describeSet(observations.dailyQuestStates)}, ` +
      `weekly type = ${describeSet(observations.weeklyTypes)}, weekly quest_state = ${describeSet(observations.weeklyQuestStates)}. ` +
      `content_name 은 daily ${String(observations.dailyContentNames.length)}종 / weekly ${String(observations.weeklyContentNames.length)}종 수집 (아래 목록 참조).`,
  })

  const lagValues = observations.dateLag.map((entry) => entry.lagHours).filter((value): value is number => value !== null)
  findings.push({
    id: 'NEXON-API#3',
    question: '스케줄러 API 의 데이터 지연 (스펙에 info.description 이 없어 15분 규칙 적용 여부 불명이었음)',
    status: lagValues.length > 0 ? 'partial' : 'unanswered',
    answer:
      lagValues.length > 0
        ? `응답 date 는 KST 일 단위(시·분 0)라 "현재 시각 - date" 는 최소 지연이 아니라 **당일 경과 시간**을 포함합니다. 실측 차이 ${lagValues.map((value) => `${String(value)}h`).join(', ')}. ` +
          `→ date 필드만으로는 15분 지연을 확정할 수 없습니다. 확정하려면 인게임에서 보스 하나를 클리어한 뒤 complete_flag 가 바뀌는 시각을 재야 합니다(이 도구 범위 밖).`
        : '스케줄러 응답을 얻지 못해 측정하지 못했습니다.',
  })

  const backfillOk = observations.dateBackfill.filter((entry) => entry.status === 200)
  const backfillFail = observations.dateBackfill.filter((entry) => entry.status !== 200 && entry.status !== null)
  findings.push({
    id: 'NEXON-API#4',
    question: '스케줄러 API 의 date 소급 조회 가능 범위',
    status: observations.dateBackfill.length > 0 ? 'partial' : 'unanswered',
    answer:
      observations.dateBackfill.length > 0
        ? `200 응답: ${backfillOk.map((entry) => entry.date).join(', ') || '없음'} / 실패: ${
            backfillFail.map((entry) => `${entry.date}(${String(entry.status)}${entry.errorName === null ? '' : ` ${entry.errorName}`})`).join(', ') || '없음'
          }. 사다리 방식 표본이므로 정확한 경계는 추가 이분 탐색이 필요합니다.`
        : '탐침을 수행하지 않았습니다(--no-date-probe).',
  })

  findings.push({
    id: 'NEXON-API#5',
    question: '주간 초기화(KST 목 00:00) 시점의 complete_flag / weekly_boss_clear_count 리셋 타이밍',
    status: 'unanswered',
    answer:
      '단일 실행으로는 확인할 수 없습니다. 목요일 00:00 KST 전후로 이 도구를 두 번 돌리고 `--diff` 로 비교해야 합니다. ' +
      '(예: 수요일 23:50, 목요일 00:10, 목요일 00:30)',
  })

  const crossAccount = observations.errorProbes.find((probe) => probe.label === 'error-cross-account-scheduler')
  findings.push({
    id: 'NEXON-API#6',
    question: '타 계정 ocid 로 스케줄러 호출 시의 정확한 에러 코드 (OPENAPI00002 로 추정했었음)',
    status: crossAccount === undefined || crossAccount.httpStatus === null ? 'unanswered' : 'answered',
    answer:
      crossAccount === undefined
        ? '탐침을 수행하지 않았습니다(--no-cross-account 이거나 길드원을 찾지 못함).'
        : `HTTP ${String(crossAccount.httpStatus)} / error.name = ${crossAccount.errorName ?? '(없음)'}${
            crossAccount.note === null ? '' : ` — ${crossAccount.note}`
          }`,
  })

  const badName = observations.errorProbes.find((probe) => probe.label === 'error-unknown-character')
  findings.push({
    id: 'NEXON-API#7',
    question: '존재하지 않는 캐릭터명으로 /v1/id 호출 시의 에러 코드 (OPENAPI00003 로 추정했었음)',
    status: badName === undefined || badName.httpStatus === null ? 'unanswered' : 'answered',
    answer:
      badName === undefined
        ? '탐침을 수행하지 못했습니다.'
        : `HTTP ${String(badName.httpStatus)} / error.name = ${badName.errorName ?? '(없음)'}`,
  })

  findings.push({
    id: 'NEXON-API#8',
    question: 'API 키의 실제 형식(test_ / live_ 접두사 여부)',
    status: 'unanswered',
    answer: KEY_FORMAT_ANSWER,
  })

  const errorNames = observations.errorProbes
    .map((probe) => probe.errorName)
    .filter((name): name is string => name !== null)
  findings.push({
    id: 'NEXON-API#11',
    question: 'OPENAPI00008 / OPENAPI00012 의 의미',
    status: errorNames.some((name) => name === 'OPENAPI00008' || name === 'OPENAPI00012') ? 'partial' : 'unanswered',
    answer:
      `이번 실행에서 관측된 error.name: ${describeSet(sortedUnique(errorNames))}. ` +
      '00008/00012 를 유발할 조건을 알 수 없어 의도적으로 재현하지 못했습니다.',
  })

  const rateLimitKeys = Object.keys(observations.rateLimitHeaders)
  findings.push({
    id: 'NEXON-API#12',
    question: '응답 헤더에 잔여 호출량 헤더가 있는지',
    status: observations.responseHeaderNames.length > 0 ? 'answered' : 'unanswered',
    answer:
      rateLimitHeaderAnswer(rateLimitKeys, observations.responseHeaderNames),
  })

  findings.push({
    id: 'NEXON-API#13',
    question: 'character/list 가 복수 계정(account_list 복수)을 반환하는 조건',
    status: observations.accountCount > 1 ? 'answered' : 'partial',
    answer:
      `이 키로는 account_list 길이 = ${String(observations.accountCount)} (계정별 캐릭터 수 ${observations.charactersPerAccount.join(', ')}). ` +
      (observations.accountCount > 1
        ? '복수 계정이 실제로 반환됩니다 → 앱은 반드시 배열로 다뤄야 합니다.'
        : '단일 계정만 반환되었습니다. 복수 반환 조건은 이 키만으로는 알 수 없습니다(넥슨 ID 에 메이플 계정이 여러 개 붙은 경우로 추정).'),
  })

  findings.push({
    id: 'BOSS-DATA#R7',
    question: 'weekly_boss_clear_limit_count 의 실제 값 (12 로 예상했었음)',
    status: observations.weeklyBossClearLimitCounts.length > 0 ? 'answered' : 'unanswered',
    answer:
      observations.weeklyBossClearLimitCounts.length > 0
        ? `limit = ${observations.weeklyBossClearLimitCounts.join(', ')} / count = ${observations.weeklyBossClearCounts.join(', ')}`
        : '스케줄러 응답에서 값을 얻지 못했습니다.',
  })

  const flagSummary = observations.flagKinds
    .map((kind) => `${kind.field}: ${kind.jsTypes.join('|')} = ${kind.values.join(', ')}`)
    .join(' / ')
  findings.push({
    id: 'FLAG-TYPE',
    question: 'registration_flag / complete_flag 가 문자열 "true"/"false" 인지 불리언인지',
    status: observations.flagKinds.length > 0 ? 'answered' : 'unanswered',
    answer: observations.flagKinds.length > 0 ? flagSummary : '플래그를 담은 응답을 얻지 못했습니다.',
  })

  findings.push(...outOfScopeFindings())

  findings.push({
    id: 'SPEC-DRIFT',
    question: '넥슨 OpenAPI YAML 원본과 실제 응답의 차이',
    status: 'partial',
    answer: specNote,
  })

  return findings
}

function rateLimitHeaderAnswer(rateLimitKeys: readonly string[], allHeaders: readonly string[]): string {
  if (rateLimitKeys.length > 0) {
    return `잔여 호출량으로 보이는 헤더가 있습니다: ${describeSet(rateLimitKeys)}. 전체 헤더: ${describeSet(allHeaders)}`
  }
  return `잔여 호출량 관련 헤더는 없습니다. 관측된 응답 헤더 전체: ${describeSet(allHeaders)} → 앱에서 남은 할당량을 헤더로 알 수 없으므로 호출량은 우리가 직접 세야 합니다.`
}
