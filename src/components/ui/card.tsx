import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Card.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Cards
 * - Default : surface 채움, 1px border, 8px 라운드, 16px 패딩. hover 시 보더가 진해진다.
 * - Elevated: medium shadow → hover 시 large shadow + translateY(-2px).
 */

export type CardVariant = "default" | "elevated";

const BASE_CLASS = "rounded-md bg-surface p-pad-lg transition duration-200";

const VARIANT_CLASS: Record<CardVariant, string> = {
  default: "border border-border hover:border-border-strong",
  elevated:
    "border border-border shadow-medium hover:-translate-y-0.5 hover:shadow-large",
};

export interface CardProps extends ComponentPropsWithRef<"div"> {
  variant?: CardVariant;
}

export function Card({ variant = "default", className, ...props }: CardProps) {
  return (
    <div
      className={cn(BASE_CLASS, VARIANT_CLASS[variant], className)}
      {...props}
    />
  );
}

/**
 * 카드 상단 라벨(Overline) — 스테이지/상태 이름용.
 *
 * ★ 색이 `ink-placeholder` → `ink-muted` 로 바뀌었다. 11px 는 타입 스케일에서 가장 작은
 *   단계라 색까지 가장 흐리면 어느 테마에서도 읽히지 않는다(라이트 `ink-placeholder`
 *   는 흰 배경에서 2.56:1 로 AA 미달이다). 크기는 디자인 문서 값이라 그대로 두고
 *   **색만** 올렸다. 이 컴포넌트는 문장이 아니라 짧은 라벨 전용이다.
 */
export function CardOverline({
  className,
  ...props
}: ComponentPropsWithRef<"p">) {
  return (
    <p
      className={cn("text-overline uppercase text-ink-muted", className)}
      {...props}
    />
  );
}

/** 카드 제목 — 기본 h3. `as` 없이 헤딩 레벨은 상위에서 관리한다. */
export function CardTitle({
  className,
  ...props
}: ComponentPropsWithRef<"h3">) {
  return (
    <h3
      className={cn("font-headline text-subhead text-ink", className)}
      {...props}
    />
  );
}

/** 카드 본문 설명. */
export function CardDescription({
  className,
  ...props
}: ComponentPropsWithRef<"p">) {
  return (
    <p className={cn("text-body-sm text-ink-muted", className)} {...props} />
  );
}
