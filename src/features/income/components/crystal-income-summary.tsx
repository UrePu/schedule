import { MesoAmount, Numeric } from "@/components/domain";
import { cn } from "@/lib/utils";

import type { CrystalIncomeSummary, CrystalPotentialCycle } from "../types";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 결정석 수익 — **대시보드 카드와 수익 화면 상단이 함께 쓰는 단 하나의 표시**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-19):
 *   · *"주간 월간은 따로놔야지"*
 *   · 결정석 수익에 **이론상 최대치**를 표시한다.
 *
 * ⚠️ **두 화면이 같은 값을 말해야 한다.** 그래서 조립은 서버 한 곳
 *    (`server/crystal-summary.ts`)이고 그리는 것도 이 컴포넌트 하나다. 카드 껍데기(제목·
 *    진입 버튼)만 화면마다 다르고, 그 안의 숫자는 글자 하나까지 같다.
 *
 * ⚠️ **여기서 계산하지 않는다.** 유일한 산수는 `현재 / 최대` 백분율 하나이며, 그것도
 *    표시용 반올림이라 어떤 합계에도 들어가지 않는다. 금액·건수·최대치는 전부 DB 뷰가
 *    낸 값이다(마이그레이션 27).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 주간과 월간을 갈랐는가 (§1)
 * ─────────────────────────────────────────────────────────────────────────────
 * **12개 상한은 주간 보스에만 걸린다.** 예전 카드는 `주간 보스 40 / 84건` 옆에
 * `주간+월간 41건` 을 놓았는데, 그 41 은 84칸과 아무 관계가 없다 — 월간 결정석은 그
 * 카운터에 한 칸도 들어가지 않는다. 분모가 뜻을 잃은 상태였다.
 *   · 주간의 분모 = **추적 캐릭터 수 × 캐릭터당 상한**(§1.1.1). 상한을 모르거나 추적이
 *     0명이면 분모를 **지어내지 않고** 건수만 쓴다.
 *   · 월간의 분모 = **이번 주 계획에 켜진 월간 보스 수**. 월간에는 상한이 없으므로
 *     "몇 개 중 몇 개"의 기준이 계획밖에 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이론상 최대치는 **목표가 아니라 상한이다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 실제로 갈 생각이 없는 보스도 계획에 켜져 있으면 분모가 커진다. 그 뜻을 화면이 한 문장
 * 으로 직접 말한다 — 말하지 않으면 사용자는 `46%` 를 "내가 절반도 못 했다"로 읽는다.
 * **가격 미확인은 최대치에서 빠져 있고 건수로만 보고된다** (§1.3 D4 — 0 으로 더하면
 * 최대치가 과소평가되고, 그게 D4 가 금지한 바로 그 짓이다).
 *
 * §4 준수:
 * - 경고는 **tertiary orange**. red 는 실패·취소 전용이라 여기 오지 않는다.
 * - 주황은 배경·아이콘만 지고 문장은 `text-ink` 다(`WarningNote`) — 주황 본문은 라이트
 *   모드에서 `#f97316` / `#ffffff` = 2.80:1 로 AA 미달이었다.
 *   (2026-08-19 라이트 `tertiary` 를 `#cf6016` 으로 재산정 — 그래도 3.93:1 이라 규약은 그대로다.
 *    글자에 주황이 꼭 필요한 자리에는 `tertiary-ink` 를 쓴다.)
 * - **문장은 `text-body-sm`(14px) 이상.** `text-caption`(12px) 은 아래 수치 주석
 *   (`298억 · 최대 410억`)에만 쓴다 — 그건 읽는 문장이 아니라 숫자 라벨이다.
 * - 대비는 **실제 색 쌍으로 계산했다**(토큰 표가 아니라 — §4 가 두 번 데인 자리):
 *   `ink-muted`/`background` 라이트 **4.63** · 다크 **9.66**,
 *   `ink`/`background` 라이트 **16.97** · 다크 **17.27**,
 *   `primary`/`background` 라이트 **6.02** · 다크 **6.12**. 전부 AA(4.5:1) 통과.
 *   ⚠️ `ink-placeholder`/`background` 는 라이트 **2.46** 으로 미달이라 이 화면의 어떤
 *      글자에도 쓰지 않는다.
 */

export interface CrystalIncomeSummaryPanelProps {
  /** `null` 이면 이번 주 집계도 계획 최대치도 없다 — 빈 상태 문구만 그린다. */
  readonly summary: CrystalIncomeSummary | null;
  /** 빈 상태에서 보여 줄 안내. 화면마다 다음 동선이 다르므로 주입받는다. */
  readonly emptyDescription: string;
  readonly className?: string;
}

