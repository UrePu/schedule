/**
 * 검증 — **실제 DB 조회로만** 판정한다. 기대값은 전부 손계산이며 근거를 주석에 남겼다.
 *
 * 여기서 확인하는 것
 *  1. 보스 마스터 행 수가 변하지 않았는가 (32 / 78 / 201 / 78)
 *  2. 시드 행 수가 데이터셋과 정확히 일치하는가 (= 멱등)
 *  3. DB `week_key(now())` 와 스크립트의 주차 계산이 일치하는가
 *  4. 하루 통째 제외가 **넘어온 구간까지** 잘라내는가
 *  5. **자정 넘김 구간의 일부 제외**가 두 조각으로 쪼개는가
 *  6. 겹침 질의가 손계산과 일치하는가
 *  7. 주간 수익이 손계산과 일치하고 **가격 미확인 보스를 0으로 더하지 않는가**
 *  8. 33:67 분배가 실제로 저장되었는가
 */
import type { Client } from './client'
import { raise } from './client'
import type { Dataset } from './dataset'
import { PERSON_IDS, PERSON_NAMES } from './dataset'
import { countBossMaster, countSeedRows, insertUnits } from './apply'
import { formatKst, kstMoment, weekKey } from './week'

const H = (hour: number, minute = 0): number => hour * 60 + minute

/** 마스터 시드 완료 시점의 기준값. 이 숫자가 바뀌면 시드가 마스터를 건드린 것이다. */
export const BOSS_MASTER_BASELINE: Readonly<Record<string, number>> = {
  bosses: 32,
  boss_difficulties: 78,
  boss_aliases: 201,
  boss_crystal_prices: 78,
}

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly expected: string
  readonly actual: string
  readonly note?: string
}

interface Segment {
  person_id: string
  starts_at: string
  ends_at: string
}

interface OverlapWindow {
  window_start: string
  window_end: string
  available_count: number
  person_ids: string[]
}

interface WeeklyIncome {
  user_id: string
  week_key: string
  crystal_income_meso: number
  clear_count: number
  weekly_clear_count: number
  unknown_price_count: number
  drop_income_meso: number
  drop_count: number
  unsold_drop_count: number
  total_income_meso: number
}

interface SignupShare {
  participant_id: string
  status: string
  share_bp: number
}

const eq = (name: string, expected: string, actual: string, note?: string): Check => ({
  name,
  ok: expected === actual,
  expected,
  actual,
  note,
})

function fmtSegments(segments: readonly Segment[]): string {
  return segments
    .slice()
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map((s) => `${formatKst(new Date(s.starts_at))} ~ ${formatKst(new Date(s.ends_at))}`)
    .join(' / ')
}

