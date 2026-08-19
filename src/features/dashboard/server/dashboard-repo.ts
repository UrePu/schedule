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
 * ⚠️ **딱 하나의 예외: 일간 뺄셈.** 일간 보스가 범위 밖이 되면서(2026-08-18 발주자 지시)
 *    뷰가 일간까지 합산한 값을 그대로 쓸 수 없게 됐다. 이미 쌓인 일간 클리어는 지우지
 *    않으므로 읽는 쪽에서 뺀다. 뺄셈의 근거와 정확성은
 *    `@/features/income/server/crystal-scope` 머리말에 있고, 이 파일은 그 함수를 **부르기만**
 *    한다 — 12개 절삭 규칙은 여전히 뷰가 소유한다.
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
import {
  fetchWeeklyCrystalScope,
  subtractDailyMeso,
  type WeeklyCrystalScope,
} from "@/features/income/server/crystal-scope";
import {
  buildCrystalIncomeSummary,
  fetchCrystalPotential,
} from "@/features/income/server/crystal-summary";
import type { CrystalIncomeSummary } from "@/features/income/types";
import type { MesoOrUnknown, PartyId, WeekKey } from "@/types/domain";

import {
  buildWeeklyBossCapacity,
  type WeeklyBossCapacity,
  type WeeklyBossClearRow,
} from "../lib/weekly-boss-capacity";

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
  /** 이번 주 클리어 수. **주간+월간만** — 일간은 범위 밖이다(2026-08-18). */
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

  /*
   * ── 주기 분리 (마이그레이션 27 · 2026-08-19 발주자: *"주간 월간은 따로놔야지"*) ──
   * **12개 상한은 주간에만 걸린다.** 예전 카드는 `주간 보스 40 / 84건` 옆에
   * `주간+월간 41건` 을 놓았는데 그 41 은 84칸과 아무 관계가 없다 — 분모가 뜻을 잃는다.
   * 아래 값은 전부 뷰가 갈라 준 것이고 **우리가 빼거나 더하지 않는다.**
   * 일간은 애초에 이 컬럼들에 들어가 있지 않다(주기별로 갈렸으니 뺄셈 자체가 불필요하다).
   */
  readonly monthlyClearCount: number;
  readonly weeklyCrystalIncomeMeso: MesoOrUnknown;
  readonly monthlyCrystalIncomeMeso: MesoOrUnknown;
  readonly weeklyUnknownPriceCount: number;
  readonly monthlyUnknownPriceCount: number;
}

/*
 * ⚠️ 여기 있던 `export const WEEKLY_CRYSTAL_LIMIT = 12` 는 **삭제했다.**
 *
 * 두 가지가 동시에 틀려 있었다.
 *   1. 12를 TS 에 박은 상수라 DB 의 단일 출처(`weekly_crystal_sell_limit()`)와 갈라질 수
 *      있었다. 상한은 뷰가 `weekly_sell_limit` 컬럼으로 실어 준다.
 *   2. 주석이 *화면이 "4 / 12" 를 그릴 때 쓴다* 라고 적고 있었는데, 그 전제는 캐릭터가
 *      **한 명일 때만** 성립한다. 12개 상한은 캐릭터당이라(§1) 여러 캐릭터를 합산한
 *      분자에 이 상수를 분모로 붙이면 화면이 실제로 `주간 보스 40 / 12건` 을 그린다
 *      — 2026-08-18 에 그 화면이 그대로 발주자에게 나갔다.
 *
 * 대체 경로는 `../lib/weekly-boss-capacity` 다. 분모는 언제나
 * `추적 캐릭터 수 × 캐릭터당 상한` 이고, 상한 값 자체는 DB 에서 온다.
 */

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
 * 그 사람의 그 주차 수익 — **일간을 뺀 값**.
 *
 * **행이 없는 것은 정상이다** — 이번 주에 아무것도 클리어하지 않았다는 뜻이다.
 * 그때는 `null` 을 돌려주고 화면이 빈 상태를 그린다. 0 으로 채운 행을 지어내면
 * "0원을 벌었다"와 "아직 아무것도 없다"가 같은 화면이 된다.
 *
 * ★ 일간만 클리어한 주도 **같은 빈 상태**로 접는다. 일간을 빼고 나면 우리가 말할 수 있는
 *   것이 하나도 남지 않는데, 거기서 `0 메소`를 찍으면 "아무것도 못 벌었다"는 거짓 주장이
 *   된다. 드랍이 하나라도 있으면 물론 남긴다.
 *
 * ★ `scope` 를 넘기면 그 조회 결과를 재사용한다. 수익 상세 화면은 계정 천장 때문에
 *   어차피 같은 원장을 읽으므로, 같은 주차를 두 번 읽지 않게 하려는 것이다.
 *
 * ★ **`scope` 는 프라미스여도 된다** (2026-08-18 성능 작업). 이게 중요한 이유:
 *   호출부가 `scopePromise.then((s) => fetchWeeklyIncome(…, s))` 로 넘기면 **뷰 조회가
 *   scope 를 기다린 뒤에야 출발한다.** 둘은 서로 아무 관계가 없는데도 왕복 1단이 통째로
 *   직렬화되던 자리다(원격 왕복 1회 ≈ 78ms). 프라미스를 그대로 받으면 아래 `Promise.all`
 *   이 둘을 **동시에** 굴리고, 뺄셈은 둘 다 도착한 뒤에 한다 — 결과는 한 글자도 다르지 않다.
 */
