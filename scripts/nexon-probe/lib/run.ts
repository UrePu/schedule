/**
 * 실제 탐침 실행부. `main.ts` 는 여기를 호출하기만 한다.
 *
 * 원칙
 *  - 어떤 단계가 실패해도 다음 단계로 넘어간다(관측 도구이므로 실패 자체가 데이터다).
 *  - governor 가 멈추면(예산 소진 / 429) 남은 계획은 전부 스킵된다.
 *  - 키는 client 내부에서만 쓰이고 밖으로 새지 않는다.
 *  - 라벨은 `plan.ts` 의 dry-run 계획과 1:1로 맞춘다.
 */
import type { Options } from './cli'
import type { Logger } from './log'
import type { CallResult, Json, Observations, SpecComparison, SpecFile, UnknownFinding } from './types'
import { ERROR_INVALID_KEY, NexonClient } from './client'
import { CallGovernor, systemClock } from './governor'
import { BOGUS_OCID, PATHS, buildPlan, nonexistentCharacterName } from './plan'
import {
  characterBasicSchema,
  characterListSchema,
  characterStateSchema,
  guildBasicSchema,
  guildIdSchema,
  ocidSchema,
} from './schemas'
import { ObservationCollector, kstDateString, resolveUnknowns } from './observe'
import { compareSpecToResponse, findResponseSchemaName, flattenSpecSchema, loadSpecs } from './spec'
import type { LoadedSpec } from './spec'

export interface RunOutcome {
  readonly calls: readonly CallResult[]
  readonly observations: Observations | null
  readonly unknowns: readonly UnknownFinding[]
  readonly specFiles: readonly SpecFile[]
  readonly specIndexUrl: string
  readonly specComparison: readonly SpecComparison[]
  readonly keyValid: boolean | null
  readonly executedCalls: number
  readonly specFetchCount: number
  readonly abortedReason: string | null
}

