import {
  BookOpen,
  CalendarPlus,
  CalendarRange,
  CheckSquare,
  Coins,
  Ellipsis,
  Gauge,
  ListChecks,
  Settings2,
  Sliders,
  Swords,
  Users,
} from "lucide-react";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 화면 이동의 **유일한 목록** — 세 무리로 접힌다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 데스크톱 상단 바와 모바일 하단 탭이 같은 배열을 읽는다. 두 벌로 두면 한쪽에만
 * 경로가 추가되는 사고가 반드시 난다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 평평한 목록에서 **현황 / 관리** 두 무리로 바뀌었나
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-08-20): *"대시보드를 삭제하고"* + 아래 구조를 그대로 지정했다.
 *
 *     현황  ├ 이번주 일정  ├ 계정 보스 현황  ├ 결정석 수익  └ 기타 숙제
 *     관리  ├ 일정 추가    ├ 캐릭별 보스 관리 └ 친구
 *     기타  ├ 가이드       └ 설정                        ← 2026-08-20 추가
 *
 * 가르는 축은 **"보러 오는가 / 고치러 오는가"** 하나다. 현황은 읽기만 하고 매일 열며,
 * 관리는 쓰기를 하고 어쩌다 한 번 연다. 이 축을 잡으면 어떤 화면을 어디에 둘지
 * 다투지 않아도 된다 — `/income` 은 읽기라 현황, `/friends` 는 명단을 고치므로 관리다.
 *
 * 항목이 4 → 9 로 늘었으므로 평평한 한 줄은 더 이상 성립하지 않는다. 접는 방식을
 * 무리 단위로 고른 이유는, 사람이 "수익 보러 왔다"를 먼저 정하고 그다음 화면을 고르기
 * 때문이다. 아홉 개를 알파벳순으로 늘어놓는 것보다 두 번 고르는 쪽이 빠르다.
 *
 * ★ 대시보드(`/`)가 **시간표로 바뀌었다.** 경로는 그대로이므로 북마크·공유 링크가
 *   살아 있고, 비로그인은 여전히 랜딩을 본다.
 * ★ `/showcase` 는 **넣지 않는다.** 개발용 컴포넌트 갤러리이며 제품 내비게이션에
 *   노출할 화면이 아니다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `requiresAuth` 가 하는 일
 * ─────────────────────────────────────────────────────────────────────────────
 * 대부분의 화면은 서버가 세션을 보고 "로그인이 필요합니다" 카드를 그린다. 즉
 * **비로그인 사용자에게는 눌러도 아무것도 없는 링크**다. 닿을 수 없는 곳을 띄워 두고
 * 눌렀을 때 막는 것은 나쁜 동선이라, 세션이 없으면 이 항목을 **아예 그리지 않는다.**
 * (막는 쪽은 그대로 살아 있다 — 주소를 직접 쳐도 페이지가 안내를 그린다.)
 *
 * 무리 전체가 비면 그 무리도 그리지 않는다. 눌러 봤자 빈 목록이 나오는 버튼은
 * 없느니만 못하다.
 */
export interface NavRoute {
  readonly href: string;
  readonly label: string;
  /** lucide 아이콘. 현재 위치 표시의 **두 번째 채널**이자 좁은 목록의 주 식별자다. */
  readonly icon: typeof Coins;
  /** 로그인해야 내용이 있는 화면인가. */
  readonly requiresAuth: boolean;
  /** 드롭다운 안에서 항목 밑에 한 줄로 붙는 설명. 무엇을 보러 가는지 말한다. */
  readonly hint: string;
}

