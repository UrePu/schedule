/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 경험치 히스토리 — 봇 `!%` 답장의 **계산과 모양**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-11-18): 다른 봇이 내던 답장을 그대로 따라 한다.
 * ```
 * [암뻐] - 크로아
 * 11월 12일 : Lv.290 89.229%
 * 11월 13일 : Lv.290 92.684% (+10.1조)
 * …
 * 11월 18일 : Lv.291 7.143% (+3210.6억)
 *
 * 일일 평균 획득량 : 9.1조
 * 남은 경험치량 : 300.6조
 * 예상 레벨업 날짜 :
 * 26년 12월 21일 (33일 후)
 * ```
 * 순수 함수만 둔다 — DB · 넥슨을 부르지 않는다. 날짜 키는 전부 **KST 달력 날짜**(`YYYY-MM-DD`)다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 레벨별 필요 경험치는 **상수표 없이 역산한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨은 그 레벨에서 보유한 경험치(`exp`)와 퍼센트(`rate`)를 함께 준다. 그래서
 * `필요 경험치 = exp × 100 / rate` 다. 표를 박지 않는 이유:
 *   · **패치로 경험치표가 바뀌어도 그대로 맞는다.** 표는 패치마다 누군가 고쳐야 하고, 안 고치면
 *     조용히 틀린다.
 *   · `rate` 는 **소수 셋째 자리에서 반올림된 값**이라 오차가 ±0.0005%p 다. 상대 오차는
 *     `0.0005 / rate` 이므로 **rate 가 클수록 정확하다.** 같은 레벨 행이 여럿이면 rate 가 가장
 *     큰 행 하나로 잰다.
 *   · rate 가 `MIN_RATE_FOR_REQUIRED`(0.1%) 미만이면 상대 오차가 0.5% 를 넘는다. 수백조 단위에서
 *     0.5% 는 몇 조라 하루 획득량보다 클 수 있다 — 그 레벨은 **모름**으로 둔다(레벨업 직후).
 */

import { addKstDays, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";

/** 만렙. 이 레벨에서는 남은 경험치 · 예상 날짜를 말하지 않는다. */
export const MAX_LEVEL = 300;

/** 몇 날을 보여 주나. 오늘 포함 7일 — 과거 6일(D-6 … D-1) + 오늘(최신). */
export const EXP_HISTORY_DAYS = 7;

/** 필요 경험치를 역산해도 되는 최소 퍼센트. 근거는 머리말. */
export const MIN_RATE_FOR_REQUIRED = 0.1;

/** 행이 하나도 없을 때의 답. */
export const EXP_HISTORY_EMPTY_TEXT = "경험치 기록을 불러오지 못했어요.";

/**
 * 예상 날짜를 **날짜로** 말하는 상한 — 10년.
 *
 * ★ 평균이 아주 작으면 예상이 수십만 일이 된다. 날짜는 `YY년` 두 자리라 100년마다 겹치고
 *   (실측: 710,039일 뒤가 `70년` 으로 찍혔다), 그만큼 먼 날짜는 어차피 뜻이 없다. 그래서 이
 *   상한을 넘으면 날짜 대신 `FORECAST_TOO_FAR_TEXT` 를 말한다. 일수가 네 자리로 묶여 최악 길이
 *   계산(`formatExpHistory` 주석)도 이 값에 기댄다.
 */
export const FORECAST_MAX_DAYS = 3650;
const FORECAST_TOO_FAR_TEXT = "10년 넘게 걸려요.";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 큰 단위부터. 경험치라 쉼표 없이 소수 한 자리로 접는다(메소 표기와 다르다). */
const EXP_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["조", 1e12],
  ["억", 1e8],
  ["만", 1e4],
];

/** 하루치 기록 한 줄. */
export interface ExpSample {
  /** KST 달력 날짜 `YYYY-MM-DD`. */
  readonly dayKey: string;
  readonly level: number;
  /** 그 레벨에서 보유한 경험치(정수). */
  readonly exp: number;
  /** 넥슨이 준 퍼센트 문자열 그대로(`"7.143"`). 표시는 이 문자열을 다시 찍지 않고 그대로 쓴다. */
  readonly rateText: string;
}

