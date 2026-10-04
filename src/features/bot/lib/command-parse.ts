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
import {
  addKstDays,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
} from "@/lib/time/kst-wallclock";
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
// 날짜 · 요일 토막 — `!일정 오늘` / `!일정 목` / `!보스 10/6` / `!보스 토`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 상대 날짜(오늘·내일·모레) / ISO 요일(1=월 … 7=일) / `week`(이번 주 전체).
 *
 * ⚠️ **여기에는 시각이 없다.** 날짜 토막과 시각 토막은 따로다 — 시각은 아래
 *    `parseClockMinute` 가 읽고, `!보스` 가 둘을 함께 쓴다. 둘을 한 파서로 합치지 않는
 *    이유는 **모양으로 갈리기 때문**이다: 시각은 `시`/`:` 를 달고 있고, 날짜는 구분자나
 *    `일` 접미사나 네 자리 숫자이고, 파티 번호는 맨 1~2자리 숫자다. 그래서 `!보스` 는
 *    토막 순서를 강제하지 않아도 된다.
 */
export type DayScope =
  /** `weekOffset` 0 = 이번 주, 1 = 다음 주. 그 이상도 **배관은 그대로 통한다**. */
  | { readonly kind: "week"; readonly weekOffset: number }
  /**
   * `dayOffset` 0 = 오늘, 1 = 내일, 2 = 모레. 아래 `RELATIVE_DAY_TOKENS` 표만 늘리면
   * 그 날이 열린다 — 예전에 `today` · `tomorrow` 두 종류로 박아 두었던 것을 2026-10-04 에
   * 오프셋 하나로 접었다. `!보스` 가 `모레` 를 받게 되면서 **같은 말을 두 명령이 다르게
   * 해석하지 않도록** 표를 한 벌로 모아야 했고, 종류를 늘리는 방식으로는 표가 한 벌이
   * 될 수 없었다.
   */
  | { readonly kind: "day"; readonly dayOffset: number }
  | { readonly kind: "weekday"; readonly isoWeekday: number };

const WEEKDAY_TOKENS: Readonly<Record<string, number>> = {
  월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7,
};

/** ISO 요일 → 한 글자. 표가 두 벌이 되지 않게 **여기 하나**만 둔다. */
const WEEKDAY_LABELS: readonly string[] = ["월", "화", "수", "목", "금", "토", "일"];

/** 1=월 … 7=일 → `토`. 범위 밖이면 빈 문자열(답장 조립이 멈추지 않게). */
export function formatIsoWeekdayKo(isoWeekday: number): string {
  return WEEKDAY_LABELS[isoWeekday - 1] ?? "";
}

/**
 * 상대 날짜 말 → 오늘로부터의 일수.
 *
 * ★ **`!일정` 과 `!보스` 가 같은 표를 읽는다**(2026-10-04). `!일정 내일` 과
 *   `!보스 내일 19시 3` 이 같은 날을 뜻해야 한다는 것은 설명이 필요 없는 수준이고,
 *   표가 두 벌이면 그게 어긋나는 데 커밋 하나면 된다.
 */
const RELATIVE_DAY_TOKENS: Readonly<Record<string, number>> = {
  오늘: 0,
  내일: 1,
  모레: 2,
};

/**
 * `토` · `토요일` · `토욜` → ISO 요일(1=월 … 7=일). 그 밖에는 `null`.
 *
 * ★ **요일 표기도 한 벌이다.** `!일정 토` 와 `!보스 토 19시 3` 이 같은 함수를 읽는다.
 *   두 명령이 요일로 하는 일은 다르지만(아래 `nextWeekdayDayKey` 주석), **`토` 가
 *   토요일이라는 해석 자체**는 갈라질 자리가 없어야 한다.
 */
export function parseWeekdayToken(token: string | undefined): number | null {
  if (token === undefined || token === "") return null;
  // `요일`·`욜` 둘 다 벗긴다. `!일정 토욜` 이 예전에 안 통했던 것이 이것 때문이다.
  const key = normalize(token).replace(/(요일|욜)$/u, "");
  return WEEKDAY_TOKENS[key] ?? null;
}

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

  const dayOffset = RELATIVE_DAY_TOKENS[key];
  if (dayOffset !== undefined) return { kind: "day", dayOffset };

  const isoWeekday = parseWeekdayToken(key);
  if (isoWeekday !== null) return { kind: "weekday", isoWeekday };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 토막 — `!보스 10/6 19시20분 3`
// ─────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` 를 일 단위로 민다. 달·해 넘김은 `kstMoment` 가 처리한다. */
export function shiftDayKey(dayKey: string, days: number): string {
  return kstDayKey(addKstDays(kstMoment(dayKey, 0), days));
}

/** `YYYY-MM-DD` 의 ISO 요일(1=월 … 7=일). 정오를 찍어 경계에서 흔들리지 않게 한다. */
export function isoWeekdayOfDayKey(dayKey: string): number {
  return kstIsoWeekday(kstMoment(dayKey, 12 * 60));
}

/**
 * **오늘을 포함해 다음에 오는 그 요일**의 KST 날짜 키.
 *
 * ★ 규칙이 이것 하나인 근거(발주 지시 2026-10-04: *"그거는 이번주 요일, 이미 지난
 *   요일이라면 다음주로"*). "이번 주 그 요일, 지났으면 다음 주"와 **결과가 같으면서**
 *   경계 논쟁이 없다 — 오늘이 그 요일일 때 "이번 주"인지 "지났는지"를 따질 필요가
 *   사라지기 때문이다. 오늘이면 오늘로 잡힌다(시각이 지났는지는 `!보스` 가 따로 알린다).
 *
 * ⚠️ **보스 주간 초기화(KST 목요일 00:00, CLAUDE.md §1)와는 아무 관계가 없다.**
 *    여기서 말하는 "다음 주"는 달력의 주차가 아니라 **그 요일이 다음에 오는 날**이다.
 *    목요일을 기준으로 고치면 수요일에 `금` 을 친 사람의 일정이 **8일 뒤**로 날아간다.
 *    주차 계산이 필요한 곳은 `lib/time/week.ts` 이고, 이 함수는 그것을 부르지 않는다.
 */
