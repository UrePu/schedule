/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 소요 시간 — **기본값 · 우선순위 · "하나 고치면 나머지도"** 의 유일한 주인
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 흐름(전부 2026-10-21):
 *   ① *"각 보스의 소요시간을 대략적으로 만들고싶은데 하나를 입력하면 다 같이 계산되도록"*
 *   ② *"단순하게 계산하지말고... 보통 메이플은 1극 단위 (2분) 정도 차이나니까.. 그걸
 *      기준으로 잡으면되는데 보통 세대카는 동급, 림흉동급 < 벨로나 < 발드 기준임"*
 *   ③ *"근데 1인이냐 2인이냐에따라 엄청 차이 많이 나니까"*
 *   ④ *"하림하흉이 솔플이 되면 하발이 더 짧게 걸릴수도있는거고. … 일단 현재 가장 어려운
 *      보스를 20분으로 잡아서 자동계산 넣어버려. 세세한건 수정 조금씩 해주고. 캐릭별 보스
 *      관리에서 시간 수정 할수 있게. 기본값을 넣어주고 사람이 수정하면 수정되도록."*
 *
 * ④가 이 파일의 성격을 정한다: **계단은 진실이 아니라 출발점이다.** 실제 소요는 그
 * 캐릭터가 솔플이냐 · 센 사람과 2인이냐 · 돌먹이냐에 따라 달라지고, 순서마저 뒤집힐 수
 * 있다. 그래서 이 파일은 **기본값**을 만들고, 사람이 고친 값이 언제나 이긴다(아래 3절).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 계단 — "극"(극딜 한 주기 ≈ 2분) 단위로 끊긴다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 계단 위 보스는 혼자 칠 때 대략 2분 더 걸린다(②). 계단의 출처는 둘이다:
 *
 *   (가) **사람이 넣은 계단** — `BOSS_DURATION_STEPS`. 발주자가 확정한 것만 있다.
 *   (나) **시세로 끼운 계단** — 표에 없는 보스. ④ *"자동계산 넣어버려"* 때문에 필요하다.
 *
 * (나)의 규칙 — ⚠️ **시세로 분을 계산하지 않는다.** ②가 연속 곡선(시세의 거듭제곱·로그로
 * 분을 내는 "단순한 계산")을 거부했다. 여기서 시세는 오직 **"이미 아는 계단 사이에서
 * 어느 칸에 끼울지"** 를 고르는 데만 쓴다. 결과는 언제나 정수 계단이고, 분은 그 계단에서
 * (가)와 **똑같은 2분 간격**으로 나온다:
 *   - 닻: (가)의 각 계단에 속한 보스들의 시세 **기하평균**. 한 계단에 보스가 여럿이라
 *     (세대카 셋) 하나로 모은다 — 곱의 척도에서 가운데라 셋 중 누구에게도 치우치지 않는다.
 *   - 닻들 사이의 시세 → **로그 거리가 가장 가까운 닻**의 계단(가까운 쪽으로 반올림).
 *   - 가장 싼 닻보다 싼 보스 → **시세가 절반이 될 때마다 한 칸 아래**(반올림).
 *   - 가장 비싼 닻보다 비싼 보스 → **최상단 계단**(= 20분).
 *   - 시세가 `null` → 계단 **없음**(§1.3 D4 — 모르는 것은 지어내지 않는다).
 * 화면·보고가 둘을 갈라 보이도록 결과에 `source: "table" | "price"` 를 싣는다. 발주자가
 * (나)를 보고 (가)로 옮겨 적는 것이 이 표가 자라는 방식이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. 전역 기본값 — "지금 가장 어려운 보스 = 20분", 계단마다 2분씩 내려간다
 * ─────────────────────────────────────────────────────────────────────────────
 *     기본값(보스) = 20 − 2 × (최상단 계단 − 계단(보스)),  5분 바닥
 * 최상단은 (가) 표의 가장 큰 계단(지금 하발 3). 결과: 하발 20 · 하벨 18 · 하림/하흉 16 ·
 * 익세/하대/하카 14. 이 기본값은 **1인 기준**이다 — 인원을 모르는 자리(캐릭터 계획)의
 * 출발점이므로 인원으로 나누지 않는다. 사람이 고쳐서 맞춘다(④ "세세한건 수정").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. 우선순위 — `resolveBossDuration` 한 곳에만 적는다
 * ─────────────────────────────────────────────────────────────────────────────
 *     묶음에 사람이 넣은 값 > 캐릭터에 사람이 넣은 값 > 전역 기본값 > 20(DEFAULT_RUN_MINUTES)
 * 2026-10-21 부터 **새로 잡는 일정**이 이 순서로 깔린다(그 전에는 묶음이 비면 20). 이미
 * 잡힌 런의 길이는 `party_runs.duration_minutes` 에 얼어 있어 이 함수와 무관하다.
 * 묶음이 가장 구체적이다(그 파티 · 인원 · 캐릭터 조합). 캐릭터 값은 묶음이 비었을 때 쓰인다.
 * ★ 사람이 넣은 값은 DB 에 `null` 아닌 값으로만 존재한다(`party_bundle_bosses.duration_minutes`,
 *   `character_boss_plans.duration_minutes`). **기본값을 행에 미리 박지 않는다** — 박으면
 *   계단표를 고쳐도 기본값이 따라오지 않고 "사람이 고친 값"과 구분할 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. "하나를 고치면 나머지도" — 묶음 안의 빠른 조정
 * ─────────────────────────────────────────────────────────────────────────────
 *     한 칸     = 2분 ÷ 인원수        ← `minutesPerStep` (곡선을 바꾸려면 여기 한 곳)
 *     분(보스) = 고친 값 + 한 칸 × (계단(보스) − 계단(고친 보스)) → 반올림 → 5~20
 * ★ 기준(앵커)은 **사람이 방금 넣은 그 값**이고, 그것은 우선순위의 맨 위(묶음 값)다.
 *   전역 기본값을 앵커로 쓰지 않는다. 다른 보스의 화면 값(앞선 계산에서 20 벽에 막혔을
 *   수도 있다)도 읽지 않는다 — 가둬진 값이 다음 계산의 기준이 될 길이 없다.
 * ★ 사용자가 넣은 값은 인원으로 나누지 않는다 — 그 숫자에 인원 효과가 이미 들어 있다(③).
 * ⚠️ `÷ 인원수` 는 가정이다. 무적 구간·패턴 때문에 정확히 반비례하지 않는다.
 * ★ 칸이 1분보다 작아져도 순서는 뒤집히지 않는다(한 칸 > 0, 반올림·가두기 모두 비감소).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `lib/domain/` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * `run-grouping.ts` 와 같은 근거 — 웹과 봇과 서버 런 생성이 같은 답을 내야 한다. 이 파일은
 * **환경 중립**이다(React·DOM·DB 의존 없음, 보스 마스터는 코드 상수다 §2.4).
 */

