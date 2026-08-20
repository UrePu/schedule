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
  /**
   * 폭. 기본 240px(디자인 원문 값)이고, `wide` 는 320px 다.
   *
   * 도움말처럼 **문장이 여러 개**인 내용은 240px 에서 세로로 지나치게 길어져 읽기가
   * 나빠진다. 값 하나를 설명하는 원래 용도에는 기본값을 그대로 쓴다.
   */
  size?: "default" | "wide";
  /**
   * 열리는 방향. 기본은 위(디자인 원문)다.
   *
   * ⚠️ **스크롤 컨테이너 안에서는 방향이 곧 잘림 여부다.** 다이얼로그 본문은
   *    `overflow-y-auto` 라, 맨 윗줄에서 위로 열면 툴팁이 잘려 보인다. 그런 자리에는
   *    `bottom` 을 준다(`HelpHint` 가 그렇게 쓴다).
   */
  placement?: "top" | "bottom";
  /** 단일 엘리먼트여야 한다(aria-describedby 주입 대상). */
  children: TooltipTrigger;
}

export function Tooltip({
  content,
  delay = 300,
  size = "default",
  placement = "top",
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
            "pointer-events-none absolute left-1/2 z-50 w-max -translate-x-1/2",
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            size === "wide" ? "max-w-80 whitespace-normal" : "max-w-60",
            "rounded-tooltip bg-ink px-2.5 py-1.5 text-caption text-neutral-50 shadow-overlay",
          )}
        >
          {content}
          <span
            aria-hidden
            className={cn(
              "absolute left-1/2 size-1.5 -translate-x-1/2 rotate-45 bg-ink",
              placement === "top"
                ? "top-full -translate-y-1/2"
                : "bottom-full translate-y-1/2",
            )}
          />
        </span>
      ) : null}
    </span>
  );
}
