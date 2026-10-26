/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 계획이 "끝났는가"는 **난이도가 아니라 보스**로 판정한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-26): *"같은 보스의 다른 난이도를 도는 경우에도 그냥 클리어 처리
 * 해버려 설정 안한 사람 잘못이지"* — 계획은 하드 카링인데 노멀 카링을 깼으면, 그 하드
 * 카링 계획은 끝난 것이다.
 *
 * 근거: 주간·월간·시즌 보스는 **한 주기에 같은 보스의 한 난이도만** 깰 수 있다.
 *
 * ★ **같은 주기여야 한다.** 자쿰·매그너스·파풀라투스·피에르·반반·블러디퀸·벨룸은 한
 *   보스 안에 일간 난이도와 주간 난이도가 섞여 있다. 노멀 자쿰(일간)을 깼다고 카오스
 *   자쿰(주간) 계획이 끝나지 않는다. 그래서 키는 `bossId` 하나가 아니라 `bossId + cycle`.
 *
 * ★ 이 파일은 **TS 쪽의 유일한 규칙**이다. SQL 쪽의 같은 규칙은 뷰
 *   `v_character_boss_plan_status`(마이그레이션 `20261026120000_plan_clear_any_difficulty.sql`)
 *   에 있고, 둘은 같은 말을 한다: 같은 `boss_id` · 같은 `cycle` · 주기 안의 클리어.
 *
 * ⚠️ **수익은 이 규칙과 무관하다.** 결정석 금액은 실제로 깬 난이도의 클리어 행과 그 가격
 *    스냅샷 그대로다. 여기서 답하는 것은 "그 계획이 남았나"와 "그 클리어가 어느 일정·
 *    어느 계획의 것인가"뿐이다.
 *
 * 환경 중립(서버·브라우저·봇 공통)이다 — 보스 마스터 상수만 읽는다(§2.4).
 */

import { GENERATED_BOSS_DIFFICULTIES } from "@/lib/boss-master/generated";
import type { BossDifficultyTier } from "@/types/domain";

/** `bossId:cycle`. 모르는 id 면 `null` — 지어내지 않는다. */
const KEY_BY_ENTRY: ReadonlyMap<string, string> = new Map(
  GENERATED_BOSS_DIFFICULTIES.map((entry) => [
    entry.id,
    `${entry.bossId}:${entry.cycle}`,
  ]),
);

const SIBLINGS_BY_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const entry of GENERATED_BOSS_DIFFICULTIES) {
    const key = `${entry.bossId}:${entry.cycle}`;
    const list = out.get(key) ?? [];
    list.push(entry.id);
    out.set(key, list);
  }
  return out;
})();

/**
 * 한 계획(또는 한 클리어)이 속한 **"같은 보스 · 같은 주기"** 묶음의 키.
 * 두 id 의 키가 같으면 한쪽의 클리어가 다른 쪽의 계획을 끝낸다.
 * 모르는 id 는 `null` 이며, 그때는 자기 자신하고만 같다(`isSameBossClear`).
 */
export function sameBossClearKey(bossDifficultyId: string): string | null {
  return KEY_BY_ENTRY.get(bossDifficultyId) ?? null;
}

/**
 * `clearedBossDifficultyId` 의 클리어가 `plannedBossDifficultyId` 의 계획을 끝내는가.
 *
 * 같은 id 면 언제나 참이다(마스터에 없는 id 라도). 주기 범위(이번 주·이번 달)는 묻지
 * 않는다 — 그건 클리어 행을 고르는 쪽이 이미 걸러 온다.
 */
export function isSameBossClear(
  plannedBossDifficultyId: string,
  clearedBossDifficultyId: string,
): boolean {
  if (plannedBossDifficultyId === clearedBossDifficultyId) return true;
  const planned = sameBossClearKey(plannedBossDifficultyId);
  return planned !== null && planned === sameBossClearKey(clearedBossDifficultyId);
}

