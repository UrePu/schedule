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
        /*
         * hover 상태가 없어서 입력칸이 "지금 여기 쓸 수 있다"를 말하지 않았다.
         * 오류 상태(border-error)를 hover 가 덮어쓰면 안 되므로 **정상 분기에만** 건다
         * — 같은 유틸리티 레이어에서 `hover:` 변형이 특이도가 더 높기 때문이다.
         * 대비 변화: 라이트 border→border-strong 1.165:1, 다크 2.38:1.
         */
        invalid
          ? "border-error"
          : "border-border enabled:hover:border-border-strong",
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
 *
 * ★ `tone="error"` 는 `text-error` 를 쓴다. 2026-08-19 대비 감사 전에는 라이트
 *   `#ef4444` / `background` = **3.61:1** 로 AA 미달이었다(다크는 6.86 라 다크만
 *   보면 놓친다). 모든 폼의 오류 문구가 이 한 줄을 지나가므로 고칠 곳도
 *   토큰 하나였다 — 라이트 `error` 를 `#d72a30` 으로 내렸다.
 *   측정: background 4.72 · surface 4.93 (다크 6.86 · 6.39, 무변경).
 *   같은 변경이 destructive 버튼의 흰 글자(3.76 → 4.93)도 함께 고쳤다.
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
