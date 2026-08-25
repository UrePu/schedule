"use client";

import { describeDayMinute } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";

import { toAxisPercent, type OverlayAxis } from "../lib/overlay-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 고른 시간대 표시자 — `▶────` 모양의 막대 하나
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"가로 세로 둘다 >------ 처럼 생긴 막대를 하나넣어서 시간대를
 * 고르고 겹치는부분을 클릭하면 바로 일정 생성 모달이 들어가면좋을거같음"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 막대가 답하는 질문: **"여기서 시작하면 몇 시에 끝나지?"**
 * ─────────────────────────────────────────────────────────────────────────────
 * 그전에는 겹침 막대를 누르면 시각이 어딘가에 저장될 뿐, 화면에는 아무 표시가 없었다.
 * 21:00~24:00 겹침에서 22시를 골랐는지 22시 10분을 골랐는지 **화면만 봐서는 알 수 없었고**,
 * 세 보스를 도는 데 한 시간이 걸린다는 사실은 등록 모달에 들어가야 알 수 있었다.
 *
 * 그래서 고른 시각에서 **예정 소요만큼 뻗는 막대**를 그린다. 머리(`▶`)가 시작이고 길이가
 * 소요다. 겹침 안에 들어가면 primary, 삐져나가면 그 초과분이 tertiary 로 갈린다 —
 * "이 겹침으로는 부족하다"가 색 하나로 보인다.
 *
 * ★ **경고는 tertiary orange 다. red 가 아니다.** 겹침을 넘긴 것은 실패가 아니라
 *   "그 시간엔 누가 빠질 수도 있다"는 사실이고, red 는 실패·취소 전용이다(§4).
 * ★ 색만으로 말하지 않는다 — 초과분에는 시각 라벨이 붙고, 넘칠 때만 `+N분` 이 나온다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **포인터를 받지 않는다** (`pointer-events-none`)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 막대는 겹침 막대 **위에** 겹쳐 그려진다. 포인터를 받으면 그 아래 겹침 막대의
 * 드래그·클릭을 통째로 가로채, 정작 시각을 고칠 수 없게 된다. 조작은 아래 막대가 하고
 * 이 막대는 **결과만 말한다.** 한 자리에 조작 대상이 둘이면 어느 쪽을 잡았는지 알 수 없다.
 */

export interface SelectionRangeBarProps {
  /** 가로 격자는 `x`(left/width), 세로 격자는 `y`(top/height)로 그린다. */
  readonly orientation: "x" | "y";
  readonly axis: OverlayAxis;
  /** 고른 시작 시각 — 그날 00:00 KST 기준 분. 1440 을 넘을 수 있다. */
  readonly startMinute: number;
  /** 예정 소요(분). 보스 수 × 보스당 소요. */
  readonly plannedMinutes: number;
  /** 이 시각이 속한 겹침의 끝. 여기를 넘는 부분이 초과분이다. */
  readonly windowEndMinute: number;
  readonly className?: string;
}

export function SelectionRangeBar({
  orientation,
  axis,
  startMinute,
  plannedMinutes,
  windowEndMinute,
  className,
}: SelectionRangeBarProps) {
  const endMinute = startMinute + plannedMinutes;
  const overflowMinutes = Math.max(0, endMinute - windowEndMinute);

  const startPct = toAxisPercent(startMinute, axis);
  const endPct = toAxisPercent(endMinute, axis);
  /* 축 밖으로 나가면 `toAxisPercent` 가 100 으로 잘라 준다. 최소 길이는 보이라고 준다. */
  const lengthPct = Math.max(endPct - startPct, 0.8);
  const insidePct =
    overflowMinutes <= 0
      ? lengthPct
      : Math.max(toAxisPercent(windowEndMinute, axis) - startPct, 0);

  const isVertical = orientation === "y";

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10",
        isVertical ? "inset-x-0" : "inset-y-0",
        className,
      )}
      style={
        isVertical
          ? { top: `${startPct}%`, height: `${lengthPct}%` }
          : { left: `${startPct}%`, width: `${lengthPct}%` }
      }
    >
      {/*
        겹침 안쪽 — primary. 실선 테두리를 함께 두는 이유는 아래 겹침 밴드가 이미
        primary 계열이라, 채움만으로는 어디까지가 선택인지 경계가 보이지 않기 때문이다.
      */}
      <span
        className={cn(
          "absolute rounded-sm border-2 border-primary bg-primary/30",
          isVertical ? "inset-x-0 top-0" : "inset-y-0 left-0",
        )}
        style={
          isVertical
            ? { height: `${(insidePct / lengthPct) * 100}%` }
            : { width: `${(insidePct / lengthPct) * 100}%` }
        }
      />

      {/* 겹침을 넘어간 부분 — tertiary(임박·주의). red 가 아니다(§4). */}
      {overflowMinutes > 0 ? (
        <span
          className={cn(
            "absolute rounded-sm border-2 border-dashed border-tertiary bg-tertiary/25",
            isVertical ? "inset-x-0 bottom-0" : "inset-y-0 right-0",
          )}
          style={
            isVertical
              ? { height: `${((lengthPct - insidePct) / lengthPct) * 100}%` }
              : { width: `${((lengthPct - insidePct) / lengthPct) * 100}%` }
          }
        />
      ) : null}

      {/*
        머리(`▶`). 발주자가 그린 `>------` 의 `>` 다 — **어느 쪽이 시작인지**를 말한다.
        길이만 있는 막대는 좌우 어느 끝이 시작인지 알려 주지 않는다.
      */}
      <span
        className={cn(
          "absolute size-2 rounded-full bg-primary ring-2 ring-surface",
          isVertical
            ? "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2"
            : "top-1/2 left-0 -translate-x-1/2 -translate-y-1/2",
        )}
      />

      {/*
        시각 라벨. 세로 배치에서는 막대가 좁아 안에 글자가 못 들어가므로 **옆에** 붙인다.
        `26:00` 처럼 24 를 넘겨 적는다 — 자정을 넘긴 시각을 `02:00` 으로 되돌리면
        어느 날인지 사라진다(`describeDayMinute`).
      */}
      <span
        className={cn(
          "absolute whitespace-nowrap rounded-sm bg-primary px-1 py-px text-overline font-bold tabular-nums text-white",
          isVertical
            ? "top-0 left-full ml-1"
            : "bottom-full left-0 mb-0.5",
        )}
      >
        {describeDayMinute(startMinute)}~{describeDayMinute(endMinute)}
        {overflowMinutes > 0 ? ` (+${String(overflowMinutes)}분)` : ""}
      </span>
    </div>
  );
}
