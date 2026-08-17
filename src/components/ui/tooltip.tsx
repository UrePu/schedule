"use client";

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Tooltip — 외부 의존성 없이 구현했다.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Tooltips
 * - ink 배경, neutral-50 텍스트, 6px 라운드(--radius-tooltip)
 * - 12px/500 텍스트, 6px/10px 패딩, 240px 최대 폭, 6px 화살표
 * - 300ms 지연, 기본 위치는 위(top)
 *
 * 접근성:
 * - hover 뿐 아니라 focus 로도 열린다(키보드 사용자).
 * - 트리거 엘리먼트에 aria-describedby 를 직접 주입한다. 따라서 children 은
 *   ref/props 를 받을 수 있는 단일 엘리먼트여야 한다.
 * - Escape 로 즉시 닫힌다.
 */

type TooltipTrigger = ReactElement<{ "aria-describedby"?: string }>;

export interface TooltipProps
  extends Omit<ComponentPropsWithRef<"span">, "content"> {
  /** 툴팁 본문. */
  content: ReactNode;
  /** 표시 지연(ms). 디자인 기본값 300ms. */
  delay?: number;
  /** 단일 엘리먼트여야 한다(aria-describedby 주입 대상). */
  children: TooltipTrigger;
}

export function Tooltip({
  content,
  delay = 300,
  className,
  children,
  ...props
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clear();
    timerRef.current = setTimeout(() => setOpen(true), delay);
  }, [clear, delay]);

  const hide = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          hide();
        }
      }}
      {...props}
    >
      {cloneElement(children, { "aria-describedby": open ? id : undefined })}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-60 -translate-x-1/2",
            "rounded-tooltip bg-ink px-2.5 py-1.5 text-caption text-neutral-50 shadow-overlay",
          )}
        >
          {content}
          <span
            aria-hidden
            className="absolute top-full left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-ink"
          />
        </span>
      ) : null}
    </span>
  );
}
