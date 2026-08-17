import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨 인게임 스케줄러 → 우리 저장소 동기화 (**캐릭터당 정확히 1콜**)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 실측(§1.1.1, 2026-08-17)에서 한 캐릭터의 응답이 이렇게 나왔다:
 *   `boss_contents` 77건 · `registration_flag=true` 12건 · `complete_flag=true` 10건
 *   `weekly_boss_clear_count / limit = 10 / 12`
 * 즉 **계획과 진행을 둘 다 넥슨이 준다.** 사용자가 목록을 손으로 만들 필요가 없고,
 * 계획 화면은 이 결과를 **보정**하는 곳이다.
 *
 * ── 세 갈래로 흘려보낸다 ─────────────────────────────────────────────────────
 *   registration_flag → `sync_character_boss_plan()`  → `character_boss_plans.api_*`
 *   complete_flag     → `boss_clears.api_cleared`     → 뷰의 `is_cleared`
 *   응답 전체 + 카운트 → `character_scheduler_snapshots` (`보스 10/12` 의 출처)
 *
 * ── 수동 편집을 절대 덮어쓰지 않는다 ─────────────────────────────────────────
 * `sync_character_boss_plan()` 은 `api_*` 컬럼만 만지도록 **함수 시그니처 차원에서**
 * 막혀 있다(난제 16-2). 이 파일은 `manual_active` / `manual_set_at` 을 한 번도 언급하지
 * 않으며, `boss_clears` 쪽도 `api_cleared` / `api_observed_at` 두 컬럼만 쓴다.
 * 승자 판정은 트리거의 몫이고 우리는 관측값만 넣는다.
 *
 * ── 매핑을 다시 구현하지 않는다 ──────────────────────────────────────────────
 * `content_name`(한글) × `difficulty` → `boss_difficulties.id` 변환은
 * `public.nexon_resolve_boss_difficulty()` 하나뿐이다. 실패하면 null 을 돌려주면서
 * `nexon_unmapped_contents` 에 **스스로 기록**하므로, 미매핑이 있어도 동기화는 깨지지 않는다.
 * 우리는 null 을 세기만 한다.
 *
 * ── 호출자는 둘, 폴링은 없다 ────────────────────────────────────────────────
 * 대시보드 **진입 시 자동 1회**와 **수동 새로고침 버튼**이다(§1.1.1). 주기적으로 도는
 * 폴링은 없다. 캐릭터당 1콜 · 개발 키 하루 1,000콜이므로 자동 경로는 클라이언트에서
 * **신선도 가드**(마지막 호출이 15분 지연 창 안이면 건너뜀)를 통과한 캐릭터만 보낸다 —
 * `features/boss-plans/lib/scheduler-freshness.ts`.
 *
 * ⚠️ **이 함수 자체에는 신선도 가드가 없다.** 수동 버튼이 가드를 우회해야 하기 때문이며,
 *    그것이 의도다. 서버 측 방어선은 두 겹으로 남아 있다: 15분 응답 캐시
 *    (`lib/nexon/cache.ts`)와 429 이후 60초 쿨다운(`NEXON_RATE_LIMIT_COOLDOWN_MS`).
 * 대상은 언제나 `is_tracked` 캐릭터로 제한된다.
 */