/**
 * 같은 보스 · 같은 주기의 모든 난이도 id(**자기 자신 포함**). DB 조회의 `.in()` 에 쓴다.
 * 모르는 id 는 `[자기 자신]`.
 */
export function sameBossClearSiblings(
  bossDifficultyId: string,
): readonly string[] {
  const key = sameBossClearKey(bossDifficultyId);
  if (key === null) return [bossDifficultyId];
  return SIBLINGS_BY_KEY.get(key) ?? [bossDifficultyId];
}

/** 여러 id 의 형제를 합쳐 중복 없이. */
export function sameBossClearSiblingsOf(
  bossDifficultyIds: readonly string[],
): readonly string[] {
  return [...new Set(bossDifficultyIds.flatMap(sameBossClearSiblings))];
}

/**
 * 계획이 **다른 난이도로** 끝났는가 — 화면의 "노멀로 완료" 표기 근거.
 * 클리어가 없거나(`null`) 같은 난이도면 `false`.
 */
export function isClearedByOtherDifficulty(plan: {
  readonly bossDifficultyId: string;
  readonly isCleared: boolean;
  readonly clearedBossDifficultyId: string | null;
}): boolean {
  return (
    plan.isCleared &&
    plan.clearedBossDifficultyId !== null &&
    plan.clearedBossDifficultyId !== plan.bossDifficultyId
  );
}

const TIER_BY_ENTRY: ReadonlyMap<string, BossDifficultyTier> = new Map(
  GENERATED_BOSS_DIFFICULTIES.map((entry) => [entry.id, entry.difficulty]),
);

/**
 * 계획을 **다른 난이도로** 끝냈다면 그 난이도, 아니면 `null`.
 * 화면은 이 값에 난이도 이름(`BOSS_DIFFICULTY_LABEL`)을 붙여 "노멀로 완료"라고 말한다.
 */
export function otherClearedDifficulty(plan: {
  readonly bossDifficultyId: string;
  readonly isCleared: boolean;
  readonly clearedBossDifficultyId: string | null;
}): BossDifficultyTier | null {
  if (!isClearedByOtherDifficulty(plan) || plan.clearedBossDifficultyId === null) {
    return null;
  }
  return TIER_BY_ENTRY.get(plan.clearedBossDifficultyId) ?? null;
}

/**
 * 넥슨이 `observedBossDifficultyId` 를 깼다고 보고했을 때, **새 행 대신 고쳐 쓸** 기존
 * 클리어 행을 고른다. 없으면 `null` → 호출부는 예전처럼 새 행을 만든다.
 *
 * 발주자 2026-10-26 (재작업): 손으로 하드 카링을 체크해 둔 뒤 넥슨이 노멀 카링을 보고하면
 * 지금까지는 행이 두 벌 생겨 수익과 12칸이 이중으로 잡혔다. 규칙은 **넥슨 관측이 이긴다**
 * — 게임에서 실제로 깬 난이도가 진실이고, 다르게 체크해 둔 것은 "설정 안 한 사람 잘못"이다.
 *
 * 고르는 조건(전부 참이어야 한다):
 *   · 같은 보스 · 같은 주기의 **다른** 난이도(`isSameBossClear`)
 *   · 켜져 있다(`effective_cleared`) — 꺼진 행은 수익도 칸도 먹지 않아 중복이 아니다
 *   · 그 난이도 자체가 이번 응답에서 깼다고 나온 것이 아니다(`excludedIds`) — 그건 그
 *     자신의 관측이라 건드리면 안 된다
 *   · 이미 다른 관측이 가져간 행이 아니다(`usedRowIds`)
 *   · 이번 주기 안이다(`inCycle` — 주기 판정은 호출부가 안다)
 * 여럿이면 `cleared_at` 이 최신인 것(뷰의 정렬과 같다).
 */
export function pickSameBossClearToReplace<
  T extends {
    readonly id: string;
    readonly boss_difficulty_id: string;
    readonly effective_cleared: boolean | null;
    readonly cleared_at: string | null;
  },
