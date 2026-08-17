import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드의 **유일한 DB 접근 지점**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **여기서 수익을 계산하지 않는다.** 결정석 분배·주간 합계는 이미 DB 에 있고
 *    (`v_weekly_income`, `distribute_meso`, `v_run_crystal_settlement`), 웹과 카톡 봇이
 *    **같은 답**을 내야 하므로 구현은 한 곳뿐이어야 한다. 이 파일이 하는 일은
 *    **뷰의 컬럼을 그대로 읽어 화면 타입으로 옮기는 것뿐**이다. 곱하기·나누기·합계가
 *    이 파일에 등장하면 그건 이미 규칙 위반이다.
 *
 * ⚠️ **가격 미확인은 0 이 아니다** (§1.3 D4). `v_weekly_income.unknown_price_count` 를
 *    별도 필드로 그대로 올려 보내고, 화면이 합계와 **따로** 표시한다.
 *
 * ── 왜 서버 컴포넌트가 직접 부르는가 ─────────────────────────────────────────
 * `schedule-repo` 와 같은 이유다. service_role 은 브라우저로 나갈 수 없으므로 읽기는
 * 서버 컴포넌트가 이 파일을 직접 import 한다. 대시보드에는 클라이언트 조회가 필요한
 * 위젯이 없어(키 목록만 예외이고 그건 별도 Route Handler 가 이미 있다) Route Handler 를
 * 새로 만들지 않았다.
 */

import { getAdminDb } from "@/lib/supabase/admin-db";
import { ApiError } from "@/features/auth/server/http";
import { fetchWeeklyChecklist } from "@/features/boss-plans/server/boss-plan-repo";
import type { CharacterChecklist } from "@/features/boss-plans/types";
import type { MesoOrUnknown, PartyId, WeekKey } from "@/types/domain";

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

