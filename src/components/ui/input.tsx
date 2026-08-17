import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro 폼 프리미티브 — Label / Input / HelperText.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Inputs
 * - Input : 38px 높이, 8px/12px 패딩, 8px 라운드, 1px border.
 *           focus 시 border primary + 3px ring(primary 12%).
 *           error 시 border error, disabled 시 background 색 + 텍스트 50%.
 * - Label : 13px / 500 / ink-label, 인풋 위에 배치.
 * - Helper: 12px / ink-muted. error 톤이면 error 색.
 *
 * id / htmlFor 는 호출부가 명시적으로 연결한다(서버 컴포넌트에서도 쓰기 위해 useId 를 쓰지 않는다).
 */

export interface LabelProps extends ComponentPropsWithRef<"label"> {
  /** 필수 입력 표시. 시각적 별표 + 스크린리더용 "필수" 텍스트. */
  required?: boolean;
}

export function Label({
  required = false,
  className,
  children,
  ...props
}: LabelProps) {
  return (
    <label
      className={cn("block text-label text-ink-label", className)}
      {...props}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden className="ml-0.5 text-error">
            *
          </span>
          <span className="sr-only"> (필수)</span>
        </>
      ) : null}
    </label>
  );
}

export interface InputProps extends ComponentPropsWithRef<"input"> {
  /** 검증 실패 상태. aria-invalid 와 error 보더를 함께 켠다. */
  invalid?: boolean;
}

export function Input({ invalid = false, className, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        "h-control-md w-full rounded-md border bg-surface px-3 py-2",
        "text-body-sm text-ink placeholder:text-ink-placeholder",
        "transition duration-200 outline-none",
        invalid ? "border-error" : "border-border",
        "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
        "aria-invalid:focus:border-error",
        "disabled:cursor-not-allowed disabled:bg-background disabled:text-ink/50",
        className,
      )}
      {...props}
    />
  );
}

export interface HelperTextProps extends ComponentPropsWithRef<"p"> {
  tone?: "default" | "error";
}

/**
 * 입력 보조 문구 / 오류 문구.
 *
 * ★ 크기를 12px(디자인 문서의 Helper 값) → **14px(`text-body-sm`)** 로 올렸다.
 *   여기 들어가는 것은 라벨이 아니라 **문장**이고("openapi.nexon.com > 내 애플리케이션
 *   에서 발급합니다."), 오류 문구도 이 컴포넌트를 쓴다. 12px 뮤티드 문장은 다크에서
 *   실제로 읽히지 않는다는 지적이 두 번 나왔으므로, 본문·메타 문장의 하한을 14px 로
 *   확정했다. 11/12px 은 배지·라벨·수치 주석 같은 짧은 조각에만 남는다.
 */
export function HelperText({
  tone = "default",
  className,
  ...props
}: HelperTextProps) {
  return (
    <p
      className={cn(
        "text-body-sm",
        tone === "error" ? "text-error" : "text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
