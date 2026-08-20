"use client";

import { useQuery } from "@tanstack/react-query";

import { LogoutButton } from "@/features/auth/components";
import { useSessionUser } from "@/features/auth/data/auth-queries";
import { BotLinkDialogButton } from "@/features/bot/components";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { fetchMyParties } from "@/features/dashboard/data";
import { Card, ErrorState, Skeleton } from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import type { WeekKey } from "@/types/domain";

import { AccountSettingsButton } from "./account-settings-button";
import { MyPartiesCard } from "./my-parties-card";
import { WeekSummaryCard } from "./week-summary-card";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 관리 › 기타 — 대시보드 해체 후 **갈 곳이 없던 것들**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): 새 구조의 관리 무리 셋째 자리가 `etc` 였고, 남은 대시보드
 * 카드들을 어디로 보낼지 물었을 때 답이 *"관리 탭으로 통합"* 이었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 있는 것과, 왜 여기인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **설정 버튼 넷** — 추적 캐릭터 · API 키 · 채팅방 연결 · 로그아웃.
 *    이것들이 이 화면이 존재해야 하는 진짜 이유다. 예전에는 대시보드 헤더에 달려
 *    있었고, 대시보드가 사라지면서 **다른 어디에도 입구가 없어졌다.** 처음 한 번 쓰고
 *    마는 것들이라 매일 여는 화면(이번 주 일정)의 머리를 다시 차지할 이유는 없다(§1.1.1).
 *    특히 채팅방 연결은 파티 알림 목적지를 정하는 **유일한 입구**다(§2.3).
 * 2. **내 파티** — `/schedule` 의 파티 바가 같은 목록을 갖고 있지만, 그쪽은 "겹쳐 볼
 *    파티를 고르는" 도구다. 여기서는 "내가 어느 파티에 속해 있나"를 읽는다.
 * 3. **이번 주 요약** — 다음 초기화까지 남은 시간. 주간 초기화는 이 앱의 모든 셈이
 *    걸려 있는 경계라(§1) 어디선가는 한 번 크게 말해야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 **없는 것**
 * ─────────────────────────────────────────────────────────────────────────────
 * 결정석 수익 카드와 '가장 가까운 일정' 카드는 옮기지 않고 **지웠다.** 각각 `/income`
 * 상단 요약과 이번 주 시간표가 같은 사실을 더 자세히 말하고 있어서, 옮기면 같은 값을
 * 두 곳에서 말하는 상태로 되돌아간다 — 대시보드가 해체된 이유가 바로 그것이었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **데이터는 캐시가 소유한다** (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티 목록은 `useQuery` 로 가져온다. 파티를 만들거나 터뜨리면 `party.mine` 키가
 * 무효화되고 이 목록이 따라 움직인다 — props 로 받으면 그 무효화가 닿지 못한다.
 * 티어: db(60초). **넥슨 호출 0건.**
 */

export interface EtcScreenProps {
  /** 이번 주차(KST 목 00:00 경계). 서버가 계산한다 — 캐시 키의 일부다. */
  readonly weekKey: WeekKey;
  /** 서버가 정한 기준 시각. **데이터가 아니라 렌더 기준점**이라 props 가 맞다. */
  readonly now: Date;
}

export function EtcScreen({ weekKey, now }: EtcScreenProps) {
  const user = useSessionUser();
  const identity =
    user === null ? null : (user.mainCharacterName ?? user.displayName);

  const partiesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.mine(weekKey)),
    queryFn: () => fetchMyParties(weekKey),
  });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-overline uppercase text-primary">관리</p>
          <h1 className="font-headline text-subhead text-ink">
            {identity ?? "기타"}
            {user !== null && user.mainWorldName !== null ? (
              <span className="ml-2 text-body-sm font-normal text-ink-muted">
                {user.mainWorldName}
              </span>
            ) : null}
          </h1>
        </div>
      </header>

      {/*
        설정 묶음. 전부 **모달 트리거**이며 모달들은 서로 형제다 — 중첩되지 않는다.
        표시 정체성은 본캐 닉네임이다(§2.1) — 키도 내부 id 도 화면에 나오지 않는다.
      */}
      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-overline uppercase text-ink-muted">계정 설정</p>
          <p className="text-body-sm text-ink-muted">
            추적할 캐릭터를 고르고, 넥슨 API 키를 추가·삭제하고, 알림을 받을
            카카오톡 채팅방을 연결합니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CharacterPickerTrigger label="추적 캐릭터" />
          <AccountSettingsButton />
          <BotLinkDialogButton />
          <LogoutButton className="shrink-0" />
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* 상태 셋(§0.3). 재조회가 실패해도 이전 목록이 있으면 화면을 지우지 않는다. */}
        {partiesQuery.data === undefined ? (
          partiesQuery.isError ? (
            <ErrorState
              title="파티 목록을 불러오지 못했습니다"
              detail={partiesQuery.error.message}
              onRetry={() => void partiesQuery.refetch()}
            />
          ) : (
            <Skeleton className="h-40" />
          )
        ) : (
          <MyPartiesCard parties={partiesQuery.data} />
        )}
        <WeekSummaryCard now={now} />
      </div>
    </div>
  );
}
