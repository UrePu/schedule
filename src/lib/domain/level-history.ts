/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 레벨 히스토리 — 봇 `!ㄼ` · `!ㄹㅂ` 의 **탐색 계획과 답장 모양**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-11-18): 최근 10번의 레벨업 날짜와 각 레벨에 걸린 일수.
 * ```
 * [새스링] - 크로아
 * Lv.279 : 25년 11월 2일 (31일)
 * Lv.280 : 25년 12월 1일 (29일)
 * …
 * Lv.288 : 26년 11월 15일 (41일)
 *
 * 지금 : Lv.288 74.772% (레벨업 후 3일)
 * ```
 * 순수 함수만 둔다 — DB · 넥슨을 부르지 않는다. 날짜 키는 전부 **KST 달력 날짜**(`YYYY-MM-DD`)다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨에는 레벨업 기록이 없다 — **날짜 표본을 이분 탐색한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `/character/basic?date=D` 는 그날 하루의 상태(레벨 · exp · rate)만 준다. 표본 D 의 뜻은 `!%` 와
 * 같다: **D 하루가 끝난 시점의 상태.** 레벨은 시간에 대해 줄지 않으므로 "레벨 T 도달일" =
 * `level(D) ≥ T` 인 가장 이른 D 이고, 그 날은 괄호 `[a, b]`(`level(a) < T ≤ level(b)`)를 좁혀 찾는다.
 *   · 목표는 **L, L-1, …, L-10 의 11개**다(L = 현재 레벨). 10줄을 보이고, 맨 윗줄(L-9)에도 걸린
 *     일수를 달려고 하나 더 찾는다.
 *   · 오늘은 찌를 수 없다(실측: `date=오늘` → 400). 오늘 상태는 최신 조회(`date` 없음)로 받아
 *     괄호의 위 끝으로 쓴다. 그래서 찌를 수 있는 날은 하한일 … 어제다.
 *   · 하한일 `LEVEL_HISTORY_FLOOR_DAY` 는 넥슨 문서의 "2023-12-21 데이터부터 조회 가능"이다.
 *
 * ⚠️ 정확한 레벨업 **시각**이 아니라 **날**이다. 같은 날 여러 레벨을 올렸으면 그 레벨들은 같은
 *    날을 갖고(`(같은 날)`), 날 안의 순서는 알 수 없다.
 */

