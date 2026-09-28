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
 * ⚠️ **여기에는 시각이 없다.** 날짜 토막과 시각 토막은 따로다 — 시각은 아래
 *    `parseClockMinute` 가 읽고, `!보스` 가 그것을 쓴다. 둘을 한 파서로 합치지 않는
 *    이유는 받는 자리가 겹치지 않기 때문이다: `!일정` 은 날짜만, `!보스` 는 시각만 받는다.
 */
export type DayScope =
  /** `weekOffset` 0 = 이번 주, 1 = 다음 주. 그 이상도 **배관은 그대로 통한다**. */
  | { readonly kind: "week"; readonly weekOffset: number }
  | { readonly kind: "today" }
  | { readonly kind: "tomorrow" }
  | { readonly kind: "weekday"; readonly isoWeekday: number };

const WEEKDAY_TOKENS: Readonly<Record<string, number>> = {
  월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7,
};

/**
 * 주차 토막 → 오프셋. **여기 한 줄만 늘리면 그 주가 열린다.**
 *
 * 발주 지시(2026-08-19): *"!일정 이번주 !일정 다음주 이것도 필요해. (…) 2,3주 뒤는 잘
 * 모르겠네 일단 다음주까진 만들어놓고 확장가능하도록하고."*
 *
 * 그래서 오프셋은 **정수로 배관을 통과**하고(주차 키 계산·리셋 표기가 전부 오프셋을 받는다),
 * 무엇을 받아들일지는 이 표만 정한다. `다다음주` 를 열려면 아래에 한 줄 추가하면 끝이고,
 * 다른 코드는 손대지 않는다.
 */
const WEEK_OFFSET_TOKENS: Readonly<Record<string, number>> = {
  이번주: 0,
  금주: 0,
  주간: 0,
  전체: 0,
  다음주: 1,
  담주: 1,
  차주: 1,
};

/** 알아듣지 못하면 `null` — 조용히 이번 주 전체로 접지 않는다. */
export function parseDayScope(token: string | undefined): DayScope | null {
  if (token === undefined || token === "") return { kind: "week", weekOffset: 0 };
  const key = normalize(token);

  const weekOffset = WEEK_OFFSET_TOKENS[key];
  if (weekOffset !== undefined) return { kind: "week", weekOffset };

  if (key === "오늘") return { kind: "today" };
  if (key === "내일") return { kind: "tomorrow" };

  const weekday = key.replace(/요일$/u, "");
  const isoWeekday = WEEKDAY_TOKENS[weekday];
  if (isoWeekday !== undefined) return { kind: "weekday", isoWeekday };
  return null;
}

/**
 * `09시` · `9시` · `09:00` · `18시30분` · `18:30` · `오전9시` · `오후9시` · `오후9:30`
 * → **KST 자정 기준 분**(09:00 = 540).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28: 부르는 곳이 `!알림` 에서 **`!보스`** 로 바뀌었다
 * ─────────────────────────────────────────────────────────────────────────────
 * 원래는 정기 알림 시각(`!알림 09시`)을 읽으려고 만든 파서다. 알림이 통째로 사라지면서
 * (`server/commands.ts` 머리말) 잠깐 부르는 곳이 없었고, 지금은 **`!보스 19시20분 3` 의
 * 시각 토막**이 이 함수 하나를 쓴다. 파서가 하나뿐이라 표기법이 명령마다 갈라질 수 없다.
 *
 * 분 단위 정수로 돌려주는 이유는 KST 하루 안의 위치를 나타내는 우리 표현이 그것이기
 * 때문이다 — `kstMoment(dayKey, minutes)` 가 바로 이 값을 받아 실제 시각을 만든다.
 *
 * ⚠️ **`30` 같은 맨 숫자는 받지 않는다.** 시각은 **반드시 `시` 나 `:` 를 달고 있어야**
 *    한다. `!보스` 가 `19시20분 3` 처럼 **시각과 파티 번호를 나란히** 받기 때문이다 —
 *    맨 숫자를 시각으로도 읽으면 `3` 이 "3번 파티"인지 "3시"인지 정할 방법이 없어진다.
 *    이 제약이 곧 `!보스` 가 두 토막을 순서와 무관하게 갈라낼 수 있는 근거다.
 */
export function parseClockMinute(token: string | undefined): number | null {
  if (token === undefined) return null;
  const key = normalize(token);

  /*
    ★ **오전/오후 접두사**(2026-08-31). 처음 연 이유는 `!알림 요약 오후9시` 였고 그 명령은
      사라졌지만, 열어 둔 표기는 **`!보스 오후9시 3` 이 그대로 물려받았다** — CLAUDE.md
      §2.2 가 요구하는 "느슨한 시간 형식"(`21시` / `21:00` / `오후9시`)의 일부다. 파서가
      하나뿐이라, 시각을 받는 명령이 몇 개가 되든 표기법이 갈라질 수 없다.
    ★ 12시 규칙은 한국어 관용을 그대로 따른다: **오전 12시 = 00:00 · 오후 12시 = 12:00.**
      단순히 `+12` 를 하면 오후 12시가 24시가 되어 `null` 로 떨어진다 — 사람이 정오를
      가리키려고 친 말이 "못 알아듣는 값"이 되는 것이 최악이다.
    ⚠️ 접두사가 붙으면 **12시간제**로 읽으므로 `오후13시` 는 거부한다. 받아 주면
      13 + 12 = 25 를 어떻게든 해석해야 하고, 그 해석은 사용자가 뜻한 바가 아니다.
  */
  let meridiem: "am" | "pm" | null = null;
  let body = key;
  if (body.startsWith("오전")) {
    meridiem = "am";
    body = body.slice(2);
  } else if (body.startsWith("오후")) {
    meridiem = "pm";
    body = body.slice(2);
  }
  if (body === "") return null;

  const colon = /^(\d{1,2}):(\d{2})$/u.exec(body);
  const korean = /^(\d{1,2})시(?:(\d{1,2})분?)?$/u.exec(body);

  let hour: number;
  let minute: number;
  if (colon !== null) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else if (korean !== null) {
    hour = Number(korean[1]);
    minute = korean[2] === undefined ? 0 : Number(korean[2]);
  } else {
    return null;
  }

  if (meridiem !== null) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    else if (meridiem === "pm" && hour !== 12) hour += 12;
  }

  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 540 → `09:00`. 표시용. */
export function formatClockMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
