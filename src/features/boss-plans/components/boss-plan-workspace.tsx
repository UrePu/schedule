"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Plus,
  Search,
  Swords,
  TriangleAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { BOSS_DIFFICULTY_BORDER_L, formatKstFull } from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
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
import { fetchBossCatalog } from "@/features/schedule/data";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { BossCatalogEntry, BossCycle, TimeRange } from "@/types/domain";

import {
  fetchCharacterPlans,
  removeCharacterBossPlan,
  setCharacterBossPlan,
  syncCharacterScheduler,
} from "../data";
import type {
  CharacterBossPlan,
  CharacterPlanResponse,
  ChecklistCharacter,
} from "../types";
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
 * 켜기/끄기와 삭제는 다르다
 * ─────────────────────────────────────────────────────────────────────────────
 * - **끄기**(`set_character_boss_plan(..., false)`): 목록에 남기고 진행률에서만 뺀다.
 *   "후보 15개를 올려 두고 12개만 켠다"가 정상 사용법이다(난제 16-3).
 * - **삭제**: 행 자체를 지운다. 난이도를 잘못 골라 추가한 것을 되돌리는 길이다.
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

/** 별칭까지 훑는 검색 — 봇의 `!등록 카룡` 과 같은 어휘를 화면에서도 쓴다. */
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
  readonly onRemove: (plan: CharacterBossPlan) => void;
  /** 행 자체를 누르면 그 보스로 일정을 잡는 모달이 열린다. */
  readonly onSchedule: (plan: CharacterBossPlan) => void;
  readonly isBusy: boolean;
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
 * 🖼️ **보스 이미지 자리**: 아래 `Swords` 아이콘 슬롯이 그 자리다. 넥슨 오픈 API 는 보스
 *    이미지를 주지 않고 `v_boss_catalog` 에도 이미지 컬럼이 없어 지금은 아이콘으로 채운다.
 *    에셋이 생기면 이 슬롯만 `<img>` 로 바꾸면 된다(레이아웃은 이미 24px 자리를 비워 뒀다).
 */
