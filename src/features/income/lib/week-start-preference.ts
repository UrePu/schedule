/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 달력 격자의 **주 시작 요일** 선택 — 월요일(M) / 일요일(S)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"옆에 버튼 넣어서 맨앞이 일요일에오는 캘린더로 변환할수있게 해
 * M / S 이렇게 바뀌도록."*
 *
 * ★ **회계 주(목 00:00 KST 리셋)와는 아무 상관이 없다.** 이 값은 격자를 어느 요일부터
 *   그리느냐, 오직 그것만 정한다. 주차 계산·수익 귀속·12개 상한은 전부 목요일 경계
 *   그대로다(§1). 그래서 이 선택을 바꿔도 **숫자는 한 자리도 움직이지 않는다** — 칸의
 *   배열만 바뀐다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `lib/theme.ts` 와 같은 모양인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 선택값이 localStorage(= React 밖의 외부 저장소)에 있고, 화면은 `useSyncExternalStore`
 * 로 읽는다. `useState` + `useEffect` 로 읽으면 첫 렌더가 항상 기본값이라 저장된 선택과
 * 한 프레임 어긋나고, effect 안에서 setState 를 하게 된다. 이미 테마에서 같은 문제를
 * 풀어 뒀으므로 **패턴을 새로 만들지 않고 그대로 따른다.**
 *
 * 테마와 다른 점 하나: 첫 페인트 전에 박아 넣는 인라인 스크립트가 **없다.** 테마는 화면
 * 전체 색이 번쩍이지만 이 값은 달력 카드 하나의 칸 순서일 뿐이고, 그 한 프레임을 없애려고
 * `<head>` 에 스크립트를 하나 더 넣을 만한 값이 아니다.
 */

export const WEEK_START_STORAGE_KEY = "m-schedule.calendar-week-start";

/** `mon` = 월요일 시작(기본), `sun` = 일요일 시작. */
export const WEEK_START_CHOICES = ["mon", "sun"] as const;
export type WeekStartChoice = (typeof WEEK_START_CHOICES)[number];

/** 버튼에 찍히는 한 글자. 발주자가 지정한 표기다. */
export const WEEK_START_BADGE: Record<WeekStartChoice, string> = {
  mon: "M",
  sun: "S",
};

/** 사람이 읽는 이름. 버튼의 `title` · `aria-label` 이 쓴다. */
export const WEEK_START_LABEL: Record<WeekStartChoice, string> = {
  mon: "월요일 시작",
  sun: "일요일 시작",
};

/** 기본값은 **월요일 시작**(발주자 2026-08-19: *"월요일시작으로 해 나는그게 편해"*). */
export const DEFAULT_WEEK_START: WeekStartChoice = "mon";

function isWeekStartChoice(value: string | null): value is WeekStartChoice {
  return value === "mon" || value === "sun";
}

/** 저장된 선택. 없거나 이상하면 기본값. */
export function readStoredWeekStart(): WeekStartChoice {
  if (typeof window === "undefined") return DEFAULT_WEEK_START;
  try {
    const stored = window.localStorage.getItem(WEEK_START_STORAGE_KEY);
    return isWeekStartChoice(stored) ? stored : DEFAULT_WEEK_START;
  } catch {
    // 시크릿 모드 등에서 localStorage 접근이 막힐 수 있다. 기본값으로 계속 간다.
    return DEFAULT_WEEK_START;
  }
}

/**
 * 서버 스냅샷. 저장값을 알 수 없으므로 기본값이다.
 *
 * 하이드레이션 직후 저장값으로 한 번 다시 그려진다 — 칸 순서만 바뀌므로 안전하다.
 */
export function serverWeekStart(): WeekStartChoice {
  return DEFAULT_WEEK_START;
}

/** 같은 탭 안에서의 변경 알림. `storage` 이벤트는 **다른 탭**에서만 발생한다. */
export const WEEK_START_EVENT = "m-schedule:calendarweekstartchange";

/** 선택을 저장하고 구독자에게 알린다. */
export function setStoredWeekStart(choice: WeekStartChoice): void {
  try {
    window.localStorage.setItem(WEEK_START_STORAGE_KEY, choice);
  } catch {
    // 저장이 막혀도 이번 세션 동안은 선택이 반영되어야 한다.
  }
  window.dispatchEvent(new Event(WEEK_START_EVENT));
}

/** `useSyncExternalStore` 용 구독자. 같은 탭 + 다른 탭 변경을 모두 받는다. */
export function subscribeWeekStart(onChange: () => void): () => void {
  window.addEventListener(WEEK_START_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(WEEK_START_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
