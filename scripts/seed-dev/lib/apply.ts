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
