import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * PipelinePro ListItem.
 * 수치 근거: Claude/pipelinepro-DESIGN.md > Components > Lists
 * - 44px 높이, 10px/12px 패딩, 14px 텍스트
 * - 1px 구분선 (neutral-100)
 * - 아이콘 18px, 텍스트와 10px 간격
 * - hover: background 토큰
 * - selected: primary-subtle 배경 + primary 텍스트 + 좌측 2px primary 보더
 *
 * 마크업은 `<li><button/></li>` 다. 항상 `<ul>` 안에서 쓴다.
 * 키보드 조작은 네이티브 버튼이 그대로 처리한다.
 */

export interface ListItemProps extends ComponentPropsWithRef<"button"> {
  /** 좌측 아이콘. 18px 로 렌더할 것. */
  icon?: ReactNode;
  /** 우측 보조 영역(시간, 배지 등). */
  trailing?: ReactNode;
  /** 선택 상태. aria-current 로도 노출된다. */
  selected?: boolean;
  /** 바깥 <li> 에 붙일 클래스. */
  containerClassName?: string;
}

export function ListItem({
  icon,
  trailing,
  selected = false,
  className,
  containerClassName,
  type = "button",
  children,
  ...props
}: ListItemProps) {
  return (
    <li
      className={cn(
        "border-b border-neutral-100 last:border-b-0",
        containerClassName,
      )}
    >
      <button
        type={type}
        aria-current={selected || undefined}
        className={cn(
          "flex h-list-item w-full items-center gap-2.5 py-2.5 pr-3 text-left text-body-sm",
          "transition duration-200 outline-none",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
          "disabled:cursor-not-allowed disabled:opacity-40",
          selected
            ? "border-l-2 border-l-primary bg-primary-subtle pl-2.5 text-primary"
            : "pl-3 text-ink hover:bg-background",
          className,
        )}
        {...props}
      >
        {/*
          아이콘 자리는 **18px 를 밑변으로 두되 더 큰 아이콘은 자리를 넓힌다.**
          `size-4.5` 로 못 박혀 있던 시절에는 18px 보다 큰 자식(보스 아이콘)이 슬롯 밖으로
          삐져나와 `gap-2.5`(10px)를 잡아먹고 글자에 닿았다. `min-*` 로 바꾸면 18px 아이콘의
          정렬은 글자 하나 다르지 않게 그대로이고, 큰 아이콘만 자리를 얻는다.
          행 높이는 `h-list-item`(44px) 이 고정하므로 44px 이하 아이콘은 줄을 늘리지 않는다.
        */}
        {icon ? (
          <span className="flex min-h-4.5 min-w-4.5 shrink-0 items-center justify-center">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing ? <span className="shrink-0">{trailing}</span> : null}
      </button>
    </li>
  );
}
