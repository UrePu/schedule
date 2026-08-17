import { CalendarClock } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import { formatKstShort } from "./kst-format";

/**
 * 주차 표시.
 *
 * 도메인 규칙(CLAUDE.md §1): 주간 초기화는 **매주 목요일 00:00 KST**.
 * 경계 계산은 전부 `src/lib/time/week.ts` 에 위임한다 — 여기서 직접 날짜 산술을 하지 않는다.
 *
 * 표시 규칙: 사용자가 "이 주가 언제 끝나는지"를 늘 알 수 있어야 하므로
 * **초기화 시점을 항상 "~8/20 목 00:00" 형태로 함께 노출한다.**
 */

export interface WeekLabelProps extends ComponentPropsWithRef<"div"> {
  /** 기준 시각. 생략하면 렌더 시점. SSR 불일치를 막으려면 주입할 것. */
  date?: Date;
  /** 주차 키(2026-W33)까지 보여줄지 여부. */
  showWeekKey?: boolean;
  /** 아이콘 숨김. */
  hideIcon?: boolean;
}

export function WeekLabel({
  date = new Date(),
  showWeekKey = true,
  hideIcon = false,
  className,
  ...props
}: WeekLabelProps) {
  const start = getWeekStart(date);
  const reset = getNextReset(date);
  const weekKey = getWeekKey(date);

  const rangeText = `${formatKstShort(start)} ~ ${formatKstShort(reset)}`;
  const resetText = `~${formatKstShort(reset)}`;

  return (
    <div
      title={`${rangeText} (KST · 목요일 00:00 주간 초기화)`}
      className={cn(
        "inline-flex items-center gap-2 text-body-sm text-ink",
        className,
      )}
      {...props}
    >
      {hideIcon ? null : (
        <CalendarClock aria-hidden size={16} className="text-primary" />
      )}
      {showWeekKey ? (
        <span className="font-semibold tabular-nums">{weekKey}</span>
      ) : null}
      <span className="text-caption text-ink-muted tabular-nums">
        {resetText} 초기화
      </span>
    </div>
  );
}
