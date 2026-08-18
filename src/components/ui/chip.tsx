import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro Chip — FilterChip / StatusChip.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Chips
 * - Filter Chip: 30px 높이, 8px 라운드, 1px border, 13px/500, 좌우 10px 패딩.
 *                선택 시 primary 채움 + 흰 텍스트 + 보더 투명. hover 시 hover-surface.
 * - Status Chip: won / at-risk / lost 3색.
 *
 * 도메인 매핑(§4): won → 완료, at-risk → 임박, lost → 실패.
 * 임박은 tertiary 계열(주황)이며 red 는 실패·취소 전용이다.
 */

const CHIP_BASE =
  "inline-flex h-chip shrink-0 items-center gap-1.5 rounded-md px-2.5 text-label whitespace-nowrap";

export interface FilterChipProps extends ComponentPropsWithRef<"button"> {
  /** 선택 상태. aria-pressed 로도 노출된다. */
  selected?: boolean;
}

export function FilterChip({
  selected = false,
  className,
  type = "button",
  ...props
}: FilterChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        CHIP_BASE,
        "border transition duration-200",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-40",
        /*
         * ★ **선택 상태에도 hover 가 있어야 한다.** 예전에는 선택된 칩만 hover 가
         *   통째로 없어서(테마 토글의 현재 테마 칩이 그랬다) 다시 누를 수 있는
         *   것인지 알 수 없었다.
         * ★ 비선택 hover 면을 `hover-surface`(흰 면 대비 1.10:1) → `hover-strong`
         *   (1.245:1)로 올리고, 보더·글자색도 같이 움직여 세 채널로 말한다.
         */
        selected
          ? "border-transparent bg-primary text-surface hover:bg-primary-hover"
          : "border-border bg-surface text-ink-label " +
            "hover:border-border-strong hover:bg-hover-strong hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 상태 톤. 디자인 문서의 won / at-risk / lost 를 도메인 어휘로 바꾼 것이다.
 * - done   : 클리어 완료 (won)
 * - soon   : 임박 / 미클리어 경고 (at-risk)
 * - failed : 실패 · 취소 (lost)
 */
export type StatusTone = "done" | "soon" | "failed";

const STATUS_CLASS: Record<StatusTone, string> = {
  done: "bg-chip-done-bg text-chip-done-fg border-chip-done-border",
  soon: "bg-chip-soon-bg text-chip-soon-fg border-chip-soon-border",
  failed: "bg-chip-failed-bg text-chip-failed-fg border-chip-failed-border",
};

/** children 이 없을 때 쓰는 기본 한국어 라벨. */
export const STATUS_LABEL: Record<StatusTone, string> = {
  done: "완료",
  soon: "임박",
  failed: "실패",
};

export interface StatusChipProps extends ComponentPropsWithRef<"span"> {
  status: StatusTone;
  /** 앞에 붙일 아이콘. 장식이므로 aria-hidden 으로 넘길 것. */
  icon?: ReactNode;
}

export function StatusChip({
  status,
  icon,
  className,
  children,
  ...props
}: StatusChipProps) {
  return (
    <span
      className={cn(CHIP_BASE, "border", STATUS_CLASS[status], className)}
      {...props}
    >
      {icon}
      {children ?? STATUS_LABEL[status]}
    </span>
  );
}