import { getBossEntry, getTrackedBossCatalog } from "@/lib/boss-master";
import {
  DEFAULT_RUN_MINUTES,
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
} from "@/lib/domain/run-grouping";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 계단
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 계단 한 칸 = **2분**, 혼자 칠 때. 출처: 발주 원문 *"보통 메이플은 1극 단위 (2분) 정도
 * 차이나니까"*(2026-10-21). 인원에 따른 조정은 `minutesPerStep` 이 한다.
 */
export const MINUTES_PER_DURATION_STEP = 2;

/**
 * ★ **사람이 넣은 계단표 — 발주자가 확정한 것만.** 결정석 시세처럼 **패치 때 손으로
 *   고치는 상수**다.
 *
 * 고치는 법: `bossDifficultyId: 계단` 한 줄을 더하거나 숫자 하나를 바꾼다. id 는
 * `src/lib/boss-master/generated.ts` 의 `GENERATED_BOSS_DIFFICULTIES[].id` 와 같은 글자여야
 * 한다(틀린 id 는 어느 보스에도 붙지 않는다). 계단은 **상대값**이라 0 의 위치는 상관없고
 * 두 보스의 차이만 뜻이 있다. 이 표에 줄을 더하면 그 보스는 "시세로 끼움"에서 "사람이
 * 넣음"으로 바뀌고, 남은 보스들의 끼움 자리도 새 닻에 맞춰 다시 정해진다.
 *
 * | 계단 | 보스            | 근거(발주 원문 2026-10-21) |
 * |------|-----------------|----------------------------|
 * | 0    | 익세 · 하대 · 하카 | *"세대카는 동급"*           |
 * | 1    | 하림 · 하흉       | *"림흉동급"*                |
 * | 2    | 하벨             | *"< 벨로나"*                |
 * | 3    | 하발             | *"< 발드"*                  |
 *
 * 세대카(0) < 림흉(1) 은 발주자 확인을 받았다(*"ㅇㅇ 대충 맞아"*).
 */
