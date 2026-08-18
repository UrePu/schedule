import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 결정석의 **범위 보정과 계정 천장** — 한 번의 조회로 둘 다 낸다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-18):
 *   1. *"일간보스는 추적 안해. 일간보스는 전부 제외"*
 *   2. *"캡경고 90개는 계정당이니까 참고해서 반영해"*
 *
 * 두 지시가 같은 행 집합(그 사람의 그 주 유효 클리어)에서 나오므로 조회를 하나로 묶는다.
 * 나누면 같은 테이블을 두 번 읽고, 두 숫자가 서로 다른 시점을 말하게 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * (1) 왜 뺄셈인가 — 수익 뷰를 다시 짜지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * `sync-scheduler` 가 일간을 **저장 전에** 버리게 됐으므로 새 일간 클리어는 더 들어오지
 * 않는다. 그러나 **이미 쌓인 일간 기록은 지우지 않는다**(지시 없음 · 되돌릴 수 없음).
 * 그 행들은 여전히 `v_weekly_crystal_income_by_character` 의 `income_meso` 에 들어 있다.
 *
 * 뷰를 고치려면 마이그레이션이 필요한데, 이 세션에서는 라이브 DB 에 적용할 수단이 없다.
 * 그래서 **뷰가 낸 값에서 일간분만 빼는** 방식을 택했다. 이 뺄셈이 정확한 이유:
 *   - 12개 절삭은 `cycle = 'weekly'` 행에만 걸린다. 일간 행은 애초에 순위를 받지 않으므로
 *     일간을 빼도 주간의 순위·절삭이 **한 칸도 움직이지 않는다.**
 *   - 즉 `일간 제외 수익 = income_meso - Σ(일간 행의 crystal_share_meso)` 가 항등식이다.
 *   - 상한 규칙(`weekly_crystal_sell_limit()`)을 TS 에 복제하지 않는다 — 그게 이 방식을
 *     고른 진짜 이유다. 직접 다시 합산했다면 12개 절삭 로직이 두 벌이 됐을 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * (2) 90개 천장은 **월드가 아니라 넥슨 계정** 단위다 (§1.3 D2, 2026-08-18 정정)
 * ─────────────────────────────────────────────────────────────────────────────
 * 기존 뷰 `v_weekly_crystal_world_usage` 는 `(world_name, week_key)` 로 묶는데 그 기준이
 * 틀렸다. **스키마를 바꾸지 않고** 질의 시점 조인으로 계정 단위를 얻는다(§2.1.2):
 *
 *   boss_clears.character_id
 *     → characters.nexon_account_ref
 *       → credential_nexon_accounts → user_credentials
 *
 * 이 조인은 이미 뷰 `v_character_sync_source` 에 통째로 들어 있다. 새 컬럼도 새 뷰도
 * 만들지 않고 그 뷰를 읽는다 — 마이그레이션 0건.
 *
 * ⚠️ **경고이지 차단이 아니다.** 90 을 넘어도 저장을 막지 않고 표시 수익을 깎지도 않는다.
 * ⚠️ **우리 집계는 과소 계상이다.** 일간이 범위 밖이라 일간 결정석이 빠져 있다. 일간을
 *    도는 사람은 우리 숫자가 예고하는 것보다 **먼저** 진짜 90 에 닿는다. 그래서 이 값을
 *    그리는 화면은 `TRACKED_SCOPE_NOTE` 를 반드시 함께 그린다 — 천장 경고가 조용히
 *    과소 보고하면 없느니만 못하다.
 */

import { ApiError } from "@/features/auth/server/http";
import { isUntrackedBossCycle } from "@/lib/domain/boss-scope";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import type { BossCycle, WeekKey } from "@/types/domain";

import type { AccountCrystalUsage } from "../types";

/** 90 에 얼마나 다가가면 경고를 켤 것인가. 넥슨 호출량 경고(0.8)와 같은 기준이다. */
export const ACCOUNT_CRYSTAL_WARN_RATIO = 0.8;

/**
 * 마지막 방어선. `world_crystal_sell_limit()` 이 단일 출처이고 여기 값은 **RPC 가 실패했을
 * 때만** 쓰인다 — 상한을 못 읽었다고 경고 자체를 끄면 그게 더 위험하기 때문이다.
 */
const ACCOUNT_CRYSTAL_LIMIT_FALLBACK = 90;

/** 집계에서 뺀 일간 결정석. **개수와 금액을 함께 들고 있어야** 뺄셈이 성립한다. */
export interface ExcludedDailyTally {
  readonly count: number;
  /** 그 일간 행들의 `crystal_share_meso` 합. 가격 미확인(null)은 여기 들어가지 않는다. */
  readonly incomeMeso: number;
  /** 그중 가격 미확인 건수. 뷰의 `unknown_price_count` 에서도 같이 빼야 한다. */
  readonly unknownPriceCount: number;
}

const EMPTY_TALLY: ExcludedDailyTally = {
  count: 0,
  incomeMeso: 0,
  unknownPriceCount: 0,
};

