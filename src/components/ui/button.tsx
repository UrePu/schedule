import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Button.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Buttons
 * - Primary(filled) / Secondary(outline) / Ghost / Destructive
 * - 높이 Small 32px · Medium 38px · Large 46px, 패딩 8px/18px, 라운드 8px
 * - disabled 는 40% opacity + disabled 커서
 * - 전환은 200ms 를 넘지 않는다 (§4)
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE_CLASS =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 " +
  "whitespace-nowrap rounded-md px-btn-x py-2 font-semibold " +
  "transition duration-200 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-surface shadow-subtle hover:bg-primary-hover " +
    "active:bg-primary-active active:scale-[0.98] disabled:hover:bg-primary",
  secondary:
    "border border-primary bg-transparent text-primary " +
    "hover:bg-primary-subtle active:bg-primary-subtle disabled:hover:bg-transparent",
  ghost:
    "bg-transparent text-ink-muted hover:bg-hover-surface hover:text-ink " +
    "disabled:hover:bg-transparent disabled:hover:text-ink-muted",
  destructive:
    "bg-error text-surface hover:bg-error-hover disabled:hover:bg-error",
};

/** 디자인 문서는 높이만 크기별로 규정한다. 좌우 패딩(18px)은 세 크기 공통. */
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-control-sm text-caption",
  md: "h-control-md text-body-sm",
  lg: "h-control-lg text-body",
};

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BASE_CLASS,
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    />
  );
}