export const BOSS_DURATION_STEPS: Readonly<Record<string, number>> = {
  seren_extreme: 0,
  first_adversary_hard: 0,
  kaling_hard: 0,
  limbo_hard: 1,
  radiant_malefic_star_hard: 1,
  bellona_hard: 2,
  baldrix_hard: 3,
};

/** 계단과 그 출처. `table` = 사람이 넣음, `price` = 시세로 끼움(1절 (나)). */
export interface DurationStep {
  readonly step: number;
  readonly source: "table" | "price";
}

interface StepAnchor {
  readonly step: number;
  readonly priceMeso: number;
}

/** (가) 표의 계단별 닻. 시세를 아는 보스만으로 만든다. 시세 오름차순. */
export function durationStepAnchors(
  priceOf: (bossDifficultyId: string) => number | null,
  table: Readonly<Record<string, number>> = BOSS_DURATION_STEPS,
): readonly StepAnchor[] {
  const logsByStep = new Map<number, number[]>();
  for (const [id, step] of Object.entries(table)) {
    const price = priceOf(id);
    if (price === null || !(price > 0)) continue;
    logsByStep.set(step, [...(logsByStep.get(step) ?? []), Math.log(price)]);
  }
  return [...logsByStep.entries()]
    .map(([step, logs]) => ({
      step,
      // 기하평균 = exp(로그 평균). 1절 (나) 참고.
      priceMeso: Math.exp(logs.reduce((sum, value) => sum + value, 0) / logs.length),
    }))
    .sort((a, b) => a.priceMeso - b.priceMeso);
}

/** (가) 표의 최상단 계단. 표가 비면 0. */
function topStepOf(table: Readonly<Record<string, number>>): number {
  const steps = Object.values(table);
  return steps.length === 0 ? 0 : Math.max(...steps);
}

/**
 * ★ **계단 판정의 본체.** 시세 조회와 표를 주입받으므로 가짜 데이터로 검증할 수 있다.
 * 시세를 모르고 표에도 없으면 `null` — 지어내지 않는다.
 */
export function durationStepFrom(
  bossDifficultyId: string,
  priceOf: (bossDifficultyId: string) => number | null,
  table: Readonly<Record<string, number>> = BOSS_DURATION_STEPS,
  anchors: readonly StepAnchor[] = durationStepAnchors(priceOf, table),
): DurationStep | null {
  if (Object.hasOwn(table, bossDifficultyId)) {
    const step = table[bossDifficultyId];
    if (step !== undefined) return { step, source: "table" };
  }
  const price = priceOf(bossDifficultyId);
  if (price === null || !(price > 0)) return null;
  const lowest = anchors[0];
  const highest = anchors[anchors.length - 1];
  if (lowest === undefined || highest === undefined) return null;

  // 가장 비싼 닻보다 비싸다 → 최상단(= 20분).
  if (price > highest.priceMeso) {
    return { step: topStepOf(table), source: "price" };
  }
  // 가장 싼 닻보다 싸다 → 시세가 절반이 될 때마다 한 칸 아래.
  if (price < lowest.priceMeso) {
    const halvings = Math.round(Math.log2(lowest.priceMeso / price));
    return { step: lowest.step - halvings, source: "price" };
  }
  // 닻들 사이 → 로그 거리가 가장 가까운 닻의 계단.
  let nearest = lowest;
  for (const anchor of anchors) {
    if (
      Math.abs(Math.log(price / anchor.priceMeso)) <
      Math.abs(Math.log(price / nearest.priceMeso))
    ) {
      nearest = anchor;
    }
  }
  return { step: nearest.step, source: "price" };
}

/** 지금 유효한 시세(코드 상수)로 본 계단. 화면·서버가 부르는 입구. */
export function durationStepOf(bossDifficultyId: string): DurationStep | null {
  return durationStepFrom(bossDifficultyId, currentPriceOf, BOSS_DURATION_STEPS, currentAnchors());
}

