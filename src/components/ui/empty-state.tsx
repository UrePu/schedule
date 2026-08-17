import { Inbox } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 빈 상태. DoD(§0.3) "로딩·빈 상태·에러 UI 존재"의 빈 상태 담당.
 *
 * 도메인 주의(§1.1): 스케줄러 응답이 비어 있는 것은 "그 날 접속하지 않음" 이지 오류가 아니다.
 * 그런 경우는 ErrorState 가 아니라 반드시 이 컴포넌트로 표현한다.
 *
 * 라운드는 empty-state 용 XL(20px)을 쓴다(디자인 문서 Border Radius > XL).
 */

export interface EmptyStateProps extends ComponentPropsWithRef<"div"> {
  /** 기본값은 Inbox 아이콘. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** 선택적 액션(주로 Button). */
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border",
        "bg-surface px-6 py-10 text-center",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-neutral-100 text-ink-placeholder"
      >
        {icon ?? <Inbox size={24} />}
      </span>
      <p className="font-headline text-body-lg font-semibold text-ink">
        {title}
      </p>
      {description ? (
        <p className="max-w-80 text-body-sm text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
