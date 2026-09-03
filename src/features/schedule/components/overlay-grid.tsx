"use client";

import { TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";

import { Numeric, SeatNumber, formatKstShort } from "@/components/domain";
import {
  DAY_MINUTES,
  describeDayMinute,
  formatDayMinute,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { participantLabel } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  RunCommitment,
  TimeRange,
} from "@/types/domain";

import { exceptionSpan } from "../lib/exception-span";
import {
  axisOverflowOf,
  buildDayRows,
  buildOverlayGapMap,
  pickDragTargetSegment,
  projectToDayRows,
  toAxisBox,
  toAxisPercent,
  type AxisOverflow,
  type DayRow,
  type OverlayAxis,
  type OverlayGapSegment,
} from "../lib/overlay-layout";

/**
 * 겹쳐보기 시간표 본체 (§1.4 왼쪽 패널).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 이 모양인가
 * ─────────────────────────────────────────────────────────────────────────────
 * **행 = 하루, 가로축 = 시각.** 사람을 세로로 쌓아 같은 x 좌표가 같은 시각이 되게 했다.
 * 겹침은 "세로로 막대가 몇 개 겹쳐 있는가"로 바로 읽히고, 그 위에 **겹침 밴드**가
 * 확정된 답("21:00~23:00 · 6명")을 한 줄로 요약한다.
 *
 * 사람마다 색을 다르게 주지 **않았다.** 6색을 새로 만들면 디자인 토큰 밖으로 나가고,
 * 색이 6개면 정작 중요한 신호(겹침 농도)가 묻힌다. 사람 구분은 **이름**이 하고
 * 색 채널은 겹침 인원 하나에만 쓴다. 그 사다리는 **5단**이고 판정 기준은 비율이 아니라
 * **인원수**다 — 근거는 아래 `overlapToneClass` 머리말.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 시간축은 **겹침 주변으로 좁힐 수 있다** (기본값)
 * ─────────────────────────────────────────────────────────────────────────────
 * 합집합 축은 누군가 "휴무 00:00~24:00" 을 하루 찍으면 하루 전체로 벌어지고, 정작
 * 볼 저녁 두세 시간이 눌린다. 그래서 축을 **계산된 값(`axis`)으로 받는다** — 좁힐지
 * 말지의 판단과 계산은 부모(`availability-panel`)가 한 번만 하고, 가로·세로 두 격자와
 * 범례가 그 한 벌을 나눠 쓴다. 잘린 쪽은 반드시 `AxisEdgeMarkers` 가 말한다:
 * **자르는 대신 잘렸음을 말한다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 행 라벨은 **이름**이다 (번호가 아니다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 레인 왼쪽에 번호만 찍었는데, 날짜 옆에 맨숫자가 세로로 늘어서니
 * **요일 번호처럼 읽혔다**(실제로 그렇게 읽혔다). 사람의 주 식별자는 이름이고
 * 번호는 카톡에서 부르기 위한 보조 식별자다. 그래서 `③ 미르` 처럼 배지 + 이름으로 둔다.
 * 날짜 거터도 **요일을 가장 크게** 둔다 — 스케줄 화면에서는 "며칠"보다 "무슨 요일"이
 * 먼저 읽혀야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자정 넘김 (22:00~02:00)
 * ─────────────────────────────────────────────────────────────────────────────
 * 가로축을 24:00 에서 끊지 않는다. 축은 `24:00`, `27:00` 으로 이어지고 구간은
 * **하나의 사각형**으로 그려진다. 24:00 위치에는 점선 구분선을 둔다.
 * 하루를 24시간으로 자르면 이 구간이 두 행으로 쪼개져 "밤 10시부터 새벽 2시까지"라는
 * 한 덩어리가 화면에서 사라진다(DB 가 `end_minute > 1440` 을 허용한 이유와 같다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 예외(특이사항)를 어떻게 그리는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 예외는 **뺄셈 전용**이라 해석 결과에는 "짧아졌다"는 사실만 남고 이유가 사라진다(§1.4).
 * 그래서 예외를 **별도 레이어로 그 사람 레인 위에 겹쳐 그린다** — tertiary 점선 블록.
 * 색은 red 가 아니라 tertiary orange 다. red 는 실패·취소 전용이고, 예외는 실패가 아니다(§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 좁은 화면(360px) — **줄이지 않고 접는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 앱의 핵심(§1.4)이라 **정보를 잃는 축소는 금지**다. 예전에는 폭에 상관없이
 * `min-w-[48rem]`(768px) 를 걸고 가로 스크롤에 맡겼는데, 360px 기기에서 실제로 보이는
 * 부분은 전체의 **38%** 였다. 가로 스크롤은 "세로로 겹침을 읽는다"는 이 표의 작동
 * 원리와 정면으로 충돌한다 — 화면 밖에 있는 사람의 막대는 겹쳐 볼 수가 없다.
 *
 * 그래서 가로로 줄이는 대신 **가로로 쓰던 것을 세로로 접었다.** 바뀌는 것은 두 가지뿐이다.
 *   1. **날짜 거터가 행 위로 올라간다.** `목 8/20` 이 왼쪽 고정 열(w-16, 64px)이 아니라
 *      그 날 묶음의 머리글 한 줄이 된다 → 시간축에 64px 이 통째로 돌아온다.
 *   2. **이름 거터가 w-20 → w-14 로 좁아진다**(80px → 56px). 이름은 원래도
 *      `truncate` + `title` 이었으므로 표현 방식이 바뀌지 않는다.
 * 남는 시간축은 360px 기준 **234px**(= 296 − 56 − 6). 저녁 시간대(18:00~27:00)라면
 * 3시간 눈금이 78px 간격으로 찍혀 눈금 라벨이 겹치지 않는다.
 *
 * ★ **행·레인·축·겹침밴드·예외 블록 중 사라지는 것은 하나도 없다.** 요일 × 시각 격자와
 *   "세로로 몇 개가 겹치는가"라는 읽기 방식이 그대로 유지된다. 접는 것과 지우는 것은
 *   다르며, 여기서 한 것은 접는 쪽이다.
 * ★ `md`(768px) 이상에서는 예전 동작이 **그대로**다 — `min-w-[48rem]` 과 가로 스크롤이
 *   다시 붙는다. 2단 레이아웃의 왼쪽 칸은 1024px 화면에서도 768px 이 안 되기 때문이다.
 */

/*
 * 레인 트랙의 좌측 여백(= 이름 거터 폭 + `gap-1.5`)은 **폭에 따라 달라진다.**
 *   좁은 폭: `w-14`(3.5rem) + 0.375rem = 3.875rem
 *   md 이상: `w-20`(5rem)   + 0.375rem = 5.375rem
 * 눈금 세로선(`AxisRules`)은 절대 배치라 이 값을 인라인 style 로 알아야 하는데,
 * 인라인 style 에는 미디어 쿼리를 쓸 수 없다. 그래서 값을 **CSS 변수**
 * `--lane-gutter` 로 내려 준다 — 변수는 상속되므로 브레이크포인트마다 한 번만
 * 선언하면 되고, 거터 폭과 눈금선이 갈라질 수 없다.
 */

/**
 * 겹침 밴드 라벨을 어느 폭부터 보여 줄지. 좁은 창에서 글자가 잘리는 대신
 * 단계적으로 줄인다(`6명` → `6` → 없음). 정보는 `aria-label`·`title` 이 항상 갖는다.
 */
const LABEL_FULL_MIN_WIDTH_PCT = 6;
/*
 * ★ 3 → 1.5 로 내렸다(2026-09-03). 색이 인원수를 나르게 된 이상 **숫자가 색의 짝**이라
 *   웬만하면 함께 보여야 한다(§4 — 색만으로 정보를 전달하지 않는다).
 *
 * ⚠️ **이 값은 가로 밴드 전용이고, 재는 서체는 `text-body-sm` — 14px bold 다.**
 *    (예전 주석은 `11px 서체 기준` 이라고 적었는데 그건 세로 격자의 `text-overline`
 *     값이었다. 두 격자는 서체가 다르므로 근거를 섞어 적으면 다음 사람이 문턱을 잘못
 *     옮긴다.) 가로 격자의 레인은 `md:min-w-[48rem]` 이 보장하는 682px 이상이라
 *    1.5% ≈ 10.2px 이고, 14px bold 숫자 한 자리는 ~8px 이므로 잘리지 않고 들어간다.
 *    그보다 얇은 막대는 글자를 넣으면 조각만 보여 오히려 못 읽으므로 비우고, 인원수는
 *    `aria-label`·`title` 이 계속 들고 있는다.
 */
const LABEL_SHORT_MIN_WIDTH_PCT = 1.5;

/**
 * 세로 격자에서 숫자를 넣을 최소 **높이**(%). 가로와 값이 다른 이유는 재는 축도 서체도
 * 다르기 때문이다 — 세로 트랙은 최소 260px 이라 4% ≈ 10.4px, `text-overline`(11px) 한
 * 줄이 겨우 들어간다.
 *
 * ⚠️ 이 문턱이 `LABEL_SHORT_MIN_WIDTH_PCT`(1.5) 보다 **크므로**, 세로 격자에서
 *    `bandCountLabel` 의 1.5% 하한은 절대 걸리지 않는다. 세로에서 실제로 일하는 갈림은
 *    `LABEL_FULL_MIN_WIDTH_PCT`(6) 하나뿐이다(`6명` vs `6`). 1.5 를 세로 기준으로
 *    읽지 말 것 — 가로에서만 의미가 있는 값이다.
 */
export const DAY_LABEL_MIN_HEIGHT_PCT = 4;

export interface OverlayGridProps {
  readonly range: TimeRange;
  /** 그 파티의 구성원 전원. 표시 순서는 번호 오름차순(연속이 아닐 수 있다). */
  readonly members: readonly PartyMember[];
  readonly intervals: readonly AvailabilityInterval[];
  readonly overlapWindows: readonly OverlapWindow[];
  /** 제외 구간(특이사항). 해당 사람 레인 위에 겹쳐 그린다. */
  readonly exceptions: readonly AvailabilityException[];
  /**
   * **이미 등록된 보스 일정이 잡아먹은 시간.**
   *
   * ★ 겹침 밴드(`overlapWindows`)에서는 이 구간이 **이미 빠져 있다**(DB
   *   `availability_overlap` 이 뺀다). 그런데 개인 레인의 막대는 여전히 전체를 그리므로,
   *   이 블록을 겹쳐 그리지 않으면 "막대는 가능이라는데 겹침은 왜 없지?" 가 된다.
   *   조용히 줄어드는 것이 가장 나쁜 경우라, **무엇이 막았는지를 이름과 함께** 보인다.
   * ★ 제외(특이사항) 블록과 같은 레이어 방식이지만 **색이 다르다** — 제외는 tertiary
   *   점선(사람이 안 된다고 말한 시간), 이것은 secondary 실선(이미 쓰기로 한 시간).
   *   둘은 원인이 다르고 사용자가 할 일도 다르다(패턴 수정 vs 일정 수정).
   */
  readonly commitments: readonly RunCommitment[];
  /**
   * 겹침 창을 만든 **최소 인원**.
   *
   * 표시에는 쓰지 않고 **빈칸의 원인 판정**에만 쓴다(`buildOverlayGapMap`). 어떤 빈칸을
   * "잡힌 일정 때문"이라고 부르려면 *그 일정만 없었으면 겹침이 생겼어야* 하고, 겹침은
   * 이 인원 이상일 때만 생기기 때문이다. 이 값 없이 판정하면 애초에 두 명뿐이라 잡을 수
   * 없던 시간까지 일정 탓으로 뒤집어씌운다.
   */
  readonly minCount: number;
  /**
   * 그릴 시간축. (2026-09-03 발주: *"겹침 주변에 +- 2시간정도씩만 보여주는게
   * 좋을거같기도 하고... 저 휴무때문에 시간대가 이상해"*)
   *
   * ★ **축은 이미 계산되어 내려온다 — 여기서 다시 계산하지 않는다**(2026-09-03 재작업).
   *   예전에는 `axisScope` 만 받아 격자가 각자 `computeScopedOverlayAxis` 를 돌렸고,
   *   같은 축이 **가로·세로·패널 세 군데서 따로** 계산됐다. 그 함수가 함께 돌려주는
   *   `canNarrow` / `isNarrowed` 를 격자가 버리는 바람에 범례와 토글 설명문은 그 값을
   *   **토글 상태로 재유도**했고, ±2시간 창이 합집합 축을 통째로 덮는 흔한 경우
   *   (`isNarrowed === false`)에 화면에 없는 이어짐 표식을 설명하게 됐다.
   *   → 부모(`availability-panel`)가 한 번 계산해 `axis` · `isNarrowed` 를 **한 벌로**
   *     내려보낸다. 한 곳에서 나오므로 셋이 어긋날 수가 없다.
   * ★ 폭이 바뀌어도 두 격자가 같은 축을 그려야 한다 — 폭에 따라 축이 달라지면 한
   *   화면이 두 가지 답을 하게 된다.
   */
  readonly axis: OverlayAxis;
  readonly selectedWindowKey: string | null;
  /**
   * 겹침을 골랐다. **`startsAt` 이 오면 그 시각**, 없으면 겹침의 시작 시각이다.
   *
   * 두 번째 인자가 생긴 이유는 드래그다(위 `DRAG_STEP_MINUTES` 머리말) — 넓은 겹침
   * 안에서 시작점을 옮길 수 있어야 하고, 그 값은 겹침 자체가 아니라 **포인터 위치**에서
   * 나온다.
   *
   * ★ **클릭도 이제 그 시각을 보낸다**(2026-08-20). 예전에는 클릭이 인자 없이 불러
   *   겹침의 시작 시각으로 되돌렸는데, 호버 표시가 가리키던 시각과 어긋났다. 인자가
   *   없는 호출은 이제 **포인터 좌표를 읽지 못한 경우**에만 남는다.
   */
  readonly onSelectWindow: (window: OverlapWindow, startsAt?: Date) => void;
  /*
    ★ **여기에는 플레이헤드가 없다**(발주 지시 2026-08-25: *"데스크탑엔 선이 필요가
      없음. 호버링시에 시간이 나오니까."*). 넓은 화면에서는 겹침 막대에 마우스를
      올리면 그 자리의 시각이 따라다니고(`dragHint`), 누르면 그 시각이 그대로 쓰인다.
      선은 그 위에 아무것도 더하지 못하면서 격자만 한 겹 더 덮었다.
      선이 필요한 쪽은 **포인터가 없는 화면**이다 — `overlay-day-grid` 가 갖는다.
  */
  /**
   * 겹침을 **클릭**했다 — 등록 모달을 연다 (발주 지시 2026-08-25: *"겹치는부분을
   * 클릭하면 바로 일정 생성 모달이 들어가면좋을거같음"*).
   *
   * ★ `onSelectWindow` 와 **다른 사건**이다. 그쪽은 드래그 중에도 계속 불리므로,
   *   거기서 모달을 열면 막대를 끄는 내내 창이 떴다 닫힌다. 이 콜백은 **클릭 한 번**에만
   *   불린다(드래그 뒤 따라오는 click 은 `movedRef` 가 이미 삼킨다).
   */
  readonly onOpenComposer: () => void;
}

/** 제외 블록 하나 — 사람 레인 위에 그리기 위한 절대 시각 구간. */
interface ExceptionBlock {
  readonly id: string;
  readonly personId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly isAllDay: boolean;
  readonly note: string | null;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 겹침 **인원수** → 밴드 색 농도 (5단)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-03): *"겹침을 색마다 다르게 하여 2명이상 겹치는 부분을 투명도 차이나
 * 색 차이로 보이게 해줘 누가봐도 아 이게 더 많이 겹치는군 할수있는 색으로"*.
 *
 * ★ **비율이 아니라 절대 인원수로 판정한다**(2026-09-03 정정). 예전에는 `count / total`
 *   이었는데, 그러면 6인 파티의 2명(0.33)과 3인 파티의 1명이 같은 색이 되고 — 무엇보다
 *   최소 인원 기본값이 `전원`이라 **모든 밴드의 비율이 1.0**, 즉 화면 전체가 한 색이었다.
 *   사용자가 묻는 것은 "몇 명이 겹치나"이지 "정원의 몇 %인가"가 아니다. 이 파일 머리말과
 *   §4 도 *"색 채널은 겹침 인원 하나에만 쓴다"* 고 적어 두었는데, 구현이 그 서술과
 *   어긋나 있었다.
 *
 * ★ **`count === total`(전원)은 인원수와 무관하게 최고 단**이다. 3인 파티의 3명은 6인
 *   파티의 6명과 **같은 뜻**("더 부를 사람이 없다")이고, 그것이 이 화면에서 가장 좋은
 *   소식이다. 절대 인원수만 보면 3인 파티는 최고 단에 영영 닿지 못한다.
 *
 * ★ 5단인 이유: 6인 파티에서 2·3·4·5·6명이 **전부 갈려야** "누가 봐도 더 많이 겹치는군"이
 *   된다. 4단이면 반드시 두 인원이 한 색을 쓴다.
 *
 * ★ 세로 배치(`overlay-day-grid`)도 **이 함수를 쓴다**(2026-08-25). 같은 인원수가
 *   화면 폭에 따라 다른 색이 되면 안 되고, 임의의 알파 값은 다크 모드에서 단계가
 *   뭉갠다(§4 — 밀도 부호는 테마마다 다시 조정된 값이어야 한다).
 *
 * ⚠️ 색은 **유일한 단서가 아니다.** 밴드에는 인원수가 숫자로 함께 찍히고(`bandCountLabel`)
 *    `aria-label`·`title` 도 인원수를 말한다 — 색만으로 정보를 나르지 않는다는 §4 규칙.
 */
export function overlapToneClass(count: number, total: number): string {
  /*
    ⚠️ **1명은 겹침이 아니다 — 최고 단이 아니라 최저 단으로 떨어뜨린다.**
    발주 문장이 *"**2명이상** 겹치는 부분을"* 이라고 한정한 자리다. 그런데 최소 인원
    하한이 1 이라(`schedule-workspace` 의 `Math.max(..., 1)`, SQL 하한도 1) 파티원을
    **한 명만 고르면** `availableCount === 1` 인 창이 실제로 내려온다. 그때 아래
    `count >= total` 이 먼저 걸려 1명짜리 창이 "가장 많이 겹침" 색으로 칠해졌다 —
    겹친 사람이 0명인데 화면이 최고 농도라고 말한 셈이다.
    이 하한은 `count >= total` **앞**에 있어야 뜻이 산다.
  */
  if (count < 2) return "bg-overlap-1 text-overlap-1-fg";
  // 전원은 인원수와 무관하게 최고 단.
  if (total > 0 && count >= total) return "bg-overlap-5 text-overlap-5-fg";
  if (count >= 6) return "bg-overlap-5 text-overlap-5-fg";
  if (count >= 5) return "bg-overlap-4 text-overlap-4-fg";
  if (count >= 4) return "bg-overlap-3 text-overlap-3-fg";
  if (count >= 3) return "bg-overlap-2 text-overlap-2-fg";
  return "bg-overlap-1 text-overlap-1-fg";
}

/** 범례 한 칸 — **같은 색으로 묶이는 인원수 구간**. */
export interface OverlapLegendStep {
  /** `overlapToneClass` 가 그대로 돌려준 값. 여기서 새로 조립하지 않는다. */
  readonly className: string;
  readonly from: number;
  readonly to: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 범례를 **사다리 함수로부터 생성한다** — 손으로 적지 않는다 (2026-09-03 재작업)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 무엇이 문제였나: 범례가 `2 3 4 5 6명+` 다섯 칸을 **정원과 무관하게 고정으로** 그렸다.
 * 그런데 `overlapToneClass` 는 `count >= total` 을 최고 단으로 올리므로 실제 대응은
 * 정원마다 다르다.
 *
 * ```
 *          2명  3명  4명  5명  6명
 *   6인    o1   o2   o3   o4   o5
 *   5인    o1   o2   o3   o5    —
 *   4인    o1   o2   o5    —    —
 *   3인    o1   o5    —    —    —
 *   2인    o5    —    —    —    —
 * ```
 *
 * 3인 파티에서 고정 범례는 "3명 = o2" 라고 말했지만 실제 색은 o5 였고, o2·o3·o4 는
 * **그 화면에서 렌더될 수 없는 색**이었다. §1 이 최신 보스 `max_party` 3 · 익스트림 스우
 * 2 라고 못 박았으므로 2~5인이 오히려 상시 케이스다 — 범례가 상시로 거짓말을 한 셈이다.
 *
 * ★ 그래서 라벨을 적는 대신 **`overlapToneClass` 를 실제로 호출해 만든다.** `count` 를
 *   2부터 `total` 까지 돌려 나온 클래스를 그대로 스와치에 쓰므로, 사다리를 나중에 어떻게
 *   바꾸든 범례는 **구조적으로 거짓말할 수 없다.**
 * ★ 같은 색이 연속으로 나오면 한 칸으로 합치고 라벨을 범위(`6~8명`)로 적는다.
 *   합치지 않으면 정원 7인 이상에서 같은 색 스와치가 나란히 반복된다.
 * ★ 1명은 겹침이 아니므로(`overlapToneClass` 의 `count < 2` 하한) 2부터 돈다.
 *   `total <= 1` 이면 **빈 배열**이고, 호출부는 사다리를 통째로 그리지 않는다.
 */
export function overlapLegendSteps(
  total: number,
): readonly OverlapLegendStep[] {
  const steps: OverlapLegendStep[] = [];
  for (let count = 2; count <= total; count += 1) {
    const className = overlapToneClass(count, total);
    const last = steps.at(-1);
    if (last && last.className === className) {
      steps[steps.length - 1] = { ...last, to: count };
      continue;
    }
    steps.push({ className, from: count, to: count });
  }
  return steps;
}

/**
 * 범례 칸의 라벨. `명` 은 **마지막 칸에만** 붙인다 — 칸마다 붙이면 숫자열이 길어져
 * 사다리가 사다리로 안 보인다(예전 `2 3 4 5 6명+` 의 리듬을 그대로 유지한다).
 */
export function overlapLegendStepLabel(
  step: OverlapLegendStep,
  isLast: boolean,
): string {
  const range =
    step.from === step.to ? `${step.from}` : `${step.from}~${step.to}`;
  return isLast ? `${range}명` : range;
}

/**
 * 밴드 안에 찍는 인원수 — `6명` → `6` → (자리가 없으면) 빈 문자열.
 *
 * ⚠️ **색의 짝이지 장식이 아니다.** 겹침 농도가 인원수를 뜻하게 된 이상(위
 *    `overlapToneClass`), 숫자가 없으면 색이 유일한 단서가 되어 §4 를 어긴다.
 *    빈 문자열로 떨어지는 것은 글자가 물리적으로 안 들어가는 폭뿐이고, 그때도
 *    `aria-label`·`title` 은 인원수를 말한다.
 *
 * ⚠️ **문턱 두 개는 가로 격자(`text-body-sm`, 14px bold) 기준으로 잡혔다.** 세로
 *    격자는 호출 전에 `DAY_LABEL_MIN_HEIGHT_PCT`(4) 로 이미 걸러 넣으므로 1.5% 하한이
 *    거기서는 발동하지 않는다 — 세로에서 갈리는 것은 6% 하나뿐이다.
 */
export function bandCountLabel(count: number, sizePct: number): string {
  if (sizePct >= LABEL_FULL_MIN_WIDTH_PCT) return `${count}명`;
  if (sizePct >= LABEL_SHORT_MIN_WIDTH_PCT) return `${count}`;
  return "";
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 축이 잘린 쪽에 **"여기서 끝난 게 아니다"**를 표시한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 시간축을 겹침 주변으로 좁히면(`computeScopedOverlayAxis`) 개인 막대와 잡힌 일정이
 * 화면 밖으로 이어질 수 있다. `overlay-layout.ts` 머리말이 *"어느 한쪽이라도 잘리면
 * 거짓말이 된다"* 고 못 박은 자리인데, 이제는 **자르는 대신 잘렸음을 말하는** 것으로
 * 그 규칙을 지킨다 — 표시가 없으면 사용자는 "저 사람은 여기까지만 된다"로 읽는다.
 *
 * ★ 색은 `ink` + `surface` 링이다. 겹침 사다리가 라이트에서 어둡고 다크에서 밝아지는
 *   반면 이 표식은 **테마마다 방향이 같이 뒤집히고**, 링이 흰/검은 후광을 만들어 다섯
 *   단 중 어느 색 위에 얹혀도 보인다(플레이헤드가 `ring-playhead-edge` 로 쓰는 방법과
 *   같다). 겹침 램프 안의 색을 쓰면 반드시 어느 한 단에서 묻힌다.
 * ★ 의미를 색으로만 나르지 않도록 `sr-only` 문장을 함께 둔다 — **다만 부모가
 *   `role="img"` 인 곳은 예외**다. 자세한 이유는 `description` 주석.
 */
export function AxisEdgeMarkers({
  overflow,
  orientation,
  description,
}: {
  readonly overflow: AxisOverflow;
  /** 시간축 방향. 가로 격자는 좌우, 세로 격자는 위아래에 붙는다. */
  readonly orientation: "horizontal" | "vertical";
  /**
   * 무엇이 이어지는지 — `sr-only` 문장의 주어(예: `금 8/21 우레푸`).
   *
   * ⚠️ **`null` 은 "부모가 이미 말했다"는 뜻이고, 그때 `sr-only` 를 아예 만들지
   *    않는다.** 부모가 `role="img"` + `aria-label` 이면 ARIA 상 그 자손은 전부
   *    presentational 이 되어 안쪽 `sr-only` 가 접근성 트리에서 통째로 빠진다 —
   *    렌더는 되지만 아무에게도 도달하지 않는 죽은 노드다. 그런 자리에서는 부모의
   *    `aria-label` 이 **잘리지 않은 실제 시각**을 이미 말하므로 잃는 정보도 없다.
   *    그래서 문자열을 넘기는 대신 `null` 로 "여기서는 필요 없다"를 명시한다.
   */
  readonly description?: string | null;
}) {
  if (!overflow.before && !overflow.after) return null;

  return (
    <>
      {overflow.before ? (
        <span
          className={cn(
            "pointer-events-none absolute z-10 bg-ink ring-1 ring-surface",
            orientation === "horizontal"
              ? "inset-y-0 left-0 w-[3px] rounded-l-sm"
              : "inset-x-0 top-0 h-[3px] rounded-t-sm",
          )}
        >
          {description == null ? null : (
            <span className="sr-only">
              {description} 보이는 시간대보다 앞으로 더 이어집니다
            </span>
          )}
        </span>
      ) : null}
      {overflow.after ? (
        <span
          className={cn(
            "pointer-events-none absolute z-10 bg-ink ring-1 ring-surface",
            orientation === "horizontal"
              ? "inset-y-0 right-0 w-[3px] rounded-r-sm"
              : "inset-x-0 bottom-0 h-[3px] rounded-b-sm",
          )}
        >
          {description == null ? null : (
            <span className="sr-only">
              {description} 보이는 시간대보다 뒤로 더 이어집니다
            </span>
          )}
        </span>
      ) : null}
    </>
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 빈칸 표시 — **왜 비었는지**만 말한다 (계산은 `lib/overlay-layout.ts`)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 이 표시는 **막대를 잇는 장치가 아니다.** 빈칸은 데이터가 진짜로 끊긴 자리이고,
 *    이으면 못 가는 시간이 갈 수 있는 시간으로 그려진다(§1.4 거짓 available 금지 —
 *    자세한 근거는 `overlay-layout.ts` 의 같은 제목 절).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 경우를 어떻게 그리는가
 * ─────────────────────────────────────────────────────────────────────────────
 *  (a) **전원이 다른 일정에 걸림** — secondary 빗금 + secondary 실선 테두리.
 *      테두리가 닫힌 상자를 만들어 "여기는 통째로 막혔다"가 형태로 읽힌다.
 *  (b) **일부만 걸림** — 같은 빗금, **테두리 없음**. 열린 빗금 = 일부는 통과.
 *  (c) **그냥 안 겹침** — **아무것도 칠하지 않는다.** 비어 있는 트랙 자체가 그 답이고,
 *      대신 투명한 구간이 `title`·`aria-label` 로 사유를 들고 있다.
 *
 * ★ 왜 (a)/(b) 에 **색을 하나 더 만들지 않았는가**: 두 경우는 원인이 같고("이미 잡힌
 *   일정이 먹었다") 사용자가 할 일도 같다(그 일정을 옮긴다). 다른 것은 **양**(몇 명이
 *   걸렸나)뿐인데, 양은 숫자로 적는 것이 색 단계보다 정확하다. 게다가 이 밴드는 이미
 *   **농도 = 겹침 인원**이라는 색 부호를 쓰고 있어(이 파일 머리말), 색을 하나 더 넣으면
 *   정작 중요한 신호가 묻힌다. 그래서 형태(테두리)와 숫자로 가른다.
 * ★ 왜 (c) 를 칠하지 않았는가: 칠하려면 3:1 을 넘는 색이 필요한데, 그만큼 진한 표시를
 *   빈칸마다 깔면 밴드가 표시로 뒤덮여 정작 겹침 막대가 안 보인다. 3:1 미만의 옅은 색을
 *   쓰면 §4 를 어기면서 아무것도 못 읽게 된다. "빗금이 없으면 시간이 안 맞는 것"은
 *   범례가 글자로 말한다 — 색만으로 정보를 전달하지 않는다는 규칙과도 맞는다.
 * ★ secondary 를 쓴 이유: 개인 레인의 **이미 잡힌 일정**이 이미 secondary 실선이다.
 *   같은 사실을 같은 색으로 말해야 두 층이 한 이야기로 읽힌다. tertiary 는 제외(특이사항),
 *   red 는 실패·취소 전용이라 둘 다 쓸 수 없다(§4).
 *
 * 대비(면·경계 3:1 기준, `--color-secondary` vs 트랙 `--color-neutral-100`):
 *   라이트 #106b7d / #f4f4f5 = **5.58:1** · 다크 #3fd3ec / #212127 = **8.96:1**.
 *   숫자 배지(`text-secondary`, 11px 700)는 같은 쌍이라 4.5:1 도 함께 넘는다.
 */
export const OVERLAY_GAP_HATCH: CSSProperties = {
  /*
    색 정지점을 같은 좌표에 겹쳐 **하드 스톱**으로 만든다. 그래야 반투명 보간이 생기지
    않아 라이트/다크 어디서도 회색 테가 끼지 않는다. 원시 hex 가 아니라 디자인 토큰
    변수를 그대로 참조한다(§4).
  */
  backgroundImage:
    "repeating-linear-gradient(45deg, var(--color-secondary) 0 2px, transparent 2px 7px)",
};

/** 빗금 안에 들어가는 숫자 — `n명`. 자리가 없으면 숫자만, 더 없으면 생략. */
export function overlayGapBadge(
  gap: OverlayGapSegment,
  sizePct: number,
): string {
  if (gap.cause !== "booked") return "";
  if (sizePct >= LABEL_FULL_MIN_WIDTH_PCT) return `${gap.blockedCount}명`;
  if (sizePct >= LABEL_SHORT_MIN_WIDTH_PCT) return `${gap.blockedCount}`;
  return "";
}

/**
 * 빈칸 하나의 사유 문장. `title` 과 `aria-label` 이 **같은 문장**을 쓴다 — 마우스로 본
 * 사람과 읽어 주기로 들은 사람이 다른 설명을 들으면 그때부터 두 화면이 된다.
 * 형식은 겹침 막대의 `20:00~21:00 · 3명 가능` 을 따른다.
 */
export function overlayGapTitle(gap: OverlayGapSegment): string {
  const span = `${describeDayMinute(gap.startMinute)}~${describeDayMinute(gap.endMinute)}`;
  const bosses = gap.bossNames.join(", ");

  if (gap.cause === "booked") {
    return gap.isFullyBlocked
      ? `${span} · 이미 잡힌 일정 때문에 비었습니다 · 가능한 ${gap.availableCount}명 전원이 ${bosses}`
      : `${span} · 이미 잡힌 일정 때문에 비었습니다 · 가능한 ${gap.availableCount}명 중 ${gap.blockedCount}명이 ${bosses} → ${gap.availableCount - gap.blockedCount}명 남음`;
  }

  /*
    일정이 걸려 있어도 **그것만으로는 비지 않았을** 자리다(빼기 전 인원이 최소 인원에
    못 미친다). 원인을 일정에 돌리지 않고, 걸린 일정은 사실로만 덧붙인다.
  */
  return gap.blockedCount > 0
    ? `${span} · 시간이 안 맞습니다 · 이 시간 가능 ${gap.availableCount}명(그중 ${gap.blockedCount}명은 ${bosses})`
    : `${span} · 시간이 안 맞습니다 · 이 시간 가능 ${gap.availableCount}명`;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 겹침 막대 드래그 — **시작 시각을 그 자리에서 미세 조정한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"겹침 에서 누르는곳 있잖아. 거기 마우스 올리고 드래그하면 시간을
 * 세세하게 오른쪽으로 넘길수있게 해줘."*
 *
 * 그전에는 막대를 누르면 **언제나 그 겹침의 시작 시각**이 등록 폼에 들어갔다. 21:00~24:00
 * 처럼 넓은 겹침에서 22시에 시작하고 싶으면 폼의 시각 칸을 손으로 고쳐야 했다.
 *
 * ★ **클릭도 누른 자리의 시각을 쓴다**(2026-08-20 정정). 처음에는 "클릭은 예전처럼 겹침의
 *   시작 시각"으로 두었는데, 그 뒤 호버 표시가 붙으면서 **화면이 `20:00` 이라고 말해 놓고
 *   누르면 `18:00` 이 되는** 상태가 됐다(발주 지적). 익숙한 조작을 지키려던 판단이 새로
 *   생긴 표시와 모순된 것이다. 이제 클릭·드래그가 같은 계산을 쓴다.
 *   (드래그 뒤에 따라오는 `click` 은 아래 `movedRef` 가 한 번 삼킨다 — 그 경로는 그대로다.)
 * ★ 10분 단위로 스냅한다. 분 단위로 붙으면 21:07 같은 값이 나오고, 보스 일정에서 그
 *   정밀도는 의미가 없다.
 */
const DRAG_STEP_MINUTES = 10;

/**
 * 포인터 위치 → 축 위의 분 좌표.
 *
 * 기준은 막대 자신이 아니라 **레인 전체**(막대의 부모)다. 막대는 겹침 구간만큼만
 * 차지하므로 그 안에서 비율을 재면 축이 아니라 그 구간의 비율이 나온다.
 * 레인을 못 찾으면 `null` — 조용히 0분으로 접으면 엉뚱한 시각이 등록 폼에 들어간다.
 */
function pointerMinute(
  /*
    ★ **클릭(`MouseEvent`)도 받는다.** 쓰는 것은 `currentTarget` 과 `clientX` 뿐이라
      포인터 이벤트에 묶어 둘 이유가 없었고, 묶여 있던 탓에 `onClick` 이 이 함수를 쓰지
      못하고 겹침 시작 시각으로 되돌리는 버그가 생겼다(아래 `onClick` 주석).
  */
  event: {
    readonly currentTarget: HTMLButtonElement;
    readonly clientX: number;
  },
  axis: OverlayAxis,
): number | null {
  const lane = event.currentTarget.parentElement;
  if (lane === null) return null;
  const rect = lane.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const ratio = (event.clientX - rect.left) / rect.width;
  return axis.startMinute + ratio * (axis.endMinute - axis.startMinute);
}

/** 10분 단위로 스냅하고 겹침 구간 안으로 가둔다. */
function clampToSegment(
  minute: number,
  startMinute: number,
  endMinute: number,
): number {
  const snapped = Math.round(minute / DRAG_STEP_MINUTES) * DRAG_STEP_MINUTES;
  /*
    끝 시각 자체는 시작점이 될 수 없다 — 길이 0 짜리 일정이 된다. 한 칸 앞을 상한으로
    두되, 겹침이 한 칸보다 짧으면 시작점은 그 구간의 시작 하나뿐이다.
  */
  const last = Math.max(startMinute, endMinute - DRAG_STEP_MINUTES);
  return Math.min(Math.max(snapped, startMinute), last);
}

export function overlapWindowKey(window: OverlapWindow): string {
  return `${window.startsAt.toISOString()}|${window.endsAt.toISOString()}`;
}

function AxisTicks({ axis }: { axis: OverlayAxis }) {
  return (
    <div className="relative h-5">
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          style={{ left: `${toAxisPercent(tick, axis)}%` }}
          className={cn(
            /*
              ★ 타임테이블 눈금(`21:00`). 가로축에 일정 간격으로 찍히므로 자릿수 폭이
                제각각이면 눈금이 중심에서 흔들린다. `formatDayMinute` 는 ASCII 전용
                (`HH:mm`)이라 통째로 등폭이어도 한글이 섞이지 않는다.
                `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
            */
            /*
              좁은 폭에서는 12px 로 내려간다. 축이 넓어지면 눈금이 7개까지 늘어나는데,
              234px 짜리 레인에서 14px `HH:mm`(~42px)은 서로 겹친다. 12px 은 §4 가
              **수치 주석**에 허용한 크기이고, 이것은 문장이 아니라 눈금이다.
            */
            "font-mono absolute top-0 -translate-x-1/2 text-caption font-medium tabular-nums whitespace-nowrap md:text-body-sm",
            // 익일 눈금도 읽는 글자니 `tertiary-ink` — 12px 라 큰 텍스트 예외가 없고,
            // 면용 `tertiary` 로는 background 대비 3.77:1 로 AA 미달이었다.
            tick >= DAY_MINUTES ? "text-tertiary-ink" : "text-ink-label",
          )}
        >
          {formatDayMinute(tick)}
        </span>
      ))}
    </div>
  );
}

/** 눈금 세로선 + 자정(24:00) 구분선. 모든 레인 뒤에 한 번만 깔린다. */
function AxisRules({ axis }: { axis: OverlayAxis }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0"
      style={{ left: "var(--lane-gutter)" }}
    >
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          style={{ left: `${toAxisPercent(tick, axis)}%` }}
          className="absolute inset-y-0 w-px bg-border"
        />
      ))}
      {axis.hasOvernight &&
      axis.startMinute < DAY_MINUTES &&
      axis.endMinute > DAY_MINUTES ? (
        <span
          style={{ left: `${toAxisPercent(DAY_MINUTES, axis)}%` }}
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 border-l-2 border-dashed border-tertiary"
        />
      ) : null}
    </div>
  );
}

