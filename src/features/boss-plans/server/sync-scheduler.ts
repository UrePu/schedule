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
import { isUntrackedNexonCycle } from "@/lib/domain/boss-scope";
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

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ 일간 보스를 **저장하기 전에** 버린다 (`@/lib/domain/boss-scope`)
   * ═══════════════════════════════════════════════════════════════════════════
   * 발주자 지시(2026-08-18): *"일간보스는 추적 안해. 일간보스는 전부 제외"*
   *
   * ⚠️ **넥슨 호출 수는 줄지 않는다.** 스케줄러는 캐릭터당 1콜이고 일간·주간·월간이 한
   *    응답에 전부 실려 온다. 줄어드는 것은 **DB 왕복과 저장량**이다 — 실측 77건 중 24건
   *    남짓이 일간이라, 매핑 RPC(`nexon_resolve_boss_difficulty`) 왕복과 스냅샷 payload
   *    크기가 그만큼 준다.
   *
   * ⚠️ **엔트리(난이도) 단위로 거른다.** `bossDaily` 라는 항목별 값을 보므로 노멀 자쿰은
   *    빠지고 카오스 자쿰은 남는다. 보스 이름으로 걸렀다면 카오스 자쿰·하드 매그너스 같은
   *    주간 보스가 통째로 사라졌을 것이다.
   *
   * ⚠️ `weeklyBossClearCount` / `weeklyBossClearLimitCount` 는 **손대지 않는다.** 넥슨이
   *    세어 준 12개 카운터이고 일간과 원장이 분리돼 있어(§1) 여기서 값이 움직이면 버그다.
   */
  const trackedBosses = state.bosses.filter(
    (entry) => !isUntrackedNexonCycle(entry.rawCycle),
  );

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
          // 일간을 뺀 목록만 미러한다 — 안 쓸 데이터를 캐릭터·주차마다 쌓을 이유가 없다.
          bosses: trackedBosses.map((entry) => ({ ...entry })),
          dailyContents: state.dailyContents.map((entry) => ({ ...entry })),
          weeklyContents: state.weeklyContents.map((entry) => ({ ...entry })),
        },
        // 빈 응답은 "그날 접속하지 않았다"이며 **에러가 아니다**(§1.1).
        /*
         * 빈 응답은 "그날 접속하지 않았다"이며 에러가 아니다(§1.1). 판정은 **원본**
         * `state.bosses` 로 한다 — 일간만 돌려받은 응답을 "빈 응답"으로 적으면
         * 접속하지 않은 것과 구별이 사라진다.
         */
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
  const mappable = trackedBosses.filter(
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
    // 일간을 뺀 건수. 화면이 "보스 N건 확인"으로 쓰는 값이라 **우리가 실제로 다룬 수**여야 한다.
    bossEntryCount: trackedBosses.length,
    planUpdatedCount,
    clearRecordedCount,
    unmappedCount,
    weeklyBossClearCount: state.weeklyBossClearCount,
    weeklyBossClearLimitCount: state.weeklyBossClearLimitCount,
    nexonCallsUsed,
  };
}

/**
 * 이 캐릭터가 이 보스들을 **평소 몇 인으로 도는지** 읽는다 (마이그레이션 21).
 *
 * 값이 없는 보스는 맵에 넣지 않는다. 그런 보스는 **계획 행 자체가 없는 보스**뿐이다 —
 * 컬럼이 `NOT NULL DEFAULT 1` 이므로(마이그레이션 25) 계획 행이 있으면 반드시 값이 있다.
 * 호출부는 맵에 없는 보스를 **1인**으로 본다. "미설정"이라는 상태는 더 이상 없다.
 *
 * ⚠️ 마이그레이션이 아직 적용되지 않았으면 PostgREST 가 42703(undefined_column)을 낸다.
 *    그때는 **동기화를 죽이지 않고** 빈 맵으로 계속한다. 인원수 기본값이 없다고 해서
 *    클리어 기록 자체가 실패할 이유는 없고, 그 경우의 결과는 이 기능이 생기기 전과 같다.
 */
