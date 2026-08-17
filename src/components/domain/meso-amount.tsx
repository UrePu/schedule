import type { ComponentPropsWithRef } from "react";

import { cn, formatMeso, formatMesoCompact } from "@/lib/utils";

/**
 * 메소 금액 표기.
 *
 * 규칙(CLAUDE.md §4): 금액은 **항상 ko-KR 로케일**로 포맷한다.
 *
 * 규칙(CLAUDE.md §1.3 D4): 결정석 가격이 `null` 인 것은 **"모름"이지 0 이 아니다.**
 * 벨로나 3난이도가 실제로 `crystal_price = null` 로 들어온다. 0 으로 찍으면
 * "수익 없음"으로 오독되므로 `null` 은 반드시 "미확인"으로 구분해 표시하고,
 * 수익 합계에서도 제외해야 한다(합산은 호출부 책임).
 *
 * 축약 표기(`compact`)를 쓰더라도 정확한 값은 `title` 로 항상 노출한다.
 */

export type MesoTone = "default" | "accent" | "muted";

const TONE_CLASS: Record<MesoTone, string> = {
  default: "text-ink",
  accent: "text-secondary",
  muted: "text-ink-muted",
};

export interface MesoAmountProps
  extends Omit<ComponentPropsWithRef<"span">, "children" | "title"> {
  /** 메소 금액. `null` 은 "가격 미확인"이며 0 과 다르다. */
  value: number | null;
  /** 한국식 축약("3억 2,400만") 사용 여부. */
  compact?: boolean;
  /** 뒤에 "메소" 를 붙일지 여부. */
  suffix?: boolean;
  tone?: MesoTone;
  /** 미확인 상태에 쓸 문구. */
  unknownLabel?: string;
}

export function MesoAmount({
  value,
  compact = false,
  suffix = true,
  tone = "default",
  unknownLabel = "미확인",
  className,
  ...props
}: MesoAmountProps) {
  if (value === null) {
    return (
      <span
        title="결정석 가격 미확인 — 값이 알려지지 않은 상태이며 0 메소가 아닙니다."
        data-meso-state="unknown"
        className={cn(
          "inline-flex items-center gap-1 text-ink-muted tabular-nums",
          className,
        )}
        {...props}
      >
        {unknownLabel}
      </span>
    );
  }

  const exact = `${formatMeso(value)} 메소`;
  const shown = compact ? formatMesoCompact(value) : formatMeso(value);

  return (
    <span
      title={exact}
      data-meso-state="known"
      className={cn("inline-flex items-center gap-1 tabular-nums", TONE_CLASS[tone], className)}
      {...props}
    >
      {shown}
      {suffix ? (
        <span className="text-caption text-ink-muted">메소</span>
      ) : null}
    </span>
  );
}