export function nextWeekdayDayKey(isoWeekday: number, now: Date): string {
  const delta = (isoWeekday - kstIsoWeekday(now) + 7) % 7;
  return shiftDayKey(kstDayKey(now), delta);
}

/**
 * `오늘` · `내일` · `모레` · `10/6` · `10-6` · `10.6` · `6일` · `1006` · `2026-10-06`
 * → `YYYY-MM-DD` (KST 달력 날짜). 알아듣지 못하면 `null`.
 *
 * ★ **2026-09-28 에 `!제외` 와 함께 지워졌던 파서를 되살린 것이다**(2026-10-04,
 *   발주 지시: *"그 !보스에 날짜가 없어서 날짜없으면 오늘 날짜 입력시 날짜로 들어가게"*).
 *   새로 짜지 않고 git 에서 꺼내 왔다 — 아래 두 함정은 그때 이미 값을 치르고 배운 것이다.
 *
 * ★ **연도를 생략하면 "가장 가까운 그 날짜"로 읽는다.** 방에서는 아무도 연도를 치지
 *   않는데, 12월에 `1/3` 을 치면 올해 1월(이미 지난 날)이 된다. 그래서 **오늘로부터
 *   30일 이상 과거면 내년으로 넘긴다** — 며칠 전 날짜는 그대로 과거로 남겨 두고
 *   (부르는 쪽이 "지난 날짜"라고 되물을 수 있게), 반 년 넘게 지난 날짜만 앞으로 민다.
 * ★ 존재하지 않는 날짜(`2/30`)는 `null` 이다. JS `Date` 는 2/30 을 3/2 로 굴려 버리므로
 *   되읽어 비교해 걸러낸다 — 그렇지 않으면 사용자가 친 적 없는 날에 일정이 잡힌다.
 *
 * ⚠️ **두 자리 짧은 형식은 구분자를 반드시 요구한다**(`10/6` ○ · `106` ✗). 되살리면서
 *    예전 정규식의 선택적 구분자(`[-./]?`)를 **필수로 바꿨다.** `!보스` 는 같은 줄에서
 *    **파티 번호를 맨 1~2자리 숫자로** 받으므로, 맨 숫자를 날짜로도 읽으면 `!보스 19시 3`
 *    의 `3` 이 "3번 파티"인지 "3일"인지 정할 방법이 없어진다. 날짜를 쓰려면 구분자(`10/6`),
 *    `일` 접미사(`6일`), 또는 네 자리(`1006`) 중 하나를 달아야 한다.
 * ⚠️ **`6일` 은 이번 달로만 읽는다.** 지났으면 다음 달로 넘기지 않는다 — 10/4 에 `3일`
 *    을 친 것은 다음 달 3일을 뜻할 가능성보다 오타일 가능성이 압도적이고, 조용히 한 달
 *    뒤에 잡히는 것이 가장 나쁘다. 부르는 쪽이 "지난 날짜"라고 되묻는다. (연도 쪽
 *    30일 규칙이 달 단위에서는 뜻이 없다: 한 달은 31일을 넘지 않으므로 이번 달 날짜는
 *    언제나 그 창 안에 들어온다.)
 */
export function parseDateToken(
  token: string | undefined,
  now: Date,
): string | null {
  if (token === undefined || token === "") return null;
  const key = normalize(token);

  // 기준 날짜는 **KST 달력의 오늘**이다. UTC 로 뽑으면 자정 근처에서 하루가 어긋난다.
  const kstToday = kstDayKey(now);

  const relative = RELATIVE_DAY_TOKENS[key];
  if (relative !== undefined) return shiftDayKey(kstToday, relative);

  const full = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/u.exec(key);
  const packedFull = /^(\d{4})(\d{2})(\d{2})$/u.exec(key);
  const short = /^(\d{1,2})[-./](\d{1,2})$/u.exec(key);
  const packedShort = /^(\d{2})(\d{2})$/u.exec(key);
  const dayOnly = /^(\d{1,2})일$/u.exec(key);

  const thisYear = Number(kstToday.slice(0, 4));
  const thisMonth = Number(kstToday.slice(5, 7));

  let year: number | null = null;
  let month: number;
  let day: number;

  if (full !== null) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (packedFull !== null) {
    year = Number(packedFull[1]);
    month = Number(packedFull[2]);
    day = Number(packedFull[3]);
  } else if (short !== null) {
    month = Number(short[1]);
    day = Number(short[2]);
  } else if (packedShort !== null) {
    month = Number(packedShort[1]);
    day = Number(packedShort[2]);
  } else if (dayOnly !== null) {
    month = thisMonth;
    day = Number(dayOnly[1]);
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const candidates = year !== null ? [year] : [thisYear, thisYear + 1];
  for (const candidate of candidates) {
    const iso = `${String(candidate).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // 되읽어 같은지 본다 — `2026-02-30` 은 여기서 걸린다.
    const probe = kstMoment(iso, 0);
    if (Number.isNaN(probe.getTime())) continue;
    if (kstDayKey(probe) !== iso) continue;

    if (year !== null) return iso;
    // 30일 이상 지난 날짜면 다음 후보(내년)를 본다.
    if (iso >= shiftDayKey(kstToday, -30)) return iso;
  }
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