import { ApiError } from "@/features/auth/server/http";
import {
  assertOwnedOcid,
  type NexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import { fetchSchedulerCharacterState } from "@/lib/nexon/client";
import { readQuotaSnapshot } from "@/lib/nexon/quota";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { getWeekKey } from "@/lib/time/week";
import type { NexonBossEntry, NexonSchedulerStateResult } from "@/lib/nexon/types";

import type { SyncResult } from "../types";

/**
 * `character_scheduler_snapshots.payload` 에 넣는 모양.
 *
 * ★ **원문이 아니라 정규화된 형태를 저장한다.** 넥슨 플래그는 문자열 `"true"`/`"false"`
 *   이고(§1.0) `"false"` 는 JS 에서 참이다. 원문을 저장하면 읽는 쪽마다 파싱을 다시 해야
 *   하고, 한 곳만 빠뜨리면 안 깬 보스가 전부 깬 것으로 집계된다. 접기는
 *   `lib/nexon/client.ts` 경계에서 이미 끝났으므로 **그 결과**를 저장한다.
 *   버전 키를 함께 넣어 나중에 형태가 바뀌어도 읽는 쪽이 구분할 수 있게 한다.
 */
const SNAPSHOT_PAYLOAD_SCHEMA = "normalized_v1";

/**
 * Supabase 왕복의 동시 실행 폭.
 *
 * 77건을 순차로 돌리면 왕복만 수 초가 되고, 전부 동시에 던지면 커넥션 풀을 밀어낸다.
 * 8은 "버튼 한 번에 1초 안쪽"과 "풀을 흔들지 않음"이 함께 성립하는 지점이다.
 * ⚠️ 이건 **Supabase** 동시성이지 넥슨이 아니다. 넥슨 호출은 이 파일 전체에서 **1건**이다.
 */
const DB_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

interface SyncTargetCharacter {
  readonly id: string;
  readonly name: string;
  readonly ocid: string;
  /** 이 캐릭터가 속한 넥슨 계정. `null` 이면 출처 기록이 없는 옛 행이다. */
  readonly nexonAccountRef: string | null;
}

/**
 * 동기화 대상 확인 — **내 캐릭터이고 추적 중이며 ocid 가 있어야** 한다.
 *
 * `ocid` 가 없으면 넥슨을 부를 열쇠가 없다. 이건 오류가 아니라 "아직 목록을 안 받았다"에
 * 가깝지만, 동기화라는 행위 자체가 성립하지 않으므로 400 으로 알린다.
 */
async function requireSyncTarget(
  db: AdminDb,
  userId: string,
  characterId: string,
): Promise<SyncTargetCharacter> {
  const { data, error } = await db
    .from("characters")
    .select("id, character_name, ocid, is_tracked, nexon_account_ref")
    .eq("id", characterId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error !== null) {
    console.error(`[sync-scheduler] 캐릭터 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  if (data === null) {
    throw ApiError.badRequest(
      "내 캐릭터가 아닙니다. 캐릭터 목록을 새로 불러와 주세요.",
    );
  }
  if (!data.is_tracked) {
    // §2.1.1 — 추적하지 않는 캐릭터를 동기화하면 고르지 않은 캐릭터에 예산이 나간다.
    throw ApiError.badRequest(
      "추적 중인 캐릭터만 동기화할 수 있습니다. 캐릭터 선택에서 먼저 추가해 주세요.",
    );
  }
  if (data.ocid === null || data.ocid === "") {
    throw ApiError.badRequest(
      "이 캐릭터의 넥슨 식별자(ocid)가 없어 동기화할 수 없습니다. 캐릭터 목록을 새로 불러와 주세요.",
    );
  }

  return {
    id: data.id,
    name: data.character_name,
    ocid: data.ocid,
    nexonAccountRef: data.nexon_account_ref,
  };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보낸 키가 **이 캐릭터의 계정 키인가** — 넥슨을 부르기 전에 끊는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 넥슨 키는 그 키를 발급한 계정의 캐릭터만 읽는다(§1.1). 다른 계정의 캐릭터를 넣으면
 * `OPENAPI00004` 로 거절되는데(§1.0 실측 — "남의 계정 ocid"), **그 거절은 우리 호출량을
 * 이미 태운 뒤에 온다.** 실계정에서 넥슨 계정 3개 중 2개의 캐릭터가 진입할 때마다 이
 * 실패를 반복했고, 화면에는 "캐릭터명이나 조회 날짜를 확인해 주세요"라는 **사실이 아닌**
 * 안내가 떴다. 원인은 캐릭터명도 날짜도 아니고 **키가 그 계정 것이 아니라는 것**이었다.
 *
 * 판정은 링크 테이블 하나를 보면 끝난다:
 *   `characters.nexon_account_ref` ↔ `credential_nexon_accounts.(credential_id, …)`
 * `assertOwnedOcid` 와 겹치지 않는다 — 그쪽은 "내 캐릭터인가", 여기는 "이 키로 읽히는
 * 캐릭터인가"다. 같은 사용자 안에서도 계정이 다르면 후자는 거짓이 된다.
 */
async function assertCredentialCoversCharacter(
  context: NexonProxyContext,
  character: SyncTargetCharacter,
): Promise<void> {
  if (character.nexonAccountRef === null) {
    /*
     * 출처 기록이 없으면 **어느 키를 써야 하는지 알 수 없다.** 아무 키나 보내면 거절과
     * 함께 호출량만 나가므로 여기서 끊는다. 복구 경로는 키 재확인(= `/character/list`
     * 재동기화)이며, 그 과정에서 `nexon_account_ref` 가 다시 채워진다.
     */
    throw ApiError.credentialMismatch(
      `${character.name} 이(가) 어느 넥슨 계정에서 왔는지 기록이 없어 어떤 키로 불러야 할지 알 수 없습니다. 계정 · 키 관리에서 키를 다시 입력하면 연결이 복구됩니다.`,
    );
  }

  const { data, error } = await context.db
    .from("credential_nexon_accounts")
    .select("id")
    .eq("credential_id", context.credentialId)
    .eq("nexon_account_ref", character.nexonAccountRef)
    .maybeSingle();

  if (error !== null) {
    console.error(
      `[sync-scheduler] 자격증명 ↔ 계정 링크 조회 실패: ${error.message}`,
    );
    throw ApiError.internal();
  }

  if (data === null) {
    throw ApiError.credentialMismatch(
      `${character.name} 은(는) 다른 넥슨 계정의 캐릭터라 지금 보낸 키로는 불러올 수 없습니다. 계정 · 키 관리에서 그 계정의 API 키를 입력해 주세요.`,
    );
  }
}

/**
 * 넥슨 응답이 말하는 **데이터 기준 시각**.
 *
 * ★ 호출 시각이 아니다. 넥슨 데이터는 ~15분 지연되므로 호출 시각으로 다루면 API 가
 *   언제나 최신인 척하게 되고, `boss_clears` 의 최신성 규칙(난제 6)이 사람의 수동 체크를
 *   부당하게 이긴다. 실측 값은 `"2026-08-17T00:00+09:00"` 형태다.
 */
function resolveObservedAt(result: NexonSchedulerStateResult): Date {
  if (result.date !== null) {
    const parsed = new Date(result.date);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** 매핑에 성공한 보스 1건. */
interface ResolvedEntry {
  readonly entry: NexonBossEntry;
  readonly bossDifficultyId: string;
}

/**
 * 캐릭터 하나를 동기화한다.
 *
 * @returns 반영 건수와 **실제로 소비한 넥슨 호출 수**. 캐시(15분)에 맞으면 0 이다 —
 *   게이트웨이가 캐시 적중을 장부에 적지 않으므로 그 사실이 숫자에 그대로 드러난다.
 */
export async function syncCharacterScheduler(
  context: NexonProxyContext,
  characterId: string,
): Promise<SyncResult> {
  const db = context.db;
  const character = await requireSyncTarget(db, context.userId, characterId);

  // 넥슨도 남의 ocid 를 거절하지만 **그 거절은 우리 호출량을 태운 뒤에 온다.**
  await assertOwnedOcid(context, character.ocid);

  /*
   * ★ 한 겹 더. `assertOwnedOcid` 는 "내 캐릭터인가"만 본다. 한 사람이 넥슨 계정을
   *   여러 개 쓰므로(§2.1) **내 캐릭터인데도 이 키로는 못 읽는** 경우가 정상적으로
   *   존재하고, 그것이 이번 결함의 정체였다.
   */
  await assertCredentialCoversCharacter(context, character);

  // 장부 대조용 사전 스냅샷. 호출 수를 추정하지 않고 **차이로 측정**한다.
  const before = await readQuotaSnapshot(db, context.credentialId);

  // ★ 이 파일에서 넥슨으로 나가는 **유일한** 호출이다.
  const state = await fetchSchedulerCharacterState(
    context.apiKey,
    character.ocid,
    undefined,
    context.gateway,
  );

  const after = await readQuotaSnapshot(db, context.credentialId);
  const nexonCallsUsed = Math.max(after.callCount - before.callCount, 0);

  const observedAt = resolveObservedAt(state);
  const observedAtIso = observedAt.toISOString();

  // ── 1. 응답 미러 ───────────────────────────────────────────────────────────
  // `보스 10/12` 는 우리가 세지 않는다. 게임이 세 준 값을 그대로 보관하고 그대로 보여 준다.
  const { error: snapshotError } = await db
    .from("character_scheduler_snapshots")
    .upsert(
      {
        character_id: character.id,
        snapshot_at: observedAtIso,
        fetched_at: new Date().toISOString(),
        weekly_boss_clear_count: state.weeklyBossClearCount,
        weekly_boss_clear_limit_count: state.weeklyBossClearLimitCount,
        /*
         * `readonly` 배열·속성은 `Json` 에 그대로 못 들어간다(가변 타입 요구). 얕은 복사로
         * 가변 사본을 만든다 — 값 자체는 문자열·숫자·불리언뿐이라 손실이 없다.
         */
        payload: {
          schema: SNAPSHOT_PAYLOAD_SCHEMA,
          bosses: state.bosses.map((entry) => ({ ...entry })),
          dailyContents: state.dailyContents.map((entry) => ({ ...entry })),
          weeklyContents: state.weeklyContents.map((entry) => ({ ...entry })),
        },
        // 빈 응답은 "그날 접속하지 않았다"이며 **에러가 아니다**(§1.1).
        is_empty: state.bosses.length === 0,
      },
      { onConflict: "character_id,snapshot_at" },
    );
  if (snapshotError !== null) {
    console.error(
      `[sync-scheduler] 스냅샷 저장 실패: ${snapshotError.message}`,
    );
    throw ApiError.internal();
  }

  // ── 2. 매핑 ────────────────────────────────────────────────────────────────
  // 변환은 `nexon_resolve_boss_difficulty()` 하나뿐이다. 실패하면 null 을 주면서
  // `nexon_unmapped_contents` 에 스스로 기록하므로, 여기서는 null 을 세기만 한다.
  const mappable = state.bosses.filter(
    (entry) => entry.contentName !== null && entry.rawDifficulty !== null,
  );

  const resolved = await mapWithConcurrency(
    mappable,
    DB_CONCURRENCY,
    async (entry): Promise<ResolvedEntry | null> => {
      const result = await db.rpc("nexon_resolve_boss_difficulty", {
        p_content_name: entry.contentName ?? "",
        p_difficulty: entry.rawDifficulty ?? "",
        ...(entry.rawCycle !== null ? { p_cycle: entry.rawCycle } : {}),
      });
      if (result.error !== null) {
        // 한 건의 매핑 실패가 동기화 전체를 죽이면 안 된다. 남기고 계속 간다.
        console.warn(
          `[sync-scheduler] 보스 매핑 실패(${entry.contentName}): ${result.error.message}`,
        );
        return null;
      }
      if (typeof result.data !== "string" || result.data === "") return null;
      return { entry, bossDifficultyId: result.data };
    },
  );

  const mapped = resolved.flatMap((item) => (item === null ? [] : [item]));
  const unmappedCount = mappable.length - mapped.length;

  // ── 3. 계획 (`registration_flag`) ─────────────────────────────────────────
  // 이미 계획에 있는 보스는 **꺼짐도 반영해야** 한다(인게임에서 등록을 뺀 경우).
  // 반대로 한 번도 등록한 적 없는 65건까지 행을 만들면 목록이 카탈로그가 된다.
  const { data: existingPlans, error: existingError } = await db
    .from("character_boss_plans")
    .select("boss_difficulty_id")
    .eq("character_id", character.id);
  if (existingError !== null) {
    console.error(
      `[sync-scheduler] 기존 계획 조회 실패: ${existingError.message}`,
    );
    throw ApiError.internal();
  }
  const planned = new Set(
    (existingPlans ?? []).map((row) => row.boss_difficulty_id),
  );

  const planTargets = mapped.filter(
    (item) =>
      item.entry.registered === true || planned.has(item.bossDifficultyId),
  );

  const planOutcomes = await mapWithConcurrency(
    planTargets,
    DB_CONCURRENCY,
    async (item): Promise<boolean> => {
      // 플래그가 해석되지 않은 건(null)은 관측 자체가 없는 것과 같다. 건너뛴다 —
      // 함수가 예외를 던지고 동기화 전체가 죽는 것보다 낫다.
      if (item.entry.registered === null) return false;
      const result = await db.rpc("sync_character_boss_plan", {
        p_character_id: character.id,
        p_boss_difficulty_id: item.bossDifficultyId,
        /*
         * ★ 함수가 **text** 를 받는 것이 설계다 — 넥슨이 문자열을 주므로 파싱을
         *   `nexon_flag_to_boolean()` 안쪽에 두어 TS 가 틀릴 수 없게 했다(난제 16-2).
         *   우리는 경계에서 이미 접힌 boolean 을 갖고 있으므로 같은 문자열로 되돌려 보낸다.
         *   변환 규칙의 소유자는 여전히 DB 함수 하나뿐이다.
         */
        p_registration_flag: item.entry.registered ? "true" : "false",
        p_observed_at: observedAtIso,
      });
      if (result.error !== null) {
        console.warn(
          `[sync-scheduler] 계획 동기화 실패(${item.bossDifficultyId}): ${result.error.message}`,
        );
        return false;
      }
      return true;
    },
  );
  const planUpdatedCount = planOutcomes.filter(Boolean).length;

  // ── 4. 진행 (`complete_flag`) ─────────────────────────────────────────────
  const clearRecordedCount = await recordApiClears(
    db,
    context.userId,
    character.id,
    mapped,
    observedAt,
  );

  return {
    characterId: character.id,
    characterName: character.name,
    bossEntryCount: state.bosses.length,
    planUpdatedCount,
    clearRecordedCount,
    unmappedCount,
    weeklyBossClearCount: state.weeklyBossClearCount,
    weeklyBossClearLimitCount: state.weeklyBossClearLimitCount,
    nexonCallsUsed,
  };
}

/**
 * `complete_flag = true` 를 클리어 원장에 반영한다.
 *
 * ── 왜 `true` 만 쓰는가 ──────────────────────────────────────────────────────
 * `boss_clears` 는 **클리어의 원장**이고 "안 깼다"는 행의 부재로 표현된다. 77건 전부를
 * 넣으면 캐릭터·주차마다 65건의 빈 행이 쌓여 원장이 카탈로그가 된다.
 *
 * ── 왜 upsert 한 방이 아니라 조회 후 분기인가 ────────────────────────────────
 * PostgREST 의 upsert 는 **넘긴 컬럼 전부를 덮어쓴다.** 한 문장으로 처리하면 사용자가
 * 고쳐 둔 `party_size`(§1.3 D3)와 `source`, 수동 체크가 함께 밀린다. 그래서 기존 행에는
 * `api_cleared` / `api_observed_at` **두 컬럼만** UPDATE 하고, 새 행만 INSERT 한다.
 *
 * ⚠️ **알려진 근사**: API 로 관측한 클리어에는 파티 인원 정보가 없어 `party_size` 가 DB
 *    기본값 **1(솔로)** 로 들어간다. 파티로 잡은 보스라면 결정석 수익이 최대 6배 과대
 *    계상된다(§1.3 D3 — 인원은 사용자가 고칠 수 있다). 넥슨 API 에 파티 정보가 아예
 *    없으므로(§1.1) 우리가 알 수 없는 값을 지어내는 대신 **고칠 수 있는 기본값**을 둔다.
 *
 * ⚠️ `week_key` 를 명시로 넘긴다. 트리거가 `cleared_at := api_observed_at` 으로 잡고
 *    CHECK 가 `week_key = week_key(cleared_at)` 를 요구하는데, 목요일 새벽에 전날 데이터가
 *    올라오면 `week_key(now())` 기본값과 어긋나 INSERT 가 죽는다.
 */
async function recordApiClears(
  db: AdminDb,
  userId: string,
  characterId: string,
  mapped: readonly ResolvedEntry[],
  observedAt: Date,
): Promise<number> {
  const cleared = mapped.filter((item) => item.entry.cleared === true);
  if (cleared.length === 0) return 0;

  const weekKey = getWeekKey(observedAt);
  const observedAtIso = observedAt.toISOString();
  const bossDifficultyIds = cleared.map((item) => item.bossDifficultyId);

  const { data: existing, error: existingError } = await db
    .from("boss_clears")
    .select("id, boss_difficulty_id")
    .eq("user_id", userId)
    .eq("character_id", characterId)
    .eq("week_key", weekKey)
    .in("boss_difficulty_id", bossDifficultyIds);
  if (existingError !== null) {
    console.error(
      `[sync-scheduler] 기존 클리어 조회 실패: ${existingError.message}`,
    );
    throw ApiError.internal();
  }

  const existingById = new Map(
    (existing ?? []).map((row) => [row.boss_difficulty_id, row.id]),
  );

  const inserts = cleared
    .filter((item) => !existingById.has(item.bossDifficultyId))
    .map((item) => ({
      user_id: userId,
      character_id: characterId,
      boss_difficulty_id: item.bossDifficultyId,
      week_key: weekKey,
      api_cleared: true,
      api_observed_at: observedAtIso,
      source: "nexon_api" as const,
    }));

  if (inserts.length > 0) {
    const { error } = await db.from("boss_clears").insert(inserts);
    if (error !== null) {
      console.error(`[sync-scheduler] 클리어 기록 실패: ${error.message}`);
      throw ApiError.internal();
    }
  }

  const updates = cleared.flatMap((item) => {
    const id = existingById.get(item.bossDifficultyId);
    return id === undefined ? [] : [id];
  });

  if (updates.length > 0) {
    // ★ 두 컬럼만 만진다. `manual_cleared` / `party_size` / `source` 는 손대지 않는다.
    const { error } = await db
      .from("boss_clears")
      .update({ api_cleared: true, api_observed_at: observedAtIso })
      .in("id", updates);
    if (error !== null) {
      console.error(`[sync-scheduler] 클리어 갱신 실패: ${error.message}`);
      throw ApiError.internal();
    }
  }

  return cleared.length;
}