/**
 * 직전 행 → 이 행 사이의 획득량. 셀 수 없으면 레벨 차만 말한다.
 *
 * `days` 는 두 행 사이 일수다. 날짜가 빠지면(00:00~02:00 의 전날 `data_not_ready` 등) 2 이상이
 * 되고, 표시에도 그 일수를 붙인다 — 붙이지 않으면 이틀치가 하루치처럼 보인다.
 */
export type ExpGain =
  | { readonly kind: "known"; readonly amount: number; readonly days: number }
  | {
      readonly kind: "unknown";
      readonly levelDelta: number;
      readonly days: number;
    };

/** 예상 레벨업. 너무 먼 날(`FORECAST_MAX_DAYS` 초과 · 무한대)은 날짜를 만들지 않는다. */
export type ExpForecast =
  | { readonly kind: "date"; readonly days: number; readonly dayKey: string }
  | { readonly kind: "too-far" };

export type ExpRemaining =
  | { readonly kind: "known"; readonly amount: number }
  /** 현재 레벨의 rate 가 너무 작아 필요 경험치를 못 구했다(레벨업 직후). */
  | { readonly kind: "unknown" }
  | { readonly kind: "max-level" };

export interface ExpHistorySummary {
  /** 입력 순서 그대로. 첫 행의 `gain` 은 `null` 이다. */
  readonly rows: ReadonlyArray<{
    readonly sample: ExpSample;
    readonly gain: ExpGain | null;
  }>;
  /** 아는 획득량 합 / 그 구간들의 일수 합. 셀 구간이 없으면 `null`. */
  readonly dailyAverage: number | null;
  /** 행이 2개 이상일 때만. 1개면 `null`(헤더 + 그 한 줄만 보여 준다). */
  readonly remaining: ExpRemaining | null;
  /** 평균이 양수이고 남은 경험치를 알 때만. */
  readonly forecast: ExpForecast | null;
}

function rateOf(sample: ExpSample): number {
  return Number(sample.rateText);
}

/** 두 KST 날짜 키 사이의 일수. KST 는 서머타임이 없어 단순 차가 정확하다. */
function dayGap(from: string, to: string): number {
  return Math.round(
    (kstMoment(to, 0).getTime() - kstMoment(from, 0).getTime()) / DAY_MS,
  );
}

function shiftDayKey(dayKey: string, days: number): string {
  return kstDayKey(addKstDays(kstMoment(dayKey, 0), days));
}

/** 레벨 → 필요 경험치. 모르면 `null`(rate 가 임계 미만). */
function requiredByLevel(
  samples: readonly ExpSample[],
): ReadonlyMap<number, number | null> {
  const best = new Map<number, ExpSample>();
  for (const sample of samples) {
    const current = best.get(sample.level);
    if (current === undefined || rateOf(sample) > rateOf(current)) {
      best.set(sample.level, sample);
    }
  }

  const required = new Map<number, number | null>();
  for (const [level, sample] of best) {
    const rate = rateOf(sample);
    required.set(
      level,
      Number.isFinite(rate) && rate >= MIN_RATE_FOR_REQUIRED
        ? Math.round((sample.exp * 100) / rate)
        : null,
    );
  }
  return required;
}

/**
 * 획득량 · 평균 · 남은 경험치 · 예상 날짜.
 *
 * @param samples 날짜 오름차순. 마지막이 가장 최근(보통 오늘의 최신 조회)이다. 빠진 날이 있어도
 *   된다 — 그 구간은 두 행 사이 일수로 나눈다.
 * @param todayKey 오늘(KST). 예상 날짜는 여기서부터 센다.
 */
