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

/** 보스 4표에 DML 을 걸어도 되는 파일 목록. 이 밖은 파서가 거부한다. */
const MANIFEST_FILES: readonly string[] = [SEED_FILE, SHORT_NAME_FILE]

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

  // ── 17-1. 보스 그룹 ───────────────────────────────────────────────────────
  const bosses = tuplesAfter(seed, 'insert into public.bosses (', '보스 그룹').map(
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

  // ── 17-2. 난이도 엔트리 ───────────────────────────────────────────────────
  const difficulties = tuplesAfter(
    seed,
    'insert into public.boss_difficulties',
    '난이도 엔트리',
  ).map((tuple): DifficultyRow => {
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
      released: asBoolean(f[7] as SqlValue, '난이도 엔트리.released'),
      nexonDifficulty:
        nexonDifficulty === null ? null : asString(nexonDifficulty, '난이도 엔트리.nexon_difficulty'),
      sortOrder: asNumber(f[9] as SqlValue, '난이도 엔트리.sort_order'),
      shortName: shortNames.get(id) ?? null,
    }
  })

  // ── 17-3. 결정석 시세 ─────────────────────────────────────────────────────
  const prices = tuplesAfter(
    seed,
    'insert into public.boss_crystal_prices (',
    '결정석 시세',
  ).map((tuple): PriceRow => {
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
