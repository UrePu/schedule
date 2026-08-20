import {
  CalendarRange,
  Coins,
  LayoutDashboard,
  Swords,
  Users,
} from "lucide-react";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 화면 이동의 **유일한 목록**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 데스크톱 상단 바와 모바일 하단 탭이 같은 배열을 읽는다. 두 벌로 두면 한쪽에만
 * 경로가 추가되는 사고가 반드시 난다.
 *
 * ★ `/showcase` 는 **넣지 않는다.** 개발용 컴포넌트 갤러리이며(`layout.tsx` 주석에도
 *   같은 말이 있다) 제품 내비게이션에 노출할 화면이 아니다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `requiresAuth` 가 하는 일
 * ─────────────────────────────────────────────────────────────────────────────
 * `/boss-plans` 와 `/income` 은 서버가 세션을 보고 "로그인이 필요합니다" 카드를 그린다.
 * 즉 **비로그인 사용자에게는 눌러도 아무것도 없는 링크**다. 닿을 수 없는 곳을 띄워
 * 두고 눌렀을 때 막는 것은 나쁜 동선이라, 세션이 없으면 이 항목을 **아예 그리지 않는다.**
 * (막는 쪽은 그대로 살아 있다 — 주소를 직접 쳐도 페이지가 안내를 그린다.)
 */
export interface NavRoute {
  readonly href: string;
  readonly label: string;
  /** lucide 아이콘. 현재 위치 표시의 **두 번째 채널**이자 좁은 탭의 주 식별자다. */
  readonly icon: typeof Coins;
  /** 로그인해야 내용이 있는 화면인가. */
  readonly requiresAuth: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  {
    href: "/",
    label: "대시보드",
    icon: LayoutDashboard,
    requiresAuth: false,
  },
  {
    href: "/schedule",
    label: "일정",
    icon: CalendarRange,
    requiresAuth: false,
  },
  {
    href: "/boss-plans",
    label: "보스 계획",
    icon: Swords,
    requiresAuth: true,
  },
  {
    href: "/income",
    label: "수익",
    icon: Coins,
    requiresAuth: true,
  },
  /*
   * 친구 (발주 지시 2026-08-20: *"맨위에 수익 옆에 친구 탭 만들어"*).
   *
   * ★ **수익 바로 다음**이다. 순서는 §1.2 의 가치 순서(겹쳐보기 → 수익 → 친구 공유)와
   *   맞고, 발주자가 지정한 자리와도 같다.
   * ★ `requiresAuth` — 친구 관계는 개인의 사회관계망이라 공개면에 실리지 않는다.
   *   비로그인에게는 항목 자체가 그려지지 않는다(이 파일 머리말).
   */
  {
    href: "/friends",
    label: "친구",
    icon: Users,
    requiresAuth: true,
  },
];

/**
 * 현재 위치 판정.
 *
 * `/` 는 **정확히 일치할 때만** 활성이다. `startsWith` 로 처리하면 모든 경로가
 * 대시보드의 하위로 잡혀 탭 두 개가 동시에 켜진다.
 * 나머지는 하위 경로(`/schedule/xxx`)까지 같은 항목으로 본다.
 */
export function isNavRouteActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
