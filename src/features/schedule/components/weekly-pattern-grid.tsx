"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { IsoWeekday } from "@/types/domain";

import {
  MIDNIGHT_SLOT,
  SLOT_COUNT,
  slotKey,
  slotLabel,
} from "../lib/pattern-slots";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 요일 × 30분 격자 — **칠해서** 내 가능 시간을 정한다 (§1.4)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 세로가 시간인가 (겹쳐보기와 축이 반대인 이유)
 * ─────────────────────────────────────────────────────────────────────────────
 * `overlay-grid` 는 **행 = 하루 / 가로축 = 시각**이다. 사람을 세로로 쌓아야 "몇 명이
 * 겹치는가"가 한눈에 읽히기 때문이다. 편집기에는 쌓을 사람이 **한 명뿐**이라 그 이유가
 * 없어지고, 대신 다른 제약이 지배한다 — **360px 폭**이다.
 *   가로축을 시각으로 두면 60칸을 300px 이 안 되는 폭에 넣어야 해서 한 칸이 5px 가 된다.
 *   손가락으로도 마우스로도 칠할 수 없고, 시간 눈금은 아예 못 찍는다.
 * 요일을 가로로 두면 7칸 × 약 35px 이고 시간은 **세로 스크롤**이 감당한다. 스케줄
 * 편집기가 거의 예외 없이 이 배치인 것도 같은 계산 때문이다.
 * ★ 요일 **순서**는 겹쳐보기와 같다(주간 초기화 기준 목→수). 축은 돌아갔지만 어느 요일이
 *   어디 있는지는 두 화면이 같으므로, 읽은 자리에 그대로 칠할 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세로축을 24:00 에서 끊지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 열은 `00:00 ~ 30:00`(= 익일 06:00) 60칸이다. 수요일 22:00 에서 내려가며 익일
 * 02:00 까지 이어 칠하면 **한 줄**(`1320~1560`)로 저장된다. 24:00 자리에는 겹쳐보기와
 * 같은 tertiary 점선을 둬서 "여기부터 익일"임을 밝힌다. 24:00 에서 끊으면 사용자의 한
 * 덩어리 의도가 두 줄로 쪼개지고, 다시 합치는 코드는 반드시 어딘가에서 틀린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 입력 경로 세 가지 — 마우스만 되는 UI 는 사람을 배제한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **포인터 드래그**(마우스·펜·터치 공통). Pointer Events + `setPointerCapture` 를
 *    격자 컨테이너에 걸고, 지나간 칸은 `elementFromPoint` 로 찾는다.
 *    터치에서 `pointerenter` 는 첫 대상에만 오므로(암묵적 포인터 캡처) 칸마다 핸들러를
 *    다는 방식은 **터치에서 조용히 동작하지 않는다.**
 * 2. **키보드.** 격자 전체가 탭 정지 **하나**다(roving tabindex — 420개 탭 정지는
 *    키보드 사용자에게 격자를 통째로 못 쓰게 만든다). 화살표로 이동, Space/Enter 로
 *    칠하기 시작, **Shift+화살표로 구간 확장**.
 * 3. 칠한 결과를 문장으로 확인하고 지우는 경로는 부모(편집 다이얼로그)의 구간 목록이 맡는다.
 *
 * ⚠️ 터치 스크롤 — 칸에는 `touch-action: none` 이 필요하다(없으면 세로로 칠할 때 화면이
 *    같이 스크롤된다). 그래서 **왼쪽 시간 눈금 열은 `touch-action: pan-y` 로 남겨** 두었다.
 *    그 열을 끌면 평소처럼 스크롤된다. 부모는 이 사실을 안내 문구로 알린다.
 *
 * 색: 칠한 칸은 `bg-primary` 다. `bg-available`(겹쳐보기의 개인 레인 색)은 흰 바탕과
 * 1.75:1 밖에 안 돼 **선택 상태의 경계 3:1**(§4)을 만족하지 못한다. 겹쳐보기에서는 그
 * 연한 색이 겹침 밴드를 가리지 않기 위한 선택이지만, 여기서는 가려질 것이 없고 대신
 * "칠했나 안 칠했나"가 유일한 정보다. 실측: primary/neutral-100 라이트 7.5:1 · 다크 5.2:1.
 */

export interface PatternGridColumn {
  readonly isoWeekday: IsoWeekday;
  /** 예) `목` */
  readonly label: string;
  readonly isWeekend: boolean;
}

export interface WeeklyPatternGridProps {
  readonly columns: readonly PatternGridColumn[];
  /** 칠해진 칸(`slotKey`). 부모가 소유하고 여기서는 읽기만 한다. */
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  /** 보이는 세로 구간(칸 번호). `lastSlot` 포함. */
  readonly firstSlot: number;
  readonly lastSlot: number;
  readonly disabled?: boolean;
}

interface CellRef {
  readonly col: number;
  readonly slot: number;
}

