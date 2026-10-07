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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ★ **잘림을 전제로 한 배치 — 가로 가운데 630px 안에 중요한 것을 다 넣는다**
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시(2026-10-07): *"사진이 너무 작아져서 보스 생긴게 구분이 안된다 피씨에선"* ·
 * *"반쯤 짤리는건 어쩔수 없어보이는데"*.
 *
 * **가정**: 카톡(특히 PC)은 이 그림을 **정사각에 가까운 썸네일로 가운데를 잘라** 쓴다.
 * 1200×630 에서 630×630 을 가운데서 떠내면 가로는 **52.5%만 남고**(= 발주자가 말한
 * "반쯤"), 세로는 **통째로 남는다.** 그래서 이 그림의 안전 영역은
 *   **x 285~915 (가운데 630px) · y 0~630 (전부)**
 * 이고, 합계 숫자와 캐릭터 네 줄은 전부 그 안에 들어간다. 아래 상수들이 그 계산이다 —
 * 카드 폭 700 을 가운데 놓으면(x 250~950) 좌우 패딩 34 를 뺀 글자 영역이 **x 284~916**,
 * 안전 영역과 1px 차이로 겹친다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **세로 순서는 "잃어도 되는 순"의 역순이다 — 그림은 숫자로 시작한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-10-07): *"맨위에 '남은 주간보스' 라는 글씨 없애고 '38건 · 151억 5610만'
 * 이거만 냅두고"*. 제목줄을 걷어낸 **그 자리에 다른 작은 글씨를 넣으면 지시와 어긋난다** —
 * 실제로 한 번 그렇게 했다가(사유 줄을 머리 위로 올림) 축소본이 **읽히지도 않는 회색
 * 한 줄로 시작**했다. 그래서 2026-10-07 에 사유 줄을 **바닥 바로 위로 내렸다.**
 *
 * 위에서부터: **합계 숫자 → 캐릭터 줄 → 빠진 사유 → 초기화 시각·출처.**
 *   - 잘리는 방향이 어느 쪽이든 **먼저 사라지는 것이 덜 중요한 것**이 되게 쌓은 순서다.
 *   - 사유 줄(`…외 N건` · `2억 이하 결정석 N건` · `캐릭터 외 N명`)은 **잃어도 되는 정보**다.
 *     "다 보여 주지 않았다"는 사실이고, 그 전체는 링크를 누르면 나온다(`/s/<토큰>`).
 *     그래서 안쪽이 아니라 바깥쪽(아래)에 둔다.
 *   - 반대로 **출처 표기는 잃으면 안 되는 의무**(§1.1)라 사유 줄보다 더 아래여도 카드
 *     **안**이다. 가로 크롭 가정에서 카드 안은 세로로 안 잘린다.
 *
 * ⚠️ 가정이 틀렸을 때의 모습도 적어 둔다(다음에 조정할 사람이 기준을 알아야 한다).
 *   - **가로를 안 자르면**: 좌우 285px 이 빈 바탕으로 남는다. 글자는 전보다 2배 크므로
 *     읽히는 데는 문제가 없고, 가운데 카드 한 장으로 보인다.
 *   - **세로를 가운데서 자르면**(y 157~472): 머리 숫자 아랫부분과 1~2번째 줄이 남는다.
 *     중요한 순서대로 위에서 아래로 쌓아 둔 이유가 이것이고, 이 경우 가장 먼저 잘려
 *     나가는 아래쪽은 사유 줄이다 — 위 순서대로 **옳은 희생 순서**다.
 *     (이 경우 출처 표기도 함께 잘린다. 세로 크롭은 어떤 배치로도 막을 수 없고,
 *      막으려고 출처를 위로 올리면 **모든 경우에** 숫자 자리를 뺏긴다.)
 * ⚠️ 실제 카톡 동작은 **배포 후에만** 확인된다. 썸네일이 세로를 자르는 쪽이면
 *    `CARD_WIDTH` 를 넓히고 머리를 한 줄로 되돌리는 것이 다음 수다.
 */
/*
  ★ **바탕 여백을 16 → 12, 카드 안쪽 세로 여백을 26 → 16 으로 줄였다**(2026-10-07).
    발주 지시 *"3줄은 에바고 4줄로 해"* 를 받으면서 세로 10px 이 아쉬워졌고, 여백은
    축소된 미리보기에서 **아무 말도 하지 않는 유일한 픽셀**이다. 좌우(`CARD_PADDING_X`)는
    건드리지 않는다 — 위 안전 영역 계산이 그 값에 걸려 있다.
*/
const CANVAS_PADDING = 12;
const CARD_WIDTH = 700;
const CARD_PADDING_X = 34;
const CARD_PADDING_Y = 16;

