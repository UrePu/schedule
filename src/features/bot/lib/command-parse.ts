/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 명령 파싱 — **느슨하게 받고, 해석 결과를 되돌려 보여준다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 방에서 사람이 한 손으로 치는 문자열이다. 띄어쓰기·조사·줄임말이 제멋대로 들어온다.
 * 그래서 파서는 관대하고, **답장은 항상 무엇으로 알아들었는지 되읽어 준다.** 그래야
 * 오해가 그 자리에서 잡힌다(research-KAKAO-BOT §2.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 별칭은 **코드 상수**다 — DB 를 읽지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스 마스터는 2026-08-18 발주자 지시로 `@/lib/boss-master` 코드 상수로 내려갔다
 * (CLAUDE.md §2.4 Rule 4). 그래서 별칭 해석에 왕복이 0회다 — 명령 응답 예산이 2초인
 * 경로에서 이건 그냥 이득이다. research-KAKAO-BOT §2.10 은 `boss_aliases` **테이블**을
 * 읽으라고 적혀 있으나, 그 문서보다 뒤에 나온 발주자 지시가 이긴다. 별칭 자체는
 * 여전히 시드 마이그레이션이 단일 출처이고 `pnpm boss-master:check` 가 어긋남을 막는다.
 *
 * ⚠️ **일간 보스는 범위 밖이다**(발주자 결정 2026-08-18). `getTrackedBossCatalog()` 가
 *    주간·월간만 돌려주므로 `자쿰` 같은 입력은 "모르는 보스"가 된다. 그게 맞다 —
 *    일간을 알아듣고 등록해 주면 12칸/90개 집계가 조용히 어긋난다.
 */

import { getTrackedBossCatalog } from "@/lib/boss-master";
import type { BossCatalogEntry, BossDifficultyTier } from "@/types/domain";

// ─────────────────────────────────────────────────────────────────────────────
// 명령 토큰화
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedCommand {
  /** `!` 를 뗀 명령 이름(소문자·공백 제거). 예: `일정` */
  readonly name: string;
  /** 나머지 인자. 공백으로 자른다. */
  readonly args: readonly string[];
  /** 명령 이름을 뗀 나머지 원문. 인자를 통째로 쓰고 싶을 때. */
  readonly rest: string;
  /** 로그에 남길 원문(정규화된 한 줄). */
  readonly raw: string;
}

/** 접두어. **없는 메시지에는 절대 반응하지 않는다** — 사람이 대화하는 방이다. */
export const COMMAND_PREFIX = "!";

/**
 * `!` 로 시작하지 않으면 `null`. 그 경우 서버는 아무 기록도 남기지 않고 침묵한다
 * (프라이버시 §R5 — 일반 대화는 우리 저장소에 도달하지 않는다).
 */
export function parseCommand(message: string): ParsedCommand | null {
  const raw = message.replace(/\s+/g, " ").trim();
  if (!raw.startsWith(COMMAND_PREFIX)) return null;

  const body = raw.slice(COMMAND_PREFIX.length);
  if (body === "") return null;

  const [head, ...tail] = body.split(" ");
  return {
    name: (head ?? "").toLowerCase(),
    args: tail.filter((token) => token !== ""),
    rest: tail.join(" ").trim(),
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 별칭 해석
// ─────────────────────────────────────────────────────────────────────────────

/** 비교용 정규화: 공백 제거 + 소문자. 조사는 아래에서 따로 벗긴다. */
function normalize(term: string): string {
  return term.replace(/\s+/g, "").toLowerCase();
}

/**
 * 끝에 붙은 조사를 벗긴 후보. 원문과 함께 **둘 다** 시도한다.
 *
 * ⚠️ 무조건 벗기면 안 된다 — `힐라` 의 `라`, `카웅` 의 `웅` 처럼 보스 이름의 마지막
 *    글자가 조사와 겹치는 경우가 흔하다. 그래서 "벗긴 것도 후보에 넣는다"이지
 *    "벗긴 것으로 바꾼다"가 아니다.
 */
function withoutParticle(term: string): string | null {
  const stripped = term.replace(/(을|를|은|는|이|가|도)$/u, "");
  return stripped !== term && stripped.length >= 2 ? stripped : null;
}

/** 난이도 접두사. 긴 것부터 봐야 `익스트림` 이 `익` 으로 먼저 잘리지 않는다. */
const DIFFICULTY_PREFIXES: readonly (readonly [string, BossDifficultyTier])[] = [
  ["익스트림", "extreme"],
  ["익스", "extreme"],
  ["카오스", "chaos"],
  ["노멀", "normal"],
  ["노말", "normal"],
  ["하드", "hard"],
  ["이지", "easy"],
  ["익", "extreme"],
  ["카", "chaos"],
  ["노", "normal"],
  ["하", "hard"],
  ["이", "easy"],
];

interface BossIndex {
  /** 난이도까지 특정되는 키 → 엔트리들(보통 1개). */
  readonly byEntry: ReadonlyMap<string, readonly BossCatalogEntry[]>;
  /** 보스 그룹 키 → 그 보스의 모든 난이도. */
  readonly byGroup: ReadonlyMap<string, readonly BossCatalogEntry[]>;
}

let cachedIndex: { readonly key: number; readonly index: BossIndex } | null = null;

function buildIndex(catalog: readonly BossCatalogEntry[]): BossIndex {
  const byEntry = new Map<string, BossCatalogEntry[]>();
  const byGroup = new Map<string, BossCatalogEntry[]>();

  const push = (
    map: Map<string, BossCatalogEntry[]>,
    key: string,
    entry: BossCatalogEntry,
  ): void => {
    if (key === "") return;
    const bucket = map.get(key) ?? [];
    if (!bucket.some((item) => item.bossDifficultyId === entry.bossDifficultyId)) {
      bucket.push(entry);
    }
    map.set(key, bucket);
  };

  for (const entry of catalog) {
    // 난이도가 이미 붙은 표기: `하드 스우` · 줄임말 `하스` · id `lotus_hard`
    push(byEntry, normalize(entry.koreanName), entry);
    push(byEntry, normalize(entry.shortName), entry);
    push(byEntry, normalize(entry.bossDifficultyId), entry);

    // 그룹 표기: `스우` 와 그 보스의 별칭들
    push(byGroup, normalize(entry.bossKoreanName), entry);
    for (const alias of entry.aliases) {
      /*
        별칭 목록은 **난이도 특정 별칭 + 그룹 별칭**이 합쳐진 것이다(boss-master/index).
        어느 쪽인지 여기서 구분할 수 없으므로 양쪽에 넣는다. 그룹 쪽에 잘못 들어간
        난이도 별칭은 후보가 1개라 결과가 같고, 엔트리 쪽에 들어간 그룹 별칭은
        후보가 여러 개가 되어 `ambiguous` 로 떨어진다 — 조용히 틀리지 않는다.
      */
      push(byEntry, normalize(alias), entry);
      push(byGroup, normalize(alias), entry);
    }
  }

  return { byEntry, byGroup };
}

function bossIndex(now?: Date): BossIndex {
  const catalog = getTrackedBossCatalog(now);
  // 카탈로그 스냅샷은 가격 변경 시각에만 바뀐다. 길이로는 못 잡으므로 참조로 캐시한다.
  const key = catalog.length;
  if (cachedIndex !== null && cachedIndex.key === key) return cachedIndex.index;
  const index = buildIndex(catalog);
  cachedIndex = { key, index };
  return index;
}

export type BossLookup =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly entry: BossCatalogEntry }
  | { readonly kind: "ambiguous"; readonly candidates: readonly BossCatalogEntry[] };

function fromBucket(bucket: readonly BossCatalogEntry[] | undefined): BossLookup | null {
  if (bucket === undefined || bucket.length === 0) return null;
  const only = bucket[0];
  if (bucket.length === 1 && only !== undefined) return { kind: "one", entry: only };
  return { kind: "ambiguous", candidates: bucket };
}

/**
 * 한 토막의 문자열을 보스 엔트리로 해석한다.
 *
 * 순서가 곧 정확도다:
 *   1. **난이도까지 특정되는 정확 일치**(`하드스우` · `하스` · `카혼`)
 *   2. **보스 그룹 정확 일치**(`스우`) → 난이도가 여러 개면 `ambiguous` 로 되묻는다
 *   3. **난이도 접두사 분리**(`하스우` → 하드 + 스우)
 *
 * 2를 3보다 먼저 보는 이유: `카웅` 은 그 자체로 보스이고, 3을 먼저 하면 `카` + `웅`
 * 으로 갈라져 조용히 다른 보스가 된다.
 */
export function resolveBoss(term: string, now?: Date): BossLookup {
  const index = bossIndex(now);
  const candidates = [term, withoutParticle(term)].filter(
    (value): value is string => value !== null && value !== "",
  );

  for (const candidate of candidates) {
    const key = normalize(candidate);
    const exactEntry = fromBucket(index.byEntry.get(key));
    if (exactEntry !== null) return exactEntry;

    const exactGroup = fromBucket(index.byGroup.get(key));
    if (exactGroup !== null) return exactGroup;
  }

  for (const candidate of candidates) {
    const key = normalize(candidate);
    for (const [prefix, tier] of DIFFICULTY_PREFIXES) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (remainder.length < 1) continue;
      const bucket = index.byGroup.get(remainder);
      if (bucket === undefined) continue;
      const matched = bucket.filter((entry) => entry.difficulty === tier);
      const resolved = fromBucket(matched);
      if (resolved !== null) return resolved;
    }
  }

  return { kind: "none" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 토막 — `!일정 오늘` / `!일정 목`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `today` / `tomorrow` / ISO 요일(1=월 … 7=일) / `week`(이번 주 전체).
 *
 * ⚠️ **시각(`21시` · `오후9시`) 파서는 이번 범위에 없다.** 시각을 받는 명령이
 *    `!등록` 하나뿐인데 그 명령을 이번에 만들지 않았기 때문이다(README 성격의 근거는
 *    `server/commands.ts` 상단 참고). 쓰이지 않는 파서를 미리 넣으면 다음 사람이
 *    그것을 "이미 검증된 경로"로 읽는다.
 */
export type DayScope =
  | { readonly kind: "week" }
  | { readonly kind: "today" }
  | { readonly kind: "tomorrow" }
  | { readonly kind: "weekday"; readonly isoWeekday: number };

const WEEKDAY_TOKENS: Readonly<Record<string, number>> = {
  월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7,
};

/** 알아듣지 못하면 `null` — 조용히 이번 주 전체로 접지 않는다. */
export function parseDayScope(token: string | undefined): DayScope | null {
  if (token === undefined || token === "") return { kind: "week" };
  const key = normalize(token);
  if (key === "이번주" || key === "주간" || key === "전체") return { kind: "week" };
  if (key === "오늘") return { kind: "today" };
  if (key === "내일") return { kind: "tomorrow" };

  const weekday = key.replace(/요일$/u, "");
  const isoWeekday = WEEKDAY_TOKENS[weekday];
  if (isoWeekday !== undefined) return { kind: "weekday", isoWeekday };
  return null;
}
