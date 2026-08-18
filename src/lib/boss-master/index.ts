/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 마스터 — **코드 상수. DB 를 읽지 않는다.**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-18): *"웬만하면 계속 불러오지마 보스같은건 그냥 고정값으로
 * 박아버리던가. 개발에서 명시적으로 패치해야지 db에서 한번 가져와서 쭉 고정해서 값으로
 * 가지고있는게 나을듯. 어차피 몇개 있지도않고 추가할때도 그냥 추가만하면되니. 가격도 포함."*
 *
 * 실측 근거: 거의 아무 일도 하지 않는 `/api/auth/me` 가 **0.30초**였다. 왕복 하나당
 * 고정비가 그만큼 크므로 **왕복 횟수를 줄이는 것이 유일한 지렛대**다. 보스 마스터는
 * 게임 패치 때만 바뀌는데도 탭을 옮길 때마다 `v_boss_catalog` + `boss_aliases` +
 * `boss_difficulties` 세 번을 읽고 있었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇이 상수로 오고 무엇이 DB 에 남는가
 * ─────────────────────────────────────────────────────────────────────────────
 * **상수**: 표시(이름·줄임말·난이도·주기) · 검색(별칭) · 가격표(솔로 기준가).
 * **DB**:   참조 무결성(`boss_difficulty_id` FK) · 집계와 정산.
 *
 * ⚠️ **계산을 앱으로 옮기지 않는다.** 결정석 분배(`resolve_crystal_payout`)·주간 12칸
 *    잔량·수익 합계는 지금도 DB 함수와 뷰가 소유한다. 웹과 카톡 봇이 **같은 답**을
 *    내야 하므로 구현은 한 군데뿐이어야 한다(§2.2). 여기서 가져오는 것은 **표시용
 *    이름과 기준가**뿐이다.
 *
 * ⚠️ **DB 표를 지우지 않았다.** `character_boss_plans` · `party_runs` · `party_bosses` ·
 *    `boss_clears` 가 전부 `boss_difficulty_id` 를 참조한다. 바뀐 것은 읽는 경로다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 가격은 "지금 유효한 값"이라 시각에 달려 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * 뷰 `v_boss_catalog` 는 `effective_from <= now()` 중 가장 최근 행을 골랐다. 상수도
 * 같은 규칙을 지키되, 모듈을 읽는 순간의 시각으로 **얼려 버리면 안 된다** — 장시간
 * 떠 있는 서버에서 미래 시각 가격이 영원히 적용되지 않는다. 그래서 스냅샷을 만들 때
 * **다음 가격 변경 시각**을 함께 계산해 두고, 그 시각을 넘기면 다시 만든다.
 * 변경이 없으면 `Infinity` 라 사실상 한 번만 만든다.
 *
 * ★ 반환 배열·Map 은 **참조가 안정적**이다(같은 스냅샷이면 같은 객체). `useMemo`
 *   의존성에 그대로 넣어도 매 렌더 재계산되지 않는다.
 */

import { TRACKED_BOSS_CYCLES } from "@/lib/domain/boss-scope";
import type { BossCatalogEntry, BossCycle } from "@/types/domain";

import {
  GENERATED_BOSS_ALIASES,
  GENERATED_BOSS_DIFFICULTIES,
  GENERATED_BOSS_GROUPS,
  GENERATED_BOSS_PRICES,
} from "./generated";

export type { GeneratedBossAlias } from "./generated";
export {
  GENERATED_BOSS_ALIASES,
  GENERATED_BOSS_DIFFICULTIES,
  GENERATED_BOSS_GROUPS,
  GENERATED_BOSS_PRICES,
} from "./generated";

// ─────────────────────────────────────────────────────────────────────────────
// 시각에 의존하지 않는 색인 — 모듈 로드 시 한 번
// ─────────────────────────────────────────────────────────────────────────────

const BOSS_GROUP_BY_ID = new Map(GENERATED_BOSS_GROUPS.map((b) => [b.id, b]));

/** 엔트리별 별칭. 난이도 특정 별칭 + 그 보스의 그룹 별칭을 이 순서로 합친다. */
const ALIASES_BY_ENTRY: ReadonlyMap<string, readonly string[]> = (() => {
  const byEntry = new Map<string, string[]>();
  const byBoss = new Map<string, string[]>();
  for (const alias of GENERATED_BOSS_ALIASES) {
    if (alias.bossDifficultyId !== null) {
      byEntry.set(alias.bossDifficultyId, [
        ...(byEntry.get(alias.bossDifficultyId) ?? []),
        alias.alias,
      ]);
    } else {
      byBoss.set(alias.bossId, [...(byBoss.get(alias.bossId) ?? []), alias.alias]);
    }
  }

  const out = new Map<string, readonly string[]>();
  for (const entry of GENERATED_BOSS_DIFFICULTIES) {
    const merged = [
      ...(byEntry.get(entry.id) ?? []),
      ...(byBoss.get(entry.bossId) ?? []),
    ];
    out.set(entry.id, [...new Set(merged)]);
  }
  return out;
})();