export async function fetchWeeklyIncome(
  userId: string,
  weekKey: WeekKey,
  scope?: WeeklyCrystalScope | Promise<WeeklyCrystalScope>,
): Promise<WeeklyIncomeSummary | null> {
  const db = getAdminDb();

  const [rows, resolvedScope] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("v_weekly_income")
          .select(
            "week_key,crystal_income_meso,clear_count,weekly_clear_count,unknown_price_count,weekly_over_limit_count,drop_income_meso,drop_count,unsold_drop_count,total_income_meso,monthly_clear_count,weekly_crystal_income_meso,monthly_crystal_income_meso,weekly_unknown_price_count,monthly_unknown_price_count",
          )
          .eq("user_id", userId)
          .eq("week_key", weekKey),
        "주간 수익 조회",
      ))(),
    scope === undefined
      ? fetchWeeklyCrystalScope(userId, weekKey, db)
      : Promise.resolve(scope),
  ]);

  const row = rows[0];
  if (row === undefined) return null;

  // ★ 일간분을 뺀다. 12개 절삭은 주간 행에만 걸리므로 이 뺄셈이 순위를 흔들지 않는다.
  const excluded = resolvedScope.excludedDailyTotal;
  const clearCount = Math.max(toCount(row.clear_count) - excluded.count, 0);
  const dropCount = toCount(row.drop_count);
  const unsoldDropCount = toCount(row.unsold_drop_count);

  if (clearCount === 0 && dropCount === 0 && unsoldDropCount === 0) return null;

  return {
    weekKey: row.week_key ?? weekKey,
    crystalIncomeMeso: subtractDailyMeso(
      toSafeMeso(row.crystal_income_meso),
      excluded,
    ),
    clearCount,
    // 주간 카운트는 손대지 않는다 — 일간은 애초에 이 숫자에 들어간 적이 없다.
    weeklyClearCount: toCount(row.weekly_clear_count),
    unknownPriceCount: Math.max(
      toCount(row.unknown_price_count) - excluded.unknownPriceCount,
      0,
    ),
    weeklyOverLimitCount: toCount(row.weekly_over_limit_count),
    dropIncomeMeso: toSafeMeso(row.drop_income_meso),
    dropCount,
    unsoldDropCount,
    totalIncomeMeso: subtractDailyMeso(
      toSafeMeso(row.total_income_meso),
      excluded,
    ),
    /*
      주기별 값은 **뺄셈을 거치지 않는다.** 뷰가 주기로 갈라 준 컬럼이라 일간이 애초에
      들어 있지 않다(마이그레이션 27). 위 `crystalIncomeMeso` 의 뺄셈 결과와 아래 두
      값의 합이 같아야 하며, 그 검산은 `buildCrystalIncomeSummary()` 가 한다.
    */
    monthlyClearCount: toCount(row.monthly_clear_count),
    weeklyCrystalIncomeMeso: toSafeMeso(row.weekly_crystal_income_meso),
    monthlyCrystalIncomeMeso: toSafeMeso(row.monthly_crystal_income_meso),
    weeklyUnknownPriceCount: toCount(row.weekly_unknown_price_count),
    monthlyUnknownPriceCount: toCount(row.monthly_unknown_price_count),
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

  /*
   * ★ **직렬 2단 → 1단** (2026-08-18 성능 작업. `schedule-repo.fetchParties()` 와
   *   **같은 결의 문제**라 같이 고쳤다 — §0.2-1).
   *   예전에는 `내 파티 id → (파티 ∥ 구성원 ∥ 이번 주 일정)` 이었다. 뒤 셋은 앞의
   *   결과를 **필터로만** 썼고 전부 `parties` 에서 뻗어 나가는 같은 관계라, PostgREST
   *   임베딩 하나로 합쳐진다. 이 함수는 `/` 대시보드와 `/boss-plans` 가 **둘 다** 부른다.
   *
   *   · `me:…!inner`  = 내가 아직 안 나간 파티만 남긴다(조인 필터).
   *   · `members:…`   = 인원수. `me` 와 별칭이 달라 `user_id` 필터가 새지 않는다.
   *   · `runs:…`      = 이번 주 일정 수. **`!inner` 가 아니다** — 일정이 0건인 파티도
   *                     목록에 있어야 한다(있었고, 지금도 그렇다).
   *
   *   ⚠️ 각 필터는 **자기 별칭**으로 건다. `runs.week_key` 를 `week_key` 로 쓰면
   *      `parties` 에 없는 컬럼이라 요청 자체가 실패한다.
   */
  const rows = unwrap(
    await db
      .from("parties")
      .select(
        "id,name,visibility,created_at,me:party_participants!inner(user_id),members:party_participants(id),runs:party_runs(id)",
      )
      .eq("me.user_id", userId)
      .is("me.left_at", null)
      .is("members.left_at", null)
      .eq("runs.week_key", weekKey)
      .is("runs.cancelled_at", null)
      .neq("runs.status", "cancelled")
      .is("archived_at", null),
    "내 파티 조회",
  );

  const runCountOf = (row: (typeof rows)[number]): number =>
    Array.isArray(row.runs) ? row.runs.length : 0;

  return [...rows]
    // 일정이 많은 파티부터. 동률이면 만든 순서라 목록이 흔들리지 않는다.
    .sort(
      (a, b) =>
        runCountOf(b) - runCountOf(a) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      partyId: row.id,
      name: row.name,
      visibility: row.visibility,
      memberCount: Array.isArray(row.members) ? row.members.length : 0,
      runCountThisWeek: runCountOf(row),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 주간 보스 칸 — 캐릭터별 클리어 수 + 캐릭터당 상한을 **뷰에서 그대로** 읽는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **한 줄 리터럴이어야 한다.** supabase-js 가 select 문자열을 타입 수준에서 파싱해
 *   행 모양을 만들기 때문에, 이어 붙이면 타입이 `string` 으로 뭉개져 컬럼 오타가
 *   런타임까지 살아남는다.
 */
const WEEKLY_BOSS_BY_CHARACTER_COLUMNS =
  "character_id,weekly_clear_count,weekly_sell_limit";

/**
 * 캐릭터별 이번 주 주간 보스 클리어 수. ← `v_weekly_crystal_income_by_character`
 *
 * ★ **체크리스트로 대신할 수 없다.** 계획 뷰(`v_character_weekly_boss_progress`)는
 *   *켜져 있는 계획에 매칭된* 클리어만 세서 같은 주에 36을 내는데, 결정석 원장은 40을
 *   낸다(2026-08-18 실측). 12칸을 소진하는 것은 계획 여부와 무관한 클리어이므로
 *   원장 쪽이 옳고, 덕분에 수익 카드의 `주간 보스` 카운터와 숫자가 갈라질 수 없다.
 *   근거 전문은 `../lib/weekly-boss-capacity` 머리말에 있다.
 * ★ 상한(`weekly_sell_limit`)도 같은 행에서 온다 — 12를 코드에 박지 않기 위해서다.
 * ★ 행이 없는 캐릭터는 **정상**이다(이번 주 클리어 0). 0 행으로 지어내지 않고,
 *   추적 명단에 있으면 칸 계산 쪽에서 `클리어 0` 으로 채워진다.
 */
async function fetchWeeklyBossClearsByCharacter(
  userId: string,
  weekKey: WeekKey,
): Promise<readonly WeeklyBossClearRow[]> {
  const db = getAdminDb();
  const rows = unwrap(
    await db
      .from("v_weekly_crystal_income_by_character")
      .select(WEEKLY_BOSS_BY_CHARACTER_COLUMNS)
      .eq("user_id", userId)
      .eq("week_key", weekKey),
    "캐릭터별 주간 보스 클리어 조회",
  );

  const result: WeeklyBossClearRow[] = [];
  for (const row of rows) {
    // 캐릭터가 지정되지 않은 클리어는 어느 캐릭터의 12칸도 먹지 않는다 — 버린다.
    if (row.character_id === null) continue;
    result.push({
      characterId: row.character_id,
      weeklyClearCount: toCount(row.weekly_clear_count),
      weeklySellLimit: row.weekly_sell_limit,
    });
  }
  return result;
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
  /**
   * 이번 주 주간 보스 칸 — **분모는 `추적 캐릭터 수 × 캐릭터당 상한`** 이다.
   *
   * ⚠️ 여기 있던 `accountCrystalUsage` / `unassignedCrystalCount`(90개 계정 천장,
   *    §1.3 D2)는 **대시보드에서 뺐다** (발주자 지시, 2026-08-18:
   *    *"천장90개로 하지말고 현재 선택된 캐릭터 갯수 위주로 몇개 보스 돌아야하는지"*).
   *    기능이 사라진 것이 아니라 자리를 옮겼을 뿐이다 — `AccountCrystalCapCard` 는
   *    수익 화면(`/income`)에 그대로 있고 그쪽은 `income-repo` 가 따로 읽는다.
   *    D2 자체는 문서에 살아 있으며, 대시보드가 앞세우는 값이 아닐 뿐이다.
   */
  readonly weeklyBossCapacity: WeeklyBossCapacity;
  /**
   * 결정석 수익 카드 한 장 — **`/income` 상단 요약과 글자 하나까지 같은 값**이다.
   *
   * 조립은 `@/features/income/server/crystal-summary` 한 곳뿐이고, 그리는 것도 컴포넌트
   * 하나(`CrystalIncomeSummaryPanel`)다. 계산이 두 벌이면 두 화면이 다른 숫자를 말한다 —
   * 이 저장소에서 이미 두 번 일어난 사고다.
   *
   * `null` 이면 이번 주 집계도 계획 최대치도 없다는 뜻이며 카드가 빈 상태를 그린다.
   */
  readonly crystalSummary: CrystalIncomeSummary | null;
}

/**
 * 조회를 병렬로. 서로 의존하지 않으므로 직렬로 둘 이유가 없다.
 *
 * `scope` 를 먼저 띄워 두고 `fetchWeeklyIncome` 에 넘긴다 — 같은 원장을 두 번 읽지
 * 않으면서도 나머지 조회와 함께 출발한다.
 */
export async function fetchDashboardData(
  userId: string,
  weekKey: WeekKey,
): Promise<DashboardData> {
  const scopePromise = fetchWeeklyCrystalScope(userId, weekKey);
  const [income, parties, checklist, weeklyBossRows, potential] = await Promise.all([
    /*
      ★ **프라미스를 그대로 넘긴다** (2026-08-18 성능 작업). 예전에는 `.then()` 안에서
        불러서 `v_weekly_income` 조회가 scope 를 기다린 뒤에야 출발했다 — 서로 남인
        두 조회가 직렬 2단이 되던 자리다. 지금은 함께 출발한다.
    */
    fetchWeeklyIncome(userId, weekKey, scopePromise),
    fetchMyParties(userId, weekKey),
    fetchWeeklyChecklist(userId),
    fetchWeeklyBossClearsByCharacter(userId, weekKey),
    /*
      이론상 최대치. 다른 조회와 서로 의존하지 않으므로 같은 단에 올린다 —
      계획 뷰 한 번이고 캐릭터 수와 무관하게 왕복 1회다. **넥슨 호출 0건.**
    */
    fetchCrystalPotential(userId),
  ]);

  const weeklyBossCapacity = buildWeeklyBossCapacity(checklist, weeklyBossRows);

  return {
    income,
    parties,
    checklist,
    /*
     * 곱셈 하나가 이 파일을 지나가지만 계산 자체는 `../lib/weekly-boss-capacity` 가
     * 갖고 있다. 이 파일의 규칙(수익을 여기서 계산하지 않는다)은 그대로다 —
     * 금액·12개 절삭은 여전히 뷰의 소유이고, 여기서 합쳐지는 것은 **추적 명단**과
     * **뷰가 이미 센 캐릭터별 건수**뿐이다.
     */
    weeklyBossCapacity,
    /*
     * ★ 카드 조립은 **income 기능이 소유한다**(`crystal-summary.ts`). 대시보드가 자기
     *   버전을 만들면 `/income` 상단 요약과 갈라지고, 그게 발주자가 두 번 지적한 그 증상이다.
     *   `weeklyBossCapacity` 는 `WeeklyBossSlots` 의 네 필드를 그대로 갖고 있어 구조적으로
     *   들어맞는다 — 분모(`추적 캐릭터 수 × 캐릭터당 상한`)의 정의가 한 곳뿐이다.
     */
    crystalSummary: buildCrystalIncomeSummary(
      weekKey,
      income,
      potential,
      weeklyBossCapacity,
    ),
  };
}
