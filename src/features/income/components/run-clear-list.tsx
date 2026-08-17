"use client";

import { CalendarCheck, GitCompareArrows } from "lucide-react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BOSS_DIFFICULTY_LABEL,
  MesoAmount,
  formatKstShort,
} from "@/components/domain";
import { Card, CardTitle, Checkbox, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearWinner, ScheduledRunClear } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 클리어 체크 — 발주자 요구의 2순위 기능 (§1.2)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * *"등록해두고 클리어 하면 체크 → 그 주의 수익으로 자동 합산."*
 *
 * 체크가 켜지는 순간 `boss_clears` 에 그 주차 행이 생기고, DB 트리거가 그 시점 시세로
 * pot 과 내 몫을 찍는다. 합산은 `v_weekly_income` 이 이미 하고 있으므로 **화면이
 * 더할 것이 없다** — 응답으로 다시 내려온 합계를 그대로 그린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 새 기록의 인원은 **1 이 아니라 그 일정의 입장 인원**이다 (§1.3 D3)
 * ─────────────────────────────────────────────────────────────────────────────
 * 우리 런과 연결된 클리어는 인원을 이미 알고 있다(`entry_party_size`, 없으면 `capacity`).
 * 기본값 1 을 그대로 쓰면 6인 파티 보스가 6배로 잡힌다. 그래서 체크 한 번에 인원까지
 * 함께 들어가고, 아래 목록이 그 값을 미리 보여 준다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 관측과 충돌하면 **덮어쓰지 않고 어느 쪽이 이겼는지 말한다** (난제 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * 체크박스의 상태는 `manual_cleared` 가 아니라 **집계에 실제로 반영되는 값**
 * (`effective_cleared`)이다. 사람이 체크했는데 더 최신 관측이 이겨서 꺼져 있는 경우가
 * 있고, 그때 체크박스가 켜져 보이면 화면이 거짓말을 하게 된다.
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

const WINNER_LABEL: Record<ClearWinner, string> = {
  manual: "수동 체크가 반영됨",
  api: "넥슨 관측이 반영됨",
  none: "판정 없음",
};

export interface RunClearListProps {
  readonly runs: readonly ScheduledRunClear[];
  readonly pendingRunId: string | null;
  readonly onToggle: (runId: string, cleared: boolean) => void;
}

export function RunClearList({
  runs,
  pendingRunId,
  onToggle,
}: RunClearListProps) {
  const remaining = runs.filter((run) => !run.cleared).length;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarCheck aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">이번 주 등록한 일정</CardTitle>
        </div>
        <span className="text-body-sm text-ink-muted tabular-nums">
          {runs.length}건 · 남은 {remaining}건
        </span>
      </div>

      <p className="text-body-sm text-ink-muted">
        참여로 등록한 일정입니다. 클리어를 체크하면 그 주의 결정석 수익에 바로
        더해집니다. 인원은 그 일정에 잡아 둔 입장 인원으로 기록되며, 아래 목록에서
        언제든 고칠 수 있습니다.
      </p>

      {runs.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck size={24} />}
          title="이번 주에 참여로 등록한 일정이 없습니다"
          description="일정 화면에서 파티원의 가능 시간을 겹쳐 보고 보스 일정을 등록하면 여기에서 클리어를 체크할 수 있습니다."
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((run) => {
            const disabled = pendingRunId === run.runId || run.characterId === null;
            return (
              <li
                key={run.runId}
                className={cn(
                  "flex flex-col gap-2 rounded-md border border-l-4 border-border bg-surface px-3 py-2.5",
                  BOSS_DIFFICULTY_BORDER_L[run.difficulty],
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-1">
                      <Checkbox
                        checked={run.cleared}
                        disabled={disabled}
                        aria-label={`${run.bossDisplayName} 클리어 표시`}
                        onChange={(event) =>
                          onToggle(run.runId, event.target.checked)
                        }
                      />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="text-overline uppercase text-ink-muted">
                        {BOSS_DIFFICULTY_LABEL[run.difficulty]} ·{" "}
                        {CYCLE_LABEL[run.cycle]}
                        {run.cycle === "weekly" ? "" : " · 12 카운터 제외"}
                      </p>
                      <p className="font-headline text-body font-semibold text-ink">
                        {run.bossDisplayName}
                      </p>
                      <p className="text-body-sm text-ink-muted">
                        {run.partyName} {run.runNo}번 ·{" "}
                        {run.scheduledAt === null
                          ? "시각 미정"
                          : formatKstShort(new Date(run.scheduledAt))}
                        {run.characterName === null
                          ? ""
                          : ` · ${run.characterName}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-caption text-ink-label">
                      솔로 기준가
                    </span>
                    <MesoAmount
                      value={run.crystalPriceMeso}
                      compact
                      suffix={false}
                      className="text-body-sm"
                    />
                    <span className="text-caption text-ink-label tabular-nums">
                      입장 {run.entryPartySize}명 · 참여 {run.goingCount}명
                    </span>
                  </div>
                </div>

                {run.characterId === null ? (
                  <p className="text-body-sm text-ink-label">
                    이 일정에 데려갈 캐릭터를 먼저 지정해 주세요. 주간 12개 상한이
                    캐릭터당이라 캐릭터 없이는 수익을 귀속시킬 곳이 없습니다.
                  </p>
                ) : null}

                {run.hasConflict ? (
                  <p className="flex items-start gap-2 rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink">
                    <GitCompareArrows
                      aria-hidden
                      size={16}
                      className="mt-0.5 shrink-0 text-ink-muted"
                    />
                    <span>
                      인게임 관측과 수동 체크가 다릅니다. 더 최신 관측인{" "}
                      <strong className="font-semibold">
                        {WINNER_LABEL[run.winner]}
                      </strong>
                      . 진 쪽 값은 지우지 않았습니다.
                    </span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
