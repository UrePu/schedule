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

import type {
  RemainingBoss,
  RemainingBossScope,
  RemainingSummary,
} from "@/features/bot/server/bot-repo";
import { resetLabel } from "@/features/bot/server/shared";
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
 * ⚠️ **예산을 다시 적는다**(2026-10-07, 작은 글씨 두 줄을 지우고 윗여백을 깎은 뒤).
 *    사유 줄 26 · 바닥 줄 24 · 머리의 둘째 줄 51 · 카드 윗여백 10 이 사라져 잔액이
 *    371 → **477px** 이 됐지만, **그 111px 은 5줄째가 아니라 줄 높이로 갔다**
 *    (84 → 113, 아이콘 72 → 94). 4줄이 쓰는 것은 119 × 4 = **476px** 이라 여유는 **7px** 뿐이다.
 *    ★ 즉 "작은 글씨를 지웠으니 줄을 늘릴 수 있다"는 **틀렸다.** 늘리려면 아이콘을 다시
 *      줄여야 하고, 그건 이번 지시(*"높이 더 높여"*)의 정반대다. 4 는 발주자가 고른 값이다.
 *    ⚠️ 접힌 캐릭터 수를 적던 `캐릭터 외 N명` 도 **같이 지웠다** — 지운 근거와 그 위험은
 *       `card.png/route.tsx` 머리말의 *"없앤 것 2"* 에 있다.
 */
export const IMAGE_CHARACTER_ROWS = 4;

/**
 * 한 줄에 그릴 **아이콘 수 상한**.
 *
 * ★ **8 → 4 → 8 → 7 → 5 → 4 (2026-10-07, 같은 날 다섯 번).** 숫자가 네 번 움직인 이유는 매번
 *   **가로 예산이 바뀌었기 때문**이지 취향이 아니다. 전부 `card.png/route.tsx` 에 계산이 있다.
 *     4: 잘림을 피하려 잡은 안전 폭 632px — 그 **안전 폭이 관측으로 사라졌다**
 *     8: 카드가 캔버스를 다 쓰게 되어 글자 영역 1096px
 *     7: *"높이 더 높여"* → 아이콘 72 → 94px, 커진 아이콘이 자리를 더 먹음
 *     5: *"닉네임 크기좀 키워"* → 닉네임 34 → 48px, 이름 칸이 아이콘 자리를 가져감
 *     4: *"캐릭당 얼마 남았는지도 ㅈㄴ 안보여"* → 금액 22 → 48px (대신 `n건` 을 뺐다)
 *
 * ★ **7 → 5 는 닉네임 크기를 산 값이다.** 발주 지시(2026-10-07) *"닉네임 - n건 - 보스
 *   순으로 해서 닉네임 크기좀 키워 잘 안보여"*. 쌓여 있던 이름·금액이 **가로 한 줄로 펴지고**
 *   닉네임이 48px 이 되면서, 줄 안쪽 1059px(실측) 중 글자가 가져가는 몫이 커졌다:
 *     이름 칸 **284** + `n건 · 금액` 칸 **206** → 아이콘 자리 **569px**
 *     한 개 = 간격 8 + 94 = 102px · `+N` 자리 48px
 *     → **5개 558px(11px 여유)** · 6개 660px(**91px 초과**)
 *   6 을 지키려면 아이콘을 **78px** 로 되돌려야 하는데(= (569−48)÷6 − 8), 그건 이 스레드
 *   내내 이어진 *"아이콘을 크게"* 의 반대다. **개수가 양보한다.**
 * ⚠️ 대가: 남은 보스가 여섯 이상인 캐릭터는 `+1` 처럼 접힌다. 실측(2026-10-07) 라이브
 *    데이터의 한 줄 최대가 **6개**였으므로 그런 줄이 **실제로 생긴다.** 접힌 수는 `+N` 으로
 *    그 자리에 적히고, 전부는 링크를 누르면 나온다.
 * ⚠️ **5 → 4 는 그 "글자부터 깎는다"를 되돌린 결과다.** 24 → 22px 로 깎은 금액이 바로
 *    *"ㅈㄴ 안보여"* 를 불렀고, 양보 순서가 **금액 > 아이콘 개수 > 아이콘 크기**로 뒤집혔다.
 *    금액을 48px 로 올리는 가로는 `n건` 을 빼서 마련했고(건수는 그 줄의 아이콘 수와 `+N`
 *    이 그대로 말한다), 그러고도 5개가 63px 모자라 4가 됐다. 계산은 `NAME_COL_WIDTH` 머리말.
 * ⚠️ **4 밑으로 혼자 내려가지 말 것** — 거기서부터는 그림이 목록 구실을 잃는다.
 */
