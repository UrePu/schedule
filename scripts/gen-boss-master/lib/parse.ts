/**
 * 마이그레이션 SQL → 보스 마스터 레코드.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * **시드 마이그레이션이 단일 진실이다.**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 이름·난이도·가격·별칭을 TS 상수로 손수 한 벌 더 적으면 반드시 갈라진다.
 * 그래서 상수는 이 파서가 **생성**하고, `--check` 가 생성물과 SQL 이 같은지 본다.
 *
 * ── 새 마이그레이션이 보스 표를 건드리면 ────────────────────────────────────
 * `assertManifestCoversAllDml()` 이 `supabase/migrations/*.sql` 전체를 훑어
 * **보스 4표에 DML 을 거는 파일**을 찾아낸다. 그 파일이 아래 매니페스트에 없으면
 * 파서가 던진다. 매니페스트를 갱신하지 않고 지나가는 길을 막아 두지 않으면
 * "다음 패치 때 조용히 갈라진다"가 정확히 그 자리에서 일어난다.
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  parseLiteral,
  readTupleList,
  splitFields,
  stripComments,
  type SqlValue,
} from './sql'

export interface BossRow {
  readonly id: string
  readonly koreanName: string
  readonly generation: string
  readonly nexonContentName: string
  readonly nexonNameVerified: boolean
  readonly sortOrder: number
}

export interface DifficultyRow {
  readonly id: string
  readonly bossId: string
  readonly koreanName: string
  readonly difficulty: string
  readonly cycle: string
  readonly maxParty: number
  readonly entryLevel: number
  readonly released: boolean
  readonly nexonDifficulty: string | null
  readonly sortOrder: number
  /** 마이그레이션 22 가 채운다. 없으면 null. */
  readonly shortName: string | null
  /**
   * 주간 결정석 12칸을 소비하는가. 기본은 `true` 이고, 메이린처럼 `cycle=weekly` 면서도
   * 12칸에 들어가지 않는 시즌/이벤트 보스만 `false` 다(마이그레이션 43).
   */
  readonly countsTowardWeeklyLimit: boolean
}

export interface PriceRow {
  readonly bossDifficultyId: string
  /** `null` 은 **미확인**이며 0 이 아니다 (CLAUDE.md §1.3 D4). */
  readonly priceMeso: number | null
  readonly effectiveFrom: string
  readonly patchLabel: string
}

export interface AliasRow {
  readonly bossId: string
  readonly bossDifficultyId: string | null
  readonly alias: string
  readonly normalizedAlias: string
}

