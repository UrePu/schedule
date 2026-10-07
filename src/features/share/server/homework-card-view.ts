import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 숙제 카드의 **표시 모형** — 그림과 웹 페이지가 같은 문자열을 쓴다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `HomeworkCard`(숫자)와 그리는 쪽(그림 · HTML) 사이에 한 겹을 둔다. 이유는 둘이다.
 *
 * 1. **금액 포맷을 한 번만 한다.** `ko-KR` 축약(§4)이 두 곳에 흩어지면 그림과 페이지가
 *    같은 값을 다르게 적는 날이 온다.
 * 2. **폰트 서브셋을 뽑을 수 있다.** `next/og` 는 `text=` 에 없는 글자를 아예 그리지
 *    못하므로(`og-assets.ts`), "화면에 나가는 글자 전부"를 한 곳에서 모을 수 있어야 한다.
 *    그리는 함수가 문자열을 즉석에서 만들면 그 수집이 불가능하다 — 빠뜨린 글자는
 *    **조용히 빈칸**으로 나오고 그건 알아채기 가장 어려운 종류의 버그다.
 */

import type { HomeworkCard } from "@/features/bot/server/homework-list";
import { homeworkSummaryLine } from "@/features/bot/server/homework-list";
import { formatMesoCompact } from "@/lib/utils";
import type { BossDifficultyTier } from "@/types/domain";

/**
 * 그림에 넣을 **캐릭터 줄 수 상한**.
 *
 * ★ 근거는 "카톡 미리보기에서 읽히는가" 하나다. 1200×630 그림이 대화방에서는 폭
 *   200~360px 로 줄어 **3~6배 축소**된다. 줄을 늘려 글자를 줄이면 미리보기에서 아무것도
 *   읽히지 않고, 줄을 줄여 글자를 키우면 합계와 상위 캐릭터가 읽힌다. **후자를 고른다** —
 *   전체 목록은 링크를 누르면 나오고(`/s/<토큰>` 페이지는 캐릭터를 다 보여 준다),
 *   미리보기가 답해야 하는 질문은 *"지금 열어 볼 만한가"* 다.
 *
 * ★ **5 → 3 → 4 (2026-10-07, 같은 날 두 번).** 먼저 *"각 줄을 더 두껍게 하고 아이콘을
 *   크게 해봐"* 로 아이콘 42 → 80px · 줄 높이 58 → 96px 을 잡으면서 3줄까지만 들어갔고,
 *   발주자가 그 결과를 보고 ***"3줄은 에바고 4줄로 해"*** 라고 정했다. **4 는 발주자가
 *   직접 고른 숫자이므로 여기서 양보하는 쪽은 줄 높이와 아이콘이다** — 아이콘 80 → 72px,
 *   줄 높이 96 → 84px 로 내려 4줄을 넣었다(계산은 `card.png/route.tsx` 의 `ROW_HEIGHT`
 *   머리말). 72px 도 개편 전(42px)보다 크고, 폭 300px 미리보기 기준 10.5px → **18px** 이다
 *   (34px 이라고 적었던 수치는 **가로를 자른다는 틀린 가정** 위의 계산이었다 — 같은 날
 *   관측으로 뒤집혔고, 고친 계산은 `card.png/route.tsx` 의 `ROW_HEIGHT` 머리말에 있다).
 * ⚠️ **예산을 다시 적는다**(2026-10-07, 작은 글씨 두 줄을 지운 뒤). 사유 줄 26 · 바닥 줄
 *    24 · 머리의 둘째 줄 51 이 사라져 잔액이 371 → **467px** 이 됐지만, **그 101px 은
 *    5줄째가 아니라 줄 높이로 갔다**(84 → 108, 아이콘 72 → 94). 4줄이 쓰는 것은
 *    114 × 4 = **456px** 이라 여유는 여전히 **11px** 뿐이다.
 *    ★ 즉 "작은 글씨를 지웠으니 줄을 늘릴 수 있다"는 **틀렸다.** 늘리려면 아이콘을 다시
 *      줄여야 하고, 그건 이번 지시(*"높이 더 높여"*)의 정반대다. 4 는 발주자가 고른 값이다.
 *    ⚠️ 접힌 캐릭터 수를 적던 `캐릭터 외 N명` 도 **같이 지웠다** — 지운 근거와 그 위험은
 *       `card.png/route.tsx` 머리말의 *"없앤 것 2"* 에 있다.
 */
export const IMAGE_CHARACTER_ROWS = 4;