/** 실패는 우리 문구로 접는다 — PostgREST 에러 원문에는 스키마 구조가 그대로 들어 있다. */
function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[dashboard-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[dashboard-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 이번 주 결정석 수익 — `v_weekly_income` 를 **그대로** 읽는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `v_weekly_income` 한 행의 화면용 모양.
 *
 * 뷰의 집계 컬럼은 `numeric` 이라 PostgREST 가 **문자열**로 준다(`"6"`). 자릿수가 큰
 * 값에서 정밀도가 깨지지 않게 만든 타입이므로, 여기서 `Number()` 로 한 번만 좁힌다.
 * 건수는 전부 12 이하의 작은 정수라 안전하다. 반면 **메소 금액은 `bigint`** 이므로
 * 같은 취급을 하면 안 된다 — 아래 `toSafeMeso()` 참고.
 */
export interface WeeklyIncomeSummary {
  readonly weekKey: WeekKey;
  /** 결정석 수익 합계. **`null` 은 "집계 불가"이지 0 이 아니다.** */
  readonly crystalIncomeMeso: MesoOrUnknown;
  /** 이번 주 클리어 수(일간·주간·월간 전부). */
  readonly clearCount: number;
  /** 그중 주간 보스 클리어 수. 12 상한과 비교하는 값이다. */
  readonly weeklyClearCount: number;
  /** **가격 미확인 건수.** 0 으로 더하지 않고 따로 센다 (§1.3 D4). */
  readonly unknownPriceCount: number;
  /** 주간 12 상한을 넘긴 건수. 뷰가 세어 준다 — 우리가 세지 않는다. */
  readonly weeklyOverLimitCount: number;
  /** 결정석 외 드랍 수익. */
  readonly dropIncomeMeso: MesoOrUnknown;
  readonly dropCount: number;
  /** 아직 팔지 않은 드랍 건수. 합계에 들어가지 않는다. */
  readonly unsoldDropCount: number;
  /** 뷰가 낸 총합. **결정석 + 드랍을 우리가 더하지 않는다.** */
  readonly totalIncomeMeso: MesoOrUnknown;
}

/** 주간 보스 결정석 판매 상한(§1). 화면이 "4 / 12" 를 그릴 때 쓴다. */
export const WEEKLY_CRYSTAL_LIMIT = 12;

/**
 * `numeric` 문자열 → 개수.
 * 집계 결과가 없는 주(행 자체가 없음)와 구분하기 위해 `null` 은 0 으로 접지 않고
 * 호출부에서 처리한다. 여기서는 이미 존재하는 행의 컬럼만 다룬다.
 */
function toCount(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `bigint` 컬럼 → 메소.
 *
 * ★ **안전 정수 범위를 넘으면 `null`(미확인)로 접는다.** `Number` 로 조용히 반올림하면
 *   화면이 **틀린 금액을 사실인 것처럼** 말하게 된다. 도메인 규칙상 `null` 은 이미
 *   "모름"이라는 뜻을 갖고 있고 화면이 그 상태를 그릴 줄 알기 때문에, 정밀도를 잃느니
 *   모른다고 말하는 쪽이 맞다. (주간 수익은 10^9 수준이라 실제로는 도달하지 않는다.)
 */
function toSafeMeso(value: number | string | null): MesoOrUnknown {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isSafeInteger(parsed)) {
    console.warn(
      `[dashboard-repo] 메소 값이 안전 정수 범위를 벗어났습니다: ${String(value)}`,
    );
    return null;
  }
  return parsed;
}

/**
 * 그 사람의 그 주차 수익.
 *
 * **행이 없는 것은 정상이다** — 이번 주에 아무것도 클리어하지 않았다는 뜻이다.
 * 그때는 `null` 을 돌려주고 화면이 빈 상태를 그린다. 0 으로 채운 행을 지어내면
 * "0원을 벌었다"와 "아직 아무것도 없다"가 같은 화면이 된다.
 */
export async function fetchWeeklyIncome(
  userId: string,
  weekKey: WeekKey,
): Promise<WeeklyIncomeSummary | null> {
  const db = getAdminDb();

  const rows = unwrap(
    await db
      .from("v_weekly_income")
      .select(
        "week_key,crystal_income_meso,clear_count,weekly_clear_count,unknown_price_count,weekly_over_limit_count,drop_income_meso,drop_count,unsold_drop_count,total_income_meso",
      )
      .eq("user_id", userId)
      .eq("week_key", weekKey),
    "주간 수익 조회",
  );

  const row = rows[0];
  if (row === undefined) return null;

  return {
    weekKey: row.week_key ?? weekKey,
    crystalIncomeMeso: toSafeMeso(row.crystal_income_meso),
    clearCount: toCount(row.clear_count),
    weeklyClearCount: toCount(row.weekly_clear_count),
    unknownPriceCount: toCount(row.unknown_price_count),
    weeklyOverLimitCount: toCount(row.weekly_over_limit_count),
    dropIncomeMeso: toSafeMeso(row.drop_income_meso),
    dropCount: toCount(row.drop_count),
    unsoldDropCount: toCount(row.unsold_drop_count),
    totalIncomeMeso: toSafeMeso(row.total_income_meso),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 내 파티 — **내가 속한 것만.** 공개 파티 게시판이 아니다
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardParty {
  readonly partyId: PartyId;
  readonly name: string;
  readonly visibility: "private" | "link" | "public";
  readonly memberCount: number;
  /** 이번 주에 잡혀 있는 일정 수. 취소분은 빠진다. */
  readonly runCountThisWeek: number;
}

/**
 * 내가 아직 나가지 않은, 보관되지 않은 파티.
 *
 * `schedule-repo.fetchParties()` 와 **의도적으로 다르다.** 그쪽은 "볼 수 있는 것"이라
 * 남의 공개 파티까지 포함하지만, 대시보드의 "내 파티"에 남의 파티가 섞이면 목록의
 * 의미가 사라진다.
 */
export async function fetchMyParties(
  userId: string,
  weekKey: WeekKey,
): Promise<readonly DashboardParty[]> {
  const db = getAdminDb();

  const myRows = unwrap(
    await db
      .from("party_participants")
      .select("party_id")
      .eq("user_id", userId)
      .is("left_at", null),
    "내 파티 id 조회",
  );

  const partyIds = [...new Set(myRows.map((row) => row.party_id))];
  if (partyIds.length === 0) return [];

  const [partyRows, memberRows, runRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("parties")
          .select("id,name,visibility,created_at")
          .in("id", partyIds)
          .is("archived_at", null),
        "내 파티 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select("party_id")
          .in("party_id", partyIds)
          .is("left_at", null),
        "파티 구성원 수 집계",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_runs")
          .select("party_id")
          .in("party_id", partyIds)
          .eq("week_key", weekKey)
          .is("cancelled_at", null)
          .neq("status", "cancelled"),
        "이번 주 일정 수 집계",
      ))(),
  ]);

  const memberCounts = new Map<string, number>();
  for (const row of memberRows) {
    memberCounts.set(row.party_id, (memberCounts.get(row.party_id) ?? 0) + 1);
  }
  const runCounts = new Map<string, number>();
  for (const row of runRows) {
    runCounts.set(row.party_id, (runCounts.get(row.party_id) ?? 0) + 1);
  }

  return partyRows
    // 일정이 많은 파티부터. 동률이면 만든 순서라 목록이 흔들리지 않는다.
    .sort(
      (a, b) =>
        (runCounts.get(b.id) ?? 0) - (runCounts.get(a.id) ?? 0) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      partyId: row.id,
      name: row.name,
      visibility: row.visibility,
      memberCount: memberCounts.get(row.id) ?? 0,
      runCountThisWeek: runCounts.get(row.id) ?? 0,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 한 번에 모으기
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardData {
  readonly income: WeeklyIncomeSummary | null;
  readonly parties: readonly DashboardParty[];
  /**
   * 첫 화면의 주간 체크리스트 (§1.1.1) — 추적 캐릭터마다 한 섹션.
   *
   * ★ **넥슨을 부르지 않는다.** 동기화는 캐릭터당 1콜이라 대시보드 진입만으로 돌면
   *   추적 11명 기준 열 때마다 11콜이 나간다(개발 키 하루 1,000콜). 여기서는 마지막
   *   동기화 결과가 담긴 우리 DB 만 읽고, 최신화는 사용자가 버튼을 누를 때 일어난다.
   */
  readonly checklist: readonly CharacterChecklist[];
}

/** 세 조회를 병렬로. 서로 의존하지 않으므로 직렬로 둘 이유가 없다. */
export async function fetchDashboardData(
  userId: string,
  weekKey: WeekKey,
): Promise<DashboardData> {
  const [income, parties, checklist] = await Promise.all([
    fetchWeeklyIncome(userId, weekKey),
    fetchMyParties(userId, weekKey),
    fetchWeeklyChecklist(userId),
  ]);
  return { income, parties, checklist };
}