/**
 * 카드 안쪽 글자 영역의 폭. 위 안전 영역 계산(**x 284~916**)이 이 값이다.
 * 사유 줄처럼 **길이를 우리가 못 정하는 문자열**은 여기에 가둬 넘치면 줄임표로 접는다.
 */
const CONTENT_WIDTH = CARD_WIDTH - CARD_PADDING_X * 2;

/**
 * 줄 높이와 아이콘 크기. 발주 지시(2026-10-07): *"각 줄을 더 두껍게 하고 아이콘을 크게"* +
 * *"3줄은 에바고 4줄로 해"*. 아이콘 32 → **72px(2.25배)**, 줄 높이 58 → **84px**,
 * 줄 수 5 → **4**(근거는 `homework-card-view.IMAGE_CHARACTER_ROWS` 머리말).
 *
 * ★ 왜 80 이 아니라 72 인가: 세로 예산이 정확히 거기서 끊긴다. 630px 에서 바탕 여백 24 ·
 *   카드 세로 여백 32 를 빼면 **574px**, 거기서 줄이 아닌 것을 뺀 잔액이 아래 계산이다.
 *     머리 숫자 135(80 + 52×1.05) + 구분선 22 + 사유 22(+아래 간격 4) + 바닥 24 = **207**
 *     남는 367 ÷ 4줄 = 91.75 → 줄 높이 84 + 줄 간격 6 = **90**(실사용 360, 7px 여유)
 *   ⚠️ 사유 줄을 머리 위에서 바닥 위로 **옮겼을 뿐**이라 합계는 그대로다(위 배치 머리말).
 *     자리를 바꿔 세로가 생기지는 않는다 — 생겼다고 믿고 줄을 늘리면 넘친다.
 *   줄 높이 84 안에 72px 아이콘이 위아래 6px 씩 숨 쉬는 모양이고, 80px 로 올리면 줄이
 *   92px 이 되어 4줄이 세로를 넘친다. **4줄이 발주자가 직접 정한 숫자이므로 아이콘이
 *   양보한다** — 그래도 축소 후 기준으로는 전보다 커진다(아래 실측).
 * ★ 실측(2026-10-07): 안전 영역 630px 폭이 썸네일 300px 로 줄면 배율 0.476 →
 *   72px 아이콘이 **34px**. 개편 전 42px 아이콘은 1200px 전체가 300px 로 줄어(0.25배)
 *   **10px** 이었다. 같은 썸네일에서 3.4배다.
 */
const ROW_HEIGHT = 84;
const ROW_GAP = 6;
const ICON_SIZE = 72;
const ICON_GAP = 8;

