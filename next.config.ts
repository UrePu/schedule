import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 클라이언트 라우터 캐시 — `dynamic` 은 **0(Next 기본값)이다. 올리지 마라.**
   * ═══════════════════════════════════════════════════════════════════════════
   * 이력: 2026-08-18 에 `dynamic: 30` 으로 올렸다가 **같은 날 되돌렸다.** 되돌린 이유를
   * 여기 남긴다 — 성능 수치만 보고 다시 올리면 같은 사고가 재현되기 때문이다.
   *
   * ─── 이 옵션이 실제로 하는 일 (Next 16.3.1 기준, 코드로 확인) ───────────────
   * `experimental.staleTimes.dynamic` 은 빌드 시 `__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME`
   * 로 인라인되고(`dist/client/components/router-reducer/reducers/navigate-reducer.js`),
   * 방문했던 라우트의 **동적 RSC 페이로드**에 `staleAt = 방문시각 + 값` 을 찍어 BFCache 에
   * 넣는다(`dist/client/components/segment-cache/bfcache.js`). 그 뒤 같은 URL 로
   * **앞으로 가는 일반 내비게이션**(`<Link>`)이 일어나면 `staleAt` 이 남아 있는 동안
   * 서버를 부르지 않고 그 페이로드를 그대로 재생한다
   * (`ppr-navigations.js` → `readFromBFCacheDuringRegularNavigation`).
   *
   * ─── 왜 이 앱에서 위험한가 ─────────────────────────────────────────────────
   * 이 앱의 라우트는 **네 개가 전부 `force-dynamic` 이고, 전부 세션이 화면 *모양*을
   * 가른다.**
   *   `/`               랜딩 ↔ 대시보드
   *   `/boss-plans`     "로그인이 필요합니다" ↔ 본문
   *   `/income`         "로그인이 필요합니다" ↔ 본문
   *   `/schedule`       공개 파티만 ↔ 내 파티 · 가용시간
   *   `/invite/[token]` 세션 유무로 로그인 폼 ↔ 받기 버튼
   * 즉 캐시에 남는 것이 "조금 낡은 숫자"가 아니라 **로그인 전/후의 다른 화면**이다.
   * 로그인 직후 랜딩이 남거나, 로그아웃 뒤 30초 안에 남의 PC 에서 대시보드가 다시
   * 보이는 것은 성능 문제가 아니라 정확성·프라이버시 문제다. `staleTimes` 가 캐시를
   * 태그하는 단위는 **URL** 이지 **세션**이 아니라, 세션이 바뀌어도 항목이 무효화되지
   * 않는다(무효화는 `router.refresh()` 나 문서 재적재가 따로 해 줘야 한다).
   *
   * ─── 성능은 얼마를 잃는가 ──────────────────────────────────────────────────
   * 이 옵션은 **순수하게 클라이언트 캐시 설정이라 서버 응답 시간은 1ms 도 바뀌지
   * 않는다.** 잃는 것은 "30초 안에 같은 탭으로 되돌아올 때의 RSC 왕복 1회"이고,
   * 그 1회의 크기가 실측 `/schedule 610ms · /income 576ms · /boss-plans 430ms · / 468ms`
   * 다. 대신 화면별 **데이터**는 TanStack Query 가 여전히 60초 동안 들고 있어
   * (§2.4 Rule 4) 탭을 오가도 클라이언트 재조회는 나지 않는다 — 발주자가 요구했던
   * "탭마다 같은 캐싱된 값" 은 그 계층이 지키고, 이 옵션이 지키던 것이 아니다.
   *
   * ─── 그래도 되살리고 싶다면 ────────────────────────────────────────────────
   * 전역 값을 올리지 말고, **세션이 모양을 가르지 않는 페이지에만** Next 16 의 페이지
   * 단위 `unstable_dynamicStaleTime` 을 export 해라. 오늘 이 앱에는 그런 페이지가
   * 하나도 없다. 하나 생기면 그 페이지에만 붙이면 된다.
   *
   * ⚠️ `static: 180` 은 남긴다. 정적 세그먼트와 `loading` 경계에만 걸리는 값이라
   *    세션 의존 페이로드를 붙잡지 않는다(네 페이지가 전부 `force-dynamic` 이므로
   *    실질 영향은 loading 경계뿐이다).
   */
  experimental: {
    staleTimes: {
      dynamic: 0,
      static: 180,
    },
  },

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 헤드리스 크롬 — **번들하면 안 되는 패키지 두 개**
   * ═══════════════════════════════════════════════════════════════════════════
   * `!환산` 이 maplescouter 페이지를 헤드리스 브라우저로 연다
   * (`features/bot/server/scouter.ts`, 2026-09-03). 그러려면 이 두 줄이 **둘 다** 필요하고,
   * 하나만 있으면 로컬에서는 멀쩡한데 배포에서만 죽는다.
   *
   * ① `serverExternalPackages` — `@sparticuz/chromium` 은 `__dirname` 기준으로 자기 패키지
   *    안의 `bin/*.br` 압축 바이너리를 찾는다. 번들되면 `__dirname` 이 `.next/server/…` 를
   *    가리켜 그 파일이 있을 리 없다. puppeteer-core 도 같은 이유로 뺀다.
   * ② `outputFileTracingIncludes` — 위 조치만으로는 **`bin/*.br` 이 배포 산출물에 안
   *    실린다.** Next 의 파일 추적은 `require` 로 이어지는 JS 만 따라가고, 코드에서 경로를
   *    조립해 읽는 100MB 짜리 바이너리는 보이지 않기 때문이다. 실제로 확인했다 —
   *    `route.js.nft.json` 500개 항목 안에 `.br` 이 **한 개도 없었다**(2026-09-03).
   *    그대로 배포하면 `executablePath()` 가 파일 없음으로 죽고, 증상은 방에서
   *    "스탯을 못 가져왔어요" 가 **항상** 나오는 것으로만 보인다.
   *
   * ⚠️ 이 두 줄을 지우려면 먼저 `.next/server/app/api/bot/command/route.js.nft.json` 에
   *    `.br` 이 들어 있는지 확인할 것. 없으면 지우면 안 된다.
   */
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/api/bot/command": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
