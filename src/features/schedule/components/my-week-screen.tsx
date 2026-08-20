"use client";

import Link from "next/link";

import { WeekLabel } from "@/components/domain";
import { useSessionUser } from "@/features/auth/data/auth-queries";
import type { TimeRange, WeekKey } from "@/types/domain";

import { WeekTimetable } from "./week-timetable";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인 사용자의 첫 화면 — **이번 주 시간표 하나뿐이다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"대시보드를 삭제하고 (…) 일정 에선 정말 나 언제 어디로
 * 보스가야하지? 를 주력으로 보여주는거임"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기서 **없어진 것들**이 이 화면의 정의다
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 대시보드는 카드 다섯을 쌓았다. 그중 넷은 이미 자기 화면을 갖고 있었다:
 *
 *   결정석 수익 카드   → `/income` 상단 요약과 **같은 컴포넌트·같은 값**이었다
 *   가장 가까운 일정   → 이 시간표가 **주 전체를 시각까지** 말하므로 부분집합이다
 *   내 파티 · 이번 주 요약 → 관리 › 기타(`/etc`)
 *   주간 체크리스트    → 현황 › 계정 보스 현황(`/boss-status`)
 *
 * 즉 삭제가 아니라 **해체**다. 같은 사실을 두 곳에서 말하던 것을 한 곳으로 모았고,
 * 첫 화면에는 다른 어디에도 없던 사실만 남겼다.
 *
 * 설정 버튼 묶음(추적 캐릭터 · API 키 · 채팅방 연결 · 로그아웃)도 `/etc` 로 갔다.
 * 처음 한 번 쓰고 마는 것들이라 매일 여는 화면의 머리를 차지할 이유가 없다(§1.1.1).
 *
 * 표시 정체성은 **본캐 닉네임**이다(§2.1) — 키도 내부 id 도 제목에 나오지 않는다.
 * 부계정 키를 추가하면 본캐가 바뀔 수 있어(`main_character_name` 트리거) 세션 쿼리에서
 * 읽는다. 그래야 키를 추가한 직후 제목이 곧바로 따라온다.
 */

export interface MyWeekScreenProps {
  /** 이번 주차(KST 목 00:00 경계). 서버가 계산한다 — 캐시 키의 일부다. */
  readonly weekKey: WeekKey;
  /** 서버가 정한 기준 시각. **데이터가 아니라 렌더 기준점**이라 props 가 맞다. */
  readonly now: Date;
  /** 이번 주 범위(목 00:00 ~ 다음 목 00:00). 같은 이유로 props 다. */
  readonly range: TimeRange;
}

export function MyWeekScreen({ weekKey, now, range }: MyWeekScreenProps) {
  const user = useSessionUser();
  const identity =
    user === null ? null : (user.mainCharacterName ?? user.displayName);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-overline uppercase text-primary">이번 주 일정</p>
          <h1 className="font-headline text-subhead text-ink">
            {identity ?? "내 일정"}
            {user !== null && user.mainWorldName !== null ? (
              <span className="ml-2 text-body-sm font-normal text-ink-muted">
                {user.mainWorldName}
              </span>
            ) : null}
          </h1>
        </div>
        {/* 주간 초기화 시점은 어느 화면에서든 항상 보인다 (§1.4). */}
        <WeekLabel date={now} />
      </header>

      {/*
        이 한 줄이 화면의 계약이다 — **참가로 등록된 것만** 나온다는 사실을 말해 두지
        않으면, 파티에는 있는데 이 사람은 안 가는 일정이 "빠졌다"로 읽힌다.
        발주자가 2026-08-20 에 지적한 *"내가 안가는데 일정에 왜뜸"* 의 반대편 오해다.
      */}
      <p className="text-body-sm text-ink-muted">
        내가 <strong className="font-semibold">참가</strong>로 등록된 일정만
        나옵니다. 이어서 도는 보스는 한 덩어리로 묶여{" "}
        <strong className="font-semibold">시작~끝</strong> 시각을 보여 줍니다.{" "}
        <Link
          href="/schedule"
          className="text-primary underline-offset-2 hover:underline"
        >
          일정 추가 →
        </Link>
      </p>

      <WeekTimetable weekKey={weekKey} now={now} range={range} />
    </div>
  );
}
