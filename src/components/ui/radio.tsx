import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Radio.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Radio Buttons
 * - 16px 외곽 원, 1.5px border-strong
 * - 선택 시 border primary + 8px primary 내부 점
 * - disabled 40% opacity
 * - 라벨은 14px, 원에서 8px 간격
 *
 * 내부 점은 peer-checked 로만 제어하므로 클라이언트 상태가 필요 없다(서버 컴포넌트 가능).
 */

export interface RadioProps
  extends Omit<ComponentPropsWithRef<"input">, "type"> {
  /** 있으면 <label> 로 감싸 클릭 영역을 넓힌다. */
  label?: ReactNode;
}

export function Radio({ label, className, disabled, ...props }: RadioProps) {
  const circle = (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input
        type="radio"
        disabled={disabled}
        className={cn(
          "peer size-4 appearance-none rounded-full border-[1.5px] border-border-strong bg-surface",
          "transition duration-200 outline-none",
          "checked:border-primary",
          /* 체크박스와 같은 이유로 hover 를 채웠다. 비활성은 `enabled:` 로 배제한다. */
          "enabled:hover:border-primary",
          "enabled:checked:hover:border-primary-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
        {...props}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute size-2 rounded-full bg-primary opacity-0 transition duration-200",
          // disabled 일 때도 선택 상태는 보여야 하므로 숨기지 않고 40% 로 맞춘다.
          disabled ? "peer-checked:opacity-40" : "peer-checked:opacity-100",
        )}
      />
    </span>
  );

  if (label === undefined) {
    return circle;
  }

  return (
    <label
      /* `cursor-pointer` 는 base 규칙(`label:has(input[type="radio"]…)`)이 잡는다. */
      className={cn(
        "inline-flex items-center gap-2 text-body-sm text-ink",
        disabled && "cursor-not-allowed",
      )}
    >
      {circle}
      {/* 원 자체가 disabled:opacity-40 을 갖고 있어 라벨에만 따로 적용한다. */}
      <span className={cn(disabled && "opacity-40")}>{label}</span>
    </label>
  );
}
