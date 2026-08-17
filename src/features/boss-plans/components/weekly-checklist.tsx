"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  KeyRound,
  ListChecks,
  Loader2,
  Swords,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { BOSS_DIFFICULTY_BORDER_L, formatKstFull } from "@/components/domain";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { CredentialDialogButton } from "@/features/auth/components";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import { fetchWeeklyChecklist, syncCharacterScheduler } from "../data";
import { splitChores } from "../lib/essential-chores";
import { forgetSyncFailure } from "../lib/scheduler-sync-memo";
import {
  describeSyncFailure,
  formatSyncFailure,
} from "../lib/sync-failure-message";
import {
  missingKeyNotice,
  useSchedulerAutoSync,
} from "../lib/use-scheduler-auto-sync";
import type {
  CharacterBossPlan,
  CharacterChecklist,
  SchedulerChore,
} from "../types";
import { SyncButton } from "./sync-button";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 첫 화면 — 주간 체크리스트 (CLAUDE.md §1.1.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구: *"제일 중요한 주간 숙제 리스트가 대시보드에 떠야 함. 보스 0/12 해서
 * 클리어 하지 않은 보스들 주르륵."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면이 지키는 네 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **할 일 목록이지 전리품 목록이 아니다.** 잡은 보스가 아니라 **아직 안 잡은** 보스를
 *    나열한다. 목록은 서버가 `where is_active and not is_cleared` 로 이미 걸러서 준다.
 * 2. **섹션은 캐릭터마다 하나다.** 12개 상한이 **캐릭터당**이라(§1) 합치면 의미가 사라진다.
 * 3. **12 카운터에는 주간 보스만 들어간다.** 일간·월간은 같은 목록에 두되 카운터 밖임을
 *    명시한다 — 뷰의 `countsTowardWeeklyLimit` 을 그대로 읽고 여기서 cycle 을 다시
 *    판정하지 않는다.
 * 4. **진행률을 다시 계산하지 않는다.** `보스 10/12` 는 넥슨이 준 값이고,
 *    `weeklyOverLimit` / `weeklySlotsRemaining` 은 뷰가 낸 값이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 갱신 경로가 **둘**이다 (§1.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * - **진입 시 자동 1회** — `useSchedulerAutoSync`. 마지막 호출이 넥슨 지연 창(15분) 안인
 *   캐릭터는 **건너뛴다.** 렌더를 막지 않고, 실패해도 저장된 데이터로 계속 뜬다.
 * - **수동 새로고침 버튼** — 가드를 우회한다. "방금 잡았으니 지금 갱신"이 필요하기
 *   때문이다. 다만 **초당 5콜 한도는 우회하지 못한다** — 두 경로 모두 페이서를 지난다.
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

/**
 * 남은 보스 한 줄. 난이도를 반드시 붙인다 — "스우"가 아니라 "하드 스우"여야 한다.
 *
 * §4: **난이도는 좌측 보더 색**으로 인코딩한다. 발주자가 *"아무런 색이 없으니 보기 너무
 * 불편함"* 이라고 한 부분이며, 규칙은 이미 있었는데 이 화면이 쓰지 않고 있었다.
 * 매핑은 `boss-card.tsx` 의 `BOSS_DIFFICULTY_BORDER_L` **재사용**이다 — 여기서 다시 정의하면
 * 두 벌이 되어 반드시 갈라진다. 색만으로 정보를 주지 않도록 난이도 텍스트가 늘 함께 있다.
 *
 * 🖼️ **보스 이미지 자리**: 아래 `Swords` 아이콘 슬롯. 넥슨 API 는 보스 이미지를 주지 않고
 *    보스 마스터에도 이미지 컬럼이 없어 지금은 아이콘으로 채운다. 에셋이 생기면 이
 *    슬롯만 `<img>` 로 바꾸면 되고 레이아웃은 그대로다.
 */
function RemainingBossRow({ plan }: { readonly plan: CharacterBossPlan }) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-l-4",
        "border-border bg-surface px-3 py-2",
        BOSS_DIFFICULTY_BORDER_L[plan.difficulty],
      )}
    >
      {/* 🖼️ 아이콘 슬롯 — 보스 이미지가 생기면 여기가 그 자리다. */}
      <Swords aria-hidden size={14} className="shrink-0 text-ink-placeholder" />
      {/* `boss_difficulties.korean_name` 은 이미 `하드 최초의 대적자` 형태다. */}
      <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">
        {plan.bossDisplayName}
      </span>

      {plan.countsTowardWeeklyLimit ? null : (
        /*
          일간·월간은 **12 카운터에 들어가지 않는다**(§1). 같은 목록에 두되 그 사실이
          한 줄 안에서 읽혀야 한다 — 안 그러면 사용자가 12를 잘못 센다.
        */
        <span className="shrink-0 rounded-md border border-border bg-neutral-100 px-1.5 py-0.5 text-caption text-ink-label">
          {CYCLE_LABEL[plan.cycle]} · 12 카운터 제외
        </span>
      )}

      {plan.hasConflict ? (
        <span
          className="shrink-0 rounded-md border border-chip-soon-border bg-chip-soon-bg px-1.5 py-0.5 text-caption text-ink"
          title="인게임 스케줄러 등록 상태와 앱에서 직접 설정한 값이 다릅니다. 직접 설정한 값이 유지됩니다."
        >
          설정 불일치
        </span>
      ) : null}

      {plan.released ? null : (
        <span className="shrink-0 text-overline text-tertiary">미출시</span>
      )}
    </li>
  );
}

