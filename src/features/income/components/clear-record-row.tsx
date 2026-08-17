"use client";

import { GitCompareArrows, TriangleAlert } from "lucide-react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  MesoAmount,
  formatKstShort,
} from "@/components/domain";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearRecord, ClearSource, ClearWinner } from "../types";
import { BossIconSlot, DifficultyChip } from "./difficulty-chip";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 클리어 한 건 — **읽기 전용**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 고치는 일은 전부 수정 모달(`IncomeEditDialog`)이 한다. 이 줄에는 입력이 하나도 없다.
 * 예전에는 줄마다 인원 입력칸 + 도움말 문단 + 경고 서너 개가 붙어 있어서, "이번 주에
 * 얼마 벌었나"를 보려는 사람이 편집 UI 를 계속 넘겨야 했다 — 그게 "난잡하다"의 실체였다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래도 **남긴** 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **인원 미확인 배지** — 이 화면에서 고칠 수는 없어도, 그 사실을 숨기면 사용자는 최대
 *    6배로 부풀려진 금액을 사실로 읽는다. 배지는 "수정" 버튼으로 가라는 신호다.
 * 2. **가격 미확인** — `MesoAmount` 가 `null` 을 "미확인"으로 그린다. 0 이 아니다(§1.3 D4).
 * 3. **출처 충돌** — 넥슨 관측과 수동 체크가 다르면 어느 쪽이 반영됐는지 말한다(난제 6).
 *    조용히 한쪽을 지우면 사용자는 자기 체크가 왜 사라졌는지 알 수 없다.
 *
 * ⚠️ **숫자를 만들지 않는다.** `내 몫` 은 `boss_clears.crystal_share_meso` 스냅샷 그대로다.
 * ⚠️ 난이도는 **좌측 보더 + 칩**(§4). 상태는 보더를 덮지 않는다.
 */

const SOURCE_LABEL: Record<ClearSource, string> = {
  manual: "수동 체크",
  nexon_api: "넥슨 관측",
  bot: "카톡 봇",
};

const WINNER_LABEL: Record<ClearWinner, string> = {
  manual: "수동 체크가 반영됨",
  api: "넥슨 관측이 반영됨",
  none: "판정 없음",
};

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

export interface ClearRecordRowProps {
  readonly clear: ClearRecord;
}

export function ClearRecordRow({ clear }: ClearRecordRowProps) {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-md border border-l-4 border-border bg-surface px-3 py-2.5",
        BOSS_DIFFICULTY_BORDER_L[clear.difficulty],
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BossIconSlot difficulty={clear.difficulty} />
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태다(난이도 포함). */}
            <span className="truncate text-body-sm font-semibold text-ink">
              {clear.bossDisplayName}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <DifficultyChip difficulty={clear.difficulty} />
              <span className="text-caption text-ink-muted tabular-nums">
                {clear.cycle === null ? "주기 미상" : CYCLE_LABEL[clear.cycle]}
                {clear.countsTowardWeeklyLimit ? "" : " · 12 카운터 제외"} ·{" "}
                {clear.partySize}인 입장
              </span>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <MesoAmount
            value={clear.shareMeso}
            compact
            suffix={false}
            tone="accent"
            className="text-body-sm font-semibold"
          />
          <span className="text-caption text-ink-muted">
            {SOURCE_LABEL[clear.source]}
            {clear.clearedAt === null
              ? ""
              : ` · ${formatKstShort(new Date(clear.clearedAt))}`}
          </span>
        </div>
      </div>

      {/*
        인원 미확인 — **여기서는 알리기만 한다.** 고치는 곳은 수정 모달이다.
        색은 tertiary orange 이고 문장은 잉크다(§4). red 는 실패·취소 전용.
      */}
      {clear.partySizeUnconfirmed ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2.5 py-1.5 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={14}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            입장 인원이 확인되지 않았습니다. 지금 값은 {clear.partySize}명입니다 —
            실제로 파티였다면 수익이 최대 6배로 잡혀 있습니다.{" "}
            <strong className="font-semibold">수정</strong>에서 고칠 수 있습니다.
          </span>
        </p>
      ) : null}

      {clear.hasConflict ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-neutral-100 px-2.5 py-1.5 text-body-sm text-ink">
          <GitCompareArrows
            aria-hidden
            size={14}
            className="mt-0.5 shrink-0 text-ink-muted"
          />
          <span>
            인게임 관측({clear.apiCleared === true ? "클리어" : "미클리어"})과 수동
            체크({clear.manualCleared === true ? "클리어" : "미클리어"})가 다릅니다.
            더 최신 관측인{" "}
            <strong className="font-semibold">{WINNER_LABEL[clear.winner]}</strong>.
            진 쪽 값은 지우지 않고 그대로 두었습니다.
          </span>
        </p>
      ) : null}
    </li>
  );
}
