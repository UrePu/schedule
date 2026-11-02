import { getBossCycle, getBossEntry } from "@/lib/boss-master";
import { isSameBossClear } from "@/lib/domain/same-boss-clear";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { BossCycle } from "@/types/domain";

import type { ParticipantCharacterEdit } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 클리어가 **그 일정의 것인가** — 붙일 때도, 뗄 때도 이 판정 하나다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 넥슨은 "언제 깼는가" 를 주지 않는다(§1.1). 동기화는 원래 (캐릭터 · 보스 · 주차)만 보고
 * 일정에 붙였고, 그래서 금요일에 이미 깬 카칼이 월요일 일정에 붙었다 — 실측: 10/23 22:50
 * 클리어가 10/27 일정에. 돈도 움직인다. 금요일 솔로로 깬 18.4억이 월요일 2인 일정에 붙으면
 * 9.2억이 된다(교차 검증 H1, 2026-11-02).
 *
 * 그래서 쓰는 곳이 둘이다:
 *   · **붙일 때** — 동기화(`sync-scheduler.recordApiClears` → `pickRunLinkForClear`).
 *   · **뗄 때** — 일정 상세의 캐릭터 변경(`schedule-repo.settleAttachedClears`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ `cleared_at` **하나로는 판정이 성립하지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 값의 출처가 경로마다 다르다(`sync-scheduler.recordApiClears` · `income-repo.setRunClear`):
 *
 * | 행이 생긴 경로                   | `cleared_at`        | `created_at`    |
 * |----------------------------------|---------------------|-----------------|
 * | 동기화 — 일정 없음, 나중에 연결  | 동기화를 돌린 시각  | 같은 시각       |
 * | 동기화 — **일정이 이미 있었음**  | **일정의 예정 시각**| 동기화를 돌린 시각 |
 * | 시간표에서 수동 체크             | 일정의 예정 시각    | 누른 시각       |
 * | 계획 칸에서 수동 체크            | 누른 시각           | 누른 시각       |
 *
 * 둘째 줄이 함정이다. 월요일에 수요일 일정을 잡아 둔 채 월요일에 깨면 `cleared_at` 이
 * **수요일로 박혀** 일정 날짜와 같아진다. 실측(2026-11-02): 연결된 191건 중 그렇게 가려진
 * 것이 2건(9/2 일정, 8/31 22:50 에 관측), `cleared_at` 만으로 잡히는 것이 3건이다.
 *
 * → **넥슨 행은 `created_at` 까지 함께 본다.** 동기화는 `complete_flag` 가 참일 때만 행을
 *   만들므로, 행이 만들어진 시각은 곧 "늦어도 이때는 이미 깼다" 는 관측 사실이다.
 *
 * ⚠️ `api_observed_at` 은 쓰지 못한다 — 동기화마다 **앞으로 밀리는** 값이라 "처음 본 때" 를
 *    말해 주지 않는다. 게다가 넥슨 `date` 라 언제나 00:00 이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **사람의 진술은 날짜보다 세다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 일정에 걸린 행의 `manual_cleared` 가 켜져 있으면 사람이 "이 일정을 깼다" 고 한 것이다
 * (`setRunClear`). 넥슨 행이든 수동 행이든, 언제 눌렀든 그 일정의 클리어다. 실측 191건 중 1건.
 * 일정에 안 걸린 행(`run_id = null`)의 체크는 계획 칸의 것이라 어느 일정에 대한 진술이 아니다 —
 * 그래서 붙일지 판단할 때는 이 규칙이 작동하지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **판정 단위는 날짜다 — 알려진 한계**(발주 결정 2026-11-02, 바꾸지 않는다)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · **같은 날 먼저 깬 것을 가려내지 못한다.** 오전에 깨고 저녁 일정이 있으면 그 저녁 일정의
 *     클리어로 붙고, 본인도 캐릭터를 못 바꾼다. 라이브 190건 중 10건이 이 모양이다. 넥슨이 깬
 *     시각을 주지 않으므로 시각 단위로 좁혀도 "관측 시각" 일 뿐 더 맞아지지 않는다.
 *   · 일정을 이미 깬 뒤 같은 주 **다음 날로 옮기면** 이 판의 클리어인데 "이전 날짜" 로 보인다.
 *   · 00:10 일정을 전날 23:50 에 일찍 시작해 깨면 역시 "이전 날짜" 다.
 *   뒤의 둘은 본인이 캐릭터를 바꾸려고 누른 때에만 드러나고, 끊어도 클리어는 사라지지 않는다.
 *   · **일정 날짜보다 일찍 돌면 그 일정에 붙지 않는다.** 수요일 일정을 월요일에 앞당겨 돌아도
 *     월요일의 클리어로 남고, 그 일정은 "이번 주 이미 클리어" 로 표시된다. 그래서 상세 창 문구는
 *     "다른 캐릭터로 간다면" 처럼 사정을 추측하지 않고 **깬 기록이 있다는 사실만** 말한다.
 */

/** `boss_clears` 에서 판정에 쓰는 칸. 서버 세 곳(시간표 · 쓰기 · 동기화)이 같은 모양으로 읽는다. */
export interface RunClearFacts {
  readonly source: string;
  readonly cleared_at: string | null;
  readonly created_at: string;
  readonly effective_cleared: boolean | null;
  readonly run_id: string | null;
  readonly manual_cleared: boolean | null;
}

/**
 * - `off` — 행은 있지만 꺼져 있다(사람이 해제함). 금액이 없다.
 * - `before_run` — 일정 **날짜보다 먼저** 관측됐다. 이 일정의 클리어가 아니다.
 * - `this_run` — 일정 날짜 이후거나 사람이 이 일정에 체크했다. 이 일정의 클리어로 본다.
 */
export type RunClearRelation = "off" | "before_run" | "this_run";

/** 이 클리어를 **처음 안 시각**. 위 표의 결론이 여기 있다. */
function firstSeenAt(clear: RunClearFacts): number | null {
  if (clear.cleared_at === null) return null;
  const clearedAt = Date.parse(clear.cleared_at);
  if (clear.source !== "nexon_api") return clearedAt;
  return Math.min(clearedAt, Date.parse(clear.created_at));
}

export function classifyRunClear(
  clear: RunClearFacts,
  runScheduledAtIso: string | null,
): RunClearRelation {
  const seenAt = firstSeenAt(clear);
  if (clear.effective_cleared !== true || seenAt === null) return "off";
  if (clear.run_id !== null && clear.manual_cleared === true) return "this_run";
  // 시각 없는 일정은 비교할 날짜가 없다. **그 일정의 것으로 둔다** — 뗄 때는 막는 쪽이고,
  // 붙일 때는 시각이 생기기 전 기존 동작 그대로다.
  if (runScheduledAtIso === null) return "this_run";
  // `YYYY-MM-DD` 라 문자열 비교가 곧 날짜 비교다. 경계는 KST 다(§1).
  return kstDayKey(new Date(seenAt)) < kstDayKey(new Date(runScheduledAtIso))
    ? "before_run"
    : "this_run";
}

/** 지금 처음 보는 클리어(아직 행이 없다) — 새 행은 **지금 시각이 처음 안 시각**이다. */
export function newClearFacts(seenAtIso: string): RunClearFacts {
  return {
    source: "nexon_api",
    cleared_at: seenAtIso,
    created_at: seenAtIso,
    effective_cleared: true,
    run_id: null,
    manual_cleared: null,
  };
}

/**
 * 동기화가 이 클리어를 **어느 일정에 붙일 것인가** — 후보 순서는 호출부가 정한다.
 *
 * ★ 조건은 하나다: 처음 안 날짜가 일정 날짜보다 앞서면 그 일정이 아니다. 그래서 일정을 **나중에
 *   소급 등록**한 경우(일정 날짜 ≤ 관측 날짜)는 그대로 붙는다 — 발주 요구 R5-G.
 * ★ 판단 시점에는 어느 일정에도 안 걸린 행이므로 `run_id` 를 비워 본다(머리말의 "사람의 진술"
 *   은 일정에 걸린 행의 이야기다).
 * ★ 꺼진 행이 이번 관측으로 되살아나는 경우 `cleared_at` 이 비어 있다. 그때는 `created_at` 으로
 *   본다 — 금요일에 만들어진 행은 월요일에 되살아나도 금요일의 클리어다.
 */
export function pickRunLinkForClear<
  L extends { readonly scheduledAtIso: string | null },
>(candidates: readonly L[], clear: RunClearFacts): L | null {
  const facts: RunClearFacts = {
    ...clear,
    run_id: null,
    effective_cleared: true,
    cleared_at: clear.cleared_at ?? clear.created_at,
  };
  return (
    candidates.find(
      (candidate) =>
        classifyRunClear(facts, candidate.scheduledAtIso) !== "before_run",
    ) ?? null
  );
}

/**
 * 클리어가 붙은 채로 캐릭터를 바꿀 때 — **막는가.** (막지 않으면 연결을 풀고 진행한다.)
 *
 * ★ **남의 줄은 어떤 행이든 막는다**(발주 2026-11-02). 남의 행은 어떤 경우에도 쓰지 않는다 —
 *   켜진 행을 풀면 그 사람의 수익이 다시 계산되고, 꺼진 행이라도 그 사람이 해제해 둔 기록이다.
 *   내 일정 편집이 남의 원장을 건드리면 안 된다.
 * ★ 내 줄은 이 일정의 클리어일 때만 막는다 — 그때 참가 행만 바꾸면 일정은 B, 12칸과 수익은
 *   A 를 말하고, 다시 체크하는 순간 같은 판이 두 캐릭터에 기록된다. 꺼진 행은 금액이 없어 풀면 된다.
 */
export function shouldBlockCharacterChange(
  relation: RunClearRelation,
  isSelf: boolean,
): boolean {
  return !isSelf || relation === "this_run";
}

/**
 * 명단 한 줄의 편집 가능 상태. 화면이 **누르기 전에** 말할 수 있게 시간표가 싣는 값이고,
 * 판정은 서버 쓰기와 같은 함수다(`shouldBlockCharacterChange`) — 두 벌이면 화면은 열어
 * 두고 서버가 거절하는 일이 생긴다.
 */
export function participantCharacterEdit(input: {
  readonly hasAccount: boolean;
  readonly isSelf: boolean;
  readonly status: "going" | "maybe" | "declined";
  readonly relations: readonly RunClearRelation[];
}): ParticipantCharacterEdit {
  if (!input.hasAccount) return "guest";
  if (input.status === "declined") return "declined";
  const blocking = input.relations.filter((r) =>
    shouldBlockCharacterChange(r, input.isSelf),
  );
  if (blocking.length > 0) {
    return blocking.every((r) => r === "off") ? "off_record_locked" : "clear_locked";
  }
  return input.relations.includes("before_run") ? "release_clear" : "open";
}

/**
 * 일정에서 떼어 낼 때의 UPDATE 본문.
 *
 * ★ `price_snapshotted_at = null` — 트리거(`boss_clears_apply_state`)가 금액을 다시 찍는다.
 *   `run_id` 가 비면 `resolve_crystal_payout` 이 그 일정의 `going` 인원 대신 **행의
 *   `party_size`** 로 나눈다. 스냅샷이 남아 있으면 트리거가 금액 블록을 건너뛰어 연결은
 *   풀렸는데 금액은 그 일정 기준으로 남는다. 주기와 시세 행은 트리거가 보존한다(재스냅샷).
 * ★ **사람이 고치지 않은 인원은 계획 인원으로 돌아간다**(`party_size_manual`). 일정에서 복사된
 *   값은 그 일정의 입장 인원이지 이 클리어의 사실이 아니고, 일정 없는 행은 원래 계획을
 *   따른다(`20260825120000` 의 같은 세 조건). 사람이 고친 값은 계획보다 세다(§1.3 D3).
 *   계획이 없으면 1 이다 — 동기화가 일정 없는 새 행에 쓰는 값과 같다.
 * ★ **`cleared_at` 이 일정 시각으로 가려져 있었으면 관측 시각으로 되돌린다**(머리말 표의
 *   둘째 줄). 판별은 "만들어진 시각보다 뒤인가" 하나다 — 깬 시각이 기록보다 뒤일 수는 없다.
 *   그 사이 일정이 다른 날로 옮겨졌어도 같은 답이 나온다. 그대로 두면 일정에서는 떨어졌는데
 *   달력은 여전히 옛 일정 날짜에 그 클리어를 찍는다.
 *   주차가 달라지면 되돌리지 않는다 — 수익 주차를 옮기는 것은 이 동작의 일이 아니다(§1.3 D1).
 */
export function clearReleasePatch(
  clear: RunClearFacts & {
    readonly week_key: string;
    readonly party_size: number;
    readonly party_size_manual: boolean;
  },
  runScheduledAtIso: string | null,
  planPartySize: number,
): {
  readonly run_id: null;
  readonly price_snapshotted_at: null;
  readonly party_size?: number;
  readonly cleared_at?: string;
} {
  const sizePatch =
    !clear.party_size_manual && clear.party_size !== planPartySize
      ? { party_size: planPartySize }
      : {};
  const base = { run_id: null, price_snapshotted_at: null, ...sizePatch } as const;

  if (
    clear.source !== "nexon_api" ||
    clear.cleared_at === null ||
    classifyRunClear(clear, runScheduledAtIso) !== "before_run"
  ) {
    return base;
  }
  const createdAt = new Date(clear.created_at);
  return Date.parse(clear.cleared_at) > createdAt.getTime() &&
    getWeekKey(createdAt) === clear.week_key
    ? { ...base, cleared_at: createdAt.toISOString() }
    : base;
}

/**
 * 이 클리어가 **그 일정과 같은 주기**인가 — 뷰 `v_character_boss_plan_status` 의 주기 범위와
 * 같은 식이다. 월 경계는 KST 달력 1일, 주 경계는 KST 목요일 00:00(§1).
 */
export function isClearInRunCycle(
  clear: { readonly week_key: string; readonly cleared_at: string | null },
  run: { readonly weekKey: string; readonly scheduledAtIso: string | null },
  cycle: BossCycle | undefined,
): boolean {
  // 시즌·모르는 주기는 주간처럼 센다(`income-repo.clearCycleScope` 와 같다).
  if (cycle !== "monthly" && cycle !== "daily") {
    return clear.week_key === run.weekKey;
  }
  if (clear.cleared_at === null || run.scheduledAtIso === null) return false;
  const clearDay = kstDayKey(new Date(clear.cleared_at));
  const runDay = kstDayKey(new Date(run.scheduledAtIso));
  return cycle === "monthly"
    ? clearDay.slice(0, 7) === runDay.slice(0, 7)
    : clearDay === runDay;
}

/** 시간표 · 봇 · 후보가 함께 쓰는 일정 한 건의 재료. */
export interface RunCycleTarget {
  readonly runId: string;
  /** 그 일정에 데려가는 캐릭터(런 지정 → 파티 기본값). 없으면 판정할 것이 없다. */
  readonly characterId: string | null;
  readonly bossDifficultyId: string;
  readonly scheduledAtIso: string | null;
  readonly weekKey: string;
}

/** `boss_clears` 의 켜진 행 — `loadCycleClears` 가 돌려주는 모양. */
export type CycleClearFacts = RunClearFacts & {
  readonly character_id: string | null;
  readonly boss_difficulty_id: string;
  readonly week_key: string;
};

/** 이 캐릭터가 **이 일정의 보스(같은 보스 · 같은 주기)** 를 이 일정의 주기 안에 깬 기록. */
function clearsOfRunBoss(
  target: RunCycleTarget,
  clears: readonly CycleClearFacts[],
): readonly CycleClearFacts[] {
  return clears.filter(
    (clear) =>
      clear.character_id === target.characterId &&
      isSameBossClear(target.bossDifficultyId, clear.boss_difficulty_id) &&
      isClearInRunCycle(
        clear,
        { weekKey: target.weekKey, scheduledAtIso: target.scheduledAtIso },
        getBossCycle(target.bossDifficultyId),
      ),
  );
}

/**
 * **이 일정에는 클리어가 안 붙을 런인가** — 데려가는 캐릭터가 이번 주기에 그 보스를 깼는데 그
 * 클리어가 이 일정의 것이 아니다(다른 일정에 붙었거나, 일정 날짜보다 먼저 관측됐다).
 *
 * 웹 시간표(`characterAlreadyCleared`)와 카톡 `!일정`(`MyRun.cleared`)이 **이 함수 하나**를 쓴다.
 *
 * ⚠️ 같은 날 먼저 깬 행은 `false` 다 — 다음 동기화가 이 일정에 붙일 행이기 때문이다. 판정이 동기화와
 *    같은 함수(`pickRunLinkForClear`)인 이유가 그것이다.
 */
export function isRunClearedElsewhere(
  target: RunCycleTarget,
  clears: readonly CycleClearFacts[],
): boolean {
  if (target.characterId === null) return false;
  return clearsOfRunBoss(target, clears).some(
    (clear) =>
      clear.run_id !== target.runId &&
      (clear.run_id !== null ||
        pickRunLinkForClear([{ scheduledAtIso: target.scheduledAtIso }], clear) ===
          null),
  );
}

/**
 * 후보 캐릭터가 이번 주기에 이미 깬 **이 묶음의 보스들** — 후보 줄의 말과 N1 거절이 같은 값을 본다.
 *
 * ★ 라벨은 **일정의 보스** 줄임말이다. 익세 칼로스를 깬 캐릭터도 카칼 일정 앞에서는 "카칼" 이다 —
 *   사용자가 지금 보고 있는 보스 이름이 그것이고, 같은 보스 · 같은 주기면 한 번만 깰 수 있다.
 */
export function candidateClearLabels(
  characterId: string,
  runs: readonly RunCycleTarget[],
  clears: readonly CycleClearFacts[],
): readonly { readonly label: string; readonly cycle: BossCycle | undefined }[] {
  return runs.flatMap((run) => {
    if (clearsOfRunBoss({ ...run, characterId }, clears).length === 0) return [];
    const entry = getBossEntry(run.bossDifficultyId);
    return [
      {
        label: entry?.shortName ?? entry?.koreanName ?? "이 보스",
        cycle: getBossCycle(run.bossDifficultyId),
      },
    ];
  });
}

/** `이번 주` · `이번 달` · `오늘` — 거절 문구가 쓴다. 섞여 있으면 가장 흔한 주간으로 말한다. */
export function clearScopeWord(
  labels: readonly { readonly cycle: BossCycle | undefined }[],
): string {
  if (labels.length > 0 && labels.every((entry) => entry.cycle === "monthly")) {
    return "이번 달";
  }
  if (labels.length > 0 && labels.every((entry) => entry.cycle === "daily")) {
    return "오늘";
  }
  return "이번 주";
}

/** 후보 한 줄에 붙이는 말. 주기별로 나눠 적는다 — 월간 보스에 "이번 주" 는 거짓이다. */
export function candidateClearNote(
  labels: readonly { readonly label: string; readonly cycle: BossCycle | undefined }[],
): string | null {
  const of = (test: (cycle: BossCycle | undefined) => boolean) =>
    labels.filter((entry) => test(entry.cycle)).map((entry) => entry.label);
  const parts = [
    ["오늘", of((cycle) => cycle === "daily")],
    ["이번 주", of((cycle) => cycle !== "daily" && cycle !== "monthly")],
    ["이번 달", of((cycle) => cycle === "monthly")],
  ] as const;
  const text = parts
    .filter(([, names]) => names.length > 0)
    .map(([scope, names]) => `${scope} ${[...new Set(names)].join("·")}`)
    .join(" · ");
  return text === "" ? null : `${text} 클리어함`;
}