export interface BossMasterData {
  readonly bosses: readonly BossRow[]
  readonly difficulties: readonly DifficultyRow[]
  readonly prices: readonly PriceRow[]
  readonly aliases: readonly AliasRow[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 매니페스트 — 어느 파일의 어느 블록을 읽는가
// ─────────────────────────────────────────────────────────────────────────────

const SEED_FILE = '20260817094100_seed_boss_master.sql'
const SHORT_NAME_FILE = '20260818120000_party_bosses_and_short_names.sql'
/**
 * 벨로나 가격 확정(2026-08-20 발주자). 시드의 `null`(미확인) 행 위에 **새 효력 시각**으로
 * 얹은 행이라, 가격은 두 파일에서 모아야 이력이 온전해진다.
 */
const BELLONA_PRICE_FILE = '20260820120000_bellona_crystal_prices.sql'
/**
 * 벨로나 출시 + 벨룸 줄임말 제거(2026-08-20 발주자). 시드의 `released` 와 22-2 의
 * `short_name` 을 **덮어쓰는** 파일이라, 두 값은 나중 것이 이긴다.
 */
const VELLUM_FILE = '20260820160000_bellona_released_and_vellum_shorthand.sql'
/**
 * 시즌 보스 메이린 추가(2026-08-25 발주자: *"메이린도 기록 해"*). 시드가 의도적으로
 * 뺐던 보스라 **보스·난이도·시세·별칭이 전부 이 파일에서** 나오고, 12칸 면제
 * (`counts_toward_weekly_limit`)도 여기서 처음 등장한다.
 */
const MEILIN_FILE = '20260825170000_meilin_season_boss.sql'
/**
 * 메이린 시세 확정(2026-08-25 발주자: 노멀 3억 / 하드 6억). 43번이 넣은 `null`(미상) 행을
 * **그 자리에서** 채운다 — 클리어가 0건이라 지킬 과거가 없고, 값이 바뀐 것이 아니라
 * 몰랐던 것을 알게 된 것이라 새 효력 시각을 만들면 없던 사건을 기록하게 된다.
 * 그래서 여기만 INSERT 가 아니라 **UPDATE** 로 읽는다.
 */
const MEILIN_PRICE_FILE = '20260825180000_meilin_crystal_price.sql'

/** 보스 4표에 DML 을 걸어도 되는 파일 목록. 이 밖은 파서가 거부한다. */
const MANIFEST_FILES: readonly string[] = [
  SEED_FILE,
  SHORT_NAME_FILE,
  BELLONA_PRICE_FILE,
  VELLUM_FILE,
  MEILIN_FILE,
  MEILIN_PRICE_FILE,
]

const BOSS_TABLES = [
  'bosses',
  'boss_difficulties',
  'boss_crystal_prices',
  'boss_aliases',
] as const

// ─────────────────────────────────────────────────────────────────────────────

function fieldsOf(tuple: string, expected: number, where: string): readonly SqlValue[] {
  const raw = splitFields(tuple)
  if (raw.length !== expected) {
    throw new Error(
      `${where}: 컬럼 수가 ${expected} 이어야 하는데 ${raw.length} 입니다 — (${tuple.trim()})`,
    )
  }
  return raw.map(parseLiteral)
}

function asString(value: SqlValue, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${where}: 문자열이어야 합니다 (${String(value)})`)
  }
  return value
}

function asNumber(value: SqlValue, where: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${where}: 숫자여야 합니다 (${String(value)})`)
  }
  return value
}

function asBoolean(value: SqlValue, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${where}: 불리언이어야 합니다 (${String(value)})`)
  }
  return value
}

/**
 * `anchor` 를 찾고 그 뒤 첫 `values` 부터 튜플 목록을 읽는다.
 * 앵커가 없으면 **던진다** — 마이그레이션이 바뀌어 앵커가 사라졌다는 뜻이고,
 * 조용히 빈 배열을 돌려주면 생성물에서 표 하나가 통째로 사라진다.
 */
function tuplesAfter(sql: string, anchor: string, where: string): readonly string[] {
  const at = sql.indexOf(anchor)
  if (at === -1) {
    throw new Error(`${where}: 앵커를 찾지 못했습니다 — ${JSON.stringify(anchor)}`)
  }
  const valuesAt = sql.indexOf('values', at + anchor.length)
  if (valuesAt === -1) {
    throw new Error(`${where}: 앵커 뒤에 values 절이 없습니다.`)
  }
  const tuples = readTupleList(sql, valuesAt + 'values'.length)
  if (tuples.length === 0) {
    throw new Error(`${where}: values 절에서 튜플을 하나도 읽지 못했습니다.`)
  }
  return tuples
}

/** DB CHECK 와 **똑같은** 정규화: `lower(btrim(replace(alias, ' ', '')))`. */
export function normalizeAlias(alias: string): string {
  return alias.replace(/ /g, '').trim().toLowerCase()
}

// ─────────────────────────────────────────────────────────────────────────────

export async function assertManifestCoversAllDml(migrationsDir: string): Promise<void> {
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()
  const offenders: string[] = []

  for (const name of names) {
    if (MANIFEST_FILES.includes(name)) continue
    const sql = stripComments(await readFile(path.join(migrationsDir, name), 'utf8'))
    const hit = BOSS_TABLES.some((table) =>
      new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+public\\.${table}\\b`, 'i').test(
        sql,
      ),
    )
    if (hit) offenders.push(name)
  }

  if (offenders.length > 0) {
    throw new Error(
      [
        '보스 마스터 표에 DML 을 거는 마이그레이션이 생성기 매니페스트 밖에 있습니다:',
        ...offenders.map((n) => `  · ${n}`),
        '',
        'scripts/gen-boss-master/lib/parse.ts 의 MANIFEST_FILES 와 파싱 블록을 갱신한 뒤',
        '`pnpm boss-master` 로 상수를 다시 생성하세요. 그러지 않으면 DB 와 코드 상수가',
        '조용히 갈라집니다.',
      ].join('\n'),
    )
  }
}