>(
  observedBossDifficultyId: string,
  rows: readonly T[],
  options: {
    readonly excludedIds: ReadonlySet<string>;
    readonly usedRowIds?: ReadonlySet<string>;
    readonly inCycle: (row: T) => boolean;
  },
): T | null {
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.boss_difficulty_id === observedBossDifficultyId) continue;
    if (options.excludedIds.has(row.boss_difficulty_id)) continue;
    if (options.usedRowIds?.has(row.id) === true) continue;
    if (row.effective_cleared !== true) continue;
    if (!isSameBossClear(observedBossDifficultyId, row.boss_difficulty_id)) continue;
    if (!options.inCycle(row)) continue;
    const at =
      row.cleared_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.cleared_at);
    if (best === null || at > bestAt) {
      best = row;
      bestAt = at;
    }
  }
  return best;
}

const SORT_BY_ENTRY: ReadonlyMap<string, number> = new Map(
  GENERATED_BOSS_DIFFICULTIES.map((entry) => [entry.id, entry.sortOrder]),
);

/**
 * 클리어 하나가 **어느 계획의 것인가** — 계획 인원을 클리어에 적용할 때 쓴다.
 *
 * 순서: ① 클리어 난이도와 **정확히 같은** 계획 → ② 활성 계획 → ③ 높은 난이도
 * (`sortOrder` 내림차순) → ④ `planId`. 같은 보스·같은 주기가 아닌 계획은 후보가 아니다.
 *
 * ⚠️ DB 함수 `apply_plan_party_sizes_to_clears` · `set_character_boss_plan_party_size`
 *    (마이그레이션 `20261026120000_plan_clear_any_difficulty.sql`)가 같은 순서를 쓴다.
 *    뷰의 **완료 귀속**(`cleared_by_sibling`)은 ①과 ②의 순서가 반대다 — 그쪽은 "켜 둔
 *    계획이 완료로 세어지는가"를 묻고, 여기는 "이 난이도를 몇 인으로 도는가"를 묻는다.
 *    정확한 난이도 계획에 적힌 인원이 그 난이도의 사실에 가장 가깝다.
 */
export function pickPlanForClear<
  P extends {
    readonly planId: string;
    readonly bossDifficultyId: string;
    readonly isActive: boolean;
  },
>(clearBossDifficultyId: string, plans: readonly P[]): P | null {
  let best: P | null = null;
  const rank = (plan: P): [number, number, number] => [
    plan.bossDifficultyId === clearBossDifficultyId ? 1 : 0,
    plan.isActive ? 1 : 0,
    SORT_BY_ENTRY.get(plan.bossDifficultyId) ?? 0,
  ];
  for (const plan of plans) {
    if (!isSameBossClear(plan.bossDifficultyId, clearBossDifficultyId)) continue;
    if (best === null) {
      best = plan;
      continue;
    }
    const a = rank(plan);
    const b = rank(best);
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (cmp > 0 || (cmp === 0 && plan.planId < best.planId)) best = plan;
  }
  return best;
}

/** `planSameBossLedgerFix` 가 읽는 클리어 행의 최소 모양. */
export interface SameBossLedgerRow {
  readonly id: string;
  readonly boss_difficulty_id: string;
  readonly run_id: string | null;
  readonly effective_cleared: boolean | null;
  readonly cleared_at: string | null;
  readonly week_key: string;
  /** 트리거의 승자 판정 입력 — `willBeOnAfterApiObservation` 이 같은 식으로 읽는다. */
  readonly manual_cleared: boolean | null;
  readonly manual_set_at: string | null;
}