export interface NavGroup {
  /** 무리 식별자. 열림 상태를 추적하는 키로도 쓴다. */
  readonly id: "status" | "manage" | "misc";
  readonly label: string;
  readonly icon: typeof Coins;
  readonly routes: readonly NavRoute[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "status",
    label: "현황",
    icon: Gauge,
    routes: [
      /*
       * 발주자가 첫 자리로 지정한 화면. *"정말 나 언제 어디로 보스가야하지? 를 주력으로"*
       * — 앱을 여는 이유 그 자체라 `/` 를 그대로 쓴다.
       */
      {
        href: "/",
        label: "이번주 일정",
        icon: CalendarRange,
        requiresAuth: false,
        hint: "내가 가는 보스만 시간표로",
      },
      {
        href: "/boss-status",
        label: "계정 보스 현황",
        icon: ListChecks,
        requiresAuth: true,
        hint: "캐릭터별 보스 12칸 진행",
      },
      {
        href: "/income",
        label: "결정석 수익",
        icon: Coins,
        requiresAuth: true,
        hint: "이번 주 수익과 주차별 내역",
      },
      {
        href: "/chores",
        label: "기타 숙제",
        icon: CheckSquare,
        requiresAuth: true,
        hint: "보스 말고 남은 주간 숙제",
      },
    ],
  },
  {
    id: "manage",
    label: "관리",
    icon: Settings2,
    routes: [
      {
        href: "/schedule",
        label: "일정 추가",
        icon: CalendarPlus,
        requiresAuth: false,
        hint: "가능 시간 겹쳐 보고 일정 잡기",
      },
      {
        href: "/boss-plans",
        label: "캐릭별 보스 관리",
        icon: Swords,
        requiresAuth: true,
        hint: "매주 가는 보스를 캐릭터마다",
      },
      {
        href: "/friends",
        label: "친구",
        icon: Users,
        requiresAuth: true,
        hint: "친구 추가와 파티 초대",
      },
    ],
  },
  /*
   * 기타 (발주 지시 2026-08-20: *"현황 관리 옆에 기타 하나 넣고 거기다 가이드 넣어줘"*).
   *
   * ★ **`/etc` 를 관리에서 여기로 옮겼다** — 발주 지시에 없는 판단이라 근거를 적어 둔다.
   *   새 무리의 이름이 `기타` 인데 관리 안에도 `기타`(`/etc`)가 있으면 같은 낱말이 서로
   *   다른 두 곳을 가리킨다. 그리고 둘은 실제로 성질이 같다 — 가이드도 계정 설정도
   *   **처음 한 번 하고 마는 일**이고, 가이드의 1·2번이 곧바로 그 설정 화면을 가리킨다.
   *   그래서 옮기면서 라벨만 `설정` 으로 바꿨다. **경로(`/etc`)는 그대로**라 북마크와
   *   기존 링크가 살아 있다.
   *
   * ★ 가이드가 첫 항목인 이유: 이 무리를 여는 사람은 대개 **아직 아무것도 안 된** 사람이다.
   */
  {
    id: "misc",
    label: "기타",
    icon: Ellipsis,
    routes: [
      {
        href: "/guide",
        label: "가이드",
        icon: BookOpen,
        /*
          ★ **비로그인에게도 보인다.** 다른 항목과 달리 이 화면은 로그인이 1단계라,
            로그인해야 보이면 순서가 거꾸로다(`app/guide/page.tsx` 머리말).
        */
        requiresAuth: false,
        hint: "처음 설정을 1→5 순서대로",
      },
      {
        href: "/etc",
        label: "설정",
        icon: Sliders,
        requiresAuth: true,
        hint: "추적 캐릭터 · API 키 · 채팅방 · 내 파티",
      },
    ],
  },
];

/**
 * 평평한 전체 목록.
 *
 * 무리를 모르는 자리(경로 유효성 확인 등)를 위한 파생값이며, **이 배열에 직접 항목을
 * 더하지 말 것** — 정의처는 위의 `NAV_GROUPS` 하나다.
 */
export const NAV_ROUTES: readonly NavRoute[] = NAV_GROUPS.flatMap(
  (group) => group.routes,
);

/**
 * 현재 위치 판정.
 *
 * `/` 는 **정확히 일치할 때만** 활성이다. `startsWith` 로 처리하면 모든 경로가
 * 그 하위로 잡혀 항목 두 개가 동시에 켜진다.
 * 나머지는 하위 경로(`/schedule/xxx`)까지 같은 항목으로 본다.
 */
export function isNavRouteActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 지금 보고 있는 화면이 속한 무리. 어디에도 없으면 `null`(예: `/showcase`, `/invite/*`). */
export function findActiveNavGroup(pathname: string): NavGroup | null {
  return (
    NAV_GROUPS.find((group) =>
      group.routes.some((route) => isNavRouteActive(route.href, pathname)),
    ) ?? null
  );
}
