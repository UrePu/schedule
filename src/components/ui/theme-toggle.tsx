"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  THEME_CHOICES,
  THEME_LABEL,
  readStoredTheme,
  setTheme,
  subscribeTheme,
  type ThemeChoice,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * 테마 전환 (시스템 / 라이트 / 다크).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 버튼 **하나**로 돌린다 (2026-08-19 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"다크모드 저거 3버튼말고 현재 상태 기준으로 보여주는 클릭하면 바뀌는 1 버튼으로 바꿔
 * 3가지로."*
 *
 * 예전에는 세 개를 다 늘어놓고 현재 값에 선택 표시를 했다. 정보량은 많지만 상단 바에서
 * 세 칸을 상시 차지하고, **세 값 모두가 늘 보여야 할 이유가 없다** — 사람들이 이 컨트롤을
 * 쓰는 방식은 "지금 게 마음에 안 들면 바꾼다"이지 "셋 중 하나를 고른다"가 아니다.
 * 그래서 지금 값 하나만 보여 주고 누르면 다음으로 넘어간다. 순환 순서는
 * `THEME_CHOICES` 그대로 **시스템 → 라이트 → 다크 → 시스템**이다.
 *
 * ⚠️ 순환 버튼은 `aria-pressed` 를 쓰지 않는다 — 눌림/안 눌림 두 상태가 아니다. 대신
 *    `aria-label` 이 **지금 값과 누르면 될 값**을 함께 말한다. 아이콘만 있는 compact
 *    형에서는 그 라벨이 유일한 설명이라 더 중요하다.
 * ⚠️ 화면 자체의 테마는 이 컴포넌트가 아니라 `<head>` 의 인라인 스크립트가 첫 페인트
 *    전에 적용해 둔다. 여기서는 **현재 선택을 보여 주고 바꾸는 일**만 한다.
 */

const ICONS: Record<ThemeChoice, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** 서버에서는 저장값을 알 수 없다. 스크립트가 첫 페인트에 실제 테마를 적용해 둔 상태다. */
function getServerSnapshot(): ThemeChoice {
  return "system";
}

/** 다음 값. 목록 끝에서 처음으로 돌아온다. */
function nextChoice(current: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(current);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length];
}

export interface ThemeToggleProps {
  readonly className?: string;
  /** 좁은 곳에서는 아이콘만. */
  readonly compact?: boolean;
}

export function ThemeToggle({ className, compact = false }: ThemeToggleProps) {
  const choice = useSyncExternalStore(
    subscribeTheme,
    readStoredTheme,
    getServerSnapshot,
  );
  const Icon = ICONS[choice];
  const next = nextChoice(choice);

  return (
    <Button
      variant="secondary"
      size="sm"
      aria-label={`테마 ${THEME_LABEL[choice]} — 누르면 ${THEME_LABEL[next]}`}
      title={`테마 ${THEME_LABEL[choice]} (누르면 ${THEME_LABEL[next]})`}
      onClick={() => setTheme(next)}
      className={cn("cursor-pointer", compact && "px-2", className)}
    >
      <Icon aria-hidden size={14} />
      {compact ? null : THEME_LABEL[choice]}
    </Button>
  );
}
