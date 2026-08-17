import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

/**
 * 로딩 자리표시자. DoD(§0.3) "로딩·빈 상태·에러 UI 존재"의 로딩 담당.
 *
 * 색은 neutral-200(디자인 문서의 보더 색)과 같은 값을 쓴다 — background/surface
 * 위에서 모두 읽히는 중립 톤이다.
 * 스크린리더에는 노출하지 않고(aria-hidden), 상태 알림은 감싸는 영역이 담당한다.
 */

export type SkeletonShape = "block" | "text" | "circle";

const SHAPE_CLASS: Record<SkeletonShape, string> = {
  block: "rounded-md",
  text: "h-4 rounded-sm",
  circle: "rounded-full",
};

export interface SkeletonProps extends ComponentPropsWithRef<"div"> {
  shape?: SkeletonShape;
}

export function Skeleton({
  shape = "block",
  className,
  ...props
}: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse bg-neutral-200",
        SHAPE_CLASS[shape],
        className,
      )}
      {...props}
    />
  );
}

/** 여러 Skeleton 을 감싸 "불러오는 중" 을 보조기기에 알리는 래퍼. */
export function SkeletonGroup({
  label = "불러오는 중",
  className,
  children,
  ...props
}: ComponentPropsWithRef<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