export const IMAGE_ICONS_PER_ROW = 4;

export interface HomeworkCardViewBoss {
  readonly bossDifficultyId: string;
  /** `하카` · `노세` 같은 줄임말. 아이콘이 없을 때 이 글자가 그 자리를 받는다. */
  readonly shortName: string;
  /** `하드 카링` — 폭이 있는 웹 화면에서만 쓴다(그림에는 자리가 없다). */
  readonly koreanName: string;
  readonly difficulty: BossDifficultyTier;
  /** 시즌 보스는 12칸을 먹지 않는다 — 평문 목록과 같은 표시 기준(§1). */
  readonly isSeason: boolean;
  /**
   * **1인당 수령액**(솔로가가 아니다). `crystalShareMeso(가격, partySize)` 의 결과다.
   * ★ 2026-10-08 에 더했다 — 발주 지시 *"호버 하면 몇인인지 각 얼마인지"*. 그림(`card.png`)은
   *   쓰지 않고 웹 착지 화면만 쓴다. 그림에는 보스 하나당 글자를 적을 자리가 없다.
   */
  readonly shareMeso: number;
  /**
   * 그 금액을 나눈 **파티 인원**. `fetchRemainingBosses` 에서 `null`이 이미 1로 접혀 온다
   * (`RemainingBoss.defaultPartySize` 머리말). **여기서 다시 접지 않는다** — 접는 자리가
   * 둘이면 계산과 표시가 갈라진다.
   */
  readonly partySize: number;
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

/*
  ★ **`buildHomeworkCardView(card)` 를 지웠다**(2026-10-08). `HomeworkCard`(= 평문용으로
    금액 문턱과 상위 15건에 **이미 잘린** 목록)를 그대로 표시 모형으로 옮기던 함수였고,
    그 경로가 2026-10-08 결함의 통로였다(위 `buildHomeworkCardViewFromRemaining` 머리말).
    그림도 웹 화면도 이제 자르지 않은 쪽을 쓰므로 부르는 곳이 없다. **남겨 두면 다음
    사람이 "짧은 쪽"을 골라 같은 결함을 되살린다** — 그래서 지운다.
*/
/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ★ **그림은 "남은 것 전부"로 묶는다 — 평문의 두 자르기를 물려받지 않는다**
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 보고(2026-10-08, 주간 초기화 직후): *"주간이 초기화됐는데 보스목록이 이상함"*.
 *
 * ─ 무엇이 틀렸나 ───────────────────────────────────────────────────────────
 * `buildHomeworkCard` 는 평문 `!숙제` 를 위해 만든 것이라 **두 번 자른 뒤** 캐릭터로 묶는다:
 *   ① 금액 문턱(`HOMEWORK_MIN_MESO`, 2억) ② 상위 **15건**(`HOMEWORK_LIST_MAX`).
 * 그림은 그 `card.characters` 를 그대로 썼다. 그래서 **머리는 전체 95건으로 더하고 줄은
 * 잘린 15건으로 묶는** 상태가 됐다 — 같은 그림 안에서 **두 모집단**이 섞인 것이다.
 *   실측(2026-10-08): 더저 115억 6,550만(실제 **130억 6,000만**) · 무르겨르 37억 6,150만
 *   (**89억 7,000만**) · 콜라이제없어 25억 6,900만(**96억 6,100만**) · 카파런 25억 3,150만
 *   (**54억 2,800만**). 정렬까지 틀어져 96.6억이 89.7억 아래에 섰다.
 * ⚠️ **왜 이제야 드러났나**: 초기화 전에는 남은 것이 22건이라 15건 상한에 거의 안 걸렸다.
 *    목요일 00:00 을 넘겨 95건이 되자 80건이 잘려 나갔다. **임계가 데이터에 숨어 있었다.**
 *
 * ─ 왜 평문은 자르고 그림은 안 자르나 ────────────────────────────────────────
 * 평문은 **보스 한 건이 한 줄**이라 95건이면 95줄이고, 카톡에서 읽히지 않는다. 문턱과
 * 15줄 상한은 **그 매체의 장치**다(`homework-list.ts` 머리말 — 건드리지 않는다).
 * 그림은 **캐릭터 한 명이 한 줄**이라 8명이면 8줄이고, 거기서 다시 4줄로 접는다.
 * 즉 **접는 일을 이미 캐릭터 단위로 하고 있어** 보스 단위로 또 자를 이유가 없다.
 * 자르면 줄의 숫자가 거짓이 되고, 이번 결함이 정확히 그것이었다.
 *
 * ─ 지키는 규칙 ────────────────────────────────────────────────────────────
 *   1. 줄의 건수·금액은 그 캐릭터의 **남은 것 전부**다(문턱도 15건 상한도 없다).
 *   2. 캐릭터 정렬도 그 **전체 금액** 내림차순(동률이면 이름 `ko`)이다.
 *   3. **아이콘 4개만 자르는 것은 자리 문제**이고, `+N` 의 `N` 은 `전체 건수 − 보인 수` 다.
 *   4. 아이콘은 캐릭터 안에서 **금액 큰 순** — `fetchRemainingBosses` 가 이미 전체를 금액
 *      내림차순으로 주므로 그 순서대로 담기만 하면 그 성질이 보존된다.
 *   ★ 검증식: **머리 합계 = 모든 줄 금액의 합**(접힌 `외 N명` 까지 포함). 둘 다
 *     `remaining.items` 하나에서 나오므로 구조적으로 성립한다 — 이게 이번 수정의 요점이다.
 *   ⚠️ `remaining.totalMeso` 는 **가격 미확인을 뺀** 합이고 `items` 도 같은 기준이라
 *      양쪽이 같은 모집단이다(D4 — `null` 은 0 이 아니라 제외다).
 */
export function buildHomeworkCardViewFromRemaining(
  remaining: RemainingSummary,
  scope: RemainingBossScope,
  now: Date,
): HomeworkCardView {
  const byCharacter = new Map<string, RemainingBoss[]>();
  for (const item of remaining.items) {
    const bucket = byCharacter.get(item.characterName);
    if (bucket === undefined) byCharacter.set(item.characterName, [item]);
    else bucket.push(item);
  }

  const rows: HomeworkCardViewRow[] = [...byCharacter.entries()]
    .map(([characterName, bosses]) => ({
      characterName,
      meso: bosses.reduce((sum, boss) => sum + boss.shareMeso, 0),
      bosses,
    }))
    .sort(
      (a, b) => b.meso - a.meso || a.characterName.localeCompare(b.characterName, "ko"),
    )
    .map((entry) => ({
      characterName: entry.characterName,
      countLabel: `${String(entry.bosses.length)}건`,
      mesoLabel: formatMesoCompact(entry.meso),
      bosses: entry.bosses.map((boss) => ({
        bossDifficultyId: boss.bossDifficultyId,
        shortName: boss.shortName,
        koreanName: boss.koreanName,
        difficulty: boss.difficulty,
        isSeason: boss.cycle === "season",
        shareMeso: boss.shareMeso,
        partySize: boss.defaultPartySize,
      })),
    }));

  const totalCount = remaining.items.length;
  return {
    title: scope === "monthly" ? "남은 월간 보스" : "남은 주간 보스",
    resetNote: scope === "monthly" ? "매월 1일 초기화" : resetLabel(now),
    /*
      ⚠️ `homeworkSummaryLine` 과 **글자가 같아야 한다**(이 모형이 존재하는 이유가 그것이다).
         그쪽은 `HomeworkCard` 를 받으므로 여기서는 부를 수 없어 같은 식을 적는다 —
         한쪽을 고치면 다른 쪽도 고칠 것. 이 값은 그림이 아니라 웹 화면이 쓴다.
    */
    summary: `남은 ${String(totalCount)}건 · ${formatMesoCompact(remaining.totalMeso)}`,
    headCountLabel: `${String(totalCount)}건`,
    headMesoLabel: formatMesoCompact(remaining.totalMeso),
    /*
      ⚠️ 그림은 사유 줄을 그리지 않는다(`card.png/route.tsx` 머리말 *"없앤 것 2"*). 그리고
         그 사유들(`…외 N건` · `2억 이하 결정석 N건`)은 **평문의 자르기를 설명하는 말**이라,
         자르지 않는 이 경로에서는 애초에 참이 아니다. 빈 배열이 정확하다.
    */
    notes: [],
    rows,
    emptyLabel: totalCount === 0 ? "남은 보스 없음" : null,
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
