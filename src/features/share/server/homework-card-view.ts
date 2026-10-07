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
 * ⚠️ 이 값을 올릴 사람은 먼저 축소된 크기에서 글자가 읽히는지 보라. 실측(2026-10-07)
 *    630px 에서 여백(24+32)·꼬리말 사유 22·머리 숫자 135·구분선 22·바닥 24 를 뺀 잔액이
 *    **371px** 이고, 4줄이 쓰는 것은 90 × 4 = 360px 이다. **5줄째가 들어갈 자리는
 *    11px 뿐이다** — 올리려면 아이콘을 다시 줄여야 하고, 그건 이번 지시의 반대다.
 *    접힌 수는 `캐릭터 외 N명` 으로 그림 안에 그대로 적는다.
 */
export const IMAGE_CHARACTER_ROWS = 4;

/**
 * 한 줄에 그릴 **아이콘 수 상한**.
 *
 * ★ **8 → 4 → 8 (2026-10-07, 같은 날 두 번).** 4 로 내린 근거는 *"잘림을 피하려고 잡은
 *   안전 폭 632px 에서 이름 칸 232px 을 빼면 400px 뿐"* 이었다. 그 **안전 폭 자체가
 *   관측으로 사라졌다** — 카톡은 가로를 자르지 않는다(`card.png/route.tsx` 의 배치 머리말,
 *   발주자 관측: *"이미지 높이는 맞는데 가로는 짧게 나온다"*). 카드가 캔버스를 다 쓰게
 *   되면서 글자 영역이 632 → **1096px**, 아이콘 자리가 400 → **776px** 이 되어
 *   **원래 값 8 로 되돌아간다**: (72+8) × 8 = 640 + `+N` 56 = **696px**(80px 여유).
 * ★ 왜 "더 키우기"가 아니라 "더 보여주기"인가: 되찾은 것은 **가로뿐**이고 아이콘 크기는
 *   **세로 예산**이 묶고 있다(줄 높이 84 · 4줄은 발주자가 정한 값). 가로만 넓다고 아이콘을
 *   키우면 정사각 아이콘이 줄 높이를 넘긴다. 그래서 넓어진 폭은 **개수**로 돌려받는다 —
 *   한 캐릭터의 남은 보스가 대개 여덟 이하라, 8이면 `+N` 으로 접히는 줄이 사실상 없어진다.
 * ⚠️ 9 로 더 올리지 않는 이유는 여유다. (72+8) × 9 + 56 = 776px 으로 **딱 0px 이 남고**,
 *   `+12` 같은 세 글자 `+N` 이나 이름 칸을 한 번만 더 손대면 바로 넘친다.
 */
export const IMAGE_ICONS_PER_ROW = 8;

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
  /** `~10/9 목 00:00` */
  readonly resetNote: string;
  /** `남은 38건 · 1조 2,345억` — 평문 요약 줄과 **같은 문자열**이다(웹 페이지가 쓴다). */
  readonly summary: string;
  /**
   * 그림 머리의 **첫 줄**. `38건`.
   *
   * ★ 왜 `summary` 를 쪼개 두는가(2026-10-07): 발주 지시가 그림의 제목줄을 걷어내고
   *   *"'38건 · 151억 5610만' 이거만 냅두고"* 라 했는데, 평문 요약 줄은 앞에 `남은` 이
   *   붙어 있고 그 낱말은 이제 그림이 아니라 `og:description` 이 맡는다. 또 한 줄로 두면
   *   잘림을 피하려 잡은 안전 폭(632px)에서 글자가 58px 까지 내려가 **지금보다 작아진다** —
   *   두 줄로 쌓으면 80px·52px 을 쓸 수 있다. 포맷은 여전히 `formatMesoCompact` 하나다.
   * ⚠️ **"한 줄로 되돌릴까"는 이미 따져 봤다 — 하지 않는다**(2026-10-07, 카드가 캔버스를
   *    다 쓰게 된 뒤). 폭이 1096px 이 되면서 위의 "58px 까지 내려간다"는 근거는 사라졌다.
   *    최악의 문자열(`128건 · 1조 2,345억`)도 한 줄 80px 이면 든다. 그런데 한 줄로 바꾸면
   *    머리가 135 → 80px 으로 줄어 **세로 55px 이 뜨고, 그 55px 을 쓸 곳이 없다** —
   *    캐릭터 4줄과 아이콘 72px 은 발주자가 정한 값이라 늘릴 수 없으므로 마지막 줄 아래에
   *    빈칸으로 남는다. 금액 글자가 52 → 80px 로 커지는 대가로 카드에 죽은 공간을 만드는
   *    거래라서 접었다. **세로를 다시 쓸 수 있게 되는 날 이 결정을 다시 보라.**
   */
  readonly headCountLabel: string;
  /** 그림 머리의 **두 번째 줄**. `151억 5,610만`. */
  readonly headMesoLabel: string;
  /** 빠진 이유별 꼬리말(평문과 같다). 비어 있을 수 있다. */
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
 */
export function homeworkCardSubsetText(
  view: HomeworkCardView,
  extra: readonly string[] = [],
): string {
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
    ...extra,
  ].join("");
}
