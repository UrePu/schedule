"use client";

import { Pencil, UserRound } from "lucide-react";

import { MesoAmount, Numeric } from "@/components/domain";
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
 * ⚠️ **월간 결정석은 그 카운터에 들어가지 않는다.** 별개로 넥슨 **계정당** 주 90개 상한이
 *    있는데, 그건 경고만 하고 막지 않는다(§1.3 D2) — 계정 단위라 이 카드의 범위 밖이고
 *    `AccountCrystalCapCard` 가 맡는다.
 * ⚠️ **일간 보스는 여기 없다** (2026-08-18 발주자 지시). 건수·금액 어디에도 들어가지 않는다.
 * ⚠️ 경고 색은 **tertiary orange** 다. red 는 실패·취소 전용이다(§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세로 압축 — 긴 설명은 **여기 한 곳**에만 (2026-08-18 발주자: *"너무 아래로 길어"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **통계 블록을 한 줄로.** `전체 / 주간 / 월간` 3열 `<dl>` 이 숫자 세 개를 위해 44px 를
 *    먹었고, 그중 `주간` 은 헤더의 `주간 보스 11 / 12건` 과 **같은 값**이었다. 헤더에
 *    없는 값(`전체` · `월간`)만 이름 아래 한 줄로 내렸다 — `전체 − 월간 = 주간` 이라
 *    사라진 숫자는 없다.
 * 2. **인원 미확인 설명은 이 카드에만.** 예전에는 같은 문장이 클리어 줄마다 반복돼
 *    11건이면 11번 + 여기 1번 = **12번** 그려졌다. 지금은 여기서 **건수와 교정 동선**을
 *    말하고, 각 줄은 `1인 입장 · 미확인` 배지로 **어느 줄인지만** 가리킨다.
 *    §1.3 D3 경고는 지워진 것이 아니라 **한 곳으로 모였다.**
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
          {/*
            예전 3열 `<dl>` 을 대신하는 한 줄. **헤더에 이미 있는 `주간` 은 빼고**
            거기 없는 값만 싣는다(`전체 − 월간 = 주간`). 수치 주석이라 12px 이다(§4).
          */}
          <span className="text-caption text-ink-muted">
            클리어 전체 <Numeric>{income.clearCount}</Numeric>건 · 월간{" "}
            <Numeric>{income.monthlyClearCount}</Numeric>건
          </span>
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
            {/*
              12개 상한 카운터. 캐릭터 카드가 세로로 쌓인다.
              `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
            */}
            <span className="text-body-sm text-ink-muted tabular-nums">
              주간 보스{" "}
              <Numeric>
                {income.weeklyClearCount} / {limit}
              </Numeric>
              건
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
        ★ **§1.3 D3 경고가 사는 유일한 자리.** 인원 미확인은 금액이 최대 6배로 부풀려져
          있다는 뜻이므로 반드시 말해야 하지만, 그 설명을 클리어 줄마다 반복하면 카드가
          화면 세 개 길이가 된다 — 그게 발주자가 지적한 세로 길이의 주범이었다.
          여기서 **몇 건인지와 어떻게 고치는지**를 말하고, 각 줄은 배지로 **어느 건인지**만
          가리킨다. 둘 다 필요하다: 요약만 있으면 무엇을 고칠지 못 고르고, 배지만 있으면
          왜 고쳐야 하는지를 모른다.
      */}
      {unconfirmedCount > 0 ? (
        <WarningNote>
          입장 인원이 확인되지 않은 클리어가 {unconfirmedCount}건 있습니다 — 아래
          목록에서 &lsquo;미확인&rsquo; 배지가 붙은 줄입니다. 넥슨 API 에는 파티
          정보가 없어 관측만으로 만들어진 기록은 인원이 기본값 1명이라, 실제로
          파티였다면 그 줄의 수익이 최대 6배로 부풀려져 있습니다. 위
          &lsquo;수정&rsquo;에서 실제 입장 인원을 넣으면 바로 다시 계산됩니다.
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
