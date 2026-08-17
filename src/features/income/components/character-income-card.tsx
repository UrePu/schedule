"use client";

import { Pencil, UserRound } from "lucide-react";

import { MesoAmount } from "@/components/domain";
import { Button, Card, CardOverline, CardTitle, EmptyState } from "@/components/ui";

import type { CharacterIncome } from "../types";
import { ClearRecordRow } from "./clear-record-row";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 한 명의 주간 수익 — **12개 상한이 적용되는 층** (§1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 주간 결정석 판매 상한은 **캐릭터당 12개**다. 그래서 화면의 1층은 캐릭터이고, 사용자
 * 합계는 이 층을 다시 합산한 것이다. 두 층을 합쳐 그리면 상한의 의미가 사라진다.
 *
 * ★ 이 카드는 **읽기 전용**이다. 고치는 일은 "수정" 버튼이 여는 모달이 한다. 카드마다
 *   입력칸이 붙어 있던 이전 구조가 발주자가 지적한 "난잡함"의 실체였다. 버튼이 카드마다
 *   따로 있는 이유는 상한이 캐릭터당이라, 사용자가 손댈 결심을 하는 지점이 **특정
 *   캐릭터의 소계를 보는 순간**이기 때문이다 — 그 캐릭터 묶음으로 바로 열린다.
 *
 * ⚠️ **12 를 코드에 박지 않는다.** `weekly_crystal_sell_limit()` 이 유일한 출처이고
 *    뷰가 그 값을 컬럼으로 실어 준다. 넘긴 건수(`weeklyOverLimitCount`)도 뷰가 센다.
 * ⚠️ **일간·월간 결정석은 그 카운터에 들어가지 않는다.** 대신 세계관상 별개인 월드당
 *    주 90개 상한이 있는데, 그건 경고만 하고 막지 않는다(§1.3 D2) — 이 카드의 범위 밖이다.
 * ⚠️ 경고 색은 **tertiary orange** 다. red 는 실패·취소 전용이다(§4).
 */

export interface CharacterIncomeCardProps {
  readonly income: CharacterIncome;
  readonly onEdit: (characterId: string | null) => void;
}

export function CharacterIncomeCard({
  income,
  onEdit,
}: CharacterIncomeCardProps) {
  const limit = income.weeklySellLimit;
  const overLimit = income.weeklyOverLimitCount > 0;
  // "접근"의 기준을 상한 − 2 로 둔다. 12개째에 처음 알려 주면 이미 늦다.
  const nearLimit =
    !overLimit && limit > 0 && income.weeklyClearCount >= limit - 2;
  const unconfirmedCount = income.clears.filter(
    (clear) => clear.partySizeUnconfirmed,
  ).length;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>{income.worldName ?? "월드 미상"}</CardOverline>
          <CardTitle className="text-body-lg">{income.characterName}</CardTitle>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex flex-col items-end gap-1">
            <MesoAmount
              value={income.incomeMeso}
              compact
              suffix={false}
              tone="accent"
              className="font-headline text-body-lg font-semibold"
            />
            <span className="text-body-sm text-ink-muted tabular-nums">
              주간 보스 {income.weeklyClearCount} / {limit}건
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEdit(income.characterId)}
          >
            <Pencil aria-hidden size={14} />
            수정
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-body-sm text-ink-muted">전체 클리어</dt>
          <dd className="text-body-sm font-semibold text-ink tabular-nums">
            {income.clearCount}건
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-body-sm text-ink-muted">주간</dt>
          <dd className="text-body-sm font-semibold text-ink tabular-nums">
            {income.weeklyClearCount}건
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-body-sm text-ink-muted">일간</dt>
          <dd className="text-body-sm font-semibold text-ink tabular-nums">
            {income.dailyClearCount}건
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-body-sm text-ink-muted">월간</dt>
          <dd className="text-body-sm font-semibold text-ink tabular-nums">
            {income.monthlyClearCount}건
          </dd>
        </div>
      </dl>

      {overLimit ? (
        <WarningNote>
          주간 결정석 판매 한도({limit}개)를 넘긴 클리어가{" "}
          {income.weeklyOverLimitCount}건 있습니다. 넘긴 만큼은 합계에서 빠져
          있습니다. 상한은 캐릭터당이며 일간·월간 결정석은 여기에 들어가지 않습니다.
        </WarningNote>
      ) : nearLimit ? (
        <WarningNote>
          주간 결정석 판매 한도({limit}개)까지 {limit - income.weeklyClearCount}개
          남았습니다. 13번째 주간 보스는 입장 자체가 불가능합니다.
        </WarningNote>
      ) : null}

      {income.unknownPriceCount > 0 ? (
        <WarningNote>
          가격 미확인 {income.unknownPriceCount}건은 이 캐릭터 합계에서
          제외했습니다. 0 으로 더하지 않습니다.
        </WarningNote>
      ) : null}

      {/*
        인원 미확인은 **금액이 최대 6배로 부풀려져 있다**는 뜻이라(§1.3 D3) 카드 층에서도
        건수를 요약한다. 줄마다 배지가 또 있지만, 클리어가 열 줄 넘어가면 스크롤해야
        발견되기 때문이다.
      */}
      {unconfirmedCount > 0 ? (
        <WarningNote>
          입장 인원이 확인되지 않은 클리어가 {unconfirmedCount}건 있습니다. 넥슨 API
          에는 파티 정보가 없어 관측만으로 만들어진 기록은 인원이 기본값 1명입니다 —
          실제로 파티였다면 그만큼 수익이 부풀려져 있습니다. 위 &lsquo;수정&rsquo;에서
          고쳐 주세요.
        </WarningNote>
      ) : null}

      {income.clears.length === 0 ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="표시할 클리어가 없습니다"
          description="이 캐릭터의 이번 주 클리어 기록이 집계에는 있지만 상세 목록이 비어 있습니다. 화면을 새로 고쳐 주세요."
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {income.clears.map((clear) => (
            <ClearRecordRow key={clear.clearId} clear={clear} />
          ))}
        </ul>
      )}
    </Card>
  );
}
