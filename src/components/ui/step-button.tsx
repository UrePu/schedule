"use client";

import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 숫자 칸 옆의 **− / + 버튼**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"인풋 박스가 너무 불편하게 생겼음"* →
 * (2026-08-28): *"여기는 왜 인원수 추가에 -1 +1 버튼없어"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 컴포넌트로 뽑았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 `boss-plan-workspace` 안에 `stepClass` 라는 지역 문자열로만 있었다. 그래서
 * **파티 인원을 고치는 다른 두 자리**(클리어 수정 다이얼로그 · 일정 수정 폼)에는 버튼이
 * 없었고, 발주자가 그걸 그대로 지적했다. 모양을 한 파일에 두면 다음에 네 번째 자리가
 * 생겨도 같은 일이 반복되지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 설계 규칙
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **정사각형이고 높이가 입력칸과 같다.** 줄 높이가 늘어나면 목록의 세로 리듬이 깨진다.
 *   `size` 는 옆에 두는 입력칸의 크기를 그대로 따른다(`sm` 32px · `md` 38px).
 * ★ **입력칸을 대체하지 않는다.** 파티 인원은 24까지 갈 수 있고(DB CHECK) 그때는
 *   타이핑이 빠르다. 버튼은 흔한 경로(1 ↔ 2~6)를 짧게 만들 뿐 유일한 경로가 아니다.
 * ★ **브라우저 기본 스피너는 끈다** — 부르는 쪽 책임이다. 우리 버튼과 나란히 두면 같은
 *   일을 하는 컨트롤이 둘이 되고, 기본 스피너는 32px 안에서 실제로 누를 수 없다.
 * ★ 경계에서는 `disabled` 다. 눌러도 아무 일이 없는 버튼은 고장으로 읽힌다.
 * ★ **`aria-label` 이 필수다.** 아이콘 하나뿐이라 낭독기에는 아무것도 안 남는다.
 *   무엇을 늘리고 줄이는지까지 부르는 쪽이 적는다("스우 인원 1명 줄이기").
 */

export interface StepButtonProps {
  /** `down` = −, `up` = + */
  readonly direction: "down" | "up";
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** 옆 입력칸의 크기에 맞춘다. 기본 `sm`(32px). */
  readonly size?: "sm" | "md";
  /** 낭독기용 설명. 무엇의 인원인지까지 적는다. */
  readonly "aria-label": string;
  /** 마우스 툴팁. 생략하면 `aria-label` 을 쓴다. */
  readonly title?: string;
}

export function StepButton({
  direction,
  onClick,
  disabled = false,
  size = "sm",
  "aria-label": ariaLabel,
  title,
}: StepButtonProps) {
  const Icon = direction === "down" ? Minus : Plus;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "sm"
          ? "h-control-sm w-control-sm"
          : "h-control-md w-control-md",
        "rounded-md border border-border bg-surface text-ink-muted",
        // §4 — 체감 지연이 있는 전환은 200ms 안쪽.
        "transition duration-200",
        "hover:bg-hover-strong hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface",
        "disabled:hover:text-ink-muted",
      )}
    >
      <Icon aria-hidden size={size === "sm" ? 14 : 16} />
    </button>
  );
}

/**
 * 브라우저 기본 스피너를 끄는 클래스. `type="number"` 입력에 `StepButton` 을 붙일 때
 * **반드시 함께** 쓴다 — 안 그러면 같은 일을 하는 컨트롤이 한 칸에 둘이 된다.
 */
export const NO_NATIVE_SPINNER = cn(
  "[appearance:textfield]",
  "[&::-webkit-inner-spin-button]:appearance-none",
  "[&::-webkit-outer-spin-button]:appearance-none",
);
