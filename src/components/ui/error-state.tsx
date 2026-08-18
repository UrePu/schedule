import { CircleAlert, RotateCcw } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * 오류 상태. DoD(§0.3) "로딩·빈 상태·에러 UI 존재"의 에러 담당.
 *
 * 색 규칙(§4): 여기서만 red 를 쓴다. 임박·지각 경고는 tertiary orange 를 쓰고
 * 이 컴포넌트를 쓰지 않는다.
 *
 * `onRetry` 는 함수 prop 이라 이 컴포넌트를 쓰는 쪽이 클라이언트 컴포넌트여야 한다.
 * 컴포넌트 자체에는 상태가 없어 "use client" 를 붙이지 않았다.
 */

export interface ErrorStateProps extends ComponentPropsWithRef<"div"> {
  title?: string;
  description?: ReactNode;
  /** 오류 코드 등 부가 정보(예: OPENAPI00007). */
  detail?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title = "불러오지 못했습니다",
  description,
  detail,
  onRetry,
  retryLabel = "다시 시도",
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-chip-failed-border",
        // 360px 에서 좌우 24px 씩은 본문 폭을 248px 로 깎는다. 좁은 곳에서만 줄인다.
        "bg-chip-failed-bg px-4 py-10 text-center sm:px-6",
        className,
      )}
      {...props}
    >
      <CircleAlert aria-hidden size={24} className="text-error" />
      <p className="font-headline text-body-lg font-semibold text-ink">
        {title}
      </p>
      {description ? (
        <p className="max-w-80 text-body-sm text-ink-muted">{description}</p>
      ) : null}
      {detail ? (
        /*
          기술 상세는 `OPENAPI00004` 같은 **공백 없는 토큰**이라 줄바꿈 기회가 없다.
          `break-all` 이 없으면 좁은 화면에서 카드 밖으로 삐져나온다.
        */
        <p className="max-w-full font-mono text-caption break-all text-chip-failed-fg">
          {detail}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-1">
          <RotateCcw aria-hidden size={14} />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