/** `현재 / 최대` 백분율. **표시용이며 어떤 합계에도 들어가지 않는다.** */
function ratioPercent(
  actual: number | null,
  potential: number | null,
): number | null {
  if (actual === null || potential === null || potential <= 0) return null;
  return Math.round((actual / potential) * 100);
}

/** 한 칸(주간 · 월간)의 뼈대. 분모가 없으면 건수만 쓴다 — 숫자를 지어내지 않는다. */
function CycleStat({
  label,
  clearCount,
  denominator,
  incomeMeso,
  potential,
}: {
  readonly label: string;
  readonly clearCount: number;
  /** `null` = 분모를 모른다. **`0` 과 다르다.** */
  readonly denominator: number | null;
  readonly incomeMeso: number | null;
  readonly potential: CrystalPotentialCycle | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-pad-md">
      <dt className="text-body-sm text-ink-muted">{label}</dt>
      <dd className="text-body-sm font-semibold text-ink tabular-nums">
        {denominator === null ? (
          <>
            <Numeric>{clearCount}</Numeric>건
          </>
        ) : (
          <>
            <Numeric>
              {clearCount} / {denominator}
            </Numeric>
            건
          </>
        )}
      </dd>
      <dd className="flex flex-wrap items-baseline gap-x-1.5">
        <MesoAmount
          value={incomeMeso}
          compact
          suffix={false}
          tone="accent"
          className="font-headline text-body font-semibold"
        />
        {potential === null ? null : (
          <span className="text-caption text-ink-muted">
            {/* 수치 주석이라 12px 이 허용된다(§4). 문장이 아니다. */}
            · 최대{" "}
            <MesoAmount
              value={potential.potentialMeso}
              compact
              suffix={false}
              className="text-caption"
            />
          </span>
        )}
      </dd>
    </div>
  );
}

