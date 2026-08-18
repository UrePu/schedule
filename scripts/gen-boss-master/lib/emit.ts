/** 파싱 결과 → `src/lib/boss-master/generated.ts` 텍스트. */

import type { BossMasterData } from './parse'

const BANNER = [
  '/*',
  ' * ═══════════════════════════════════════════════════════════════════════════',
  ' * 이 파일은 **생성물이다. 손으로 고치지 마세요.**',
  ' * ═══════════════════════════════════════════════════════════════════════════',
  ' *',
  ' * 출처(단일 진실):',
  ' *   supabase/migrations/20260817094100_seed_boss_master.sql        (보스·난이도·가격·별칭)',
  ' *   supabase/migrations/20260818120000_party_bosses_and_short_names.sql (줄임말·별칭 9)',
  ' *',
  ' * 다시 만들기:  pnpm boss-master',
  ' * 어긋남 검사:  pnpm boss-master:check   ← `pnpm build` 가 자동으로 먼저 돌린다',
  ' *',
  ' * 왜 코드 상수인가 (발주자 지시, 2026-08-18):',
  ' *   *"보스같은건 그냥 고정값으로 박아버리던가. 개발에서 명시적으로 패치해야지 db에서',
  ' *     한번 가져와서 쭉 고정해서 값으로 가지고있는게 나을듯. 가격도 포함."*',
  ' *   보스 마스터는 게임 패치 때만 바뀌는데도 탭을 옮길 때마다 왕복 하나를 먹고 있었다.',
  ' *   왕복 하나당 고정비가 300ms 수준이라(실측 `/api/auth/me` 0.30s) 지우는 편이 낫다.',
  ' *',
  ' * ⚠️ DB 표는 그대로 남는다. `character_boss_plans` · `party_runs` · `party_bosses` ·',
  ' *    `boss_clears` 가 전부 `boss_difficulty_id` 를 FK 로 참조하므로 참조 무결성은',
  ' *    여전히 DB 가 갖는다. 바뀐 것은 **읽는 경로**뿐이다 — 표시·검색·가격은 이 상수에서.',
  ' */',
  '',
].join('\n')

function str(value: string): string {
  return JSON.stringify(value)
}

function nullableStr(value: string | null): string {
  return value === null ? 'null' : str(value)
}