export async function runChecks(client: Client, data: Dataset): Promise<readonly Check[]> {
  const checks: Check[] = []
  const start = data.weekStart

  // ── 1. 보스 마스터 불변 ─────────────────────────────────────────────────────
  const master = await countBossMaster(client)
  for (const [table, expected] of Object.entries(BOSS_MASTER_BASELINE)) {
    checks.push(
      eq(
        `보스 마스터 불변 · ${table}`,
        String(expected),
        String(master[table] ?? -1),
        '시드는 마스터를 절대 지우거나 넣지 않는다',
      ),
    )
  }

  // ── 2. 시드 행 수 = 데이터셋 (멱등의 실체) ──────────────────────────────────
  const counted = await countSeedRows(client, data)
  const expectedByTable = new Map(insertUnits(data).map((u) => [u.table, u.rows.length]))
  for (const row of counted) {
    checks.push(
      eq(`행 수 · ${row.table}`, String(expectedByTable.get(row.table) ?? -1), String(row.count)),
    )
  }

  // ── 3. 주차 계산이 DB 와 일치 ───────────────────────────────────────────────
  {
    const { data: dbWeek, error } = await client.rpc('week_key', { ts: data.now.toISOString() })
    raise('week_key RPC', error)
    checks.push(
      eq('주차 키 (DB week_key ↔ 스크립트)', String(dbWeek), weekKey(data.now), 'KST 목 00:00 경계'),
    )
  }

  // ── 4. 하루 통째 제외 — 넘어온 구간까지 잘린다 ──────────────────────────────
  //
  // 라이언 패턴: 평일(월~금) 22:00~26:00. 예외: 이번 주 **목요일 전체**(0~1440).
  // 조회 창을 [목 00:00, 금 03:00) 로 잡으면 세 조각이 후보로 들어온다.
  //   (a) 전주 수 22:00~목 02:00  → 목 00:00~02:00 부분이 예외에 걸려 **소멸**
  //   (b) 목 22:00~금 02:00       → 목 22:00~24:00 **소멸**, 금 00:00~02:00 **생존**
  // 따라서 정답은 **금 00:00~02:00 한 조각뿐**이다.
  {
    const from = kstMoment(start, 0, 0)
    const to = kstMoment(start, 1, H(3))
    const { data: rows, error } = await client.rpc('resolve_availability', {
      p_person_ids: [PERSON_IDS.ryan],
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    })
    raise('resolve_availability(라이언)', error)
    const segments = (rows ?? []) as Segment[]
    const expected = `${formatKst(kstMoment(start, 1, 0))} ~ ${formatKst(kstMoment(start, 1, H(2)))}`
    checks.push(
      eq(
        `하루 통째 제외 · ${PERSON_NAMES.ryan} 목요일`,
        expected,
        fmtSegments(segments),
        '수요일에서 넘어온 목 00:00~02:00 도 함께 사라져야 한다',
      ),
    )
  }

  // ── 5. ★ 자정 넘김 구간의 **일부** 제외 ─────────────────────────────────────
  //
  // 진서 패턴: 평일 23:00~27:00 (= 다음 날 03:00). 예외: **토 00:00~01:00**.
  // 조회 창 [금 12:00, 토 12:00) 안의 후보는 금 23:00~토 03:00 하나뿐이고,
  // 예외가 그 한가운데를 뚫어 **두 조각**이 되어야 한다.
  //   금 23:00~토 00:00  /  토 01:00~토 03:00
  {
    const from = kstMoment(start, 1, H(12))
    const to = kstMoment(start, 2, H(12))
    const { data: rows, error } = await client.rpc('resolve_availability', {
      p_person_ids: [PERSON_IDS.jinseo],
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    })
    raise('resolve_availability(진서)', error)
    const segments = (rows ?? []) as Segment[]
    const expected = [
      `${formatKst(kstMoment(start, 1, H(23)))} ~ ${formatKst(kstMoment(start, 2, 0))}`,
      `${formatKst(kstMoment(start, 2, H(1)))} ~ ${formatKst(kstMoment(start, 2, H(3)))}`,
    ].join(' / ')
    checks.push(
      eq(
        `자정 넘김 구간 일부 제외 · ${PERSON_NAMES.jinseo}`,
        expected,
        fmtSegments(segments),
        '한 구간이 두 조각으로 쪼개져야 한다',
      ),
    )
  }

  // ── 6. 겹침 질의 — 손계산 대조 ──────────────────────────────────────────────
  //
  // 목요일 파티 6인의 **토요일** 가능시간:
  //   우레푸 20~24 / 라이언 21~26 / 미르 13~17,19~24 / 하늘 19~23 / 진서 20~26 /
  //   코코 15~19,21~24
  // 토요일에는 아무에게도 예외가 없다. 6명이 동시에 겹치는 구간은
  //   시작 = max(20,21,19,19,20,21) = 21:00,  끝 = min(24,26,24,23,26,24) = 23:00
  // → **토 21:00~23:00, 6명**. 이 창 하나뿐이어야 한다.
  {
    const members = [
      PERSON_IDS.urepu,
      PERSON_IDS.ryan,
      PERSON_IDS.mir,
      PERSON_IDS.haneul,
      PERSON_IDS.jinseo,
      PERSON_IDS.coco,
    ]
    const from = kstMoment(start, 2, 0)
    const to = kstMoment(start, 3, 0)
    const { data: rows, error } = await client.rpc('availability_overlap', {
      p_person_ids: members,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_min_count: 6,
    })
    raise('availability_overlap(6인)', error)
    const windows = (rows ?? []) as OverlapWindow[]
    const actual = windows
      .slice()
      .sort((a, b) => Date.parse(a.window_start) - Date.parse(b.window_start))
      .map(
        (w) =>
          `${formatKst(new Date(w.window_start))} ~ ${formatKst(new Date(w.window_end))} (${w.available_count}명)`,
      )
      .join(' / ')
    const expected = `${formatKst(kstMoment(start, 2, H(21)))} ~ ${formatKst(kstMoment(start, 2, H(23)))} (6명)`
    checks.push(
      eq('겹침 질의 · 목요일 파티 6인 전원 (토요일)', expected, actual, '손계산: 토 21:00~23:00'),
    )
  }

  // ── 7. 주간 수익 — 가격 미확인 보스를 0으로 더하지 않는다 ───────────────────
  //
  // 우레푸의 이번 주 결정석 (전부 클리어 시점 스냅샷):
  //   하드 스우      base 51,500,000 / 6인 → pot 51,499,998, 균등 →     8,583,333
  //   카오스 더스크  base 69,800,000 / 4인 → pot 69,800,000, 균등 →    17,450,000
  //   카오스 칼로스  base 1,273,000,000 / 2인 → pot 1,273,000,000, 33% → 420,090,000
  //   노멀 벨로나    가격 미확인            → **합계에서 제외**, unknown_price_count = 1
  //   하드 반 레온   base 1,070,000 / 1인 (일간) →                     1,070,000
  //   노멀 힐라      base   455,000 / 1인 (일간) →                       455,000
  //   ─────────────────────────────────────────────────────────────────────────
  //   결정석 합계 = 447,648,333
  //   드랍(창세의 뿌리 solo) = 500,000,000
  //   총합 = 947,648,333
  //   clear_count 6 / weekly_clear_count 4 (스우·더스크·칼로스·벨로나) / unknown 1
  {
    const { data: rows, error } = await client
      .from('v_weekly_income')
      .select('*')
      .eq('user_id', PERSON_IDS.urepu)
      .eq('week_key', data.weekKey)
    raise('v_weekly_income 조회', error)
    const income = ((rows ?? []) as WeeklyIncome[])[0]
    const actual =
      income === undefined
        ? '(행 없음)'
        : [
            `결정석 ${income.crystal_income_meso}`,
            `드랍 ${income.drop_income_meso}`,
            `합계 ${income.total_income_meso}`,
            `클리어 ${income.clear_count}`,
            `주간 ${income.weekly_clear_count}`,
            `가격미확인 ${income.unknown_price_count}`,
          ].join(' / ')
    const expected = [
      '결정석 447648333',
      '드랍 500000000',
      '합계 947648333',
      '클리어 6',
      '주간 4',
      '가격미확인 1',
    ].join(' / ')
    checks.push(
      eq(
        `주간 수익 · ${PERSON_NAMES.urepu} (${data.weekKey})`,
        expected,
        actual,
        '벨로나(가격 null)는 합계에 0으로 더해지지 않고 따로 세어진다',
      ),
    )
  }

  // 가격 미확인 클리어가 실제로 null 로 남아 있는지 (0 으로 채워지지 않았는지)
  {
    const { data: rows, error } = await client
      .from('boss_clears')
      .select('id, crystal_share_meso, base_price_meso, effective_cleared')
      .eq('boss_difficulty_id', 'bellona_normal')
      .in('id', data.bossClears.filter((c) => c.boss_difficulty_id === 'bellona_normal').map((c) => c.id))
    raise('boss_clears(벨로나) 조회', error)
    const list = (rows ?? []) as Array<{ crystal_share_meso: number | null; base_price_meso: number | null; effective_cleared: boolean }>
    const allNullAndCleared =
      list.length === 2 &&
      list.every((r) => r.crystal_share_meso === null && r.base_price_meso === null && r.effective_cleared)
    checks.push(
      eq(
        '가격 미확인 보스 · 금액이 null 로 남는다',
        'true',
        String(allNullAndCleared),
        '0 은 "0메소를 벌었다"는 거짓 주장이 된다 (§1.3 D4)',
      ),
    )
  }

  // ── 8. 33:67 분배 ───────────────────────────────────────────────────────────
  {
    const { data: rows, error } = await client
      .from('run_signups')
      .select('participant_id, status, share_bp')
      .eq('run_id', data.manualShareRun.runId)
    raise('run_signups(칼로스) 조회', error)
    const list = (rows ?? []) as SignupShare[]
    const going = list
      .filter((r) => r.status === 'going')
      .map((r) => r.share_bp)
      .sort((a, b) => a - b)
    const nonGoingZero = list.filter((r) => r.status !== 'going').every((r) => r.share_bp === 0)
    checks.push(
      eq(
        '균등이 아닌 분배 · 33 : 67',
        '3300,6700 / 불참자 0',
        `${going.join(',')} / 불참자 ${nonGoingZero ? '0' : '≠0'}`,
        '합계는 항상 10000 이어야 한다',
      ),
    )
  }

  // ── 9. 미판매 드랍이 null 로 남아 있는가 ────────────────────────────────────
  {
    const ids = data.drops.map((d) => d.id)
    const { data: rows, error } = await client
      .from('run_drops')
      .select('id, item_name, sale_amount_meso, sold_at')
      .in('id', ids)
    raise('run_drops 조회', error)
    const list = (rows ?? []) as Array<{ sale_amount_meso: number | null; sold_at: string | null }>
    const unsold = list.filter((r) => r.sale_amount_meso === null)
    const sold = list.filter((r) => r.sale_amount_meso !== null)
    checks.push(
      eq(
        '드랍 · 판매/미판매 공존',
        '미판매 1건(null) / 판매 3건',
        `미판매 ${unsold.length}건(${unsold.every((r) => r.sold_at === null) ? 'null' : 'sold_at 존재'}) / 판매 ${sold.length}건`,
      ),
    )
  }

  // ── 10. 비어 있는 파티 (빈 상태 확인용) ─────────────────────────────────────
  {
    const guildParty = data.parties[2]
    const { count, error } = await client
      .from('party_runs')
      .select('id', { count: 'exact', head: true })
      .eq('party_id', guildParty.id)
    raise('party_runs(길드) 조회', error)
    checks.push(eq(`일정 0건 파티 · ${guildParty.name}`, '0', String(count ?? -1)))
  }

  // ── 11. 빠진 참가자 번호가 유지되는가 ───────────────────────────────────────
  {
    const { data: rows, error } = await client
      .from('party_participants')
      .select('member_no')
      .eq('party_id', data.parties[0].id)
      .order('member_no')
    raise('party_participants(목요일) 조회', error)
    const nos = ((rows ?? []) as Array<{ member_no: number }>).map((r) => r.member_no)
    checks.push(
      eq(
        '참가자 번호 재배열 금지 · 4번이 비어 있다',
        '1,2,3,5,6,7',
        nos.join(','),
        '§1.4 — 빠진 번호는 빈 채로 둔다',
      ),
    )
  }

  return checks
}