function currentPriceOf(bossDifficultyId: string): number | null {
  return getBossEntry(bossDifficultyId)?.crystalPriceMeso ?? null;
}

/** 닻은 카탈로그 스냅샷(참조 안정)마다 한 번만 만든다. 시세 패치 시각을 넘으면 새로 만든다. */
const ANCHORS_BY_CATALOG = new WeakMap<object, readonly StepAnchor[]>();

function currentAnchors(): readonly StepAnchor[] {
  const catalog = getTrackedBossCatalog();
  const cached = ANCHORS_BY_CATALOG.get(catalog);
  if (cached !== undefined) return cached;
  const anchors = durationStepAnchors(currentPriceOf);
  ANCHORS_BY_CATALOG.set(catalog, anchors);
  return anchors;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 전역 기본값
// ─────────────────────────────────────────────────────────────────────────────

/** 계단 → 기본 분. 2절의 식. 최상단 = RUN_DURATION_MAX(20), 5분 바닥. */
export function defaultMinutesForStep(
  step: number,
  table: Readonly<Record<string, number>> = BOSS_DURATION_STEPS,
): number {
  const minutes =
    RUN_DURATION_MAX - MINUTES_PER_DURATION_STEP * (topStepOf(table) - step);
  return Math.min(RUN_DURATION_MAX, Math.max(RUN_DURATION_MIN, minutes));
}

/** 보스의 전역 기본 분. 계단이 없으면(시세 null · 표에 없음) `null`. */
export function defaultBossMinutes(bossDifficultyId: string): number | null {
  const step = durationStepOf(bossDifficultyId);
  return step === null ? null : defaultMinutesForStep(step.step);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 우선순위
// ─────────────────────────────────────────────────────────────────────────────

export type BossDurationSource = "bundle" | "character" | "default" | "fallback";

export interface ResolvedBossDuration {
  readonly minutes: number;
  /** 어느 층에서 왔는가. 화면이 "기본값(흐리게)"과 "사람이 넣음(진하게)"을 가르는 근거다. */
  readonly source: BossDurationSource;
}

/**
 * ★ **우선순위의 유일한 정의** (머리말 3절).
 *     묶음 값 > 캐릭터 값 > 전역 기본값 > 마지막 방어선(`fallbackMinutes`, 기본 20)
 * `null` 은 "그 층에서 사람이 정하지 않았다"이다. 기본값은 `defaultMinutes` 로 주입할 수
 * 있다(검증용) — 생략하면 `defaultBossMinutes` 를 쓴다.
 *
 * ★ **부르는 곳이 셋이고, 셋이 같은 입력을 넣어야 한다** (2026-10-21 — 런 생성에 꽂음):
 *   - 서버 `schedule-repo.createPartyRuns` — 실제로 깔리는 분.
 *   - 화면 `timetable-run-dialog`(미리보기) · `bundle-editor-dialog`(칸 placeholder).
 *   - 봇 `!보스` 의 겹침 검사(답장 시각은 저장 결과를 그대로 읽는다).
 *   `bundleMinutes` = "그 창에서 방금 고친 값 ?? 묶음에 저장된 값", `characterMinutes` =
 *   **일정을 잡는 사람이 데려가는 캐릭터**의 `character_boss_plans.duration_minutes`.
 *   어느 캐릭터인지는 `createPartyRuns` 머리말(소요 시간 절)이 정한다.
 * ★ `fallbackMinutes` — 시세도 계단도 없는 보스(§1.3 D4 — 지어내지 않는다)에서만 쓰인다.
 *   서버는 요청의 `durationMinutes`(호출부가 전부 `DEFAULT_RUN_MINUTES` 를 싣는다)를 넣고,
 *   화면은 자기가 보내는 그 상수를 넣는다 — 그래서 이 층에서도 둘이 갈라지지 않는다.
 */
export function resolveBossDuration(input: {
  readonly bossDifficultyId: string;
  readonly bundleMinutes: number | null;
  readonly characterMinutes: number | null;
  readonly defaultMinutes?: number | null;
  readonly fallbackMinutes?: number;
}): ResolvedBossDuration {
  if (input.bundleMinutes !== null) {
    return { minutes: input.bundleMinutes, source: "bundle" };
  }
  if (input.characterMinutes !== null) {
    return { minutes: input.characterMinutes, source: "character" };
  }
  const fallback =
    input.defaultMinutes === undefined
      ? defaultBossMinutes(input.bossDifficultyId)
      : input.defaultMinutes;
  if (fallback !== null) return { minutes: fallback, source: "default" };
  return {
    minutes: input.fallbackMinutes ?? DEFAULT_RUN_MINUTES,
    source: "fallback",
  };
}

/**
 * 캐릭터 하나가 **사람이 고쳐 둔** 보스별 분. 키 = `bossDifficultyId`.
 * 값이 없는 보스는 키가 없다(= 기본값을 따름). 서버(`loadCharacterBossMinutes`)와
 * 화면(`RunCharacterOption.bossMinutes`)이 같은 모양을 쓴다.
 */
export type CharacterBossMinutes = Readonly<Record<string, number>>;

/** 캐릭터 값 한 칸을 꺼낸다. 캐릭터를 모르면(`null`) 그 층은 비었다. */
export function characterMinutesOf(
  minutes: CharacterBossMinutes | null | undefined,
  bossDifficultyId: string,
): number | null {
  if (minutes === null || minutes === undefined) return null;
  return Object.hasOwn(minutes, bossDifficultyId)
    ? (minutes[bossDifficultyId] ?? null)
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. "하나를 고치면 나머지도"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **한 칸 간격(분)을 정하는 유일한 자리.** `÷ 인원수` 는 가정이다(머리말 4절).
 * 인원이 1 미만이거나 수가 아니면 1인으로 본다(0 으로 나누지 않게).
 */
export function minutesPerStep(partySize: number): number {
  const size = Number.isFinite(partySize) && partySize >= 1 ? partySize : 1;
  return MINUTES_PER_DURATION_STEP / size;
}

export type DurationEstimateResult =
  | {
      readonly kind: "applied";
      /** **고친 보스를 뺀** 나머지 중 계단이 있는 보스의 새 분(반올림·5~20). */
      readonly minutes: ReadonlyMap<string, number>;
      /** 계단이 없어(시세 미확인) **건드리지 않은** 나머지 보스. */
      readonly unknownIds: readonly string[];
    }
  | {
      readonly kind: "skipped";
      /**
       * - `unset`: 칸을 비웠다. 기준으로 쓸 값이 없다.
       * - `unknown-step`: 고친 보스의 계단이 없다(시세 미확인). 나머지를 움직일 근거가 없다.
       */
      readonly reason: "unset" | "unknown-step";
    };

function clampMinutes(minutes: number): number {
  return Math.min(
    RUN_DURATION_MAX,
    Math.max(RUN_DURATION_MIN, Math.round(minutes)),
  );
}

/** 계산의 본체. 계단 조회를 주입받으므로 가짜 표로 검증할 수 있다. */
export function estimateFromSteps(
  bossDifficultyIds: readonly string[],
  editedId: string,
  editedMinutes: number | null,
  partySize: number,
  stepOf: (bossDifficultyId: string) => number | null = (id) =>
    durationStepOf(id)?.step ?? null,
): DurationEstimateResult {
  if (editedMinutes === null) return { kind: "skipped", reason: "unset" };
  const editedStep = stepOf(editedId);
  if (editedStep === null) return { kind: "skipped", reason: "unknown-step" };

  const perStep = minutesPerStep(partySize);
  const minutes = new Map<string, number>();
  const unknownIds: string[] = [];
  for (const id of bossDifficultyIds) {
    if (id === editedId) continue;
    const step = stepOf(id);
    if (step === null) {
      unknownIds.push(id); // 시세를 몰라 계단이 없다 — 그대로 둔다.
      continue;
    }
    minutes.set(id, clampMinutes(editedMinutes + perStep * (step - editedStep)));
  }
  return { kind: "applied", minutes, unknownIds };
}

/**
 * 화면이 부르는 입구. `partySize` 는 그 묶음을 실제로 도는 인원이다 — 어디서 세는지는
 * 호출부가 정하고 근거를 적는다(묶음 편집: 파티의 현재 구성원 수 · 일정 잡기: 체크한 참여자 수).
 */
export function estimateBundleDurations(
  bossDifficultyIds: readonly string[],
  editedId: string,
  editedMinutes: number | null,
  partySize: number,
): DurationEstimateResult {
  return estimateFromSteps(bossDifficultyIds, editedId, editedMinutes, partySize);
}
