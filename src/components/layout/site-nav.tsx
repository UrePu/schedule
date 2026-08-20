"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Skeleton } from "@/components/ui";
import { useSessionQuery } from "@/features/auth/data/auth-queries";
import { cn } from "@/lib/utils";

import {
  NAV_GROUPS,
  isNavRouteActive,
  type NavGroup,
  type NavRoute,
} from "./nav-routes";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 화면 이동 — 데스크톱은 **상단 바의 드롭다운 둘**, 모바일은 **하단 탭 둘 + 시트**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"현황 ㄴ… 관리 ㄴ… 이렇게 드롭다운식 메뉴로 바꾸면 좋을거같대"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 평평한 탭에서 드롭다운으로 갔나
 * ─────────────────────────────────────────────────────────────────────────────
 * 경로가 4개일 때는 한 줄에 다 늘어놨다. 대시보드가 해체되면서 화면이 **8개**가 됐고,
 * 8개를 한 줄에 두면 (1) 데스크톱에서 브랜드를 밀어내고 (2) 모바일 하단 탭은 한 칸이
 * 45px 이 되어 라벨이 `계정…` 이 된다. 어느 쪽도 성립하지 않는다.
 *
 * 무리로 접는 이유는 `nav-routes.ts` 머리말에 있다 — 사람은 "보러 왔다 / 고치러 왔다"를
 * 먼저 정한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 열고 닫기 — **직접 만든다.** 드롭다운 프리미티브가 이 저장소에 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * `components/ui` 에는 Dialog 는 있어도 Popover/DropdownMenu 가 없다. 내비게이션 하나
 * 때문에 범용 프리미티브를 새로 세우면 그쪽이 훨씬 큰 표면이 되므로, 여기서 필요한
 * 만큼만 만든다. 대신 접근성에서 **깎지 않는다**:
 *   - 버튼에 `aria-expanded` / `aria-controls`
 *   - **Escape 로 닫고 버튼으로 포커스가 돌아온다**
 *   - 바깥 클릭(pointerdown)으로 닫는다 — click 으로 잡으면 링크 이동과 경합한다
 *   - 경로가 바뀌면 자동으로 닫는다(안 그러면 이동 후에도 메뉴가 떠 있다)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 데스크톱은 **hover 로 연다** — 나갈 때는 1초 유예 (발주 지시 2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"위에 네비게이션 바 호버하면 바로 켜지도록 하고 빠져나가는것도 1초의 대기시간을
 * 주고나서 꺼지게 해"*.
 *
 * ⚠️ 이 파일은 원래 *"hover 로 열지 않는다"* 고 적고 있었다. 근거는 두 가지였는데
 *    하나만 살아남았다:
 *      · **"터치 기기에는 hover 가 없다"** → 여전히 맞다. 그래서 hover 는
 *        `(hover: hover)` 인 기기에서만 붙인다(`useHasHover`). 터치는 탭 그대로다.
 *      · "지나가다 열리는 사고가 잦다" → **닫는 쪽에 1초 유예**를 두면 실제로 문제가 되는
 *        것은 지나가다 *열리는* 것이 아니라 지나가다 *닫히는* 것이다. 트리거와 메뉴
 *        사이를 대각선으로 가로지르면 잠깐 둘 다에서 벗어나는데, 유예가 없으면 그때
 *        닫혀 버린다. 발주 요구가 정확히 그 지점을 짚었다.
 *
 * ★ **클릭도 그대로 동작한다.** 키보드 사용자와 터치 기기에는 그것이 유일한 길이고,
 *   hover 로 연 뒤 클릭하면 닫힌다(토글). Escape 도 그대로다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 현재 위치는 **두 채널 이상**으로 표시한다 (§4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 색만으로 구분하면 색각 이상에서 사라진다. 활성 항목은
 *   (1) 색(`text-primary`)  (2) **굵기**(`font-bold` ↔ `font-medium`)
 *   (3) 면(`bg-primary-subtle` 알약 / 모바일 상단 2px 인디케이터)
 * 이 함께 바뀌고, 보조기기에는 `aria-current="page"` 로 한 번 더 말한다.
 * 무리 버튼도 **그 안에 현재 화면이 있으면** 같은 세 채널로 켜진다.
 *
 * 대비 실측(WCAG 2.1, 렌더되는 조합 기준):
 *   라이트 primary #4f46e5 on primary-subtle #eef2ff = **5.64:1** (AA)
 *   다크   primary #8b85f5 on primary-subtle #22203a = **5.09:1** (AA)
 *   비활성 ink-label  라이트 #3f3f46 on surface #ffffff = 10.4:1
 *                     다크   #d4d4d8 on surface #18181d = 11.97:1
 *   드롭다운 설명줄 ink-muted on surface 라이트 5.04:1 / 다크 9.01:1
 *   (여기 적힌 hex 는 계산 근거를 남긴 **주석**이며, 코드는 토큰만 쓴다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 상태 — **닿을 수 없는 곳은 띄우지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 대부분의 화면은 비로그인에게 "로그인이 필요합니다" 카드만 준다. 그런 링크를 띄워 두고
 * 눌렀을 때 막는 것은 나쁜 동선이라 **항목 자체를 감춘다.** 무리가 통째로 비면 무리
 * 버튼도 감춘다.
 *
 * ★ 판정은 **클라이언트의 `useSessionQuery()`** 로만 한다. 서버 컴포넌트에서 세션을
 *   읽어 리다이렉트하는 방식은 **쓰지 않는다** — 비로그인 200 보장(DoD §0.3)이
 *   라우팅 계층으로 흩어지고 실패 지점이 늘어난다. 이 훅은 비로그인에서 200
 *   `{user:null}` 을 받으므로 `isError` 조차 아니다.
 *
 * 세션을 아직 모르는 동안(SSR 첫 페인트 ~ `/api/auth/me` 응답)에는 무리 버튼을 그대로
 * 그린다 — **무리는 로그인 여부와 상관없이 항상 둘이므로 바가 출렁이지 않는다.**
 * (예전에는 항목이 직접 노출돼 자리표시자가 필요했다. 이제 필요 없어졌다.)
 * 조회 실패는 "비로그인"으로 취급한다 — 열리지 않는 곳을 여는 것보다 안전하다.
 */

/**
 * hover 가 메뉴에서 빠져나간 뒤 닫히기까지의 유예(ms). 발주 지시가 정한 값이다
 * (2026-08-20: *"빠져나가는것도 1초의 대기시간을 주고나서 꺼지게 해"*).
 *
 * 이 값이 하는 일은 **대각선 이동을 허용하는 것**이다. 트리거에서 메뉴 아래쪽 항목으로
 * 곧장 내려가면 도중에 둘 다에서 잠깐 벗어나는데, 유예가 없으면 그 순간 닫힌다.
 */
const HOVER_CLOSE_MS = 1000;

interface VisibleGroup extends NavGroup {
  readonly routes: readonly NavRoute[];
}

function useVisibleGroups(): readonly VisibleGroup[] {
  const session = useSessionQuery();
  const isSignedIn = (session.data?.user ?? null) !== null;

  return NAV_GROUPS.flatMap((group) => {
    const routes = group.routes.filter(
      (route) => !route.requiresAuth || isSignedIn,
    );
    return routes.length === 0 ? [] : [{ ...group, routes }];
  });
}

/**
 * 열림 상태 하나. 열려 있는 무리는 **최대 하나**다 — 둘이 동시에 펼쳐지면 겹쳐서
 * 어느 쪽을 고르는지 알 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 경로가 바뀌면 닫는다 — 그런데 **effect 로 닫지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 링크를 눌러 이동한 뒤 메뉴가 남아 있으면 "안 눌렸나" 싶어 한 번 더 누르게 된다.
 * 그래서 닫아야 하는데, `useEffect(() => setOpenId(null), [pathname])` 은 **렌더를
 * 한 번 더 유발한다** — 새 화면이 메뉴가 열린 채로 한 프레임 그려진 뒤 닫히는 것이라
 * 눈에 보이는 깜빡임이기도 하다(그리고 `react-hooks/set-state-in-effect` 가 막는다).
 *
 * 대신 **열림 상태에 그 경로를 함께 적어 둔다.** 경로가 달라진 순간 그 상태는 낡은 것이
 * 되고, 렌더 중에 `null` 로 읽힌다 — 추가 렌더도, 깜빡임도 없다. 상태를 지우는 것이
 * 아니라 "언제의 상태인지"를 판정에 넣는 방식이다.
 */
function useMenuState() {
  const pathname = usePathname();
  const [state, setState] = useState<{
    readonly openId: string | null;
    readonly at: string;
  }>({ openId: null, at: pathname });

  // 다른 화면에서 열어 둔 상태는 이 화면의 것이 아니다.
  const openId = state.at === pathname ? state.openId : null;

  const setOpenId = useCallback(
    (next: string | null) => {
      setState({ openId: next, at: pathname });
    },
    [pathname],
  );

  /*
    닫기 유예 타이머. **ref 인 이유**: 이 값이 바뀐다고 다시 그릴 것이 없고, state 로
    두면 타이머를 걸 때마다 렌더가 한 번씩 더 돈다.
  */
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /** hover 진입 — **즉시** 연다(발주 요구: *"호버하면 바로 켜지도록"*). */
  const openNow = useCallback(
    (id: string) => {
      cancelClose();
      setOpenId(id);
    },
    [cancelClose, setOpenId],
  );

  /**
   * hover 이탈 — `HOVER_CLOSE_MS` 뒤에 닫는다.
   *
   * ★ 이미 걸린 타이머를 먼저 지운다. 안 그러면 빠르게 들락거릴 때 타이머가 쌓이고,
   *   그중 가장 오래된 것이 "이미 다시 열린" 메뉴를 닫는다.
   */
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenId(null);
    }, HOVER_CLOSE_MS);
  }, [cancelClose, setOpenId]);

  // 화면을 떠날 때 타이머가 살아 있으면 사라진 컴포넌트에 setState 한다.
  useEffect(() => cancelClose, [cancelClose]);

  return { openId, setOpenId, openNow, closeSoon, cancelClose, pathname };
}

