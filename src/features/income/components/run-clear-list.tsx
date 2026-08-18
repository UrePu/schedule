"use client";

import { CalendarCheck, GitCompareArrows, TriangleAlert } from "lucide-react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BossIcon,
  MesoAmount,
  Numeric,
  NumericText,
  formatKstShort,
} from "@/components/domain";
import { Card, CardTitle, Checkbox, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearWinner, ScheduledRunClear } from "../types";
import { DifficultyChip } from "./difficulty-chip";
import { WarningNote } from "./warning-note";

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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 한 줄로 접었나 (2026-08-18 — `clear-record-row.tsx` 와 **같은 처방**)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자: *"너무 아래로 길어."* 읽기 전용 클리어 기록은 이미 한 줄로 접었는데
 * 이 목록만 **한 건이 3층**으로 남아 있었다 — 정보 묶음 2행 + 조건부 문단 2개.
 * 일정 11건이면 같은 문장이 열 번 넘게 반복되고, 목록만 1,400px 를 먹었다.
 *
 * ★ 같은 원칙을 그대로 적용했다: **말은 한 번, 표시는 매 줄.**
 *   - **설명**(캐릭터를 왜 지정해야 하는가)은 카드 상단 경고 **한 곳**에만 둔다.
 *     거기서 건수를 세고 무엇을 해야 하는지 말한다.
 *   - **줄**은 그 상태임을 배지 하나로 알린다 — `캐릭터 미지정`. 전문은 `title` 이다.
 *   - **출처 충돌**은 줄마다 내용이 다르므로(어느 쪽이 이겼는지) 요약으로 접을 수 없다.
 *     배지에 결과를, `title` 에 전문을 둔다.
 *   지운 정보는 없다. 반복만 지웠다.
 *
 * ⚠️ 체크박스는 이 줄의 **유일한 조작**이다. 16px 짜리 상자를 그대로 두면 모바일에서
 *    누르기 어렵다 → 44×44 `<label>` 로 감싼다. 음수 마진으로 줄 높이는 그대로 두고
 *    히트 영역만 줄 패딩까지 넓힌다(줄 총높이 ≈ 44px 이라 딱 맞는다).
 * ⚠️ 난이도는 **좌측 보더 + 칩**(§4). 표시명(`하드 스우`)이 난이도를 글자로도 싣는다.
 * ⚠️ 12px(`text-caption`)로 내려간 것은 **배지와 수치 주석뿐**이다. 문장은 줄에 없다(§4).
 * ⚠️ 경고 배지는 주황이 배경·테두리·아이콘을 지고 **글자는 잉크**다 — 주황 본문은
 *    라이트 모드에서 AA 미달이다(§4).
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

/** 전문(`title`)에 쓰는 판정 문구. */
const WINNER_LABEL: Record<ClearWinner, string> = {
  manual: "수동 체크가 반영됨",
  api: "넥슨 관측이 반영됨",
  none: "판정 없음",
};

/** 배지에 쓰는 판정 문구. 한 줄에 들어가야 하므로 짧다. */
const WINNER_SHORT: Record<ClearWinner, string> = {
  manual: "수동 반영",
  api: "관측 반영",
  none: "판정 없음",
};

/** 배지 공통. 높이가 난이도 칩과 같아야 줄 높이가 칩 하나로 결정된다. */
const BADGE_BASE =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption";

export interface RunClearListProps {
  readonly runs: readonly ScheduledRunClear[];
  readonly onToggle: (runId: string, cleared: boolean) => void;
}

/*
 * ★ **`pendingRunId` prop 이 사라졌다** (낙관적 업데이트, 2026-08-18).
 *   체크는 이제 즉시 반영되므로 "저장 중이라 못 누름" 상태 자체가 없다. 남은 비활성
 *   사유는 **캐릭터 미지정** 하나뿐이며, 그것은 저장 중이어서가 아니라 12개 상한이
 *   캐릭터당이라 귀속시킬 곳이 없기 때문이다(카드 상단 경고가 이유를 말한다).
 *   실패하면 체크가 되돌아가고 롤백 알림이 그 사실을 말한다(`@/lib/query/optimistic`).
 */
