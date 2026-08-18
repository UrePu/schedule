import { CalendarClock } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

import { getNextReset, getWeekKey, getWeekStart } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import { formatKstShort } from "./kst-format";
import { Numeric, NumericText } from "./numeric";

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
        /*
          `2026-W34` 는 순수 ASCII 주차 **키**다. §4 가 mono 를 코드·키·ID 용으로
          규정한 바로 그 범주라 통째로 감싸도 한글이 섞일 일이 없다.
          `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
        */
        <Numeric className="font-semibold">{weekKey}</Numeric>
      ) : null}
      <span className="text-caption text-ink-muted tabular-nums">
        {/* `~8/20 목 00:00` — 요일 한 글자가 섞여 있어 숫자 구간만 감싼다. */}
        <NumericText>{resetText}</NumericText> 초기화
      </span>
    </div>
  );
}