/**
 * 이 기기에 **진짜 hover 가 있는가.**
 *
 * 터치 화면은 탭을 hover 로 흉내 내는 경우가 있어, hover 로 열면 탭 한 번에 열렸다가
 * 곧바로 클릭 토글로 닫히는 일이 생긴다. `(hover: hover)` 는 그 둘을 가르는 표준
 * 미디어 쿼리이고, 태블릿처럼 폭은 넓은데 손가락으로 만지는 기기가 정확히 여기 걸린다.
 *
 * ★ 서버 스냅샷은 `false` 다. hover 가 없다고 가정해도 **보이는 것이 달라지지 않으므로**
 *   (핸들러가 붙고 말고의 차이) 하이드레이션 불일치가 생기지 않는다.
 * ★ `useSyncExternalStore` 는 이 저장소가 테마·주 시작 요일에서 이미 쓰는 패턴이다 —
 *   새 패턴을 만들지 않는다.
 */
let hoverQuery: MediaQueryList | null = null;

/**
 * `MediaQueryList` 는 한 번만 만든다.
 *
 * `getSnapshot` 은 **렌더마다** 불리므로 거기서 `matchMedia()` 를 새로 부르면 렌더 횟수만큼
 * 객체가 생긴다. 값은 boolean 이라 React 의 비교에는 문제가 없지만 만들 이유도 없다.
 * 모듈 레벨이어도 안전한 이유: 브라우저 전역의 성질을 읽을 뿐 사용자별 상태가 아니다
 * (§2.4 Rule 2 가 금지하는 것은 **서버**의 모듈 레벨 캐시다).
 */
