import { ArrowRight, Coins } from "lucide-react";
import Link from "next/link";

import { Button, Card, CardOverline, CardTitle } from "@/components/ui";
import { CrystalIncomeSummaryPanel } from "@/features/income/components";
import type { CrystalIncomeSummary } from "@/features/income/types";

/**
 * 이번 주 결정석 수익 (§1.2 2순위).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 카드는 **껍데기만** 소유한다
 * ═════════════════════════════════════════════════════════════════════════════
 * 2026-08-19 정리. 예전에는 이 파일이 금액·건수·경고를 직접 그렸고, `/income` 상단
 * 요약이 **같은 것을 따로** 그렸다. 두 화면이 다른 숫자를 말하기 시작하는 전형적인 배치다.
 * 지금은 안쪽이 통째로 `CrystalIncomeSummaryPanel`(income 기능 소유)이고, 값도
 * `crystal-summary.ts` 한 곳이 조립한다. 이 파일에 남은 것은 제목과 진입 버튼뿐이다.
 *
 * 그 결과로 함께 들어온 것들:
 * - **주간/월간 분리** (발주자 지시: *"주간 월간은 따로놔야지"*). 12개 상한은 주간에만
 *   걸리므로 예전의 `주간+월간 41건` 은 바로 옆 `40 / 84건` 의 분모와 아무 관계가 없었다.
 * - **이론상 최대치** — 계획을 전부 클리어했을 때의 상한. 목표가 아니라는 문장이 함께 붙는다.
 *
 * ⚠️ **숫자를 여기서 만들지 않는다.** 전부 뷰의 컬럼이다(`v_weekly_income` 의 주기별 금액,
 *    `v_weekly_plan_potential` 의 최대치 — 마이그레이션 27).
 * ⚠️ **`주간 보스 N / M` 의 분모는 `추적 캐릭터 수 × 캐릭터당 상한` 이다**(2026-08-18).
 *    예전에는 `12` 를 그대로 붙여 화면이 **`주간 보스 40 / 12건`** 을 그렸다.
 *    분자·분모 모두 `WeeklyBossCapacity` 한 객체에서 오므로 옆의
 *    `WeeklyBossCapacityCard` 와 숫자가 갈라질 수 없다.
 *
 * 90/주 상한은 **넥슨 계정당**이며(§1.3 D2) 경고만 하고 막지 않는다. 그 카드
 * (`AccountCrystalCapCard`)는 **대시보드에서 빠졌고** 수익 화면(`/income`)에만 남아 있다 —
 * 발주자가 대시보드에서 앞세울 값이 아니라고 정했다.
 */

export interface WeeklyIncomeCardProps {
  /**
   * 카드 안쪽 전부. **`/income` 상단 요약과 같은 값**이며 조립처는
   * `@/features/income/server/crystal-summary` 하나다.
   */
  readonly summary: CrystalIncomeSummary | null;
  readonly className?: string;
}

export function WeeklyIncomeCard({ summary, className }: WeeklyIncomeCardProps) {
  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        {/*
          ── 헤더 = 제목 + 이 카드의 진입점 ─────────────────────────────────
          진입점은 **헤더 오른쪽**이다. 대시보드에서 `MyPartiesCard` 의 `겹쳐보기 열기`,
          체크리스트 카드의 `보스 목록 수정`, 수익 화면의 `클리어 수정` 이 모두 같은
          자리·같은 형태(`secondary` · `sm` · 아이콘 + 라벨)를 쓴다.
        */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Coins aria-hidden size={20} className="mt-0.5 text-secondary" />
            <div className="flex min-w-0 flex-col gap-1">
              <CardOverline>이번 주 수익</CardOverline>
              <CardTitle className="text-body-lg">결정석 수익</CardTitle>
            </div>
          </div>
          {/*
            이 카드는 **요약**이고 원장은 `/income` 이다 — 달력, 주차별 내역, 입장 인원
            수정(§1.3 D3), 클리어 체크(§1.2 2순위)가 전부 그쪽에 있다. 여기에 다 넣으면
            대시보드의 첫 화면(주간 체크리스트, §1.1.1)을 밀어낸다.
          */}
          <Link href="/income" className="shrink-0">
            <Button variant="secondary" size="sm">
              <ArrowRight aria-hidden size={14} />
              수익 상세 열기
            </Button>
          </Link>
        </div>

        <CrystalIncomeSummaryPanel
          summary={summary}
          emptyDescription="이번 주에 클리어로 기록된 보스가 아직 없습니다. 수익 화면에서 등록한 일정을 클리어로 체크하면 결정석 수익이 자동으로 합산됩니다."
        />
      </div>
    </Card>
  );
}
