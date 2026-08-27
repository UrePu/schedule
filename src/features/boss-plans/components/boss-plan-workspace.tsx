"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Swords,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BossIcon,
  NumericText,
  describeSnapshotFreshness,
  formatKstFull,
} from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  FilterChip,
  HelperText,
  Input,
  Label,
  ListItem,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { fetchMyParties } from "@/features/dashboard/data";
import { getTrackedBossCatalog } from "@/lib/boss-master";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import {
  dbQueryOptions,
  queryKeys,
} from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { clearedPeriodLabel } from "@/lib/domain/boss-scope";
import type {
  BossCatalogEntry,
  BossCycle,
  TimeRange,
  WeekKey,
} from "@/types/domain";

import {
  fetchCharacterPlans,
  fetchWeeklyChecklist,
  resetCharacterBossPlanToApi,
  setCharacterBossPlan,
  setCharacterBossPlanPartySize,
  syncCharacterScheduler,
} from "../data";
import type {
  CharacterBossPlan,
  CharacterPlanResponse,
  ChecklistCharacter,
} from "../types";
import {
  describePlanConflict,
  divergedSummarySentence,
  pendingSummarySentence,
  resolvePlanConflictState,
} from "../lib/plan-conflict";
import {
  withPlanActive,
  withPlanPartySize,
} from "../lib/plan-optimistic";
import { weeklySlotBlockReason } from "../lib/weekly-slot-guard";
import {
  describeSyncFailure,
  formatSyncFailure,
} from "../lib/sync-failure-message";
import { PlanRunDialog, type PlanRunParty } from "./plan-run-dialog";
import { SyncButton } from "./sync-button";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터별 "매주 가는 보스" 편집 (DB-SCHEMA 난제 16)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ 이 화면은 **동기화 결과를 보정하는 곳**이지 목록을 처음부터 채우는 곳이 아니다
 *   (§1.1.1). 넥슨이 `registration_flag` 로 계획을, `complete_flag` 로 진행을 이미 준다.
 *   사람이 하는 일은 "인게임 체크리스트를 관리하지 않는 보스"를 직접 켜고 끄는 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 가지를 여기서 다시 계산하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **진행률** — `planned / cleared / remaining` 은 `v_character_weekly_boss_progress`.
 * 2. **12개 상한 판정** — `weeklyOverLimit` / `weeklySlotsRemaining` 도 같은 뷰.
 *    상한값(12)조차 `weekly_crystal_sell_limit()` 에서 오므로 이 파일에 숫자가 없다.
 * 3. **12 카운터 포함 여부** — 행 단위 `countsTowardWeeklyLimit` 을 그대로 읽는다.
 *    화면이 `cycle === "weekly"` 를 다시 적으면 규칙이 두 벌이 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 끄기 = 묘비. 되돌리기 = 판단 포기. **삭제 버튼은 없앴다** (2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 줄마다 `끄기` 와 휴지통(삭제)이 나란히 있었다. 그런데 삭제는 행을 지우는
 * 구현이었고, 계획 행은 **동기화가 다시 만드는 행**이라 다음 동기화가 넥슨의
 * `registration_flag = true` 를 보고 `manual_active = null` 로 되살렸다. 발주자 화면에서
 * `노멀 림보` · `노멀 찬란한 흉성` 이 하드 버전과 함께 남아 주간 계획이 14개가 된 원인이다.
 *
 * - **끄기**(`set_character_boss_plan(..., false)`) — 이제 **목록에서 빼는 유일한 길**이다.
 *   `manual_active = false` 라는 묘비가 남고 트리거의 `coalesce` 가 그것을 집으므로
 *   **동기화가 되살릴 수 없다.** 행은 `꺼 둔 항목` 구역에 회색 취소선으로 남는다 —
 *   "후보를 올려 두고 12개만 켠다"는 사용법도 여전히 여기서 나온다.
 * - **되돌리기**(`RotateCcw`, `DELETE`) — 뜻이 다른 별개 동선이다. `manual_active` 를
 *   `null` 로 지워 판정을 인게임 목록에 넘긴다. 그래서 넥슨이 등록 중인 보스는 **다시
 *   나타나며 그것이 의도된 결과**다. 확인창이 그 사실을 먼저 말한 뒤에만 부른다.
 *   내 판단이 없는 행(`manualActive === null`)에는 지울 것이 없으므로 버튼도 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 13번째 주간 보스는 **서버가 거절한다** (발주자 지시, 2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 2025-08-21 패치 이후 13번째 주간 보스는 입장 자체가 불가능하다(§1). **판정의 소유자는
 * 여전히 서버**(`server/boss-plan-repo.ts` 의 `assertWeeklyPlanSlotAvailable()`)이고
 * 그쪽이 400 으로 거절한다.
 *
 * ★ 2026-08-18 변경 — 화면이 **누르기 전에 미리 본다**(발주자 지시). 낙관적 업데이트가
 *   들어오면서 이 자리가 달라졌다: 낙관적으로 켰다가 서버가 거절해 롤백하면 목록이
 *   깜빡이고, 사용자는 자기가 무엇을 잘못했는지 모른 채 "안 눌렸다"고 읽는다. 그래서
 *   `canTurnOnWeeklyPlan()` 이 클릭 시점에 먼저 판정하고, 걸리면 **호출 자체를 하지 않고**
 *   같은 문장을 즉시 보여 준다.
 * ★ 규칙이 두 벌이 되지 않는 이유: 그 함수는 상한도 개수도 만들지 않는다. **뷰가 낸
 *   `progress.plannedWeekly` 와 `progress.weeklyLimit` 을 비교만** 한다 —
 *   `assertWeeklyPlanSlotAvailable()` 이 하는 일과 글자 그대로 같고, 12 라는 숫자는
 *   여기에도 서버에도 없다(`weekly_crystal_sell_limit()` 이 단일 출처).
 * ★ **버튼을 잠그지는 않는다.** 예전 주석이 경계한 그대로다 — 잠그면 이미 상한을 넘긴
 *   사람은 무엇 때문에 잠겼는지 알 수 없다. 누를 수는 있고, 누르면 이유를 말한다.
 *
 * 월간은 그 12에 들어가지 않으며, 이미 넘어 있는 계획을 잘라내지도 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 인원수 — **기본값을 정하는 곳**이지 과거를 고치는 곳이 아니다 (마이그레이션 21)
 * ─────────────────────────────────────────────────────────────────────────────
 * 줄마다 있는 숫자 칸은 `character_boss_plans.default_party_size` 이고, **앞으로 생길
 * 클리어의 `party_size` 기본값**이다. 넥슨 API 에는 파티 정보가 없어(§1.1) 동기화로 들어온
 * 클리어가 1인으로 앉고 결정석 수익이 최대 6배 과대 계상되는데(§1.3 D3), 여기 한 번
 * 적어 두면 그 반복 교정이 사라진다.
 *
 * 규칙 세 줄:
 * 1. **기본값은 1인이고, 그것이 확정 상태다** (발주자 지시, 2026-08-19: *"그냥 1인을
 *    기본으로 잡아 굳이 1이라고 설정안하게"*). 컬럼이 `NOT NULL DEFAULT 1` 이라
 *    "미설정"이라는 상태가 아예 없다 — 화면에 보이는 1 은 자리표시자가 아니라 저장된 값이다.
 *    ⚠️ **그 대가**: 실제로는 파티로 도는 보스를 1 그대로 두면 아무 경고 없이 결정석
 *      수익이 과대 계상된다(§1.3 D3). 예전에는 `인원수를 정하지 않은 보스 N개` 문장이
 *      그것을 알렸지만, 발주자가 그 경고 자체를 없애기로 했다. 대신 목록 위 안내 문장이
 *      "정하지 않으면 1인 기준"이라는 규칙을 한 번 말한다.
 * 2. **이미 쌓인 클리어는 바뀌지 않는다.** 사실이 기본값을 이긴다. 이미 기록된 클리어의
 *    인원은 **한 건씩 직접 고친다**(발주자 지시, 2026-08-19: *"개별수정 가능하도록해"*).
 *    ★ 2026-08-19 삭제 — 예전에 여기 있던 `쌓인 클리어에 인원수 적용`(일괄 소급) 버튼.
 *      대상 조건이 `boss_clears.party_size_confirmed = false` 인데 기본값 1인 확정
 *      (마이그레이션 25) 이후 미확인 행이 하나도 없어 미리보기가 **항상 0건**이었다.
 *      눌러도 아무 일이 없는 버튼은 "고장났다"로 읽히므로 없는 편이 낫다. DB 함수
 *      `apply_plan_party_sizes_to_clears()` 는 남겨 두었다 — 나중에 대상 조건을
 *      "계획 인원 ≠ 클리어 인원"으로 바꿔 되살릴 여지가 있고, 지우는 쪽이 되돌리기 어렵다.
 * 3. **`max_party` 는 경고일 뿐 막지 않는다**(§1.3 D5 — 대부분 추정치다).
 */

/**
 * 인원수 입력칸을 **비웠을 때 되돌아가는 값** (발주자 지시, 2026-08-19).
 *
 * 예전에는 빈 칸이 "미설정으로 해제"였다. 그 상태가 사라졌으므로 이제 빈 칸은
 * **기본값 1로 되돌리기**다. DB 함수도 `coalesce(p_party_size, 1)` 로 같은 값을 쓴다.
 */
const PARTY_SIZE_DEFAULT = 1;

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
  // 주간마다 초기화되지만 12칸을 안 먹는다 — 라벨을 갈라야 그 차이가 보인다(2026-08-26).
  season: "시즌",
};

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

/** 별칭까지 훑는 검색 — 봇의 `!등록 하카` 와 같은 어휘를 화면에서도 쓴다. */
function matchesBoss(boss: BossCatalogEntry, query: string): boolean {
  if (query === "") return false;
  const haystack = [
    boss.koreanName,
    boss.bossKoreanName,
    boss.bossDifficultyId,
    ...boss.aliases,
  ].map(normalizeQuery);
  return haystack.some((value) => value.includes(query));
}

interface PlanRowProps {
  readonly plan: CharacterBossPlan;
  readonly onToggle: (plan: CharacterBossPlan) => void;
  /** 내 판단을 지우고 인게임 목록에 맡긴다. 확인창을 연다 — 되살아날 수 있기 때문이다. */
  readonly onReset: (plan: CharacterBossPlan) => void;
  /** 행 자체를 누르면 그 보스로 일정을 잡는 모달이 열린다. */
  readonly onSchedule: (plan: CharacterBossPlan) => void;
  /** 인원수 확정. `null` 은 **기본값 1로 되돌리기**다(입력칸을 비웠을 때). */
  readonly onPartySize: (plan: CharacterBossPlan, size: number | null) => void;
}

/** 인원수 입력의 허용 범위. DB CHECK(`1 ~ 24`)와 같은 경계를 그대로 옮겼다. */
const PARTY_SIZE_MIN = 1;
const PARTY_SIZE_MAX = 24;

/**
 * 보스 한 줄의 **인원수 입력칸** — "이 보스는 몇 인으로 도는가".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 값이 무엇인지 (마이그레이션 21)
 * ─────────────────────────────────────────────────────────────────────────────
 * `character_boss_plans.default_party_size` 이고, **앞으로 생길 클리어의 기본값**이다.
 * 넥슨 API 에는 파티 정보가 아예 없어(§1.1) 동기화로 들어온 클리어가 1인으로 앉고,
 * 그러면 결정석 수익이 최대 6배 과대 계상된다(§1.3 D3). 여기 한 번 적어 두면 그 반복
 * 교정이 사라진다. **이미 쌓인 클리어는 이 입력으로 바뀌지 않는다** — 그쪽은 한 건씩
 * 고친다(일괄 소급 버튼은 언제나 0건이라 2026-08-19 에 제거, 머리말 참조).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 기본값은 **`1` 이고 그것이 확정 상태다** (발주자 지시, 2026-08-19)
 * ─────────────────────────────────────────────────────────────────────────────
 * 컬럼이 `NOT NULL DEFAULT 1` 이라(마이그레이션 25) 칸에 보이는 1 은 **저장된 값**이다.
 * 예전처럼 "미설정을 미리 보여 주는 자리표시자"가 아니므로 흐리게 그리지 않는다 —
 * 정한 1 과 정하지 않은 1 을 가를 이유가 사라졌다.
 *
 * 칸을 비우면 `null` 을 보내고 DB 함수가 `coalesce(…, 1)` 로 접는다. 즉 **1로 되돌리기**다.
 *
 * ⚠️ 대가는 머리말과 같다 — 실제 파티 보스를 1 그대로 두면 경고 없이 수익이 과대 계상된다
 *    (§1.3 D3). 발주자가 알고 내린 결정이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 상태를 effect 없이 다룬다
 * ─────────────────────────────────────────────────────────────────────────────
 * `draft === null` 이면 서버 값(`plan.defaultPartySize`)을 그대로 보여 준다. 확정(blur /
 * Enter) 시 draft 를 비우므로, 응답으로 갱신된 번들이 곧바로 화면 값이 된다 —
 * `useEffect` 로 prop 을 state 에 복사하는 흔한 동기화 버그가 구조적으로 생기지 않는다.
 *
 * 높이는 옆 버튼(`h-control-sm`, 32px)과 **같다.** 줄 높이가 늘어나면 안 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * −/+ 버튼을 붙인 이유 (2026-08-20, 발주 지적: *"인풋 박스가 너무 불편하게 생겼음"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 칸의 실제 사용은 **1 → 2~6 사이를 오가는 것**이 거의 전부다(§1 최대 파티 6, 신규
 * 보스 3, 익스 스우 2). 그런데 숫자 입력만 있으면 그 한 걸음에 **누르고 · 지우고 ·
 * 치고 · 포커스를 빼는** 네 동작이 든다. 13줄이 한 화면에 있으니 그게 곧 마찰이다.
 *
 * ★ **입력칸을 없애지 않는다.** 24까지 갈 수 있고(DB CHECK), 그때는 타이핑이 빠르다.
 *   버튼은 흔한 경로를 짧게 만들 뿐 유일한 경로가 되어서는 안 된다.
 * ★ **브라우저 기본 스피너는 끈다.** 우리 버튼과 나란히 두면 같은 일을 하는 컨트롤이
 *   둘이 되고, 기본 스피너는 32px 안에서 누를 수 없을 만큼 작다.
 * ★ 버튼은 **즉시 확정**한다. 타이핑은 blur/Enter 를 기다리지만, 버튼 클릭은 그 자체가
 *   확정 의사라 한 번 더 기다릴 이유가 없다.
 */
function PartySizeField({
  plan,
  onCommit,
}: {
  readonly plan: CharacterBossPlan;
  readonly onCommit: (size: number | null) => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<string | null>(null);

  const committed = String(plan.defaultPartySize);
  const value = draft ?? committed;

  /** 확정. 빈 값은 **기본값 1로 되돌리기**, 범위 밖은 저장하지 않고 서버 값으로 되돌린다. */
  function commit() {
    if (draft === null) return;
    const trimmed = draft.trim();
    setDraft(null);

    if (trimmed === "") {
      // `null` 을 보내면 DB 가 1 로 접는다. 이미 1 이면 왕복할 이유가 없다.
      if (plan.defaultPartySize !== PARTY_SIZE_DEFAULT) onCommit(null);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (
      !Number.isInteger(parsed) ||
      parsed < PARTY_SIZE_MIN ||
      parsed > PARTY_SIZE_MAX
    ) {
      return; // 되돌린다. 저장하지 않았음이 값으로 드러난다.
    }
    if (parsed !== plan.defaultPartySize) onCommit(parsed);
  }

  /**
   * −/+ 가 밟고 설 **현재 값**.
   *
   * 타이핑 중(`draft`)이라면 그 값을 기준으로 삼는다 — 사용자가 `3` 을 치다 말고 `+` 를
   * 눌렀는데 서버 값 `1` 에서 2가 되면 눈앞의 숫자와 어긋난다. 숫자로 읽히지 않는
   * 중간 상태(빈 칸 등)에서는 저장된 값으로 돌아간다.
   */
  const parsedDraft = draft === null ? Number.NaN : Number.parseInt(draft, 10);
  const current = Number.isInteger(parsedDraft)
    ? parsedDraft
    : plan.defaultPartySize;

  /** 버튼은 **즉시 확정**한다. 범위 밖으로는 못 나가므로 되돌릴 일이 없다. */
  function step(delta: number) {
    const next = Math.min(PARTY_SIZE_MAX, Math.max(PARTY_SIZE_MIN, current + delta));
    setDraft(null);
    if (next !== plan.defaultPartySize) onCommit(next);
  }

  // §1.3 D5 — `max_party` 는 대부분 추정치라 **막지 않고** 알리기만 한다.
  const overMax =
    plan.maxParty !== null && plan.defaultPartySize > plan.maxParty;

  /** −/+ 공통 모양. 입력칸과 같은 높이(32px)의 정사각형이라 줄 높이가 늘지 않는다. */
  const stepClass = cn(
    "flex h-control-sm w-control-sm shrink-0 items-center justify-center",
    "rounded-md border border-border bg-surface text-ink-muted",
    "transition duration-200",
    "hover:bg-hover-strong hover:text-ink",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface",
    "disabled:hover:text-ink-muted",
  );

  return (
    <span className="flex items-center gap-1">
      <label htmlFor={fieldId} className="sr-only">
        {plan.bossDisplayName} 파티 인원수 (결정석 1/n 분모)
      </label>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={current <= PARTY_SIZE_MIN}
        title="인원 1명 줄이기"
        aria-label={`${plan.bossDisplayName} 인원 1명 줄이기`}
        className={stepClass}
      >
        <Minus aria-hidden size={14} />
      </button>
      <input
        id={fieldId}
        type="number"
        inputMode="numeric"
        min={PARTY_SIZE_MIN}
        max={PARTY_SIZE_MAX}
        step={1}
        value={value}
        title={`이 보스를 몇 인으로 도는지. ${String(PARTY_SIZE_MIN)}~${String(PARTY_SIZE_MAX)} 사이이며, 비우면 기본값 ${String(PARTY_SIZE_DEFAULT)}인으로 되돌아갑니다.`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        className={cn(
          "h-control-sm w-12 rounded-md border bg-surface px-1",
          // 숫자는 등폭으로. 본문 서체(Pretendard)의 `tnum` 이 낸다 — mono 로 감싸면
          // 입력칸만 다른 서체가 되어 옆 라벨과 갈린다(2026-08-20 서체 교체).
          "text-center text-body-sm tabular-nums",
          /*
            브라우저 기본 스피너를 끈다. −/+ 버튼이 같은 일을 하므로 둘을 함께 두면
            컨트롤이 중복되고, 기본 스피너는 32px 높이 안에서 실제로 누를 수 없다.
          */
          "[appearance:textfield]",
          "[&::-webkit-inner-spin-button]:appearance-none",
          "[&::-webkit-outer-spin-button]:appearance-none",
          /*
            ★ 2026-08-19 부터 **흐림 단계가 없다.** 예전에는 "미설정으로 미리 채운 1" 과
              "사용자가 정한 1" 을 톤으로 갈랐지만, 그 두 상태가 하나로 합쳐졌다.
              칸에 보이는 숫자는 언제나 저장된 값이므로 §4 대로 본문 잉크로 그린다.
          */
          "text-ink",
          "transition duration-200 outline-none",
          overMax ? "border-chip-soon-border" : "border-border",
          "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
        )}
      />
      <button
        type="button"
        onClick={() => step(1)}
        disabled={current >= PARTY_SIZE_MAX}
        title="인원 1명 늘리기"
        aria-label={`${plan.bossDisplayName} 인원 1명 늘리기`}
        className={stepClass}
      >
        <Plus aria-hidden size={14} />
      </button>
      <span aria-hidden className="text-caption text-ink-label">
        인
      </span>
      {overMax ? (
        <>
          {/*
            §4: 경고는 red 가 아니라 **tertiary orange** 이고, 주황은 아이콘·배경이 지고
            문장은 잉크가 진다. 줄이 좁아 문장은 옆 카드에 한 번만 두고, 여기서는
            아이콘 + 스크린리더 문장으로 같은 사실을 말한다.
          */}
          <TriangleAlert
            aria-hidden
            size={14}
            className="shrink-0 text-tertiary"
          />
          <span className="sr-only">
            최대 파티 {plan.maxParty}인을 넘습니다. 저장은 막지 않습니다.
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * 계획 한 줄.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 행 클릭 ≠ 버튼 클릭 — **이벤트를 구조로 가른다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 행 전체가 눌려야 하는데 그 안에 `끄기`·삭제 버튼이 이미 있다. 흔한 해법 두 개는
 * 둘 다 나쁘다:
 *   (a) `<li onClick>` + 버튼에서 `stopPropagation` — 버튼이 하나 늘 때마다 다시
 *       빠뜨릴 수 있고, `<li role="button">` 안에 `<button>` 이 들어가 중첩이 된다.
 *   (b) 이름 영역만 버튼 — "행을 클릭"이라는 요구를 지키지 못한다.
 *
 * 그래서 **행을 덮는 투명 버튼**(stretched link 패턴)을 쓴다. 액션 버튼들은 그 버튼의
 * **자식이 아니라 형제**이고 `relative` 로 위층에 놓이므로, 액션 버튼 클릭은 애초에
 * 덮개에 닿지 않는다 — `stopPropagation` 이 필요 없다. 이벤트 분리가 **구조로 보장**된다.
 * 키보드도 탭 스톱 하나(덮개 버튼) + 액션 버튼들로 자연스럽게 잡힌다.
 *
 * §4: **난이도는 좌측 보더 색**으로 인코딩한다. 매핑은 `boss-card.tsx` 의
 * `BOSS_DIFFICULTY_BORDER_L` 를 재사용한다 — 여기서 다시 정의하면 두 벌이 되어 갈라진다.
 * 색만으로 정보를 주지 않도록 난이도 텍스트(`bossDisplayName` 이 이미 `하드 …` 형태)가
 * 항상 함께 있다.
 *
 * 🖼️ **보스 아이콘**은 `BossIcon`(`@/components/domain`)이 그린다. 파일명 규칙과 폴백은
 *    그 컴포넌트 안에만 있다. 아이콘이 없는 보스는 실루엣이 뜨며 **오류가 아니다**.
 *    꺼 둔 계획은 이미지도 함께 흐려진다 — 글자의 취소선과 같은 신호다.
 */
/*
 * ★ **`isBusy` prop 이 사라졌다** (낙관적 업데이트, 2026-08-18).
 *   예전에는 한 줄의 `끄기` 를 누르면 `setPlan.isPending` 이 켜지면서 **목록 전체**의
 *   버튼과 인원수 칸이 비활성이 됐다. 발주자 원문 그대로 *"db 입력한다고 계속 멈추는데
 *   굉장히 불쾌함"* 의 정체가 이것이다. 이제 값이 즉시 바뀌므로 잠글 이유가 없다 —
 *   잠그면 "먼저 반영"의 이점이 그대로 사라진다. 실패하면 값이 되돌아가고
 *   `@/lib/query/optimistic` 이 그 사실을 알린다.
 */
function PlanRow({
  plan,
  onToggle,
  onReset,
  onSchedule,
  onPartySize,
}: PlanRowProps) {
  /*
   * ★ `plan.hasConflict` 를 그대로 쓰지 않는다. 최신성으로 갈라야 "방금 바꿔서 아직
   *   게임에 안 들어간 것"과 "게임이 계속 다른 말을 하는 것"이 구분된다.
   *   판정은 `lib/plan-conflict.ts` 하나에만 있고 체크리스트도 같은 함수를 쓴다.
   */
  const conflictState = resolvePlanConflictState(plan);
  const conflictNote = describePlanConflict(conflictState, plan.bossDisplayName);

  return (
    <li
      className={cn(
        "group relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-l-4",
        "border-border bg-surface px-3 py-2 transition duration-200",
        /*
         * hover 면을 `hover-surface`(흰 면 대비 1.10:1) → `hover-strong`(1.245:1)로 올렸다.
         * 대신 이 행 안의 `ink-muted` 글자는 그 면 위에서 3.88:1 로 AA 미달이 되므로
         * `group-hover` 로 `ink-label`(8.39 / 8.97:1)까지 같이 올린다.
         */
        "hover:border-border-strong hover:bg-hover-strong",
        "focus-within:border-primary",
        BOSS_DIFFICULTY_BORDER_L[plan.difficulty],
      )}
    >
      {/*
        행 전체를 덮는 클릭 대상. 시각적으로는 없고, 스크린리더에는 행위가 분명히 읽힌다.
        `absolute` 라 정적 배치된 텍스트 위에 오고, 아래 액션 버튼 묶음(`relative`)보다는
        DOM 순서상 앞이라 그쪽이 위층이 된다.
      */}
      <button
        type="button"
        onClick={() => onSchedule(plan)}
        aria-label={`${plan.bossDisplayName} 일정 잡기`}
        className={cn(
          "absolute inset-0 rounded-md outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-focus-ring",
        )}
      />

      <BossIcon
        bossDifficultyId={plan.bossDifficultyId}
        difficulty={plan.difficulty}
        size="sm"
        className={plan.isActive ? undefined : "opacity-50 grayscale"}
      />
      {/* `boss_difficulties.korean_name` — 이미 `하드 최초의 대적자` 형태다. */}
      <span
        className={
          plan.isActive
            ? "min-w-0 flex-1 truncate text-body-sm font-medium text-ink"
            : "min-w-0 flex-1 truncate text-body-sm text-ink-muted line-through group-hover:text-ink-label"
        }
      >
        {plan.bossDisplayName}
      </span>

      {plan.isCleared ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-chip-done-border bg-chip-done-bg px-1.5 py-0.5 text-caption text-ink">
          <CheckCircle2
            aria-hidden
            size={12}
            className="shrink-0 text-chip-done-fg"
          />
          {/*
            ★ **주기 이름으로 말한다** (2026-08-20 발주자). `이번 주 완료` 로 못박으면
              월간 보스(검은 마법사)에서 거짓말이 된다 — 한 달에 한 번이라 주가 바뀌어도
              배지는 켜져 있는 것이 맞고, 문구가 그 사실을 말해야 한다.
              판정(`isCleared`)은 원래부터 주기별이었고 문구만 못 따라가고 있었다.
          */}
          {clearedPeriodLabel(plan.cycle)}
        </span>
      ) : null}

      {plan.countsTowardWeeklyLimit ? null : (
        /*
          주기 배지. 예전에는 카운터 제외 문구를 덧붙였는데 발주자 지시로 뺐다
          (2026-08-18 — 주간 체크리스트에서 먼저 제거된 것과 같은 결정).
          월간이라는 사실만으로 카운터 밖임은 이미 전달되고, 좁은 줄에서 글자만 늘어난다.
        */
        <span className="shrink-0 rounded-md border border-border bg-neutral-100 px-1.5 py-0.5 text-caption text-ink-label">
          {CYCLE_LABEL[plan.cycle]}
        </span>
      )}

      {/*
        ── 인게임 목록과의 차이 ─────────────────────────────────────────────
        예전에는 `설정 불일치` 배지가 **행마다** 붙었다. 규칙이 최신성을 보지 않아서
        (마이그레이션 19-2: *"최신성 비교 없음"*) 앱에서 방금 켠 보스에도 즉시 붙었고,
        §1.1 대로 우리는 인게임 스케줄러에 **쓸 수 없으므로** 사용자가 해소할 방법도
        없었다. 해소 불가능한 경고를 줄마다 도배하는 것은 수익 화면에서 같은 문단을
        11번 반복하던 것과 같은 결함이다.

        지금은 판정을 `lib/plan-conflict.ts` 가 하고, 여기에는 **진짜 어긋남만**
        아이콘 하나로 남는다. 문장(무엇을 해야 하는지)은 `title` 과 스크린리더에,
        개수와 조치는 오른쪽 카드 요약에 **한 번만** 있다.
        `pending`(우리 설정이 더 최신 = 게임 반영 대기)은 **아무것도 그리지 않는다.**
        §4: 색은 red 가 아니라 tertiary orange 이고, 주황은 아이콘이 지고 문장은 잉크다.
      */}
      {conflictState === "diverged" && conflictNote !== null ? (
        /* `title` 은 마우스용, `sr-only` 는 낭독기용 — **같은 문장**이다. */
        <span
          className="relative flex shrink-0 items-center"
          title={conflictNote}
        >
          <TriangleAlert aria-hidden size={14} className="text-tertiary" />
          <span className="sr-only">{conflictNote}</span>
        </span>
      ) : null}

      {plan.origin === "nexon_api" ? (
        <span className="shrink-0 text-caption text-ink-muted group-hover:text-ink-label">
          인게임 등록
        </span>
      ) : null}

      {/*
        `relative` 로 덮개보다 위층에 둔다 — 이 조작들의 클릭·포커스는 덮개에 닿지 않는다.
        인원수 입력칸도 **여기 안에** 있어야 한다. 밖에 두면 칸을 누를 때마다 일정 모달이
        열린다(덮개가 행 전체를 덮고 있다).
      */}
      <div className="relative flex shrink-0 items-center gap-1">
        <PartySizeField plan={plan} onCommit={(size) => onPartySize(plan, size)} />
        <Button variant="ghost" size="sm" onClick={() => onToggle(plan)}>
          {plan.isActive ? "끄기" : "켜기"}
        </Button>
        {/*
          ── 되돌리기 ─────────────────────────────────────────────────────────
          휴지통(삭제)이 있던 자리다. 삭제는 다음 동기화가 되살려 무의미했으므로
          **목록에서 빼는 일은 위의 `끄기` 가 맡는다**(묘비가 남아 되살아나지 않는다).
          이 버튼은 뜻이 다르다 — 내가 켜고 끈 판단 자체를 지워 인게임 목록에 맡긴다.
          그래서 **내 판단이 없는 행에는 버튼이 없다**. 지울 것이 없기 때문이다.
        */}
        {plan.manualActive === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            title={`${plan.bossDisplayName} — 내 설정을 지우고 인게임 목록 기준으로 되돌립니다`}
            aria-label={`${plan.bossDisplayName} 내 설정을 지우고 인게임 목록 기준으로 되돌리기`}
            onClick={() => onReset(plan)}
          >
            <RotateCcw aria-hidden size={14} />
          </Button>
        )}
      </div>
    </li>
  );
}

/** 빈 목록 상수 — 매 렌더 새 배열을 만들면 하위 memo 가 전부 무효화된다. */
const EMPTY_CHARACTERS: readonly ChecklistCharacter[] = [];
const EMPTY_PARTIES: readonly PlanRunParty[] = [];

export interface BossPlanWorkspaceProps {
  /** `?characterId=` 로 지정된 초기 선택. **선택 상태**이지 데이터가 아니라 props 가 맞다. */
  readonly initialCharacterId: string | null;
  /** 이번 주차. 내 파티 목록의 캐시 키에 들어간다(응답에 그 주 일정 건수가 실린다). */
  readonly weekKey: WeekKey;
  /** 이번 주(KST 목 00:00 → 다음 목 00:00). 서버가 계산한다 — 클라이언트에서 `new Date()`
   *  로 만들면 SSR 과 값이 달라 하이드레이션이 어긋난다. */
  readonly range: TimeRange;
}

export function BossPlanWorkspace({
  initialCharacterId,
  weekKey,
  range,
}: BossPlanWorkspaceProps) {
  const queryClient = useQueryClient();
  const searchId = useId();

  /**
   * ★ **추적 캐릭터도 파티도 props 가 아니다** (§2.4 Rule 1).
   *   예전에는 서버 컴포넌트가 둘 다 읽어 내려보냈고, 그래서 캐릭터를 추가/해제하거나
   *   파티를 새로 만들어도 이 화면은 새로고침 전까지 낡은 목록을 보여 줬다.
   *
   *   캐릭터는 **체크리스트 쿼리에서 갈라 쓴다.** 같은 응답에 이미 들어 있는 값이라
   *   두 번째 엔드포인트를 만들면 두 화면이 다른 명단을 볼 수 있게 된다.
   *
   *   티어는 둘 다 db(60초). **넥슨 호출 0건** — 우리 DB 만 읽는다.
   */
  const checklistQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.bossPlans.checklist()),
    queryFn: async () => (await fetchWeeklyChecklist()).characters,
  });

  const characters = useMemo<readonly ChecklistCharacter[]>(
    () =>
      checklistQuery.data === undefined
        ? EMPTY_CHARACTERS
        : checklistQuery.data.map((entry) => entry.character),
    [checklistQuery.data],
  );

  /**
   * **내가 속한 파티만.** 일정 등록은 파티 구성원만 할 수 있어서(서버가 403 으로 거른다)
   * 남의 공개 파티는 후보가 아니다. `/api/schedule/parties` 는 "볼 수 있는 것"을 주므로
   * 공개 파티가 섞인다 — 그래서 전용 경로(`/api/schedule/parties/mine`)를 쓴다.
   */
  const myPartiesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.mine(weekKey)),
    queryFn: () => fetchMyParties(weekKey),
  });

  const parties = myPartiesQuery.data ?? EMPTY_PARTIES;

  const [selectedId, setSelectedId] = useState<string | null>(
    initialCharacterId ?? characters[0]?.characterId ?? null,
  );
  const [query, setQuery] = useState("");
  /** 추가한 뒤 검색어를 비우고 **포커스를 돌려놓기 위한** 참조. 아래 `addPlan` 참고. */
  const searchRef = useRef<HTMLInputElement>(null);
  /**
   * 방금 계획에 넣은 보스 이름. `null` 이면 아무것도 그리지 않는다.
   *
   * 이 화면은 검색어가 비면 후보 목록이 **통째로 사라진다**(`matchesBoss` 가 빈 검색어에
   * false 를 준다). 추가 직후 검색어를 비우면 목록이 사라지는데, 새 행은 낙관적이 아니라
   * 서버 응답 뒤에야 왼쪽 계획 목록에 나타난다 — 그 사이가 "눌리긴 한 건가"가 된다.
   * 그래서 무엇을 넣었는지 한 줄로 말한다.
   */
  const [addedNotice, setAddedNotice] = useState<string | null>(null);
  /**
   * 일정 모달의 대상 계획. `null` 이면 모달 자체를 **렌더하지 않는다** —
   * 열 때마다 새로 마운트되므로 폼 초안이 이전 보스의 값을 물고 있지 않고,
   * 모달 내부의 `new Date()`(오늘 날짜 기본값)가 서버 렌더에 끼어들지도 않는다.
   */
  const [runPlan, setRunPlan] = useState<CharacterBossPlan | null>(null);
  /**
   * 되돌리기 확인 대상. `null` 이면 확인창을 렌더하지 않는다.
   *
   * 확인을 받는 이유는 **결과가 행마다 다르기 때문**이다 — 넥슨이 등록 중인 보스는 다시
   * 켜지고, 손으로 추가한 보스는 목록에서 사라진다. 어느 쪽인지 모른 채 누르게 두면
   * "지웠는데 되살아났다"는 바로 그 경험이 반복된다.
   */
  const [resetTarget, setResetTarget] = useState<CharacterBossPlan | null>(null);
  /**
   * **서버가 거절할 것을 누르기 전에 말한 문장.** `null` 이면 아무것도 그리지 않는다.
   *
   * 상태로 들고 있는 이유: 이것은 뮤테이션의 실패가 아니라 **뮤테이션을 아예 하지 않은
   * 사실**이라 `useMutation` 어디에도 담길 자리가 없다. 다음 조작에서 비운다 — 해소된
   * 뒤에도 남아 있으면 그때부터는 틀린 말이다.
   */
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);

  const selectedCharacter =
    characters.find((entry) => entry.characterId === selectedId) ?? null;

  const planQuery = useQuery({
    // 티어: db(60초) — 사람이 켜고 끄는 값이라 뮤테이션 후 무효화가 신선도를 진다.
    ...dbQueryOptions(queryKeys.db.bossPlans.character(selectedId ?? "none")),
    queryFn: () => fetchCharacterPlans(selectedId ?? ""),
    enabled: selectedId !== null,
  });

  /*
    보스 카탈로그는 **쿼리가 아니다.** 게임 패치 때만 바뀌는 값이라 코드 상수로
    내려왔다(`@/lib/boss-master`, 발주자 지시 2026-08-18). 일간 제외와 최신 우선
    정렬의 소유자는 여전히 하나이며 그 자리가 `getTrackedBossCatalog()` 로 옮겨졌다.
  */
  const bossCatalog = getTrackedBossCatalog();

  /**
   * 성공 응답이 갱신된 번들을 그대로 주므로 재조회 왕복이 없다.
   *
   * 무효화 대상이 셋인 이유:
   * - **계획**: 이 화면. 응답 번들을 그대로 심으므로 재조회가 없다.
   * - **체크리스트**: 대시보드가 같은 데이터에서 나온다.
   * - **수익**: 인원수는 결정석 1/n 의 분모다. 계획만 바꾼 경우 이미 쌓인 금액은 그대로지만,
   *   사용자에게는 "인원을 고쳤다"가 하나의 행위라 수익 화면이 다음에 열릴 때 반드시
   *   최신이어야 한다. 비용은 우리 DB 조회 한 번이다.
   */
  function applyBundle(bundle: CharacterPlanResponse): void {
    if (selectedId === null) return;
    queryClient.setQueryData<CharacterPlanResponse>(
      queryKeys.db.bossPlans.character(selectedId),
      bundle,
    );
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.bossPlans.checklist(),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.income.root(),
    });
    /*
     * ★ 대시보드도. 수익 카드와 12칸 분모가 같은 원장에서 나온다. 예전에는 대시보드가
     *   서버 컴포넌트라 캐시 밖이었고, 그래서 홈으로 돌아가면 낡은 숫자가 그대로였다.
     */
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.dashboard.root(),
    });
  }

  /**
   * 롤백 문장에 쓰는 보스 이름. **`하드 스우` 처럼 사람이 아는 이름이어야 한다** —
   * `boss_difficulties.id` 를 그대로 보여 주면 "무엇이 되돌아갔는지"를 말한 것이 아니다.
   * 계획 목록에 없으면(보스 추가 경로) 카탈로그에서 찾고, 그것도 없으면 id 로 떨어진다.
   */
  function planLabel(bossDifficultyId: string): string {
    const fromPlan = planQuery.data?.plans.find(
      (plan) => plan.bossDifficultyId === bossDifficultyId,
    );
    if (fromPlan !== undefined) return fromPlan.bossDisplayName;
    const fromCatalog = bossCatalog.find(
      (boss) => boss.bossDifficultyId === bossDifficultyId,
    );
    return fromCatalog?.koreanName ?? bossDifficultyId;
  }

  /**
   * 켜기 / 끄기 — **낙관적**.
   *
   * ── 어느 캐시를 함께 덮는가 ─────────────────────────────────────────────────
   * 이 화면에 동시에 떠 있는 캐시는 `db.bossPlans.character(선택 캐릭터)` **하나**다.
   * 그래서 낙관적 패치도 하나면 충분하고, 그 안에서 목록과 진행 상황 숫자가
   * `recountProgress()` 로 **같은 배열에서** 다시 나오므로 서로 어긋날 수 없다.
   *
   * 화면 밖 캐시(체크리스트 칩 · 대시보드 12칸 · 수익 원장)는 `applyBundle` 이 예전처럼
   * 무효화만 한다 — 보이지 않는 것은 어긋나 보일 수 없고, 다음 진입 전에 정답이 된다.
   * (계획 화면의 캐릭터 칩은 `db.bossPlans.checklist()` 를 읽지만 그 칩은 이름뿐이라
   *  계획을 켜고 꺼도 한 글자도 바뀌지 않는다.)
   *
   * ── 새로 추가하는 보스는 낙관적 대상이 아니다 ──────────────────────────────
   * 목록에 행이 없으면 `planId` 를 서버가 만든다. 클라이언트가 지어낸 id 로 줄을 그리면
   * 그 줄의 버튼이 존재하지 않는 행을 가리킨다 — §1.4 의 번호 규칙과 같은 이유로 하지
   * 않는다. 그때는 패치가 빈 배열이고, 예전처럼 응답을 기다린다.
   */
  const setPlan = useOptimisticMutation({
    mutationFn: setCharacterBossPlan,
    optimistic: (input) => {
      if (selectedId === null) return [];
      const key = queryKeys.db.bossPlans.character(selectedId);
      const bundle =
        queryClient.getQueryData<CharacterPlanResponse>(key) ?? null;
      const exists =
        bundle?.plans.some(
          (plan) => plan.bossDifficultyId === input.bossDifficultyId,
        ) ?? false;
      if (!exists) return [];
      return [
        cachePatch<CharacterPlanResponse>(key, (current) =>
          withPlanActive(
            current,
            input.bossDifficultyId,
            input.active,
            new Date().toISOString(),
          ),
        ),
      ];
    },
    rollbackTitle: "보스 계획을 저장하지 못했습니다",
    rollbackDescription: (input) =>
      `${planLabel(input.bossDifficultyId)} 을(를) ${input.active ? "켜려던" : "끄려던"} 것을 되돌렸습니다.`,
    onSuccess: applyBundle,
  });

  /** 내 판단을 지우고 인게임 목록에 맡긴다. 성공하면 확인창을 닫는다. */
  const resetPlan = useMutation({
    mutationFn: resetCharacterBossPlanToApi,
    onSuccess: (bundle) => {
      applyBundle(bundle);
      setResetTarget(null);
    },
  });

  /**
   * 인원수 확정 — **낙관적**. `null` 은 기본값 1로 되돌리기다. 이미 쌓인 클리어는 이
   * 경로로 바뀌지 않으며, 그쪽은 한 건씩 직접 고친다(일괄 소급 경로는 제거됨).
   *
   * 이 값은 화면 안에서 세 곳을 동시에 움직인다 — 그 줄의 숫자, `인원수를 정하지 않은
   * 보스 N개`, `최대 파티 인원을 넘긴 항목 N개`. 뒤의 둘은 이미 `activePlans` 에서
   * 파생되므로, 계획 배열 하나만 낙관적으로 고치면 **셋이 자동으로 같은 말을 한다.**
   */
  const setPartySize = useOptimisticMutation({
    mutationFn: setCharacterBossPlanPartySize,
    optimistic: (input) => {
      if (selectedId === null) return [];
      return [
        cachePatch<CharacterPlanResponse>(
          queryKeys.db.bossPlans.character(selectedId),
          (current) =>
            withPlanPartySize(
              current,
              input.bossDifficultyId,
              input.partySize,
            ),
        ),
      ];
    },
    rollbackTitle: "인원수를 저장하지 못했습니다",
    rollbackDescription: (input) =>
      // `null` 은 "해제"가 아니라 **기본값 1로 되돌리기**다(2026-08-19).
      input.partySize === null
        ? `${planLabel(input.bossDifficultyId)} 의 인원수를 기본값 ${String(PARTY_SIZE_DEFAULT)}인으로 되돌리려던 것을 취소했습니다.`
        : `${planLabel(input.bossDifficultyId)} 의 인원수를 ${String(input.partySize)}인으로 바꾸려던 것을 되돌렸습니다.`,
    onSuccess: applyBundle,
  });

  const sync = useMutation({
    mutationFn: syncCharacterScheduler,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      // 동기화는 클리어까지 반영한다 → 수익 원장과 대시보드 요약이 함께 움직인다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.income.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
    },
  });

  const plans = useMemo(() => planQuery.data?.plans ?? [], [planQuery.data]);
  const progress = planQuery.data?.progress ?? null;
  const snapshot = planQuery.data?.snapshot ?? null;

  const plannedIds = useMemo(
    () => new Set(plans.map((plan) => plan.bossDifficultyId)),
    [plans],
  );

  const normalizedQuery = normalizeQuery(query);
  /**
   * 검색어에 걸린 후보 **전부**.
   *
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **자르지 않는다.** 예전에는 `.slice(0, 8)` 이 걸려 있었다.
   *   ═══════════════════════════════════════════════════════════════════════
   *   카탈로그는 54건인데 8건만 배열에 담기니, 아래 `<ul>` 이 스크롤되는데도
   *   `노멀 림보`(역정렬 17번째)에는 **스크롤로도 닿을 수 없었다.**
   *   발주자 지적(2026-08-18): *"아니 스크롤해서 보이게 해야된다고"*.
   *   결함은 목록 높이가 아니라 **조용한 잘라내기**였다. 수십 건은 가상 스크롤
   *   없이도 아무 문제 없으니 과하게 최적화하지 말 것.
   *   (같은 결함이 `party-boss-picker.tsx` · `run-composer.tsx` 에도 있었고 함께 고쳤다.)
   */
  const candidates = useMemo(
    () =>
      bossCatalog
        .filter((boss) => matchesBoss(boss, normalizedQuery))
        .filter((boss) => !plannedIds.has(boss.bossDifficultyId)),
    [bossCatalog, normalizedQuery, plannedIds],
  );

  /*
   * ★ **`isBusy` 가 없어졌다.** 예전에는 `setPlan.isPending || setPartySize.isPending`
   *   이 목록 전체를 잠갔다. 두 뮤테이션이 낙관적이 된 지금 그 잠금은 손해만 남는다 —
   *   값은 이미 바뀌어 있는데 손댈 수 없는 상태가 200~800ms 지속된다.
   *
   * ★ **행 단위 실패 문구도 없앴다.** `setPlan` / `setPartySize` 의 실패는 이제
   *   롤백 알림(`@/lib/query/optimistic`)이 말한다. 여기 남기면 같은 사건을 두 번,
   *   그것도 값이 이미 되돌아간 뒤에 카드 위쪽에서 말하게 된다.
   *   낙관적이 **아닌** 되돌리기 경로는 자기 확인창 안에 문구가 있다.
   *
   * ★ 2026-08-19 — `mutationError`(소급 적용 미리보기 실패) 도 함께 사라졌다. 그 뮤테이션
   *   자체를 걷어냈기 때문이다. 이제 이 카드 위쪽에서 말하는 실패는 동기화뿐이다.
   */

  /**
   * 모달에 넘길 보스 마스터 항목. 결정석 솔로 기준가와 확정된 `max_party` 가 여기 있다.
   * 카탈로그는 코드 상수라 **요청이 아예 없다.**
   */
  const runBoss =
    runPlan === null
      ? null
      : (bossCatalog.find(
          (entry) => entry.bossDifficultyId === runPlan.bossDifficultyId,
        ) ?? null);

  const activePlans = plans.filter((plan) => plan.isActive);
  const inactivePlans = plans.filter((plan) => !plan.isActive);

  /**
   * 계획 줄의 `켜기` / `끄기`. **켜는 경우에만** 상한을 먼저 본다 — 끄기는 언제나
   * 통과한다(서버도 같다). 걸리면 호출도 낙관적 적용도 하지 않는다.
   */
  function togglePlan(target: CharacterBossPlan, active: boolean): void {
    if (selectedCharacter === null) return;
    if (active) {
      const reason = weeklySlotBlockReason({
        cycle: target.cycle,
        bossDisplayName: target.bossDisplayName,
        isAlreadyActive: target.isActive,
        progress,
      });
      if (reason !== null) {
        setBlockedNotice(reason);
        return;
      }
    }
    setBlockedNotice(null);
    setPlan.mutate({
      characterId: selectedCharacter.characterId,
      bossDifficultyId: target.bossDifficultyId,
      active,
    });
  }

  /** `보스 추가` 목록에서 새 보스를 켠다. 새 행은 서버가 만들므로 낙관적 대상이 아니다. */
  function addPlan(boss: BossCatalogEntry): void {
    if (selectedCharacter === null) return;
    const reason = weeklySlotBlockReason({
      cycle: boss.cycle,
      bossDisplayName: boss.koreanName,
      isAlreadyActive: false,
      progress,
    });
    if (reason !== null) {
      setBlockedNotice(reason);
      return;
    }
    setBlockedNotice(null);
    setPlan.mutate(
      {
        characterId: selectedCharacter.characterId,
        bossDifficultyId: boss.bossDifficultyId,
        active: true,
      },
      // 실패하면 아래 안내는 **틀린 말**이 된다. 롤백 토스트가 실패를 따로 말한다.
      { onError: () => setAddedNotice(null) },
    );
    /*
      **실제로 추가한 경우에만** 검색어를 비운다 — 위 상한 차단으로 돌아가는 길에서는
      아무 일도 일어나지 않았으므로 검색어를 지우면 사용자가 친 것만 잃는다.
      보스는 연달아 여러 개를 넣는 것이 정상이라, 남은 검색어를 매번 손으로 지우게 두지
      않는다. 포커스는 입력으로 돌려놓는다(마우스로 눌렀어도) — 방금 누른 행은 후보에서
      빠져 사라지므로 그냥 두면 포커스가 문서로 떨어진다.
    */
    setQuery("");
    setAddedNotice(boss.koreanName);
    searchRef.current?.focus();
  }

  /*
   * ★ 2026-08-19 삭제 — `unsetPartySizeCount` ("인원수를 아직 정하지 않은 보스 N개").
   *   "정하지 않음"과 "1인으로 정함"이 하나의 상태가 되면서(발주자 지시) 이 개수는
   *   구조적으로 언제나 0 이 된다. 언제나 0 인 숫자를 세는 코드와 절대 뜨지 않는 문단은
   *   그 자체로 결함이라 지웠다.
   *   ⚠️ 그래서 §1.3 D3 의 과대 계상을 **개수로 경고하던 자리가 사라졌다.** 규칙 고지는
   *      목록 위 안내 문장 한 곳에만 남는다. 발주자가 알고 내린 결정이다.
   */

  /** §1.3 D5 — `max_party` 초과는 막지 않고 개수로만 알린다. 문장은 카드에 한 번만 둔다. */
  const overMaxPartyCount = activePlans.filter(
    (plan) => plan.maxParty !== null && plan.defaultPartySize > plan.maxParty,
  ).length;

  /*
   * 상태 셋(§0.3). 하이드레이션이 정상이면 명단은 첫 렌더부터 있으므로 아래 두 분기는
   * 캐시가 빈 예외 경로에서만 보인다 — "추적 0명"과 "아직 못 받았다"를 같은 화면으로
   * 그리면 안 되기 때문에 분리한다.
   */
  if (checklistQuery.isError && checklistQuery.data === undefined) {
    return (
      <ErrorState
        title="캐릭터 목록을 불러오지 못했습니다"
        detail={checklistQuery.error.message}
        onRetry={() => void checklistQuery.refetch()}
      />
    );
  }

  if (checklistQuery.data === undefined) {
    return (
      <SkeletonGroup label="추적 캐릭터를 불러오는 중">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </SkeletonGroup>
    );
  }

  if (characters.length === 0) {
    return (
      <EmptyState
        icon={<UserRound size={24} />}
        title="추적 중인 캐릭터가 없습니다"
        description="보스 계획은 캐릭터에 속합니다. 먼저 추적할 캐릭터를 골라 주세요 — 고른 캐릭터만 인게임 스케줄러와 동기화됩니다."
        action={
          <Link href="/">
            <Button variant="secondary" size="sm">
              <UserRound aria-hidden size={16} />
              홈에서 캐릭터 선택하기
            </Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 캐릭터 선택 — 12개 상한이 캐릭터당이라 화면도 캐릭터 단위다. */}
      <div className="flex flex-wrap items-center gap-2">
        {/*
          ★ 개수는 **목록과 같은 배열**에서 센다. 페이지 헤더에 서버가 센 값을 박아 두면
            캐릭터를 추가·해제한 뒤 숫자와 칩 개수가 서로 다른 말을 한다.
        */}
        <span className="text-body-sm text-ink-muted tabular-nums">
          추적 캐릭터 {characters.length}명
        </span>
        {characters.map((entry) => (
          <FilterChip
            key={entry.characterId}
            selected={entry.characterId === selectedId}
            onClick={() => {
              setSelectedId(entry.characterId);
              // 상한 안내는 캐릭터마다 다르다. 남겨 두면 다른 캐릭터에 대해 틀린 말이 된다.
              setBlockedNotice(null);
              // 추가 안내도 마찬가지 — 다른 캐릭터 화면에서는 사실이 아니다.
              setAddedNotice(null);
            }}
          >
            {entry.name}
            {entry.isMain ? " · 본캐" : ""}
          </FilterChip>
        ))}
      </div>

      {selectedCharacter === null ? (
        <EmptyState
          title="캐릭터를 선택해 주세요"
          description="위에서 캐릭터를 고르면 그 캐릭터가 매주 가는 보스 목록이 표시됩니다."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ── 계획 목록 ─────────────────────────────────────────────────── */}
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <CardOverline>
                  {selectedCharacter.worldName ?? "월드 미상"}
                </CardOverline>
                <CardTitle className="text-body-lg">
                  {selectedCharacter.name} · 매주 가는 보스
                </CardTitle>
              </div>
              {/*
                키는 **이 캐릭터가 속한 넥슨 계정의 것**이어야 한다(§1.1 · §2.1).
                버튼이 `credentialId` 로 저장소에서 골라 쓰고, 없으면 조치를 안내한다.
              */}
              <SyncButton
                characterId={selectedCharacter.characterId}
                credentialId={selectedCharacter.credentialId}
                credentialLabel={selectedCharacter.credentialLabel}
                /* 서버가 그 계정 키를 보관 중이면 이 브라우저에 원문이 없어도 된다(§2.1.2).
                   빠뜨리면 키가 DB 에 있는데도 "등록되지 않았습니다"가 뜬다. */
                serverKeyAvailable={selectedCharacter.serverKeyAvailable}
                onSync={(input) => sync.mutate(input)}
                isPending={sync.isPending}
                label={snapshot === null ? "인게임에서 불러오기" : "새로고침"}
              />
            </div>

            {sync.isError ? (
              /*
                문구는 체크리스트와 **같은 표**에서 나온다(`sync-failure-message.ts`).
                화면마다 다른 문장을 내면 사용자가 같은 사건을 두 번 다르게 배운다.
              */
              <ErrorState
                title="인게임 스케줄러를 불러오지 못했습니다"
                description={formatSyncFailure(describeSyncFailure(sync.error))}
                className="py-6"
              />
            ) : null}

            {/*
              ── 13번째 주간 보스 예고 ────────────────────────────────────────
              **서버가 거절할 것을 누르기 전에 말한다**(발주자 지시, 2026-08-18).
              낙관적으로 켰다가 롤백하면 목록이 깜빡이고, 사용자는 무엇이 잘못됐는지
              모른 채 "안 눌렸다"고 읽는다. 그래서 이 경우만은 낙관적 적용도 호출도
              하지 않고 이유를 즉시 보여 준다.
              §4: 이것은 실패가 아니라 **조치가 필요한 상태**라 red 가 아니라 tertiary
              orange 이고, 주황은 배경·아이콘이 지고 **문장은 잉크**가 진다.
            */}
            {blockedNotice === null ? null : (
              <p
                role="status"
                className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink"
              >
                <TriangleAlert
                  aria-hidden
                  size={16}
                  className="mt-0.5 shrink-0 text-tertiary"
                />
                <span>{blockedNotice}</span>
              </p>
            )}

            {planQuery.isError ? (
              <ErrorState
                title="보스 계획을 불러오지 못했습니다"
                onRetry={() => void planQuery.refetch()}
              />
            ) : planQuery.isLoading ? (
              <SkeletonGroup label="보스 계획을 불러오는 중">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </SkeletonGroup>
            ) : plans.length === 0 ? (
              <EmptyState
                icon={<Swords size={24} />}
                title="등록된 보스가 없습니다"
                description="인게임 스케줄러에서 불러오면 이 캐릭터가 등록해 둔 보스가 그대로 들어옵니다. 오른쪽에서 직접 추가할 수도 있습니다."
                className="py-8"
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <p className="text-body-sm text-ink-muted">
                    켜져 있음 {activePlans.length}개 —{" "}
                    <strong className="font-semibold text-ink-label">
                      보스 줄을 누르면 그 보스로 일정을 잡습니다.
                    </strong>{" "}
                    숫자 칸은 그 보스를 몇 인으로 도는지이며, 결정석이 그 수로
                    나뉩니다.{" "}
                    {/*
                      ★ **"1인 기준" 고지 — 이제 이곳이 유일한 자리다** (발주자 지시,
                        2026-08-19: *"그냥 1인을 기본으로 잡아 굳이 1이라고 설정안하게"*).
                        기본값이 1인 확정이 되면서 오른쪽 카드의 `정하지 않은 보스 N개`
                        문단과 수익 화면의 `확인 필요` 배지가 함께 사라졌다.
                        ⚠️ 그래서 §1.3 D3 의 과대 계상을 알리는 문장이 화면 전체에서
                          **이 한 줄뿐**이다. 지우지 말 것 — 2인 파티로 도는 사람에게
                          기본값 1 은 곧 수익 2배 과대 계상이다.
                    */}
                    <strong className="font-semibold text-ink-label">
                      기본값은 1인이라, 손대지 않은 보스는 클리어가 1인(솔로) 기준으로
                      기록됩니다.
                    </strong>{" "}
                    안 갈 보스는 <strong>끄기</strong>로 빼면 되고, 한 번 끄면 인게임
                    목록을 다시 불러와도 켜지지 않습니다.
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {activePlans.map((plan) => (
                      <PlanRow
                        key={plan.planId}
                        plan={plan}
                        onSchedule={setRunPlan}
                        onPartySize={(target, size) =>
                          setPartySize.mutate({
                            characterId: selectedCharacter.characterId,
                            bossDifficultyId: target.bossDifficultyId,
                            partySize: size,
                          })
                        }
                        onToggle={(target) => togglePlan(target, false)}
                        onReset={setResetTarget}
                      />
                    ))}
                  </ul>
                </div>

                {inactivePlans.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {/* 이것은 라벨이 아니라 **문장**이다 → 14px 하한(§4). */}
                    <p className="text-body-sm text-ink-label">
                      꺼 둔 항목 {inactivePlans.length}개 — 목록에는 남아 있고
                      진행률과 12개 카운터에서만 빠집니다. 동기화해도 다시 켜지지
                      않습니다.
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {inactivePlans.map((plan) => (
                        <PlanRow
                          key={plan.planId}
                          plan={plan}
                          onSchedule={setRunPlan}
                          onPartySize={(target, size) =>
                            setPartySize.mutate({
                              characterId: selectedCharacter.characterId,
                              bossDifficultyId: target.bossDifficultyId,
                              partySize: size,
                            })
                          }
                          onToggle={(target) => togglePlan(target, true)}
                          onReset={setResetTarget}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          {/* ── 진행 상황 + 보스 추가 ─────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-4">
            <Card className="flex flex-col gap-3">
              <CardTitle className="text-body-lg">이번 주 진행 상황</CardTitle>

              {progress === null ? (
                <p className="text-body-sm text-ink-muted">
                  아직 계획이 없어 집계할 것이 없습니다.
                </p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2">
                      <dt className="text-caption text-ink-muted">계획</dt>
                      <dd className="text-body-lg font-semibold text-ink tabular-nums">
                        {progress.plannedTotal}개
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2">
                      <dt className="text-caption text-ink-muted">클리어</dt>
                      <dd className="text-body-lg font-semibold text-ink tabular-nums">
                        {progress.clearedTotal}개
                      </dd>
                    </div>
                  </dl>

                  {/*
                    월간이 몇 개인지만 말한다. 카운터 제외 문구는 발주자 지시로 뺐다
                    (2026-08-18 — 주간 체크리스트에서 먼저 제거된 것과 같은 결정).
                  */}
                  <p className="text-body-sm text-ink-muted">
                    주간 보스 {progress.plannedWeekly}개 중{" "}
                    {progress.clearedWeekly}개 완료 · 남은{" "}
                    {progress.remainingWeekly}개
                    {progress.plannedMonthly > 0
                      ? ` (월간 ${progress.plannedMonthly}개)`
                      : ""}
                  </p>

                  {/*
                    12개 상한 경고.
                    ★ 이제 서버가 13번째 **켜기**를 거절한다(발주자 지시, 2026-08-18).
                      그래도 이 경고는 남는다 — 동기화가 넣는 `api_registered` 는 막을 수
                      없어서 인게임 목록만으로도 초과 상태가 될 수 있고, **이미 넘어 있는
                      계획을 우리가 잘라내지 않기** 때문이다. 어느 것을 끌지는 사용자가 정한다.
                    ★ 그래서 문구는 "몇 개를 꺼야 하는지"를 말한다.
                    ★ §4 대로 red 가 아니라 **tertiary orange** 이고, 주황은 배경과
                      아이콘이 지고 **문장은 잉크**가 진다(주황 본문은 라이트에서 AA 미달).
                  */}
                  {progress.weeklyOverLimit ? (
                    <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      <TriangleAlert
                        aria-hidden
                        size={16}
                        className="mt-0.5 shrink-0 text-tertiary"
                      />
                      <span>
                        주간 보스 {progress.plannedWeekly}개는 상한(
                        {progress.weeklyLimit}개)을 넘습니다. 넘긴 만큼은 입장
                        자체가 불가능하니{" "}
                        <strong className="font-semibold">
                          {progress.plannedWeekly - progress.weeklyLimit}개를 꺼
                          주세요.
                        </strong>{" "}
                        상한을 넘긴 동안에는 주간 보스를 새로 켤 수 없습니다. 월간
                        보스는 이 개수에 들어가지 않습니다.
                      </span>
                    </p>
                  ) : (
                    <p className="text-body-sm text-ink-muted">
                      남은 슬롯 {progress.weeklySlotsRemaining}개 / 상한{" "}
                      {progress.weeklyLimit}개
                    </p>
                  )}

                  {/*
                    ── 인게임 목록과의 차이 요약 ──────────────────────────────
                    **행마다 배지를 도배하지 않고 여기서 한 번만** 말한다(수익 화면에서
                    검증된 처방). 그리고 두 상태는 성격이 아예 다르므로 문단도 다르다:

                    · `diverged` — 넥슨이 **나중에** 관측했는데도 값이 다르다. 우리는
                      인게임 스케줄러에 쓸 수 없으므로(§1.1) 조치는 사용자 몫이고,
                      그래서 문구가 **무엇을 해야 하는지**를 말한다. 색은 §4 대로
                      tertiary orange — 배경·아이콘이 주황을 지고 **문장은 잉크**다.
                    · `pending` — 우리 설정이 더 최신이라 아직 게임에 안 들어갔다.
                      **경고가 아니다.** 넥슨 데이터는 ~15분 늦고 전날치는 다음 날
                      02:00 에 들어오므로(§1.1) 이렇게 보이는 것이 정상이며, 그 사실을
                      문장으로 알려 준다. 주황도 아이콘도 쓰지 않는다.
                  */}
                  {progress.conflictDivergedCount > 0 ? (
                    <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      <TriangleAlert
                        aria-hidden
                        size={16}
                        className="mt-0.5 shrink-0 text-tertiary"
                      />
                      <span>
                        {divergedSummarySentence(progress.conflictDivergedCount)}
                      </span>
                    </p>
                  ) : null}

                  {progress.conflictPendingCount > 0 ? (
                    <p className="text-body-sm text-ink-muted">
                      {pendingSummarySentence(progress.conflictPendingCount)}
                    </p>
                  ) : null}

                  {/*
                    ── 인원수 요약 ─────────────────────────────────────────────
                    줄마다 문장을 달면 목록이 글자밭이 되므로, **개수는 여기서 한 번만**
                    말한다. 줄에는 아이콘과 스크린리더 문장만 남겨 두었다.
                  */}
                  {/*
                    ★ 2026-08-19 삭제 — `인원수를 아직 정하지 않은 보스 N개` 문단.
                      기본값이 1인 확정이 되면서 N 이 언제나 0 이라 영원히 렌더되지 않는다.
                      규칙 고지는 목록 위 안내 문장에 한 번만 남는다(§1.3 D3 의 위험은
                      그대로지만 발주자가 경고를 없애기로 했다).
                  */}
                  {overMaxPartyCount > 0 ? (
                    /*
                      §1.3 D5 — `max_party` 는 대부분 추정치라 **막지 않는다.**
                      §4 대로 색은 red 가 아니라 tertiary orange 이고, 주황은 배경·아이콘이
                      지고 **문장은 잉크**가 진다.
                    */
                    <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      <TriangleAlert
                        aria-hidden
                        size={16}
                        className="mt-0.5 shrink-0 text-tertiary"
                      />
                      <span>
                        최대 파티 인원을 넘긴 항목이 {overMaxPartyCount}개
                        있습니다. 저장은 막지 않습니다 — 보스별 최대 인원은
                        상당수가 추정값이라, 실제 입장 인원이 맞다면 그대로 두셔도
                        됩니다.
                      </span>
                    </p>
                  ) : null}

                  {/*
                    ── ★ 2026-08-19 삭제 — `쌓인 클리어에 인원수 적용` 버튼과 확인창 ──
                    DB 함수의 대상 조건이 `boss_clears.party_size_confirmed = false` 인데,
                    기본 인원 1인 확정(마이그레이션 25) 이후 미확인 행이 하나도 남지 않아
                    미리보기가 **항상 0건**이었다. 눌러도 아무 일이 없는 버튼은 사용자에게
                    "고장났다"로 읽히므로 없는 편이 낫다.
                    이미 쌓인 클리어의 인원은 이제 **한 건씩 개별 수정**한다
                    (발주자 지시 2026-08-19: *"개별수정 가능하도록해"*).
                    DB 함수 `apply_plan_party_sizes_to_clears()` 자체는 남겨 두었다 —
                    대상 조건을 "계획 인원 ≠ 클리어 인원"으로 바꿔 되살릴 여지가 있고,
                    지우는 쪽이 되돌리기 어렵다(마이그레이션 26 이 그 사실을 COMMENT 에 적었다).
                  */}
                </>
              )}

              {/*
                ⚠️ `snapshotAt` 이 아니라 `fetchedAt` 을 그린다 — 앞엣것은 넥슨 응답의
                   `date` 라 날짜 단위여서 시각이 영원히 `00:00` 이고, 새로고침을 눌러도
                   안 움직여 "동기화가 안 됐나"로 읽힌다. 체크리스트에서 나온 지적을
                   같은 결함이 있는 이 자리에도 함께 적용했다(2026-08-27).
                   관측일은 불러온 날과 다를 때만 덧붙는다 — 그때가 "왜 방금 잡은 게
                   안 보이지"의 답이다(§1.1: 로그인을 안 했으면 어제 날짜가 온다).
              */}
              {snapshot === null ? null : (
                <SnapshotFreshnessLine
                  snapshotAtIso={snapshot.snapshotAt}
                  fetchedAtIso={snapshot.fetchedAt}
                  weeklyBossClearCount={snapshot.weeklyBossClearCount}
                  weeklyBossClearLimitCount={snapshot.weeklyBossClearLimitCount}
                />
              )}
            </Card>

            <Card className="flex flex-col gap-3">
              <CardTitle className="text-body-lg">보스 추가</CardTitle>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={searchId}>보스 검색</Label>
                <div className="relative">
                  <Search
                    aria-hidden
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
                  />
                  <Input
                    id={searchId}
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      // 다시 찾기 시작하면 직전 추가 안내는 지난 이야기다.
                      setAddedNotice(null);
                    }}
                    placeholder="이름 또는 별칭 — 하카, 하스우, 익세"
                    className="pl-9"
                    autoComplete="off"
                  />
                </div>
                <HelperText>
                  난이도까지 골라야 합니다 — &ldquo;스우&rdquo;가 아니라
                  &ldquo;하드 스우&rdquo;입니다.
                  {/*
                    ★ 주간 슬롯이 다 찼다는 사실을 **누르기 전에** 말한다. 위 목록의
                      차단 문장은 눌렀을 때 나오므로, 이 카드에서 검색부터 하는 사람은
                      그 전에 알 수 없다. 값은 뷰가 낸 `weeklySlotsRemaining` 그대로다.
                  */}
                  {progress !== null && progress.weeklySlotsRemaining === 0
                    ? ` 주간 보스 슬롯이 다 찼습니다(${String(progress.plannedWeekly)}/${String(progress.weeklyLimit)}) — 주간 보스를 새로 켜려면 목록에서 먼저 하나를 꺼 주세요. 월간 보스는 지금도 추가할 수 있습니다.`
                    : ""}
                </HelperText>
              </div>

              {/*
                ★ 로딩·오류 분기는 없앴다. 보스 목록은 **코드 상수**라
                  (`@/lib/boss-master`) 늦게 오지도 실패하지도 않는다. 도달할 수 없는
                  분기를 남겨 두면 다음 사람이 그것을 사실로 읽는다.
              */}
              {normalizedQuery === "" ? (
                addedNotice === null ? (
                  <HelperText>
                    이름을 입력하면 추가할 수 있는 보스가 나옵니다.
                  </HelperText>
                ) : (
                  /*
                    추가 직후. 실패가 아니라 **완료된 조치**라 주황이 아니라 primary 계열
                    이고(§4), 문장은 잉크가 진다. `role="status"` 로 스크린리더에도 알린다.
                  */
                  <p
                    role="status"
                    className="flex items-start gap-2 rounded-md border border-border bg-primary-subtle px-3 py-2 text-body-sm text-ink"
                  >
                    <CheckCircle2
                      aria-hidden
                      size={16}
                      className="mt-0.5 shrink-0 text-primary"
                    />
                    <span>
                      <strong className="font-semibold">{addedNotice}</strong>
                      (을)를 계획에 넣었습니다. 이어서 다른 보스를 찾을 수 있습니다.
                    </span>
                  </p>
                )
              ) : candidates.length === 0 ? (
                <HelperText>
                  일치하는 보스가 없거나 이미 목록에 있습니다.
                </HelperText>
              ) : (
                <ul className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border">
                  {candidates.map((boss) => (
                    <ListItem
                      key={boss.bossDifficultyId}
                      icon={<Plus aria-hidden size={16} />}
                      onClick={() => addPlan(boss)}
                      trailing={
                        <span className="text-caption text-ink-muted">
                          {CYCLE_LABEL[boss.cycle]}
                        </span>
                      }
                    >
                      {/*
                        아이콘 슬롯은 `Plus` 가 지킨다 — 이 목록의 행위는 "추가"이고,
                        그 신호를 보스 그림으로 덮으면 무엇을 하는 줄인지 흐려진다.
                        보스 아이콘은 이름 옆에 둔다.
                      */}
                      <span className="flex min-w-0 items-center gap-2">
                        <BossIcon
                          bossDifficultyId={boss.bossDifficultyId}
                          difficulty={boss.difficulty}
                          size="sm"
                        />
                        <span className="truncate">{boss.koreanName}</span>
                      </span>
                    </ListItem>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {/*
        계획 → 일정을 잇는 다리. 대상 계획이 정해졌을 때만 마운트한다(위 상태 주석 참고).
        닫으면 계획 목록으로 그대로 돌아온다 — 이 화면을 떠나지 않는다.
      */}
      {runPlan !== null && selectedCharacter !== null ? (
        <PlanRunDialog
          open
          onClose={() => setRunPlan(null)}
          plan={runPlan}
          character={selectedCharacter}
          boss={runBoss}
          parties={parties}
          range={range}
        />
      ) : null}

      {/*
        ── 되돌리기 확인창 ─────────────────────────────────────────────────────
        **결과가 행마다 다르므로 무엇이 일어날지 먼저 말한다.** 넥슨이 등록 중인 보스는
        다시 켜지고(의도된 동작이다), 손으로 추가한 보스는 목록에서 사라진다.
        그리고 "목록에서 빼려던 것"이라면 이 버튼이 아니라 `끄기` 라는 것도 함께 말한다 —
        예전 삭제 버튼이 되살아나던 경험이 여기서 반복되지 않게 하는 유일한 방법이다.
        §4: 주황은 배경·아이콘이 지고 **문장은 잉크**다. red 는 실패·취소 전용.
      */}
      {resetTarget !== null && selectedCharacter !== null ? (
        <Dialog
          open
          onClose={() => setResetTarget(null)}
          title="내 설정을 지우고 인게임 목록 기준으로 되돌릴까요?"
          description={`${resetTarget.bossDisplayName} 에 대해 여기서 켜고 끈 판단을 지웁니다.`}
        >
          <div className="flex flex-col gap-4">
            {resetTarget.apiRegistered === true ? (
              <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                <TriangleAlert
                  aria-hidden
                  size={16}
                  className="mt-0.5 shrink-0 text-tertiary"
                />
                <span>
                  이 보스는 <strong className="font-semibold">인게임 목록에
                  등록돼 있습니다.</strong>{" "}
                  내 설정을 지우면 인게임 기준을 따라{" "}
                  <strong className="font-semibold">다시 켜집니다.</strong> 목록에서
                  빼려는 것이라면 이 버튼이 아니라 <strong>끄기</strong>를 눌러
                  주세요 — 끄면 동기화해도 다시 켜지지 않습니다.
                </span>
              </p>
            ) : resetTarget.apiRegistered === false ? (
              <p className="text-body-sm text-ink-muted">
                이 보스는 인게임 목록에 등록돼 있지 않습니다. 내 설정을 지우면
                인게임 기준을 따라 꺼진 상태가 되고, 목록에는 남습니다. 나중에
                게임에서 등록하면 동기화 때 다시 켜집니다.
              </p>
            ) : (
              <p className="text-body-sm text-ink-muted">
                이 보스는 인게임 스케줄러에서 한 번도 관측된 적이 없습니다(직접
                추가한 항목입니다). 내 설정을 지우면{" "}
                <strong className="font-semibold">목록에서 사라지며</strong>,
                되살릴 인게임 값이 없으므로 동기화로 다시 나타나지 않습니다.
              </p>
            )}

            {resetPlan.isError ? (
              <ErrorState
                title="설정을 되돌리지 못했습니다"
                detail={resetPlan.error.message}
                className="py-6"
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={resetPlan.isPending}
                onClick={() =>
                  resetPlan.mutate({
                    characterId: selectedCharacter.characterId,
                    bossDifficultyId: resetTarget.bossDifficultyId,
                  })
                }
              >
                {resetPlan.isPending ? "되돌리는 중…" : "되돌리기"}
              </Button>
              <Button variant="ghost" onClick={() => setResetTarget(null)}>
                취소
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * 인게임 스냅샷 한 줄 — **언제 불러왔나**(+ 인게임 집계).
 *
 * 판정은 `describeSnapshotFreshness()` 한 곳에 있다. 체크리스트도 같은 함수를 쓰므로
 * 두 화면이 서로 다른 시각을 말할 수 없다 — 예전에는 양쪽이 각자 `snapshotAt` 을
 * 찍어서 둘 다 `00:00` 이었다.
 */
function SnapshotFreshnessLine({
  snapshotAtIso,
  fetchedAtIso,
  weeklyBossClearCount,
  weeklyBossClearLimitCount,
}: {
  readonly snapshotAtIso: string;
  readonly fetchedAtIso: string;
  readonly weeklyBossClearCount: number | null;
  readonly weeklyBossClearLimitCount: number | null;
}) {
  const freshness = describeSnapshotFreshness(snapshotAtIso, fetchedAtIso);

  return (
    <p
      className="text-caption text-ink-muted"
      title={`인게임 데이터 기준 ${formatKstFull(new Date(snapshotAtIso))}`}
    >
      <NumericText>{freshness.fetchedText}</NumericText> 불러옴
      {freshness.staleDayText === null ? null : (
        <>
          {" · "}
          <NumericText>{freshness.staleDayText}</NumericText> 데이터
        </>
      )}
      {weeklyBossClearCount !== null && weeklyBossClearLimitCount !== null
        ? ` · 인게임 집계 보스 ${String(weeklyBossClearCount)}/${String(weeklyBossClearLimitCount)}`
        : ""}
    </p>
  );
}
