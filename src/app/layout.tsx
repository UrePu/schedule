import type { Metadata } from "next";
import { Source_Code_Pro } from "next/font/google";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";

import { MobileTabBar, PrimaryNav } from "@/components/layout";
import { ThemeToggle } from "@/components/ui";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 폰트 — 왜 메이플스토리체인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이력: Outfit + Inter(한글 글리프 없음) → IBM Plex Sans KR → **메이플스토리체**.
 *
 * 발주 요구가 "메이플스토리체 적용"이었고, CLAUDE.md §4 는 이미 디자인 원문의
 * 라틴 전용 서체(Outfit/Inter) 대신 **한글 지원 서체를 기본 UI 폰트로** 삼도록
 * 규정한다. 메이플스토리체는 그 규정에 맞고 제품 주제와도 맞는다.
 *
 * ★ **헤드라인과 본문이 같은 패밀리다.** 제목만 다른 서체를 남기면 한국어 제목에서
 *   폰트가 갈린다. `--font-headline` 과 `--font-sans` 둘 다 이 변수를 가리킨다.
 *   Mono(`--font-mono`)만 Source Code Pro 로 남는다 — §4 가 코드·키·ID 용
 *   mono 는 그대로 두라고 규정한다.
 *
 * 이 서체는 Google Fonts 에 없다 → `next/font/google` 불가 → **woff2 벤더링**.
 * 넥슨 배포 페이지(https://maplestory.nexon.com/Media/Font)의 공식 OTF 를 받아
 * 컨테이너만 woff2 로 재압축했다(서브셋 없음). 출처·라이선스 원문·원본 sha256 은
 * `src/app/fonts/LICENSE-Maplestory.txt`, 결정 근거 전체는 `Claude/FONT-NOTES.md`.
 * 여기 적힌 URL 은 **주석일 뿐**이고, 런타임에는 외부 폰트 CDN 을 때리지 않는다.
 *
 * ─── 굵기 매핑: 실제 2단(Light 300 / Bold 700) → 타입 스케일 4단(400/500/600/700)
 * 메이플스토리체는 Light 와 Bold 두 벌뿐이다. 각 face 를 300/700 한 값으로만
 * 선언하면 500·600 은 브라우저 매칭에 맡겨지고, 조금만 어긋나도 **합성 볼드**(가짜
 * 굵게)가 끼어들어 작은 글자가 뭉갠다. 그래서 face 마다 **굵기 구간**을 준다.
 *   Light → `300 500`   Bold → `600 900`
 * 이러면 300~900 어떤 값이 와도 실제 face 가 하나 잡히므로 합성이 원천적으로 없다.
 * 경계를 500|600 에 둔 이유: 타입 스케일에서 500 은 `label`·`caption`(본문처럼
 * 읽혀야 하는 것), 600 은 `subhead` 와 코드베이스 전역의 `font-semibold`(강조로
 * 읽혀야 하는 것)다. 그 사이가 "본문 : 강조"의 실제 경계다.
 * (정적 폰트에 굵기 구간을 선언하는 것은 CSS 스펙상 유효하며, next/font 는 값을
 *  `@font-face { font-weight: ... }` 에 그대로 써 준다.)
 *
 * `preload: false` 를 유지한 이유는 **바뀌었다**. 예전에는 구글 한글 폰트가
 * unicode-range 로 수백 조각이라 preload 링크가 쏟아지는 게 문제였다. 지금은
 * 조각이 2개뿐이지만 합계 약 468KB 라, 모든 페이지 `<head>` 에서 최우선순위로
 * 받게 하면 JS/CSS 와 대역을 다툰다. `display: "swap"` + next/font 의 자동 폴백
 * 메트릭 보정(Arial 기준 size-adjust ≈ 112.5%)으로 흔들림을 줄이는 전략은 그대로다.
 *
 * ⚠️ 알려진 손실 — 자세한 계측은 `Claude/FONT-NOTES.md`:
 *  - 숫자가 **등폭이 아니고** `tnum` 피처도 없다(GSUB 자체가 비어 있다).
 *    코드 전역의 `tabular-nums` 는 이 폰트에서 아무 효과가 없다.
 *  - `—`(em dash) `–`(en dash) 글리프가 없어 그 자리만 폴백 폰트로 떨어진다.
 */
const maplestory = localFont({
  variable: "--font-maplestory",
  src: [
    { path: "./fonts/Maplestory-Light.woff2", weight: "300 500", style: "normal" },
    { path: "./fonts/Maplestory-Bold.woff2", weight: "600 900", style: "normal" },
  ],
  display: "swap",
  preload: false,
  // 폰트를 못 받아도 화면이 비지 않도록 체인을 명시한다.
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ko"
      /*
       * 아래 인라인 스크립트가 하이드레이션 전에 `data-theme` 를 바꾸므로
       * 서버 HTML 과 달라질 수 있다. 의도된 차이라 경고를 끈다.
       */
      suppressHydrationWarning
      className={`${maplestory.variable} ${sourceCodePro.variable} h-full antialiased`}
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
              <ThemeToggle className="hidden shrink-0 lg:flex" />
              <ThemeToggle className="flex shrink-0 lg:hidden" compact />
            </div>
          </header>
          {children}
          <MobileTabBar />
        </Providers>
      </body>
    </html>
  );
}