/**
 * 주간 숙제 한 줄. 진행 카운트가 있으면 함께 보인다.
 *
 * ★ **난이도 색을 쓰지 않는다.** 숙제는 보스가 아니므로 난이도라는 축이 존재하지 않고,
 *   같은 색 언어를 빌려 쓰면 "이 숙제가 하드 난이도"라는 없는 뜻이 생긴다. 그래서 보더는
 *   **무채색(`neutral-300`)** 이고, 아이콘도 검·`Swords` 가 아니라 체크리스트다.
 *   행 리듬(좌측 4px 바 + 같은 들여쓰기)은 보스 행과 맞춰 목록이 두 벌로 갈라져 보이지
 *   않게 했다.
 */
function ChoreRow({ chore }: { readonly chore: SchedulerChore }) {
  const hasCount = chore.maxCount !== null && chore.maxCount > 0;
  return (
    <li className="flex items-center gap-2 rounded-md border border-l-4 border-border border-l-neutral-300 bg-surface px-3 py-1.5">
      <ListChecks
        aria-hidden
        size={14}
        className="shrink-0 text-ink-placeholder"
      />
      <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
        {chore.contentName}
      </span>
      {hasCount ? (
        <span className="shrink-0 text-caption text-ink-label tabular-nums">
          {chore.nowCount ?? 0} / {chore.maxCount}
        </span>
      ) : null}
    </li>
  );
}

/**
 * 주간 숙제 묶음 — **필수 항목만 펼치고 나머지는 접는다** (발주자 지정).
 *
 * 기준은 `lib/essential-chores.ts` 한 곳에만 있다. 이 컴포넌트는 이름을 하나도 모른다.
 */
