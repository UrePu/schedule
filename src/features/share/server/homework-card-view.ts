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
 *   250~360px 로 줄어 **3~5배 축소**된다. 즉 34px 글자는 7~11px 로 떨어진다. 줄을 늘려
 *   글자를 줄이면 미리보기에서 아무것도 읽히지 않고, 줄을 줄여 글자를 키우면 미리보기에서
 *   합계와 상위 캐릭터가 읽힌다. **후자를 고른다** — 전체 목록은 링크를 누르면 나오고
 *   (`/s/<토큰>` 페이지는 캐릭터를 다 보여 준다), 미리보기가 답해야 하는 질문은
 *   *"지금 열어 볼 만한가"* 다.
 * ⚠️ 이 값을 올릴 사람은 먼저 축소된 크기에서 글자가 읽히는지 보라. 630px 안에서
 *    머리글·꼬리말을 뺀 뒤 쓸 수 있는 높이는 **330px 남짓**이다.
 */
export const IMAGE_CHARACTER_ROWS = 5;

/**
 * 한 줄에 그릴 **아이콘 수 상한**. 아이콘 42px + 간격 8px 이므로 8개면 400px —
 * 이름·건수·금액을 뺀 나머지 폭(약 470px)에 들어가는 최대치다. 넘으면 `+N` 으로 접는다.
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
  /** `남은 주간 보스` */
  readonly title: string;
  /** `~10/9 목 00:00` */
  readonly resetNote: string;
  /** `남은 38건 · 1조 2,345억` — 평문 요약 줄과 **같은 문자열**이다. */
  readonly summary: string;
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
