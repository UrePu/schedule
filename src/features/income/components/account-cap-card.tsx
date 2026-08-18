import { Gauge } from "lucide-react";

import { Numeric } from "@/components/domain";
import { Card, CardDescription, CardOverline, CardTitle } from "@/components/ui";
import { TRACKED_SCOPE_NOTE } from "@/lib/domain/boss-scope";
import { cn } from "@/lib/utils";

import type { AccountCrystalUsage } from "../types";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨 **계정당** 주 90개 결정석 천장 (§1.3 D2)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 정정(2026-08-18): *"캡경고 90개는 계정당이니까 참고해서 반영해"*
 * 이전 설계는 **월드당**이었고 그 기준이 틀렸다. 집계 경로는
 * `boss_clears.character_id → characters.nexon_account_ref → credential_nexon_accounts`
 * 이며 서버(`server/crystal-scope.ts`)가 질의 시점에 묶는다 — 스키마 변경 없음.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 카드가 반드시 지키는 것 셋
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **막지 않는다.** 90 을 넘겨도 경고만 하고, 표시 수익을 조용히 깎지 않는다(D2).
 * 2. **과소 계상을 숨기지 않는다.** 일간 보스가 범위 밖이라 우리 숫자에는 일간 결정석이
 *    빠져 있다 — 일간을 도는 사람은 우리가 예고하는 것보다 **먼저** 진짜 90 에 닿는다.
 *    천장 경고가 조용히 과소 보고하면 없느니만 못하므로, 그 문장을 **항상** 그린다
 *    (경고가 켜졌을 때만이 아니다).
 * 3. **12개 상한과 섞지 않는다.** 12는 캐릭터당 주간 보스 수, 90은 계정당 결정석 총량이다.
 *    원장이 서로 분리돼 있어 한쪽이 다른 쪽을 움직이지 않는다(§1).
 *
 * §4 준수:
 * - 경고는 **tertiary orange** 다. red 는 실패·취소 전용이라 여기 오지 않는다.
 * - 주황은 **배경·아이콘·막대**만 진다. 읽어야 하는 문장은 전부 `text-ink` 다 —
 *   주황 본문은 라이트 모드에서 AA(4.5:1) 미달이다.
 * - 문장은 `text-body-sm`(14px) 이상. `text-caption` 은 숫자 주석에만 쓴다.
 */

export interface AccountCrystalCapCardProps {
  readonly accounts: readonly AccountCrystalUsage[];
  /** 어느 계정에도 붙이지 못한 클리어 수. 0 이 아니면 아래 숫자가 그만큼 더 낮다. */
  readonly unassignedCount: number;
  readonly className?: string;
}

/** 사용량 막대. 값이 아니라 **상태**를 색으로 말한다 — 접근/초과면 주황. */
function UsageMeter({ usage }: { readonly usage: AccountCrystalUsage }) {
  const ratio =
    usage.limit <= 0 ? 0 : Math.min(usage.crystalCount / usage.limit, 1);
  const alert = usage.overLimit || usage.nearLimit;

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-hover-surface"
      role="presentation"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-200",
          alert ? "bg-tertiary" : "bg-primary",
        )}
        style={{ width: `${String(Math.round(ratio * 100))}%` }}
      />
    </div>
  );
}

function AccountRow({ usage }: { readonly usage: AccountCrystalUsage }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-pad-md">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-body-sm font-semibold text-ink">
          {usage.label}
        </span>
        {/*
          90개 상한 카운터(§1.3 D2). 계정 카드가 세로로 쌓이고 오른쪽 정렬이라
          자릿수가 어긋나면 바로 눈에 띈다. `개` 는 한글이라 mono 밖이다.
          아래 `주간 · 월간 · 캐릭터 · 남은 칸` 줄은 일부러 그대로 뒀다 — 라벨 길이가
          제각각이라 어차피 세로로 줄이 서지 않는다(`Claude/FONT-NOTES.md` §9).
          `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
        */}
        <span className="shrink-0 text-body-sm text-ink tabular-nums">
          <Numeric>
            {usage.crystalCount} / {usage.limit}
          </Numeric>
          개
        </span>
      </div>

      <UsageMeter usage={usage} />

      <p className="text-caption text-ink-label tabular-nums">
        주간 {usage.weeklyCount} · 월간 {usage.monthlyCount} · 캐릭터{" "}
        {usage.characterCount}명 · 남은 칸 {usage.remaining}
      </p>

      {usage.overLimit ? (
        <WarningNote>
          이 계정의 이번 주 결정석이 상한({usage.limit}개)을 넘었습니다. 넘긴
          만큼은 판매되지 않습니다. 등록을 막지는 않습니다.
        </WarningNote>
      ) : usage.nearLimit ? (
        <WarningNote>
          이 계정의 상한({usage.limit}개)까지 {usage.remaining}칸 남았습니다.
        </WarningNote>
      ) : null}
    </li>
  );
}

export function AccountCrystalCapCard({
  accounts,
  unassignedCount,
  className,
}: AccountCrystalCapCardProps) {
  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start gap-2">
        <Gauge aria-hidden size={20} className="mt-0.5 text-secondary" />
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>넥슨 계정당 주 상한</CardOverline>
          <CardTitle className="text-body-lg">결정석 90개 천장</CardTitle>
        </div>
      </div>

      {accounts.length === 0 ? (
        /* 빈 상태 — "0개 썼다"가 아니라 "아직 셀 것이 없다"이다. */
        <CardDescription>
          이번 주에 집계된 결정석이 아직 없습니다. 보스를 클리어로 체크하면 넥슨
          계정별 사용량이 여기에 쌓입니다.
        </CardDescription>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((usage) => (
            <AccountRow key={usage.accountRef ?? "unknown"} usage={usage} />
          ))}
        </ul>
      )}

      {/*
        ★ **항상 그린다.** 경고가 켜졌을 때만 밝히면, 켜지지 않은 화면은 "아직 여유가
          있다"고 읽히는데 그 판단의 근거가 이미 낮게 잡힌 숫자다.
      */}
      <p className="text-body-sm text-ink-muted">{TRACKED_SCOPE_NOTE}</p>

      {unassignedCount > 0 ? (
        <p className="text-body-sm text-ink-muted">
          어느 넥슨 계정의 것인지 알 수 없는 클리어가 {unassignedCount}건 있어
          위 숫자에 들어가지 않았습니다. 계정 · 키 관리에서 키를 다시 확인하면
          연결이 복구됩니다.
        </p>
      ) : null}
    </Card>
  );
}
