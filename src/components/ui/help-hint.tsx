"use client";

import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Tooltip } from "./tooltip";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 도움말 `?` — 설명문을 **접어 두는** 자리
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 발주자(2026-08-20): *"일단 설명문접고 ? 달아서 호버링으로 바꿔봐"*
 *
 * 이 저장소의 화면은 조작법을 문단으로 길게 적어 두는 습관이 있었다. 처음 오는 사람에게는
 * 필요하지만 **없어지지 않아서**, 세 번째 방문부터는 읽지 않고 건너뛰는 텍스트가 화면의
 * 상당 부분을 차지한다. 지우는 대신 접는다 — 필요한 사람은 여전히 읽을 수 있어야 한다.
 *
 * ★ **hover 전용이 아니다.** 트리거가 `<button>` 이라 키보드 `Tab` 으로 초점이 오면 열리고
 *   (`Tooltip` 이 focus 를 함께 본다), 터치에서는 탭하면 초점이 잡혀 열린다. Escape 로 닫힌다.
 *   마우스가 없는 사람에게 정보를 잠그면 그건 접은 게 아니라 없앤 것이다.
 * ★ 아이콘만 있는 버튼이므로 `aria-label` 이 필수다. 기본값은 "도움말" 이고, 한 화면에
 *   여러 개가 있으면 `label` 로 무엇의 도움말인지 구분해 준다.
 * ★ `type="button"` 을 명시한다. 폼 안에 들어가는 자리가 있어서, 빠뜨리면 도움말을 누를 때
 *   폼이 제출된다.
 */
export interface HelpHintProps {
  /** 접어 둘 설명. 문장 여러 개면 `<>` 로 묶어 넘긴다. */
  readonly children: ReactNode;
  /** 무엇의 도움말인지. 스크린리더가 읽는다. */
  readonly label?: string;
  readonly className?: string;
}

export function HelpHint({
  children,
  label = "도움말",
  className,
}: HelpHintProps) {
  return (
    <Tooltip
      content={children}
      size="wide"
      /*
        ★ **아래로 연다.** 이 `?` 들은 섹션 머리에 붙는데, 다이얼로그 본문이
          `overflow-y-auto` 라 위로 열면 첫 줄에서 잘린다.
      */
      placement="bottom"
      /*
        기본 300ms 는 "값 하나를 설명하는" 툴팁 기준이다. 여기는 사용자가 `?` 를 **찾아서**
        가리키는 자리라, 그 지연이 반응 없음으로 읽힌다.
      */
      delay={120}
      className={cn("align-[-2px]", className)}
    >
      <button
        type="button"
        aria-label={label}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-full text-ink-muted",
          "transition duration-200 hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        )}
      >
        <HelpCircle aria-hidden size={14} />
      </button>
    </Tooltip>
  );
}