export function summarizeExpHistory(
  samples: readonly ExpSample[],
  todayKey: string,
): ExpHistorySummary {
  const required = requiredByLevel(samples);

  let knownSum = 0;
  let knownDays = 0;
  const rows = samples.map((sample, index) => {
    const previous = index > 0 ? samples[index - 1] : undefined;
    if (previous === undefined) return { sample, gain: null };

    const days = dayGap(previous.dayKey, sample.dayKey);
    const levelDelta = sample.level - previous.level;
    let gain: ExpGain;
    if (levelDelta === 0) {
      gain = { kind: "known", amount: sample.exp - previous.exp, days };
    } else {
      /*
        한 레벨 오른 구간만 이전 레벨의 필요 경험치로 잇는다. 두 레벨 이상 뛰면 중간 레벨의
        필요 경험치를 이 7일 안에서 알 길이 없다 — 모른다고 말한다(`(+2레벨)`).
      */
      const need = levelDelta === 1 ? required.get(previous.level) : null;
      gain =
        need === null || need === undefined
          ? { kind: "unknown", levelDelta, days }
          : { kind: "known", amount: need - previous.exp + sample.exp, days };
    }

    // 날짜가 겹친 행(일수 0)은 평균의 분모를 0 으로 만든다. 그런 구간은 평균에서 뺀다.
    if (gain.kind === "known" && gain.days > 0) {
      knownSum += gain.amount;
      knownDays += gain.days;
    }
    return { sample, gain };
  });

  const dailyAverage = knownDays > 0 ? knownSum / knownDays : null;
  const latest = samples[samples.length - 1];

  if (samples.length < 2 || latest === undefined) {
    return { rows, dailyAverage: null, remaining: null, forecast: null };
  }

  let remaining: ExpRemaining;
  if (latest.level >= MAX_LEVEL) {
    remaining = { kind: "max-level" };
  } else {
    const need = required.get(latest.level);
    remaining =
      need === null || need === undefined
        ? { kind: "unknown" }
        : { kind: "known", amount: Math.max(0, need - latest.exp) };
  }

  const forecast =
    remaining.kind === "known" && dailyAverage !== null && dailyAverage > 0
      ? forecastFrom(remaining.amount / dailyAverage, todayKey)
      : null;

  return { rows, dailyAverage, remaining, forecast };
}

/**
 * 남은 일수(실수) → 예상.
 *
 * ★ **상한 검사가 날짜 계산보다 먼저다.** 평균이 아주 작으면 일수가 억 단위를 넘고(실측: 6일 정지 후
 *   오늘 +1만), 그 일수로 날짜를 만들면 `Date` 가 범위를 벗어나 예외가 난다 — 명령 전체가 죽는다.
 *   NaN · Infinity 도 같은 갈래로 보낸다.
 */
function forecastFrom(rawDays: number, todayKey: string): ExpForecast {
  if (!Number.isFinite(rawDays) || rawDays > FORECAST_MAX_DAYS) {
    return { kind: "too-far" };
  }
  const days = Math.max(0, Math.round(rawDays));
  return { kind: "date", days, dayKey: shiftDayKey(todayKey, days) };
}

/** 한 단위 안에서 반올림한 값이 이 값(10000.0)에 닿으면 한 단위 올린다. */
const UNIT_CARRY_TENTHS = 100_000;

/** 단위 없이 찍는 정수의 상한. 반올림이 이 값에 닿으면 `만` 으로 넘어간다. */
const PLAIN_INTEGER_LIMIT = 10_000;

/**
 * 부호 없는 양 → `9.1조` · `3210.6억` · `12.3만` · `950`.
 *
 * ★ 단위는 **`abs >= 단위`** 로 고른다. 그리고 그 단위로 반올림한 값이 `10000.0` 이 될 때만 한
 *   단위 올린다(`9999.96억` → `1.0조`). 예전처럼 "반올림해서 1.0 이 되는 가장 큰 단위"로 고르면
 *   `9.5e11` 이 `1.0조` 가 되어 최대 5% 부풀었다(교차 검증 2026-11-18).
 */
function formatExpMagnitude(abs: number): string {
  let index = EXP_UNITS.findIndex(([, size]) => abs >= size);
  if (index === -1) {
    const whole = Math.round(abs);
    if (whole < PLAIN_INTEGER_LIMIT) return String(whole);
    index = EXP_UNITS.length - 1; // 9999.6 → `1.0만`
  }
  for (;;) {
    const entry = EXP_UNITS[index];
    if (entry === undefined) return String(Math.round(abs));
    const [unit, size] = entry;
    const tenths = Math.round((abs / size) * 10);
    if (tenths >= UNIT_CARRY_TENTHS && index > 0) {
      index -= 1;
      continue;
    }
    return `${(tenths / 10).toFixed(1)}${unit}`;
  }
}

/**
 * 경험치 양 → 위 표기. 부호는 음수일 때만 붙이되, **반올림해서 0 이 되면 붙이지 않는다**
 * (`-0` 방지 — 평균이 -0.3 이면 `0`).
 */
