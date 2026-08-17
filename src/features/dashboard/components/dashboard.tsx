import { LogoutButton } from "@/features/auth/components";
import type { SessionUser } from "@/features/auth/types";
import { WeeklyChecklist } from "@/features/boss-plans/components";
import { CharacterPickerTrigger } from "@/features/characters/components";

import type { DashboardData } from "../server/dashboard-repo";
import { AccountSettingsButton } from "./account-settings-button";
import { MyPartiesCard } from "./my-parties-card";
import { WeekSummaryCard } from "./week-summary-card";
import { WeeklyIncomeCard } from "./weekly-income-card";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인 사용자의 첫 화면 — **파티가 맨 위**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구(최신): *"메인이 이게 아니고 파티가 메인이 되어야 함. 가장 위에는 파티가
 * 나와야 해."*
 *
 * ⚠️ **이 배치는 CLAUDE.md §1.1.1 의 "첫 화면은 주간 체크리스트"를 대체한다.**
 *    §1.1.1 은 "숙제 리스트가 대시보드에 떠야 한다"는 이전 요구에서 나왔고 그 요구 자체는
 *    여전히 유효하다 — 체크리스트는 사라지지 않고 **파티 바로 다음**으로 내려갔을 뿐이다.
 *    두 요구가 충돌하는 지점은 "무엇이 맨 위인가" 하나뿐이며, 최신 지시가 이긴다.
 *    (문서 갱신은 진행 관리 쪽에서 한다 — 이 파일이 §1.1.1 을 고치지 않는다.)
 *
 * 배치:
 *   1) **내 파티** — §1.2 1순위(여러 사람 시간을 겹쳐 보기)로 가는 진입점.
 *      옆에 이번 주 요약(다음 초기화까지)이 붙는다.
 *   2) 이번 주 체크리스트 — 캐릭터마다 `보스 N/12` + 아직 안 잡은 보스 + 주간 숙제
 *   3) 이번 주 결정석 수익 (`v_weekly_income`)
 *
 * 헤더의 버튼 둘이 **설정을 전부 흡수한다** — 캐릭터 선택과 키 관리는 처음 한 번 쓰고
 * 마는 화면이라 본문에서 뺐다. 기능이 사라진 것이 아니라 진입만 접혔다.
 *
 * **서버 컴포넌트다.** 데이터는 페이지가 미리 읽어 넘긴다. 클라이언트 상호작용이 필요한
 * 조각(체크리스트, 캐릭터 선택 모달, 키 관리 모달, 로그아웃)만 클라이언트 컴포넌트다.
 *
 * 표시 정체성은 **본캐 닉네임**이다(§2.1) — 키도 내부 id 도 제목에 나오지 않는다.
 */

export interface DashboardProps {
  readonly user: SessionUser;
  readonly data: DashboardData;
  readonly now: Date;
}

export function Dashboard({ user, data, now }: DashboardProps) {
  const identity = user.mainCharacterName ?? user.displayName;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-overline uppercase text-primary">내 스케줄</p>
          <h1 className="font-headline text-subhead text-ink">
            {identity}
            {user.mainWorldName !== null ? (
              <span className="ml-2 text-body-sm font-normal text-ink-muted">
                {user.mainWorldName}
              </span>
            ) : null}
          </h1>
        </div>

        {/* 설정은 전부 버튼 뒤 모달이다. 두 모달은 **형제**이며 중첩되지 않는다. */}
        <div className="flex flex-wrap items-center gap-2">
          <CharacterPickerTrigger label="추적 캐릭터" />
          <AccountSettingsButton />
          <LogoutButton className="shrink-0" />
        </div>
      </header>

      {/*
        1 — **파티가 맨 위다.** 이 앱의 존재 이유(§1.2 1순위)가 여기서 시작한다.
        파티 카드가 두 칸을 먹고 이번 주 요약이 옆에 붙는다 — 요약은 한 줄짜리 지표라
        같은 폭을 줄 이유가 없다.
      */}
      <div className="grid gap-3 lg:grid-cols-3">
        <MyPartiesCard parties={data.parties} className="lg:col-span-2" />
        <WeekSummaryCard now={now} />
      </div>

      {/* 2 — 이번 주 체크리스트. 맨 위에서 내려왔을 뿐 그대로 남아 있다. */}
      <WeeklyChecklist initial={data.checklist} />

      {/* 3 — 결정석 수익. */}
      <WeeklyIncomeCard income={data.income} />
    </div>
  );
}