import { MAX_LEVEL, MIN_RATE_FOR_REQUIRED } from "@/lib/domain/exp-history";
import { addKstDays, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";

/** 넥슨 캐릭터 정보가 있는 첫날(넥슨 문서). 이보다 이른 날은 찌르지 않는다. */
export const LEVEL_HISTORY_FLOOR_DAY = "2023-12-21";

/** 답장에 보이는 줄 수. */
export const LEVEL_HISTORY_ROWS = 10;

/** 찾는 목표 수 — 보이는 줄 + 맨 윗줄의 일수를 셀 한 단계 아래. */
export const LEVEL_HISTORY_TARGETS = LEVEL_HISTORY_ROWS + 1;

/** 레벨 1 은 "도달"한 것이 아니라 만들었을 때의 상태라 목표로 삼지 않는다. */
const LOWEST_TARGET_LEVEL = 2;

/**
 * 아래쪽 끝(레벨이 목표보다 낮은 날)을 하나도 모르고 속도를 잴 표본도 오늘뿐일 때, 처음 찔러 볼 거리(일).
 * 이 한 점으로 한 달 치 속도를 재서 다음 탐침을 겨냥한다(아래 `REACH_OVERSHOOT`). 빨리 크는 캐릭터는
 * 이 한 점이 곧 아래쪽 끝이 된다.
 */
const INITIAL_REACH_DAYS = 30;

/**
 * 속도(하루 진행도)를 잴 두 점의 최소 간격(일). 하루치 획득량은 ±50% 흔들리고 쉬는 날도 있어, 이보다
 * 짧은 구간의 기울기로 수백 일을 외삽하면 크게 빗나간다.
 */
const SPEED_MIN_SPAN_DAYS = 7;

/**
 * 아래쪽 끝을 겨냥할 때 추정 거리에 곱하는 여유. 맨 아래 목표의 도달일보다 **조금 더 과거**를 찔러야
 * 한 번에 괄호가 생긴다. 너무 크면 그 목표의 괄호가 넓어지고, 작으면 한 번 더 넓혀야 한다.
 */
const REACH_OVERSHOOT = 1.15;

/**
 * 괄호 끝의 국소 기울기가 괄호 전체 기울기와 이 배수 이상 다르면 둘을 섞는다(`estimateCrossing`).
 * 그보다 비슷하면 괄호 전체(현)를 쓴다 — 하루치가 흔들리는 날에는 짧은 구간의 기울기가 더 시끄럽다.
 */
const LOCAL_SLOPE_RATIO = 1.5;

/**
 * 안전장치의 여유 — 한 목표의 탐침 수는 **괄호 안에 빈 날이 없을 때만** 이분 탐색 + 이 값을 넘지 않는다
 * (`bracketStep`). 빈 날은 찔러도 괄호가 줄지 않아 이 상한 밖이다(머리말 "안전장치"의 ⚠️).
 * 시뮬레이션(2026-11-18)에서 2 · 3 · 4 의 중앙값 차이는 1콜 안쪽이었다. 3 이면 좋은 추정이 괄호 끝 가까이
 * 떨어진 뒤 한두 번 더 보간할 여유가 있다.
 */
const GUARD_EXTRA_PROBES = 3;


/**
 * 레벨당 필요 경험치 비의 허용 범위. 이 밖이면 경험치 값을 믿지 않는다(아래 `consistent`). 외삽에도 이
 * 범위로 자른다 — 표가 한 레벨에서 크게 뛰어도 탐침 위치만 덜 좋아질 뿐이다.
 */
const REQUIRED_RATIO_MIN = 0.8;
const REQUIRED_RATIO_MAX = 2;

/** 같은 레벨 표본끼리 역산한 필요 경험치가 이 배수보다 어긋나면 경험치 값을 믿지 않는다(rate 반올림은 0.5% 안쪽). */
const REQUIRED_SPREAD_MAX = 1.05;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

/** 날짜 하나의 표본. */
export interface LevelSample {
  /** KST 달력 날짜 `YYYY-MM-DD`. 그날 하루가 **끝난 시점**의 상태다. */
  readonly day: string;
  /**
   * `null` = 그날 데이터 없음(넥슨이 빈 값 · "그날 기록 없음"으로 답했다). 판단 근거가 아니다.
   * 1 ~ `MAX_LEVEL` 정수가 아닌 레벨은 표본째 버린다(믿을 수 없는 값 — R2-7).
   */
  readonly level: number | null;
  /** 넥슨 퍼센트 문자열(`"74.772"`). 탐침 위치를 고르는 데만 쓴다. */
  readonly rate: string | null;
  /**
   * 그 레벨에서 보유한 경험치. 있으면 레벨별 필요 경험치(`exp × 100 / rate`)를 역산해 진행도를 **누적
   * 경험치**로 잰다 — 탐침 위치가 좋아질 뿐 결과(정확 · 근사 · 끊김)는 바뀌지 않는다.
   */
  readonly exp?: number | null;
  /**
   * `level === null` 인 날의 까닭. `before-creation` = 넥슨이 그 날짜를 "유효하지 않은 파라미터"로 거절했다
   * (캐릭터가 아직 없던 날 — 클라이언트 주석의 실측). 그 날 이전은 모두 같다. `no-data` = 빈 응답 등.
   * 모르면 `no-data` 로 읽는다. "지난 기록 없음"(`noPastData`)의 유일한 근거다.
   */
  readonly emptyReason?: LevelEmptyReason;
}

/** 빈 날의 까닭(`LevelSample.emptyReason`). */
export type LevelEmptyReason = "no-data" | "before-creation";

/**
 * 목표 하나의 **안전장치 상태**. 계획이 탐침을 낼 때 만들고, 부르는 쪽은 실제로 낸 탐침의 목표 몫만 다음
 * 계획에 넘긴다(`previousGuardStates`).
 */
export interface LevelGuardState {
  /** 이 목표에 처음 탐침을 낼 때 괄호 안 **모르는 날**의 수 + 1(경험치 경로의 상한 기준). */
  readonly firstWidth: number;
  /** 직전 탐침을 낼 때의 같은 값(경험치가 없을 때의 "절반 규칙" 기준). */
  readonly lastWidth: number;
  /** 지금까지 이 목표에 낸 탐침 수. */
  readonly used: number;
}

/** 한 목표 레벨의 결과. */
export type LevelReach =
  /** 전날은 아래, 이 날은 위 — 정확하다. */
  | { readonly kind: "exact"; readonly level: number; readonly day: string }
  /** 괄호 안쪽이 전부 데이터 없음이라 위 끝(`day`)으로 말한다 — 그 날 **이전**일 수 있다. */
  | { readonly kind: "approx"; readonly level: number; readonly day: string }
  /** 넥슨 기록 밖 — 하한일(또는 데이터 시작일)에 이미 이 레벨이었다. */
  | { readonly kind: "cut"; readonly level: number }
  /** 아직 모른다(더 찔러야 하거나, 찌르는 중인 날의 답을 기다린다). */
  | { readonly kind: "pending"; readonly level: number };

export interface LevelSearchInput {
  /** 지금까지 아는 날들(저장분 · 이번에 받은 것). 오늘 이후 · 하한일 이전은 무시한다. */
  readonly samples: readonly LevelSample[];
  readonly todayKey: string;
  /** 최신 조회의 레벨 = 오늘의 상태. 괄호의 위 끝이다. */
  readonly currentLevel: number;
  readonly currentRate: string | null;
  /** 최신 조회의 경험치(`LevelSample.exp` 와 같은 뜻). */
  readonly currentExp?: number | null;
  readonly floorDay: string;
  /**
   * **탐침 금지일** — 지금 찌르지 않는 날(보통 답을 기다리는 중인 날). 계획은 이 날을 내지 않고,
   * 판단 근거로도 쓰지 않는다. 괄호 안에 이런 날이 있는 목표는 그 답을 기다린다(`pending`, 탐침 없음 —
   * 같은 괄호에 두 번째 탐침을 겹쳐 내지 않는다). 근사로 접지도 않는다.
   */
  readonly blockedDays?: ReadonlySet<string>;
  /**
   * 직전 계획의 `guardStates` — 부르는 쪽은 실제로 낸 탐침의 목표 몫만 그대로 넘긴다(`probeTargets`).
   * 없으면(첫 계획) 처음부터 센다.
   */
  readonly previousGuardStates?: ReadonlyMap<number, LevelGuardState>;
}

export interface LevelSearchPlan {
  /** 목표별 결과. `[0]` 이 현재 레벨 L, 그 뒤로 L-1, L-2 … (최근 → 과거). */
  readonly reaches: readonly LevelReach[];
  /** 다음에 찔러 볼 날짜. **최근 레벨의 탐침이 앞**이다. 중복 없음. */
  readonly probes: readonly string[];
  /** 탐침 날짜 → 그 탐침이 좁히려는 목표 레벨들. 안전장치 상태를 목표별로 넘길 때 쓴다. */
  readonly probeTargets: ReadonlyMap<string, readonly number[]>;
  /** 모든 목표가 `pending` 이 아니다. */
  readonly done: boolean;
  /**
   * 하한일 ~ 어제에 **값 있는 날이 하나도 없음**이 탐침으로 확인됐다(오늘 만든 캐릭터). "레벨업한 적이
   * 없다"와 갈라 말한다(지휘 결정 2026-11-18, D8 · R2-6).
   * ★ 근거는 **넥슨이 "캐릭터가 없던 날"로 거절한 날**(`before-creation`)뿐이다: 그런 날 D 가 있고 D 뒤 ~ 어제가
   *   모두 빈 날로 확인됐으면 참. 빈 응답(`no-data`)만으로는 참이 되지 않는다 — 최근 며칠이 비어 있어도 그
   *   앞에 값 있는 날이 숨어 있을 수 있다(시뮬레이션: 최근 빈 날 묶음에서 452건 오답).
   */
  readonly noPastData: boolean;
  /** 목표별 안전장치 상태. 이번 계획에서 탐침을 받은 목표만 있다. 다음 계획의 `previousGuardStates` 로. */
  readonly guardStates: ReadonlyMap<number, LevelGuardState>;
}

/** KST 날짜 키 → 일 번호. KST 는 서머타임이 없어 단순 나눗셈이 정확하다. */
function ordinalOf(dayKey: string): number {
  return Math.round(kstMoment(dayKey, 0).getTime() / DAY_MS);
}

/** 일 번호 → KST 날짜 키. 기준 날짜에서 민다(`exp-history` 의 `shiftDayKey` 와 같은 길). */
function dayKeyOf(ordinal: number, anchorKey: string, anchorOrdinal: number): string {
  return kstDayKey(addKstDays(kstMoment(anchorKey, 0), ordinal - anchorOrdinal));
}

/** 퍼센트 문자열 → 0 이상 1 미만의 소수. 모르면 0(탐침 위치가 조금 덜 좋아질 뿐이다). */
function rateFraction(rate: string | null): number {
  if (rate === null) return 0;
  const value = Number(rate);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, 99.999) / 100;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** 올림 log₂, 최소 1. 폭 w 의 괄호를 이분 탐색으로 닫는 탐침 수의 상한이다. */
function binarySteps(width: number): number {
  return Math.ceil(Math.log2(Math.max(2, width)));
}

interface TargetStep {
  readonly reach: LevelReach;
  readonly probes: readonly number[];
  /** 탐침을 낼 때의 안전장치 상태(다음 계획으로 넘긴다). */
  readonly guardState?: LevelGuardState;
}

/** 믿을 수 있는 레벨 — 1 ~ 만렙 정수. */
function isUsableLevel(level: number): boolean {
  return Number.isInteger(level) && level >= 1 && level <= MAX_LEVEL;
}

/** 넘겨받은 안전장치 상태가 말이 되면 그대로, 아니면 `undefined`(처음부터 센다). */
function sanitizeGuard(state: LevelGuardState | undefined): LevelGuardState | undefined {
  if (state === undefined) return undefined;
  const { firstWidth, lastWidth, used } = state;
  const sane =
    Number.isSafeInteger(firstWidth) &&
    firstWidth >= 1 &&
    Number.isSafeInteger(lastWidth) &&
    lastWidth >= 1 &&
    Number.isSafeInteger(used) &&
    used >= 0;
  return sane ? state : undefined;
}

/**
 * 다음에 무엇을 찌를지 정한다. **상태가 없다** — 표본(과 넘겨받은 안전장치 상태)만 보고 매번 처음부터
 * 계산하므로, 저장된 표본으로 다음 `!ㄼ` 가 그대로 이어 간다. 탐침마다 다시 불러도 싸다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 결과의 정의 — 탐침 전략과 상관없이 **구조로** 맞는다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `a` = 레벨이 T 미만인 **가장 늦은** 날, `b` = `a` 뒤로 레벨이 T 이상인 가장 이른 날(오늘이
 *     언제나 후보다). 레벨이 줄어든 것처럼 보이는 표본이 섞여도 이 정의는 `[a, b]` 를 올바른 괄호로
 *     남긴다.
 *   · `b = a + 1` → **정확.** 이웃한 두 날이 실제로 목표를 사이에 둘 때뿐이다(±1일 근사는 없다).
 *     한 날에 여러 레벨을 올렸으면 여러 목표가 같은 날을 갖는다.
 *   · 데이터 없는 날(`null`)은 근거가 아니다. 괄호 안쪽이 **전부** 데이터 없음이면 근사(`approx`).
 *   아래의 탐침 규칙은 **어느 날을 찌르나**만 정한다 — 콜 수와 왕복 수만 바뀐다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 진행도 — 누적 경험치 (2026-11-18 2라운드, "찾는 알고리즘을 더 좋게 만들어서 호출횟수를 줄여")
 * ─────────────────────────────────────────────────────────────────────────────
 * `레벨 + rate` 는 레벨마다 크기가 같다고 가정하지만 필요 경험치는 레벨마다 커진다. 표본의
 * `exp × 100 / rate`(`!%` 와 같은 역산, rate ≥ `MIN_RATE_FOR_REQUIRED`)로 레벨별 필요 경험치를 구하고,
 * 표본이 없는 레벨은 이웃한 두 레벨의 비로 로그 보간 · 외삽한다. 그 위의 누적 경험치는 날짜에 대해
 * 단조이고, 하루 활동이 고르면 거의 직선이다. 경험치를 하나도 모르면(옛 표본) 예전처럼 `레벨 + rate` 와
 * 역이차 보간으로 돌아간다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 목표 T 의 다음 탐침
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 도달 시점 추정(`estimateCrossing`): 괄호 양 끝을 잇는 현(브라운 다리의 평균 — 하루치가 고르게
 *     흔들릴 때 가장 좋다). 다만 **가까운 쪽 끝**(누적 경험치 차이가 작은 쪽)의 국소 기울기가 현의 기울기와
 *     `LOCAL_SLOPE_RATIO` 배 이상 다르면 두 기울기의 기하평균으로 그 끝에서 외삽한다 — 활동이 달라진
 *     구간에서 현만 쓰면 하루씩 다가가는 "거짓 위치법" 기어가기가 났다(시뮬레이션에서 한 목표에 5콜).
 *   · 찌를 날 = 추정 시점을 **반올림한 날**. 도달일 R 은 (R-1, R) 쌍으로 확정되므로, 반올림한 날 x 는
 *     R = x 이면 위쪽, R = x+1 이면 아래쪽 짝이 된다 — 짝이 될 확률이 가장 큰 날이다.
 *   · **안전장치**: 한 목표의 탐침이 이분 탐색 + `GUARD_EXTRA_PROBES` 를 넘을 수 없게, 남은 몫으로는
 *     이분 탐색밖에 못 할 때부터 한가운데를 찌른다(`쓴 탐침 + 1 + ⌈log₂ 지금 폭⌉ > ⌈log₂ 처음 폭⌉ + 3`).
 *     폭은 괄호 안 **모르는 날의 수 + 1** 이고, 경험치를 모르는 경로에도 같은 예산을 건다(`bracketStep`).
 *     ⚠️ 경험치 경로에서는 1라운드의 "직전 탐침이 폭을 절반 이상 못 줄이면 이등분" 을 **이것으로
 *        바꿨다.** 그 규칙은 좋은 추정이 괄호 끝 가까이 정확히 떨어져도(한쪽 결과면 폭이 절반 넘게 남는다) 다음을 이등분으로 버려,
 *        꾸준한 캐릭터에서 목표마다 0.5콜씩(합 5콜) 더 들었다. 이 규칙의 최악은 목표당 이분 탐색 + 3 으로
 *        예전 "이분 탐색의 2배" 보다 오히려 좁다.
 *     ⚠️ **이 상한은 괄호 안에 빈 날이 없을 때만 지켜진다**(3라운드 재측정, 시뮬레이션 8,000건 · 같은 사례로
 *        비교, 한 목표의 탐침 수 ≤ ⌈log₂ 처음 폭⌉ + 3 인가). 빈 날 없는 캐릭터: 19,026목표 중 초과 0.
 *        빈 날 있는 캐릭터 포함: 45,326목표 중 2,313(5.1%) 초과, 최악 +90. 그중 1,676건은 **도달일 바로 앞이나
 *        그 날이 빈 날**이라 "대략"으로 답하려면 그 빈 날 묶음을 다 찔러야 하는 경우다(정확의 정의상 피할 수
 *        없다 — 명령당 60콜 상한이 대신 막는다). 나머지 637건(1.4%)은 괄호 안 다른 곳의 빈 날 때문이고 최악
 *        +16이다. 빈 날을 찌르면 폭이 하루만 줄어 예산 셈이 어긋나기 때문이며, 빈 날 곁을 피해 찌르는 규칙
 *        (`emptyRanks`)으로 줄였을 뿐 없애지 못했다(그 규칙과 "두 경로 모두 예산"(`bracketStep`) 전: 빈 날
 *        때문 871건 · 빈 날 없는 목표 126건, 최악 +79).
 *   · 같은 괄호의 목표들은 각자 제 추정일을 찌르되, 괄호 안에 **답을 기다리는 날**이 있으면 그 목표는
 *     이번에 찌르지 않는다 — 답이 오면 괄호가 갈라져 추정이 좋아진다(핸들러는 응답마다 다시 계획한다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 아래쪽 끝을 아직 모를 때(레벨이 T 미만인 날을 하나도 모른다)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 하한일에 값이 있으면(그러면 그 값은 T 이상이다) **넥슨 기록 밖**(`cut`).
 *   · 그런 목표 중 **가장 낮은 목표만** 찌른다 — 그 목표의 아래쪽 끝이 다른 목표들의 아래쪽 끝이 된다.
 *     값 있는 가장 이른 날 E 와, E 위로 `SPEED_MIN_SPAN_DAYS` 이상 떨어진 점 사이의 하루 진행도로 그 목표의
 *     도달 시점을 외삽하고 `REACH_OVERSHOOT` 만큼 더 과거를 찌른다. 표본이 오늘뿐이면
 *     `INITIAL_REACH_DAYS` 전, 진행이 없었으면(쉬는 중) 거리를 두 배로 넓힌다. 하한일보다 이르면 하한일.
 *     (1라운드는 4 · 16 · 64 · 256일 · 하한일 다섯 칸을 한 번에 냈다 — 빨리 크는 캐릭터에서 먼 칸을 버렸다.)
 *   · 빈 날(`null`)이 E 아래에 나오면 데이터가 **중간에 시작한** 경우다(실측: 새스링 2023-12-21 ~
 *     2024-02-01 빈 값, 2024-03-01 부터 값). 그 아래 가장 늦은 빈 날 `n` 과 E 사이를 이등분해 시작일을
 *     찾는다 — **이 구간에서만 빈 날을 "시작 전"으로 읽는다.** `n + 1 = E` 가 되면, 하한일을 아직 모르면
 *     하한일을 한 번 보고(그 날에 값이 있으면 `n` 은 시작이 아니라 구멍이다), 그래도 빈 날이면 그 목표는
 *     시작일에 이미 넘었으므로 넥슨 기록 밖이다.
 *     ⚠️ 시작 뒤 중간 구멍이 이 구간에 걸리면 시작일을 늦게 잡아, 찾을 수 있던 목표를 "기록 밖"으로
 *        끊을 수 있다. 틀린 날짜를 말하는 쪽보다 "더 이전 기록은 없다"고 말하는 쪽을 골랐다.
 *     ⚠️ 빈 날이 `character_exp_empty_days` 에 저장되므로(D3) 그렇게 잘못 끊긴 결과도 다음 조회 · 다른
 *        인스턴스로 이어진다 — 다만 저장한 빈 날은 `EMPTY_DAY_TRUST_DAYS`(30일) 뒤 다시 찔러 본다(R2-6).
 */
export function planLevelSearch(input: LevelSearchInput): LevelSearchPlan {
  // 믿을 수 없는 현재 레벨이면 아무것도 계획하지 않는다(부르는 쪽이 먼저 걸러 답한다 — R2-7).
  if (!isUsableLevel(input.currentLevel)) {
    return { reaches: [], probes: [], probeTargets: new Map(), done: true, noPastData: false, guardStates: new Map() };
  }
  const todayOrdinal = ordinalOf(input.todayKey);
  const floorOrdinal = ordinalOf(input.floorDay);
  const lastProbeOrdinal = todayOrdinal - 1;

  /** 알려진 날: 일 번호 → 레벨(`null` = 데이터 없음). 오늘은 최신 조회 값이다. */
  const levelAt = new Map<number, number | null>();
  /** 캐릭터가 아직 없던 날로 넥슨이 거절한 날(`before-creation`). */
  const beforeCreation = new Set<number>();
  const fractionAt = new Map<number, number>();
  const expAt = new Map<number, number>();
  for (const sample of input.samples) {
    if (!DAY_KEY.test(sample.day)) continue;
    const ordinal = ordinalOf(sample.day);
    if (ordinal < floorOrdinal || ordinal > lastProbeOrdinal) continue;
    if (sample.level === null) {
      // 같은 날 값 있는 표본이 따로 있으면 그쪽이 이긴다.
      if (!levelAt.has(ordinal)) levelAt.set(ordinal, null);
      if (sample.emptyReason === "before-creation") beforeCreation.add(ordinal);
      continue;
    }
    if (!isUsableLevel(sample.level)) continue;
    levelAt.set(ordinal, sample.level);
    fractionAt.set(ordinal, rateFraction(sample.rate));
    if (typeof sample.exp === "number" && Number.isFinite(sample.exp)) {
      expAt.set(ordinal, sample.exp);
    }
  }
  levelAt.set(todayOrdinal, input.currentLevel);
  fractionAt.set(todayOrdinal, rateFraction(input.currentRate));
  if (typeof input.currentExp === "number" && Number.isFinite(input.currentExp)) {
    expAt.set(todayOrdinal, input.currentExp);
  }

  const blocked = new Set<number>();
  for (const day of input.blockedDays ?? []) {
    if (!DAY_KEY.test(day)) continue;
    const ordinal = ordinalOf(day);
    if (!levelAt.has(ordinal)) blocked.add(ordinal);
  }

  /** 값 있는 날, 오름차순. */
  const points = [...levelAt]
    .filter((entry): entry is [number, number] => entry[1] !== null)
    .sort((a, b) => a[0] - b[0]);

  // ── 진행도: 누적 경험치(필요 경험치를 표본에서 역산), 모르면 레벨 단위 ──
  let minLevel = Math.max(LOWEST_TARGET_LEVEL, input.currentLevel - LEVEL_HISTORY_TARGETS + 1);
  let maxLevel = input.currentLevel;
  for (const [, level] of points) {
    minLevel = Math.min(minLevel, level);
    maxLevel = Math.max(maxLevel, level);
  }
  /** 레벨 → 역산한 필요 경험치(rate 가 가장 큰 표본에서 — `!%` 와 같은 이유). */
  const required = new Map<number, { readonly need: number; readonly rate: number }>();
  /** 레벨 → 표본들이 준 필요 경험치의 최소 · 최대(서로 맞는지 본다). */
  const spread = new Map<number, { min: number; max: number }>();
  for (const [ordinal, level] of points) {
    if (level >= MAX_LEVEL) continue;
    const exp = expAt.get(ordinal);
    const rate = (fractionAt.get(ordinal) ?? 0) * 100;
    if (exp === undefined || exp <= 0 || rate < MIN_RATE_FOR_REQUIRED) continue;
    const need = (exp * 100) / rate;
    const current = required.get(level);
    if (current === undefined || rate > current.rate) required.set(level, { need, rate });
    const range = spread.get(level);
    if (range === undefined) spread.set(level, { min: need, max: need });
    else {
      range.min = Math.min(range.min, need);
      range.max = Math.max(range.max, need);
    }
  }
  let knownLevels = [...required.keys()].sort((a, b) => a - b);
  /*
    ★ 경험치가 **넥슨 표처럼 생겼을 때만** 쓴다. 같은 레벨의 표본끼리 필요 경험치가 어긋나거나(rate 반올림
      오차는 0.5% 안쪽이다), 이웃한 레벨 사이의 레벨당 비가 `REQUIRED_RATIO_MIN`~`MAX` 밖이면 경험치 값을
      믿지 않고 레벨 단위로 돌아간다 — 탐침 위치가 엉뚱해져 콜을 상한까지 쓰는 것보다 낫다(검증 하네스의
      고정 경험치에서 실제로 그랬다).
  */
  const consistent =
    [...spread.values()].every((range) => range.max <= range.min * REQUIRED_SPREAD_MAX) &&
    knownLevels.every((level, index) => {
      const next = knownLevels[index + 1];
      if (next === undefined) return true;
      const step = Math.pow(
        (required.get(next)?.need ?? 1) / (required.get(level)?.need ?? 1),
        1 / (next - level),
      );
      return step >= REQUIRED_RATIO_MIN && step <= REQUIRED_RATIO_MAX;
    });
  if (!consistent) knownLevels = [];
  const needOf = (level: number): number => required.get(level)?.need ?? 1;
  const ratioBetween = (a: number, b: number): number =>
    clamp(
      Math.pow(needOf(b) / needOf(a), 1 / (b - a)),
      REQUIRED_RATIO_MIN,
      REQUIRED_RATIO_MAX,
    );
  /** 레벨 하나의 필요 경험치 — 모르면 이웃 레벨의 비로 보간 · 외삽, 하나도 모르면 1(레벨 단위). */
  const requiredOf = (level: number): number => {
    if (knownLevels.length === 0) return 1;
    const exact = required.get(level);
    if (exact !== undefined) return exact.need;
    let below: number | undefined;
    let above: number | undefined;
    for (const known of knownLevels) {
      if (known < level) below = known;
      else if (above === undefined) above = known;
    }
    if (below !== undefined && above !== undefined) {
      return needOf(below) * Math.pow(ratioBetween(below, above), level - below);
    }
    const anchor = below ?? above ?? level;
    let ratio = 1;
    const first = knownLevels[0];
    const second = knownLevels[1];
    const last = knownLevels[knownLevels.length - 1];
    const beforeLast = knownLevels[knownLevels.length - 2];
    if (below !== undefined && last !== undefined && beforeLast !== undefined) {
      ratio = ratioBetween(beforeLast, last);
    } else if (above !== undefined && first !== undefined && second !== undefined) {
      ratio = ratioBetween(first, second);
    }
    return needOf(anchor) * Math.pow(ratio, level - anchor);
  };
  /** 레벨 → 그 레벨에 막 닿은 순간의 누적 진행도. */
  const thresholdAt = new Map<number, number>();
  {
    let total = 0;
    for (let level = minLevel; level <= maxLevel + 1; level += 1) {
      thresholdAt.set(level, total);
      total += requiredOf(level);
    }
  }
  const threshold = (level: number): number => thresholdAt.get(level) ?? 0;
  /**
   * 값 있는 날의 누적 진행도.
   * ★ 만렙 날은 두지 않는다 — 그 괄호는 이등분한다. 만렙에서는 경험치가 더 쌓이지 않아 진행도가 멈춰
   *   있고, 그 값으로 보간하면 도달일을 늘 위 끝 바로 앞으로 추정해 한 칸씩만 좁힌다.
   */
  const progressAt = new Map<number, number>();
  for (const [ordinal, level] of points) {
    if (level >= MAX_LEVEL) continue;
    progressAt.set(ordinal, threshold(level) + (fractionAt.get(ordinal) ?? 0) * requiredOf(level));
  }
  const useExp = knownLevels.length > 0;

  /** 찌를 수 있는 날: 하한일 … 어제, 아직 모르고, 금지되지 않았다. */
  const isOpen = (ordinal: number): boolean =>
    ordinal >= floorOrdinal &&
    ordinal <= lastProbeOrdinal &&
    !levelAt.has(ordinal) &&
    !blocked.has(ordinal);

  /** `(low, high)` 안쪽에 찌를 날이 있나 · 답을 기다리는 날이 있나. */
  const scanInside = (low: number, high: number): { open: boolean; waiting: boolean } => {
    let open = false;
    let waiting = false;
    for (let ordinal = low + 1; ordinal < high && !(open && waiting); ordinal += 1) {
      if (isOpen(ordinal)) open = true;
      else if (blocked.has(ordinal)) waiting = true;
    }
    return { open, waiting };
  };

  /** `(low, high)` 안쪽의 찌를 수 있는 날, 오름차순. */
  const openInside = (low: number, high: number): number[] => {
    const days: number[] = [];
    for (let ordinal = low + 1; ordinal < high; ordinal += 1) {
      if (isOpen(ordinal)) days.push(ordinal);
    }
    return days;
  };

  /**
   * `aim` 을 찌를 수 없으면(이미 아는 빈 날 · 답을 기다리는 날) 그 날이 든 **찌를 수 없는 날 묶음 전체를
   * 하나로 보고**, 묶음의 양 바깥 중 `(low, high)` 안이고 괄호 가운데에 가까운 쪽을 고른다(R2-5).
   * ★ 예전에는 겨냥한 날에서 하루씩 넓혀 가장 가까운 날을 골라, 긴 빈 날 묶음 가장자리를 하루씩 걸었다
   *   (시뮬레이션: 한 목표에 97탐침). 묶음 바깥이 둘 다 괄호 끝이면 찌를 날이 없다(`null`).
   * 아래쪽 끝을 모르는 목표(`unboundedStep`)가 쓴다. 괄호를 아는 목표는 이것만으로는 모자라 — 겨냥한 날이
   * 찌를 수 있는 날이면 빈 날 바로 곁이어도 그대로 찔렀다 — `emptyRanks` · `nearestWhere` 를 쓴다.
   */
  const nearestOpen = (aim: number, low: number, high: number): number | null => {
    if (high - low <= 1) return null;
    const start = clamp(aim, low + 1, high - 1);
    if (isOpen(start)) return start;
    let left = start;
    while (left > low && !isOpen(left)) left -= 1;
    let right = start;
    while (right < high && !isOpen(right)) right += 1;
    const candidates = [left > low ? left : null, right < high ? right : null].filter(
      (candidate): candidate is number => candidate !== null,
    );
    if (candidates.length === 0) return null;
    const middle = (low + high) / 2;
    return candidates.reduce((best, candidate) =>
      Math.abs(candidate - middle) < Math.abs(best - middle) ? candidate : best,
    );
  };

  /**
   * 괄호 `(low, high)` 안 날마다 **빈 날 묶음과의 관계**: 0 = 멀다 · 1 = 묶음 곁(묶음 길이 안쪽) ·
   * 2 = 묶음 안(아는 빈 날 사이). 아는 빈 날이 없으면 `null`(전부 0).
   * ★ 왜(R2-5 재측정): 넥슨의 빈 날은 하루씩 흩어지기보다 며칠 ~ 몇 주씩 몰려 있어서, 빈 날 곁이나 두 빈 날
   *   사이를 찌르면 또 빈 날일 가능성이 높고 그 탐침은 괄호를 전혀 좁히지 못한다. 모르는 날의 한가운데만
   *   겨냥하면 긴 빈 날 묶음 한가운데에서 바깥으로 하루씩 걸었다(시뮬레이션: 한 목표에 100탐침 넘게).
   *   그래서 0 → 1 → 2 순서로만 찌른다. 묶음은 다음 빈 날과의 틈이 묶음 길이 이하면 이어 붙이고, 곁은
   *   묶음 길이만큼이라 — 빈 날이 이어질수록 피하는 폭이 두 배씩 커져 긴 묶음도 몇 번 만에 벗어난다.
   *   멀리 떨어진 외톨이 빈 날은 서로 묶이지 않아 그 곁 하루씩만 피한다.
   */
  const emptyRanks = (low: number, high: number): Uint8Array | null => {
    const clusters: Array<readonly [number, number]> = [];
    let start: number | null = null;
    let end = 0;
    for (let ordinal = low + 1; ordinal < high; ordinal += 1) {
      if (!levelAt.has(ordinal) || levelAt.get(ordinal) !== null) continue;
      if (start !== null && ordinal - end - 1 <= end - start + 1) {
        end = ordinal;
        continue;
      }
      if (start !== null) clusters.push([start, end]);
      start = ordinal;
      end = ordinal;
    }
    if (start !== null) clusters.push([start, end]);
    if (clusters.length === 0) return null;
    const ranks = new Uint8Array(high - low + 1);
    for (const [from, to] of clusters) {
      const length = to - from + 1;
      const first = Math.max(low + 1, from - length);
      const last = Math.min(high - 1, to + length);
      for (let ordinal = first; ordinal <= last; ordinal += 1) {
        const rank = ordinal >= from && ordinal <= to ? 2 : 1;
        if (rank > (ranks[ordinal - low] ?? 0)) ranks[ordinal - low] = rank;
      }
    }
    return ranks;
  };

  /** `(low, high)` 안에서 `accept` 를 만족하는 `aim` 에 가장 가까운 날(같으면 괄호 가운데에 가까운 쪽). */
  const nearestWhere = (
    aim: number,
    low: number,
    high: number,
    accept: (ordinal: number) => boolean,
  ): number | null => {
    if (high - low <= 1) return null;
    const start = clamp(aim, low + 1, high - 1);
    const middle = (low + high) / 2;
    for (let distance = 0; start - distance > low || start + distance < high; distance += 1) {
      const left = start - distance;
      const right = start + distance;
      const leftOk = left > low && accept(left);
      const rightOk = right < high && accept(right);
      if (leftOk && rightOk) {
        return Math.abs(left - middle) <= Math.abs(right - middle) ? left : right;
      }
      if (leftOk) return left;
      if (rightOk) return right;
    }
    return null;
  };

  /**
   * 오름차순 날들 `days` 를 연속한 날 묶음으로 나눠 **가장 긴 묶음의 가운데**(짝수면 앞쪽). 길이가 같으면
   * 괄호 가운데에 가까운 묶음. 빈 배열이면 괄호 달력 한가운데.
   */
  const widestGapMiddle = (days: readonly number[], low: number, high: number): number => {
    const middle = (low + high) / 2;
    let best: { start: number; end: number } | null = null;
    let start = 0;
    for (let index = 0; index < days.length; index += 1) {
      const current = days[index];
      const next = days[index + 1];
      if (current === undefined) break;
      if (next !== undefined && next === current + 1) continue;
      const runStart = days[start] ?? current;
      const length = current - runStart + 1;
      const bestLength = best === null ? 0 : best.end - best.start + 1;
      const runMiddle = (runStart + current) / 2;
      if (
        best === null ||
        length > bestLength ||
        (length === bestLength &&
          Math.abs(runMiddle - middle) < Math.abs((best.start + best.end) / 2 - middle))
      ) {
        best = { start: runStart, end: current };
      }
      start = index + 1;
    }
    if (best === null) return low + Math.floor((high - low) / 2);
    return best.start + Math.floor((best.end - best.start) / 2);
  };

  const pending = (level: number): LevelReach => ({ kind: "pending", level });
  const dayOf = (ordinal: number): string =>
    dayKeyOf(ordinal, input.todayKey, todayOrdinal);

  /** 괄호 끝 `anchor` 와 같은 쪽에서 가장 가까운 값 있는 날(국소 기울기용). 괄호 폭보다 멀면 쓰지 않는다. */
  const neighbourBeyond = (
    anchor: number,
    direction: 1 | -1,
    reach: number,
  ): readonly [number, number] | null => {
    const ordered = direction === 1 ? points : [...points].reverse();
    for (const [ordinal] of ordered) {
      if (direction === 1 ? ordinal <= anchor : ordinal >= anchor) continue;
      if (Math.abs(ordinal - anchor) > reach) return null;
      const progress = progressAt.get(ordinal);
      if (progress !== undefined) return [ordinal, progress];
    }
    return null;
  };

  /**
   * 괄호 `[low, high]` 안에서 진행도가 목표에 닿는 시점(일 번호, 실수). 못 구하면 `null`(이등분).
   * 규칙은 위 머리말. 경험치를 모르면 예전 역이차 보간(세 번째 점 = 괄호 위쪽 가장 가까운 값 있는 날).
   */
  const estimateCrossing = (level: number, low: number, high: number): number | null => {
    const lowProgress = progressAt.get(low);
    const highProgress = progressAt.get(high);
    const target = threshold(level);
    if (lowProgress === undefined || highProgress === undefined || !(highProgress > lowProgress)) {
      return null;
    }
    const width = high - low;
    const chord = low + ((target - lowProgress) / (highProgress - lowProgress)) * width;
    if (!Number.isFinite(chord)) return null;

    if (!useExp) {
      let above: readonly [number, number] | undefined;
      let below: readonly [number, number] | undefined;
      for (const [ordinal] of points) {
        const progress = progressAt.get(ordinal);
        if (progress === undefined) continue;
        if (ordinal < low) below = [ordinal, progress];
        if (ordinal > high && above === undefined) above = [ordinal, progress];
      }
      const third = above ?? below;
      if (third !== undefined) {
        const [x2, y2] = third;
        const quadratic =
          (low * ((target - highProgress) * (target - y2))) /
            ((lowProgress - highProgress) * (lowProgress - y2)) +
          (high * ((target - lowProgress) * (target - y2))) /
            ((highProgress - lowProgress) * (highProgress - y2)) +
          (x2 * ((target - lowProgress) * (target - highProgress))) /
            ((y2 - lowProgress) * (y2 - highProgress));
        if (Number.isFinite(quadratic) && quadratic > low && quadratic < high) return quadratic;
      }
      return chord;
    }

    const chordSlope = (highProgress - lowProgress) / width;
    const fromLow = target - lowProgress <= highProgress - target;
    const neighbour = fromLow
      ? neighbourBeyond(low, -1, width)
      : neighbourBeyond(high, 1, width);
    if (neighbour === null) return chord;
    const [ordinal, progress] = neighbour;
    const localSlope = fromLow
      ? (lowProgress - progress) / (low - ordinal)
      : (progress - highProgress) / (ordinal - high);
    if (!(localSlope > 0)) return chord;
    const ratio = localSlope / chordSlope;
    if (ratio < LOCAL_SLOPE_RATIO && ratio > 1 / LOCAL_SLOPE_RATIO) return chord;
    const slope = Math.sqrt(localSlope * chordSlope);
    return fromLow
      ? clamp(low + (target - lowProgress) / slope, low, high)
      : clamp(high - (highProgress - target) / slope, low, high);
  };

  /** 괄호 `[low, high]` 를 아는 목표. */
  const bracketStep = (level: number, low: number, high: number): TargetStep => {
    const width = high - low;
    if (width <= 1) return { reach: { kind: "exact", level, day: dayOf(high) }, probes: [] };
    const inside = scanInside(low, high);
    if (!inside.open) {
      return inside.waiting
        ? { reach: pending(level), probes: [] }
        : { reach: { kind: "approx", level, day: dayOf(high) }, probes: [] };
    }
    // 이 괄호에 답을 기다리는 날이 있다 — 그 답이 괄호를 가른 뒤에 다시 고른다.
    if (inside.waiting) return { reach: pending(level), probes: [] };

    /*
      ★ 안전장치의 폭은 **괄호 안 모르는 날의 수 + 1** 이다(달력 폭이 아니다 — R2-5). 이미 아는 빈 날은 다시
        찌를 일이 없어 후보가 아니다. 이등분은 모르는 날 중 **빈 날 묶음에서 가장 먼 등급**(`emptyRanks`)의
        날들의 가운데(짝수면 앞쪽)를 찌른다 — 빈 날이 없으면 달력 한가운데(`low + ⌊폭/2⌋`)와 같은 날이다.
    */
    const open = openInside(low, high);
    const effectiveWidth = open.length + 1;
    const previous = sanitizeGuard(input.previousGuardStates?.get(level));
    const firstWidth = previous?.firstWidth ?? effectiveWidth;
    const used = previous?.used ?? 0;
    const ranks = emptyRanks(low, high);
    const rankOf = (ordinal: number): number => (ranks === null ? 0 : (ranks[ordinal - low] ?? 0));
    let bestRank = Number.POSITIVE_INFINITY;
    for (const ordinal of open) bestRank = Math.min(bestRank, rankOf(ordinal));
    const preferred = ranks === null ? open : open.filter((ordinal) => rankOf(ordinal) === bestRank);
    /*
      빈 날 묶음 곁(등급 1)이나 안(등급 2)만 남았으면 추정도 이등분도 쓰지 않고, 남은 후보를 연속한 날
      묶음으로 나눠 **가장 긴 묶음의 가운데**를 찌른다. 후보 대부분이 빈 날 곁이라, 추정일에서 가장 가까운
      후보는 빈 날 묶음 가장자리 바로 바깥이 되어 묶음을 하루씩 넓히며 걸었다(3라운드 재측정: 한 목표에
      39탐침). 긴 묶음일수록 빈 날에서 멀리 떨어진 날이 있고, 그 가운데는 어느 답이 와도 후보를 가른다.
    */
    const insideCluster = bestRank >= 1;
    let aim = insideCluster
      ? widestGapMiddle(preferred, low, high)
      : (preferred[Math.floor((preferred.length - 1) / 2)] ?? low + Math.floor(width / 2));

    /*
      예산 "이분 탐색 + `GUARD_EXTRA_PROBES`"(머리말)는 **두 경로 모두** 지킨다. 경험치를 모를 때는 거기에
      1라운드 규칙(직전 탐침이 폭을 절반 이상 못 줄이면 이등분)을 더한다 — 레벨 단위 추정은 레벨 안의 진행
      모양에 따라 크게 빗나가므로, 빗나가면 바로 이등분하는 쪽이 시뮬레이션에서 낫다.
      ★ 예산을 경험치 경로에만 두었더니(3라운드 재측정), 탐색 도중 새 표본 때문에 경험치 일관성 검사가 깨져
        레벨 단위 경로로 넘어간 목표는 예산 없이 한쪽 끝에서 하루씩 다가갔다(빈 날 없는 캐릭터의 18,972목표
        중 100목표가 상한 초과, 최악 +6 → 이 규칙 뒤 0).
    */
    const overBudget =
      used + 1 + binarySteps(effectiveWidth) > binarySteps(firstWidth) + GUARD_EXTRA_PROBES;
    const mustBisect =
      overBudget ||
      (!useExp && previous !== undefined && effectiveWidth > Math.ceil(previous.lastWidth / 2));
    const crossing = mustBisect || insideCluster ? null : estimateCrossing(level, low, high);
    if (crossing !== null) {
      if (useExp) {
        aim = clamp(Math.round(crossing), low + 1, high - 1);
      } else {
        // 추정이 맞으면 어느 쪽 결과든 폭이 절반 이하가 되는 이웃을 찌른다.
        const reachGuess = clamp(Math.ceil(crossing), low + 1, high);
        aim = clamp(
          reachGuess - low <= width / 2 ? reachGuess : reachGuess - 1,
          low + 1,
          high - 1,
        );
      }
    }
    const probe = nearestWhere(
      aim,
      low,
      high,
      (ordinal) => isOpen(ordinal) && rankOf(ordinal) === bestRank,
    );
    return {
      reach: pending(level),
      probes: probe === null ? [] : [probe],
      guardState: { firstWidth, lastWidth: effectiveWidth, used: used + 1 },
    };
  };

  /** 아래쪽 끝을 하나도 모르는 목표 중 가장 낮은 것. 이 목표만 아래쪽 끝을 찌른다. */
  let lowestUnbounded: number | null = null;
  for (let index = 0; index < LEVEL_HISTORY_TARGETS; index += 1) {
    const level = input.currentLevel - index;
    if (level < LOWEST_TARGET_LEVEL) break;
    if (!points.some(([, value]) => value < level)) lowestUnbounded = level;
  }

  /**
   * 아래쪽 끝을 모르는 목표 `level` 의 도달 시점보다 조금 더 과거를 겨냥한 날(하한일 ~ `high`-1).
   * 값 있는 가장 이른 날 `high` 와 그 위로 `SPEED_MIN_SPAN_DAYS` 이상 떨어진 점 사이의 하루 진행도로
   * 외삽하고 `REACH_OVERSHOOT` 를 곱한다. 표본이 오늘뿐이면 `INITIAL_REACH_DAYS` 전, 진행이 없었으면 거리를
   * 두 배로. `high` 가 하한일이면 `null`.
   */
  const aimBelow = (level: number, high: number): number | null => {
    if (high <= floorOrdinal) return null;
    const highProgress = progressAt.get(high);
    let speed: number | null = null;
    if (highProgress !== undefined) {
      let reference: readonly [number, number] | undefined;
      for (const [ordinal] of points) {
        const progress = progressAt.get(ordinal);
        if (progress === undefined || ordinal <= high) continue;
        reference = [ordinal, progress];
        if (ordinal - high >= SPEED_MIN_SPAN_DAYS) break;
      }
      if (reference !== undefined) speed = (reference[1] - highProgress) / (reference[0] - high);
    }
    let aim: number;
    if (highProgress !== undefined && speed !== null && speed > 0) {
      const days = (highProgress - threshold(level)) / speed;
      aim = high - Math.ceil(days * REACH_OVERSHOOT) - 1;
    } else if (high === todayOrdinal) {
      aim = todayOrdinal - INITIAL_REACH_DAYS;
    } else {
      // 진행이 없었다(쉬는 중 · 만렙) — 거리를 두 배로 넓힌다.
      aim = todayOrdinal - 2 * (todayOrdinal - high);
    }
    return clamp(aim, floorOrdinal, high - 1);
  };

  /**
   * 맨 아래 목표(`lowestUnbounded`)가 빈 날보다 **더 과거를 먼저 볼 날**(아래 `unboundedStep` 의 "★ 빈 날
   * 하나만 보고 …"). 있으면 그 날, 없으면 `null`. 한 번만 계산한다.
   */
  let lowestDeeperMemo: number | null | undefined;
  const lowestDeeper = (): number | null => {
    if (lowestDeeperMemo !== undefined) return lowestDeeperMemo;
    lowestDeeperMemo = null;
    if (lowestUnbounded === null) return null;
    const level = lowestUnbounded;
    const high = points.find(([, value]) => value >= level)?.[0];
    if (high === undefined) return null;
    let lastEmpty: number | undefined;
    for (const [ordinal, value] of levelAt) {
      if (value === null && ordinal < high && (lastEmpty === undefined || ordinal > lastEmpty)) {
        lastEmpty = ordinal;
      }
    }
    if (lastEmpty === undefined) return null;
    const deeper = aimBelow(level, high);
    if (deeper !== null && deeper < lastEmpty && isOpen(deeper)) lowestDeeperMemo = deeper;
    return lowestDeeperMemo;
  };

  /** 아래쪽 끝을 아직 모르는 목표. `high` 는 값 있는 가장 이른 날이다. */
  const unboundedStep = (level: number, high: number): TargetStep => {
    const floorLevel = levelAt.get(floorOrdinal);
    if (floorLevel !== undefined && floorLevel !== null) {
      return { reach: { kind: "cut", level }, probes: [] };
    }

    /*
      ★ `high` 아래에 **답을 기다리는 날**이 하나라도 있으면 기다린다(R2-4). 그 답이 값을 주면 아래쪽 끝이
        생기거나 빈 날이 구멍으로 드러난다 — 그 전에 데이터 시작일을 판정하면 답장 시점에 섣불리 "기록 밖"
        이라고 말한다(재현: 중간 빈 날 + 더 과거 탐침이 날아가는 중).
    */
    if ([...blocked].some((ordinal) => ordinal < high)) {
      return { reach: pending(level), probes: [] };
    }

    let lastEmpty: number | undefined;
    for (const [ordinal, value] of levelAt) {
      if (value === null && ordinal < high && (lastEmpty === undefined || ordinal > lastEmpty)) {
        lastEmpty = ordinal;
      }
    }

    /*
      ★ 빈 날 하나만 보고 "데이터가 그 뒤에 시작한다"고 단정하지 않는다. 속도로 겨냥한 날(`aimBelow`)이 그
        빈 날보다 더 과거이고 아직 모르면 그 날을 먼저 본다 — 값이 있으면 그 빈 날은 시작 전이 아니라 중간
        구멍이다. 첫 탐침이 구멍에 떨어져 멀쩡한 목표를 "기록 밖"으로 끊는 일이 시뮬레이션에서 늘었다.
    */
    if (lastEmpty !== undefined && level === lowestUnbounded) {
      const deeper = aimBelow(level, high);
      if (deeper !== null && deeper < lastEmpty && isOpen(deeper)) {
        return { reach: pending(level), probes: [deeper] };
      }
    }

    if (lastEmpty !== undefined) {
      // 데이터가 시작하는 날을 찾는다(이 구간에서만 빈 날 = 시작 전).
      const inside = scanInside(lastEmpty, high);
      if (inside.open) {
        const probe = nearestOpen(
          lastEmpty + Math.floor((high - lastEmpty) / 2),
          lastEmpty,
          high,
        );
        return { reach: pending(level), probes: probe === null ? [] : [probe] };
      }
      // 시작일 경계에 닿았다. 하한일을 아직 모르면 한 번 본다(값이 있으면 `lastEmpty` 는 구멍이다).
      if (!levelAt.has(floorOrdinal)) return { reach: pending(level), probes: [floorOrdinal] };
      /*
        ★ 맨 아래 목표가 아직 더 과거를 볼 참이면(계획만 했고 동시 2 에 밀려 아직 안 냈을 수 있다) 끊지 않고
          기다린다 — 그 답이 값을 주면 이 빈 날도 구멍이다. 끊으면 답장 시점에만 "기록 밖"이 나간다(3라운드
          재측정: 무작위 6만 건 중 1건, 구멍이 많은 캐릭터에서 최종은 대략 날짜였다).
      */
      if (level !== lowestUnbounded && lowestDeeper() !== null) {
        return { reach: pending(level), probes: [] };
      }
      return { reach: { kind: "cut", level }, probes: [] };
    }

    // 맨 아래 목표만 겨냥한다 — 그 목표의 아래쪽 끝이 나머지의 아래쪽 끝이 된다.
    if (level !== lowestUnbounded) return { reach: pending(level), probes: [] };
    const aim = aimBelow(level, high);
    const probe = aim === null ? null : nearestOpen(aim, floorOrdinal - 1, high);
    if (probe === null) {
      // 하한일 ~ E 를 다 안다 — 값 있는 날이 다 T 이상이었으면 위에서 끊겼다. 여기는 금지일뿐인 경우다.
      return { reach: pending(level), probes: [] };
    }
    return { reach: pending(level), probes: [probe] };
  };

  const reaches: LevelReach[] = [];
  const guardStates = new Map<number, LevelGuardState>();
  const probeOrdinals: number[] = [];
  const targetsByProbe = new Map<number, number[]>();

  for (let index = 0; index < LEVEL_HISTORY_TARGETS; index += 1) {
    const level = input.currentLevel - index;
    if (level < LOWEST_TARGET_LEVEL) break;

    let low: number | undefined;
    for (const [ordinal, value] of points) {
      if (value < level) low = ordinal;
    }
    let high: number | undefined;
    for (const [ordinal, value] of points) {
      if ((low === undefined || ordinal > low) && value >= level) {
        high = ordinal;
        break;
      }
    }
    // 오늘(현재 레벨 ≥ 목표)이 늘 후보라 `high` 는 있다. 타입을 위한 방어다.
    if (high === undefined) {
      reaches.push(pending(level));
      continue;
    }

    const step =
      low === undefined ? unboundedStep(level, high) : bracketStep(level, low, high);
    reaches.push(step.reach);
    if (step.guardState !== undefined) guardStates.set(level, step.guardState);
    for (const ordinal of step.probes) {
      const targets = targetsByProbe.get(ordinal);
      if (targets !== undefined) {
        targets.push(level);
        continue;
      }
      targetsByProbe.set(ordinal, [level]);
      probeOrdinals.push(ordinal);
    }
  }

  /*
    지난 기록 없음(`noPastData`): 현재 레벨이 끊겼고 값 있는 날이 오늘뿐인 데다, 넥슨이 "캐릭터가 없던 날"로
    거절한 날 D 가 있고 D 다음 날 ~ 어제가 **전부 빈 날로 확인**됐을 때만이다. D 이전은 거절 그 자체가
    근거다(캐릭터가 없던 날 이전도 없던 날이다). 빈 응답만 있는 구간은 근거가 아니다(머리말 · R2-6).
  */
  const head = reaches[0];
  let noPastData = false;
  if (head?.kind === "cut" && points.every(([ordinal]) => ordinal >= todayOrdinal)) {
    let latestBeforeCreation: number | null = null;
    for (const ordinal of beforeCreation) {
      if (levelAt.get(ordinal) !== null) continue;
      if (latestBeforeCreation === null || ordinal > latestBeforeCreation) {
        latestBeforeCreation = ordinal;
      }
    }
    if (latestBeforeCreation !== null) {
      noPastData = true;
      for (let ordinal = latestBeforeCreation + 1; ordinal <= lastProbeOrdinal; ordinal += 1) {
        if (levelAt.get(ordinal) !== null) {
          noPastData = false;
          break;
        }
      }
    }
  }
  return {
    reaches,
    probes: probeOrdinals.map(dayOf),
    probeTargets: new Map(
      [...targetsByProbe].map(([ordinal, targets]) => [dayOf(ordinal), targets]),
    ),
    done: reaches.every((reach) => reach.kind !== "pending"),
    noPastData,
    guardStates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 답장 모양
// ─────────────────────────────────────────────────────────────────────────────

/** 최신 조회에 레벨이 없을 때의 답. */
export const LEVEL_HISTORY_EMPTY_TEXT = "레벨 기록을 불러오지 못했어요.";
const SEARCHING_FIRST_TEXT = "레벨업 날짜를 찾는 중이에요. 30초쯤 뒤 다시 쳐 주세요.";
const SEARCHING_MORE_TEXT = "이전 레벨은 찾는 중이에요. 잠시 후 다시 쳐 주세요.";
const STOPPED_NEXON_TEXT = "넥슨 조회가 멈춰 여기까지예요. 잠시 후 다시 쳐 주세요.";
const STOPPED_LIMIT_TEXT = "다시 치면 이전 레벨을 이어서 찾아요.";
const STOPPED_QUOTA_TEXT = "지금은 넥슨 조회량이 많아 여기까지예요.";
const BEYOND_RECORD_TEXT = "더 이전 기록은 넥슨에 없어요.";
const NO_LEVEL_UP_TEXT = "넥슨 기록 안에서는 레벨업한 적이 없어요.";
const NO_PAST_DATA_TEXT = "넥슨에 지난 기록이 아직 없어요.";

/**
 * 아직 못 찾은 목표가 있을 때 **탐색이 어떤 상태인가** — 아래에 붙일 말이 달라진다(지휘 결정 2026-11-18, D4).
 *   · `searching` — 탐색이 아직 돌고 있다. "찾는 중이에요 … 다시 쳐 주세요".
 *   · `nexon-stopped` — 넥슨 오류(할당량 · 서버 · 점검 등)로 멈췄다. 줄이 하나도 없으면 이 함수까지 오지
 *     않는다 — 부르는 쪽이 `!%` 와 같은 넥슨 실패 답장을 보낸다.
 *   · `limit-stopped` — 명령당 콜 상한(60) · 시간 상한으로 멈췄다. 다시 치면 저장된 표본에서 이어 간다.
 *   · `quota-stopped` — 키의 남은 몫 때문에 줄어든 상한으로 멈췄다(R2-2). "다시 치면 이어서"라고 하면 바로
 *     다시 친 사람이 예산 답을 받는다. 내일이라고도 하지 않는다 — 다른 키에 몫이 있을 수 있다.
 */
export type LevelPendingNote = "searching" | "nexon-stopped" | "limit-stopped" | "quota-stopped";

/** `2026-11-15` → `26년 11월 15일`. 앞자리 0 없음. */
function formatShortDate(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  return `${dayKey.slice(2, 4)}년 ${String(month)}월 ${String(day)}일`;
}

function daysBetween(from: string, to: string): number {
  return ordinalOf(to) - ordinalOf(from);
}

type Resolved = Extract<LevelReach, { kind: "exact" | "approx" }>;

function isResolved(reach: LevelReach | undefined): reach is Resolved {
  return reach !== undefined && (reach.kind === "exact" || reach.kind === "approx");
}

/**
 * 답장 줄들. 평문 규칙(예산 · 빈 줄 접기)은 부르는 쪽의 `lines()` 가 적용한다.
 *
 * ★ 위에서 아래로 **오래된 것 → 최근**(`!%` 와 같은 방향).
 * ★ **최근 쪽으로 연속해서 확정된 줄만** 보인다. 가운데가 비면 그 아래 줄들의 일수가 무엇과의
 *   차인지 읽는 사람이 알 수 없다.
 * ★ 괄호 안 일수는 **두 날이 모두 정확할 때만** 단다. 근사 날짜(`~`)는 "이 날 또는 그 이전"이라
 *   차를 내면 틀린 숫자가 된다. 같은 이유로 근사인 현재 레벨에는 `레벨업 후 N일` 을 달지 않는다.
 * ★ 길이(2026-11-18 실측 — 구성한 최악 + 무작위 30만 건): **최악 337자 · 13줄** — 12자 닉 · 5자 월드
 *   `챌린저스4` · 10줄 모두 11자 날짜 + 7자 꼬리(`(같은 날)`/세 자리 일수) · `지금` 줄 네 자리 일수.
 *   봇 답장 상한 350자에서 도배 방지 꼬리(`differentiate` 의 8자)를 뺀 342자 안이다. 이 최악은
 *   **일수의 합이 기록 길이를 넘을 수 없다**는 데 기대고 있다(10줄 일수 + `레벨업 후 N일` 의 합 =
 *   오늘 − 맨 아래 목표 도달일 ≤ 오늘 − 하한일). 네 자리 일수 하나가 1자를 더하므로 최악은
 *   `336 + ⌊기록 일수 / 1000⌋` 자다 — 지금(1,063일) 337, 2029-06 부터 338, 342 에 닿는 것은 2040 년
 *   (6,000일)이다. 그 제약을 무시한 조합(10줄 모두 네 자리)은 347자로 342자를 넘는다 — 문구를 늘리면
 *   여기부터 다시 잴 것. 찾는 중(333자) · 넥슨 멈춤(335자) · 상한 멈춤(324자) · 조회량 멈춤(325자) ·
 *   기록 밖(320자) 문구는 **줄이 10개 미만일 때만** 붙어 그만큼 짧다(2 · 3라운드 실측).
 */
export function formatLevelHistory(input: {
  readonly characterName: string;
  readonly worldName: string | null;
  readonly currentLevel: number;
  readonly currentRate: string | null;
  readonly todayKey: string;
  readonly reaches: readonly LevelReach[];
  /** `LevelSearchPlan.noPastData`. 참이면 목록 대신 "지난 기록이 아직 없다". */
  readonly noPastData?: boolean;
  /** 못 찾은 목표가 남았을 때 붙일 말. 기본은 `searching`. */
  readonly pendingNote?: LevelPendingNote;
}): readonly string[] {
  const pendingNote = input.pendingNote ?? "searching";
  const header =
    input.worldName === null || input.worldName === ""
      ? `[${input.characterName}]`
      : `[${input.characterName}] - ${input.worldName}`;

  const byLevel = new Map(input.reaches.map((reach) => [reach.level, reach]));
  const current = byLevel.get(input.currentLevel);

  let nowLine: string;
  if (input.currentLevel >= MAX_LEVEL) {
    nowLine = `지금 : Lv.${String(input.currentLevel)} (만렙)`;
  } else {
    const rate = input.currentRate === null ? "" : ` ${input.currentRate}%`;
    let since = "";
    if (current?.kind === "exact") {
      const days = daysBetween(current.day, input.todayKey);
      since = days === 0 ? " (오늘 레벨업)" : ` (레벨업 후 ${String(days)}일)`;
    }
    nowLine = `지금 : Lv.${String(input.currentLevel)}${rate}${since}`;
  }

  if (input.noPastData === true) return [header, NO_PAST_DATA_TEXT, "", nowLine];
  if (current === undefined || current.kind === "cut") {
    return [header, NO_LEVEL_UP_TEXT, "", nowLine];
  }

  const shown: Resolved[] = [];
  let stopper: LevelReach | undefined;
  for (let index = 0; index < LEVEL_HISTORY_ROWS; index += 1) {
    const reach = byLevel.get(input.currentLevel - index);
    if (reach === undefined) break;
    if (isResolved(reach)) {
      shown.push(reach);
      continue;
    }
    stopper = reach;
    break;
  }
  if (shown.length === 0) {
    // 넥슨 오류로 멈췄고 줄이 하나도 없으면 부르는 쪽이 실패 답장을 보낸다(위 `LevelPendingNote`).
    const first =
      pendingNote === "limit-stopped"
        ? STOPPED_LIMIT_TEXT
        : pendingNote === "quota-stopped"
          ? STOPPED_QUOTA_TEXT
          : SEARCHING_FIRST_TEXT;
    return [header, first, "", nowLine];
  }

  const rows = shown.reverse().map((reach) => {
    const date = `${reach.kind === "approx" ? "~" : ""}${formatShortDate(reach.day)}`;
    const below = byLevel.get(reach.level - 1);
    let gap = "";
    if (reach.kind === "exact" && below?.kind === "exact") {
      const days = daysBetween(below.day, reach.day);
      gap = days === 0 ? " (같은 날)" : ` (${String(days)}일)`;
    }
    return `Lv.${String(reach.level)} : ${date}${gap}`;
  });

  let note: string | null = null;
  if (stopper?.kind === "cut") {
    note = BEYOND_RECORD_TEXT;
  } else if (stopper !== undefined) {
    note =
      pendingNote === "nexon-stopped"
        ? STOPPED_NEXON_TEXT
        : pendingNote === "limit-stopped"
          ? STOPPED_LIMIT_TEXT
          : pendingNote === "quota-stopped"
            ? STOPPED_QUOTA_TEXT
            : SEARCHING_MORE_TEXT;
  }

  return [header, ...rows, ...(note === null ? [] : [note]), "", nowLine];
}