/**
 * 이 행에 `api_cleared = observation.apiCleared, api_observed_at = observation.observedAtIso`
 * 를 쓰면 **켜지는가**.
 *
 * 트리거 `boss_clears_apply_state()` 1단계(승자 판정)와 같은 식이다:
 *   · `manual_cleared` 가 없으면 API 가 이긴다 → 관측값
 *   · 있으면 `manual_set_at >= api_observed_at` 일 때 사람이 이긴다(동률도 사람) → 사람 값
 *   · 아니면 API → 관측값
 * ★ 관측값(`apiCleared`)을 **인자로 받는다**(F2). 지금 부르는 경로는 전부 "넥슨이 깼다고
 *   한 행"이라 `true` 를 넘기지만, 그 전제가 함수 안에 숨어 있으면 `false` 관측을 쓰는
 *   경로가 생겼을 때 조용히 틀린 답(켜짐)을 낸다.
 *
 * ⚠️ 넥슨의 `api_observed_at` 은 **그날 00:00 KST** 다(§1.1 — `date` 기준). 그래서 오늘
 *    낮에 사람이 해제한 행은 오늘의 동기화로 다시 켜지지 않는다. 이 판정 없이 형제를 눕히면
 *    "사람이 노멀을 해제하고 하드를 체크" 한 날 **둘 다 꺼진다**(R1, 2026-10-26 재검증).
 */
export function willBeOnAfterApiObservation(
  row: Pick<SameBossLedgerRow, "manual_cleared" | "manual_set_at">,
  observation: { readonly apiCleared: boolean; readonly observedAtIso: string },
): boolean {
  if (row.manual_cleared === null) return observation.apiCleared;
  const manualAt =
    row.manual_set_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.manual_set_at);
  const apiAt = Date.parse(observation.observedAtIso);
  return manualAt >= apiAt ? row.manual_cleared : observation.apiCleared;
}