async function loadPlanPartySizes(
  db: AdminDb,
  characterId: string,
  bossDifficultyIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const sizes = new Map<string, number>();
  if (bossDifficultyIds.length === 0) return sizes;

  const { data, error } = await db
    .from("character_boss_plans")
    .select("boss_difficulty_id,default_party_size")
    .eq("character_id", characterId)
    .in("boss_difficulty_id", [...bossDifficultyIds]);

  if (error !== null) {
    if (error.code === "42703") {
      console.warn(
        "[sync-scheduler] character_boss_plans.default_party_size 가 없습니다. " +
          "20260818110000_boss_plan_party_size.sql 미적용으로 보고 인원 기본값 없이 진행합니다.",
      );
      return sizes;
    }
    console.error(`[sync-scheduler] 계획 인원수 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }

  for (const row of data ?? []) {
    if (typeof row.default_party_size === "number") {
      sizes.set(row.boss_difficulty_id, row.default_party_size);
    }
  }
  return sizes;
}

/** 동기화가 만든 클리어에 붙일 **이미 등록된 일정**. */
interface RunLink {
  readonly runId: string;
  /** 그 일정에 잡아 둔 입장 인원. `entry_party_size ?? capacity`. */
  readonly partySize: number;
  /** 그 일정의 예정 시각. 없으면 `null` — 호출부가 관측 시각으로 되돌린다. */
  readonly scheduledAtIso: string | null;
}

/** `party_runs.entry_party_size` 는 nullable 이라 정원으로 되돌리고 범위를 자른다. */
function entryPartySizeOf(run: {
  readonly entry_party_size: number | null;
  readonly capacity: number;
}): number {
  return Math.min(Math.max(run.entry_party_size ?? run.capacity, 1), 24);
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨이 "깼다"고 한 보스를 **우리가 이미 등록해 둔 일정에 붙인다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"이미 파티 인원이 저장되어있는데 그상태로 클리어하면 그냥 3인으로
 * 클리어했다고 치면되지 그렇게 해결이 안돼?"* — 된다. 이 함수가 그 연결을 찾는다.
 *
 * API 에는 파티 정보가 전혀 없지만(§1.1), **우리 DB 에는 있다.** 같은 주차·같은 보스에
 * 이 캐릭터가 `going` 으로 등록된 일정이 있으면 그 일정으로 돈 것이라고 보는 것이 자연스러운
 * 해석이고, 그 순간 인원은 추측이 아니라 **사용자가 저장해 둔 값**이 된다.
 *
 * 연결되면 따라오는 것들:
 *   · `run_id` → 트리거의 `resolve_crystal_payout` 이 pot 을 그 일정의 `going` 인원으로
 *     나눈다. 1인 기준 과대 계상(§1.3 D3)이 여기서 사라진다.
 *   · `party_size` → 그 일정의 입장 인원. 화면이 "입장 3명"이라고 바르게 말한다.
 *   · `cleared_at` → 그 일정의 예정 시각. 동기화 시각보다 실제에 훨씬 가깝고, 달력의
 *     날짜 칸이 실제로 돈 날에 찍힌다. **수동 체크(`setRunClear`)가 쓰는 값과 같다** —
 *     두 경로가 같은 규칙을 쓰게 맞춘 것이다.
 *
 * 후보가 여럿이면(같은 주에 같은 보스 일정을 두 번 잡은 경우) **예정 시각이 이른 것**을
 * 고른다. 무엇을 고르든 근사이지만 규칙이 있어야 동기화를 두 번 돌려도 답이 같다.
 *
 * ⚠️ 취소된 일정은 후보가 아니다. `setRunClear` 도 취소된 일정을 거부한다.
 */
async function loadRunLinks(
  db: AdminDb,
  characterId: string,
  weekKey: string,
  bossDifficultyIds: readonly string[],
): Promise<ReadonlyMap<string, RunLink>> {
  const links = new Map<string, RunLink>();
  if (bossDifficultyIds.length === 0) return links;

  const { data, error } = await db
    .from("run_signups")
    .select(
      "run_id, party_runs!inner(id,boss_difficulty_id,week_key,scheduled_at,entry_party_size,capacity,cancelled_at,status)",
    )
    .eq("character_id", characterId)
    .eq("status", "going")
    .eq("party_runs.week_key", weekKey)
    .in("party_runs.boss_difficulty_id", [...bossDifficultyIds]);

  if (error !== null) {
    /*
     * 일정 조회가 실패했다고 **클리어 기록 자체를 죽이지 않는다.** 연결이 없으면 결과는
     * 이 기능이 생기기 전과 같고(1인 기준), 그건 기록을 아예 잃는 것보다 낫다.
     */
    console.warn(`[sync-scheduler] 일정 연결 조회 실패: ${error.message}`);
    return links;
  }

  for (const row of data ?? []) {
    const run = row.party_runs;
    if (run === null) continue;
    if (run.cancelled_at !== null || run.status === "cancelled") continue;

    const previous = links.get(run.boss_difficulty_id);
    if (previous !== undefined) {
      // 예정 시각이 이른 쪽을 남긴다. 시각이 없는 일정은 있는 쪽에 자리를 내준다.
      const previousAt = previous.scheduledAtIso;
      const currentAt = run.scheduled_at;
      if (previousAt !== null && (currentAt === null || previousAt <= currentAt)) {
        continue;
      }
    }

    links.set(run.boss_difficulty_id, {
      runId: run.id,
      partySize: entryPartySizeOf(run),
      scheduledAtIso: run.scheduled_at,
    });
  }

  return links;
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
 * ⚠️ **알려진 근사**: API 로 관측한 클리어에는 파티 인원 정보가 없다(§1.1). 파티로 잡은
 *    보스를 1인으로 세면 결정석 수익이 최대 6배 과대 계상된다(§1.3 D3).
 *
 *    ★ **1순위는 이미 등록해 둔 일정이다** (발주자 2026-08-19: *"이미 파티 인원이
 *      저장되어있는데 그상태로 클리어하면 그냥 3인으로 클리어했다고 치면되지"*).
 *      같은 주차·같은 보스에 이 캐릭터가 `going` 으로 등록된 일정이 있으면 `loadRunLinks`
 *      가 찾아 `run_id`·인원·시각을 함께 싣는다. 그러면 인원은 추측이 아니라 **사용자가
 *      저장해 둔 값**이고, 분배도 그 일정의 참여자 수로 갈린다.
 *
 *    일정이 없을 때만 **계획에 적어 둔 인원수**(`character_boss_plans.default_party_size`,
 *    마이그레이션 21)를 새 행의 기본값으로 쓴다. 이것은 넥슨이 준 값이 아니라 **사용자가
 *    미리 말해 둔 값**이므로 지어낸 숫자가 아니다 — "이 캐릭터는 이 보스를 3인으로 돈다"를
 *    한 번 적으면 클리어마다 손으로 고칠 필요가 없어진다.
 *
 *    ★ **2026-08-19 변경 — 인원의 기본값은 1인으로 확정이다** (발주자 지시:
 *      *"그냥 1인을 기본으로 잡아 굳이 1이라고 설정안하게"*). 예전에는 계획에 인원을
 *      적어 두지 않은 보스가 `party_size_confirmed = false` 로 들어와 수익 화면이 계속
 *      "인원 확인 필요"라고 말했다. 이제 "정하지 않음"과 "1인으로 정함"은 **같은 상태**이므로
 *      이 경로는 언제나 `confirmed = true` 를 싣는다.
 *
 *      ⚠️ **그 대가**: 실제로는 파티로 도는 보스의 인원을 계획에 적어 두지 않으면, 아무
 *         경고 없이 1인(솔로가)으로 계산되어 결정석 수익이 최대 6배 과대 계상된다
 *         (§1.3 D3 이 경고하던 바로 그 지점). 발주자가 그 위험을 알고 내린 결정이다.
 *    ★ **기존 행에는 적용하지 않는다.** 아래 UPDATE 는 여전히 두 컬럼만 만진다. 이미 쌓인
 *      클리어의 인원은 **한 건씩 개별 수정**한다(발주자 지시 2026-08-19: *"개별수정
 *      가능하도록해"*). 예전에 있던 일괄 소급 경로(`apply_plan_party_sizes_to_clears()`)는
 *      웹 UI 에서 걷어냈다 — 대상 조건이 `party_size_confirmed = false` 인데 바로 이
 *      경로가 `true` 를 싣게 되면서 대상이 **언제나 0건**이 되었기 때문이다. DB 함수 자체는
 *      남아 있고, 마이그레이션 26 이 그 사실을 함수 COMMENT 에 적었다.
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
    .select("id, boss_difficulty_id, run_id, party_size_confirmed")
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
    (existing ?? []).map((row) => [row.boss_difficulty_id, row]),
  );

  const planPartySizes = await loadPlanPartySizes(
    db,
    characterId,
    bossDifficultyIds,
  );

  /** 같은 주차에 이미 등록해 둔 일정. 있으면 인원과 시각을 여기서 가져온다. */
  const runLinks = await loadRunLinks(
    db,
    characterId,
    weekKey,
    bossDifficultyIds,
  );

  const inserts = cleared
    .filter((item) => !existingById.has(item.bossDifficultyId))
    .map((item) => {
      /*
       * 계획 행이 없는 보스만 맵에서 빠지고, 그때의 값은 **1** 이다(마이그레이션 25 —
       * 컬럼이 `NOT NULL DEFAULT 1` 이라 계획 행이 있으면 언제나 값이 있다).
       * ⚠️ 두 컬럼을 **모든 행에 똑같이** 싣는다 — PostgREST 의 벌크 INSERT 는 행마다
       *    키 집합이 다르면 `PGRST102` 로 전체를 거부한다(조건부로 키를 빼면 안 된다).
       */
      const planned = planPartySizes.get(item.bossDifficultyId) ?? 1;
      /*
       * ★ 등록해 둔 일정이 있으면 **그 일정이 계획값을 이긴다** (발주자 2026-08-19:
       *   *"이미 파티 인원이 저장되어있는데 그상태로 클리어하면 그냥 3인으로 클리어했다고
       *   치면되지"*). 계획값은 "평소 몇 인으로 도는가"이고 일정은 "이번에 몇 인으로
       *   갔는가"다 — 이번 판에 대해서는 뒤엣것이 사실에 가깝다.
       */
      const link = runLinks.get(item.bossDifficultyId) ?? null;
      return {
        user_id: userId,
        character_id: characterId,
        boss_difficulty_id: item.bossDifficultyId,
        week_key: weekKey,
        api_cleared: true,
        api_observed_at: observedAtIso,
        source: "nexon_api" as const,
        /*
         * 연결되면 트리거가 pot 을 그 일정의 `going` 인원으로 나눈다(§1.3 D3 의
         * 6배 과대 계상이 사라지는 지점). 없으면 `null` — **키는 모든 행에 실어야 한다**
         * (아래 PGRST102 주석).
         */
        run_id: link?.runId ?? null,
        /*
         * 클리어 시각도 일정에서 가져온다. 트리거는 `cleared_at` 이 null 일 때만
         * `api_observed_at`(동기화 시각)으로 채우므로, 여기서 넣은 값이 존중된다.
         * 일정의 주차로 걸러 온 후보라 `week_key` 와 어긋나지 않는다.
         */
        cleared_at: link?.scheduledAtIso ?? null,
        party_size: link?.partySize ?? planned,
        /*
         * ★ 언제나 `true` 다 (2026-08-19, 발주자 지시). 예전에는 `planned !== null` 이라
         *   "계획에 적어 두지 않은 보스"가 미확인으로 들어와 수익 화면에 "확인 필요" 배지가
         *   붙었다. 이제 기본값 1인은 그 자체로 확정이므로 배지를 띄우지 않는다.
         *
         *   트리거 `boss_clears_apply_state()` 는 INSERT 시
         *   `coalesce(new.party_size_confirmed, false) or source <> 'nexon_api' or run_id is not null`
         *   로 유도하는데, 첫 항이 여기서 넘긴 `true` 를 그대로 존중한다. 트리거의 보수적
         *   기본값(넥슨 관측분은 미확인)은 **일부러 남겨 두었다** — 앞으로 다른 경로가
         *   넥슨 클리어를 만들면 그때는 신호가 살아 있어야 한다.
         *
         *   ⚠️ 대가는 위 머리말과 같다: 실제 파티 보스를 방치하면 수익이 조용히 과대 계상된다.
         */
        party_size_confirmed: true,
      };
    });

  if (inserts.length > 0) {
    const { error } = await db.from("boss_clears").insert(inserts);
    if (error !== null) {
      console.error(`[sync-scheduler] 클리어 기록 실패: ${error.message}`);
      throw ApiError.internal();
    }
  }

  /*
   * ── 기존 행 ────────────────────────────────────────────────────────────────
   * 두 갈래다.
   *
   * ① 그냥 관측만 갱신 — 이미 일정에 걸려 있거나, 걸 일정이 없는 행. **두 컬럼만**
   *    만진다(`manual_cleared` / `party_size` / `source` 는 사용자 것이다).
   * ② 뒤늦게 일정이 생긴 행 — 동기화가 먼저 돌고 일정을 나중에 등록한 경우다.
   *    `run_id` 를 채우고 `price_snapshotted_at = null` 로 **금액을 다시 계산**시킨다.
   *    스냅샷이 남아 있으면 트리거가 금액 계산 자체를 건너뛰어 연결이 돈에 반영되지 않는다.
   *
   *    인원은 **아무도 확인한 적이 없는 행에만** 덮어쓴다 — `setRunClear` 가 쓰는 규칙과
   *    같다. 사용자가 고쳐 둔 값(§1.3 D3)을 동기화가 되돌리면 안 된다. 인원을 못 고치는
   *    행이라도 `run_id` 만으로 분배는 바로잡힌다(pot 은 인원과 거의 무관하고, 나누는 것은
   *    일정의 `going` 인원이다).
   */
  const plainUpdates: string[] = [];
  const linkUpdates: {
    readonly id: string;
    readonly runId: string;
    readonly partySize: number | null;
  }[] = [];

  for (const item of cleared) {
    const row = existingById.get(item.bossDifficultyId);
    if (row === undefined) continue;

    const link = runLinks.get(item.bossDifficultyId) ?? null;
    if (link === null || row.run_id !== null) {
      plainUpdates.push(row.id);
      continue;
    }
    linkUpdates.push({
      id: row.id,
      runId: link.runId,
      partySize: row.party_size_confirmed ? null : link.partySize,
    });
  }

  if (plainUpdates.length > 0) {
    const { error } = await db
      .from("boss_clears")
      .update({ api_cleared: true, api_observed_at: observedAtIso })
      .in("id", plainUpdates);
    if (error !== null) {
      console.error(`[sync-scheduler] 클리어 갱신 실패: ${error.message}`);
      throw ApiError.internal();
    }
  }

  // 행마다 `run_id` 가 달라 한 문장으로 묶을 수 없다. 캐릭터당 최대 12건이라 감당된다.
  for (const update of linkUpdates) {
    const { error } = await db
      .from("boss_clears")
      .update({
        api_cleared: true,
        api_observed_at: observedAtIso,
        run_id: update.runId,
        price_snapshotted_at: null,
        ...(update.partySize === null
          ? {}
          : { party_size: update.partySize, party_size_confirmed: true }),
      })
      .eq("id", update.id);
    if (error !== null) {
      console.error(`[sync-scheduler] 클리어 일정 연결 실패: ${error.message}`);
      throw ApiError.internal();
    }
  }

  return cleared.length;
}