function getHoverQuery(): MediaQueryList {
  hoverQuery ??= window.matchMedia("(hover: hover)");
  return hoverQuery;
}

function useHasHover(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = getHoverQuery();
      query.addEventListener("change", onChange);
      return () => {
        query.removeEventListener("change", onChange);
      };
    },
    () => getHoverQuery().matches,
    () => false,
  );
}

/**
 * 바깥을 누르면 닫는다.
 *
 * `pointerdown` 을 쓰는 이유: `click` 은 링크의 기본 동작과 같은 프레임에 도착해서,
 * 메뉴 안 링크를 눌렀을 때 "닫기"가 먼저 실행되며 이동이 취소되는 경합이 생긴다.
 * `pointerdown` 은 그보다 앞서 오고, 컨테이너 안쪽이면 아무 일도 하지 않는다.
 */
function useDismissOnOutside(
  ref: React.RefObject<HTMLElement | null>,
  isOpen: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current;
      if (node !== null && event.target instanceof Node && node.contains(event.target)) {
        return;
      }
      close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [ref, isOpen, close]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 무리 안의 링크 한 줄 — 데스크톱 드롭다운과 모바일 시트가 **함께 쓴다**
// ─────────────────────────────────────────────────────────────────────────────

function NavMenuItem({
  route,
  pathname,
}: {
  readonly route: NavRoute;
  readonly pathname: string;
}) {
  const Icon = route.icon;
  const active = isNavRouteActive(route.href, pathname);

  return (
    <Link
      href={route.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-3 py-2 transition duration-200",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        active
          ? "bg-primary-subtle text-primary"
          : "text-ink-label hover:bg-hover-strong hover:text-ink",
      )}
    >
      <Icon aria-hidden size={16} className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className={cn("text-body-sm", active ? "font-bold" : "font-medium")}>
          {route.label}
        </span>
        {/*
          설명줄은 `text-caption`(12px)이다. §4 의 14px 하한은 **문장**에 대한 규칙이고
          이것은 항목에 붙는 라벨이다. 색은 `ink-muted` 이상만 쓴다(플레이스홀더 톤 금지).
        */}
        <span className="text-caption text-ink-muted">{route.hint}</span>
      </span>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 데스크톱 — 상단 바 안쪽의 드롭다운 둘
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `h-control-md`(38px) 는 상단 바에서 터치로도 눌리는 최소치다. 태블릿(md~lg)도
 * 손가락으로 만지므로 30px 짜리 칩 높이를 그대로 쓰지 않았다.
 */
const TRIGGER_BASE = cn(
  "inline-flex h-control-md shrink-0 items-center gap-1.5 rounded-md px-3",
  "text-body-sm whitespace-nowrap transition duration-200",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
);

function DesktopGroup({
  group,
  pathname,
  isOpen,
  onToggle,
  hoverProps,
}: {
  readonly group: VisibleGroup;
  readonly pathname: string;
  readonly isOpen: boolean;
  readonly onToggle: (next: boolean) => void;
  /**
   * hover 로 열고 닫는 핸들러. **hover 가 없는 기기에서는 빈 객체**이며, 그때 이 메뉴는
   * 예전처럼 클릭으로만 동작한다(`useHasHover` 주석).
   */
  readonly hoverProps: {
    readonly onMouseEnter?: () => void;
    readonly onMouseLeave?: () => void;
  };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const Icon = group.icon;

  const hasActive = group.routes.some((route) =>
    isNavRouteActive(route.href, pathname),
  );

  useDismissOnOutside(containerRef, isOpen, () => {
    onToggle(false);
  });

  return (
    <div
      ref={containerRef}
      className="relative"
      {...hoverProps}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !isOpen) return;
        onToggle(false);
        // 포커스를 버튼으로 되돌린다. 안 그러면 키보드 사용자가 문서 처음으로 튄다.
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-haspopup="menu"
        onClick={() => {
          onToggle(!isOpen);
        }}
        className={cn(
          TRIGGER_BASE,
          hasActive
            ? "bg-primary-subtle font-bold text-primary"
            : "font-medium text-ink-label hover:bg-hover-strong hover:text-ink",
        )}
      >
        <Icon aria-hidden size={16} />
        {group.label}
        <ChevronDown
          aria-hidden
          size={14}
          className={cn("transition duration-200", isOpen ? "rotate-180" : null)}
        />
      </button>

      {isOpen ? (
        /*
          ★ 바깥 껍데기가 `pt-1` 을 갖는다. 예전에는 메뉴 자체가 `mt-1` 로 4px 떨어져
            있었는데, hover 로 여닫게 되면서 그 **4px 이 죽은 구간**이 됐다 — 트리거에서
            메뉴로 내려가는 길에 잠깐 둘 다에서 벗어나 닫기 타이머가 걸린다. 1초 유예가
            있어 실제로 닫히지는 않지만, 껍데기가 여백까지 덮으면 그런 일이 아예 없다.
            보이는 간격은 그대로다(패딩이 여백 노릇을 한다).
        */
        <div className="absolute left-0 top-full z-50 pt-1">
          <div
            id={menuId}
            role="menu"
            aria-label={group.label}
            className={cn(
              "flex w-64 flex-col gap-0.5 p-1.5",
              "rounded-lg border border-border bg-surface shadow-lg",
            )}
          >
            {group.routes.map((route) => (
              <NavMenuItem key={route.href} route={route} pathname={pathname} />
            ))}
          </div>
        </div>
      ) : (
        /* 닫혀 있어도 `aria-controls` 대상이 존재해야 보조기기가 관계를 읽는다. */
        <div id={menuId} hidden />
      )}
    </div>
  );
}

export interface PrimaryNavProps {
  readonly className?: string;
}

/**
 * 데스크톱 내비게이션. 상단 바의 브랜드 옆에 붙는다.
 *
 * hover 로 열고 1초 뒤 닫는다(파일 머리말). 무리 사이를 옮겨 갈 때는 **새 무리를 바로
 * 열면서 예전 타이머를 지운다** — `openNow` 가 그 둘을 함께 하므로, 옮기는 도중에
 * 앞서 걸린 타이머가 새로 연 메뉴를 닫는 일이 없다.
 */
export function PrimaryNav({ className }: PrimaryNavProps) {
  const { openId, setOpenId, openNow, closeSoon, cancelClose, pathname } =
    useMenuState();
  const groups = useVisibleGroups();
  const hasHover = useHasHover();

  return (
    <nav
      aria-label="주요 메뉴"
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      {groups.map((group) => (
        <DesktopGroup
          key={group.id}
          group={group}
          pathname={pathname}
          isOpen={openId === group.id}
          onToggle={(next) => {
            // 클릭으로 상태를 정했으면 걸려 있던 닫기 예약은 무의미하다.
            cancelClose();
            setOpenId(next ? group.id : null);
          }}
          hoverProps={
            hasHover
              ? {
                  onMouseEnter: () => {
                    openNow(group.id);
                  },
                  onMouseLeave: closeSoon,
                }
              : {}
          }
        />
      ))}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 모바일 — 하단 탭 둘 + 위로 열리는 시트
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 탭 하나.
 *
 * `min-h-nav-mobile`(56px)이 터치 목표를 책임진다 — 44×44 를 넘긴다. 이제 칸이 둘뿐이라
 * 360px 폰에서도 한 칸이 180px 이고, 라벨이 잘릴 여지가 없다.
 * 라벨은 `text-caption`(12px)이다 — 아이콘과 짝지어 한 단어로 읽히는 탭 라벨이며,
 * §4 의 14px 하한은 문장에 대한 규칙이다. 색은 `ink-muted` 이상만 쓴다.
 */
const MOBILE_ITEM_BASE = cn(
  "relative flex min-h-nav-mobile w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5",
  "text-caption transition duration-200",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
);

/**
 * 모바일 하단 탭 바. `md`(768px) 미만에서만 뜬다.
 *
 * 탭을 누르면 그 무리의 화면 목록이 **바 위로** 펼쳐진다. 데스크톱 드롭다운과 같은
 * 항목·같은 컴포넌트(`NavMenuItem`)를 쓰므로 두 벌이 갈라질 수 없다.
 *
 * ⚠️ 본문 하단 여백은 `layout.tsx` 의 `<body>` 가 잡는다 — 이 바가 `fixed` 라
 *    문서 흐름에서 빠져 있어서, 여백이 없으면 마지막 요소가 바 밑에 가린다.
 *    바와 여백은 **같은 토큰**(`--spacing-nav-mobile`)을 쓴다.
 * ⚠️ `pb-[env(safe-area-inset-bottom)]` 은 아이폰 홈 인디케이터 영역이다.
 *    없는 기기에서는 0 이므로 항상 붙여 둬도 손해가 없다.
 */
export function MobileTabBar() {
  const { openId, setOpenId, pathname } = useMenuState();
  const groups = useVisibleGroups();
  const containerRef = useRef<HTMLElement>(null);

  useDismissOnOutside(containerRef, openId !== null, () => {
    setOpenId(null);
  });

  const open = groups.find((group) => group.id === openId) ?? null;

  return (
    <nav
      ref={containerRef}
      aria-label="주요 메뉴"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 md:hidden",
        "border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpenId(null);
      }}
    >
      {/* 펼쳐진 목록. 바 **위쪽**으로 자라므로 엄지 이동 거리가 짧다. */}
      {open !== null ? (
        <div
          role="menu"
          aria-label={open.label}
          className="mx-auto flex w-full max-w-[92rem] flex-col gap-0.5 border-b border-border p-1.5"
        >
          {open.routes.map((route) => (
            <NavMenuItem key={route.href} route={route} pathname={pathname} />
          ))}
        </div>
      ) : null}

      <ul className="mx-auto flex w-full max-w-[92rem] items-stretch">
        {groups.map((group) => {
          const Icon = group.icon;
          const hasActive = group.routes.some((route) =>
            isNavRouteActive(route.href, pathname),
          );
          const isOpen = openId === group.id;

          return (
            <li key={group.id} className="min-w-0 flex-1">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setOpenId(isOpen ? null : group.id);
                }}
                className={cn(
                  MOBILE_ITEM_BASE,
                  hasActive
                    ? "font-bold text-primary"
                    : /*
                       * 비활성 탭의 hover — 데스크톱 폭을 줄이면 그대로 보이고, 무엇보다
                       * focus 이동 시 반응이 필요하다. 배경 + 글자색 두 채널로 바꾼다.
                       * (`ink-muted` 는 `hover-strong` 위에서 3.88:1 이라 AA 미달 —
                       *  그래서 hover 시 `ink` 로 함께 올린다. 라이트 14.23:1 / 다크 12.06:1)
                       */
                      "font-medium text-ink-muted hover:bg-hover-strong hover:text-ink",
                )}
              >
                {/* 활성 인디케이터 — 색 말고 **면**으로도 말하는 채널. */}
                {hasActive ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary"
                  />
                ) : null}
                <Icon aria-hidden size={20} />
                <span className="flex max-w-full items-center gap-0.5 truncate">
                  {group.label}
                  <ChevronDown
                    aria-hidden
                    size={12}
                    className={cn(
                      "transition duration-200",
                      isOpen ? "rotate-180" : null,
                    )}
                  />
                </span>
              </button>
            </li>
          );
        })}

        {/* 세션을 몰라도 무리는 항상 둘이라 자리표시자가 필요 없다(머리말). */}
        {groups.length === 0 ? (
          <li className="min-w-0 flex-1" aria-hidden>
            <div className="flex min-h-nav-mobile items-center justify-center px-1 py-1.5">
              <Skeleton shape="text" className="h-4 w-16" />
            </div>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
