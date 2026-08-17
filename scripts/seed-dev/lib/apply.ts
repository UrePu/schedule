/**
 * 삭제·삽입 실행.
 *
 * **파괴 범위**: `lib/ids.ts` 가 만든 고정 UUID 목록에 대해서만 DELETE 한다.
 * 조건절이 아니라 **id 열거**이므로 시드가 아닌 행에는 어떤 경우에도 손이 닿지 않는다.
 *
 * **멱등성**: 모든 삽입은 `upsert(onConflict: id)` 다. 같은 데이터를 몇 번 넣어도
 * 행 수가 늘지 않는다.
 *
 * **보스 마스터는 읽기 전용이다.** `bosses` / `boss_difficulties` / `boss_aliases` /
 * `boss_crystal_prices` 는 이 파일 어디에서도 쓰기 대상이 아니다.
 */
import type { Client } from './client'
import { raise } from './client'
import type { Dataset } from './dataset'

export interface TableUnit {
  readonly table: string
  readonly rows: readonly object[]
}

/**
 * 삽입 순서 — 부모 먼저.
 * `guest_profiles → invite_links → parties → app_users` 사슬 때문에
 * 파티가 게스트보다 먼저 들어가야 한다.
 */
export function insertUnits(data: Dataset): readonly TableUnit[] {
  return [
    { table: 'app_users', rows: data.appUsers },
    { table: 'characters', rows: data.characters },
    { table: 'parties', rows: data.parties },
    { table: 'invite_links', rows: data.inviteLinks },
    { table: 'guest_profiles', rows: data.guestProfiles },
    { table: 'friendships', rows: data.friendships },
    { table: 'party_participants', rows: data.participants },
    { table: 'availability_patterns', rows: data.patterns },
    { table: 'availability_exceptions', rows: data.exceptions },
    { table: 'party_runs', rows: data.runs },
    { table: 'run_signups', rows: data.signups },
    { table: 'boss_clears', rows: data.bossClears },
    { table: 'run_drops', rows: data.drops },
    { table: 'run_drop_shares', rows: data.dropShares },
  ]
}

/** 삭제 순서 = 삽입 순서의 역순 (자식 먼저). */
export function deleteUnits(data: Dataset): readonly TableUnit[] {
  return [...insertUnits(data)].reverse()
}

function idsOf(rows: readonly object[]): string[] {
  return rows.map((row) => {
    const id = (row as { id?: unknown }).id
    if (typeof id !== 'string') {
      throw new Error('시드 행에 문자열 id 가 없습니다. ids.ts 를 확인하세요.')
    }
    return id
  })
}

export interface TableResult {
  readonly table: string
  readonly count: number
}

/** 시드 대역의 현재 행 수를 테이블별로 센다 (읽기 전용). */
export async function countSeedRows(
  client: Client,
  data: Dataset,
): Promise<readonly TableResult[]> {
  const out: TableResult[] = []
  for (const unit of insertUnits(data)) {
    const ids = idsOf(unit.rows)
    const { count, error } = await client
      .from(unit.table)
      .select('id', { count: 'exact', head: true })
      .in('id', ids)
    raise(`${unit.table} 조회`, error)
    out.push({ table: unit.table, count: count ?? 0 })
  }
  return out
}

/** 보스 마스터 행 수 (읽기 전용 — 이 값이 변하면 사고다). */
export async function countBossMaster(client: Client): Promise<Record<string, number>> {
  const tables = ['bosses', 'boss_difficulties', 'boss_aliases', 'boss_crystal_prices'] as const
  const out: Record<string, number> = {}
  for (const table of tables) {
    const { count, error } = await client.from(table).select('id', { count: 'exact', head: true })
    raise(`${table} 조회`, error)
    out[table] = count ?? 0
  }
  return out
}

/**
 * 시드 UUID 대역의 **양 끝값**.
 *
 * `5eed…` 로 시작하는 UUID 는 전부 이 두 값 사이에 있다. uuid 타입은 바이트 순서로
 * 비교되므로 `gte`/`lte` 두 개면 접두 검색과 정확히 같은 집합을 얻는다 —
 * PostgREST 에서 `id::text like '5eed%'` 를 표현할 수 없기 때문에 이 방식을 쓴다.
 *
 * ⚠️ 이 범위는 **감사(監査) 전용**이다. 삭제는 언제나 `ids.ts` 의 열거 목록으로만 한다.
 */
const SEED_RANGE_LOW = '5eed0000-0000-0000-0000-000000000000'
const SEED_RANGE_HIGH = '5eedffff-ffff-ffff-ffff-ffffffffffff'

