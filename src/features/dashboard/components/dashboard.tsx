import { LogoutButton } from "@/features/auth/components";
import type { SessionUser } from "@/features/auth/types";
import { WeeklyChecklist } from "@/features/boss-plans/components";
import { CharacterPickerTrigger } from "@/features/characters/components";

import type { DashboardData } from "../server/dashboard-repo";
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
        1 — **결정석 수익이 맨 위다.** 옆에 "몇 개 더 돌아야 하는가"가 붙는다.
        같은 `weeklyBossCapacity` 를 둘 다 받으므로 `주간 보스 40 / 84` 가 두 카드에서
        다르게 나올 수 없다.
      */}
      <div className="grid gap-3 lg:grid-cols-2">
        <WeeklyIncomeCard
          income={data.income}
          capacity={data.weeklyBossCapacity}
        />
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

      {/* 3 — 이번 주 체크리스트. 캐릭터별 `보스 N/12` 는 단일 캐릭터라 그대로 옳다. */}
      <WeeklyChecklist initial={data.checklist} />
    </div>
  );
}