/**
 * 한 줄에 그릴 **아이콘 수 상한**.
 *
 * ★ **8 → 4 → 8 → 7 (2026-10-07, 같은 날 세 번).** 4 로 내린 근거는 *"잘림을 피하려고 잡은
 *   안전 폭 632px 에서 이름 칸 232px 을 빼면 400px 뿐"* 이었다. 그 **안전 폭 자체가
 *   관측으로 사라져**(카톡은 가로를 자르지 않는다 — `card.png/route.tsx` 의 배치 머리말)
 *   8 로 되돌아갔고, 그 다음 지시가 **아이콘을 더 키우라**고 해서 7 이 됐다.
 *
 * ★ **8 → 7 은 아이콘 크기를 산 값이다.** 발주 지시(2026-10-07) *"맨밑에 작은 글씨 삭제
 *   하고 높이 더 높여"* 로 줄 높이가 84 → 108 이 되고, 정사각 아이콘이 거기 묶여
 *   72 → **94px** 이 됐다(계산은 `card.png/route.tsx` 의 `ROW_HEIGHT` 머리말).
 *   줄 안쪽 가로는 그대로 **1059px**(실측)이라, 커진 아이콘이 자리를 더 먹는다:
 *     이름 칸 280(320에서 깎음) → 아이콘 자리 **779px**
 *     한 개 = 간격 8 + 94 = 102px · `+N` 자리 52px
 *     → **7개 766px(13px 여유)** · 8개 868px(**89px 초과**)
 *   8 을 지키려면 아이콘을 **82px** 까지 되돌려야 하는데(= (779−52)÷8 − 8), 그건 이번
 *   지시의 정반대다. **개수가 양보한다.**
 * ⚠️ 대가: 남은 보스가 여덟 이상인 캐릭터는 `+1` 처럼 접힌다. 전 라운드가 8 을 고른 이유가
 *    *"대개 여덟 이하라 접히는 줄이 사실상 없어진다"* 였으므로, **접히는 줄이 다시 생긴다.**
 *    접힌 수는 `+N` 으로 그 자리에 적히고, 전부는 링크를 누르면 나온다.
 * ⚠️ 6 으로 더 내리지 않은 이유: 이름 칸을 깎지 않으면(320) 아이콘 자리가 739px 이라
 *    6개(664px)밖에 못 서고 오른쪽에 **75px 짜리 빈칸**이 남는다. 직전 작업이 되찾은
 *    가로를 다시 빈칸으로 돌려주는 셈이라, 닉네임이 길어야 여섯 자라는 실측을 근거로
 *    이름 칸을 280 으로 깎고 7 을 세웠다.
 */
export const IMAGE_ICONS_PER_ROW = 7;

export interface HomeworkCardViewBoss {
  readonly bossDifficultyId: string;
  /** `하카` · `노세` 같은 줄임말. 아이콘이 없을 때 이 글자가 그 자리를 받는다. */
  readonly shortName: string;
  /** `하드 카링` — 폭이 있는 웹 화면에서만 쓴다(그림에는 자리가 없다). */
  readonly koreanName: string;
  readonly difficulty: BossDifficultyTier;
  /** 시즌 보스는 12칸을 먹지 않는다 — 평문 목록과 같은 표시 기준(§1). */
  readonly isSeason: boolean;
}

export interface HomeworkCardViewRow {
  readonly characterName: string;
  /** `3건` */
  readonly countLabel: string;
  /** `12억 3,456만` */
  readonly mesoLabel: string;
  readonly bosses: readonly HomeworkCardViewBoss[];
}