type PaintMode = "paint" | "erase";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function WeeklyPatternGrid({
  columns,
  selected,
  onChange,
  firstSlot,
  lastSlot,
  disabled = false,
}: WeeklyPatternGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  /** 드래그 시작 시점의 스냅샷. 사각형을 줄이면 되돌아와야 하므로 매번 여기서 다시 계산한다. */
  const baseRef = useRef<ReadonlySet<string>>(selected);
  const anchorRef = useRef<CellRef | null>(null);
  const modeRef = useRef<PaintMode>("paint");
  const draggingRef = useRef(false);
  /** 이 렌더에서 포커스를 실제로 옮겨야 하는가. 마운트만으로 포커스를 뺏지 않기 위해. */
  const shouldFocusRef = useRef(false);

  const [focus, setFocus] = useState<CellRef>({ col: 0, slot: firstSlot });

  /**
   * 밴드(보이는 시간대)나 열 개수가 바뀌면 이전 포커스가 범위 밖으로 나갈 수 있다.
   * 상태를 고쳐 쓰는 대신 **읽을 때 가둔다** — 그래야 "밴드를 넓혔다 좁히면 포커스가
   * 엉뚱한 데로 옮겨져 있다" 같은 잔상이 남지 않는다.
   * (`useMemo` 인 이유는 이 값이 아래 `useCallback` 의 의존성이기 때문이다.)
   */
  const safeFocus = useMemo<CellRef>(
    () => ({
      col: clamp(focus.col, 0, Math.max(columns.length - 1, 0)),
      slot: clamp(focus.slot, firstSlot, lastSlot),
    }),
    [columns.length, firstSlot, focus.col, focus.slot, lastSlot],
  );

  useEffect(() => {
    if (!shouldFocusRef.current) return;
    shouldFocusRef.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(
        `[data-col="${safeFocus.col}"][data-slot="${safeFocus.slot}"]`,
      )
      ?.focus();
  }, [safeFocus.col, safeFocus.slot]);

  const applyRect = useCallback(
    (a: CellRef, b: CellRef, mode: PaintMode) => {
      const c0 = Math.min(a.col, b.col);
      const c1 = Math.max(a.col, b.col);
      /*
        ★ **보이는 밴드 밖은 절대 칠하지 않는다.** 기준점을 잡은 뒤 밴드를 좁히면
          사각형이 화면 밖까지 뻗을 수 있는데, 그렇게 칠해진 칸은 사용자가 본 적도
          없고 지울 수도 없다. 보이지 않는 곳에 값이 생기는 것은 그 자체로 사고다.
      */
      const s0 = clamp(Math.min(a.slot, b.slot), firstSlot, lastSlot);
      const s1 = clamp(Math.max(a.slot, b.slot), firstSlot, lastSlot);

      const next = new Set(baseRef.current);
      for (let col = c0; col <= c1; col += 1) {
        const column = columns[col];
        if (column === undefined) continue;
        for (let slot = s0; slot <= s1; slot += 1) {
          const key = slotKey(column.isoWeekday, slot);
          if (mode === "paint") next.add(key);
          else next.delete(key);
        }
      }
      onChange(next);
    },
    [columns, firstSlot, lastSlot, onChange],
  );

  /** 화면 좌표 → 칸. 터치 드래그에서 `pointerenter` 가 오지 않으므로 이 경로가 필요하다. */
  const cellAt = useCallback((clientX: number, clientY: number): CellRef | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const cell = element?.closest<HTMLElement>("[data-cell]");
    if (!cell) return null;
    const col = Number.parseInt(cell.dataset.col ?? "", 10);
    const slot = Number.parseInt(cell.dataset.slot ?? "", 10);
    if (!Number.isInteger(col) || !Number.isInteger(slot)) return null;
    return { col, slot };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || event.button !== 0) return;
      const cell = cellAt(event.clientX, event.clientY);
      if (cell === null) return;
      const column = columns[cell.col];
      // 열을 못 찾으면 **캡처하기 전에** 빠진다. 캡처만 해 두고 나가면 포인터가
      // 이 요소에 묶인 채 남아 다음 클릭이 통째로 먹힌다.
      if (column === undefined) return;

      // 텍스트 선택·스크롤 관성이 드래그를 방해하지 않도록 기본 동작을 끊는다.
      event.preventDefault();
      gridRef.current?.setPointerCapture(event.pointerId);

      const mode: PaintMode = selected.has(slotKey(column.isoWeekday, cell.slot))
        ? "erase"
        : "paint";

      baseRef.current = new Set(selected);
      anchorRef.current = cell;
      modeRef.current = mode;
      draggingRef.current = true;
      shouldFocusRef.current = true;
      setFocus(cell);
      applyRect(cell, cell, mode);
    },
    [applyRect, cellAt, columns, disabled, selected],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || anchorRef.current === null) return;
      const cell = cellAt(event.clientX, event.clientY);
      if (cell === null) return;
      applyRect(anchorRef.current, cell, modeRef.current);
    },
    [applyRect, cellAt],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (gridRef.current?.hasPointerCapture(event.pointerId)) {
      gridRef.current.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * 키보드 — Space/Enter 로 "칠하기 시작", Shift+화살표로 확장.
   *
   * 토글 시점에 스냅샷(`baseRef`)과 기준점(`anchorRef`)을 함께 잡아 두기 때문에,
   * 이어지는 Shift+화살표가 드래그와 **정확히 같은 사각형 계산**을 탄다.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      const move = (deltaCol: number, deltaSlot: number) => {
        event.preventDefault();
        const next: CellRef = {
          col: clamp(safeFocus.col + deltaCol, 0, columns.length - 1),
          slot: clamp(safeFocus.slot + deltaSlot, firstSlot, lastSlot),
        };
        shouldFocusRef.current = true;
        setFocus(next);
        if (event.shiftKey && anchorRef.current !== null) {
          applyRect(anchorRef.current, next, modeRef.current);
        }
      };

      switch (event.key) {
        case "ArrowUp":
          move(0, -1);
          return;
        case "ArrowDown":
          move(0, 1);
          return;
        case "ArrowLeft":
          move(-1, 0);
          return;
        case "ArrowRight":
          move(1, 0);
          return;
        case "Home":
          move(0, firstSlot - safeFocus.slot);
          return;
        case "End":
          move(0, lastSlot - safeFocus.slot);
          return;
        case " ":
        case "Enter": {
          event.preventDefault();
          const column = columns[safeFocus.col];
          if (column === undefined) return;
          const mode: PaintMode = selected.has(
            slotKey(column.isoWeekday, safeFocus.slot),
          )
            ? "erase"
            : "paint";
          baseRef.current = new Set(selected);
          anchorRef.current = safeFocus;
          modeRef.current = mode;
          applyRect(safeFocus, safeFocus, mode);
          return;
        }
        default:
          return;
      }
    },
    [
      applyRect,
      columns,
      disabled,
      firstSlot,
      lastSlot,
      safeFocus,
      selected,
    ],
  );

  const slots: number[] = [];
  for (let slot = firstSlot; slot <= lastSlot && slot < SLOT_COUNT; slot += 1) {
    slots.push(slot);
  }

  /** 시간 눈금 열 + 요일 7열. 모든 행이 같은 템플릿을 써야 칸이 세로로 맞는다. */
  const template = `3.25rem repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`;

  return (
    <div className="flex flex-col">
      {/* 요일 머리글 — 스크롤해도 붙어 있어야 어느 열을 칠하는지 알 수 있다. */}
      <div
        role="presentation"
        className="sticky top-0 z-10 grid border-b border-border bg-surface pb-1"
        style={{ gridTemplateColumns: template }}
      >
        <span aria-hidden />
        {columns.map((column) => (
          <span
            key={column.isoWeekday}
            className={cn(
              "px-0.5 text-center text-body-sm font-bold",
              column.isWeekend ? "text-tertiary" : "text-ink",
            )}
          >
            {column.label}
          </span>
        ))}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label="요일별 반복 가능 시간 격자"
        aria-readonly={disabled || undefined}
        aria-multiselectable="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className="select-none"
      >
        {slots.map((slot) => {
          const isHourStart = slot % 2 === 0;
          const isOvernight = slot >= MIDNIGHT_SLOT;
          const isMidnightEdge = slot === MIDNIGHT_SLOT;

          return (
            <div
              key={slot}
              role="row"
              className="grid"
              style={{ gridTemplateColumns: template }}
            >
              {/*
                시간 눈금. `touch-action: pan-y` 라 이 열을 끌면 평소처럼 스크롤된다 —
                칸이 `touch-action: none` 이라 격자 위에서는 스크롤이 막히기 때문이다.
              */}
              <span
                role="rowheader"
                className={cn(
                  "flex h-6 touch-pan-y items-center justify-end pr-1.5 text-caption tabular-nums",
                  isOvernight ? "text-tertiary" : "text-ink-muted",
                )}
              >
                {isHourStart ? (
                  slotLabel(slot)
                ) : (
                  <span className="sr-only">{slotLabel(slot)}</span>
                )}
              </span>

              {columns.map((column, colIndex) => {
                const key = slotKey(column.isoWeekday, slot);
                const isSelected = selected.has(key);
                const isFocused =
                  safeFocus.col === colIndex && safeFocus.slot === slot;

                return (
                  <div
                    key={column.isoWeekday}
                    role="gridcell"
                    data-cell=""
                    data-col={colIndex}
                    data-slot={slot}
                    tabIndex={isFocused ? 0 : -1}
                    aria-selected={isSelected}
                    aria-label={`${column.label}요일 ${slotLabel(slot)} ${
                      isSelected ? "가능" : "미선택"
                    }`}
                    className={cn(
                      "h-6 touch-none border-l border-border transition-colors duration-100",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                      isHourStart ? "border-t border-t-border" : "",
                      // 24:00 경계 — 겹쳐보기의 자정 구분선과 같은 표현.
                      isMidnightEdge && "border-t-2 border-dashed border-t-tertiary",
                      colIndex === columns.length - 1 && "border-r border-border",
                      isSelected
                        ? "bg-primary"
                        : cn(
                            column.isWeekend ? "bg-neutral-50" : "bg-surface",
                            !disabled && "hover:bg-primary-subtle",
                          ),
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
