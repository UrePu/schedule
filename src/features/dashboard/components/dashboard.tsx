"use client";

import { useQuery } from "@tanstack/react-query";

import { ErrorState, Skeleton, SkeletonGroup } from "@/components/ui";
import { LogoutButton } from "@/features/auth/components";
import { useSessionUser } from "@/features/auth/data/auth-queries";
import { BotLinkDialogButton } from "@/features/bot/components";
import { WeeklyChecklist } from "@/features/boss-plans/components";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import type { WeekKey } from "@/types/domain";

import { fetchDashboard } from "../data";
import { AccountSettingsButton } from "./account-settings-button";
import { MyPartiesCard } from "./my-parties-card";
import { WeekSummaryCard } from "./week-summary-card";
import { WeeklyBossCapacityCard } from "./weekly-boss-capacity-card";
import { WeeklyIncomeCard } from "./weekly-income-card";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인 사용자의 첫 화면 — **결정석 수익이 맨 위**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구(최신, 2026-08-18): *"대시보드인데. 이게 제일 위로 올라가야할듯."* —
 * 만들어진 화면을 보고 **결정석 수익을 맨 위로** 올린 지시다. CLAUDE.md §1.1.1 도
 * 같은 날 그렇게 개정됐다(*"Crystal income comes first on the dashboard, then parties,
 * then the checklist"*).
 *
 * ⚠️ 그 앞에는 *"파티가 메인이 되어야 함"* 지시가 있었고 그때는 파티가 맨 위였다.
 *    파티가 §1.2 1순위인 것은 그대로이며, **한 칸 내려갔을 뿐 사라지지 않았다.**
 *    최신 지시가 이긴다.
 *
 * 배치:
 *   1) **이번 주 결정석 수익** + **남은 주간 보스 칸** — 사람들이 앱을 여는 이유.
 *      두 카드를 나란히 두는 이유: 수익은 "얼마 벌었나", 칸은 "몇 개 더 돌아야 하나"라
 *      같은 순간에 같이 보는 값이다. 분자·분모를 한 객체(`weeklyBossCapacity`)에서
 *      받으므로 두 카드의 숫자가 갈라질 수 없다.
 *   2) **내 파티** — §1.2 1순위(여러 사람 시간을 겹쳐 보기)로 가는 진입점.
 *      옆에 이번 주 요약(다음 초기화까지)이 붙는다.
 *   3) 이번 주 체크리스트 — 캐릭터마다 `보스 N/12` + 아직 안 잡은 보스 + 주간 숙제.
 *      여기 `/12` 는 **캐릭터 하나**를 그리므로 옳다. 합산 분모가 필요한 자리는 1) 뿐이다.
 *
 * ⚠️ **90개 계정 천장(`AccountCrystalCapCard`)은 이 화면에서 뺐다** (같은 날 지시:
 *    *"천장90개로 하지말고 현재 선택된 캐릭터 갯수 위주로 몇개 보스 돌아야하는지"*).
 *    삭제가 아니라 이동이다 — 수익 화면(`/income`)에는 그대로 있다. §1.3 D2 도 그대로다.
 *
 * 헤더의 버튼 둘이 **설정을 전부 흡수한다** — 캐릭터 선택과 키 관리는 처음 한 번 쓰고
 * 마는 화면이라 본문에서 뺐다. 기능이 사라진 것이 아니라 진입만 접혔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **데이터는 캐시가 소유한다** — props 로 받지 않는다 (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 서버 컴포넌트였고 `data: DashboardData` 를 통째로 props 로 받았다. props 는
 * `invalidateQueries()` 가 닿을 수 없는 자리라, 클리어를 체크하거나 계획을 껐을 때 수익
 * 합계와 12칸이 **새로고침 전까지 낡은 값 그대로**였다. 그것이 발주자가 본
 * *"invalidateQueryKey 가 제대로 안된거같음"* 의 실제 정체다.
 *
 * 이제 서버 컴포넌트(`app/page.tsx`)는 같은 repo 를 불러 **쿼리 캐시에 심기만** 하고
 * (`dehydrateQueries`), 이 컴포넌트가 `useQuery` 로 그 값을 인수한다. 하이드레이션은
 * 서버 렌더 시점에 이미 일어나므로 **첫 페인트가 스켈레톤으로 퇴행하지 않는다** —
 * 아래 로딩 분기는 캐시가 비는 예외 경로(직접 마운트·캐시 소거)용이다.
 *
 * 표시 정체성도 같은 이유로 세션 쿼리에서 읽는다. 부계정 키를 추가하면 본캐가 바뀔 수
 * 있고(`main_character_name` 트리거), 그때 mutation 이 세션 캐시를 갱신하면 제목이
 * 곧바로 따라온다.
 *
 * 표시 정체성은 **본캐 닉네임**이다(§2.1) — 키도 내부 id 도 제목에 나오지 않는다.
 */

export interface DashboardProps {
  /** 이번 주차(KST 목 00:00 경계). 서버가 계산한다 — 캐시 키의 일부다. */
  readonly weekKey: WeekKey;
  /**
   * 서버가 정한 기준 시각. 하이드레이션 불일치를 막으려면 반드시 주입해야 한다.
   * (데이터가 아니라 **렌더 기준점**이라 props 가 맞다.)
   */
  readonly now: Date;
}

export function Dashboard({ weekKey, now }: DashboardProps) {
  const user = useSessionUser();

  /**
   * 화면 하나 = 쿼리 하나. 수익 합계 · 12칸 분모 · 파티 건수는 같은 원장에서 한 번에
   * 나온 값이라 조각으로 나눠 받으면 잠깐 서로 어긋난 숫자를 말한다.
   *
   * 티어: db(60초) — 우리 DB 이고 신선도는 **뮤테이션 후 무효화**가 책임진다.
   * 넥슨 호출은 0건이다(§1.1.1).
   */
  const dashboardQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.dashboard.summary(weekKey)),
    queryFn: () => fetchDashboard(weekKey),
  });

  const data = dashboardQuery.data;
  const identity = user === null ? null : (user.mainCharacterName ?? user.displayName);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-overline uppercase text-primary">내 스케줄</p>
          <h1 className="font-headline text-subhead text-ink">
            {identity ?? "내 스케줄"}
            {user !== null && user.mainWorldName !== null ? (
              <span className="ml-2 text-body-sm font-normal text-ink-muted">
                {user.mainWorldName}
              </span>
            ) : null}
          </h1>
        </div>

        {/* 설정은 전부 버튼 뒤 모달이다. 모달들은 **형제**이며 중첩되지 않는다. */}
        <div className="flex flex-wrap items-center gap-2">
          <CharacterPickerTrigger label="추적 캐릭터" />
          <AccountSettingsButton />
          {/*
            채팅방 연결도 **설정**이다(§1.1.1). 처음 한 번 열고 마는 화면이라 본문을
            차지하지 않으며, 여기가 파티 알림 목적지를 정하는 유일한 입구다(§2.3).
          */}
          <BotLinkDialogButton />
          <LogoutButton className="shrink-0" />
        </div>
      </header>

      {/*
        1 — **결정석 수익이 맨 위다.** 옆에 "몇 개 더 돌아야 하는가"가 붙는다.
        같은 `weeklyBossCapacity` 를 둘 다 받으므로 `주간 보스 40 / 84` 가 두 카드에서
        다르게 나올 수 없다.
      */}
      {/*
        상태 셋(§0.3). 하이드레이션이 정상이면 `data` 는 **첫 렌더부터** 채워져 있으므로
        아래 두 분기는 캐시가 빈 예외 경로에서만 보인다. 재조회가 실패해도 이전 데이터가
        남아 있으면(`data !== undefined`) 화면을 지우지 않는다 — 숫자를 통째로 없애는
        것보다 마지막으로 확인된 값을 계속 보여 주는 쪽이 낫다.
      */}
      {data === undefined ? (
        dashboardQuery.isError ? (
          <ErrorState
            title="대시보드를 불러오지 못했습니다"
            detail={dashboardQuery.error.message}
            onRetry={() => void dashboardQuery.refetch()}
          />
        ) : (
          <SkeletonGroup label="이번 주 요약을 불러오는 중">
            <div className="grid gap-3 lg:grid-cols-2">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          </SkeletonGroup>
        )
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {/*
              카드 안쪽 전부가 `crystalSummary` 한 객체다 — `/income` 상단 요약과 **같은
              값·같은 컴포넌트**이며, 조립처는 `income/server/crystal-summary.ts` 하나다.
            */}
            <WeeklyIncomeCard summary={data.crystalSummary} />
            <WeeklyBossCapacityCard capacity={data.weeklyBossCapacity} />
          </div>

          {/*
            2 — 파티. 맨 위에서 한 칸 내려왔을 뿐 그대로다(§1.2 1순위).
            파티 카드가 두 칸을 먹고 이번 주 요약이 옆에 붙는다 — 요약은 한 줄짜리 지표라
            같은 폭을 줄 이유가 없다.
          */}
          <div className="grid gap-3 lg:grid-cols-3">
            <MyPartiesCard parties={data.parties} className="lg:col-span-2" />
            <WeekSummaryCard now={now} />
          </div>
        </>
      )}

      {/*
        3 — 이번 주 체크리스트. 캐릭터별 `보스 N/12` 는 단일 캐릭터라 그대로 옳다.
        ★ **자기 쿼리를 스스로 갖는다.** 동기화 버튼이 여기 있고, 그 결과로 갱신돼야 하는
          것도 이 목록이라 소유를 나누면 무효화 대상이 둘로 갈라진다.
      */}
      <WeeklyChecklist />
    </div>
  );
}