export async function parseBossMaster(migrationsDir: string): Promise<BossMasterData> {
  await assertManifestCoversAllDml(migrationsDir)

  const seed = stripComments(await readFile(path.join(migrationsDir, SEED_FILE), 'utf8'))
  const shortNameSql = stripComments(
    await readFile(path.join(migrationsDir, SHORT_NAME_FILE), 'utf8'),
  )
  const bellonaPriceSql = stripComments(
    await readFile(path.join(migrationsDir, BELLONA_PRICE_FILE), 'utf8'),
  )
  const vellumSql = stripComments(
    await readFile(path.join(migrationsDir, VELLUM_FILE), 'utf8'),
  )
  const meilinSql = stripComments(
    await readFile(path.join(migrationsDir, MEILIN_FILE), 'utf8'),
  )
  const meilinPriceSql = stripComments(
    await readFile(path.join(migrationsDir, MEILIN_PRICE_FILE), 'utf8'),
  )

  // ── 17-1. 보스 그룹 ───────────────────────────────────────────────────────
  const bosses = [
    ...tuplesAfter(seed, 'insert into public.bosses (', '보스 그룹'),
    // 43: 시드가 일부러 뺐던 시즌 보스. 그래서 **여기서만** 나온다.
    ...tuplesAfter(meilinSql, 'insert into public.bosses (', '보스 그룹(메이린)'),
  ].map(
    (tuple): BossRow => {
      const f = fieldsOf(tuple, 6, '보스 그룹')
      return {
        id: asString(f[0] as SqlValue, '보스 그룹.id'),
        koreanName: asString(f[1] as SqlValue, '보스 그룹.korean_name'),
        generation: asString(f[2] as SqlValue, '보스 그룹.generation'),
        nexonContentName: asString(f[3] as SqlValue, '보스 그룹.nexon_content_name'),
        nexonNameVerified: asBoolean(f[4] as SqlValue, '보스 그룹.nexon_name_verified'),
        sortOrder: asNumber(f[5] as SqlValue, '보스 그룹.sort_order'),
      }
    },
  )

  // ── 22-2. 줄임말 (난이도 엔트리보다 먼저 읽어 둔다) ───────────────────────
  const shortNames = new Map<string, string>()
  for (const tuple of tuplesAfter(
    shortNameSql,
    'update public.boss_difficulties bd',
    '보스 줄임말',
  )) {
    const f = fieldsOf(tuple, 2, '보스 줄임말')
    shortNames.set(
      asString(f[0] as SqlValue, '보스 줄임말.id'),
      asString(f[1] as SqlValue, '보스 줄임말.short_name'),
    )
  }

  for (const tuple of tuplesAfter(
    meilinSql,
    'update public.boss_difficulties sn',
    '보스 줄임말(메이린)',
  )) {
    const f = fieldsOf(tuple, 2, '보스 줄임말(메이린)')
    shortNames.set(
      asString(f[0] as SqlValue, '보스 줄임말(메이린).id'),
      asString(f[1] as SqlValue, '보스 줄임말(메이린).short_name'),
    )
  }

  /*
    ── 줄임말 거두기 (2026-08-20) ──────────────────────────────────────────────
    나중 마이그레이션이 `short_name` 을 **null 로 덮으면** 그 엔트리는 줄임말이 없다.
    `null::text` 캐스트가 붙어 있어 리터럴 파서가 `null` 로 읽는다.
    ★ 지우는 것이지 비우는 것이 아니므로 `set(id, '')` 이 아니라 **키를 삭제**한다 —
      빈 문자열을 남기면 아래 인덱스가 `''` 를 키로 잡아 아무 단어에나 걸린다.
  */
  for (const tuple of tuplesAfter(
    vellumSql,
    'update public.boss_difficulties sn',
    '보스 줄임말 제거',
  )) {
    const f = fieldsOf(tuple, 2, '보스 줄임말 제거')
    const id = asString(f[0] as SqlValue, '보스 줄임말 제거.id')
    const next = f[1] as SqlValue
    if (next === null) shortNames.delete(id)
    else shortNames.set(id, asString(next, '보스 줄임말 제거.short_name'))
  }

  /*
    ── 출시 여부 덮어쓰기 ──────────────────────────────────────────────────────
    시드가 `released = false` 로 넣은 것을 나중에 뒤집는다(벨로나 출시).
  */
  const releasedOverrides = new Map<string, boolean>()
  for (const tuple of tuplesAfter(
    vellumSql,
    'update public.boss_difficulties bd',
    '출시 여부',
  )) {
    const f = fieldsOf(tuple, 2, '출시 여부')
    releasedOverrides.set(
      asString(f[0] as SqlValue, '출시 여부.id'),
      asBoolean(f[1] as SqlValue, '출시 여부.released'),
    )
  }

  /*
    ── 12칸 면제 (2026-08-25) ──────────────────────────────────────────────────
    `cycle=weekly` 인데도 주간 결정석 12칸을 먹지 않는 보스. **기본은 참**이고 여기
    적힌 것만 거짓이다 — 목록에서 빠뜨리는 쪽이 "12칸을 먹는다"가 되어, 틀렸을 때
    경고가 과하게 뜨는 안전한 방향으로 실패한다.
  */
  const weeklyLimitExemptions = new Map<string, boolean>()
  for (const tuple of tuplesAfter(
    meilinSql,
    'update public.boss_difficulties wl',
    '12칸 면제',
  )) {
    const f = fieldsOf(tuple, 2, '12칸 면제')
    weeklyLimitExemptions.set(
      asString(f[0] as SqlValue, '12칸 면제.id'),
      asBoolean(f[1] as SqlValue, '12칸 면제.counts_toward_weekly_limit'),
    )
  }

  // ── 17-2. 난이도 엔트리 ───────────────────────────────────────────────────
  const difficulties = [
    ...tuplesAfter(seed, 'insert into public.boss_difficulties', '난이도 엔트리'),
    ...tuplesAfter(meilinSql, 'insert into public.boss_difficulties', '난이도 엔트리(메이린)'),
  ].map((tuple): DifficultyRow => {
    const f = fieldsOf(tuple, 10, '난이도 엔트리')
    const id = asString(f[0] as SqlValue, '난이도 엔트리.id')
    const nexonDifficulty = f[8] as SqlValue
    return {
      id,
      bossId: asString(f[1] as SqlValue, '난이도 엔트리.boss_id'),
      koreanName: asString(f[2] as SqlValue, '난이도 엔트리.korean_name'),
      difficulty: asString(f[3] as SqlValue, '난이도 엔트리.difficulty'),
      cycle: asString(f[4] as SqlValue, '난이도 엔트리.cycle'),
      maxParty: asNumber(f[5] as SqlValue, '난이도 엔트리.max_party'),
      entryLevel: asNumber(f[6] as SqlValue, '난이도 엔트리.entry_level'),
      released:
        releasedOverrides.get(id) ??
        asBoolean(f[7] as SqlValue, '난이도 엔트리.released'),
      nexonDifficulty:
        nexonDifficulty === null ? null : asString(nexonDifficulty, '난이도 엔트리.nexon_difficulty'),
      sortOrder: asNumber(f[9] as SqlValue, '난이도 엔트리.sort_order'),
      shortName: shortNames.get(id) ?? null,
      // 열의 기본값과 같다 — 적히지 않은 보스는 12칸을 먹는다.
      countsTowardWeeklyLimit: weeklyLimitExemptions.get(id) ?? true,
    }
  })

  // ── 17-3. 결정석 시세 ─────────────────────────────────────────────────────
  /*
    ★ **가격은 이력이다.** 시드가 넣은 행 위에 나중 마이그레이션이 새 `effective_from`
      으로 얹을 수 있고(벨로나 확정, 2026-08-20), 상수 쪽 `priceAt()` 이 그 목록을
      효력 시각 순으로 훑어 "그때의 값" 을 고른다. 그래서 여기서 **덮어쓰지 않고 합친다** —
      마지막 것만 남기면 출시 전 스냅샷이 새 가격으로 소급돼 R3 를 깬다.
  */
  const rawPrices = [
    ...tuplesAfter(seed, 'insert into public.boss_crystal_prices (', '결정석 시세'),
    ...tuplesAfter(
      bellonaPriceSql,
      'insert into public.boss_crystal_prices (',
      '결정석 시세(벨로나 확정)',
    ),
    // 메이린은 **시세 미상(null)** 행이다. 0 이 아니라 "모른다"가 기록으로 남는다(D4).
    ...tuplesAfter(
      meilinSql,
      'insert into public.boss_crystal_prices (',
      '결정석 시세(메이린)',
    ),
  ].map((tuple): PriceRow => {
    const f = fieldsOf(tuple, 5, '결정석 시세')
    const price = f[1] as SqlValue
    return {
      bossDifficultyId: asString(f[0] as SqlValue, '결정석 시세.boss_difficulty_id'),
      // ★ null 은 0 이 아니라 **미확인**이다 (§1.3 D4).
      priceMeso: price === null ? null : asNumber(price, '결정석 시세.price_meso'),
      effectiveFrom: asString(f[2] as SqlValue, '결정석 시세.effective_from'),
      patchLabel: asString(f[3] as SqlValue, '결정석 시세.patch_label'),
    }
  })

  /*
    ── 시세 제자리 정정 (2026-08-25) ───────────────────────────────────────────
    43 번이 넣은 메이린 `null` 행을 44 번이 **그 자리에서** 채운다. 새 효력 시각이 아니라
    같은 행이라, 이력에 항목이 늘지 않고 값만 바뀐다. 44 번 머리말이 그 예외의 조건을
    적어 두었다(클리어 0건). 여기서는 **id 당 한 행뿐**이라는 전제로 덮는다 —
    메이린은 43 번이 만든 한 행씩만 갖는다.
  */
  const priceOverrides = new Map<string, number>()
  for (const tuple of tuplesAfter(
    meilinPriceSql,
    'update public.boss_crystal_prices pv',
    '결정석 시세 정정',
  )) {
    const f = fieldsOf(tuple, 2, '결정석 시세 정정')
    priceOverrides.set(
      asString(f[0] as SqlValue, '결정석 시세 정정.boss_difficulty_id'),
      asNumber(f[1] as SqlValue, '결정석 시세 정정.price_meso'),
    )
  }
  const prices = rawPrices.map((row): PriceRow => {
    const next = priceOverrides.get(row.bossDifficultyId)
    return next === undefined ? row : { ...row, priceMeso: next }
  })

  // ── 별칭: 17-4(시드) + 22-8(대/쌀 계열) ───────────────────────────────────
  const aliases: AliasRow[] = []
  const seen = new Set<string>()
  const pushAliases = (tuples: readonly string[], where: string): void => {
    for (const tuple of tuples) {
      const f = fieldsOf(tuple, 3, where)
      const entryId = f[1] as SqlValue
      const alias = asString(f[2] as SqlValue, `${where}.alias`)
      const normalizedAlias = normalizeAlias(alias)
      // 22-8 은 `on conflict do nothing` 이라 17-4 와 겹치는 행은 DB 에 들어가지 않는다.
      if (seen.has(normalizedAlias)) continue
      seen.add(normalizedAlias)
      aliases.push({
        bossId: asString(f[0] as SqlValue, `${where}.boss_id`),
        bossDifficultyId: entryId === null ? null : asString(entryId, `${where}.entry_id`),
        alias,
        normalizedAlias,
      })
    }
  }
  pushAliases(
    tuplesAfter(seed, 'insert into public.boss_aliases (', '보스 별칭(시드)'),
    '보스 별칭(시드)',
  )
  pushAliases(
    tuplesAfter(shortNameSql, 'insert into public.boss_aliases (', '보스 별칭(대/쌀)'),
    '보스 별칭(대/쌀)',
  )

  /*
    ── 별칭 삭제 (2026-08-20) ──────────────────────────────────────────────────
    보스 하나의 별칭을 통째로 거둔다(벨룸). **삭제를 먼저 적용하고** 그다음 추가를 읽는
    순서가 중요하다 — `노벨` 은 벨룸이 자리를 비운 뒤에야 벨로나가 가질 수 있고,
    그 순서가 DB 의 유니크 인덱스(`boss_aliases_normalized_uniq`)와 같다.
  */
  const removedBossIds = new Set(
    tuplesAfter(vellumSql, 'delete from public.boss_aliases a', '별칭 삭제').map(
      (tuple) => asString(fieldsOf(tuple, 1, '별칭 삭제')[0] as SqlValue, '별칭 삭제.boss_id'),
    ),
  )
  if (removedBossIds.size > 0) {
    for (let i = aliases.length - 1; i >= 0; i -= 1) {
      const row = aliases[i]
      if (row !== undefined && removedBossIds.has(row.bossId)) {
        seen.delete(row.normalizedAlias)
        aliases.splice(i, 1)
      }
    }
  }

  pushAliases(
    tuplesAfter(vellumSql, 'insert into public.boss_aliases (', '보스 별칭(벨로나)'),
    '보스 별칭(벨로나)',
  )
  pushAliases(
    tuplesAfter(meilinSql, 'insert into public.boss_aliases (', '보스 별칭(메이린)'),
    '보스 별칭(메이린)',
  )

  assertConsistent({ bosses, difficulties, prices, aliases })
  return { bosses, difficulties, prices, aliases }
}

