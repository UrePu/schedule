"use client";

import { describeDayMinute } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";

import { toAxisPercent, type OverlayAxis } from "../lib/overlay-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 고른 **시작 시각** 표시자
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"그냥 시작하는시간만 고르도록 해."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 길이를 그리지 않는가 — **아직 모르는 값이기 때문이다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 `▶────` 로 예정 소요만큼 뻗는 막대를 그렸다. 그런데 그 길이는 **보스를 몇 개
 * 고르느냐**에 달려 있고, 그건 등록 모달 2단계가 묻는다. 격자 위에서는 아직 답이 없는
 * 값을 추측으로 그린 셈이라, 화면이 `15:50~16:30` 이라고 단언해 놓고 모달에서 보스를
 * 하나 더 켜면 조용히 틀린 말이 됐다(발주 지적: *"시간대가 왜이럼?"*).
 *
 * 그래서 **아는 것만 그린다**: 시작 시각 하나. 끝 시각은 보스를 다 고른 뒤 모달이 말한다.
 * 추측을 지우면 화면이 틀릴 자리도 함께 사라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **포인터를 받지 않는다** (`pointer-events-none`)
 * ─────────────────────────────────────────────────────────────────────────────
 * 색은 primary 의 **보색인 노랑**이다(발주 지시 2026-08-25: *"보라색의 반대가 뭐야?
 * 좀 눈에 잘띄게 해봐"*). 이 격자는 primary 계열로 뒤덮여 있어 같은 계열의 선은 묻힌다.
 * 테두리가 어두운 중립색인 이유는 `globals.css` 의 `--color-playhead` 주석에 있다.
 *
 * 이 표시자는 겹침 막대 **위에** 겹쳐 그려진다. 포인터를 받으면 그 아래 겹침 막대의
 * 드래그·클릭을 통째로 가로채, 정작 시각을 고칠 수 없게 된다. 조작은 아래 막대가 하고
 * 이 표시자는 **결과만 말한다.**
 */

export interface SelectionStartMarkerProps {
  /** 가로 격자는 세로선(`left`), 세로 격자는 가로선(`top`)으로 그린다. */
  readonly orientation: "x" | "y";
  readonly axis: OverlayAxis;
  /** 고른 시작 시각 — 그날 00:00 KST 기준 분. 1440 을 넘을 수 있다. */
  readonly startMinute: number;
  /**
   * 가로 격자에서 **레인 거터만큼 왼쪽을 비운다.** 선을 행 전체에 그으려면 이름 칸을
   * 지나 레인이 시작하는 자리부터여야 한다(`AxisRules` 와 같은 기준).
   */
  readonly laneGutter?: boolean;
  /** 시각 라벨. 손잡이가 이미 시각을 말하는 자리에서는 끈다 — 같은 값이 두 번 나온다. */
  readonly showLabel?: boolean;
  readonly className?: string;
}

export function SelectionStartMarker({
  orientation,
  axis,
  startMinute,
  laneGutter = false,
  showLabel = true,
  className,
}: SelectionStartMarkerProps) {
  const startPct = toAxisPercent(startMinute, axis);
  const isVertical = orientation === "y";

  /*
    거터가 필요한 가로 격자에서는 **한 겹 더 감싼다.** 선의 `left` 는 레인 폭에 대한
    백분율이라, 거터를 같은 요소에 얹으면 `calc()` 로 섞여 계산이 어긋난다.
  */
  const line = (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10",
        isVertical ? "inset-x-0" : "inset-y-0",
        className,
      )}
      style={isVertical ? { top: `${startPct}%` } : { left: `${startPct}%` }}
    >
      {/*
        선 자체. 겹침 밴드가 이미 primary 계열이라 같은 색으로는 경계가 안 보인다.
        바깥쪽에 surface 색 링을 둘러 **어느 배경 위에서도 한 줄로 읽히게** 한다.
      */}
      <span
        className={cn(
          "absolute bg-playhead ring-1 ring-playhead-edge",
          isVertical
            ? "inset-x-0 h-0.5 -translate-y-1/2"
            : "inset-y-0 w-0.5 -translate-x-1/2",
        )}
      />

      {/*
        머리(●). 선만 있으면 눈금 세로선과 구별되지 않는다 — 이 점 하나가 "이건 내가
        고른 값"이라고 말한다.
      */}
      <span
        className={cn(
          "absolute size-2.5 rounded-full bg-playhead ring-2 ring-playhead-edge",
          isVertical
            ? "top-0 left-1 -translate-y-1/2"
            : "top-0 left-0 -translate-x-1/2",
        )}
      />

      {/*
        시각 라벨. `26:00` 처럼 24 를 넘겨 적는다 — 자정을 넘긴 시각을 `02:00` 으로
        되돌리면 어느 날인지 사라진다(`describeDayMinute`).
        세로에서는 선이 가로로 누우므로 라벨을 **오른쪽 끝**에 붙인다. 왼쪽은 시각 눈금이
        이미 쓰고 있어 겹친다.
      */}
      {showLabel ? (
        <span
          className={cn(
            "absolute whitespace-nowrap rounded-sm bg-playhead px-1 py-px text-overline font-bold tabular-nums text-playhead-edge",
            isVertical
              ? "top-0 right-0 -translate-y-1/2"
              : "bottom-full left-0 mb-1 -translate-x-1/2",
          )}
        >
          {describeDayMinute(startMinute)}
        </span>
      ) : null}
    </div>
  );

  if (!laneGutter) return line;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0"
      style={{ left: "var(--lane-gutter)" }}
    >
      {line}
    </div>
  );
}
