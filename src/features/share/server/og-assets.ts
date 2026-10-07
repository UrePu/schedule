import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `next/og` 에 먹일 재료 — **한글 폰트**와 **보스 아이콘 바이트**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 왜 폰트를 따로 실어야 하나 — 기본 폰트에 한글이 **없다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `next/og`(satori + resvg)가 들고 있는 기본 폰트는
 * `node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf` 하나뿐이고, 라틴
 * 전용이다. 한글을 그대로 그리면 **전부 빈칸(두부)** 으로 나온다. 이 제품은 화면이 통째로
 * 한국어라, 폰트를 싣지 않으면 그림이 아무 말도 못 한다.
 *
 * 저장소의 `src/app/fonts/*.woff2`(Pretendard · Maplestory)는 **쓸 수 없다.**
 * satori 가 받는 형식은 `ttf` · `otf` · `woff` 뿐이고(`next/dist/docs` ImageResponse 문서
 * 명시), woff2 디코더는 들어 있지 않다. 그걸 ttf 로 바꾸려면 woff2(브로틀리 + glyf 변환)
 * 역변환기가 필요한데 저장소에 폰트 도구가 없다(`package.json` 스크립트 확인).
 *
 * 그래서 **Google Fonts 에서 필요한 글자만 받는다.**
 *   `css2?family=Noto+Sans+KR:wght@400;700&text=<쓰는 글자들>`
 * ★ `text=` 서브셋이 핵심이다. 전체 한글(11,172자)은 수 MB 지만, 한 화면에 실제로 쓰이는
 *   글자는 100자 안팎이라 **20KB 내외**로 떨어진다(실측 20,508B).
 * ★ **User-Agent 를 보내지 않는다.** Google 은 UA 로 형식을 고르는데(실측 2026-10-07)
 *   Firefox/IE 계열 UA → `woff`, IE8 UA → **EOT**(satori 가 못 읽는다), UA 를 모르면
 *   → `truetype`. 그래서 아무 UA 도 주지 않는 쪽이 우리가 원하는 형식을 준다.
 *   ⚠️ UA 를 "친절하게" 채워 넣지 말 것. 그 한 줄이 그림을 통째로 깨뜨린다.
 * ⚠️ 폰트를 못 받으면 **그림을 포기하지 않고 기본 폰트로 그린다.** 숫자와 기호는 그대로
 *    읽히므로 "미리보기가 깨진 것"보다 낫다. 실패는 서버 로그에만 남긴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 아이콘은 **data: URI 로 인라인**한다
 * ─────────────────────────────────────────────────────────────────────────────
 * satori 의 `<img src>` 에 원격 URL 을 그대로 줘도 받아 오지만, 그 경로는 한 장만
 * 실패해도 `ImageResponse` 가 **통째로 던진다.** 미리보기 그림에서 아이콘 한 장 때문에
 * 500 을 내는 것은 맞바꿀 가치가 없으므로, 우리가 받아서 넣고 실패한 자리는 글자 칩으로
 * 떨어뜨린다.
 *
 * ★ 모듈 레벨 캐시를 쓴다. §2.4 Rule 2(서버 캐시 금지)는 **사용자 데이터**에 걸린 규칙이고,
 *   여기 담기는 것은 `public/bosses/*.png` — 로그인 없이 누구나 받는 정적 에셋이다.
 *   사람에 따라 달라지는 값이 한 바이트도 없으므로 다음 방문자에게 샐 것이 없다.
 */

/*
  ⚠️ 배럴(`@/components/domain`)이 아니라 **매니페스트 모듈을 직접** 가져온다. 배럴에는
     `lucide-react` · `next/image` 를 끌어오는 React 컴포넌트가 함께 들어 있어서,
     경로 문자열 두 줄 때문에 `ImageResponse` 라우트 번들에 그 전부가 딸려 온다.
     경로 규칙의 단일 소유자(`bossIconSrc`)는 그대로 지킨다 — 문자열을 복제하지 않는다.
*/
import {
  bossIconSrc,
  hasBossIcon,
} from "@/components/domain/boss-icon-manifest";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 주소
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 크롤러가 받아 갈 **절대 주소**의 출처. `og:image` 는 상대 경로를 쓸 수 없다.
 *
 * 규칙은 `app/api/bot/command/route.ts` 의 `publicOrigin` 과 같다 — 프록시 뒤에서
 * `request.url` 은 내부 호스트일 수 있으므로 `x-forwarded-*` 를 먼저 본다. 환경변수를
 * 두지 않는 이유도 같다: 배포 주소가 바뀌면 조용히 낡는다.
 */
