"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Skeleton } from "@/components/ui";
import { useSessionQuery } from "@/features/auth/data/auth-queries";
import { cn } from "@/lib/utils";

import { NAV_ROUTES, isNavRouteActive, type NavRoute } from "./nav-routes";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 화면 이동 — 데스크톱은 **상단 바 확장**, 모바일은 **하단 탭 바**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구: *"위나 왼쪽에 네비게이션바도 만들어줘. 모바일 반응형으로."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 좌측 사이드바가 아니라 상단 바인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 경로가 **4개**다. 사이드바는 항목이 십수 개로 늘고 계층이 생길 때 값을 하는데,
 * 4개짜리 사이드바는 화면 좌측 220px 을 상시 차지하면서 아무 정보도 더하지 않는다.
 * 이 앱의 핵심 화면(`/schedule` 겹쳐보기)은 **가로 폭이 곧 시간축**이라 폭을 깎는
 * 결정이 그대로 정보 손실이 된다. 게다가 상단 바는 이미 있고 테마 토글이 살고 있으므로,
 * 새 레이아웃을 만드는 것보다 **있는 바에 얹는 쪽이 흔들림이 적다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 모바일은 햄버거가 아니라 하단 탭인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 항목이 4개면 하단 탭 한 줄에 정확히 들어간다(360px 에서 탭 하나 90px).
 * 햄버거는 "열기 → 고르기" 두 동작인데 탭은 한 동작이고, 엄지가 닿는 곳에 있다.
 * 탭 높이는 56px 로 44×44 터치 목표를 넘긴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 현재 위치는 **두 채널 이상**으로 표시한다 (§4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 색만으로 구분하면 색각 이상에서 사라진다. 그래서 활성 항목은
 *   (1) 색(`text-primary`)  (2) **굵기**(`font-bold` ↔ `font-medium`)
 *   (3) 면(데스크톱 `bg-primary-subtle` 알약 / 모바일 상단 2px 인디케이터)
 * 이 함께 바뀌고, 보조기기에는 `aria-current="page"` 로 한 번 더 말한다.
 *
 * 대비 실측(WCAG 2.1, 렌더되는 조합 기준):
 *   라이트 primary #4f46e5 on primary-subtle #eef2ff = **5.64:1** (AA)
 *   다크   primary #8b85f5 on primary-subtle #22203a = **5.09:1** (AA)
 *   비활성 ink-label  라이트 #3f3f46 on surface #ffffff = 10.4:1
 *                     다크   #d4d4d8 on surface #18181d = 11.97:1
 *   모바일 비활성 ink-muted 라이트 5.04:1 / 다크 9.01:1
 *   (여기 적힌 hex 는 계산 근거를 남긴 **주석**이며, 코드는 토큰만 쓴다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 상태 — **닿을 수 없는 곳은 띄우지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `/boss-plans` 와 `/income` 은 비로그인에게 "로그인이 필요합니다" 카드만 준다.
 * 그런 링크를 띄워 두고 눌렀을 때 막는 것은 나쁜 동선이라 **항목 자체를 감춘다.**
 *
 * ★ 판정은 **클라이언트의 `useSessionQuery()`** 로만 한다. 서버 컴포넌트에서 세션을
 *   읽어 리다이렉트하는 방식은 **쓰지 않는다** — 비로그인 200 보장(DoD §0.3)이
 *   라우팅 계층으로 흩어지고 실패 지점이 늘어난다. 이 훅은 비로그인에서 200
 *   `{user:null}` 을 받으므로 `isError` 조차 아니다.
 *
 * 세션을 아직 모르는 동안(SSR 첫 페인트 ~ `/api/auth/me` 응답)에는 **자리표시자**를
 * 둔다. 곧바로 감췄다가 나중에 두 개가 튀어나오면 바가 한 번 출렁이기 때문이다.
 * 조회 실패는 "비로그인"으로 취급한다 — 열리지 않는 곳을 여는 것보다 안전하다.
 */

interface NavState {
  /** 지금 보여 줄 항목. */
  readonly routes: readonly NavRoute[];
  /** 세션을 아직 모르는 상태. 감춰 둔 자리에 자리표시자를 그린다. */
  readonly isResolving: boolean;
  /** 감춰진 항목 수 = 자리표시자 개수. */
  readonly pendingCount: number;
}

function useNavState(): NavState {
  const session = useSessionQuery();
  const isSignedIn = (session.data?.user ?? null) !== null;
  const routes = NAV_ROUTES.filter((route) => !route.requiresAuth || isSignedIn);

  return {
    routes,
    isResolving: session.isPending,
    pendingCount: NAV_ROUTES.length - routes.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 데스크톱 — 상단 바 안쪽
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `h-control-md`(38px) 는 상단 바에서 터치로도 눌리는 최소치다. 태블릿(md~lg)도
 * 손가락으로 만지므로 30px 짜리 칩 높이를 그대로 쓰지 않았다.
 * `shrink-0` 인 이유: 라벨이 줄면 `대시…` 가 된다. 좁아질 때 양보하는 쪽은
 * **브랜드**로 이미 정해져 있다(`layout.tsx` 주석).
 */
const DESKTOP_ITEM_BASE = cn(
  "inline-flex h-control-md shrink-0 items-center gap-1.5 rounded-md px-3",
  "text-body-sm whitespace-nowrap transition duration-200",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
);

export interface PrimaryNavProps {
  readonly className?: string;
}

/** 데스크톱 내비게이션. 상단 바의 브랜드 옆에 붙는다. */
export function PrimaryNav({ className }: PrimaryNavProps) {
  const pathname = usePathname();
  const { routes, isResolving, pendingCount } = useNavState();

  return (
    <nav
      aria-label="주요 메뉴"
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      {routes.map((route) => {
        const Icon = route.icon;
        const active = isNavRouteActive(route.href, pathname);

        return (
          <Link
            key={route.href}
            href={route.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              DESKTOP_ITEM_BASE,
              active
                ? "bg-primary-subtle font-bold text-primary"
                : "font-medium text-ink-label hover:bg-hover-strong hover:text-ink",
            )}
          >
            <Icon aria-hidden size={16} />
            {route.label}
          </Link>
        );
      })}

      {/* 로딩 — 세션을 모르는 동안 감춰 둔 자리를 잡아 둔다(바가 출렁이지 않게). */}
      {isResolving
        ? Array.from({ length: pendingCount }, (_, index) => (
            <Skeleton
              key={`pending-${String(index)}`}
              className="h-control-md w-20 shrink-0"
            />
          ))
        : null}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 모바일 — 하단 탭 바
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 탭 하나.
 *
 * `min-h-nav-mobile`(56px)이 터치 목표를 책임진다 — 44×44 를 넘긴다.
 * 라벨은 `text-caption`(12px)이다. §4 의 14px 하한은 **문장**에 대한 규칙이고,
 * 아이콘과 짝지어 한 단어로 읽히는 탭 라벨은 그 문서가 12px 을 허용한 "라벨"이다.
 * 그래도 색은 `ink-muted` 이상만 쓴다(플레이스홀더 톤 금지).
 */
const MOBILE_ITEM_BASE = cn(
  "relative flex min-h-nav-mobile w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5",
  "text-caption transition duration-200",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
);

/**
 * 모바일 하단 탭 바. `md`(768px) 미만에서만 뜬다.
 *
 * ⚠️ 본문 하단 여백은 `layout.tsx` 의 `<body>` 가 잡는다 — 이 바가 `fixed` 라
 *    문서 흐름에서 빠져 있어서, 여백이 없으면 마지막 요소가 바 밑에 가린다.
 *    바와 여백은 **같은 토큰**(`--spacing-nav-mobile`)을 쓴다.
 * ⚠️ `pb-[env(safe-area-inset-bottom)]` 은 아이폰 홈 인디케이터 영역이다.
 *    없는 기기에서는 0 이므로 항상 붙여 둬도 손해가 없다.
 */
export function MobileTabBar() {
  const pathname = usePathname();
  const { routes, isResolving, pendingCount } = useNavState();

  return (
    <nav
      aria-label="주요 메뉴"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 md:hidden",
        "border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur",
      )}
    >
      <ul className="mx-auto flex w-full max-w-[92rem] items-stretch">
        {routes.map((route) => {
          const Icon = route.icon;
          const active = isNavRouteActive(route.href, pathname);

          return (
            <li key={route.href} className="min-w-0 flex-1">
              <Link
                href={route.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  MOBILE_ITEM_BASE,
                  active
                    ? "font-bold text-primary"
                    /*
                     * 비활성 탭에 hover 가 **하나도** 없었다. 모바일 바이긴 하지만
                     * 데스크톱 폭을 줄이면 그대로 보이고, 무엇보다 focus 이동 시
                     * 아무 반응이 없었다. 배경 + 글자색 두 채널로 바꾼다.
                     * (`ink-muted` 는 `hover-strong` 위에서 3.88:1 이라 AA 미달 —
                     *  그래서 hover 시 `ink` 로 함께 올린다. 라이트 14.23:1 / 다크 12.06:1)
                     */
                    : "font-medium text-ink-muted hover:bg-hover-strong hover:text-ink",
                )}
              >
                {/* 활성 인디케이터 — 색 말고 **면**으로도 말하는 채널. */}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary"
                  />
                ) : null}
                <Icon aria-hidden size={20} />
                <span className="max-w-full truncate">{route.label}</span>
              </Link>
            </li>
          );
        })}

        {isResolving
          ? Array.from({ length: pendingCount }, (_, index) => (
              <li
                key={`pending-${String(index)}`}
                className="min-w-0 flex-1"
                aria-hidden
              >
                <div className="flex min-h-nav-mobile flex-col items-center justify-center gap-1 px-1 py-1.5">
                  <Skeleton shape="circle" className="size-5" />
                  <Skeleton shape="text" className="h-3 w-10" />
                </div>
              </li>
            ))
          : null}
      </ul>
    </nav>
  );
}
