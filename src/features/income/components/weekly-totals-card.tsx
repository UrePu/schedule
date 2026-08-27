"use client";

import { Coins } from "lucide-react";

import { MesoAmount, Numeric } from "@/components/domain";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

import type { CrystalIncomeSummary } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 수익 — **주간 · 월간 · 드랍 세 칸이 전부다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-27): *"결정석 수익에서 주간 월간 드랍 이거 세개만 들어간 폼"* ·
 * *"UI 가 너무 안좋아"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 덜어냈고, 왜 그게 개선인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 `CrystalIncomeSummaryPanel` 은 한 카드 안에 **여덟 덩어리**를 쌓고 있었다 —
 * 주기별 큰 타일 2개 · 최대치 설명 문단 · 통계 타일 3개 · 총 수익 줄 · 월간 범위 설명
 * 문단 · 경고 4종. 그중 **주간·월간 금액은 두 번씩** 나왔다(큰 타일과 통계 타일).
 * 화면에서 가장 위, 가장 좋은 자리를 반복과 설명이 먹고 있었다.
 *
 * 남긴 기준은 하나다 — **매번 보는 값인가.**
 *   · 주간 · 월간 · 드랍 금액 → 매번 본다. 남긴다.
 *   · 최대치 → 금액 아래 한 줄로 붙인다(별도 타일·문단 없이).
 *   · 설명 문단 두 개 → 뺐다. 규칙은 매번 읽히지 않고, 매번 읽히지 않는 문장은
 *     그 자리에 있을 이유가 없다.
 *   · 경고 4종 → **한 줄로 접었다.** 넷 다 뜻이 같다: "위 숫자에 안 들어간 것이 있다".
 *     원인이 달라도 사용자가 할 일은 같아서, 종류별로 문단을 나눌 값이 없다.
 *
 * ★ 총 수익 줄도 뺐다. 세 칸을 더하면 나오는 값이라 새 정보가 없고, 발주 지시가
 *   "이거 세개만"이었다.
 * ★ 빈 상태는 **0 원이 아니다.** 금액을 0 으로 찍으면 "0 메소를 벌었다"는 사실 주장이
 *   되므로, 아직 기록이 없을 때는 대시가 나간다(§0.3).
 */

export interface WeeklyTotalsCardProps {
  /** `null` 이면 이번 주 집계가 아직 없다. */
  readonly summary: CrystalIncomeSummary | null;
  readonly className?: string;
}

export function WeeklyTotalsCard({ summary, className }: WeeklyTotalsCardProps) {
  if (summary === null) {
    return (
      <Card className={cn("flex flex-col gap-1", className)}>
        <p className="text-body-sm font-semibold text-ink">이번 주 수익</p>
        <p className="text-body-sm text-ink-muted">
          아직 이번 주 기록이 없습니다. 보스를 잡으면 자동으로 쌓입니다.
        </p>
      </Card>
    );
  }

  const { potential } = summary;
  const monthLabel =
    summary.monthKey === null ? null : `${summary.monthKey.slice(5)}월`;

  /*
    합계에 안 들어간 것들을 **한 줄로** 센다(머리말). 넷을 각각 문단으로 그리면
    카드가 다시 길어지고, 정작 위의 숫자에서 눈이 떠난다.
  */
  const excluded =
    summary.unknownPriceCount +
    summary.weeklyOverLimitCount +
    summary.unsoldDropCount;

  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <Coins aria-hidden size={16} className="text-secondary" />
        <h2 className="text-body-sm font-semibold text-ink">이번 주 수익</h2>
      </div>

      {/*
        세 칸을 **같은 폭**으로 둔다. 금액 크기가 서로 다르면 큰 쪽이 중요해 보이는데,
        어느 것이 큰지는 그 주에 무엇을 돌았느냐일 뿐 중요도가 아니다.
        좁은 화면에서도 3열을 유지한다 — 세로로 쌓으면 "한눈에 비교"라는 이 카드의
        유일한 일이 사라진다. 그래서 금액은 compact 표기(`428억`)를 쓴다.
      */}
      <dl className="grid grid-cols-3 gap-2">
        <Tile
          label="주간"
          incomeMeso={summary.weekly.incomeMeso}
          countText={`${String(summary.weekly.clearCount)}건`}
          potentialMeso={potential?.weekly.potentialMeso ?? null}
        />
        <Tile
          label={monthLabel === null ? "월간" : `월간 ${monthLabel}`}
          incomeMeso={summary.monthly.incomeMeso}
          countText={`${String(summary.monthly.clearCount)}건`}
          potentialMeso={potential?.monthly.potentialMeso ?? null}
        />
        <Tile
          label="드랍"
          incomeMeso={summary.dropIncomeMeso}
          countText={`${String(summary.dropCount)}건`}
          potentialMeso={null}
        />
      </dl>

      {excluded > 0 ? (
        /*
          ⚠️ 이 줄을 지우지 말 것. 위 숫자가 전부라고 읽히면 안 된다 — 가격 미확인은
             0 으로 더하지 않고(§1.3 D4), 한도 초과분과 안 판 드랍도 빠져 있다.
             색은 tertiary 계열이 아니라 **잉크**다. 주의를 끌 일이 아니라 사실 고지다.
        */
        <p className="text-body-sm text-ink-muted">
          위 합계에 안 들어간 <Numeric>{excluded}</Numeric>건이 있습니다
          {summary.unknownPriceCount > 0
            ? ` · 가격 미확인 ${String(summary.unknownPriceCount)}`
            : ""}
          {summary.weeklyOverLimitCount > 0
            ? ` · 주간 한도 초과 ${String(summary.weeklyOverLimitCount)}`
            : ""}
          {summary.unsoldDropCount > 0
            ? ` · 안 판 드랍 ${String(summary.unsoldDropCount)}`
            : ""}
        </p>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Tile({
  label,
  incomeMeso,
  countText,
  potentialMeso,
}: {
  readonly label: string;
  readonly incomeMeso: number | null;
  readonly countText: string;
  /** `null` 이면 최대치 줄을 그리지 않는다 — 지어내지 않는다. */
  readonly potentialMeso: number | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background px-2.5 py-2">
      <dt className="truncate text-caption text-ink-muted">{label}</dt>
      <dd>
        <MesoAmount
          value={incomeMeso}
          compact
          suffix={false}
          className="font-headline text-body font-bold text-ink"
        />
      </dd>
      {/*
        건수와 최대치를 **한 줄에** 붙인다. 각각 줄을 차지하면 타일이 두 배로 높아지고,
        셋을 나란히 놓는다는 이 카드의 전제가 좁은 화면에서 먼저 깨진다.
      */}
      <dd className="truncate text-caption tabular-nums text-ink-muted">
        {countText}
        {potentialMeso === null ? null : (
          <>
            {" / 최대 "}
            <MesoAmount value={potentialMeso} compact suffix={false} />
          </>
        )}
      </dd>
    </div>
  );
}
