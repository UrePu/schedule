"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 마법사 단계 표시줄 — **한 번에 하나만 묻는 창**의 머리
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"시간(고정), 보스, 참여자 순서대로 고르면 모달 자체가
 * 넘어가도록 변경해"* · *"파티생성시에 파티이름, 파티원, 갈 보스, 분배 순서대로
 * 한번에 하나의 정보만 입력하도록 해봐"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 표시줄이 필요한가 — 한 번에 하나만 보이면 **끝을 모른다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 화면에 전부 늘어놓는 폼의 유일한 장점은 "얼마나 남았는지 보인다"였다. 단계로
 * 쪼개면 그것이 사라지므로, 남은 단계를 **항상 보이게** 되돌려 준다. 이게 없으면
 * 사용자는 세 번째 질문에서 "이거 언제 끝나지" 를 묻게 된다.
 *
 * ★ **지나온 단계는 누를 수 있다.** 앞 단계로 돌아가는 것은 취소가 아니라 정정이고,
 *   막아 두면 오타 하나 때문에 창을 닫았다 다시 열게 된다.
 * ★ **앞으로는 못 간다.** 아직 답하지 않은 질문으로 건너뛰면 그 다음 단계가 무엇을
 *   근거로 목록을 만들지 알 수 없다(보스는 시간에, 참여자는 보스에 딸린다).
 *
 * 색만으로 상태를 말하지 않는다(§4) — 완료는 **체크 표시**, 현재는 굵기와 링,
 * 나머지는 흐린 숫자. 명암비만으로 세 상태를 가르면 대비가 낮은 화면에서 뭉갠다.
 */

export interface WizardStep {
  /** 짧은 이름. 표시줄에 그대로 나온다 — 문장이 아니라 명사여야 한다. */
  readonly label: string;
  /** 이 단계가 답해졌는가. 완료 표시와 "다음" 활성화의 근거다. */
  readonly complete: boolean;
}

export interface WizardStepsProps {
  readonly steps: readonly WizardStep[];
  /** 0-based. */
  readonly current: number;
  /** 지나온 단계를 눌렀을 때. 없으면 되돌아가기가 막힌다(저장 중 등). */
  readonly onGoTo?: (index: number) => void;
  readonly className?: string;
}

export function WizardSteps({
  steps,
  current,
  onGoTo,
  className,
}: WizardStepsProps) {
  return (
    /*
      좁은 화면에서 4단계가 한 줄에 들어가지 않는다. 줄바꿈 대신 **가로 스크롤**을
      쓴다 — 줄이 늘면 다이얼로그 본문이 그만큼 밀려 정작 질문이 접힌다.
      `overflow-x-auto` 는 세로축도 auto 로 만들므로 세로 여유(`py`)를 넉넉히 준다.
    */
    <ol
      className={cn(
        "flex items-center gap-1 overflow-x-auto py-1",
        className,
      )}
    >
      {steps.map((step, index) => {
        const isCurrent = index === current;
        const isPast = index < current;
        const canGo = isPast && onGoTo !== undefined;

        return (
          <li key={step.label} className="flex shrink-0 items-center gap-1">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-4 shrink-0",
                  isPast || isCurrent ? "bg-primary" : "bg-border",
                )}
              />
            ) : null}

            <button
              type="button"
              disabled={!canGo}
              onClick={canGo ? () => onGoTo(index) : undefined}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition duration-200",
                isCurrent
                  ? "bg-primary-subtle text-primary ring-1 ring-primary"
                  : isPast
                    ? "text-ink"
                    : "text-ink-placeholder",
                canGo ? "hover:bg-hover-strong" : "cursor-default",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-overline tabular-nums",
                  step.complete
                    ? "bg-success text-white"
                    : isCurrent
                      ? "bg-primary text-white"
                      : "bg-hover-strong text-ink-muted",
                )}
              >
                {step.complete ? (
                  <Check aria-hidden size={11} strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              {/*
                단계 이름은 문장이 아니라 라벨이라 `text-caption`(12px)이 규칙에 맞다(§4).
                현재 단계만 굵게 — 굵기가 색을 보조하는 두 번째 채널이다.
              */}
              <span
                className={cn(
                  "whitespace-nowrap text-caption",
                  isCurrent ? "font-bold" : "font-medium",
                )}
              >
                {step.label}
              </span>
              {step.complete ? (
                <span className="sr-only">(완료)</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
