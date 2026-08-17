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
import { FilterChip } from "./chip";

/**
 * 테마 전환 (시스템 / 라이트 / 다크).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `useSyncExternalStore` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 선택값은 localStorage 에 있다 — **React 밖의 외부 저장소**다.
 * `useState` + `useEffect` 로 읽어 오면 (1) effect 안에서 setState 를 하게 되고
 * (2) 첫 렌더가 항상 "system" 이라 실제 선택과 한 프레임 어긋난다.
 * `useSyncExternalStore` 는 이 용도로 만들어진 훅이고, 서버 스냅샷을 따로 줄 수 있어
 * 하이드레이션도 안전하다.
 *
 * 화면 자체의 테마는 이 컴포넌트가 아니라 `<head>` 의 인라인 스크립트가 이미
 * 첫 페인트 전에 적용해 둔다. 여기서는 **현재 선택을 보여 주고 바꾸는 일**만 한다.
 *
 * 새 프리미티브를 만들지 않고 `FilterChip` 을 조합했다 — 선택 상태와 키보드 조작이
 * 이미 해결돼 있고, `aria-pressed` 도 그대로 쓴다.
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

  return (
    <div
      role="group"
      aria-label="테마"
      className={cn("flex items-center gap-1", className)}
    >
      {THEME_CHOICES.map((value) => {
        const Icon = ICONS[value];
        return (
          <FilterChip
            key={value}
            selected={choice === value}
            onClick={() => setTheme(value)}
            aria-label={`테마 ${THEME_LABEL[value]}`}
            title={`테마 ${THEME_LABEL[value]}`}
            className={compact ? "px-2" : undefined}
          >
            <Icon aria-hidden size={14} />
            {compact ? null : THEME_LABEL[value]}
          </FilterChip>
        );
      })}
    </div>
  );
}