interface CharacterRef {
  readonly ocid: string
  readonly name: string
  readonly world: string
  readonly level: number
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'text/html,application/yaml,text/plain,*/*' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} for ${url}`)
  return await response.text()
}

export async function run(options: Options, log: Logger, apiKey: string | null): Promise<RunOutcome> {
  const collector = new ObservationCollector(options.redactNames)
  const calls: CallResult[] = []
  const governor = new CallGovernor(options.budget, options.rps, systemClock)
  const successBodies = new Map<string, Json[]>()
  let keyValid: boolean | null = null
  let specFetchCount = 0

  const record = (result: CallResult): void => {
    calls.push(result)
    collector.addHeaders(result.headerNames, result.rateLimitHeaders)
    const suffix = result.skipped
      ? `SKIP (${result.skipReason ?? ''})`
      : result.networkError !== null
        ? `네트워크 오류: ${result.networkError}`
        : `HTTP ${String(result.status ?? 0)}${result.errorName === null ? '' : ` ${result.errorName}`}`
    log.line(`  · ${result.label.padEnd(32)} ${suffix}`)
    if (result.ok && result.body !== null) {
      const bucket = successBodies.get(result.path) ?? []
      bucket.push(result.body)
      successBodies.set(result.path, bucket)
    }
  }

  if (apiKey === null) {
    log.line('  API 키가 없어 API 호출 단계를 통째로 건너뜁니다.')
  } else if (options.specOnly) {
    log.line('  --spec-only: API 키 호출을 건너뜁니다 (할당량 0 소모).')
  } else {
    const client = new NexonClient({ apiKey, governor, onCall: record })
    keyValid = await probeApi(client, options, log, collector)
  }

  // ── 스펙 대조 ───────────────────────────────────────────────
  let specFiles: SpecFile[] = []
  let specIndexUrl = ''
  let specComparison: SpecComparison[] = []
  let specNote = '스펙 대조를 수행하지 않았습니다 (--no-spec).'

  if (options.spec) {
    log.section('스펙 대조 (넥슨 OpenAPI YAML 원본)')
    const loaded = await loadSpecs(fetchText, (url, ok) => {
      specFetchCount += 1
      log.line(`  · ${ok ? 'GET ' : 'FAIL'} ${url}`)
    })
    specIndexUrl = loaded.indexUrl
    specFiles = loaded.specs.map((spec) => spec.meta)
    if (loaded.indexError !== null) {
      specNote = `스펙 목록을 가져오지 못했습니다: ${loaded.indexError}`
      log.warn(specNote)
    } else {
      specComparison = compareAll(loaded.specs, successBodies)
      const diffCount = specComparison.reduce(
        (sum, item) => sum + item.missingInResponse.length + item.extraInResponse.length + item.typeMismatch.length,
        0,
      )
      specNote =
        successBodies.size === 0
          ? `스펙 ${String(specFiles.length)}건을 받았지만 대조할 성공 응답이 없습니다 (키 없음 또는 무효).`
          : `스펙 ${String(specFiles.length)}건 대조 완료. 스펙과 어긋난 필드 ${String(diffCount)}건.`
      log.line(`  ${specNote}`)
    }
  }

  const observations = keyValid === true ? collector.finish() : null
  const unknowns = resolveUnknowns(observations, specNote)

  return {
    calls,
    observations,
    unknowns,
    specFiles,
    specIndexUrl,
    specComparison,
    keyValid,
    executedCalls: governor.used,
    specFetchCount,
    abortedReason: governor.stopReason === null ? null : `governor stop: ${governor.stopReason}`,
  }
}

/** 키가 있을 때의 전체 탐침. 반환값은 키 유효성. */
async function probeApi(
  client: NexonClient,
  options: Options,
  log: Logger,
  collector: ObservationCollector,
): Promise<boolean | null> {
  const plan = buildPlan(options)
  const find = (label: string): { purpose: string } => {
    const entry = plan.find((item) => item.label === label)
    return { purpose: entry?.purpose ?? label }
  }

  log.section('1. 계정 / 캐릭터 목록  (/character/list)')
  const listResult = await client.call({
    label: 'character-list',
    path: PATHS.characterList,
    query: {},
    purpose: find('character-list').purpose,
  })

  if (listResult.errorName === ERROR_INVALID_KEY) {
    log.line('')
    log.line('  ❌ API 키가 유효하지 않습니다 (OPENAPI00005).')
    log.line('     .env.local 의 NEXON_API_KEY 값을 다시 확인하세요. 키 값 자체는 출력하지 않습니다.')
    log.line('     이후 탐침은 의미가 없어 전부 건너뜁니다.')
    return false
  }
  if (!listResult.ok) {
    log.warn(`캐릭터 목록 조회 실패 (HTTP ${String(listResult.status ?? 0)}). 이후 탐침을 건너뜁니다.`)
    return null
  }

  const parsedList = characterListSchema.safeParse(listResult.body)
  if (!parsedList.success) {
    log.warn('character/list 응답이 예상 스키마와 다릅니다. 원본은 raw/ 에 남아 있습니다.')
    return true
  }

  const accounts = parsedList.data.account_list ?? []
  collector.addAccountList(
    accounts.map((account) => ({
      accountId: account.account_id ?? null,
      characters: (account.character_list ?? []).map((character) => ({
        name: character.character_name ?? null,
        world: character.world_name ?? null,
      })),
    })),
  )

  const allCharacters: CharacterRef[] = accounts.flatMap((account) =>
    (account.character_list ?? []).map((character) => ({
      ocid: character.ocid,
      name: character.character_name ?? '',
      world: character.world_name ?? '',
      level: character.character_level ?? 0,
    })),
  )
  const targets = [...allCharacters].sort((a, b) => b.level - a.level).slice(0, options.characters)
  log.line(`  계정 ${String(accounts.length)}개 / 캐릭터 ${String(allCharacters.length)}명 → 상위 ${String(targets.length)}명 조회`)

  // ── 2. 캐릭터별 basic + scheduler ───────────────────────────
  log.section('2. 캐릭터별 basic + scheduler')
  let guildSeed: { guildName: string; worldName: string } | null = null
  let schedulerSeedOcid: string | null = null

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    if (target === undefined) continue
    const index = String(i + 1)

    const basic = await client.call({
      label: `character-basic-${index}`,
      path: PATHS.characterBasic,
      query: { ocid: target.ocid },
      purpose: find(`character-basic-${index}`).purpose,
    })
    if (basic.ok) {
      const parsed = characterBasicSchema.safeParse(basic.body)
      if (parsed.success && guildSeed === null) {
        const guildName = parsed.data.character_guild_name
        const worldName = parsed.data.world_name ?? target.world
        if (typeof guildName === 'string' && guildName.length > 0 && worldName.length > 0) {
          guildSeed = { guildName, worldName }
        }
      }
    }

    const state = await client.call({
      label: `scheduler-state-${index}`,
      path: PATHS.schedulerState,
      query: { ocid: target.ocid },
      purpose: find(`scheduler-state-${index}`).purpose,
    })
    if (state.ok) {
      const parsed = characterStateSchema.safeParse(state.body)
      if (parsed.success) {
        collector.addCharacterState(parsed.data, Date.now())
        const hasPayload = (parsed.data.boss_contents ?? []).length > 0
        if (hasPayload && schedulerSeedOcid === null) schedulerSeedOcid = target.ocid
      } else {
        log.warn(`scheduler 응답이 예상 스키마와 다릅니다 (${state.label}). 원본은 raw/ 에 있습니다.`)
      }
    }
  }
  schedulerSeedOcid ??= targets[0]?.ocid ?? null

  // ── 3. date 소급 조회 범위 ──────────────────────────────────
  if (options.dateProbe && schedulerSeedOcid !== null) {
    log.section('3. date 소급 조회 범위 (미확인 #4)')
    const now = new Date()
    const ladder: { label: string; date: string; daysAgo: number | null }[] = [
      { label: 'yesterday', date: kstDateString(now, 1), daysAgo: 1 },
      { label: '7d', date: kstDateString(now, 7), daysAgo: 7 },
      { label: '30d', date: kstDateString(now, 30), daysAgo: 30 },
      { label: '2023-12-21', date: '2023-12-21', daysAgo: null },
    ]
    for (const step of ladder) {
      const result = await client.call({
        label: `scheduler-date-${step.label}`,
        path: PATHS.schedulerState,
        query: { ocid: schedulerSeedOcid, date: step.date },
        purpose: find(`scheduler-date-${step.label}`).purpose,
      })
      collector.addDateBackfill({
        date: step.date,
        daysAgo: step.daysAgo,
        status: result.status,
        errorName: result.errorName,
        hasPayload: hasSchedulerPayload(result.body),
      })
    }
  }

  // ── 4. 에러 형태 탐침 ───────────────────────────────────────
  log.section('4. 에러 형태 탐침')
  const unknownName = nonexistentCharacterName()
  const unknownNameResult = await client.call({
    label: 'error-unknown-character',
    path: PATHS.ocid,
    query: { character_name: unknownName },
    purpose: find('error-unknown-character').purpose,
  })
  collector.addErrorProbe({
    label: 'error-unknown-character',
    description: '존재하지 않는 캐릭터명으로 /v1/id 호출',
    httpStatus: unknownNameResult.status,
    errorName: unknownNameResult.errorName,
    errorMessage: unknownNameResult.errorMessage,
    note: null,
  })

  const badOcidResult = await client.call({
    label: 'error-bad-ocid',
    path: PATHS.characterBasic,
    query: { ocid: BOGUS_OCID },
    purpose: find('error-bad-ocid').purpose,
  })
  collector.addErrorProbe({
    label: 'error-bad-ocid',
    description: '잘못된 ocid 로 /character/basic 호출',
    httpStatus: badOcidResult.status,
    errorName: badOcidResult.errorName,
    errorMessage: badOcidResult.errorMessage,
    note: null,
  })

  const bogusPathResult = await client.call({
    label: 'error-bogus-path',
    path: PATHS.bogus,
    query: {},
    purpose: find('error-bogus-path').purpose,
  })
  collector.addErrorProbe({
    label: 'error-bogus-path',
    description: '존재하지 않는 경로 호출 (유효 키)',
    httpStatus: bogusPathResult.status,
    errorName: bogusPathResult.errorName,
    errorMessage: bogusPathResult.errorMessage,
    note: '유효 키에서는 경로 검증까지 도달하므로 OPENAPI00006 이 기대값이다.',
  })

  // ── 5. 타 계정 ocid 로 스케줄러 호출 ────────────────────────
  if (options.crossAccount) {
    log.section('5. 타 계정 ocid 로 스케줄러 호출 (미확인 #6)')
    await probeCrossAccount(client, log, collector, guildSeed, new Set(allCharacters.map((c) => c.name)), find)
  }

  return true
}

async function probeCrossAccount(
  client: NexonClient,
  log: Logger,
  collector: ObservationCollector,
  guildSeed: { guildName: string; worldName: string } | null,
  ownNames: ReadonlySet<string>,
  find: (label: string) => { purpose: string },
): Promise<void> {
  if (guildSeed === null) {
    log.line('  길드에 소속된 캐릭터를 찾지 못해 건너뜁니다.')
    collector.addErrorProbe({
      label: 'error-cross-account-scheduler',
      description: '타 계정 ocid 로 /scheduler/character-state 호출',
      httpStatus: null,
      errorName: null,
      errorMessage: null,
      note: '길드 소속 캐릭터가 없어 타 계정 캐릭터를 확보하지 못했습니다.',
    })
    return
  }

  const guildIdResult = await client.call({
    label: 'cross-guild-id',
    path: PATHS.guildId,
    query: { guild_name: guildSeed.guildName, world_name: guildSeed.worldName },
    purpose: find('cross-guild-id').purpose,
  })
  const guildId = guildIdResult.ok ? guildIdSchema.safeParse(guildIdResult.body) : null
  if (guildId === null || !guildId.success) {
    collector.addErrorProbe({
      label: 'error-cross-account-scheduler',
      description: '타 계정 ocid 로 /scheduler/character-state 호출',
      httpStatus: null,
      errorName: null,
      errorMessage: null,
      note: '길드 식별자 조회에 실패해 진행하지 못했습니다.',
    })
    return
  }

  const guildBasicResult = await client.call({
    label: 'cross-guild-basic',
    path: PATHS.guildBasic,
    query: { oguild_id: guildId.data.oguild_id },
    purpose: find('cross-guild-basic').purpose,
  })
  const guildBasic = guildBasicResult.ok ? guildBasicSchema.safeParse(guildBasicResult.body) : null
  const otherName = (guildBasic?.success === true ? (guildBasic.data.guild_member ?? []) : []).find(
    (member) => !ownNames.has(member),
  )
  if (otherName === undefined) {
    collector.addErrorProbe({
      label: 'error-cross-account-scheduler',
      description: '타 계정 ocid 로 /scheduler/character-state 호출',
      httpStatus: null,
      errorName: null,
      errorMessage: null,
      note: '길드원 목록에서 본인 계정이 아닌 캐릭터를 찾지 못했습니다.',
    })
    return
  }

  const ocidResult = await client.call({
    label: 'cross-ocid',
    path: PATHS.ocid,
    query: { character_name: otherName },
    purpose: find('cross-ocid').purpose,
  })
  const ocid = ocidResult.ok ? ocidSchema.safeParse(ocidResult.body) : null
  if (ocid === null || !ocid.success) {
    collector.addErrorProbe({
      label: 'error-cross-account-scheduler',
      description: '타 계정 ocid 로 /scheduler/character-state 호출',
      httpStatus: null,
      errorName: null,
      errorMessage: null,
      note: '길드원의 ocid 조회에 실패했습니다.',
    })
    return
  }

  const crossResult = await client.call({
    label: 'error-cross-account-scheduler',
    path: PATHS.schedulerState,
    query: { ocid: ocid.data.ocid },
    purpose: find('error-cross-account-scheduler').purpose,
  })
  collector.addErrorProbe({
    label: 'error-cross-account-scheduler',
    description: '타 계정(길드원) ocid 로 /scheduler/character-state 호출',
    httpStatus: crossResult.status,
    errorName: crossResult.errorName,
    errorMessage: crossResult.errorMessage,
    note:
      crossResult.ok
        ? '⚠️ 200 이 돌아왔습니다. "자신의 계정 캐릭터만 조회 가능"이라는 스펙 문구와 어긋나므로 응답 내용을 반드시 확인하세요.'
        : null,
  })
}

function hasSchedulerPayload(body: Json | null): boolean {
  const parsed = characterStateSchema.safeParse(body)
  if (!parsed.success) return false
  return (
    (parsed.data.boss_contents ?? []).length > 0 ||
    (parsed.data.daily_contents ?? []).length > 0 ||
    (parsed.data.weekly_contents ?? []).length > 0
  )
}

function compareAll(specs: readonly LoadedSpec[], successBodies: ReadonlyMap<string, Json[]>): SpecComparison[] {
  const targets: { label: string; apiPath: string }[] = [
    { label: 'character-list', apiPath: PATHS.characterList },
    { label: 'character-basic', apiPath: PATHS.characterBasic },
    { label: 'scheduler-state', apiPath: PATHS.schedulerState },
  ]
  const out: SpecComparison[] = []
  for (const target of targets) {
    const owner = specs.find((spec) => findResponseSchemaName(spec.doc, target.apiPath) !== null)
    const schemaName = owner === undefined ? null : findResponseSchemaName(owner.doc, target.apiPath)
    const specFields = owner === undefined || schemaName === null ? [] : flattenSpecSchema(owner.doc, schemaName)
    out.push(
      compareSpecToResponse({
        endpointLabel: target.label,
        apiPath: target.apiPath,
        specFileName: owner?.meta.fileName ?? null,
        schemaName,
        specFields,
        responses: successBodies.get(target.apiPath) ?? [],
      }),
    )
  }
  return out
}
