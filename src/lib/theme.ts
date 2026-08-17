/**
 * 테마(라이트/다크) 선택 상태.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 가지 상태를 구분한다
 * ─────────────────────────────────────────────────────────────────────────────
 * - `system` — **기본값.** OS 설정(`prefers-color-scheme`)을 따른다.
 * - `light` / `dark` — 사용자가 못박은 값. localStorage 에 저장된다.
 *
 * "system" 을 별도 상태로 둔 이유: 저장값을 라이트/다크 둘 중 하나로만 두면
 * OS 를 다크로 바꿔도 앱이 따라가지 않는다. 사용자가 "알아서 해"라고 말할 수 있어야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CSS 와의 계약
 * ─────────────────────────────────────────────────────────────────────────────
 * - `system` 이면 `<html>` 의 `data-theme` 를 **지운다.** 그러면 globals.css 의
 *   `@media (prefers-color-scheme: dark)` 규칙이 알아서 적용된다.
 * - `light`/`dark` 면 `data-theme` 에 그 값을 쓴다. 미디어 쿼리 규칙은
 *   `:root:not([data-theme="light"])` 로 막혀 있고, `[data-theme="dark"]` 규칙이 이긴다.
 *
 * 즉 **CSS 가 단일 진실**이고 JS 는 속성 하나만 만진다. JS 가 색을 계산하지 않는다.
 */

export const THEME_STORAGE_KEY = "m-schedule.theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "시스템",
  light: "라이트",
  dark: "다크",
};

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** 저장된 선택. 없거나 이상하면 `system`. */
export function readStoredTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    // 시크릿 모드 등에서 localStorage 접근이 막힐 수 있다. 기본값으로 계속 간다.
    return "system";
  }
}

/** `<html data-theme>` 를 선택에 맞게 갱신한다. 색 계산은 CSS 가 한다. */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/** 선택을 저장하고 즉시 적용한다. 같은 탭의 구독자에게도 알린다. */
export function setTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // 저장이 막혀도 이번 세션 동안은 적용되어야 한다.
  }
  applyTheme(choice);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** 같은 탭 안에서의 변경 알림. `storage` 이벤트는 **다른 탭**에서만 발생한다. */
export const THEME_EVENT = "m-schedule:themechange";

/** `useSyncExternalStore` 용 구독자. 같은 탭 + 다른 탭 변경을 모두 받는다. */
export function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * 첫 페인트 **전에** 실행되어야 하는 스크립트.
 *
 * FOUC 방지의 핵심이다. React 가 하이드레이트된 뒤에 테마를 적용하면
 * 라이트 화면이 한 번 번쩍인 뒤 다크로 바뀐다. 그래서 `<head>` 안에서
 * 동기적으로 실행해 `data-theme` 를 먼저 박는다.
 *
 * 문자열로 두는 이유: 번들러를 거치지 않고 인라인으로 나가야 하기 때문이다.
 * try/catch 로 감싼 이유: localStorage 가 막힌 환경에서 이 스크립트가 던지면
 * 뒤따르는 문서 파싱이 멈춘다.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(c==="light"||c==="dark"){document.documentElement.setAttribute("data-theme",c);}}catch(e){}})();`;