export function publicOriginFrom(headers: Headers, fallbackUrl?: string): string {
  const forwardedHost = headers.get("x-forwarded-host");
  const host = forwardedHost ?? headers.get("host");
  const proto =
    headers.get("x-forwarded-proto") ??
    (host !== null && host.startsWith("localhost") ? "http" : "https");
  if (host !== null && host !== "") return `${proto}://${host}`;
  if (fallbackUrl !== undefined) return new URL(fallbackUrl).origin;
  throw new Error("[share/og] 요청에서 호스트를 찾을 수 없습니다.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 한글 폰트
// ─────────────────────────────────────────────────────────────────────────────

/** `ImageResponse` 의 `fonts` 항목 모양. `next/og` 의 타입을 끌어오지 않고 최소로 맞춘다. */
export interface OgFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 400 | 700;
  readonly style: "normal";
}

export const OG_FONT_FAMILY = "Noto Sans KR";

/**
 * 어떤 카드에도 반드시 들어가는 글자. 숫자·구분기호·단위가 빠지면 금액이 통째로 빈칸이 된다.
 *
 * ⚠️ 서브셋은 `text=` 에 **없는 글자를 그리지 않는다.** 동적 문자열(캐릭터 이름 · 보스
 *    줄임말)은 호출부가 합쳐 넣고, 고정 문구에서 빠뜨리기 쉬운 것들을 여기에 모아 둔다.
 */
const ALWAYS_INCLUDED =
  "0123456789,.·~/()+-: %억만조원건명주간월일보스남은초기화외이하결정석가격미확인제외없시즌캐릭터기준";

/** 서브셋 키 → 받아 둔 폰트. 같은 글자 조합이면 두 번 받지 않는다. */
const fontCache = new Map<string, readonly OgFont[]>();

/** 중복을 걷어 정렬한 글자들. 같은 화면이면 매번 같은 키가 나온다(캐시 적중률). */
function subsetKey(text: string): string {
  return [...new Set(`${text}${ALWAYS_INCLUDED}`)].sort().join("");
}

async function fetchGoogleFont(
  subset: string,
  weight: 400 | 700,
  url: string,
): Promise<OgFont> {
  /*
    `cache: "no-store"` — Next 의 데이터 캐시에 바이너리를 쌓지 않는다. 재사용은 위의
    `fontCache` 가 하고, 그쪽이 프로세스 수명 동안 훨씬 싸다.
  */
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`폰트 바이트 응답 ${String(response.status)} (${subset.length}자)`);
  }
  return {
    name: OG_FONT_FAMILY,
    data: await response.arrayBuffer(),
    weight,
    style: "normal",
  };
}

/**
 * 이 글자들을 그릴 수 있는 한글 폰트(400 · 700)를 받아 온다.
 *
 * 실패하면 **빈 배열**이다 — 부르는 쪽은 그대로 `ImageResponse` 에 넘기면 되고,
 * 기본 폰트로 떨어진다(한글은 빈칸이 되지만 그림 자체는 나온다).
 */
export async function loadKoreanOgFonts(text: string): Promise<readonly OgFont[]> {
  const subset = subsetKey(text);
  const cached = fontCache.get(subset);
  if (cached !== undefined) return cached;

  try {
    const cssUrl =
      `https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700` +
      `&text=${encodeURIComponent(subset)}`;
    // ⚠️ 헤더를 **비워 둔다.** 위 머리말의 UA → 형식 표를 보라.
    const cssResponse = await fetch(cssUrl, { cache: "no-store" });
    if (!cssResponse.ok) {
      throw new Error(`css2 응답 ${String(cssResponse.status)}`);
    }
    const css = await cssResponse.text();

    const blocks = css.split("@font-face").slice(1);
    const wanted: Array<{ readonly weight: 400 | 700; readonly url: string }> = [];
    for (const blockText of blocks) {
      const weightText = /font-weight:\s*(\d+)/u.exec(blockText)?.[1];
      const url = /url\((https:[^)]+)\)/u.exec(blockText)?.[1];
      if (url === undefined) continue;
      const weight = weightText === "700" ? 700 : 400;
      wanted.push({ weight, url });
    }
    if (wanted.length === 0) {
      throw new Error("css2 응답에서 폰트 주소를 찾지 못했습니다.");
    }

    const fonts = await Promise.all(
      wanted.map(async ({ weight, url }) => fetchGoogleFont(subset, weight, url)),
    );
    fontCache.set(subset, fonts);
    return fonts;
  } catch (error) {
    console.warn(
      "[share/og] 한글 폰트를 받지 못해 기본 폰트로 그립니다:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 아이콘
// ─────────────────────────────────────────────────────────────────────────────

/** `boss_difficulties.id` → `data:image/png;base64,...`. 아이콘은 패치 때만 바뀐다. */
const iconCache = new Map<string, string>();

/**
 * 아이콘이 있는 것만 data URI 로 돌려준다. 없거나 못 받은 것은 **Map 에 담기지 않는다** —
 * 부르는 쪽이 그 자리를 글자 칩으로 그린다(에셋 없음은 오류가 아니다, `BossIcon` 과 동일).
 */
export async function loadBossIconDataUris(
  origin: string,
  bossDifficultyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(bossDifficultyIds)].filter((id) => hasBossIcon(id));
  const missing = unique.filter((id) => !iconCache.has(id));

  await Promise.all(
    missing.map(async (id) => {
      try {
        const response = await fetch(`${origin}${bossIconSrc(id)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`응답 ${String(response.status)}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        iconCache.set(id, `data:image/png;base64,${bytes.toString("base64")}`);
      } catch (error) {
        console.warn(
          `[share/og] 보스 아이콘 ${id} 을(를) 받지 못했습니다:`,
          error instanceof Error ? error.message : error,
        );
      }
    }),
  );

  const result = new Map<string, string>();
  for (const id of unique) {
    const dataUri = iconCache.get(id);
    if (dataUri !== undefined) result.set(id, dataUri);
  }
  return result;
}
