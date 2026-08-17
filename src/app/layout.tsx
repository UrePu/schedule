import type { Metadata } from "next";
import { IBM_Plex_Sans_KR, Source_Code_Pro } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";

import { ThemeToggle } from "@/components/ui";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 폰트 — 왜 IBM Plex Sans KR 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이전에는 Outfit(제목) + Inter(본문)를 썼는데 **둘 다 한글 글리프가 없다.**
 * 화면의 거의 전부가 한국어인 앱에서 모든 한글이 OS 기본 폰트(맑은 고딕 / Apple SD
 * Gothic)로 떨어지고 있었다. 그래서 (1) 머신마다 다르게 보이고 (2) 한 줄에 한글과
 * 영문이 섞이면 **서로 다른 두 폰트가 이어 붙어** 자소 크기·굵기·베이스라인이 어긋났다.
 * 이 앱은 `카오스 칼로스 · Lv.295 · 21:00` 같은 줄이 계속 나오므로 치명적이다.
 *
 * 고른 이유:
 * - **라틴과 한글이 함께 설계된 패밀리**다. Plex Sans 의 라틴 골격을 그대로 두고
 *   한글을 맞춰 그려서, 섞인 줄에서 크기·무게가 튀지 않는다. 이게 1순위 기준이었다.
 * - `next/font/google` 로 **self-host** 된다. 런타임에 외부 폰트 CDN 을 때리지 않는다
 *   (woff2 를 저장소에 벤더링할 필요도 없다).
 * - 400/500/600/700 네 굵기가 있어 디자인 문서의 무게 단계를 그대로 쓴다.
 * - 숫자가 등폭이라 `tabular-nums` 로 표·금액·시각을 정렬할 수 있다.
 *
 * Noto Sans KR 은 가장 안전하지만 개성이 약하고, Pretendard 는 가장 좋지만
 * Google Fonts 에 없어 woff2 벤더링이 필요해 저장소가 무거워진다.
 *
 * `preload: false` 인 이유: 한글 폰트는 unicode-range 로 수백 개 조각으로 쪼개져
 * 배포된다. preload 를 켜면 그 조각들에 대한 `<link rel=preload>` 가 쏟아져
 * 오히려 초기 로딩을 방해한다. 대신 `display: "swap"` + next/font 의 자동
 * 폴백 크기 보정으로 레이아웃 흔들림을 줄인다.
 *
 * ★ **헤드라인과 본문이 같은 패밀리다.** 제목만 라틴 전용 폰트를 남기면
 *   한국어 제목에서 폰트가 갈리므로 Outfit 은 제거했다.
 */
const plexKr = IBM_Plex_Sans_KR({
  variable: "--font-plex-kr",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
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
      className={`${plexKr.variable} ${sourceCodePro.variable} h-full antialiased`}
    >
      <head>
        {/*
          FOUC 방지: 첫 페인트 **전에** 테마를 확정한다.
          React 하이드레이션 뒤에 적용하면 라이트 화면이 한 번 번쩍인 뒤 다크로 바뀐다.
          저장값이 없으면 아무것도 하지 않고 CSS 의 prefers-color-scheme 에 맡긴다.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background text-ink">
        <Providers>
          {/*
            모든 화면(`/`, `/schedule`, `/showcase`)에서 테마를 바꿀 수 있어야 하므로
            레이아웃에 얇은 상단 바를 둔다. 브랜드 링크는 홈으로만 간다 —
            `/showcase` 는 개발용 경로라 제품 내비게이션에 넣지 않는다.
          */}
          {/*
            ─────────────────────────────────────────────────────────────────
            상단 바가 좁은 화면에서 넘치지 않는 이유 (구조로 보장한다)
            ─────────────────────────────────────────────────────────────────
            이전에는 `justify-between` 안에 브랜드와 토글만 넣어 두었다. 토글의 칩은
            `shrink-0 whitespace-nowrap` 이라 줄지 않는데 브랜드도 줄지 않아서, 폭이
            모자라면 **행 전체가 뷰포트를 넘어** 오른쪽 끝의 `다크` 가 잘렸다.

            고친 방법은 두 가지다.
            1. **양보하는 쪽을 정했다.** 브랜드에 `min-w-0 truncate` 를 줘서, 모자라면
               브랜드가 줄임표로 접힌다. 넘치는 축(가로)에 줄어들 수 있는 요소가 하나라도
               있으면 행은 절대 뷰포트를 넘지 않는다.
            2. **라벨 토글의 등장 시점을 `sm`(640px) → `md`(768px) 로 올렸다.**
               라벨형은 `시스템·라이트·다크` 3개라 ~230px 를 먹는데, 640px 에서는
               브랜드까지 얹으면 여유가 거의 없다. 768px 부터 켜면 항상 넉넉하다.
               그 아래는 아이콘만 있는 compact 형이라 ~90px 로 360px 폭에서도 남는다.

            토글 묶음에는 `shrink-0` 을 명시했다 — 칩이 안 줄어드는데 컨테이너만 줄면
            내부가 밖으로 삐져나오는(overflow) 모양이 되기 때문이다.
          */}
          <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
            <div className="mx-auto flex w-full max-w-[92rem] items-center justify-between gap-3 px-4 py-2 md:px-6">
              <Link
                href="/"
                className="min-w-0 truncate font-headline text-body font-bold text-ink"
              >
                M_Schedule
              </Link>
              <ThemeToggle className="hidden shrink-0 md:flex" />
              <ThemeToggle className="flex shrink-0 md:hidden" compact />
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
