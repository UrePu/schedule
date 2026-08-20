import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 결정석 수익 카드의 **유일한 조립 지점** — 대시보드와 수익 화면이 여기를 함께 쓴다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-19):
 *   · *"주간 월간은 따로놔야지"*
 *   · 결정석 수익에 **이론상 최대치**를 표시한다.
 *
 * ⚠️ **두 화면이 같은 계산을 써야 한다.** 대시보드의 `결정석 수익` 카드와 `/income` 상단
 *    요약은 같은 값을 말해야 하고, 계산이 두 벌이면 언젠가 갈라진다 — 이 저장소에서
 *    이미 두 번 일어나 두 번 고친 사고다. 그래서 조립은 이 파일 하나이고, 그리는 것도
 *    컴포넌트 하나(`components/crystal-income-summary.tsx`)다.
 *
 * ⚠️ **여기서 금액을 만들지 않는다.** 주기별 금액은 `v_weekly_income` 의
 *    `weekly_crystal_income_meso` / `monthly_crystal_income_meso`(마이그레이션 27)이고,
 *    이론상 최대치는 `v_weekly_plan_potential` 이다. 이 파일이 하는 산수는 **주간+월간을
 *    더해 최대치 총합을 내는 것 하나뿐**이며, 그것도 뷰가 이미 같은 절삭 규칙으로 낸 두
 *    값의 합이라 규칙이 복제되지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 주간과 월간을 섞으면 안 되는가 (§1)
 * ─────────────────────────────────────────────────────────────────────────────
 * **12개 상한은 주간 보스에만 걸린다.** 예전 카드는 `주간 보스 40 / 84건` 바로 옆에
 * `주간+월간 41건` 을 놓았는데, 그 41 은 84칸과 아무 관계가 없다 — 월간 결정석은 그
 * 카운터에 단 한 칸도 들어가지 않는다. 분모가 뜻을 잃은 상태였다.
 * 그래서 건수·금액·최대치를 **주기마다 따로** 세고, 합치는 것은 총 수익 한 줄뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이론상 최대치는 **이번 주에만** 뜻이 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * 계획(`character_boss_plans`)은 "매주 이 보스를 돈다"는 **현재 상태**이고, 과거 주차의
 * 계획 스냅샷은 어디에도 남지 않는다. 지난주 최대치를 지금 계획으로 그리면 그건 그때의
 * 상한이 아니라 지금의 상한이다. 그래서 과거 주차에는 `potential = null` 을 준다.
 */

import { ApiError } from "@/features/auth/server/http";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import type { BossCycle, MesoOrUnknown, WeekKey } from "@/types/domain";

