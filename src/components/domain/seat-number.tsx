import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

/**
 * 참가자 번호 배지 (`seat_no`).
 *
 * ⚠️ 번호는 **안정 식별자**다 (CLAUDE.md §1.4).
 * - 대기열도 아니고 투표 순위도 아니다. 사람이 긴 닉네임 대신 "1번"이라고 부르기 위한 관리 번호다.
 * - **절대 재배열(renumber)하지 않는다.** #3 이 나가도 #4 는 계속 #4 이고 3번 자리는 빈 채로 둔다.
 *   카카오톡 평문에서 `!분배 1번 33` 같은 명령이 이미 오가는 중이므로, 번호를 다시 매기면
 *   진행 중인 대화가 조용히 어긋난다.
 * - 새로 들어오는 사람은 `max(seat_no) + 1` 을 받는다.
 *
 * 따라서 이 컴포넌트는 배열 인덱스가 아니라 **저장된 `seat_no` 값을 그대로** 받는다.
 * 렌더링 순서와 번호는 별개다.
 */

export type SeatNumberTone = "default" | "primary" | "muted";
export type SeatNumberSize = "sm" | "md";

const TONE_CLASS: Record<SeatNumberTone, string> = {
  default: "bg-primary-subtle text-primary",
  primary: "bg-primary text-surface",
  muted: "bg-neutral-100 text-ink-muted",
};

const SIZE_CLASS: Record<SeatNumberSize, string> = {
  sm: "size-5 text-overline",
  md: "size-6 text-caption",
};

export interface SeatNumberProps
  extends Omit<ComponentPropsWithRef<"span">, "children"> {
  /** 저장된 seat_no 값. 배열 인덱스를 넘기지 말 것. */
  seatNo: number;
  tone?: SeatNumberTone;
  size?: SeatNumberSize;
}

export function SeatNumber({
  seatNo,
  tone = "default",
  size = "md",
  className,
  ...props
}: SeatNumberProps) {
  return (
    <span
      aria-label={`${seatNo}번 참가자`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums",
        TONE_CLASS[tone],
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    >
      <span aria-hidden>{seatNo}</span>
    </span>
  );
}
