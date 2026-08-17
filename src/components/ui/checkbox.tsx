"use client";

import { Check, Minus } from "lucide-react";
import { useCallback, type ComponentPropsWithRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Checkbox.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Checkboxes
 * - 16px 박스, 1.5px border-strong, 4px 라운드
 * - checked / indeterminate 모두 primary 채움 + 흰 체크/대시
 * - disabled 40% opacity
 * - 라벨은 14px, 박스에서 8px 간격
 *
 * `indeterminate` 는 DOM 프로퍼티라 CSS 클래스만으로는 켤 수 없어 콜백 ref 로 직접 세팅한다.
 * "use client" 인 이유도 이것 하나뿐이다.
 */

export interface CheckboxProps
  extends Omit<ComponentPropsWithRef<"input">, "type"> {
  /** 부분 선택 상태. checked 보다 우선해서 대시로 표시된다. */
  indeterminate?: boolean;
  /** 있으면 <label> 로 감싸 클릭 영역을 넓힌다. */
  label?: ReactNode;
}

export function Checkbox({
  indeterminate = false,
  label,
  className,
  disabled,
  ref,
  ...props
}: CheckboxProps) {
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node) {
        node.indeterminate = indeterminate;
      }
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref, indeterminate],
  );

  const box = (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input
        ref={setRef}
        type="checkbox"
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : undefined}
        className={cn(
          "peer size-4 appearance-none rounded-sm border-[1.5px] border-border-strong bg-surface",
          "transition duration-200 outline-none",
          "checked:border-primary checked:bg-primary",
          "indeterminate:border-primary indeterminate:bg-primary",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
        {...props}
      />
      {indeterminate ? (
        <Minus
          aria-hidden
          size={12}
          strokeWidth={3}
          className={cn(
            "pointer-events-none absolute text-surface",
            // 박스가 disabled:opacity-40 을 갖고 있어 표식도 같은 감쇠를 따라간다.
            disabled && "opacity-40",
          )}
        />
      ) : (
        <Check
          aria-hidden
          size={12}
          strokeWidth={3}
          className={cn(
            "pointer-events-none absolute hidden text-surface peer-checked:block",
            disabled && "opacity-40",
          )}
        />
      )}
    </span>
  );

  if (label === undefined) {
    return box;
  }

  return (
    <label
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 text-body-sm text-ink",
        disabled && "cursor-not-allowed",
      )}
    >
      {box}
      {/* 박스 자체가 disabled:opacity-40 을 갖고 있어 라벨에만 따로 적용한다(이중 감쇠 방지). */}
      <span className={cn(disabled && "opacity-40")}>{label}</span>
    </label>
  );
}