/** 엔트리별 가격 이력, **효력 시작 오름차순**. */
const PRICES_BY_ENTRY: ReadonlyMap<
  string,
  readonly { readonly at: number; readonly priceMeso: number | null }[]
> = (() => {
  const out = new Map<string, { at: number; priceMeso: number | null }[]>();
  for (const price of GENERATED_BOSS_PRICES) {
    const list = out.get(price.bossDifficultyId) ?? [];
    list.push({
      at: Date.parse(price.effectiveFrom),
      priceMeso: price.priceMeso,
    });
    out.set(price.bossDifficultyId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
})();

/** 가격이 바뀌는 모든 시각, 오름차순. 스냅샷 유효기간 계산에만 쓴다. */
const PRICE_CHANGE_INSTANTS: readonly number[] = [
  ...new Set(GENERATED_BOSS_PRICES.map((p) => Date.parse(p.effectiveFrom))),
].sort((a, b) => a - b);

// ─────────────────────────────────────────────────────────────────────────────
// 시각에 의존하는 스냅샷
// ─────────────────────────────────────────────────────────────────────────────

interface CatalogSnapshot {
  /** 전체 엔트리. `sortOrder` **내림차순** — 최신 보스가 맨 위다. */
  readonly all: readonly BossCatalogEntry[];
  /** 주간·월간만. 역시 내림차순. */
  readonly tracked: readonly BossCatalogEntry[];
  readonly byId: ReadonlyMap<string, BossCatalogEntry>;
  /** 이 시각 전까지 유효. 넘어가면 다시 만든다. */
  readonly validUntil: number;
}

let snapshot: CatalogSnapshot | null = null;

function priceAt(entryId: string, at: number): number | null {
  const history = PRICES_BY_ENTRY.get(entryId);
  if (history === undefined) return null;
  let current: number | null = null;
  for (const row of history) {
    if (row.at > at) break;
    current = row.priceMeso;
  }
  return current;
}

function buildSnapshot(at: number): CatalogSnapshot {
  const all = GENERATED_BOSS_DIFFICULTIES.map((entry): BossCatalogEntry => {
    const group = BOSS_GROUP_BY_ID.get(entry.bossId);
    return {
      bossDifficultyId: entry.id,
      bossId: entry.bossId,
      koreanName: entry.koreanName,
      bossKoreanName: group?.koreanName ?? entry.koreanName,
      /*
        줄임말이 없으면 **보스 전체 이름**으로 떨어진다. 규칙("난이도 첫 글자 + 이름
        마지막 단어 첫 글자")으로 지어내지 않는 이유는 그 규칙이 안전하지 않기 때문이다 —
        검은 마법사는 `익마` 가 아니라 `익검마` 이고, 진 힐라와 힐라는 둘 다 `하힐` 이
        된다. 길어질 뿐 틀리지 않는 쪽을 고른다(마이그레이션 22 머리말).
      */
      shortName: entry.shortName ?? entry.koreanName,
      difficulty: entry.difficulty,
      cycle: entry.cycle,
      // **소프트 상한**이다 (§1.3 D5). 화면은 경고만 하고 막지 않는다.
      maxParty: entry.maxParty,
      // ★ `null` 은 0 이 아니라 **미확인**이다 (§1.3 D4).
      crystalPriceMeso: priceAt(entry.id, at),
      released: entry.released,
      aliases: ALIASES_BY_ENTRY.get(entry.id) ?? [],
    };
  }).sort((a, b) => entrySortOrder(b.bossDifficultyId) - entrySortOrder(a.bossDifficultyId));

  const trackedCycles = new Set<BossCycle>(TRACKED_BOSS_CYCLES);
  return {
    all,
    tracked: all.filter((entry) => trackedCycles.has(entry.cycle)),
    byId: new Map(all.map((entry) => [entry.bossDifficultyId, entry])),
    validUntil: PRICE_CHANGE_INSTANTS.find((instant) => instant > at) ?? Infinity,
  };
}

const SORT_ORDER_BY_ENTRY = new Map(
  GENERATED_BOSS_DIFFICULTIES.map((entry) => [entry.id, entry.sortOrder]),
);

function entrySortOrder(entryId: string): number {
  return SORT_ORDER_BY_ENTRY.get(entryId) ?? 0;
}

function currentSnapshot(now?: Date): CatalogSnapshot {
  const at = (now ?? new Date()).getTime();
  if (snapshot !== null && at < snapshot.validUntil) return snapshot;
  snapshot = buildSnapshot(at);
  return snapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **전체** 보스 엔트리(일간 포함). `sortOrder` 내림차순.
 *
 * ⚠️ 고르는 화면에 그대로 쓰지 말 것 — 일간 보스는 추적 대상이 아니다
 * (`@/lib/domain/boss-scope`). 목록에는 `getTrackedBossCatalog()` 를 쓴다.
 * 이 함수는 **이미 저장된 런/클리어의 id 로 이름을 되찾을 때** 쓴다. 거기서 일간을
 * 거르면 과거 기록이 이름 없는 껍데기로 렌더된다.
 */
export function getBossCatalog(now?: Date): readonly BossCatalogEntry[] {
  return currentSnapshot(now).all;
}

/**
 * 보스를 **고를 수 있는 모든 화면**이 쓰는 목록 — 주간·월간만, `sortOrder` 내림차순.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **일간 보스를 거르는 단일 관문이자, 목록 순서의 단일 소유자다.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   발주자 지적(2026-08-18): *"스케줄러, 혹은 보스로 등록된것 아래부터 역정렬해서
 *   보여줘. 유피테르가 맨 위로 오게 뭔 카오스 피에르여"* — 오름차순이면 첫 화면이
 *   아무도 안 도는 구보스로 채워진다. 목록이 길어 스크롤로만 끝까지 닿으므로
 *   **순서가 곧 발견 가능성**이다.
 *
 *   일정 등록(`run-composer`) · 파티 보스 편집(`party-boss-picker`) · 보스 계획
 *   (`boss-plan-workspace`)이 전부 이 하나를 쓴다. 화면마다 뒤집으면 셋이 갈라진다.
 *   ⚠️ `party_bosses.sort_order`(파티가 도는 차례)와는 **다른 값**이다.
 *
 * **미출시(`released = false`)도 함께 돌려준다.** 화면이 미출시 배지를 그리고,
 * 미출시 3건은 정확히 벨로나 3난이도라 **가격 미확인(§1.3 D4)** 표시의 유일한 실례다.
 */
export function getTrackedBossCatalog(now?: Date): readonly BossCatalogEntry[] {
  return currentSnapshot(now).tracked;
}

/** `boss_difficulty_id` → 엔트리. 없으면 `undefined`(모르는 id 를 지어내지 않는다). */
export function getBossEntry(
  bossDifficultyId: string,
  now?: Date,
): BossCatalogEntry | undefined {
  return currentSnapshot(now).byId.get(bossDifficultyId);
}

/** 여러 id 를 한 번에. DB 왕복을 대체하던 자리라 Map 으로 돌려준다. */
export function getBossEntryMap(
  bossDifficultyIds: readonly string[],
  now?: Date,
): ReadonlyMap<string, BossCatalogEntry> {
  const snap = currentSnapshot(now);
  const out = new Map<string, BossCatalogEntry>();
  for (const id of bossDifficultyIds) {
    const entry = snap.byId.get(id);
    if (entry !== undefined) out.set(id, entry);
  }
  return out;
}

/**
 * 좁은 자리 전용 줄임말(`하스`). 모르는 id 는 `undefined`.
 *
 * 가격과 무관하므로 스냅샷을 만들지 않는다 — 시각에 의존하지 않는 조회다.
 */
export function getBossShortName(bossDifficultyId: string): string | undefined {
  return SHORT_NAME_BY_ENTRY.get(bossDifficultyId);
}

const SHORT_NAME_BY_ENTRY: ReadonlyMap<string, string> = new Map(
  GENERATED_BOSS_DIFFICULTIES.flatMap((entry) =>
    entry.shortName === null ? [] : [[entry.id, entry.shortName] as const],
  ),
);

/** 엔트리 주기만 필요할 때. 없으면 `undefined`. */
export function getBossCycle(bossDifficultyId: string): BossCycle | undefined {
  return CYCLE_BY_ENTRY.get(bossDifficultyId);
}

const CYCLE_BY_ENTRY: ReadonlyMap<string, BossCycle> = new Map(
  GENERATED_BOSS_DIFFICULTIES.map((entry) => [entry.id, entry.cycle]),
);
