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
import { kstDayKey } from "@/lib/time/kst-wallclock";
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

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 토막 — `!제외 0820`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0820` · `08-20` · `8/20` · `2026-08-20` → `YYYY-MM-DD` (KST 달력 날짜).
 *
 * ★ **연도를 생략하면 "가장 가까운 그 날짜"로 읽는다.** 방에서는 아무도 연도를 치지
 *   않는데, 12월에 `0103` 을 치면 올해 1월(이미 지난 날)이 되어 아무 효과가 없는 제외가
 *   조용히 만들어진다. 그래서 **오늘로부터 30일 이상 과거면 내년으로 넘긴다** — 지난주
 *   날짜를 정정하는 경우(며칠 전)는 그대로 남기고, 반 년 넘게 지난 날짜만 앞으로 민다.
 * ★ 존재하지 않는 날짜(`0230`)는 `null` 이다. JS `Date` 는 2/30 을 3/2 로 굴려 버리므로
 *   되읽어 비교해 걸러낸다 — 그렇지 않으면 사용자가 친 적 없는 날이 제외된다.
 */
export function parseDateToken(
  token: string | undefined,
  now: Date,
): string | null {
  if (token === undefined) return null;
  const key = normalize(token);

  let year: number | null = null;
  let month: number;
  let day: number;

  const full = /^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/u.exec(key);
  const short = /^(\d{1,2})[-./]?(\d{1,2})$/u.exec(key);
  const packed = /^(\d{2})(\d{2})$/u.exec(key);

  if (full !== null) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (packed !== null && key.length === 4) {
    month = Number(packed[1]);
    day = Number(packed[2]);
  } else if (short !== null) {
    month = Number(short[1]);
    day = Number(short[2]);
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 기준 연도는 **KST 달력의 올해**다. UTC 로 뽑으면 연말 자정 근처에서 한 해가 어긋난다.
  const kstToday = kstDayKey(now);
  const thisYear = Number(kstToday.slice(0, 4));

  const candidates = year !== null ? [year] : [thisYear, thisYear + 1];
  for (const candidate of candidates) {
    const iso = `${String(candidate).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // 되읽어 같은지 본다 — `2026-02-30` 은 여기서 걸린다.
    const probe = new Date(`${iso}T00:00:00+09:00`);
    if (Number.isNaN(probe.getTime())) continue;
    if (kstDayKey(probe) !== iso) continue;

    if (year !== null) return iso;
    // 30일 이상 지난 날짜면 다음 후보(내년)를 본다.
    if (iso >= shiftDayKey(kstToday, -30)) return iso;
  }
  return null;
}

/** `YYYY-MM-DD` 를 일 단위로 민다. 달·해 넘김은 `Date` 가 처리한다. */
function shiftDayKey(dayKey: string, days: number): string {
  const base = new Date(`${dayKey}T00:00:00+09:00`);
  return kstDayKey(new Date(base.getTime() + days * 24 * 60 * 60 * 1000));
}

/**
 * `09시` · `9시` · `09:00` · `18시30분` · `18:30` → **KST 자정 기준 분**(09:00 = 540).
 *
 * 정기 알림 시각(`!알림 09시`)을 읽는다. 분 단위 정수로 돌려주는 이유는
 * `availability_*` 가 이미 그 표현을 쓰기 때문이다 — 시간 표현이 두 종류면 변환이 곳곳에
 * 생긴다.
 *
 * ⚠️ **`30` 같은 맨 숫자는 받지 않는다.** `!알림 1 30 10` 의 `30` 은 "30분 전"이고
 *    `!알림 09시` 의 `09시` 는 "오전 9시"다. 두 뜻이 같은 토큰 모양을 쓰면 명령이
 *    모호해지므로, 시각은 **반드시 `시` 나 `:` 를 달고 있어야** 한다.
 */
export function parseClockMinute(token: string | undefined): number | null {
  if (token === undefined) return null;
  const key = normalize(token);

  const colon = /^(\d{1,2}):(\d{2})$/u.exec(key);
  const korean = /^(\d{1,2})시(?:(\d{1,2})분?)?$/u.exec(key);

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

  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 540 → `09:00`. 표시용. */
export function formatClockMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