export interface TableAudit {
  readonly table: string
  /** 테이블 전체 행 수. */
  readonly total: number
  /** 열거 목록에 있고 실제로 DB 에 있는 행 수 = **삭제 대상**. */
  readonly enumerated: number
  /**
   * 시드 UUID 대역에 있지만 **열거 목록에는 없는** 행의 id.
   *
   * 정상이면 언제나 빈 배열이다. 비어 있지 않다면 (a) 옛 버전 시드가 남았거나
   * (b) 실사용자 행이 우연히 이 대역을 쓰고 있다는 뜻이다. 어느 쪽이든
   * **자동으로 지우지 않는다** — 사람이 보고 판단할 일이다.
   */
  readonly orphanIds: readonly string[]
}

/**
 * 삭제 전 감사. **읽기 전용.**
 *
 * 테이블마다 "전체 / 삭제 대상 / 대역 고아"를 센다. 이 셋이 있어야
 * "지운 뒤 남는 행이 전부 실데이터"임을 숫자로 보일 수 있다.
 */
export async function auditSeedRange(
  client: Client,
  data: Dataset,
): Promise<readonly TableAudit[]> {
  const out: TableAudit[] = []
  for (const unit of insertUnits(data)) {
    const ids = idsOf(unit.rows)
    const known = new Set(ids)

    const { count: total, error: totalError } = await client
      .from(unit.table)
      .select('id', { count: 'exact', head: true })
    raise(`${unit.table} 전체 행 수 조회`, totalError)

    const { data: rangeRows, error: rangeError } = await client
      .from(unit.table)
      .select('id')
      .gte('id', SEED_RANGE_LOW)
      .lte('id', SEED_RANGE_HIGH)
    raise(`${unit.table} 시드 대역 조회`, rangeError)

    const rangeIds = (rangeRows ?? []).map((row) => String((row as { id: unknown }).id))

    out.push({
      table: unit.table,
      total: total ?? 0,
      enumerated: rangeIds.filter((id) => known.has(id)).length,
      orphanIds: rangeIds.filter((id) => !known.has(id)),
    })
  }
  return out
}

/**
 * 삭제 대상 행을 **통째로** 읽어 온다. 백업용이라 컬럼을 고르지 않고 `*` 다.
 *
 * 되돌리기 경로가 둘이 되도록 만든 장치다:
 *   1. `pnpm seed:dev --yes` — 시드는 결정론적이라 언제든 같은 데이터가 다시 들어간다.
 *   2. 이 JSON — 시드 코드가 그사이 바뀌었더라도 **지운 시점의 행 그대로** 남는다.
 */
export async function dumpSeedRows(
  client: Client,
  data: Dataset,
): Promise<Record<string, readonly unknown[]>> {
  const out: Record<string, readonly unknown[]> = {}
  for (const unit of insertUnits(data)) {
    const ids = idsOf(unit.rows)
    const { data: rows, error } = await client.from(unit.table).select('*').in('id', ids)
    raise(`${unit.table} 백업 조회`, error)
    out[unit.table] = rows ?? []
  }
  return out
}

/** 시드가 만든 행만 지운다. */
export async function deleteSeedRows(
  client: Client,
  data: Dataset,
): Promise<readonly TableResult[]> {
  const out: TableResult[] = []
  for (const unit of deleteUnits(data)) {
    const ids = idsOf(unit.rows)
    const { error, count } = await client
      .from(unit.table)
      .delete({ count: 'exact' })
      .in('id', ids)
    raise(`${unit.table} 삭제`, error)
    out.push({ table: unit.table, count: count ?? 0 })
  }
  return out
}

/** 시드를 넣는다(멱등). */
export async function upsertSeedRows(
  client: Client,
  data: Dataset,
): Promise<readonly TableResult[]> {
  const out: TableResult[] = []
  for (const unit of insertUnits(data)) {
    if (unit.rows.length === 0) {
      out.push({ table: unit.table, count: 0 })
      continue
    }
    const { error } = await client
      .from(unit.table)
      .upsert([...unit.rows], { onConflict: 'id', ignoreDuplicates: false })
    raise(`${unit.table} 삽입`, error)
    out.push({ table: unit.table, count: unit.rows.length })
  }

  // ★ 33:67 을 한 번 더 못박는다.
  //   `run_signups` 의 AFTER 트리거(`run_signups_sync_shares`)가 균등 재계산을 시도하므로,
  //   사용자 지정 비율의 정식 진입점인 `set_run_shares()` 로 확정한다.
  //   (`share_mode` 를 'manual' 로 바꾸고 합계 10000 을 검사한다.)
  const { error: shareError } = await client.rpc('set_run_shares', {
    p_run_id: data.manualShareRun.runId,
    p_participant_ids: [...data.manualShareRun.participantIds],
    p_share_bps: [...data.manualShareRun.shareBps],
  })
  raise('set_run_shares(33:67 분배 확정)', shareError)

  return out
}