export function RunClearList({ runs, onToggle }: RunClearListProps) {
  const remaining = runs.filter((run) => !run.cleared).length;
  const missingCharacterCount = runs.filter(
    (run) => run.characterId === null,
  ).length;

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
        더해집니다. 인원은 그 일정에 잡아 둔 입장 인원으로 기록되며, 위 &lsquo;수정&rsquo;에서
        언제든 고칠 수 있습니다.
      </p>

      {/*
        ★ **캐릭터 미지정 안내가 사는 유일한 자리.** 예전에는 해당 줄마다 같은 문단이
          통째로 반복됐다. 여기서 건수와 이유를 한 번만 말하고, 줄에는 배지만 남긴다.
      */}
      {missingCharacterCount > 0 ? (
        <WarningNote>
          데려갈 캐릭터가 정해지지 않은 일정이 {missingCharacterCount}건 있습니다 —
          아래에서 &lsquo;캐릭터 미지정&rsquo; 배지가 붙은 줄입니다. 주간 12개 상한이
          캐릭터당이라 캐릭터 없이는 수익을 귀속시킬 곳이 없어 체크할 수 없습니다.
          일정 화면에서 캐릭터를 지정하면 바로 체크할 수 있습니다.
        </WarningNote>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck size={24} />}
          title="이번 주에 참여로 등록한 일정이 없습니다"
          description="일정 화면에서 파티원의 가능 시간을 겹쳐 보고 보스 일정을 등록하면 여기에서 클리어를 체크할 수 있습니다."
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {runs.map((run) => {
            const disabled = run.characterId === null;

            return (
              <li
                key={run.runId}
                className={cn(
                  "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-l-4 border-border bg-surface px-2.5 py-1.5",
                  BOSS_DIFFICULTY_BORDER_L[run.difficulty],
                )}
              >
                {/*
                  유일한 조작. 44×44 히트 영역을 `<label>` 이 만든다.
                  `cursor-pointer` 는 `globals.css` base 의
                  `label:has(input[type="checkbox"]:not(:disabled))` 가 잡으므로 여기 적지 않는다.
                */}
                <label
                  className={cn(
                    "-my-1.5 flex size-11 shrink-0 items-center justify-center rounded-md",
                    "transition duration-200",
                    disabled ? "cursor-not-allowed" : "hover:bg-hover-strong",
                  )}
                >
                  <Checkbox
                    checked={run.cleared}
                    disabled={disabled}
                    aria-label={`${run.bossDisplayName} 클리어 표시`}
                    onChange={(event) =>
                      onToggle(run.runId, event.target.checked)
                    }
                  />
                </label>

                {/* 🖼️ 파일이 없는 보스는 실루엣 폴백. 오류가 아니다(§2.1.1). */}
                <BossIcon
                  bossDifficultyId={run.bossDifficultyId}
                  difficulty={run.difficulty}
                  size="sm"
                />

                {/*
                  표시명은 이미 `하드 스우` 형태다(난이도 포함). 이름만 늘어나고
                  나머지는 `shrink-0` 이라, 긴 이름이 배지를 밀어내지 않는다.
                */}
                <span
                  className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink"
                  title={run.bossDisplayName}
                >
                  {run.bossDisplayName}
                </span>

                <DifficultyChip difficulty={run.difficulty} />

                {/*
                  주기만 적는다. 카운터 제외 문구는 발주자 지시로 뺐다(2026-08-18 —
                  주간 체크리스트·보스 계획에서 먼저 빠진 것과 같은 결정).
                  `월간` 이라는 말이 이미 카운터 밖임을 전달한다.
                */}
                <span className="shrink-0 whitespace-nowrap text-caption text-ink-muted">
                  {CYCLE_LABEL[run.cycle]}
                </span>

                {/*
                  런 시작 시각 + 어느 파티의 몇 번 런인가. 줄이 세로로 쌓이므로
                  등폭이어야 `8/20 목 21:00` 과 `8/2 토 9:00` 이 같은 리듬으로 읽힌다.
                  요일 한 글자는 `NumericText` 가 본문 서체로 남긴다.
                */}
                <span
                  className="shrink-0 whitespace-nowrap text-caption text-ink-muted"
                  title={`${run.partyName} ${String(run.runNo)}번 일정`}
                >
                  {run.scheduledAt === null ? (
                    "시각 미정"
                  ) : (
                    <NumericText>
                      {formatKstShort(new Date(run.scheduledAt))}
                    </NumericText>
                  )}
                  {" · "}
                  {run.partyName} <Numeric>{run.runNo}</Numeric>번
                </span>

                {/*
                  캐릭터. 미지정이면 **같은 자리가 경고 배지로 바뀐다** — 줄이 한 줄로
                  유지된다. 전문은 `title` 이고, 왜 그런지는 카드 상단 경고가 말한다.
                */}
                {run.characterId === null ? (
                  <span
                    className={cn(
                      BADGE_BASE,
                      "border-chip-soon-border bg-chip-soon-bg text-ink",
                    )}
                    title="이 일정에 데려갈 캐릭터가 지정되지 않았습니다. 주간 12개 상한이 캐릭터당이라 캐릭터 없이는 수익을 귀속시킬 곳이 없어 클리어를 체크할 수 없습니다. 일정 화면에서 캐릭터를 지정해 주세요."
                  >
                    <TriangleAlert
                      aria-hidden
                      size={12}
                      className="shrink-0 text-tertiary"
                    />
                    캐릭터 미지정
                  </span>
                ) : (
                  <span
                    className="max-w-28 shrink-0 truncate text-caption text-ink-muted"
                    title={run.characterName ?? undefined}
                  >
                    {run.characterName}
                  </span>
                )}

                <span className="shrink-0 whitespace-nowrap text-caption text-ink-muted">
                  입장 <Numeric>{run.entryPartySize}</Numeric>명 · 참여{" "}
                  <Numeric>{run.goingCount}</Numeric>명
                </span>

                {/*
                  출처 충돌(난제 6). 줄마다 **다른 내용**이라 요약으로 접지 않고
                  배지에 결과를, `title` 에 전문을 둔다. 색은 중립이다 — 실패가 아니므로
                  빨강이 아니고, 조치가 필요한 상태도 아니므로 주황도 아니다(§4).
                */}
                {run.hasConflict ? (
                  <span
                    className={cn(
                      BADGE_BASE,
                      "border-border bg-neutral-100 text-ink",
                    )}
                    title={`인게임 관측과 수동 체크가 다릅니다. 더 최신 관측인 ${WINNER_LABEL[run.winner]}. 진 쪽 값은 지우지 않고 그대로 두었습니다.`}
                  >
                    <GitCompareArrows
                      aria-hidden
                      size={12}
                      className="shrink-0 text-ink-muted"
                    />
                    불일치 · {WINNER_SHORT[run.winner]}
                  </span>
                ) : null}

                {/*
                  솔로 기준가. 앞의 배지 폭이 줄마다 달라도 금액 자릿수는 세로로 줄이
                  서도록 `min-w-20 justify-end` 로 오른쪽에 세운다
                  (`Claude/FONT-NOTES.md` §9 — 등폭의 목적).
                  `null` 은 "미확인"으로 그려진다. 0 이 아니다(§1.3 D4).
                */}
                <MesoAmount
                  value={run.crystalPriceMeso}
                  compact
                  suffix={false}
                  className="min-w-20 shrink-0 justify-end text-body-sm"
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