export interface HomeworkCardView {
  /** `남은 주간 보스` — 웹 페이지의 제목. **그림은 쓰지 않는다**(아래 `headCountLabel`). */
  readonly title: string;
  /**
   * `~10/9 목 00:00` — **웹 페이지 전용이 됐다**(2026-10-07).
   * 그림의 바닥 줄이 사라지면서 이 값을 그리는 곳은 `../page.tsx` 하나다. 그림이 어느
   * 주의 것인지 말하지 않게 된 위험은 `card.png/route.tsx` 머리말 *"없앤 것 3"* 에 있다.
   */
  readonly resetNote: string;
  /** `남은 38건 · 1조 2,345억` — 평문 요약 줄과 **같은 문자열**이다(웹 페이지가 쓴다). */
  readonly summary: string;
  /**
   * 그림 머리의 **앞쪽**. `38건`. 뒤의 `headMesoLabel` 과 `·` 로 이어 **한 줄**로 그린다.
   *
   * ★ 왜 `summary` 를 쪼개 두는가(2026-10-07): 발주 지시가 그림의 제목줄을 걷어내고
   *   *"'38건 · 151억 5610만' 이거만 냅두고"* 라 했는데, 평문 요약 줄은 앞에 `남은` 이
   *   붙어 있고 그 낱말은 이제 그림이 아니라 `og:description` 이 맡는다.
   *   쪼갠 채로 두는 **또 하나의 이유**: 그림이 둘에 **다른 색**을 준다(건수 primary ·
   *   금액 ink). 한 문자열로 합쳐 두면 그 색을 나눌 수 없다.
   * ★ **두 줄 → 한 줄 (2026-10-07).** 발주 지시 *"맨위에 글씨 1줄로 변경"*.
   *   ⚠️ 바로 앞 라운드에 적어 둔 *"한 줄로 되돌리지 않는다 — 뜨는 세로 55px 을 쓸 곳이
   *      없다"* 는 **같은 날 지시로 무효가 됐다.** 같은 지시가 바닥의 작은 글씨 두 줄도
   *      지우라 했고, 그래서 뜬 세로는 **줄 높이와 아이콘**이 받는다
   *      (`card.png/route.tsx` 의 `ROW_HEIGHT` 예산식). "쓸 곳이 없다"가 더는 참이 아니다.
   *   가로는 문제가 아니다 — 최악의 문자열(`128건 · 1조 2,345억`)도 80px 한 줄로 약
   *   795px 이라 글자 영역 1094px 안이다(실측 근거는 `HEAD_FONT_SIZE` 머리말).
   */
  readonly headCountLabel: string;
  /** 그림 머리의 **뒤쪽**. `151억 5,610만`. 위 `headCountLabel` 과 한 줄에 선다. */
  readonly headMesoLabel: string;
  /**
   * 빠진 이유별 꼬리말(평문과 같다). 비어 있을 수 있다.
   * ⚠️ **그림은 더는 그리지 않는다**(2026-10-07) — 쓰는 곳은 평문과 `../page.tsx` 뿐이다.
   *    근거는 `card.png/route.tsx` 머리말 *"없앤 것 2"*.
   */
  readonly notes: readonly string[];
  /** **전부**. 그림은 앞에서 `IMAGE_CHARACTER_ROWS` 개만 쓰고, 페이지는 다 그린다. */
  readonly rows: readonly HomeworkCardViewRow[];
  /** 남은 것이 하나도 없을 때 띄울 한마디. */
  readonly emptyLabel: string | null;
}

export function buildHomeworkCardView(card: HomeworkCard): HomeworkCardView {
  return {
    title: card.title,
    resetNote: card.resetNote,
    summary: homeworkSummaryLine(card),
    headCountLabel: `${String(card.totalCount)}건`,
    headMesoLabel: formatMesoCompact(card.totalMeso),
    notes: card.notes,
    rows: card.characters.map((character) => ({
      characterName: character.characterName,
      countLabel: `${String(character.listedCount)}건`,
      mesoLabel: formatMesoCompact(character.listedMeso),
      bosses: character.bosses.map((boss) => ({
        bossDifficultyId: boss.bossDifficultyId,
        shortName: boss.shortName,
        koreanName: boss.koreanName,
        difficulty: boss.difficulty,
        isSeason: boss.cycle === "season",
      })),
    })),
    emptyLabel: card.totalCount === 0 ? "남은 보스 없음" : null,
  };
}

/**
 * 그림에 **실제로 나가는 글자 전부**. 폰트 서브셋 요청에 그대로 넣는다.
 *
 * ⚠️ 그리는 쪽에 문자열 리터럴을 새로 쓰면 **여기에도 더해야 한다.** 더하지 않으면 그
 *    글자만 빈칸으로 나온다. 그래서 그리는 쪽은 이 모형 밖의 글자를 만들지 않는 것이
 *    규약이고, 예외는 `og-assets.ts` 의 `ALWAYS_INCLUDED` 가 받는다.
 * ★ **`extra` 인자를 걷어냈다**(2026-10-07). 그 인자가 존재한 유일한 이유는 그림 바닥의
 *   출처 한 줄(`M_Schedule · Data based on NEXON Open API`)을 서브셋에 밀어 넣는 것이었고,
 *   그 줄이 사라졌다(머리말 *"없앤 것 1"*). 쓰지 않는 확장점은 **다음 사람이 서브셋을
 *   우회하는 통로**가 되므로 남겨 두지 않는다 — 필요해지면 그때 모형에 필드를 더한다.
 * ⚠️ `title` · `summary` · `resetNote` 는 그림이 그리지 않지만 **그대로 둔다.** 이 함수는
 *    "그림에 나갈 수 있는 글자"의 상한이고, 서브셋이 조금 넓은 것은 바이트만 늘릴 뿐
 *    아무것도 깨지 않는다. 반대로 좁으면 그 글자가 **조용히 빈칸**이 된다.
 */
export function homeworkCardSubsetText(view: HomeworkCardView): string {
  return [
    view.title,
    view.resetNote,
    view.summary,
    view.headCountLabel,
    view.headMesoLabel,
    view.emptyLabel ?? "",
    ...view.notes,
    ...view.rows.flatMap((row) => [
      row.characterName,
      row.countLabel,
      row.mesoLabel,
      ...row.bosses.map((boss) => boss.shortName),
    ]),
  ].join("");
}