/** 이름 + `3건 · 12억 3,456만` 묶음의 폭. 남는 폭이 아이콘 4개 + `+N` 자리다. */
const NAME_COL_WIDTH = 232;

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
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.background,
        color: C.ink,
        padding: CANVAS_PADDING,
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      {/* 안전 영역 카드 — 위 머리말의 x 285~915 계산이 이 폭이다 */}
      <div
        style={{
          width: CARD_WIDTH,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 18,
          paddingLeft: CARD_PADDING_X,
          paddingRight: CARD_PADDING_X,
          paddingTop: CARD_PADDING_Y,
          paddingBottom: CARD_PADDING_Y,
        }}
      >
        {/*
          ★ **제목줄을 걷어냈다** (발주 지시 2026-10-07: 맨 위 `남은 주간 보스` 글씨를
            없애고 합계 숫자만 남기라는 요구다). 머리는 이제 합계 숫자 하나이고, 빠진
            낱말(`남은 주간 보스`)은 `page.tsx` 의 `og:description` 이 받는다 — 카드에서
            사라진 것이 아니라 **그림에서 카드의 글씨 쪽으로** 옮겨 간 것이다.
          ★ 두 줄로 쌓는 이유: 안전 폭 632px 안에서 한 줄로 적으면 58px 까지 내려가
            **전(86px)보다 작아진다.** 쌓으면 80 · 52px 을 쓸 수 있다.
          ★ 92 · 60 → **80 · 52 (2026-10-07)**: 4줄로 늘리면서 세로 23px 을 머리에서
            떼 왔다. 머리는 숫자 두 개뿐이라 조금 줄어도 **그림에서 가장 큰 글씨**라는
            지위가 흔들리지 않는다 — 80px 은 축소 후(0.476배) 38px 이고, 그 자리에서
            읽히지 않을 크기가 아니다. 반대로 줄 쪽에서 23px 을 떼면 아이콘이 한 단계
            더 작아져 애초의 불만(*"보스 생긴게 구분이 안된다"*)으로 되돌아간다.
        */}
        {view.emptyLabel === null ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: 80,
                fontWeight: 700,
                color: C.primary,
                lineHeight: 1,
              }}
            >
              {view.headCountLabel}
            </div>
            <div
              style={{
                fontSize: 52,
                fontWeight: 700,
                color: C.ink,
                lineHeight: 1.05,
              }}
            >
              {view.headMesoLabel}
            </div>
          </div>
        ) : (
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              color: C.primary,
              lineHeight: 1.2,
            }}
          >
            {view.emptyLabel}
          </div>
        )}

        <div
          style={{
            height: 2,
            backgroundColor: C.border,
            marginTop: 10,
            marginBottom: 10,
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
                  backgroundColor: C.background,
                  border: `1px solid ${C.border}`,
                  // §4 — 상태·구분은 왼쪽 보더 색이 짊어진다.
                  borderLeft: `8px solid ${C.primary}`,
                  borderRadius: 12,
                  paddingLeft: 14,
                  paddingRight: 12,
                }}
              >
                {/*
                  이름 아래에 건수·금액을 쌓는다. 한 줄에 넷(이름·건수·금액·아이콘)을
                  늘어놓던 전 배치는 아이콘을 72px 로 키울 폭을 남기지 않는다.
                */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    width: NAME_COL_WIDTH,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ fontSize: 34, fontWeight: 700, color: C.ink }}>
                    {row.characterName}
                  </div>
                  <div style={{ fontSize: 24, color: C.inkLabel }}>
                    {`${row.countLabel} · ${row.mesoLabel}`}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexGrow: 1,
                    justifyContent: "flex-end",
                  }}
                >
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
                          paddingLeft: 10,
                          paddingRight: 10,
                          marginLeft: ICON_GAP,
                          borderRadius: 10,
                          backgroundColor: C.primarySubtle,
                          color: C.primary,
                          fontSize: 28,
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
                          marginLeft: ICON_GAP,
                          borderRadius: 10,
                          // 시즌은 12칸을 먹지 않는다 — 평문의 `(시즌)` 표시를 테두리로 옮겼다.
                          border: boss.isSeason
                            ? `3px solid ${C.tertiary}`
                            : `1px solid ${C.border}`,
                        }}
                      />
                    );
                  })}
                  {moreBosses > 0 ? (
                    <div
                      style={{
                        fontSize: 28,
                        color: C.inkMuted,
                        marginLeft: ICON_GAP,
                      }}
                    >
                      {`+${String(moreBosses)}`}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/*
          ★ **빠진 이유는 바닥 바로 위다**(2026-10-07). 머리 위에 두었다가 내렸다 —
            제목줄을 걷어낸 자리를 작은 회색 글씨가 다시 차지해 **그림이 숫자로 시작하지
            않았다**(위 배치 머리말). 아래로 내려도 뜻은 그대로다: 바로 위 캐릭터 줄들이
            "다 보여 준 것이 아니다"라고 말하는 주석이라, 오히려 설명하는 대상 **옆**에 붙는다.
          ⚠️ 길이를 우리가 못 정하는 유일한 문자열이다(사유 세 개 + `캐릭터 외 N명` 이 모두
             설 수 있다). `CONTENT_WIDTH` 에 가두고 넘치면 **줄임표로 접는다** — 안 가두면
             안전 영역 밖으로 흘러 잘린 글자가 되고, 그건 접힌 것보다 읽기 나쁘다.
             실측(2026-10-07) 관측된 가장 긴 문자열은 632px 중 약 400px 을 썼다.
        */}
        {notes.length > 0 ? (
          <div
            style={{
              display: "flex",
              width: CONTENT_WIDTH,
              height: 22,
              marginBottom: 4,
              overflow: "hidden",
              fontSize: 20,
              color: C.inkMuted,
            }}
          >
            <div
              style={{
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {notes.join(" · ")}
            </div>
          </div>
        ) : null}

        {/*
          꼬리말 — ★ **초기화 시각이 제목줄에서 여기로 내려왔다**(2026-10-07). 버리지 않은
          이유: 어느 주의 그림인지 모르면 지난주 카드를 이번 주 것으로 믿는다(링크 수명이
          최대 한 주라 실제로 생길 수 있는 일이다). 머리에서 크게 말할 값은 아니므로
          출처 표기와 같은 줄, 같은 크기로 둔다. 둘 다 카드 **안**이라 잘리지 않는다.
          ⚠️ 높이를 **명시**한다. 줄 높이가 폰트에 따라 흔들리면 위 세로 예산(203px)이
             같이 흔들리고, 넘치는 순간 잘리는 것은 하필 이 줄 — 즉 **출처 표기**다.
        */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 24,
            fontSize: 20,
            color: C.inkMuted,
          }}
        >
          <div style={{ display: "flex" }}>{view.resetNote}</div>
          <div style={{ display: "flex" }}>{ATTRIBUTION}</div>
        </div>
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