export function OverlayGrid({
  range,
  members,
  intervals,
  overlapWindows,
  exceptions,
  commitments,
  minCount,
  axis,
  selectedWindowKey,
  onSelectWindow,
  onOpenComposer,
}: OverlayGridProps) {
  /**
   * 지금 드래그 중인 막대의 키. `null` 이면 드래그가 아니다.
   * `movedRef` 는 **실제로 움직였는가** 를 기억해, 드래그 뒤 따라오는 `click` 이 시작
   * 시각으로 되돌려 놓는 것을 막는다(포인터를 떼면 브라우저가 click 을 한 번 더 쏜다).
   */
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /**
   * 커서 옆에 띄우는 시각 표시.
   *
   * 처음에는 **드래그 중에만** 떴다 (2026-08-19 발주자: *"클릭후 드래그할때 마우스쪽에
   * 팝업? 으로 몇시인지를 보여줘야 하고"*). 2026-08-20 에 **가리키기만 해도** 뜨도록
   * 넓혔다 (*"겹침 호버링시 시간이 추가정보로 나와야 되는데 클릭한채로 말고"*).
   *
   * 왜 그게 맞는가: 이 표시가 답하는 질문은 *"여기를 누르면 몇 시가 되는가"* 이고, 그건
   * **누르기 전에** 알아야 쓸모가 있다. 누른 뒤에만 보여 주면 사용자는 일단 눌러 보고
   * 확인한 다음 취소하거나 끌어서 고쳐야 했다 — 미리 보기가 미리 보이지 않았던 셈이다.
   *
   * 좌표는 **뷰포트 기준**(`position: fixed`)이다. 막대 안에 넣으면 폭이 좁을 때 잘리고
   * 격자가 밀릴 때 함께 밀린다 — 커서를 따라다니는 표시는 커서와 같은 좌표계에 둔다.
   */
  const [dragHint, setDragHint] = useState<{
    readonly x: number;
    readonly y: number;
    readonly text: string;
  } | null>(null);
  const movedRef = useRef(false);

  const dayRows = useMemo<readonly DayRow[]>(
    () => buildDayRows(range),
    [range],
  );

  const dayKeySet = useMemo(
    () => new Set(dayRows.map((row) => row.dayKey)),
    [dayRows],
  );

  const intervalSegments = useMemo(
    () =>
      projectToDayRows(
        intervals,
        dayKeySet,
        (item, index) => `${item.personId}-${index}`,
      ),
    [intervals, dayKeySet],
  );

  const windowSegments = useMemo(
    () =>
      projectToDayRows(overlapWindows, dayKeySet, (item) =>
        overlapWindowKey(item),
      ),
    [overlapWindows, dayKeySet],
  );

  const exceptionBlocks = useMemo<readonly ExceptionBlock[]>(
    () =>
      exceptions.map((exception) => {
        const span = exceptionSpan(
          exception.dayKey,
          exception.startMinute,
          exception.endMinute,
        );
        return {
          id: exception.id,
          personId: exception.personId,
          startsAt: span.startsAt,
          endsAt: span.endsAt,
          isAllDay:
            exception.startMinute === null && exception.endMinute === null,
          note: exception.note,
        };
      }),
    [exceptions],
  );

  const exceptionSegments = useMemo(
    () => projectToDayRows(exceptionBlocks, dayKeySet, (item) => item.id),
    [exceptionBlocks, dayKeySet],
  );

  const exceptionDayKeys = useMemo(
    () => new Set(exceptionSegments.map((segment) => segment.dayKey)),
    [exceptionSegments],
  );

  /**
   * 이미 잡힌 일정 블록. 같은 사람이 같은 시각에 두 파티의 런에 걸려 있을 수 있으므로
   * (그 자체가 사용자가 봐야 할 사실이다) 키에 `runId` 를 함께 넣는다.
   */
  const commitmentSegments = useMemo(
    () =>
      projectToDayRows(
        commitments,
        dayKeySet,
        (item, index) => `${item.personId}-${item.runId}-${index}`,
      ),
    [commitments, dayKeySet],
  );

  /*
    ★ **축은 `axis` prop 으로 받는다 — 여기서 계산하지 않는다.** 어떤 구간이 축을
      정의하는지(개인 · 겹침 · 잡힌 일정은 넣고, 하루 전체를 벌리는 제외 블록은 뺀다)와
      겹침 주변으로 좁힐지의 판단은 전부 `availability-panel` 이 한 번에 한다.
      그 함수가 함께 돌려주는 `isNarrowed` 를 여기서 버리면 범례가 화면에 없는
      이어짐 표식을 설명하게 된다(2026-09-03 재작업의 원인).
      잘린 레인마다 `AxisEdgeMarkers` 로 이어짐을 표시하는 책임은 그대로 여기 있다 —
      자르는 대신 잘렸음을 말하는 것이 축을 좁혀도 거짓말하지 않는 방법이다.
  */

  /*
    빈칸 사유. **행마다 다시 계산하지 않는다** — `dayRows.map` 안에서 부르면 7번 돌고
    렌더마다 다시 돈다. 세로 격자(`overlay-day-grid`)와 **같은 함수**를 쓴다.
  */
  const gapsByDay = useMemo(
    () =>
      buildOverlayGapMap({
        windows: windowSegments,
        intervals: intervalSegments,
        commitments: commitmentSegments,
        minCount,
      }),
    [windowSegments, intervalSegments, commitmentSegments, minCount],
  );

  const total = members.length;

  return (
    <div className="overflow-x-auto">
      {/* 모바일에서 눈금·이름이 뭉개지지 않도록 최소 폭을 주고 가로 스크롤한다. */}
      <div className="[--lane-gutter:3.875rem] md:min-w-[48rem] md:[--lane-gutter:5.375rem]">
        {/* 축 눈금 */}
        <div className="flex items-end gap-2 pb-1">
          {/* 날짜 거터 자리. 좁은 폭에서는 날짜가 행 위로 올라가므로 이 칸이 없다. */}
          <div className="hidden w-16 shrink-0 md:block" />
          <div className="flex min-w-0 flex-1 gap-1.5">
            <span className="w-14 shrink-0 md:w-20" />
            <div className="min-w-0 flex-1">
              <AxisTicks axis={axis} />
            </div>
          </div>
        </div>

        {dayRows.map((row) => {
          const rowWindows = windowSegments.filter(
            (segment) => segment.dayKey === row.dayKey,
          );
          const hasException = exceptionDayKeys.has(row.dayKey);
          const rowGaps = gapsByDay.get(row.dayKey) ?? [];
          /*
            밴드가 축 밖으로 이어지는가. 겹침 막대와 빈칸 사유를 **함께** 본다 —
            둘 다 밴드에 그려지므로 어느 쪽이 잘려도 밴드가 짧아 보인다.
          */
          const bandOverflow: AxisOverflow = axisOverflowOf(
            [...rowWindows, ...rowGaps],
            axis,
          );

          return (
            <div
              key={row.dayKey}
              className={cn(
                "flex flex-col gap-1 border-t border-border py-2.5 md:flex-row md:gap-2",
                row.isWeekend && "bg-neutral-50",
              )}
            >
              {/* 날짜 거터 — 요일이 가장 먼저 읽혀야 한다. */}
              <div className="flex shrink-0 items-baseline gap-1.5 md:w-16 md:flex-col md:items-start md:gap-0 md:pt-0.5">
                <p className="flex items-center gap-1 whitespace-nowrap">
                  <span
                    className={cn(
                      "text-body-lg font-bold",
                      // 주말 강조는 글자니 `tertiary-ink` — 면용 `tertiary` 는 라이트에서 3.77:1 로 AA 미달.
                      row.isWeekend ? "text-tertiary-ink" : "text-ink",
                    )}
                  >
                    {row.weekdayLabel}
                  </span>
                  {hasException ? (
                    <span
                      title="제외 시간이 있는 날입니다"
                      className="inline-flex text-tertiary"
                    >
                      <TriangleAlert aria-hidden size={14} />
                      <span className="sr-only">제외 시간 있음</span>
                    </span>
                  ) : null}
                </p>
                {/*
                  요일 레인의 날짜(`8/20`). 요일 행이 세로로 쌓이는 좌측 고정 열이라
                  `8/2` 와 `8/20` 의 폭이 다르면 열이 들쭉날쭉해진다. `dateLabel` 은
                  `M/d` 라 ASCII 전용이다(요일 한글은 바로 위 `weekdayLabel` 이 맡는다).
                */}
                <p className="text-body-sm text-ink-label tabular-nums whitespace-nowrap">
                  <Numeric>{row.dateLabel}</Numeric>
                </p>
              </div>

              {/* 레인 영역 */}
              <div className="relative min-w-0 flex-1">
                <AxisRules axis={axis} />

                {/* 겹침 밴드 — 이 화면의 답이 여기 있다. */}
                <div className="relative flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="w-14 shrink-0 text-right text-caption font-semibold text-ink-label md:w-20"
                  >
                    겹침
                  </span>
                  <div className="relative h-8 min-w-0 flex-1 rounded-sm bg-neutral-100">
                    {/*
                      ── 빈칸 사유 ────────────────────────────────────────────
                      겹침 막대 **뒤에** 깔린다(먼저 그린다). 구조상 막대와 겹치지
                      않지만, 뒤에 두면 반올림으로 1px 이 물려도 막대의 클릭·드래그를
                      가로챌 수 없다.
                      ⚠️ 이 표시는 빈칸을 **메우는** 것이 아니다 — 위 `OVERLAY_GAP_HATCH`
                         머리말(거짓 available 금지) 참조.
                    */}
                    <AxisEdgeMarkers
                      overflow={bandOverflow}
                      orientation="horizontal"
                      description={`${row.label} 겹침이`}
                    />

                    {rowGaps.map((gap) => {
                      const box = toAxisBox(
                        gap.startMinute,
                        gap.endMinute,
                        axis,
                      );
                      if (box.isOutside) return null;
                      const title = overlayGapTitle(gap);
                      const badge = overlayGapBadge(gap, box.width);

                      return (
                        <span
                          key={gap.key}
                          role="img"
                          aria-label={`${row.label} ${title}`}
                          title={title}
                          style={{
                            left: `${box.left}%`,
                            width: `${box.width}%`,
                            ...(gap.cause === "booked"
                              ? OVERLAY_GAP_HATCH
                              : null),
                          }}
                          className={cn(
                            "absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-sm",
                            // (a) 전원이 걸림 = 닫힌 상자. (b) 일부만 = 열린 빗금.
                            gap.cause === "booked" && gap.isFullyBlocked
                              ? "border border-secondary"
                              : null,
                          )}
                        >
                          {badge === "" ? null : (
                            <span
                              aria-hidden
                              className="text-overline font-bold text-secondary tabular-nums"
                            >
                              {badge}
                            </span>
                          )}
                        </span>
                      );
                    })}

                    {rowWindows.map((segment) => {
                      const window = segment.datum;
                      const box = toAxisBox(
                        segment.startMinute,
                        segment.endMinute,
                        axis,
                      );
                      if (box.isOutside) return null;
                      const key = overlapWindowKey(window);
                      const label = `${formatKstShort(window.startsAt)} ~ ${formatKstShort(window.endsAt)}`;
                      const text = bandCountLabel(
                        window.availableCount,
                        box.width,
                      );

                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={(event) => {
                            /*
                              드래그로 이미 시각을 정했으면 이 click 은 삼킨다 — 안 그러면
                              손을 떼는 순간 겹침 시작 시각으로 되돌아간다.
                            */
                            if (movedRef.current) {
                              movedRef.current = false;
                              return;
                            }
                            /*
                              ★ **누른 자리의 시각을 그대로 쓴다** (발주 지적 2026-08-20:
                                *"이거 뜬상태로 클릭해도 6시로 감"*).
                                예전에는 `onSelectWindow(window)` 만 불러 **겹침의 시작
                                시각**이 들어갔다. 호버 표시가 `20:00` 이라고 말해 놓고
                                누르면 `18:00` 이 되니, 화면이 방금 한 약속을 스스로
                                어긴 셈이다. 끌어야만 원하는 시각이 되는 것도 그래서였다 —
                                드래그 경로에만 이 계산이 있었다.
                              ★ 좌표를 못 읽으면(`null`) **인자 없이** 부른다. 그때의
                                겹침 시작 시각은 지어낸 값이 아니라 이 겹침의 사실이다.
                            */
                            const minute = pointerMinute(event, axis);
                            if (minute === null) {
                              onSelectWindow(window);
                            } else {
                              onSelectWindow(
                                window,
                                kstMoment(
                                  row.dayKey,
                                  clampToSegment(
                                    minute,
                                    segment.startMinute,
                                    segment.endMinute,
                                  ),
                                ),
                              );
                            }
                            /*
                              ★ 고르는 것과 **여는 것**이 한 동작이다(발주 지시
                                2026-08-25). 예전에는 고른 뒤 아래 `보스 일정 등록`
                                버튼을 따로 눌러야 했는데, 겹침을 누르는 행위 자체가
                                이미 "여기 잡겠다"는 뜻이다.
                            */
                            onOpenComposer();
                          }}
                          onPointerDown={(event) => {
                            movedRef.current = false;
                            setDraggingKey(key);
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                          }}
                          onPointerMove={(event) => {
                            const minute = pointerMinute(event, axis);
                            if (minute === null) return;
                            /*
                              ★ **끄는 동안에는 구간을 넘을 수 있다**(2026-08-31).
                                세로 격자와 **같은 결함**이 여기에도 있었다 —
                                `pointerMinute` 는 막대가 아니라 레인 전체를 기준으로
                                재므로 좌표는 진작 옆 구간까지 갔는데, `clampToSegment`
                                가 **누를 때의 막대**로 도로 가뒀다. 그래서 잡힌 일정이
                                겹침을 끊어 놓으면 오른쪽으로 아무리 끌어도 그 막대
                                끝에서 멈췄다. 이제 좌표가 속한 구간을 매번 다시 고른다
                                (빈칸 위에서는 가장 가까운 구간 — 규칙과 근거는
                                `lib/overlay-layout.ts` 의 `pickDragTargetSegment`).
                                가로축이라 좌우 드래그일 뿐 판정은 같은 함수다.
                              ★ **가리키기만 할 때는 넘지 않는다.** 호버 표시가 답하는
                                질문은 *"여기를 누르면 몇 시가 되는가"* 이고, 누르는 것은
                                커서 밑의 그 막대다. 넘겨 버리면 표시와 클릭 결과가
                                어긋나 2026-08-20 에 고친 그 모순이 되살아난다.
                              ★ 넘어간 뒤에도 겹침 **안쪽**으로만 붙인다. 밖으로 나간
                                시각은 그 자리에 사람이 다 있다는 보장이 없어서, 그대로
                                등록하면 화면이 "가능하다"고 거짓말한 셈이 된다(§1.4).
                              ★ 구간 후보는 `rowWindows` — **그 행(하루)치뿐**이라
                                끌어도 날짜는 바뀌지 않는다.
                            */
                            const target =
                              draggingKey === key
                                ? (pickDragTargetSegment(rowWindows, minute) ??
                                  segment)
                                : segment;
                            const snapped = clampToSegment(
                              minute,
                              target.startMinute,
                              target.endMinute,
                            );
                            /*
                              `26:00` 처럼 24 를 넘겨 적는다(`describeDayMinute`) — 자정을
                              넘긴 시각을 `02:00` 으로 되돌리면 어느 날인지 사라진다.
                            */
                            const hint = {
                              x: event.clientX,
                              y: event.clientY,
                              text: describeDayMinute(snapped),
                            };

                            if (draggingKey === key) {
                              setDragHint(hint);
                              /*
                                ★ `movedRef` 는 **드래그일 때만** 세운다. 가리키기만 한
                                  것으로 세우면 뒤따르는 `click` 이 삼켜져 한 번 눌러도
                                  선택이 안 된다.
                              */
                              movedRef.current = true;
                              /*
                                `window` 가 아니라 `target.datum` 이다 — 구간을 넘었으면
                                **넘어간 쪽 겹침**이 선택되어야 한다. 시각만 옮기고 창은
                                그대로 두면 등록 폼이 "이 겹침의 밖"을 가리키게 된다.
                              */
                              onSelectWindow(
                                target.datum,
                                kstMoment(row.dayKey, snapped),
                              );
                              return;
                            }

                            /*
                              ★ 끌지 않아도 **가리키는 자리의 시각**을 보여 준다.
                                마우스에서만 한다 — 터치·펜에는 "가리키기"가 없고, 손가락을
                                댄 순간은 이미 드래그라 위 분기가 맡는다.
                              ★ 상태만 바꾸고 선택은 건드리지 않는다. 가리켰다고 등록 폼의
                                시각이 바뀌면 마우스가 스쳐 지나가기만 해도 값이 흔들린다.
                            */
                            if (event.pointerType !== "mouse") return;
                            setDragHint(hint);
                          }}
                          onPointerLeave={() => {
                            // 드래그 중이면 포인터 캡처로 계속 따라오므로 지우지 않는다.
                            if (draggingKey === key) return;
                            setDragHint(null);
                          }}
                          onPointerUp={(event) => {
                            event.currentTarget.releasePointerCapture(
                              event.pointerId,
                            );
                            setDraggingKey(null);
                            setDragHint(null);
                          }}
                          onPointerCancel={() => {
                            setDraggingKey(null);
                            setDragHint(null);
                          }}
                          aria-pressed={selectedWindowKey === key}
                          aria-label={`${label} · ${window.availableCount}명 가능. 누르면 이 시간대로 일정 등록, 좌우로 끌면 시작 시각 조정`}
                          title={`${label} · ${window.availableCount}명 가능
누르면 시작 시각, 좌우로 끌면 ${DRAG_STEP_MINUTES}분 단위로 조정`}
                          style={{
                            left: `${box.left}%`,
                            width: `${box.width}%`,
                            /*
                              세로 스크롤은 살리고 가로 끌기만 우리가 가져간다. `none` 으로
                              막으면 모바일에서 막대 위에서 시작한 페이지 스크롤이 죽는다.
                            */
                            touchAction: "pan-y",
                          }}
                          className={cn(
                            "absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-sm",
                            /*
                              ★ `cursor-ew-resize` 였다(발주 지적 2026-08-20: *"커서도 그냥
                                포인터로 변경"*). 좌우 화살표 커서는 **크기 조절 손잡이**를
                                뜻하는 관용이라 "이 막대의 폭을 늘린다"로 읽힌다. 실제로 하는
                                일은 **누르면 그 시각이 선택되는 것**이고, 끌기는 그 위에
                                얹힌 미세 조정이다. 주된 동작이 클릭이면 커서도 클릭을
                                가리켜야 한다.
                            */
                            "cursor-pointer text-body-sm font-bold tabular-nums whitespace-nowrap transition duration-200",
                            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                            "hover:brightness-95",
                            overlapToneClass(window.availableCount, total),
                            selectedWindowKey === key &&
                              "ring-2 ring-primary ring-offset-1",
                          )}
                        >
                          {text}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 개인 레인 — 번호 순. 라벨은 이름이 주, 번호가 보조다. */}
                <div className="mt-1.5 flex flex-col gap-1">
                  {members.map((member) => {
                    const personSegments = intervalSegments.filter(
                      (segment) =>
                        segment.dayKey === row.dayKey &&
                        segment.datum.personId === member.personId,
                    );
                    const personExceptions = exceptionSegments.filter(
                      (segment) =>
                        segment.dayKey === row.dayKey &&
                        segment.datum.personId === member.personId,
                    );
                    const personCommitments = commitmentSegments.filter(
                      (segment) =>
                        segment.dayKey === row.dayKey &&
                        segment.datum.personId === member.personId,
                    );

                    const availableText =
                      personSegments.length === 0
                        ? "가능 시간 없음"
                        : personSegments
                            .map(
                              (segment) =>
                                `${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ");
                    const excludedText =
                      personExceptions.length === 0
                        ? ""
                        : ` · 제외 ${personExceptions
                            .map((segment) =>
                              segment.datum.isAllDay
                                ? "이 날 전체"
                                : `${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ")}`;
                    /*
                      `더저(메검메)` — 부캐로 참여 중이면 그 사실이 왼쪽 이름에도 보여야
                      한다. 조합 규칙은 `lib/domain/participant-label.ts` 가 소유한다.
                      한 줄 텍스트(툴팁·`aria-label`)에는 합쳐진 문자열을 쓴다.
                    */
                    /*
                      "이미 일정 있음"도 한 줄 설명에 넣는다. 화면 읽어 주기(`aria-label`)
                      만 쓰는 사람에게 이 정보가 빠지면, 왜 겹침이 없는지 알 길이 없다.
                    */
                    const bookedText =
                      personCommitments.length === 0
                        ? ""
                        : ` · 이미 일정 ${personCommitments
                            .map(
                              (segment) =>
                                `${segment.datum.shortName} ${describeDayMinute(segment.startMinute)}~${describeDayMinute(segment.endMinute)}`,
                            )
                            .join(", ")}`;
                    const label = participantLabel(member);
                    const description = `${label} · ${availableText}${excludedText}${bookedText}`;

                    return (
                      <div
                        key={member.personId}
                        className="flex items-center gap-1.5"
                      >
                        <span className="flex w-14 shrink-0 items-center gap-1 overflow-hidden md:w-20">
                          <SeatNumber
                            seatNo={member.seatNo}
                            size="sm"
                            tone="muted"
                          />
                          <span
                            title={label}
                            className="truncate text-body-sm text-ink-label"
                          >
                            {label}
                          </span>
                        </span>
                        <div
                          role="img"
                          aria-label={`${row.label} ${description}`}
                          className="relative h-5 min-w-0 flex-1 rounded-sm bg-neutral-100"
                        >
                          {/*
                            축을 좁히면 이 사람의 막대가 화면 밖으로 이어질 수 있다.
                            표시가 없으면 "저 사람은 여기까지만 된다"로 읽힌다.
                            ★ `description={null}` — 이 레인 컨테이너는 위에서
                              `role="img"` + `aria-label` 이라 **자손이 접근성 트리에서
                              통째로 빠진다.** 여기에 `sr-only` 를 두면 렌더는 되지만
                              아무에게도 도달하지 않는 죽은 노드가 된다. 그 `aria-label`
                              이 이미 **잘리지 않은 실제 시각**을 전부 말하므로 잃는
                              정보도 없다 — 이 표식은 눈으로 보는 쪽만을 위한 것이다.
                          */}
                          <AxisEdgeMarkers
                            overflow={axisOverflowOf(
                              [
                                ...personSegments,
                                ...personExceptions,
                                ...personCommitments,
                              ],
                              axis,
                            )}
                            orientation="horizontal"
                            description={null}
                          />

                          {personSegments.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );
                            if (box.isOutside) return null;

                            return (
                              <span
                                key={segment.key}
                                title={`${label} · ${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)}${
                                  segment.datum.note
                                    ? ` · ${segment.datum.note}`
                                    : ""
                                }`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm bg-available"
                              />
                            );
                          })}

                          {/*
                            제외 구간 — 패턴에서 깎여 나간 자리. 해석 결과에는 없는 정보라
                            예외 조회 결과로 따로 겹쳐 그린다.
                          */}
                          {personExceptions.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );
                            if (box.isOutside) return null;

                            return (
                              <span
                                key={segment.key}
                                title={`${label} · ${
                                  segment.datum.isAllDay
                                    ? `${row.label} 전체 제외`
                                    : `${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)} 제외`
                                }${segment.datum.note ? ` · ${segment.datum.note}` : ""}`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm border border-dashed border-tertiary bg-excluded"
                              />
                            );
                          })}

                          {/*
                            이미 등록된 일정 — **겹침에서 빠진 이유**가 여기 보인다.
                            제외 블록보다 뒤에 그려 위로 올라오게 둔다. 둘이 겹치는 경우
                            (제외한 시간에 잡힌 런)는 그 자체가 이상 신호라 더 강한 쪽이
                            보여야 한다.
                          */}
                          {personCommitments.map((segment) => {
                            const box = toAxisBox(
                              segment.startMinute,
                              segment.endMinute,
                              axis,
                            );
                            if (box.isOutside) return null;

                            return (
                              <span
                                key={segment.key}
                                title={`${label} · ${segment.datum.shortName} ${formatKstShort(segment.datum.startsAt)} ~ ${formatKstShort(segment.datum.endsAt)} · 이미 일정 있음`}
                                style={{
                                  left: `${box.left}%`,
                                  width: `${box.width}%`,
                                }}
                                className="absolute inset-y-0 rounded-sm bg-secondary"
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/*
        ── 드래그 중 시각 표시 (2026-08-19 발주자) ─────────────────────────────
        *"클릭후 드래그할때 마우스쪽에 팝업? 으로 몇시인지를 보여줘야 하고"*

        커서 **위쪽**에 띄운다 — 아래에 두면 손가락(모바일)이나 커서 자신이 가린다.
        `pointer-events-none` 이라 이 표시가 드래그를 가로채지 않는다.
        `aria-hidden` 인 이유: 같은 사실을 등록 폼의 시각 칸이 이미 **값으로** 들고 있고,
        드래그는 포인터 조작이라 스크린 리더 사용자에게는 이 표시가 도달하지 않는다.
      */}
      {dragHint === null ? null : (
        <div
          aria-hidden
          style={{ left: dragHint.x, top: dragHint.y - 12 }}
          className={cn(
            "pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full",
            "rounded-md border border-border-strong bg-surface px-2 py-1 shadow-medium",
            "text-body-sm font-semibold text-ink tabular-nums",
          )}
        >
          {dragHint.text}
        </div>
      )}
    </div>
  );
}

/** 범례. 색만으로 정보를 전달하지 않도록 텍스트를 함께 둔다. */
export function OverlayLegend({
  total,
  minCount,
  hasOvernight,
  isAxisNarrowed,
}: {
  total: number;
  minCount: number;
  hasOvernight: boolean;
  /**
   * 축이 **실제로 잘렸는가** — 이어짐 표식 항목을 켤지 정한다.
   *
   * ⚠️ *"겹침 주변 토글이 눌려 있는가"* 가 아니다. 그 둘은 다르다: ±2시간 창이 합집합
   *    축을 통째로 덮으면(전원 20:00~24:00 · 겹침 21:00~23:00 처럼 아주 흔한 모양)
   *    좁힌 축과 합집합 축이 같아져 `AxisEdgeMarkers` 가 **하나도 그려지지 않는다.**
   *    그때 이 항목을 켜면 화면에 없는 표식을 찾게 만든다. 그래서 값은 반드시
   *    `computeScopedOverlayAxis` 가 돌려준 `isNarrowed` 여야 하고, 토글 상태에서
   *    재유도하면 안 된다(그 추정이 정확히 이 결함이었다 — 2026-09-03 재작업).
   */
  isAxisNarrowed: boolean;
}) {
  /*
    범례 칸은 **사다리 함수가 만든다.** 손으로 적으면 정원이 6이 아닌 순간 거짓이 된다
    (`overlapLegendSteps` 머리말의 대응표).
  */
  const legendSteps = useMemo(() => overlapLegendSteps(total), [total]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body-sm text-ink-label">
      {/*
        ── 겹침 농도 사다리 ────────────────────────────────────────────────
        ★ 색 사다리를 색 사다리로 보여 주는 것이 범례의 일이다. 예전 범례는
          `전원 N명 / 다수 / 최소 k명` 세 칸이라 "다수"가 몇 명인지 말하지 않았다.
        ★ **칸은 `overlapToneClass` 를 실제로 호출해 만든다**(`overlapLegendSteps`).
          손으로 적은 다섯 칸은 6인 파티에서만 사실이었고, 3인 파티에서는 렌더될 수
          없는 색 세 개를 보여 주며 "3명 = 두 번째 단"이라고 거짓말했다. 이제 사다리를
          어떻게 바꾸든 범례가 따라온다.
        ★ `total <= 1` 이면 칸이 하나도 없다. 겹침은 2명부터이므로 그때는 사다리 자체가
          말할 것이 없고, 있지도 않은 색을 설명하지 않는다.
      */}
      {legendSteps.length === 0 ? null : (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>겹침 인원</span>
          {legendSteps.map((step, index) => (
            <span
              key={step.from}
              className="inline-flex items-center gap-1"
            >
              <span
                aria-hidden
                className={cn("size-3 rounded-sm", step.className)}
              />
              <span className="tabular-nums">
                {overlapLegendStepLabel(
                  step,
                  index === legendSteps.length - 1,
                )}
              </span>
            </span>
          ))}
          <span>
            · 전원({total}명)은 언제나 가장 진한 색 · 지금 기준 최소 {minCount}명
          </span>
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-available" />
        개인 가능시간
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-3 rounded-sm border border-dashed border-tertiary bg-excluded"
        />
        제외 시간
      </span>
      {/*
        ★ 겹침 계산에서 **빠진** 시간. 색만으로 말하지 않도록 글자를 함께 둔다 —
          이 항목이 없으면 사용자는 겹침이 줄어든 이유를 알 방법이 없다.
      */}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-secondary" />
        이미 일정 있음(겹침에서 제외)
      </span>
      {/*
        ★ 겹침 밴드의 **빈칸이 왜 비었는지**. 두 사유는 사용자가 할 일이 정반대라
          (일정을 옮긴다 / 시간을 조율한다) 반드시 구분되어야 하고, 그중 하나는
          **아무 표시도 없는 상태**라 글자로만 말할 수 있다 — 색이 아니라 문장이
          이 항목의 본체다.
      */}
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          style={OVERLAY_GAP_HATCH}
          className="size-3 rounded-sm border border-secondary bg-neutral-100"
        />
        밴드 빗금 = 잡힌 일정이 먹은 빈칸 (빗금 없는 빈칸 = 시간이 안 맞음)
      </span>
      {/*
        ★ 축을 좁혔을 때만 나온다. 표식이 없는 화면에 표식 설명을 두면 있지도 않은
          것을 찾게 만든다.
      */}
      {isAxisNarrowed ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3 w-[3px] rounded-sm bg-ink ring-1 ring-surface"
          />
          레인 가장자리의 굵은 선 = 보이는 시간대 밖으로 이어짐
        </span>
      ) : null}
      {hasOvernight ? (
        /*
          §4: 주황은 **보더가 지고 문장은 잉크**다. 예전에는 범례 문장 자체가
          `text-tertiary` 였고 라이트에서 3.77:1 로 AA 미달이었다. 옆 범례들과도
          글자색이 달라 일관성이 없었다 — 이제 부모의 `ink-label` 을 따른다.
        */
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3 w-0 border-l-2 border-dashed border-tertiary"
          />
          24:00 이후는 익일 — 구간은 끊지 않고 이어 그립니다
        </span>
      ) : null}
    </div>
  );
}