/** 넥슨 동기화 한 번이 원장에 할 **같은 보스 정리**의 계획(쓰기는 호출부가 한다). */
export interface SameBossLedgerFix<R extends SameBossLedgerRow> {
  /** 이 행의 난이도를 관측된 난이도로 고친다(새 행 대신). */
  readonly replacements: readonly { readonly observedId: string; readonly row: R }[];
  /** 꺼진 채 있던 관측 난이도의 행 — 다시 켠다(유니크 충돌 회피, L2). */
  readonly revivals: readonly R[];
  /** 이번 실행에서 **새 행을 만들지 않을** 관측 난이도. */
  readonly handledIds: ReadonlySet<string>;
  /** 눕힐 형제 행(같은 보스·같은 주기의 다른 난이도, 켜져 있음). */
  readonly layDownIds: ReadonlySet<string>;
  /** 관측된 행 id → 형제에게서 옮겨 올 `run_id`. */
  readonly runTransfers: ReadonlyMap<string, string>;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨 관측이 이긴다 — 같은 보스·같은 주기 원장을 **1벌**로 (2026-10-26)
 * ═════════════════════════════════════════════════════════════════════════════
 * `sync-scheduler.recordApiClears` 가 쓰기 전에 부르는 순수 판정. 판정과 쓰기를 갈라 둔
 * 이유는 이 규칙을 DB 없이 케이스로 검증하기 위해서다.
 *
 * 관측된 난이도 X 하나에 대해:
 *   ① 이번 주차에 X 행이 있거나(켜짐·꺼짐 무관) 이번 주기에 켜진 X 행이 이미 있으면
 *      → 기존 갱신 경로가 그 행을 켠다. 교체는 없다.
 *   ② 그렇지 않고 같은 보스의 켜진 다른 난이도 행 Y 가 이번 주기에 있으면
 *      → Y 와 **같은 주차**에 X 행(꺼짐)이 있으면 그 X 를 되살린다(L2 — Y 를 X 로 고치면
 *        유니크 제약에 부딪힌다). 없으면 Y 를 X 로 고친다. 어느 쪽이든 새 행은 없다.
 *   ③ 둘 다 아니면 새 행(기존 동작).
 * 그 뒤 **형제 정리**: X 의 행이 있는 모든 관측(①·②-되살림)에 대해, 이번 주기에 켜져 있는
 * 같은 보스의 다른 난이도 행을 눕힌다(L1). 그 형제가 일정에 걸려 있고 X 행에 일정이 없으며
 * 이번 실행이 X 에 붙일 일정도 없으면 `run_id` 를 옮긴다.
 *
 * ⚠️ 이번 응답에서 함께 깼다고 나온 난이도의 행은 **형제로 보지 않는다**(`observedIds`).
 */
export function planSameBossLedgerFix<R extends SameBossLedgerRow>(input: {
  readonly observedIds: readonly string[];
  readonly rows: readonly R[];
  readonly weekKey: string;
  /** 이번 실행이 관측 행에 쓸 `api_observed_at`. 갱신 뒤 켜질지 판정하는 데 쓴다(R1). */
  readonly observedAtIso: string;
  /** 이번 주기에 이미 켜진 기록이 있어 새 행을 만들지 않는 관측(월간·일간, 이번 주차 밖). */
  readonly alreadyThisCycle: ReadonlySet<string>;
  readonly inCycleOf: (observedId: string) => (row: R) => boolean;
  /** 이번 실행이 일정에 연결할 관측 난이도(`loadRunLinks` 결과의 키). */
  readonly linkedIds: ReadonlySet<string>;
}): SameBossLedgerFix<R> {
  const observed = new Set(input.observedIds);
  const exactRows = input.rows.filter((row) => observed.has(row.boss_difficulty_id));
  const thisWeekExact = new Map(
    exactRows
      .filter((row) => row.week_key === input.weekKey)
      .map((row) => [row.boss_difficulty_id, row]),
  );

  const replacements: { observedId: string; row: R }[] = [];
  const revivals: R[] = [];
  const handledIds = new Set<string>();
  const replacedRowIds = new Set<string>();

  for (const observedId of input.observedIds) {
    if (thisWeekExact.has(observedId)) continue;
    if (input.alreadyThisCycle.has(observedId)) continue;
    const row = pickSameBossClearToReplace(observedId, input.rows, {
      excludedIds: observed,
      usedRowIds: replacedRowIds,
      inCycle: input.inCycleOf(observedId),
    });
    if (row === null) continue;
    handledIds.add(observedId);
    const blocker = exactRows.find(
      (candidate) =>
        candidate.boss_difficulty_id === observedId &&
        candidate.week_key === row.week_key,
    );
    if (blocker !== undefined) {
      revivals.push(blocker);
      continue;
    }
    replacedRowIds.add(row.id);
    replacements.push({ observedId, row });
  }

  const layDownIds = new Set<string>();
  const runTransfers = new Map<string, string>();
  for (const observedId of input.observedIds) {
    const inCycle = input.inCycleOf(observedId);
    /*
      기준 행(own)과 그 행이 **이 실행 뒤 켜져 있을지**.
        · 이번 주차 행 / 되살리는 행 → 이번 실행이 API 관측을 쓴다 → 트리거 식으로 예측
        · 이번 주기의 다른 주차에 이미 켜진 행 → 이번 실행이 건드리지 않는다 → 켜져 있다
      ★ 켜질 것이 **확실할 때만** 형제를 눕힌다(R1). 사람이 같은 날 관측 난이도를 해제하고
        다른 난이도를 체크했다면 그 결정이 이긴다 — 형제(사람이 켠 것)는 살고 관측 행은
        꺼진 채로 남아 **1벌**이 유지된다. 다음 날 관측(00:00)이 사람 시각보다 늦어지면
        그때 넥슨 쪽이 켜지고 형제가 눕는다.
    */
    /*
      이번 실행이 `api_cleared = true` 를 쓰는 경로는 셋이다 — 이번 주차 행의 단순 갱신
      (`plainUpdates`) · 일정 연결 갱신(`linkUpdates`) · 되살리기(`revivals`). 앞의 둘은
      `thisWeekExact` 의 행이고 셋째는 `revivals` 의 행이다. 셋 다 관측값 `true` 다.
    */
    const thisWeek = thisWeekExact.get(observedId);
    const revived = revivals.find((row) => row.boss_difficulty_id === observedId);
    const pending = thisWeek ?? revived;
    const untouched =
      pending === undefined
        ? exactRows.find(
            (row) =>
              row.boss_difficulty_id === observedId &&
              row.effective_cleared === true &&
              inCycle(row),
          )
        : undefined;
    const own = pending ?? untouched;
    if (own === undefined) continue;
    const observation = { apiCleared: true, observedAtIso: input.observedAtIso } as const;
    const ownOn =
      thisWeek !== undefined
        ? willBeOnAfterApiObservation(thisWeek, observation) // plainUpdates · linkUpdates
        : revived !== undefined
          ? willBeOnAfterApiObservation(revived, observation) // revivals
          : true; // 이번 실행이 건드리지 않는, 이미 켜진 같은 주기 행
    if (!ownOn) continue;
    for (const sibling of input.rows) {
      if (observed.has(sibling.boss_difficulty_id)) continue;
      if (replacedRowIds.has(sibling.id)) continue;
      if (sibling.effective_cleared !== true) continue;
      if (!isSameBossClear(observedId, sibling.boss_difficulty_id)) continue;
      if (!inCycle(sibling)) continue;
      layDownIds.add(sibling.id);
      if (
        own.run_id === null &&
        sibling.run_id !== null &&
        !input.linkedIds.has(observedId) &&
        !runTransfers.has(own.id)
      ) {
        runTransfers.set(own.id, sibling.run_id);
      }
    }
  }

  return { replacements, revivals, handledIds, layDownIds, runTransfers };
}

/**
 * 계획 목록을 **보스 단위 한 줄**로 접는다 — 12칸 격자·칸 수·남은 금액이 쓴다(R4).
 *
 * 같은 보스·같은 주기 계획이 여럿이면 하나만 남긴다:
 *   ① 그 보스의 클리어를 **귀속받은** 계획(`isCleared && !clearedBySibling`)
 *   ② 없으면 활성 계획 중 **높은 난이도**(`sortOrder`)
 *   ③ 그다음 `planId`
 * 형제로 끝난 계획은 ①이 있으면 자연히 빠진다. 순서는 **남긴 계획이 처음 나온 자리**를
 * 따른다(화면의 정렬을 흔들지 않는다).
 *
 * ⚠️ 활성 여부는 묻지 않는다 — 넘겨받은 목록이 이미 켜진 것만이라는 전제다(격자·카드).
 */
export function collapseToOnePlanPerBoss<
  P extends {
    readonly planId: string;
    readonly bossDifficultyId: string;
    readonly isActive: boolean;
    readonly isCleared: boolean;
    readonly clearedBySibling: boolean;
  },
>(plans: readonly P[]): P[] {
  const chosen = new Map<string, P>();
  const firstIndex = new Map<string, number>();
  const score = (plan: P): [number, number, number] => [
    plan.isCleared && !plan.clearedBySibling ? 1 : 0,
    plan.isActive ? 1 : 0,
    SORT_BY_ENTRY.get(plan.bossDifficultyId) ?? 0,
  ];
  plans.forEach((plan, index) => {
    const key = sameBossClearKey(plan.bossDifficultyId) ?? `id:${plan.bossDifficultyId}`;
    if (!firstIndex.has(key)) firstIndex.set(key, index);
    const current = chosen.get(key);
    if (current === undefined) {
      chosen.set(key, plan);
      return;
    }
    const a = score(plan);
    const b = score(current);
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (cmp > 0 || (cmp === 0 && plan.planId < current.planId)) chosen.set(key, plan);
  });
  return [...chosen.entries()]
    .sort((x, y) => (firstIndex.get(x[0]) ?? 0) - (firstIndex.get(y[0]) ?? 0))
    .map(([, plan]) => plan);
}
