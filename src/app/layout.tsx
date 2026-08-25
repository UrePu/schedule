import { Analytics } from "@vercel/analytics/next";
import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { Source_Code_Pro } from "next/font/google";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";

import { MobileTabBar, PrimaryNav } from "@/components/layout";
import { ThemeToggle } from "@/components/ui";
import { QuickDropButton } from "@/features/income/components";
import { loadCurrentUser } from "@/features/auth/server/current-user";
import type { MeResponse } from "@/features/auth/types";
import { dehydrateQueries } from "@/lib/query/server-cache";
import { queryKeys } from "@/lib/query-keys";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 폰트 — 왜 Pretendard 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이력: Outfit + Inter(한글 글리프 없음) → IBM Plex Sans KR → 메이플스토리체 →
 *       **Pretendard**(2026-08-20 발주자: *"UI가 너무 지저분해보여.. 글씨체
 *       Pretendard 써봐"*).
 *
 * CLAUDE.md §4 는 디자인 원문의 라틴 전용 서체 대신 **한글 지원 서체를 기본 UI 폰트로**
 * 삼도록 규정하고, 대체 사실을 폰트 모듈 주석이나 사이드 노트에 남기라고 요구한다
 * (원문 `pipelinepro-DESIGN.md` 는 건드리지 않는다). 이 주석이 그 기록이다.
 *
 * ★ 교체 근거는 취향이 아니라 **계측**이다. fontTools 로 두 서체를 직접 열어 비교했다.
 *
 *     항목            메이플스토리체   Pretendard(subset)
 *     --------------- --------------- ------------------
 *     GSUB 피처        0 개            45 개
 *     tnum(등폭 숫자)  없음            있음
 *     — (em dash)      글리프 없음     있음
 *     – (en dash)      글리프 없음     있음
 *     ₩                글리프 없음     있음
 *     한글 완성형      11,172 자       2,780 자
 *
 *   앞의 다섯 줄이 화면이 "지저분해" 보이던 실제 원인이다.
 *     · 코드베이스 전역의 `tabular-nums` 가 **아무 효과도 못 내고 있었다.** 등폭 숫자가
 *       없으니 메소 금액이 자릿수마다 폭이 달라 표에서 숫자가 흔들렸다.
 *     · 문구에 흔히 쓰는 `—`/`–` 가 그 자리에서만 폴백 폰트로 떨어져 한 문장에 서체가
 *       두 벌 섞였다.
 *   마지막 줄(한글 자수)만 메이플스토리체가 앞서는데, **실측으로 문제가 없다**:
 *   DB 의 캐릭터명·계정명·파티명·게스트명·보스명에 실제로 쓰인 서로 다른 글자 611 개가
 *   subset 판에 100% 들어 있다(누락 0). 근거·출처·sha256 은
 *   `src/app/fonts/LICENSE-Pretendard.txt`.
 *
 * ★ **헤드라인과 본문이 같은 패밀리다.** 제목만 다른 서체를 남기면 한국어 제목에서
 *   폰트가 갈린다. `--font-headline` 과 `--font-sans` 둘 다 이 변수를 가리킨다.
 *   Mono(`--font-mono`)만 Source Code Pro 로 남는다 — §4 가 코드·키·ID 용 mono 는
 *   그대로 두라고 규정한다.
 *
 * ─── 굵기: 실제 4벌을 그대로 쓴다
 * 메이플스토리체는 Light/Bold 두 벌뿐이라 굵기 **구간**을 선언해 합성 볼드를 막아야 했고,
 * 그 결과 600 과 700 이 같은 face 로 렌더됐다(타입 스케일은 둘을 구분하는데도). Pretendard
 * 는 400/500/600/700 을 각각 갖고 있어 **선언한 굵기가 그대로 나온다** — 구간 트릭도,
 * 합성 볼드도 필요 없다.
 *
 * `preload: false` 를 유지한다. 4벌 합계 약 1.05MB 라 모든 페이지 `<head>` 에서 최우선으로
 * 받게 하면 JS/CSS 와 대역을 다툰다. `display: "swap"` + next/font 의 폴백 메트릭 보정으로
 * 흔들림을 줄이는 전략은 그대로다.
 *
 * ⚠️ 되돌리려면: 아래 `pretendard` 를 지우고 `maplestory` 를 되살린 뒤(파일은 이 폴더에
 *    그대로 있다) `globals.css` 의 `--font-headline`/`--font-sans` 를 되돌리면 된다.
 */
const pretendard = localFont({
  variable: "--font-pretendard",
  src: [
    { path: "./fonts/Pretendard-Regular.subset.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Pretendard-Medium.subset.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Pretendard-SemiBold.subset.woff2", weight: "600", style: "normal" },
    { path: "./fonts/Pretendard-Bold.subset.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  preload: false,
  /*
    폴백 체인에 **한글 시스템 폰트**를 넣는다. subset 에 없는 희귀 음절(예: 뷁)이 닉네임에
    들어오면 그 글자만 여기로 떨어지는데, 라틴 기본값으로 두면 한글이 두부(□)가 된다.
  */
  fallback: [
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Malgun Gothic",
    "Apple SD Gothic Neo",
    "sans-serif",
  ],
});

/** Mono 는 그대로 — API 키·ocid·코드 표시에만 쓰고 한글이 들어가지 않는다. */
const sourceCodePro = Source_Code_Pro({
  variable: "--font-source-code-pro",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "M_Schedule — 메이플스토리 보스 파티 스케줄러",
    template: "%s | M_Schedule",
  },
  description:
    "메이플스토리 주간 보스 파티 일정을 겹쳐 보고, 결정석 수익을 자동으로 집계하는 스케줄러입니다.",
  applicationName: "M_Schedule",
  keywords: ["메이플스토리", "보스", "파티", "스케줄러", "결정석", "주간 숙제"],
};

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 세션은 **여기서 한 번만** 캐시에 심는다 — 탭을 옮겨도 다시 심지 않는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * App Router 는 형제 라우트 사이를 오갈 때 **공유 레이아웃을 다시 렌더하지 않는다.**
 * 그래서 문서 로드 1회에만 도는 자리가 정확히 여기다. 예전에는 `/` 만 세션을 심었고
 * `/schedule` `/boss-plans` `/income` 은 심지 않아, 상단 바(`PrimaryNav`)의
 * `useSessionQuery()` 가 화면마다 `GET /api/auth/me` 를 한 번씩 더 쐈다 —
 * 거의 아무 일도 하지 않는 그 요청이 **실측 0.30초**였다.
 *
 * ★ 심는 것은 **세션 하나뿐이다.** 체크리스트·파티·수익 같은 화면별 데이터는 각
 *   페이지에 남는다. 여기로 올리면 그 데이터를 쓰지 않는 화면(`/income`, `/invite/*`)
 *   까지 값을 치르게 되고, 그건 지금 고치려는 문제와 같은 종류의 낭비다.
 *
 * ⚠️ **비로그인 200 을 깨뜨리지 않는다** (DoD §0.3). `loadCurrentUser()` 는 쿠키가
 *    없으면 던지지 않고 null 을 준다. 레이아웃이 던지면 네 화면이 전부 죽는다.
 * ⚠️ **§2.4 Rule 2** — `dehydrateQueries()` 는 요청마다 새 QueryClient 를 만들고
 *    함수 밖으로 내보내지 않는다. 모듈 레벨 캐시를 여기에 만들면 한 사람의 세션이
 *    다음 방문자에게 나간다.
 */
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await loadCurrentUser();
  const sessionState = await dehydrateQueries((queryClient) => {
    // 비로그인도 **정상 상태**다 — `{ user: null }` 은 `/api/auth/me` 의 200 응답과 같다.
    queryClient.setQueryData<MeResponse>(queryKeys.db.auth.session(), { user });
  });

  return (
    <html
      lang="ko"
      /*
       * 아래 인라인 스크립트가 하이드레이션 전에 `data-theme` 를 바꾸므로
       * 서버 HTML 과 달라질 수 있다. 의도된 차이라 경고를 끈다.
       */
      suppressHydrationWarning
      className={`${pretendard.variable} ${sourceCodePro.variable} h-full antialiased`}
    >
      <head>
        {/*
          FOUC 방지: 첫 페인트 **전에** 테마를 확정한다.
          React 하이드레이션 뒤에 적용하면 라이트 화면이 한 번 번쩍인 뒤 다크로 바뀐다.
          저장값이 없으면 아무것도 하지 않고 CSS 의 prefers-color-scheme 에 맡긴다.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/*
        `pb-nav-mobile` — 모바일 하단 탭 바는 `fixed` 라 문서 흐름에서 빠져 있다.
        여백을 잡아 두지 않으면 페이지 **마지막 요소가 바 밑에 영구히 가린다.**
        높이는 바와 같은 토큰(`--spacing-nav-mobile`)에서 오고, 아이폰 홈 인디케이터
        만큼(`env(safe-area-inset-bottom)`)을 더한다. 바가 사라지는 `md` 이상에서는 0.
      */}
      <body className="flex min-h-full flex-col bg-background pb-[calc(var(--spacing-nav-mobile)+env(safe-area-inset-bottom,0px))] text-ink md:pb-0">
        <Providers>
          {/*
            ─────────────────────────────────────────────────────────────────
            상단 바 = 브랜드 + **화면 이동** + 테마 토글
            ─────────────────────────────────────────────────────────────────
            예전에는 브랜드와 테마 토글뿐이라 `/schedule` `/income` `/boss-plans` 로
            가려면 주소를 직접 쳐야 했다. 이제 데스크톱(md 이상)은 이 바가 이동을
            맡고, 그 아래에서는 화면 하단의 탭 바(`MobileTabBar`)가 맡는다.
            경로 목록은 `components/layout/nav-routes.ts` 한 곳에만 있다 —
            `/showcase` 는 개발용 경로라 거기에 들어 있지 않다.

            ─────────────────────────────────────────────────────────────────
            상단 바가 좁은 화면에서 넘치지 않는 이유 (구조로 보장한다)
            ─────────────────────────────────────────────────────────────────
            이전에는 `justify-between` 안에 브랜드와 토글만 넣어 두었다. 토글의 칩은
            `shrink-0 whitespace-nowrap` 이라 줄지 않는데 브랜드도 줄지 않아서, 폭이
            모자라면 **행 전체가 뷰포트를 넘어** 오른쪽 끝의 `다크` 가 잘렸다.

            고친 방법은 두 가지다.
            1. **양보하는 쪽을 정했다.** 브랜드에 `min-w-0 truncate` 를 줘서, 모자라면
               브랜드가 줄임표로 접힌다. 넘치는 축(가로)에 줄어들 수 있는 요소가 하나라도
               있으면 행은 절대 뷰포트를 넘지 않는다. 내비게이션 항목은 `shrink-0` 이라
               `대시…` 로 뭉개지지 않는다 — 양보는 브랜드 한 곳에서만 일어난다.
            2. **라벨 토글의 등장 시점을 `md`(768px) → `lg`(1024px) 로 한 번 더 올렸다.**
               라벨형은 `시스템·라이트·다크` 3개라 ~230px 를 먹는다. 768px 에서
               브랜드(~110px)+내비(~355px)+여백을 더하면 남는 자리가 거의 없어,
               브랜드가 곧바로 줄임표가 됐다. 1024px 부터 켜면 항상 넉넉하다.
               그 아래는 아이콘만 있는 compact 형이라 ~90px 로 360px 폭에서도 남는다.

            토글 묶음에는 `shrink-0` 을 명시했다 — 칩이 안 줄어드는데 컨테이너만 줄면
            내부가 밖으로 삐져나오는(overflow) 모양이 되기 때문이다.
          */}
          <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
            <div className="mx-auto flex w-full max-w-[92rem] items-center justify-between gap-3 px-4 py-2 md:px-6">
              <div className="flex min-w-0 items-center gap-2 md:gap-4">
                <Link
                  href="/"
                  className="min-w-0 truncate font-headline text-body font-bold text-ink"
                >
                  M_Schedule
                </Link>
                <PrimaryNav className="hidden md:flex" />
              </div>
              {/*
                드랍 기록(카톡 `!드랍` 의 웹 판). 상단 바에 둔 이유는
                `quick-drop-button.tsx` 머리말에 있다 — 보스를 돌고 나온 직후에 적는
                일이라 어느 화면에 있든 손이 닿아야 한다. 비로그인에는 그려지지 않는다.
              */}
              <div className="flex shrink-0 items-center gap-2">
                <QuickDropButton />
                <ThemeToggle className="hidden lg:flex" />
                <ThemeToggle className="flex lg:hidden" compact />
              </div>
            </div>
          </header>
          <HydrationBoundary state={sessionState}>{children}</HydrationBoundary>
          <MobileTabBar />
          {/*
            Vercel Web Analytics (2026-08-25 발주 지시).
            방문자수·페이지뷰만 센다. 쿠키를 쓰지 않고 개인을 식별하지 않으므로 동의
            배너가 필요 없다 — 우리가 심는 것은 이 한 줄뿐이고 넘기는 값도 없다.

            ★ **`Providers` 안, 탭 바 뒤에 둔다.** 어느 자리든 스크립트 하나를 넣는 일이라
              그리는 것에는 영향이 없고, 화면 요소가 아니므로 본문 맨 끝이 읽기 좋다.
            ★ 로컬(`pnpm dev`·`pnpm start`)에서는 스크립트가 Vercel 배포본에서만 응답하는
              `/_vercel/insights/*` 를 가리켜 **404 가 난다. 정상이다** — 계측은 배포된
              도메인에서만 켜진다.
          */}
          <Analytics />
        </Providers>
      </body>
    </html>
  );
}