function PlanRow({
  plan,
  onToggle,
  onRemove,
  onSchedule,
  isBusy,
}: PlanRowProps) {
  return (
    <li
      className={cn(
        "relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-l-4",
        "border-border bg-surface px-3 py-2 transition duration-200",
        "hover:border-border-strong hover:bg-hover-surface",
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

      {/* 🖼️ 아이콘 슬롯 — 보스 이미지가 생기면 여기가 그 자리다. */}
      <Swords
        aria-hidden
        size={14}
        className={
          plan.isActive ? "shrink-0 text-primary" : "shrink-0 text-ink-placeholder"
        }
      />
      {/* `boss_difficulties.korean_name` — 이미 `하드 최초의 대적자` 형태다. */}
      <span
        className={
          plan.isActive
            ? "min-w-0 flex-1 truncate text-body-sm font-medium text-ink"
            : "min-w-0 flex-1 truncate text-body-sm text-ink-muted line-through"
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
          이번 주 완료
        </span>
      ) : null}

      {plan.countsTowardWeeklyLimit ? null : (
        // 일간·월간은 12 카운터 밖이다(§1). 같은 목록에 두되 그 사실을 한 줄에서 밝힌다.
        <span className="shrink-0 rounded-md border border-border bg-neutral-100 px-1.5 py-0.5 text-caption text-ink-label">
          {CYCLE_LABEL[plan.cycle]} · 12 카운터 제외
        </span>
      )}

      {plan.hasConflict ? (
        <span
          className="shrink-0 rounded-md border border-chip-soon-border bg-chip-soon-bg px-1.5 py-0.5 text-caption text-ink"
          title="인게임 스케줄러 등록 상태와 여기서 직접 설정한 값이 다릅니다. 직접 설정한 값이 유지됩니다."
        >
          설정 불일치
        </span>
      ) : null}

      {plan.origin === "nexon_api" ? (
        <span className="shrink-0 text-caption text-ink-muted">인게임 등록</span>
      ) : null}

      {/* `relative` 로 덮개보다 위층에 둔다 — 이 버튼들의 클릭은 덮개에 닿지 않는다. */}
      <div className="relative flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={() => onToggle(plan)}
        >
          {plan.isActive ? "끄기" : "켜기"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          aria-label={`${plan.bossDisplayName} 목록에서 삭제`}
          onClick={() => onRemove(plan)}
        >
          <Trash2 aria-hidden size={14} />
        </Button>
      </div>
    </li>
  );
}

export interface BossPlanWorkspaceProps {
  readonly characters: readonly ChecklistCharacter[];
  readonly initialCharacterId: string | null;
  /**
   * **내가 속한 파티만.** 일정 등록은 파티 구성원만 할 수 있어서(서버가 403 으로 거른다)
   * 남의 공개 파티는 후보가 아니다. `/api/schedule/parties` 는 "볼 수 있는 것"을 주므로
   * 공개 파티가 섞인다 — 그래서 서버 컴포넌트가 `fetchMyParties()` 로 읽어 내려 준다.
   */
  readonly parties: readonly PlanRunParty[];
  /** 이번 주(KST 목 00:00 → 다음 목 00:00). 서버가 계산한다 — 클라이언트에서 `new Date()`
   *  로 만들면 SSR 과 값이 달라 하이드레이션이 어긋난다. */
  readonly range: TimeRange;
}

export function BossPlanWorkspace({
  characters,
  initialCharacterId,
  parties,
  range,
}: BossPlanWorkspaceProps) {
  const queryClient = useQueryClient();
  const searchId = useId();

  const [selectedId, setSelectedId] = useState<string | null>(
    initialCharacterId ?? characters[0]?.characterId ?? null,
  );
  const [query, setQuery] = useState("");
  /**
   * 일정 모달의 대상 계획. `null` 이면 모달 자체를 **렌더하지 않는다** —
   * 열 때마다 새로 마운트되므로 폼 초안이 이전 보스의 값을 물고 있지 않고,
   * 모달 내부의 `new Date()`(오늘 날짜 기본값)가 서버 렌더에 끼어들지도 않는다.
   */
  const [runPlan, setRunPlan] = useState<CharacterBossPlan | null>(null);

  const selectedCharacter =
    characters.find((entry) => entry.characterId === selectedId) ?? null;

  const planQuery = useQuery({
    queryKey: queryKeys.db.bossPlans.character(selectedId ?? "none"),
    queryFn: () => fetchCharacterPlans(selectedId ?? ""),
    enabled: selectedId !== null,
  });

  const bossQuery = useQuery({
    queryKey: queryKeys.db.bosses.catalog(),
    queryFn: fetchBossCatalog,
  });

  /** 성공 응답이 갱신된 번들을 그대로 주므로 재조회 왕복이 없다. */
  function applyBundle(bundle: CharacterPlanResponse): void {
    if (selectedId === null) return;
    queryClient.setQueryData<CharacterPlanResponse>(
      queryKeys.db.bossPlans.character(selectedId),
      bundle,
    );
    // 대시보드 체크리스트도 같은 데이터에서 나온다.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.bossPlans.checklist(),
    });
  }

  const setPlan = useMutation({
    mutationFn: setCharacterBossPlan,
    onSuccess: applyBundle,
  });

  const removePlan = useMutation({
    mutationFn: removeCharacterBossPlan,
    onSuccess: applyBundle,
  });

  const sync = useMutation({
    mutationFn: syncCharacterScheduler,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
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
  const candidates = useMemo(
    () =>
      (bossQuery.data ?? [])
        .filter((boss) => matchesBoss(boss, normalizedQuery))
        .filter((boss) => !plannedIds.has(boss.bossDifficultyId))
        .slice(0, 8),
    [bossQuery.data, normalizedQuery, plannedIds],
  );

  const isBusy = setPlan.isPending || removePlan.isPending;
  const mutationError = setPlan.error ?? removePlan.error;

  /**
   * 모달에 넘길 보스 마스터 항목. 결정석 솔로 기준가와 확정된 `max_party` 가 여기 있다.
   * 카탈로그는 이 화면이 이미 조회하고 있으므로 **추가 요청이 없다.**
   */
  const runBoss =
    runPlan === null
      ? null
      : ((bossQuery.data ?? []).find(
          (entry) => entry.bossDifficultyId === runPlan.bossDifficultyId,
        ) ?? null);

  const activePlans = plans.filter((plan) => plan.isActive);
  const inactivePlans = plans.filter((plan) => !plan.isActive);

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
        {characters.map((entry) => (
          <FilterChip
            key={entry.characterId}
            selected={entry.characterId === selectedId}
            onClick={() => setSelectedId(entry.characterId)}
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
              <SyncButton
                characterId={selectedCharacter.characterId}
                onSync={(input) => sync.mutate(input)}
                isPending={sync.isPending}
                label={snapshot === null ? "인게임에서 불러오기" : "새로고침"}
              />
            </div>

            {sync.isError ? (
              <ErrorState
                title="인게임 스케줄러를 불러오지 못했습니다"
                detail={sync.error.message}
                className="py-6"
              />
            ) : null}

            {mutationError ? (
              <ErrorState
                title="계획을 저장하지 못했습니다"
                detail={mutationError.message}
                className="py-6"
              />
            ) : null}

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
                    </strong>
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {activePlans.map((plan) => (
                      <PlanRow
                        key={plan.planId}
                        plan={plan}
                        isBusy={isBusy}
                        onSchedule={setRunPlan}
                        onToggle={(target) =>
                          setPlan.mutate({
                            characterId: selectedCharacter.characterId,
                            bossDifficultyId: target.bossDifficultyId,
                            active: false,
                          })
                        }
                        onRemove={(target) =>
                          removePlan.mutate({
                            characterId: selectedCharacter.characterId,
                            bossDifficultyId: target.bossDifficultyId,
                          })
                        }
                      />
                    ))}
                  </ul>
                </div>

                {inactivePlans.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-caption text-ink-label">
                      꺼 둔 항목 {inactivePlans.length}개 — 목록에는 남아 있고
                      진행률에서만 빠집니다
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {inactivePlans.map((plan) => (
                        <PlanRow
                          key={plan.planId}
                          plan={plan}
                          isBusy={isBusy}
                          onSchedule={setRunPlan}
                          onToggle={(target) =>
                            setPlan.mutate({
                              characterId: selectedCharacter.characterId,
                              bossDifficultyId: target.bossDifficultyId,
                              active: true,
                            })
                          }
                          onRemove={(target) =>
                            removePlan.mutate({
                              characterId: selectedCharacter.characterId,
                              bossDifficultyId: target.bossDifficultyId,
                            })
                          }
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

                  <p className="text-body-sm text-ink-muted">
                    주간 보스 {progress.plannedWeekly}개 중{" "}
                    {progress.clearedWeekly}개 완료 · 남은{" "}
                    {progress.remainingWeekly}개
                    {progress.plannedDaily + progress.plannedMonthly > 0
                      ? ` (일간 ${progress.plannedDaily} · 월간 ${progress.plannedMonthly}개는 12 카운터 제외)`
                      : ""}
                  </p>

                  {/*
                    12개 상한 경고 (난제 16-3).
                    ★ DB 는 13번째를 **막지 않는다.** 이 경고를 그리지 않으면 사용자는
                      입장조차 못 하는 계획을 세워 두고도 모른다.
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
                        자체가 불가능하니 일부를 꺼 주세요. 저장은 막지 않습니다.
                      </span>
                    </p>
                  ) : (
                    <p className="text-body-sm text-ink-muted">
                      남은 슬롯 {progress.weeklySlotsRemaining}개 / 상한{" "}
                      {progress.weeklyLimit}개
                    </p>
                  )}

                  {progress.conflictCount > 0 ? (
                    <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      <TriangleAlert
                        aria-hidden
                        size={16}
                        className="mt-0.5 shrink-0 text-tertiary"
                      />
                      <span>
                        인게임 등록 상태와 다른 항목이 {progress.conflictCount}개
                        있습니다. 여기서 직접 설정한 값이 그대로 유지됩니다.
                      </span>
                    </p>
                  ) : null}
                </>
              )}

              {snapshot === null ? null : (
                <p className="text-caption text-ink-muted">
                  인게임 기준 {formatKstFull(new Date(snapshot.snapshotAt))}
                  {snapshot.weeklyBossClearCount !== null &&
                  snapshot.weeklyBossClearLimitCount !== null
                    ? ` · 인게임 집계 보스 ${snapshot.weeklyBossClearCount}/${snapshot.weeklyBossClearLimitCount}`
                    : ""}
                </p>
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
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="이름 또는 별칭 — 카룡, 하스우, 익세렌"
                    className="pl-9"
                    autoComplete="off"
                  />
                </div>
                <HelperText>
                  난이도까지 골라야 합니다 — &ldquo;스우&rdquo;가 아니라
                  &ldquo;하드 스우&rdquo;입니다.
                </HelperText>
              </div>

              {bossQuery.isError ? (
                <ErrorState
                  title="보스 목록을 불러오지 못했습니다"
                  onRetry={() => void bossQuery.refetch()}
                  className="py-6"
                />
              ) : bossQuery.isLoading ? (
                <SkeletonGroup label="보스 목록을 불러오는 중">
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} className="h-11" />
                  ))}
                </SkeletonGroup>
              ) : normalizedQuery === "" ? (
                <HelperText>
                  이름을 입력하면 추가할 수 있는 보스가 나옵니다.
                </HelperText>
              ) : candidates.length === 0 ? (
                <HelperText>
                  일치하는 보스가 없거나 이미 목록에 있습니다.
                </HelperText>
              ) : (
                <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
                  {candidates.map((boss) => (
                    <ListItem
                      key={boss.bossDifficultyId}
                      icon={<Plus aria-hidden size={16} />}
                      onClick={() =>
                        setPlan.mutate({
                          characterId: selectedCharacter.characterId,
                          bossDifficultyId: boss.bossDifficultyId,
                          active: true,
                        })
                      }
                      trailing={
                        <span className="text-caption text-ink-muted">
                          {CYCLE_LABEL[boss.cycle]}
                        </span>
                      }
                    >
                      <span className="truncate">{boss.koreanName}</span>
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
    </div>
  );
}
