import { Coins, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { MesoAmount } from "@/components/domain";
import { Card, CardDescription, CardOverline, CardTitle } from "@/components/ui";

import {
  WEEKLY_CRYSTAL_LIMIT,
  type WeeklyIncomeSummary,
} from "../server/dashboard-repo";

/**
 * 이번 주 결정석 수익 (§1.2 2순위).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 카드가 지키는 두 가지
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. **숫자를 여기서 만들지 않는다.** 전부 `v_weekly_income` 의 컬럼을 그대로 그린다.
 *    결정석 + 드랍의 합계마저 뷰의 `total_income_meso` 를 쓴다 — 화면이 더하기 시작하면
 *    웹과 카톡 봇(`!결정석`)의 답이 언젠가 갈라진다.
 * 2. **가격 미확인은 0 이 아니다** (§1.3 D4). 합계에 넣지 않고 **따로 센 건수**를 보여 준다.
 *    벨로나 3난이도가 실제로 `crystal_price = null` 이라 이 분기는 실사용에서 나온다.
 *    색은 tertiary orange 다 — 실패가 아니라 "확인이 필요한 상태"이기 때문이다(§4).
 *
 * 12 상한은 **주간 보스 클리어 수**에만 적용된다(일간 결정석은 세지 않는다, §1).
 * 90/주 월드 상한은 경고만 하고 막지 않는다(§1.3 D2) — 그 경고 역시 뷰가 세어 준다.
 */

/**
 * 경고 문구 — **주황은 배경과 아이콘이 지고, 글자는 잉크가 진다.**
 *
 * `text-tertiary` 로 문장을 그리면 라이트 모드에서 `#f97316` / `#ffffff` = **2.80:1** 로
 * AA 에 한참 못 미친다(다크는 7.82:1 이라 계산을 다크만 놓고 하면 지나친다).
 * 그렇다고 `--color-tertiary` 를 바꾸면 원본 디자인 문서의 브랜드 색이 흔들리고
 * 채움색으로 쓰는 곳까지 함께 바뀐다.
 *   → 색 토큰은 그대로 두고 **역할을 나눴다.** 의미(임박·주의 = 주황, §4)는 틴트 배경과
 *     아이콘이 전달하고, 읽어야 하는 문장은 `text-ink` 가 맡는다.
 *     라이트 16.69:1 · 다크 14.12:1 로 양쪽 모두 넉넉히 통과한다.
 * 빨강을 쓰지 않는 것은 그대로다 — 빨강은 실패·취소 전용이다(§4).
 */
function WarningNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
      <TriangleAlert
        aria-hidden
        size={16}
        className="mt-0.5 shrink-0 text-tertiary"
      />
      <span>{children}</span>
    </p>
  );
}

export interface WeeklyIncomeCardProps {
  readonly income: WeeklyIncomeSummary | null;
  readonly className?: string;
}

export function WeeklyIncomeCard({ income, className }: WeeklyIncomeCardProps) {
  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Coins aria-hidden size={20} className="mt-0.5 text-secondary" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardOverline>이번 주 수익</CardOverline>
            <CardTitle className="text-body-lg">결정석 수익</CardTitle>
          </div>
        </div>

        {income === null ? (
          // 빈 상태 — "0 메소를 벌었다"가 아니라 "아직 클리어가 없다"이다.
          // 두 상태를 같은 화면으로 그리면 안 되므로 금액을 0 으로 찍지 않는다.
          <CardDescription>
            이번 주에 클리어로 기록된 보스가 아직 없습니다. 수익 화면에서 등록한
            일정을 클리어로 체크하면 결정석 수익이 자동으로 합산됩니다.
          </CardDescription>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-2">
              <MesoAmount
                value={income.crystalIncomeMeso}
                compact
                suffix={false}
                tone="accent"
                className="font-headline text-subhead font-bold"
              />
              <span className="text-body-sm text-ink-muted">메소</span>
            </p>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-ink-muted">주간 보스</dt>
                <dd className="text-body-sm font-semibold text-ink tabular-nums">
                  {income.weeklyClearCount} / {WEEKLY_CRYSTAL_LIMIT}건
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-ink-muted">전체 클리어</dt>
                <dd className="text-body-sm font-semibold text-ink tabular-nums">
                  {income.clearCount}건
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-ink-muted">드랍 수익</dt>
                <dd className="text-body-sm font-semibold text-ink">
                  <MesoAmount
                    value={income.dropIncomeMeso}
                    compact
                    suffix={false}
                  />
                </dd>
              </div>
            </dl>

            <div className="flex items-baseline justify-between gap-2 border-t border-border pt-2">
              <span className="text-body-sm text-ink-label">총 수익</span>
              <MesoAmount
                value={income.totalIncomeMeso}
                compact
                className="text-body font-semibold"
              />
            </div>

            {/*
              ⚠️ 여기부터는 **합계에 들어가지 않은 것들**이다.
                 합계 아래에 두는 이유: 위 숫자가 전부라고 읽히면 안 되기 때문이다.
            */}
            {income.unknownPriceCount > 0 ? (
              <WarningNote>
                가격 미확인 {income.unknownPriceCount}건은 합계에서 제외했습니다.
                0 으로 더하지 않습니다.
              </WarningNote>
            ) : null}

            {income.unsoldDropCount > 0 ? (
              <p className="text-body-sm text-ink-muted">
                아직 팔지 않은 드랍 {income.unsoldDropCount}건은 합계에 들어가지
                않았습니다.
              </p>
            ) : null}

            {income.weeklyOverLimitCount > 0 ? (
              <WarningNote>
                주간 판매 한도({WEEKLY_CRYSTAL_LIMIT}개)를 넘긴 클리어가{" "}
                {income.weeklyOverLimitCount}건 있습니다.
              </WarningNote>
            ) : null}

            <p className="text-body-sm text-ink-muted">
              클리어 주차 기준 근사치입니다. 판매를 미루면 인게임 메소와 어긋날 수
              있습니다.
            </p>
          </>
        )}

        {/*
          상세로 가는 진입점.
          이 카드는 **요약**이고 원장은 `/income` 이다 — 캐릭터별 내역, 입장 인원 수정
          (§1.3 D3), 클리어 체크(§1.2 2순위)가 전부 그쪽에 있다. 여기에 다 넣으면
          대시보드의 첫 화면(주간 체크리스트, §1.1.1)을 밀어낸다.
        */}
        <Link
          href="/income"
          className="text-body-sm text-primary underline-offset-2 hover:underline"
        >
          수익 상세 · 인원 수정 · 클리어 체크 →
        </Link>
      </div>
    </Card>
  );
}