/**
 * 파싱 직후의 자기검증. **DB 제약과 같은 것들**만 본다 — 파서가 어긋나면
 * 여기서 먼저 죽어야 하고, 그럴듯한 반쪽 결과가 생성물로 굳는 일은 없어야 한다.
 */
function assertConsistent(data: BossMasterData): void {
  const bossIds = new Set(data.bosses.map((b) => b.id))
  const entryIds = new Set(data.difficulties.map((d) => d.id))

  const problems: string[] = []

  if (bossIds.size !== data.bosses.length) problems.push('보스 id 가 중복입니다.')
  if (entryIds.size !== data.difficulties.length) {
    problems.push('난이도 엔트리 id 가 중복입니다.')
  }

  for (const d of data.difficulties) {
    if (!bossIds.has(d.bossId)) problems.push(`엔트리 ${d.id} 의 boss_id ${d.bossId} 가 없습니다.`)
  }
  for (const p of data.prices) {
    if (!entryIds.has(p.bossDifficultyId)) {
      problems.push(`가격 행의 엔트리 ${p.bossDifficultyId} 가 없습니다.`)
    }
  }
  for (const a of data.aliases) {
    if (!bossIds.has(a.bossId)) problems.push(`별칭 ${a.alias} 의 boss_id ${a.bossId} 가 없습니다.`)
    if (a.bossDifficultyId !== null && !entryIds.has(a.bossDifficultyId)) {
      problems.push(`별칭 ${a.alias} 의 엔트리 ${a.bossDifficultyId} 가 없습니다.`)
    }
  }

  // 줄임말은 표시용 유일키다(부분 유니크 인덱스). 겹치면 파티 제목이 두 보스를 가리킨다.
  const byShort = new Map<string, string[]>()
  for (const d of data.difficulties) {
    if (d.shortName === null) continue
    byShort.set(d.shortName, [...(byShort.get(d.shortName) ?? []), d.id])
  }
  for (const [short, ids] of byShort) {
    if (ids.length > 1) problems.push(`줄임말 ${short} 이 ${ids.join(', ')} 에 겹칩니다.`)
  }

  if (problems.length > 0) {
    throw new Error(['보스 마스터 파싱 결과가 일관되지 않습니다:', ...problems].join('\n  · '))
  }
}