/** 이번 주 결정석을 "우리 범위"로 다시 재단한 결과. */
export interface WeeklyCrystalScope {
  readonly weekKey: WeekKey;
  /** 사용자 전체에서 뺀 일간분. 대시보드 요약이 쓴다. */
  readonly excludedDailyTotal: ExcludedDailyTally;
  /** 캐릭터별로 뺀 일간분. 키는 `character_id`, 캐릭터 미지정 행은 빈 문자열. */
  readonly excludedDailyByCharacter: ReadonlyMap<string, ExcludedDailyTally>;
  /** 결정이 1개 이상 잡힌 계정만. 0개인 계정을 `0/90` 으로 늘어놓지 않는다. */
  readonly accounts: readonly AccountCrystalUsage[];
  /**
   * 어느 계정에도 붙이지 못한 클리어 수 — 캐릭터가 지정되지 않았거나 그 캐릭터에
   * `nexon_account_ref` 기록이 없는 경우다. **0 이 아니면 화면이 말해야 한다**,
   * 그만큼 계정별 숫자가 더 낮게 나오기 때문이다.
   */
  readonly unassignedCount: number;
  readonly limit: number;
}

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[crystal-scope] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[crystal-scope] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/** `bigint` 는 PostgREST 가 문자열로 줄 수 있다. 안전 정수를 못 지키면 0 으로 접지 않고 버린다. */
function toMeso(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

/**
 * 상한값은 DB 함수 하나가 소유한다(`world_crystal_sell_limit()` = 90).
 *
 * ⚠️ 함수 **이름**은 여전히 `world_` 다. 이름을 고치려면 마이그레이션이 필요하고 이번
 *    작업은 스키마를 건드리지 않기로 했다. 값(90)은 정정 전후가 같고, 바뀐 것은
 *    **무엇으로 묶어 세는가**뿐이라 값의 출처를 옮길 이유가 없다. 묶는 기준은
 *    이 파일이 소유한다.
 */
async function readAccountCrystalLimit(db: AdminDb): Promise<number> {
  const result = await db.rpc("world_crystal_sell_limit");
  if (result.error !== null || typeof result.data !== "number") {
    console.warn(
      "[crystal-scope] 결정 상한 조회 실패 — 기본값으로 계속합니다.",
      result.error?.message ?? "",
    );
    return ACCOUNT_CRYSTAL_LIMIT_FALLBACK;
  }
  return result.data;
}

interface ClearRow {
  readonly character_id: string | null;
  readonly cycle: BossCycle | null;
  readonly crystal_share_meso: number | null;
}

interface CharacterAccountRow {
  readonly character_id: string | null;
  readonly character_name: string | null;
  readonly is_main: boolean | null;
  readonly nexon_account_ref: string | null;
  readonly credential_label: string | null;
}

/** 계정 하나를 만드는 동안 들고 있는 가변 상태. */
interface AccountBucket {
  weekly: number;
  monthly: number;
  readonly characters: Set<string>;
}

/** 계정 이름 후보. 키 라벨이 최우선이고, 없으면 대표 캐릭터로 부른다. */
interface AccountIdentity {
  credentialLabel: string | null;
  mainCharacterName: string | null;
  firstCharacterName: string | null;
}

function accountLabel(identity: AccountIdentity | undefined): string {
  if (identity === undefined) return "계정 미상";
  if (identity.credentialLabel !== null && identity.credentialLabel !== "") {
    return identity.credentialLabel;
  }
  const representative =
    identity.mainCharacterName ?? identity.firstCharacterName;
  return representative === null ? "넥슨 계정" : `${representative} 계정`;
}

/**
 * 그 사람의 그 주차 결정석을 한 번에 읽어 **범위 보정값과 계정 천장**을 함께 낸다.
 *
 * 왕복 3회다 — 클리어 / 캐릭터↔계정 / 상한. 캐릭터 수와 무관하게 고정이다.
 */
export async function fetchWeeklyCrystalScope(
  userId: string,
  weekKey: WeekKey,
  db: AdminDb = getAdminDb(),
): Promise<WeeklyCrystalScope> {
  const [clearRows, characterRows, limit] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("boss_clears")
          .select("character_id,cycle,crystal_share_meso")
          .eq("user_id", userId)
          .eq("week_key", weekKey)
          // 집계에 실제로 반영된 것만. 수익 뷰의 모집단과 같아야 뺄셈이 성립한다.
          .eq("effective_cleared", true),
        "이번 주 결정석 원장 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("v_character_sync_source")
          .select(
            "character_id,character_name,is_main,nexon_account_ref,credential_label",
          )
          .eq("user_id", userId),
        "캐릭터 ↔ 넥슨 계정 조회",
      ))(),
    readAccountCrystalLimit(db),
  ]);

  // ── 캐릭터 → 계정 ─────────────────────────────────────────────────────────
  const accountByCharacter = new Map<string, string>();
  const identities = new Map<string, AccountIdentity>();
  for (const row of characterRows as readonly CharacterAccountRow[]) {
    if (row.character_id === null || row.nexon_account_ref === null) continue;
    accountByCharacter.set(row.character_id, row.nexon_account_ref);

    const identity = identities.get(row.nexon_account_ref) ?? {
      credentialLabel: null,
      mainCharacterName: null,
      firstCharacterName: null,
    };
    if (identity.credentialLabel === null) {
      identity.credentialLabel = row.credential_label;
    }
    if (row.character_name !== null) {
      if (row.is_main === true && identity.mainCharacterName === null) {
        identity.mainCharacterName = row.character_name;
      }
      if (
        identity.firstCharacterName === null ||
        row.character_name < identity.firstCharacterName
      ) {
        identity.firstCharacterName = row.character_name;
      }
    }
    identities.set(row.nexon_account_ref, identity);
  }

  // ── 한 번의 순회로 (a) 일간 뺄셈 (b) 계정별 천장 을 동시에 만든다 ─────────
  const byCharacter = new Map<string, ExcludedDailyTally>();
  let totalCount = 0;
  let totalIncome = 0;
  let totalUnknown = 0;

  const buckets = new Map<string | null, AccountBucket>();
  let unassignedCount = 0;

  for (const row of clearRows as readonly ClearRow[]) {
    const share = toMeso(row.crystal_share_meso);

    if (isUntrackedBossCycle(row.cycle)) {
      // (a) 범위 밖 — 수익·건수에서 뺄 몫으로 모은다. 원장에서 지우지는 않는다.
      const key = row.character_id ?? "";
      const previous = byCharacter.get(key) ?? EMPTY_TALLY;
      byCharacter.set(key, {
        count: previous.count + 1,
        incomeMeso: previous.incomeMeso + (share ?? 0),
        unknownPriceCount: previous.unknownPriceCount + (share === null ? 1 : 0),
      });
      totalCount += 1;
      totalIncome += share ?? 0;
      if (share === null) totalUnknown += 1;
      continue;
    }

    // (b) 범위 안 — 90개 천장은 이 행들만 센다(= 실제보다 낮다).
    const accountRef =
      row.character_id === null
        ? null
        : (accountByCharacter.get(row.character_id) ?? null);
    if (accountRef === null) {
      unassignedCount += 1;
      continue;
    }

    const bucket = buckets.get(accountRef) ?? {
      weekly: 0,
      monthly: 0,
      characters: new Set<string>(),
    };
    if (row.cycle === "monthly") bucket.monthly += 1;
    else bucket.weekly += 1;
    if (row.character_id !== null) bucket.characters.add(row.character_id);
    buckets.set(accountRef, bucket);
  }

  const accounts: AccountCrystalUsage[] = [];
  for (const [accountRef, bucket] of buckets) {
    const crystalCount = bucket.weekly + bucket.monthly;
    accounts.push({
      accountRef,
      label: accountLabel(
        accountRef === null ? undefined : identities.get(accountRef),
      ),
      crystalCount,
      weeklyCount: bucket.weekly,
      monthlyCount: bucket.monthly,
      characterCount: bucket.characters.size,
      limit,
      remaining: Math.max(limit - crystalCount, 0),
      overLimit: crystalCount > limit,
      nearLimit: crystalCount >= limit * ACCOUNT_CRYSTAL_WARN_RATIO,
    });
  }

  // 많이 쓴 계정이 위로. 동률이면 이름으로 안정 정렬한다.
  accounts.sort(
    (a, b) =>
      b.crystalCount - a.crystalCount ||
      a.label.localeCompare(b.label, "ko-KR"),
  );

  return {
    weekKey,
    excludedDailyTotal: {
      count: totalCount,
      incomeMeso: totalIncome,
      unknownPriceCount: totalUnknown,
    },
    excludedDailyByCharacter: byCharacter,
    accounts,
    unassignedCount,
    limit,
  };
}

/** 캐릭터 하나에서 뺄 일간분. 행이 없으면 뺄 것이 없다는 뜻이다. */
export function excludedDailyFor(
  scope: WeeklyCrystalScope,
  characterId: string | null,
): ExcludedDailyTally {
  return scope.excludedDailyByCharacter.get(characterId ?? "") ?? EMPTY_TALLY;
}

/**
 * 뷰가 낸 금액에서 일간분을 뺀다.
 *
 * `null`(집계 불가 · 미확인)은 **그대로 `null`** 이다 — 모르는 값에서 뺄셈을 하면
 * 모른다는 사실이 조용히 숫자로 바뀐다. 음수로 내려가는 것도 막는다(원장과 뷰가
 * 어긋난 순간에도 화면이 마이너스 메소를 말하면 안 된다).
 */
export function subtractDailyMeso(
  value: number | null,
  excluded: ExcludedDailyTally,
): number | null {
  if (value === null) return null;
  return Math.max(value - excluded.incomeMeso, 0);
}