import type {
  CrystalCycleTally,
  CrystalIncomeSummary,
  CrystalPotential,
  CrystalPotentialCycle,
  WeeklyBossSlots,
} from "../types";

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[crystal-summary] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[crystal-summary] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/** `numeric`/`bigint` 문자열 → 개수. PostgREST 는 집계 컬럼을 문자열로 줄 수 있다. */
export function toCount(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `bigint` 컬럼 → 메소.
 *
 * ★ 안전 정수 범위를 넘으면 `null`(미확인)로 접는다. 조용히 반올림하면 화면이 **틀린
 *   금액을 사실인 것처럼** 말한다. `null` 은 이미 "모름"이라는 뜻을 갖고 있고 화면이 그
 *   상태를 그릴 줄 안다.
 */
export function toSafeMeso(value: number | string | null): MesoOrUnknown {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isSafeInteger(parsed)) {
    console.warn(
      `[crystal-summary] 메소 값이 안전 정수 범위를 벗어났습니다: ${String(value)}`,
    );
    return null;
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 이론상 최대치 — `v_weekly_plan_potential` 을 **그대로** 읽는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **한 줄 리터럴이어야 한다.** supabase-js 가 select 문자열을 타입 수준에서 파싱해
 *   행 모양을 만들기 때문에, 이어 붙이면 타입이 `string` 으로 뭉개져 컬럼 오타가
 *   런타임까지 살아남는다.
 */
const POTENTIAL_COLUMNS =
  "cycle,character_count,planned_count,counted_count,over_limit_count,unknown_price_count,potential_meso";

const EMPTY_POTENTIAL_CYCLE: CrystalPotentialCycle = {
  plannedCount: 0,
  countedCount: 0,
  overLimitCount: 0,
  unknownPriceCount: 0,
  potentialMeso: 0,
};

/**
 * 이번 주 계획을 전부 클리어하면 얼마인가.
 *
 * **행이 없으면 `null`** 이다 — 계획이 하나도 켜져 있지 않거나 추적 캐릭터가 없다는 뜻이고,
 * 그때 `0` 을 최대치로 찍으면 "상한이 0원"이라는 거짓이 된다. 화면은 `null` 에서 최대치
 * 표기 자체를 그리지 않는다.
 */
export async function fetchCrystalPotential(
  userId: string,
  db: AdminDb = getAdminDb(),
): Promise<CrystalPotential | null> {
  const rows = unwrap(
    await db
      .from("v_weekly_plan_potential")
      .select(POTENTIAL_COLUMNS)
      .eq("user_id", userId),
    "이론상 최대치 조회",
  );

  if (rows.length === 0) return null;

  const byCycle = new Map<BossCycle, CrystalPotentialCycle>();
  let characterCount = 0;
  for (const row of rows) {
    if (row.cycle === null) continue;
    byCycle.set(row.cycle, {
      plannedCount: toCount(row.planned_count),
      countedCount: toCount(row.counted_count),
      overLimitCount: toCount(row.over_limit_count),
      unknownPriceCount: toCount(row.unknown_price_count),
      potentialMeso: toSafeMeso(row.potential_meso),
    });
    // 주기마다 행이 따로라 최대값을 쓴다 — 주간만 도는 캐릭터가 있으면 두 행의 수가 다르다.
    characterCount = Math.max(characterCount, toCount(row.character_count));
  }

  const weekly = byCycle.get("weekly") ?? EMPTY_POTENTIAL_CYCLE;
  const monthly = byCycle.get("monthly") ?? EMPTY_POTENTIAL_CYCLE;

  /*
   * 총합만 여기서 더한다. 두 값 모두 **뷰가 같은 절삭 규칙으로** 낸 것이라 규칙이
   * 복제되지 않고, 어느 한쪽이 `null`(안전 정수 초과)이면 총합도 `null` 이다 —
   * 모르는 값을 0 으로 채워 더하면 그 순간 최대치가 조용히 줄어든다.
   */
  const totalPotentialMeso =
    weekly.potentialMeso === null || monthly.potentialMeso === null
      ? null
      : weekly.potentialMeso + monthly.potentialMeso;

  return { weekly, monthly, totalPotentialMeso, characterCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 조립
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `v_weekly_income` 한 행에서 카드가 쓰는 부분만. **구조적 타입**이라 대시보드의
 * `WeeklyIncomeSummary` 가 그대로 들어맞는다 — 모듈 순환 import 를 만들지 않으려는 것이다.
 */
export interface WeeklyIncomeSummaryLike {
  readonly crystalIncomeMeso: MesoOrUnknown;
  readonly dropIncomeMeso: MesoOrUnknown;
  readonly totalIncomeMeso: MesoOrUnknown;
  readonly weeklyClearCount: number;
  readonly monthlyClearCount: number;
  readonly weeklyCrystalIncomeMeso: MesoOrUnknown;
  readonly monthlyCrystalIncomeMeso: MesoOrUnknown;
  readonly weeklyUnknownPriceCount: number;
  readonly monthlyUnknownPriceCount: number;
  readonly unknownPriceCount: number;
  readonly weeklyOverLimitCount: number;
  readonly dropCount: number;
  readonly unsoldDropCount: number;
}

const EMPTY_TALLY: CrystalCycleTally = {
  clearCount: 0,
  incomeMeso: 0,
  unknownPriceCount: 0,
};

/**
 * 카드 한 장을 조립한다.
 *
 * **`null` 을 돌려주는 경우**: 이번 주 집계도 없고(`summary === null`) 계획 최대치도
 * 없다(`potential === null`). 그때는 "아직 아무것도 없다"이지 "0원을 벌었다"가 아니므로
 * 화면이 빈 상태를 그린다.
 *
 * 반대로 클리어가 0건이어도 **계획이 있으면 카드를 그린다** — `0 / 최대 450억 (0%)` 은
 * 거짓이 아니라 "이번 주에 아직 안 돌았다"는 사실이고, 그게 사용자가 보려는 정보다.
 */
/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 월간 보스 수익은 **달 단위로** 읽는다 (2026-08-20 발주자)
 * ═════════════════════════════════════════════════════════════════════════════
 * *"이거 월간은 그래도 월간으로 조회해야지. 저번주에 월간 잡은걸 안보여주면 어떡함"*
 *
 * 요약의 나머지는 전부 `v_weekly_income`(주차 버킷)에서 온다. 그래서 8/17 에 잡은 검은
 * 마법사가 목요일 리셋을 넘기는 순간 화면에서 0 이 됐다 — 인게임 월간 초기화는 달력 1일
 * 이므로 사실과 다르다.
 *
 * ★ 집계는 `v_monthly_crystal_income`(마이그레이션 32)이 한다. **여기서 더하지 않는다.**
 * ★ 없으면 `null` 이 아니라 **0 건**이다 — 이번 달에 월간 보스를 아직 안 잡았다는 뜻이고,
 *   그건 "모른다"가 아니라 정상 상태다.
 */
export interface MonthlyCrystalIncome {
  readonly monthKey: string;
  readonly clearCount: number;
  readonly incomeMeso: number;
  readonly unknownPriceCount: number;
}

export async function fetchMonthlyCrystalIncome(
  userId: string,
  monthKey: string,
  db: AdminDb = getAdminDb(),
): Promise<MonthlyCrystalIncome> {
  const rows = unwrap(
    await db
      .from("v_monthly_crystal_income")
      .select("month_key,clear_count,income_meso,unknown_price_count")
      .eq("user_id", userId)
      .eq("month_key", monthKey),
    "이번 달 월간 보스 수익 조회",
  );

  const row = rows[0];
  if (row === undefined) {
    return { monthKey, clearCount: 0, incomeMeso: 0, unknownPriceCount: 0 };
  }
  return {
    monthKey,
    clearCount: Number(row.clear_count ?? 0),
    incomeMeso: Number(row.income_meso ?? 0),
    unknownPriceCount: Number(row.unknown_price_count ?? 0),
  };
}

export function buildCrystalIncomeSummary(
  weekKey: WeekKey,
  summary: WeeklyIncomeSummaryLike | null,
  potential: CrystalPotential | null,
  slotsInput: WeeklyBossSlots,
  /**
   * 이번 **달**의 월간 보스 수익. 주차 버킷과 범위가 다르므로 별도 인자다.
   * 넘기지 않으면 예전처럼 주차 값이 쓰인다(옛 호출부 호환).
   */
  month?: MonthlyCrystalIncome,
): CrystalIncomeSummary | null {
  if (summary === null && potential === null) return null;

  /*
   * ★ **네 필드만 남기고 좁힌다.** 대시보드는 `WeeklyBossCapacity` 를 그대로 넘기는데
   *   (구조적으로 들어맞는다) 그 객체에는 캐릭터별 남은 칸 배열이 딸려 있다. 그대로
   *   실으면 같은 배열이 `weeklyBossCapacity` 와 여기 두 번 나가고, 응답을 읽는 사람은
   *   둘 중 어느 쪽이 카드의 근거인지 헷갈린다.
   */
  const slots: WeeklyBossSlots = {
    trackedCount: slotsInput.trackedCount,
    perCharacterLimit: slotsInput.perCharacterLimit,
    limitTotal: slotsInput.limitTotal,
    clearedTotal: slotsInput.clearedTotal,
  };

  if (summary === null) {
    return {
      weekKey,
      crystalIncomeMeso: 0,
      dropIncomeMeso: 0,
      totalIncomeMeso: 0,
      weekly: EMPTY_TALLY,
      monthKey: month?.monthKey ?? null,
      monthly:
        month === undefined
          ? EMPTY_TALLY
          : {
              clearCount: month.clearCount,
              incomeMeso: month.incomeMeso,
              unknownPriceCount: month.unknownPriceCount,
            },
      dropCount: 0,
      unsoldDropCount: 0,
      weeklyOverLimitCount: 0,
      unknownPriceCount: 0,
      slots,
      potential,
    };
  }

  /*
   * 검산: 뷰가 낸 주기별 금액의 합은 **일간을 뺀 결정석 총액**과 같아야 한다.
   * 두 값의 출처가 다르므로(주기 컬럼 vs 총액 − 일간 뺄셈) 어긋나면 전제가 깨진 것이다.
   * 화면은 계속 그린다 — 숫자를 안 보여 주는 것보다 낫다 — 대신 로그로 드러낸다.
   */
  const weeklyMeso = summary.weeklyCrystalIncomeMeso;
  const monthlyMeso = summary.monthlyCrystalIncomeMeso;
  if (
    weeklyMeso !== null &&
    monthlyMeso !== null &&
    summary.crystalIncomeMeso !== null &&
    weeklyMeso + monthlyMeso !== summary.crystalIncomeMeso
  ) {
    console.warn(
      `[crystal-summary] 주기별 합(${String(weeklyMeso + monthlyMeso)})이 결정석 총액(${String(summary.crystalIncomeMeso)})과 다릅니다 (week=${weekKey}).`,
    );
  }

  return {
    weekKey,
    crystalIncomeMeso: summary.crystalIncomeMeso,
    dropIncomeMeso: summary.dropIncomeMeso,
    totalIncomeMeso: summary.totalIncomeMeso,
    weekly: {
      clearCount: summary.weeklyClearCount,
      incomeMeso: weeklyMeso,
      unknownPriceCount: summary.weeklyUnknownPriceCount,
    },
    /*
      ★ **달 기준이다.** 주차 값(`summary.monthly*`)은 위 검산에만 쓰고 화면에는 내보내지
        않는다 — 목요일이 지났다고 이번 달에 잡은 검은 마법사가 사라지면 안 된다.
        `month` 가 없는 옛 호출부만 예전처럼 주차 값으로 떨어진다.
    */
    monthKey: month?.monthKey ?? null,
    monthly:
      month === undefined
        ? {
            clearCount: summary.monthlyClearCount,
            incomeMeso: monthlyMeso,
            unknownPriceCount: summary.monthlyUnknownPriceCount,
          }
        : {
            clearCount: month.clearCount,
            incomeMeso: month.incomeMeso,
            unknownPriceCount: month.unknownPriceCount,
          },
    dropCount: summary.dropCount,
    unsoldDropCount: summary.unsoldDropCount,
    weeklyOverLimitCount: summary.weeklyOverLimitCount,
    unknownPriceCount: summary.unknownPriceCount,
    slots,
    potential,
  };
}