export function formatExpAmount(value: number): string {
  const magnitude = formatExpMagnitude(Math.abs(value));
  return value < 0 && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

/** 획득량은 늘 부호를 단다 — `+10.1조` · `-3.2억` · `+0`. */
function formatExpGain(amount: number): string {
  const formatted = formatExpAmount(amount);
  return formatted.startsWith("-") ? formatted : `+${formatted}`;
}

/** `(+10.1조)` · 빠진 날이 있으면 `(+38.3조, 2일)` · 셀 수 없으면 `(+2레벨)`. */
function formatGainSuffix(gain: ExpGain | null): string {
  if (gain === null) return "";
  const span = gain.days > 1 ? `, ${String(gain.days)}일` : "";
  if (gain.kind === "known") return ` (${formatExpGain(gain.amount)}${span})`;
  const sign = gain.levelDelta < 0 ? "-" : "+";
  return ` (${sign}${String(Math.abs(gain.levelDelta))}레벨${span})`;
}

/** `2026-11-12` → `11월 12일`. */
function formatMonthDay(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  return `${String(month)}월 ${String(day)}일`;
}

/** `2026-12-21` → `26년 12월 21일`. */
function formatShortDate(dayKey: string): string {
  return `${dayKey.slice(2, 4)}년 ${formatMonthDay(dayKey)}`;
}

/**
 * 답장 줄들. 평문 규칙(예산 · 빈 줄 접기)은 부르는 쪽의 `lines()` 가 적용한다.
 *
 * ★ 행이 1개면 **헤더 + 그 한 줄**뿐이다 — 획득량이 없으니 평균도 예상도 말할 것이 없다.
 * ★ 요약 앞의 빈 줄은 `toPlaintext` 를 통과한다(연속 빈 줄만 1줄로 접는다).
 * ★ 길이: 예시는 302자, **최악은 336자 · 13줄**이다(실측 2026-11-18 — 12자 닉 · 5자 월드
 *   `챌린저스4` · 7행 모두 `+5400.0억` · `1796.7조` · 네 자리 일수). 봇 답장 상한 350자에서
 *   도배 방지 꼬리(`differentiate` 의 8자)를 뺀 342자 안이다. 빠진 날의 `, 2일` 은 그 대신 한 줄이
 *   통째로 빠지므로 더 짧다(같은 조건 한 날 빠짐 301자). 줄을 늘리거나 문구를 길게 바꾸면
 *   이 여유(6자)부터 다시 잴 것 — 넘치면 `toPlaintext` 가 맨 끝 예상 날짜 줄을 `…` 로 자른다.
 */
export function formatExpHistory(input: {
  readonly characterName: string;
  readonly worldName: string | null;
  readonly samples: readonly ExpSample[];
  readonly todayKey: string;
}): readonly string[] {
  if (input.samples.length === 0) return [EXP_HISTORY_EMPTY_TEXT];

  const summary = summarizeExpHistory(input.samples, input.todayKey);
  const header =
    input.worldName === null || input.worldName === ""
      ? `[${input.characterName}]`
      : `[${input.characterName}] - ${input.worldName}`;

  const rowLines = summary.rows.map(
    ({ sample, gain }) =>
      `${formatMonthDay(sample.dayKey)} : Lv.${String(sample.level)} ${sample.rateText}%${formatGainSuffix(gain)}`,
  );

  if (summary.remaining === null) return [header, ...rowLines];

  const tail: string[] = [];
  if (summary.dailyAverage !== null) {
    tail.push(`일일 평균 획득량 : ${formatExpAmount(summary.dailyAverage)}`);
  }
  switch (summary.remaining.kind) {
    case "max-level":
      tail.push(`만렙(Lv.${String(MAX_LEVEL)})이라 남은 경험치가 없어요.`);
      break;
    case "unknown":
      tail.push("레벨업 직후라 남은 경험치를 아직 못 구해요.");
      break;
    case "known":
      tail.push(`남은 경험치량 : ${formatExpAmount(summary.remaining.amount)}`);
      break;
  }
  if (summary.forecast !== null) {
    const forecast = summary.forecast;
    tail.push(
      "예상 레벨업 날짜 :",
      forecast.kind === "too-far"
        ? FORECAST_TOO_FAR_TEXT
        : `${formatShortDate(forecast.dayKey)} (${forecast.days === 0 ? "오늘" : `${String(forecast.days)}일 후`})`,
    );
  }

  return [header, ...rowLines, "", ...tail];
}
