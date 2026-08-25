import { formatKst } from "@/lib/time/week";

import type { WeekLedgerEntry } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 원장 묶음 — 주 / 월 / 년 / 기간
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-25): *"주차별 내역을 주차 단위, 월단위, 년단위 혹은 기간단위로 볼수있게
 * 변경해줘"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **주차 합계를 다시 더할 뿐, 클리어를 다시 세지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이게 이 파일에서 가장 중요한 결정이다. 한 달치를 만들려고 `boss_clears` 를 다시 더하면
 * **12개 상한 절삭이 사라져 금액이 부풀려진다.** 주간 결정석 판매 상한은 캐릭터당 주 12개고
 * (§1), 그 절삭은 `v_weekly_income` 이 **주 단위로** 이미 해 뒀다. 우리는 그 결과를 더한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 달·해 경계는 **주가 시작한 날**로 가른다 (근사)
 * ─────────────────────────────────────────────────────────────────────────────
 * 주는 목요일에 시작하므로 7/30~8/5 처럼 달을 걸치는 주가 있다. 그 주를 쪼개려면 결국
 * 클리어를 다시 세야 하고, 그러면 위의 절삭이 무너진다. 그래서 **주 전체를 시작한 달**에
 * 넣는다 — 화면이 그 사실과 포함된 주차를 함께 보여 주므로 사용자가 확인할 수 있다.
 * (`monthKeyOfWeek` 가 요약 카드에서 쓰는 규칙과 같다.)
 */

export type LedgerPeriod = "week" | "month" | "year" | "range";

export const LEDGER_PERIOD_LABEL: Record<LedgerPeriod, string> = {
  week: "주",
  month: "월",
  year: "년",
  range: "기간",
};

/** 한 묶음. `weeks` 는 **최신 주차가 먼저**이며 화면이 그대로 펼쳐 보여 준다. */
export interface LedgerBucket {
  readonly key: string;
  /** 사람이 읽는 이름. `2026년 8월` · `2026년` · `8/1 ~ 8/25`. */
  readonly label: string;
  /** 이 묶음이 덮는 주차. 주 단위면 한 개다. */
  readonly weeks: readonly WeekLedgerEntry[];
  readonly crystalIncomeMeso: number;
  readonly dropIncomeMeso: number;
  readonly totalIncomeMeso: number;
  readonly weeklyClearCount: number;
  readonly monthlyClearCount: number;
  readonly dropCount: number;
  /** 가격 미확인 건수. 합계에서 빠졌다는 사실을 화면이 말할 수 있게 따로 센다(§1.3 D4). */
  readonly unknownPriceCount: number;
  readonly weeklyOverLimitCount: number;
}

/** `null`(미확인)은 **0 이 아니라 모름**이라 합계에서 뺀다(§1.3 D4). */
function addKnown(sum: number, value: number | null): number {
  return value === null ? sum : sum + value;
}

function bucketKeyOf(week: WeekLedgerEntry, period: LedgerPeriod): string {
  if (period === "week") return week.weekKey;
  if (period === "range") return "range";
  const start = new Date(week.startsAt);
  return period === "month"
    ? formatKst(start, "yyyy-MM")
    : formatKst(start, "yyyy");
}

function bucketLabelOf(
  week: WeekLedgerEntry,
  period: LedgerPeriod,
  fallback: string,
): string {
  if (period === "week") return week.weekKey;
  if (period === "range") return fallback;
  const start = new Date(week.startsAt);
  return period === "month"
    ? formatKst(start, "yyyy년 M월")
    : formatKst(start, "yyyy년");
}

/**
 * 주차 목록을 고른 단위로 묶는다. 입력 순서(최신 주차 먼저)를 그대로 유지한다.
 *
 * `rangeLabel` 은 `range` 단위에서만 쓰인다 — 사용자가 고른 기간을 그대로 제목에 건다.
 */
export function buildLedgerBuckets(
  weeks: readonly WeekLedgerEntry[],
  period: LedgerPeriod,
  rangeLabel = "선택한 기간",
): readonly LedgerBucket[] {
  const order: string[] = [];
  const byKey = new Map<string, WeekLedgerEntry[]>();

  for (const week of weeks) {
    const key = bucketKeyOf(week, period);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [week]);
      order.push(key);
    } else {
      bucket.push(week);
    }
  }

  return order.map((key) => {
    const members = byKey.get(key) ?? [];
    let crystal = 0;
    let drop = 0;
    let total = 0;
    let weeklyClears = 0;
    let monthlyClears = 0;
    let drops = 0;
    let unknown = 0;
    let overLimit = 0;

    for (const week of members) {
      crystal = addKnown(crystal, week.crystalIncomeMeso);
      drop = addKnown(drop, week.dropIncomeMeso);
      total = addKnown(total, week.totalIncomeMeso);
      weeklyClears += week.weekly.clearCount;
      monthlyClears += week.monthly.clearCount;
      drops += week.drops.length;
      unknown += week.weekly.unknownPriceCount + week.monthly.unknownPriceCount;
      overLimit += week.weeklyOverLimitCount;
    }

    return {
      key,
      label: bucketLabelOf(members[0] as WeekLedgerEntry, period, rangeLabel),
      weeks: members,
      crystalIncomeMeso: crystal,
      dropIncomeMeso: drop,
      totalIncomeMeso: total,
      weeklyClearCount: weeklyClears,
      monthlyClearCount: monthlyClears,
      dropCount: drops,
      unknownPriceCount: unknown,
      weeklyOverLimitCount: overLimit,
    };
  });
}