function ChoreSection({ chores }: { readonly chores: readonly SchedulerChore[] }) {
  const [showRest, setShowRest] = useState(false);
  const { essential, rest } = splitChores(chores);

  if (chores.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-caption text-ink-label">
        주간 숙제 · 필수 {essential.length}개
        {rest.length > 0 ? ` (그 외 ${rest.length}개)` : ""}
      </p>

      {essential.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          필수 숙제(에픽 던전 · 지하 수로)로 등록된 것이 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {essential.map((chore) => (
            <ChoreRow key={chore.contentName} chore={chore} />
          ))}
        </ul>
      )}

      {rest.length > 0 ? (
        <>
          {showRest ? (
            <ul className="flex flex-col gap-1.5">
              {rest.map((chore) => (
                <ChoreRow key={chore.contentName} chore={chore} />
              ))}
            </ul>
          ) : null}
          {/*
            접힌 항목의 개수를 버튼에 적는다. "숨겼다"가 아니라 "여기 있다"를 말해야
            사용자가 데이터가 사라졌다고 오해하지 않는다.
          */}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={showRest}
            onClick={() => setShowRest((value) => !value)}
          >
            {showRest ? (
              <ChevronUp aria-hidden size={14} />
            ) : (
              <ChevronDown aria-hidden size={14} />
            )}
            {showRest ? "그 외 숙제 접기" : `그 외 숙제 ${rest.length}개 보기`}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * 캐릭터 한 명의 섹션.
 *
 * 상태가 셋이다 —
 *   (a) 한 번도 동기화 안 함 → 빈 상태 + "지금 불러오기"
 *   (b) 동기화했고 남은 보스가 있음 → 할 일 목록
 *   (c) 동기화했고 전부 잡음 → 완료 상태
 */
function CharacterSection({
  entry,
  onSync,
  isPending,
}: {
  readonly entry: CharacterChecklist;
  readonly onSync: (input: {
    readonly apiKey: string;
    readonly characterId: string;
  }) => void;
  readonly isPending: boolean;
}) {
  const { character, progress, snapshot, remaining } = entry;

  /*
   * `보스 N/12` — 넥슨이 직접 준 값이다. 실측에서 주간 `complete_flag=true` 개수와
   * 정확히 일치했고(10), 월간(검은 마법사)은 카운터에 들어가지 않았다.
   * 우리가 세지 않는다. 값이 없으면 숫자를 지어내지 말고 없다고 말한다.
   */
  const clearCount = snapshot?.weeklyBossClearCount ?? null;
  const clearLimit = snapshot?.weeklyBossClearLimitCount ?? null;
  const hasCounter = clearCount !== null && clearLimit !== null;

  const weeklyRemaining = remaining.filter((plan) => plan.countsTowardWeeklyLimit);
  const otherRemaining = remaining.filter(
    (plan) => !plan.countsTowardWeeklyLimit,
  );
  const chores = snapshot?.weeklyChores ?? [];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>
            {character.worldName ?? "월드 미상"}
            {character.isMain ? " · 본캐" : ""}
          </CardOverline>
          <CardTitle className="text-body-lg">{character.name}</CardTitle>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {hasCounter ? (
            <p className="font-headline text-body-lg font-semibold text-ink tabular-nums">
              보스 {clearCount}/{clearLimit}
            </p>
          ) : null}
          {/*
            ★ 키 선택의 열쇠를 그대로 넘긴다. 버튼이 저장소에서 **이 캐릭터의 계정 키**를
              꺼내고, 없으면 버튼 대신 조치를 안내한다(§2.1 — 사람 한 명에 계정 여럿).
          */}
          <SyncButton
            characterId={character.characterId}
            credentialId={character.credentialId}
            credentialLabel={character.credentialLabel}
            onSync={onSync}
            isPending={isPending}
            label={snapshot === null ? "지금 불러오기" : "새로고침"}
          />
        </div>
      </div>

      {/*
        12개 초과 경고 (난제 16-3).

        ★ DB 도 우리도 13번째를 **막지 않는다.** 그래서 이 경고를 그리지 않으면 사용자는
          입장조차 못 하는 계획을 세워 두고도 모른다. 판정은 뷰가 한 것을 그대로 읽는다.
        ★ 색은 §4 대로 **tertiary orange** 다 — red 는 실패·취소 전용이다. 그리고
          주황은 **배경과 아이콘**이 지고 문장은 잉크가 진다(주황 본문은 라이트에서 AA 미달).
      */}
      {progress?.weeklyOverLimit === true ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            주간 보스 계획이 {progress.plannedWeekly}개로 상한(
            {progress.weeklyLimit}개)을 넘었습니다. 넘긴 만큼은 입장 자체가
            불가능하니 목록에서 일부를 꺼 주세요.
          </span>
        </p>
      ) : progress !== null && progress.weeklySlotsRemaining > 0 ? (
        <p className="text-body-sm text-ink-muted">
          주간 보스 계획 {progress.plannedWeekly}개 · 남은 슬롯{" "}
          {progress.weeklySlotsRemaining}개
        </p>
      ) : null}

      {snapshot === null ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="아직 불러오지 않았습니다"
          description="인게임 스케줄러에서 이 캐릭터의 보스 등록·클리어 상태를 가져옵니다. 캐릭터당 넥슨 API 를 1회 호출합니다."
          className="py-8"
        />
      ) : remaining.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-chip-done-border bg-chip-done-bg px-3 py-2 text-body-sm text-ink">
          <CheckCircle2
            aria-hidden
            size={16}
            className="shrink-0 text-chip-done-fg"
          />
          <span>등록한 보스를 이번 주에 전부 잡았습니다.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-caption text-ink-label">
              아직 안 잡은 주간 보스 {weeklyRemaining.length}개
            </p>
            {weeklyRemaining.length === 0 ? (
              <p className="text-body-sm text-ink-muted">
                주간 보스는 전부 잡았습니다.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {weeklyRemaining.map((plan) => (
                  <RemainingBossRow key={plan.planId} plan={plan} />
                ))}
              </ul>
            )}
          </div>

          {otherRemaining.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-caption text-ink-label">
                일간 · 월간 보스 {otherRemaining.length}개 (12 카운터 제외)
              </p>
              <ul className="flex flex-col gap-1.5">
                {otherRemaining.map((plan) => (
                  <RemainingBossRow key={plan.planId} plan={plan} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <ChoreSection chores={chores} />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <Link
          href={`/boss-plans?characterId=${encodeURIComponent(character.characterId)}`}
          className="text-body-sm text-primary underline-offset-2 hover:underline"
        >
          가는 보스 목록 편집 →
        </Link>
        {snapshot === null ? null : (
          <span
            className="text-caption text-ink-muted"
            title={formatKstFull(new Date(snapshot.fetchedAt))}
          >
            기준 {formatKstFull(new Date(snapshot.snapshotAt))}
          </span>
        )}
      </div>
    </Card>
  );
}

export interface WeeklyChecklistProps {
  readonly initial: readonly CharacterChecklist[];
  readonly className?: string;
}

export function WeeklyChecklist({ initial, className }: WeeklyChecklistProps) {
  const queryClient = useQueryClient();

  const checklistQuery = useQuery({
    queryKey: queryKeys.db.bossPlans.checklist(),
    queryFn: async () => (await fetchWeeklyChecklist()).characters,
    initialData: initial,
  });

  /**
   * 수동 새로고침. **신선도 가드를 우회한다** — 사용자가 명시적으로 눌렀기 때문이다
   * ("방금 잡았으니 지금 갱신"). 다만 `paceNexonRequest` 는 우회하지 못한다:
   * 우회해도 되는 것은 *우리* 규칙이지 넥슨의 초당 5콜 한도가 아니다.
   */
  const sync = useMutation({
    mutationFn: (input: { readonly apiKey: string; readonly characterId: string }) =>
      paceNexonRequest(() => syncCharacterScheduler(input)),
    onSuccess: (result) => {
      /*
       * 자동 경로가 "이 캐릭터는 지금 키로 못 읽는다"고 기억해 뒀더라도, 수동으로
       * 성공했으면 그 기억은 틀린 것이다. 지워야 다음 진입에서 자동으로도 돈다.
       */
      forgetSyncFailure(result.characterId);
      // 계획·클리어·스냅샷이 한꺼번에 바뀐다. 계획 화면 캐시까지 함께 무효화한다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
    },
  });

  const characters = checklistQuery.data;

  /**
   * 진입 시 자동 갱신 1회. 훅 안에서 신선도 가드 · 직렬화 · 실패 격리를 전부 처리하므로
   * 이 컴포넌트는 **표시만** 한다.
   */
  const autoSync = useSchedulerAutoSync(characters);

  /*
   * **키 없음은 실패가 아니다.** 넥슨을 부르지도 않았으므로 "갱신을 마치지 못했다"가
   * 아니라 "그 계정 키가 이 브라우저에 없다"이며, 조치도 다르다(키 입력 vs 기다리기).
   * 그래서 별도 문단으로 뽑는다.
   */
  const missingKeyEntries = autoSync.summary?.missingKey ?? [];
  const missingKeyNames = missingKeyEntries
    .map((entry) => entry.characterName)
    .join(", ");
  /*
   * 문장은 **첫 항목 기준 하나만** 쓴다. 캐릭터마다 한 줄씩 늘어놓으면 읽히지 않고,
   * 어차피 조치는 "계정 · 키 관리에서 그 키를 입력하라"로 같다. 캐릭터별로 더 정확한
   * 안내가 필요하면 각 카드의 `SyncButton` 자리에 이미 들어 있다.
   */
  const firstMissingKey = missingKeyEntries[0] ?? null;
  const missingKeySentence =
    firstMissingKey === null
      ? ""
      : formatSyncFailure(missingKeyNotice(firstMissingKey));

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ListChecks aria-hidden size={18} className="text-primary" />
          <h2 className="font-headline text-body-lg font-semibold text-ink">
            이번 주 체크리스트
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            갱신 중 인디케이터.

            ★ 조용히 값이 바뀌면 사용자는 무슨 일이 일어났는지 모른다. 그렇다고 로딩
              화면으로 덮으면 진입할 때마다 화면이 사라진다 — 저장된 데이터는 이미 떠
              있으므로 **자리를 차지하지 않는 작은 표시**만 둔다.
          */}
          {autoSync.isSyncing ? (
            <span
              className="flex items-center gap-1.5 text-caption text-ink-muted tabular-nums"
              role="status"
            >
              <Loader2 aria-hidden size={14} className="animate-spin" />
              인게임 스케줄러 갱신 중 {autoSync.progress.done}/
              {autoSync.progress.total}
            </span>
          ) : null}
          <span className="text-body-sm text-ink-muted tabular-nums">
            추적 {characters.length}명
          </span>
        </div>
      </div>

      {/*
        ═══════════════════════════════════════════════════════════════════════
        자동 갱신 결과 알림 — **원인이 다르면 문단도 다르다**
        ═══════════════════════════════════════════════════════════════════════

        예전에는 모든 실패가 한 문장으로 뭉개져 "넥슨 API 가 요청을 거절했습니다.
        캐릭터명이나 조회 날짜를 확인해 주세요"가 떴다. **캐릭터명도 날짜도 멀쩡했고**,
        진짜 원인은 그 캐릭터가 속한 계정의 키가 이 브라우저에 없다는 것이었다.
        원인이 다르면 조치도 다르므로 두 문단으로 나눈다.

        ★ `ErrorState` 로 대체하지 않는다. 어느 쪽이든 **저장된 데이터는 멀쩡하고 화면은
          계속 쓸 수 있다.** 여기서 에러 화면을 띄우면 넥슨이 흔들릴 때마다 대시보드가
          통째로 사라진다.
        ★ 색은 §4 대로 tertiary orange(배경·아이콘) — red 는 실패·취소 전용이다.
          문장은 잉크가 진다(주황 본문은 라이트에서 AA 미달). 14px 이상.
      */}
      {!autoSync.isSyncing && missingKeyEntries.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
          <KeyRound
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <p className="min-w-0 flex-1 text-body-sm text-ink">
            {missingKeyNames} — {missingKeySentence} 아래 내용은 마지막으로 저장된
            값입니다.
          </p>
          {/*
            ★ **동선.** 원인만 말하고 끝내면 사용자는 어디로 가야 할지 모른다.
              같은 문단 안에서 키를 넣을 수 있어야 한다.
          */}
          <CredentialDialogButton label="키 입력하기" />
        </div>
      ) : null}

      {!autoSync.isSyncing && autoSync.summary?.failure != null ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            자동 갱신을 마치지 못했습니다 — {autoSync.summary.failureMessage} 아래
            내용은 마지막으로 저장된 값입니다.
            {autoSync.summary.succeeded > 0
              ? ` (${autoSync.summary.succeeded}/${autoSync.summary.attempted}명은 갱신됨)`
              : ""}
          </span>
        </p>
      ) : null}

      {/*
        수동 새로고침 실패도 같은 표를 쓴다. 자동과 수동이 다른 문장을 내면 사용자는
        같은 사건을 두 번 다르게 배운다.
      */}
      {sync.isError ? (
        <ErrorState
          title="인게임 스케줄러를 불러오지 못했습니다"
          description={formatSyncFailure(describeSyncFailure(sync.error))}
          className="py-6"
        />
      ) : null}

      {sync.isSuccess && !sync.isPending ? (
        <p className="rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
          {sync.data.characterName} 동기화 완료 — 보스 {sync.data.bossEntryCount}
          건 확인 · 계획 {sync.data.planUpdatedCount}건 · 클리어{" "}
          {sync.data.clearRecordedCount}건 반영
          {sync.data.unmappedCount > 0
            ? ` · 미확인 보스 ${sync.data.unmappedCount}건은 건너뛰었습니다`
            : ""}
          {` · 넥슨 호출 ${sync.data.nexonCallsUsed}회`}
        </p>
      ) : null}

      {checklistQuery.isError ? (
        <ErrorState
          title="체크리스트를 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={() => void checklistQuery.refetch()}
        />
      ) : checklistQuery.isLoading ? (
        <SkeletonGroup label="체크리스트를 불러오는 중">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-48" />
          ))}
        </SkeletonGroup>
      ) : characters.length === 0 ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="추적 중인 캐릭터가 없습니다"
          description="보스를 도는 캐릭터를 고르면 그 캐릭터의 주간 보스와 숙제가 여기에 정리됩니다. 고른 캐릭터만 인게임 스케줄러와 동기화됩니다."
          action={<CharacterPickerTrigger label="캐릭터 선택하기" />}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {characters.map((entry) => (
            <CharacterSection
              key={entry.character.characterId}
              entry={entry}
              onSync={(input) => sync.mutate(input)}
              isPending={
                sync.isPending &&
                sync.variables?.characterId === entry.character.characterId
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
