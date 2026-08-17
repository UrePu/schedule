import { Clock, TriangleAlert } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";
import { formatKstFull } from "./kst-format";

/**
 * 남은 시간 / 지각 표시.
 *
 * 색 규칙(CLAUDE.md §4): **임박·지각 경고는 red 가 아니라 tertiary orange 를 쓴다.**
 * red 는 실패·취소 전용이므로 이 컴포넌트는 어떤 상태에서도 error 토큰을 쓰지 않는다.
 *
 * 절대 시각은 항상 KST 로 `title` 에 노출한다(§2 — 표시는 Asia/Seoul 고정).
 * `now` 를 주입할 수 있게 해 두어 SSR/CSR 간 시각 불일치를 호출부가 통제할 수 있다.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 임박으로 볼 기본 임계값. 보스 파티는 보통 몇 시간 전에 모이기 시작한다. */
export const DEFAULT_IMMINENT_MS = 6 * HOUR_MS;

/** 부호 없는 경과/잔여 시간을 한국어로 만든다. 예) "1일 3시간", "45분" */
function formatDuration(absMs: number): string {
  const days = Math.floor(absMs / DAY_MS);
  const hours = Math.floor((absMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((absMs % HOUR_MS) / MINUTE_MS);

  if (days > 0) {
    return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  return `${minutes}분`;
}

export type TimeUntilState = "upcoming" | "imminent" | "overdue";

export function getTimeUntilState(
  target: Date,
  now: Date,
  imminentWithinMs: number = DEFAULT_IMMINENT_MS,
): TimeUntilState {
  const diff = target.getTime() - now.getTime();
  if (diff < 0) return "overdue";
  if (diff <= imminentWithinMs) return "imminent";
  return "upcoming";
}

export interface TimeUntilProps extends ComponentPropsWithRef<"span"> {
  /** 대상 시각. */
  target: Date;
  /** 기준 시각. 생략하면 렌더 시점. 하이드레이션 불일치를 막으려면 주입할 것. */
  now?: Date;
  /** 임박으로 볼 임계값(ms). */
  imminentWithinMs?: number;
  /** 아이콘 숨김. */
  hideIcon?: boolean;
}

export function TimeUntil({
  target,
  now = new Date(),
  imminentWithinMs = DEFAULT_IMMINENT_MS,
  hideIcon = false,
  className,
  ...props
}: TimeUntilProps) {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const state = getTimeUntilState(target, now, imminentWithinMs);

  let text: string;
  if (abs < MINUTE_MS) {
    text = "지금";
  } else if (diff < 0) {
    text = `${formatDuration(abs)} 지남`;
  } else {
    text = `${formatDuration(abs)} 뒤`;
  }

  const warn = state !== "upcoming";
  const Icon = warn ? TriangleAlert : Clock;

  return (
    <span
      title={`${formatKstFull(target)} KST`}
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1 text-caption tabular-nums",
        // red 아님 — 임박/지각은 tertiary orange (§4)
        warn ? "text-tertiary" : "text-ink-muted",
        className,
      )}
      {...props}
    >
      {hideIcon ? null : <Icon aria-hidden size={14} />}
      {text}
      {state === "overdue" ? <span className="sr-only">(지각)</span> : null}
      {state === "imminent" ? <span className="sr-only">(임박)</span> : null}
    </span>
  );
}
