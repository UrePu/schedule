import { ImageResponse } from "next/og";

import {
  buildHomeworkCard,
  type HomeworkCard,
} from "@/features/bot/server/homework-list";
import {
  buildHomeworkCardView,
  homeworkCardSubsetText,
  IMAGE_CHARACTER_ROWS,
  IMAGE_ICONS_PER_ROW,
  type HomeworkCardView,
} from "@/features/share/server/homework-card-view";
import {
  loadBossIconDataUris,
  loadKoreanOgFonts,
  OG_FONT_FAMILY,
  publicOriginFrom,
} from "@/features/share/server/og-assets";
import { verifyShareToken } from "@/features/share/server/share-token";
import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /s/<토큰>/card.png` — 카톡 미리보기에 뜨는 **그림**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-07): *"!숙제 부분이 생각보다 보기 힘든거같아서 저렇게 사진으로보내면
 * 개편하잖아"*. 봇은 주소만 던지고(즉답), 그림은 **그 주소를 열 때** 만든다 —
 * 명령 응답 예산이 3초라 답장 시점에 PNG 를 구울 여유가 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `opengraph-image.tsx` 가 아니라 직접 만든 라우트인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 파일 규약을 쓰면 Next 가 `og:image` 를 알아서 넣어 주지만, **절대 주소**를 만들려면
 * `metadataBase` 가 필요하다. 이 앱에는 그 값이 없고(배포 주소가 바뀌면 조용히 낡는다는
 * 이유로 `siteOrigin` 을 매 요청 헤더에서 뽑는다), 억지로 넣으면 환경변수 하나가 늘어난다.
 * 라우트로 두면 페이지가 `x-forwarded-host` 로 절대 주소를 만들어 쓰면 되고, 주소에
 * **`.png` 확장자**가 남아 까다로운 크롤러에도 안전하다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 로그인 없이 열린다 — **토큰 검증 외에는 아무것도 흘리지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * - 위조·만료 토큰은 **본문 없는 404** 다. 둘을 구분해 알려 주면 토큰을 훑을 수 있다
 *   (`verifyShareToken` 이 애초에 둘을 `null` 하나로 접는다).
 * - 담기는 정보는 `buildHomeworkCard` 가 평문과 **같은 기준으로** 접은 것뿐이다
 *   (`homework-list.ts` 머리말). 세션도 쿠키도 읽지 않는다.
 * - `force-dynamic` — 토큰마다 다른 그림이라 빌드가 정적으로 구워서는 안 된다.
 */
export const dynamic = "force-dynamic";

/** 1200×630. 카톡 큰 카드가 기대하는 2:1 근처이고, OG 의 사실상 표준 크기다. */
const WIDTH = 1200;
const HEIGHT = 630;

/* ── §4 토큰 값(라이트 팔레트, `app/globals.css`) ─────────────────────────────
   satori 는 CSS 변수를 풀지 못하므로 값을 그대로 적는다. 하드코딩이 아니라 **토큰 값의
   전사**이고, 다른 값을 새로 만들지 않는 것이 규약이다. 토큰이 바뀌면 여기도 바꾼다.
   라이트만 쓰는 이유: 카톡 미리보기에는 사용자의 테마가 전달되지 않는다. */
const C = {
  background: "#fafafa",
  surface: "#ffffff",
  border: "#e4e4e7",
  ink: "#18181b",
  inkLabel: "#3f3f46",
  inkMuted: "#62616a",
  primary: "#4f46e5",
  primarySubtle: "#eef2ff",
  tertiary: "#cf6016",
} as const;

const ROW_HEIGHT = 58;
const ROW_GAP = 9;
const ICON_SIZE = 42;

/** 바닥 한 줄. §1.1 이 요구하는 출처 표기다 — 그림도 화면이므로 예외가 아니다. */
const ATTRIBUTION = "M_Schedule · Data based on NEXON Open API";

function HomeworkCardImage({
  view,
  icons,
}: {
  readonly view: HomeworkCardView;
  readonly icons: ReadonlyMap<string, string>;
}) {
  const rows = view.rows.slice(0, IMAGE_CHARACTER_ROWS);
  const hiddenRows = view.rows.length - rows.length;
  /*
    ⚠️ 접힌 캐릭터 수는 `캐릭터 외 N명` 이라고 **낱말을 붙여** 적는다. `외 N명` 만 쓰면
       바로 앞 꼬리말 `…외 13건` 과 나란히 서면서 같은 것을 두 번 센 것처럼 읽힌다
       (실측 2026-10-07: `…외 13건 · 2억 이하 결정석 19건 · 외 1명`).
    ⚠️ 쓰는 글자는 모두 `og-assets.ALWAYS_INCLUDED` 안에 있어야 한다 — 서브셋에 없는
       글자는 **조용히 빈칸**으로 나온다.
  */
  const notes = [
    ...view.notes,
    hiddenRows > 0 ? `캐릭터 외 ${String(hiddenRows)}명` : null,
  ].filter((note): note is string => note !== null);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.background,
        color: C.ink,
        padding: 44,
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      {/* 머리글 — 제목과 초기화 시계를 한 줄에 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 38, fontWeight: 700, color: C.ink }}>
          {view.title}
        </div>
        <div style={{ fontSize: 26, color: C.inkMuted }}>{view.resetNote}</div>
      </div>

      {/*
        요약 한 줄이 **미리보기에서 유일하게 확실히 읽히는 글자**다. 그래서 가장 크고,
        색도 primary 다. 축소 3~5배를 지나도 18~26px 로 남는다.
      */}
      <div
        style={{
          fontSize: 86,
          fontWeight: 700,
          color: C.primary,
          marginTop: 2,
          lineHeight: 1.05,
        }}
      >
        {view.emptyLabel ?? view.summary}
      </div>

      <div
        style={{
          height: 2,
          backgroundColor: C.border,
          marginTop: 14,
          marginBottom: 14,
        }}
      />

      {/* 캐릭터별 묶음 — 참고 화면(`/boss-status`)과 같은 축이다 */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
        }}
      >
        {rows.map((row) => {
          const shownBosses = row.bosses.slice(0, IMAGE_ICONS_PER_ROW);
          const moreBosses = row.bosses.length - shownBosses.length;
          return (
            <div
              key={row.characterName}
              style={{
                display: "flex",
                alignItems: "center",
                height: ROW_HEIGHT,
                marginBottom: ROW_GAP,
                backgroundColor: C.surface,
                border: `1px solid ${C.border}`,
                // §4 — 상태·구분은 왼쪽 보더 색이 짊어진다.
                borderLeft: `6px solid ${C.primary}`,
                borderRadius: 10,
                paddingLeft: 16,
                paddingRight: 16,
              }}
            >
              <div
                style={{
                  width: 230,
                  fontSize: 32,
                  fontWeight: 700,
                  color: C.ink,
                  overflow: "hidden",
                }}
              >
                {row.characterName}
              </div>
              <div style={{ width: 96, fontSize: 26, color: C.inkMuted }}>
                {row.countLabel}
              </div>
              <div
                style={{
                  width: 250,
                  fontSize: 32,
                  fontWeight: 700,
                  color: C.inkLabel,
                }}
              >
                {row.mesoLabel}
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                {shownBosses.map((boss) => {
                  const dataUri = icons.get(boss.bossDifficultyId);
                  return dataUri === undefined ? (
                    // 에셋이 없는 보스는 오류가 아니다 — 줄임말 칩으로 떨어뜨린다.
                    <div
                      key={boss.bossDifficultyId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        height: ICON_SIZE,
                        paddingLeft: 8,
                        paddingRight: 8,
                        marginRight: 8,
                        borderRadius: 8,
                        backgroundColor: C.primarySubtle,
                        color: C.primary,
                        fontSize: 22,
                        fontWeight: 700,
                      }}
                    >
                      {boss.shortName}
                    </div>
                  ) : (
                    /*
                      satori 는 `next/image` 를 모른다 — `<img>` 가 유일한 수단이고,
                      `src` 는 이미 우리가 받아 인라인한 data URI 라 추가 요청이 없다.
                    */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={boss.bossDifficultyId}
                      src={dataUri}
                      width={ICON_SIZE}
                      height={ICON_SIZE}
                      alt=""
                      style={{
                        marginRight: 8,
                        borderRadius: 8,
                        // 시즌은 12칸을 먹지 않는다 — 평문의 `(시즌)` 표시를 테두리로 옮겼다.
                        border: boss.isSeason
                          ? `2px solid ${C.tertiary}`
                          : `1px solid ${C.border}`,
                      }}
                    />
                  );
                })}
                {moreBosses > 0 ? (
                  <div style={{ fontSize: 24, color: C.inkMuted }}>
                    {`+${String(moreBosses)}`}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* 꼬리말 — 접은 사실을 숨기지 않는다 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 22,
          color: C.inkMuted,
        }}
      >
        <div style={{ display: "flex" }}>{notes.join(" · ")}</div>
        <div style={{ display: "flex" }}>{ATTRIBUTION}</div>
      </div>
    </div>
  );
}

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly token: string }> },
): Promise<Response> {
  const { token } = await params;
  const now = new Date();

  const claim = verifyShareToken(token, now);
  if (claim === null) return new Response(null, { status: 404 });

  let card: HomeworkCard;
  try {
    card = await buildHomeworkCard(
      getAdminDb(),
      claim.userId,
      claim.scope,
      now,
    );
  } catch (error) {
    console.error(
      "[s/card.png#GET] 숙제 카드 조회 실패:",
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return new Response(null, { status: 500 });
  }

  const view = buildHomeworkCardView(card);
  const origin = publicOriginFrom(request.headers, request.url);

  /*
    폰트와 아이콘은 서로를 기다릴 이유가 없다. 둘 다 실패해도 그림은 나온다
    (`og-assets.ts` — 폰트는 기본 폰트로, 아이콘은 글자 칩으로 떨어진다).
  */
  const [fonts, icons] = await Promise.all([
    loadKoreanOgFonts(homeworkCardSubsetText(view, [ATTRIBUTION])),
    loadBossIconDataUris(
      origin,
      view.rows
        .slice(0, IMAGE_CHARACTER_ROWS)
        .flatMap((row) =>
          row.bosses.slice(0, IMAGE_ICONS_PER_ROW).map((b) => b.bossDifficultyId),
        ),
    ),
  ]);

  return new ImageResponse(<HomeworkCardImage view={view} icons={icons} />, {
    width: WIDTH,
    height: HEIGHT,
    fonts: fonts.map((font) => ({ ...font })),
    headers: {
      /*
        주소에 토큰이 박혀 있어 URL 단위로 사람이 갈리므로 공용 캐시가 섞일 일이 없다.
        60초만 두는 이유: `!결정석` 직후 다시 공유하면 바뀐 숫자가 보여야 한다.
      */
      "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