export function emit(data: BossMasterData): string {
  const lines: string[] = [BANNER]

  lines.push(
    'import type { BossCycle, BossDifficultyTier } from "@/types/domain";',
    '',
    '/** ← `public.bosses` 한 행. */',
    'export interface GeneratedBossGroup {',
    '  readonly id: string;',
    '  /** 난이도가 붙지 않은 이름. 예: `스우` */',
    '  readonly koreanName: string;',
    '  readonly generation: string;',
    '  /** 넥슨 스케줄러 API 의 `content_name`. 매핑 조인 키다. */',
    '  readonly nexonContentName: string;',
    '  readonly nexonNameVerified: boolean;',
    '  readonly sortOrder: number;',
    '}',
    '',
    '/** ← `public.boss_difficulties` 한 행. */',
    'export interface GeneratedBossDifficulty {',
    '  readonly id: string;',
    '  readonly bossId: string;',
    '  /** 난이도가 이미 붙은 이름. 예: `하드 스우` */',
    '  readonly koreanName: string;',
    '  readonly difficulty: BossDifficultyTier;',
    '  readonly cycle: BossCycle;',
    '  /** **소프트 상한**이다 (§1.3 D5). 초과를 막지 않고 경고만 한다. */',
    '  readonly maxParty: number;',
    '  readonly entryLevel: number;',
    '  readonly released: boolean;',
    '  readonly nexonDifficulty: string | null;',
    '  readonly sortOrder: number;',
    '  /** 좁은 자리 전용 줄임말. 예: `하스`. 없으면 null. */',
    '  readonly shortName: string | null;',
    '}',
    '',
    '/** ← `public.boss_crystal_prices` 한 행. 효력 시작 시각을 갖는 이력 행이다. */',
    'export interface GeneratedBossPrice {',
    '  readonly bossDifficultyId: string;',
    '  /** `null` = **미확인**(§1.3 D4). 0 이 아니며 합계에서 제외된다. */',
    '  readonly priceMeso: number | null;',
    '  /** ISO 순간(UTC). 원본은 `timestamptz ... +09` 다. */',
    '  readonly effectiveFrom: string;',
    '  readonly patchLabel: string;',
    '}',
    '',
    '/** ← `public.boss_aliases` 한 행. `bossDifficultyId` 가 null 이면 보스 전체 별칭. */',
    'export interface GeneratedBossAlias {',
    '  readonly bossId: string;',
    '  readonly bossDifficultyId: string | null;',
    '  readonly alias: string;',
    '  /** `lower(btrim(replace(alias, " ", "")))` — DB CHECK 와 같은 정규화. */',
    '  readonly normalizedAlias: string;',
    '}',
    '',
  )

  lines.push(
    `/** ${data.bosses.length}건. */`,
    'export const GENERATED_BOSS_GROUPS: readonly GeneratedBossGroup[] = [',
  )
  for (const b of data.bosses) {
    lines.push(
      `  { id: ${str(b.id)}, koreanName: ${str(b.koreanName)}, generation: ${str(b.generation)}, nexonContentName: ${str(b.nexonContentName)}, nexonNameVerified: ${String(b.nexonNameVerified)}, sortOrder: ${b.sortOrder} },`,
    )
  }
  lines.push('];', '')

  lines.push(
    `/** ${data.difficulties.length}건 (일간 ${data.difficulties.filter((d) => d.cycle === 'daily').length} · 주간 ${data.difficulties.filter((d) => d.cycle === 'weekly').length} · 월간 ${data.difficulties.filter((d) => d.cycle === 'monthly').length}). */`,
    'export const GENERATED_BOSS_DIFFICULTIES: readonly GeneratedBossDifficulty[] = [',
  )
  for (const d of data.difficulties) {
    lines.push(
      `  { id: ${str(d.id)}, bossId: ${str(d.bossId)}, koreanName: ${str(d.koreanName)}, difficulty: ${str(d.difficulty)}, cycle: ${str(d.cycle)}, maxParty: ${d.maxParty}, entryLevel: ${d.entryLevel}, released: ${String(d.released)}, nexonDifficulty: ${nullableStr(d.nexonDifficulty)}, sortOrder: ${d.sortOrder}, shortName: ${nullableStr(d.shortName)} },`,
    )
  }
  lines.push('];', '')

  lines.push(
    `/** ${data.prices.length}건. 미확인(null) ${data.prices.filter((p) => p.priceMeso === null).length}건 — §1.3 D4. */`,
    'export const GENERATED_BOSS_PRICES: readonly GeneratedBossPrice[] = [',
  )
  for (const p of data.prices) {
    lines.push(
      `  { bossDifficultyId: ${str(p.bossDifficultyId)}, priceMeso: ${p.priceMeso === null ? 'null' : String(p.priceMeso)}, effectiveFrom: ${str(p.effectiveFrom)}, patchLabel: ${str(p.patchLabel)} },`,
    )
  }
  lines.push('];', '')

  lines.push(
    `/** ${data.aliases.length}건. */`,
    'export const GENERATED_BOSS_ALIASES: readonly GeneratedBossAlias[] = [',
  )
  for (const a of data.aliases) {
    lines.push(
      `  { bossId: ${str(a.bossId)}, bossDifficultyId: ${nullableStr(a.bossDifficultyId)}, alias: ${str(a.alias)}, normalizedAlias: ${str(a.normalizedAlias)} },`,
    )
  }
  lines.push('];', '')

  return lines.join('\n')
}