export function CrystalIncomeSummaryPanel({
  summary,
  emptyDescription,
  className,
}: CrystalIncomeSummaryPanelProps) {
  if (summary === null) {
    /*
      빈 상태 — **"0 메소를 벌었다"가 아니라 "아직 아무것도 없다"** 이다.
      두 상태를 같은 화면으로 그리면 안 되므로 금액을 0 으로 찍지 않는다(§0.3).
    */
    return (
      <p className={cn("text-body-sm text-ink-muted", className)}>
        {emptyDescription}
      </p>
    );
  }

  const { potential, slots } = summary;
  const percent =
    potential === null
      ? null
      : ratioPercent(summary.crystalIncomeMeso, potential.totalPotentialMeso);

  /*
    최대치에서 빠진 것들. **합쳐서 한 문장으로** 말한다 — 미확인과 상한 초과는 원인이
    다르지만 사용자가 취할 조치("최대치가 실제보다 낮게 보인다"를 이해하는 것)는 같고,
    경고 블록을 두 개로 늘리면 카드가 세로로 길어진다(2026-08-18 발주자: *"너무 아래로 길어"*).
  */
  const potentialUnknown =
    potential === null
      ? 0
      : potential.weekly.unknownPriceCount + potential.monthly.unknownPriceCount;
  const potentialOverLimit =
    potential === null
      ? 0
      : potential.weekly.overLimitCount + potential.monthly.overLimitCount;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* ── 큰 금액 + 이론상 최대치 ──────────────────────────────────────── */}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <MesoAmount
          value={summary.crystalIncomeMeso}
          compact
          suffix={false}
          tone="accent"
          className="font-headline text-subhead font-bold"
        />
        <span className="text-body-sm text-ink-muted">메소</span>
        {potential === null ? null : (
          <span className="text-body-sm text-ink-muted">
            · 최대{" "}
            <MesoAmount
              value={potential.totalPotentialMeso}
              compact
              suffix={false}
              className="text-body-sm"
            />
            {percent === null ? null : (
              <>
                {" ("}
                <Numeric>{percent}</Numeric>
                {"%)"}
              </>
            )}
          </span>
        )}
      </p>

      {potential === null ? null : (
        /*
          ★ **이 문장을 지우지 말 것.** 최대치는 상한이지 목표가 아니다. 실제로 갈 생각이
            없는 보스도 계획에 켜져 있으면 분모가 커지므로, 설명이 없으면 사용자는 백분율을
            "내가 절반도 못 했다"로 읽는다.
        */
        <p className="text-body-sm text-ink-muted">
          최대치는 <strong className="font-semibold text-ink">이번 주 계획에 켜진 보스를 전부 클리어했을 때</strong>의
          상한입니다. 목표가 아니며, 실제로 가지 않을 보스가 계획에 남아 있으면 그만큼
          높게 잡힙니다. 계산은 계획에 저장된 인원으로 나눈 값입니다.
        </p>
      )}

      {/* ── 주간 / 월간 / 드랍 — 12개 상한은 주간에만 걸린다 ─────────────── */}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <CycleStat
          label="주간 보스"
          clearCount={summary.weekly.clearCount}
          denominator={slots.limitTotal}
          incomeMeso={summary.weekly.incomeMeso}
          potential={potential?.weekly ?? null}
        />
        <CycleStat
          label="월간 보스"
          clearCount={summary.monthly.clearCount}
          /* 월간에는 상한이 없다. 기준이 될 수 있는 것은 **계획한 개수**뿐이다. */
          denominator={potential === null ? null : potential.monthly.plannedCount}
          incomeMeso={summary.monthly.incomeMeso}
          potential={potential?.monthly ?? null}
        />
        <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-pad-md">
          <dt className="text-body-sm text-ink-muted">드랍 수익</dt>
          <dd className="text-body-sm font-semibold text-ink tabular-nums">
            <Numeric>{summary.dropCount}</Numeric>건
          </dd>
          <dd>
            <MesoAmount
              value={summary.dropIncomeMeso}
              compact
              suffix={false}
              className="font-headline text-body font-semibold"
            />
          </dd>
        </div>
      </dl>

      {/* ── 총 수익 = 결정석 + 드랍. **뷰가 낸 값이다** ─────────────────── */}
      <div className="flex items-baseline justify-between gap-2 border-t border-border pt-2">
        <span className="text-body-sm text-ink-label">총 수익</span>
        <MesoAmount
          value={summary.totalIncomeMeso}
          compact
          className="text-body font-semibold"
        />
      </div>

      {/*
        ⚠️ 여기부터는 **합계에 들어가지 않은 것들**이다.
           합계 아래에 두는 이유: 위 숫자가 전부라고 읽히면 안 되기 때문이다.
      */}
      {summary.unknownPriceCount > 0 ? (
        <WarningNote>
          가격 미확인 {summary.unknownPriceCount}건은 합계에서 제외했습니다. 0 으로
          더하지 않습니다.
        </WarningNote>
      ) : null}

      {potentialUnknown > 0 || potentialOverLimit > 0 ? (
        <WarningNote>
          최대치에서 빠진 계획이 있습니다
          {potentialUnknown > 0
            ? ` — 가격 미확인 ${String(potentialUnknown)}건`
            : ""}
          {potentialOverLimit > 0
            ? `${potentialUnknown > 0 ? " ·" : " —"} 캐릭터당 주간 한도를 넘긴 계획 ${String(potentialOverLimit)}건`
            : ""}
          . 그만큼 위 최대치는 실제 상한보다 낮게 잡혀 있습니다.
        </WarningNote>
      ) : null}

      {summary.weeklyOverLimitCount > 0 ? (
        <WarningNote>
          캐릭터당 주간 판매 한도
          {slots.perCharacterLimit === null
            ? ""
            : `(${String(slots.perCharacterLimit)}개)`}
          를 넘긴 클리어가 {summary.weeklyOverLimitCount}건 있습니다. 어느 캐릭터인지는
          아래 주차별 내역에서 확인할 수 있습니다.
        </WarningNote>
      ) : null}

      {summary.unsoldDropCount > 0 ? (
        <p className="text-body-sm text-ink-muted">
          아직 팔지 않은 드랍 {summary.unsoldDropCount}건은 합계에 들어가지 않았습니다.
          일정 목록에서 판매액을 채우면 그때 반영됩니다.
        </p>
      ) : null}

      {/*
        §1.3 D1 — **판매 주차가 아니라 클리어 주차 기준**이라는 근사 고지. 그리고 일간
        보스가 범위 밖이라는 사실(2026-08-18 발주자 결정). 둘 다 지우지 않는다.
      */}
      <p className="text-body-sm text-ink-muted">
        클리어 주차 기준 근사치입니다. 결정석은 획득 후 1주일간 유효해서 목요일 초기화를
        넘겨 팔 수 있고, 그 경우 인게임 메소와 어긋납니다. 일간 보스는 추적하지 않아
        건수·금액 어디에도 들어가지 않습니다.
      </p>
    </div>
  );
}
