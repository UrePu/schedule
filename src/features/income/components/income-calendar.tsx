"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { BossIcon, MesoAmount, Numeric } from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@/components/ui";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";

import {
  calendarWeekKeys,
  calendarWeekdays,
  dayOfMonthLabel,
  formatMonthKey,
  formatWeekRange,
  monthCalendarWeeks,
  shiftMonthKey,
  shortWeekLabel,
} from "../lib/week-range";
import {
  WEEK_START_BADGE,
  WEEK_START_LABEL,
  readStoredWeekStart,
  serverWeekStart,
  setStoredWeekStart,
  subscribeWeekStart,
} from "../lib/week-start-preference";
import type { ClearRecord, WeekLedgerEntry } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 수익 달력 — **언제 무슨 보스를 돌았나**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-19): *"캘린더를 박아놔서 언제 무슨보스를 돌았고 하는 내역들을
 * 볼수있게 해봐 주차별로 32주차엔 얼마 벌었다."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 격자는 **보통 달력**이다 — 월요일 시작 (2026-08-19 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"캘린더부분 표시는 일반적인 달력과 같게좀 해줘라 이건 헷갈릴거같아."* / *"월요일시작으로
 * 해 나는그게 편해."*
 *
 * 이전 버전은 회계 주(목 00:00 KST 리셋)에 맞춰 격자를 **목~수**로 돌리고 줄 왼쪽에 주차
 * 라벨과 그 주 합계를 붙였다. 한 줄 = 한 주라는 정합성은 얻었지만 **날짜를 찾는 일이
 * 어려워졌다** — 1일이 엉뚱한 칸에 있는 달력은 사람이 아는 달력이 아니다. 회계 편의보다
 * 날짜 찾기가 먼저다.
 *
 * 시작 요일은 헤더의 **`M`/`S` 버튼**으로 바꾼다(발주자 2026-08-19: *"옆에 버튼 넣어서
 * 맨앞이 일요일에오는 캘린더로 변환할수있게 해 M / S 이렇게 바뀌도록"*). 기본은 월요일이고
 * 선택은 브라우저에 남는다. **바뀌는 것은 칸 배열뿐** — 주차·수익·12개 상한은 목요일 경계
 * 그대로다(§1). 그래서 이 버튼을 눌러도 화면의 숫자는 한 자리도 움직이지 않는다.
 *
 * 그래서 격자는 `월 화 수 목 금 토 일` 로 돌아오고, **주간 경계는 목요일 칸이 진다**:
 *   · 목요일 칸 = `W33` 배지 → "여기서 이번 주가 시작한다"
 *   · 줄 옆 합계는 **없앴다.** 한 줄이 두 주차에 걸치므로 줄에 붙은 합계는 이제 거짓말이
 *     된다. 주차 합계는 격자 아래 **주차 칩**과 그 아래 주차별 내역 카드가 답한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 주 경계는 **상시 표시가 아니라 hover** 로 (2026-08-19 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"이 보라색 줄 치우고 W33 에 손 올리면 목~수 하이라이트 되도록 바꿀수있나?"*
 *
 * 목요일 칸마다 서 있던 왼쪽 보라색 굵은 선을 **없앴다.** 매 줄에 세로 막대가 서 있으면
 * 격자가 그만큼 조각나 보이고, 정작 자주 쓰는 정보(그날 뭘 돌았나)보다 시선을 먼저 먹는다.
 * 대신 `W33` 배지에 **마우스를 올리면 그 주(목~수) 7칸이 한꺼번에 강조된다** — 주차 경계는
 * 늘 보고 있어야 하는 정보가 아니라 *궁금할 때 확인하는* 정보다.
 *
 * 강조는 **줄을 넘나든다**(목~일은 이 줄, 월~수는 다음 줄). 그래서 CSS `group-hover` 로는
 * 안 되고 — 형제도 자식도 아닌 칸을 물들여야 한다 — `hoverWeekKey` 상태 하나로 처리한다.
 * 칸은 자기 `day.weekKey` 가 그 값과 같은지만 본다.
 *
 * 배지는 `<span>` 이라 키보드 초점을 받지 않는다. 클리어가 있는 칸은 `<button>` 이고 그
 * 안에 초점 가능한 요소를 또 넣으면 중첩 인터랙티브가 되기 때문이다. hover 강조는 **보조
 * 표시**이고, 같은 정보(주차 번호와 목~수 날짜 범위)를 배지 글자와 `title` 이 그대로 들고
 * 있으므로 마우스가 없어도 잃는 정보가 없다.
 *
 * 달 경계에서 앞뒤 달의 날짜가 딸려 오는데 **지우지 않는다.** 그 칸에도 기록이 있을 수
 * 있고 빈 칸은 "안 돌았다"로 읽힌다. 구분은 **점선 테두리와 배경**이 지고 글자 색은 낮추지
 * 않는다 — 날짜 숫자는 읽는 정보이고, 흐리게 만들려면 `ink-placeholder`(라이트 2.46:1) 로
 * 내려가야 해서 AA 를 깬다(§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 칸의 층은 **고정**이다 (2026-08-19 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"셀크기는 보스가 하나라도 있으면 고정이니 보스 4개 아랫줄에 + 숫자 맨밑에 메소 이렇게
 * 고정해서 볼수있게 해봐."*
 *
 *   ① 날짜(+ 목요일이면 주차 배지) → ② 보스 아이콘 **4개, 한 줄** → ③ 넘친 `+N`
 *   → ④ **칸 맨 아래**에 그날 수령액
 *
 * 이전에는 아이콘과 `+N` 이 같은 줄에서 `flex-wrap` 으로 흘렀다. 폭에 따라 3개씩 접히고
 * `+N` 이 다음 줄로 밀리면서 **금액이 칸마다 다른 높이에 앉았고**, 날짜별 금액을 눈으로
 * 비교할 수 없었다. 지금은 아이콘 줄이 `grid-cols-4` 로 고정이고 금액은 `mt-auto` 로 바닥에
 * 붙는다 — 격자 한 줄의 칸은 높이가 같으므로 금액이 한 선에 나란히 선다.
 *
 * 아이콘 4개는 **그날 클리어 중 비싼 보스 순**이다(*"역정렬해서 제일 비싼보스 순으로 4개"*).
 * 기준은 `basePriceMeso`(솔로 기준가) — 아래 `clearsByDay` 주석 참고.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 모바일
 * ─────────────────────────────────────────────────────────────────────────────
 * 7칸을 좁은 화면에 욱여넣으면 아이콘도 숫자도 못 읽는다. **가로 스크롤**로 처리하고
 * (`overflow-x-auto` + `min-w`), 페이지 본문은 절대 가로로 밀리지 않게 한다. 주차 칩은
 * 스크롤 상자 **밖**에 있어 좁은 화면에서도 바로 보인다.
 *
 * ⚠️ **숫자를 만들지 않는다.** 날짜 칸의 금액은 그 날 클리어들의 `crystal_share_meso`
 *    스냅샷 합이다(원장 값의 부분합일 뿐 새 규칙이 아니다). 주차 칩의 합계는 뷰가 낸
 *    `total_income_meso` 를 그대로 쓴다 — 우리가 날짜 칸을 더해 만들지 않는다.
 * ⚠️ 날짜 숫자와 배지는 `text-caption`(12px) 이다. §4 가 12px 을 허용하는 것은 **라벨과
 *    수치 주석**이며, 이 달력에는 읽어야 하는 문장이 들어가지 않는다.
 */

/**
 * 한 칸에 그리는 보스 아이콘 최대 개수. 넘치면 **아랫줄에** `+N` 으로 접는다.
 *
 * 발주자(2026-08-19): *"보스 4개 아랫줄에 + 숫자 맨밑에 메소 이렇게 고정해서 볼수있게."*
 * 한 줄에 정확히 4칸이라 `grid-cols-4` 와 짝이다 — 개수를 바꾸면 그 클래스도 바꿔야 한다.
 */
const MAX_ICONS_PER_DAY = 4;

/**
 * 머리글에서 강조할 요일. **주 시작 요일이 바뀌면 칸 번호도 바뀌므로 위치를 상수로 박지
 * 않고 라벨로 찾는다** — 월요일 시작이면 4번째, 일요일 시작이면 5번째 칸이다.
 */
const RESET_WEEKDAY_LABEL = "목";

export interface IncomeCalendarProps {
  /** `2026-08`. */
  readonly monthKey: string;
  readonly onMonthChange: (monthKey: string) => void;
  /** 그 달을 덮는 주차들. **기록이 없는 주는 들어 있지 않다.** */
  readonly weeks: readonly WeekLedgerEntry[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly onSelectDay: (dayKey: string) => void;
  /** 주차 칩을 눌렀을 때. 그 주 전체(드랍 포함) 내역을 연다. */
  readonly onSelectWeek: (weekKey: string) => void;
  /** 오늘의 KST 날짜 키. SSR 불일치를 막으려면 주입해야 한다. */
  readonly todayDayKey: string;
  readonly className?: string;
}

/** 그 날 클리어들의 내 몫 합. 하나라도 미확인이면 **`null`(모름)** 이다 — 0 이 아니다. */
function sumShare(clears: readonly ClearRecord[]): number | null {
  let total = 0;
  let known = false;
  for (const clear of clears) {
    if (clear.shareMeso === null) continue;
    total += clear.shareMeso;
    known = true;
  }
  return known || clears.length === 0 ? total : null;
}

export function IncomeCalendar({
  monthKey,
  onMonthChange,
  weeks,
  isLoading,
  isError,
  onRetry,
  onSelectDay,
  onSelectWeek,
  todayDayKey,
  className,
}: IncomeCalendarProps) {
  /**
   * 주 시작 요일(`M`/`S`). localStorage 에 있는 **React 밖의 값**이라 테마 전환과 같은
   * `useSyncExternalStore` 패턴으로 읽는다(`week-start-preference.ts` 머리말).
   */
  const weekStart = useSyncExternalStore(
    subscribeWeekStart,
    readStoredWeekStart,
    serverWeekStart,
  );

  const weekdays = useMemo(() => calendarWeekdays(weekStart), [weekStart]);
  const grid = useMemo(
    () => monthCalendarWeeks(monthKey, weekStart),
    [monthKey, weekStart],
  );
  /** 격자가 건드리는 주차. 격자 아래 칩이 이 순서로 늘어선다. */
  const weekKeys = useMemo(() => calendarWeekKeys(grid), [grid]);
  /**
   * `W33` 배지(또는 아래 주차 칩)에 손을 올려 둔 주차. 그 주 7칸이 함께 강조된다.
   *
   * 상태로 두는 이유: 강조 대상이 **줄을 넘어간다.** 목~일은 이 줄, 월~수는 다음 줄이라
   * CSS 의 `group-hover`(조상→자손)로는 닿지 않는다.
   */
  const [hoverWeekKey, setHoverWeekKey] = useState<string | null>(null);

  /**
   * 클리어를 **KST 달력 날짜**로 흩는다. 주 단위 응답을 날짜 격자로 옮기는 유일한 지점.
   *
   * ★ 날짜별로 **비싼 보스 순으로 정렬**한다(발주자 2026-08-19: *"그날 클리어된것중에
   *   역정렬해서 제일 비싼보스 순으로 4개"*). 칸에는 4개만 들어가므로, 정렬하지 않으면
   *   어떤 4개가 보일지는 응답 순서 운이고 **가장 비싼 보스가 `+N` 뒤로 숨는다.**
   *
   * 기준은 `basePriceMeso`(솔로 기준가 스냅샷) — "보스가 비싼 순"은 파티 인원으로 나누기
   * 전의 값이다. 내 몫(`shareMeso`)으로 줄 세우면 같은 보스도 인원에 따라 순서가 바뀐다.
   * 가격 미확인(`null`)은 **0 이 아니라 모름**이므로(§1.3 D4) 맨 뒤로 보내고, 동점이면
   * `clearId` 로 갈라 렌더마다 순서가 흔들리지 않게 한다.
   */
  const clearsByDay = useMemo(() => {
    const map = new Map<string, ClearRecord[]>();
    for (const week of weeks) {
      for (const clear of week.clears) {
        // `effective_cleared` 인 행은 DB CHECK 상 `cleared_at` 이 반드시 있다.
        if (clear.clearedAt === null) continue;
        const dayKey = kstDayKey(new Date(clear.clearedAt));
        const list = map.get(dayKey) ?? [];
        list.push(clear);
        map.set(dayKey, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const priceA = a.basePriceMeso;
        const priceB = b.basePriceMeso;
        if (priceA === null || priceB === null) {
          if (priceA === priceB) return a.clearId < b.clearId ? -1 : 1;
          return priceA === null ? 1 : -1;
        }
        if (priceA !== priceB) return priceB - priceA;
        return a.clearId < b.clearId ? -1 : 1;
      });
    }
    return map;
  }, [weeks]);

  const weekByKey = useMemo(() => {
    const map = new Map<string, WeekLedgerEntry>();
    for (const week of weeks) map.set(week.weekKey, week);
    return map;
  }, [weeks]);

  const todayMonthKey = todayDayKey.slice(0, 7);

  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <CalendarDays aria-hidden size={20} className="mt-0.5 text-primary" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardOverline>기록 달력</CardOverline>
            <CardTitle className="text-body-lg">
              {formatMonthKey(monthKey)}
            </CardTitle>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/*
            주 시작 요일 전환 — `M`(월요일) ↔ `S`(일요일). 발주자 지정 표기다.

            글자 한 자만으로는 무엇을 바꾸는 버튼인지 알 수 없으므로 `aria-label` 과
            `title` 이 **현재 상태와 누르면 될 상태**를 함께 말한다. 달 이동 버튼 옆이라
            "달을 바꾸는 버튼"으로 오해될 자리라서 더욱 필요하다.
          */}
          <Button
            variant="secondary"
            size="sm"
            aria-label={`주 시작 요일: ${WEEK_START_LABEL[weekStart]} — 누르면 ${WEEK_START_LABEL[weekStart === "mon" ? "sun" : "mon"]}`}
            title={`주 시작 요일: ${WEEK_START_LABEL[weekStart]} (누르면 ${WEEK_START_LABEL[weekStart === "mon" ? "sun" : "mon"]})`}
            className="cursor-pointer font-mono"
            onClick={() => setStoredWeekStart(weekStart === "mon" ? "sun" : "mon")}
          >
            {WEEK_START_BADGE[weekStart]}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="이전 달"
            className="cursor-pointer"
            onClick={() => onMonthChange(shiftMonthKey(monthKey, -1))}
          >
            <ChevronLeft aria-hidden size={14} />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="cursor-pointer"
            disabled={monthKey === todayMonthKey}
            onClick={() => onMonthChange(todayMonthKey)}
          >
            오늘
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="다음 달"
            className="cursor-pointer"
            onClick={() => onMonthChange(shiftMonthKey(monthKey, 1))}
          >
            <ChevronRight aria-hidden size={14} />
          </Button>
        </div>
      </div>

      <p className="text-body-sm text-ink-muted">
        날짜를 누르면 그날 돈 보스와 수령액을 볼 수 있고, 거기서 캐릭터와 입장 인원을 고칠 수
        있습니다. 주간 초기화는{" "}
        <strong className="font-semibold text-ink">목요일 00:00</strong> 이라 목요일 칸에
        주차(<span className="font-semibold text-primary">W33</span>)가 붙고,{" "}
        <strong className="font-semibold text-ink">그 배지에 마우스를 올리면</strong> 그 주
        목~수 7칸이 함께 표시됩니다.
      </p>

      {isError ? (
        <ErrorState
          title="달력을 불러오지 못했습니다"
          description="아래 격자는 마지막으로 확인된 기록입니다. 잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
          className="py-6"
        />
      ) : null}

      {/*
        ── 가로 스크롤 컨테이너 ────────────────────────────────────────────
        좁은 화면에서 잘려 나가면 실패다. 격자에 최소 폭을 주고 **이 상자만** 가로로
        스크롤한다 — 페이지 본문은 밀리지 않는다.
      */}
      {/*
        `data-calendar-*` 는 **레이아웃 측정용 표식**이다. 이 화면이 가로로 넘치는지는
        눈이 아니라 `scrollWidth - clientWidth` 로만 확인할 수 있고, 실제로 그 값을 재서
        67rem 상시 스크롤을 잡았다(2026-08-25). 스타일에는 아무 영향이 없다.
      */}
      <div data-calendar-scroll className="-mx-1 overflow-x-auto px-1 pb-1">
        {/*
          ── 최소 폭: 67rem → **46rem** (2026-08-25 발주 지적) ────────────────
          발주 원문: *"반응형이 안되는데? ui가 고정임. 그리고 최대 값에서도 가로 스크롤이
          쓸데없이 생겨"* — 둘은 같은 원인의 앞뒤다.

          67rem(1,072px)은 **32px 고정 아이콘 4개**가 한 줄에 들어갈 자리를 산술로 확보한
          값이었다. 그런데 이 화면의 스크롤 상자는 본문 `max-w-6xl` 안에서 실측 **1,078px**
          이고, 격자는 `min-w` 때문에 **1,080px** 이 된다 — 딱 **2px**이 넘친다.
          헤드리스 크롬으로 1,280 · 1,440 · 1,920 세 폭에서 모두 같은 값이 나왔다.
          그래서 화면이 아무리 넓어도 스크롤바가 상시로 떴고, 칸은 화면을 따라 넓어지지도
          않았다(둘은 같은 원인의 앞뒤다).

          지금은 아이콘이 `fluid`(칸을 채우되 32px 상한)라 칸이 폭을 따라 줄고 늘어난다.
          남은 최소 폭은 이제 아이콘이 아니라 **금액 문구**가 정한다. `28억 3,500만` 이
          12px 로 약 78px 이고, 여기에 칸 안쪽 여백 12 + 테두리 2 를 더하면 92px 이다.
          7칸 + 칸 사이 간격 6×4 = 668px 이 하한이지만, 그 값은 글자가 **딱 맞는** 폭이라
          한 글자만 길어져도 금액이 두 줄로 접히고 줄 높이가 들쭉날쭉해진다(발주자가 예전에
          없애 달라고 한 그 흔들림이다). 여유 한 칸을 둬 **46rem(736px)** 으로 잡는다.
          넓은 화면에서는 칸이 140px 넘게 벌어져 아이콘이 상한인 32px 로 붙으므로
          **예전과 똑같이 보인다.**

          대가는 그대로 남는다: 폰에서는 여전히 가로로 민다. 7칸을 390px 에 욱여넣으면
          아이콘도 숫자도 못 읽는다.
        */}
        <div className="min-w-[46rem]">
          {/* 요일 머리글. 월요일 시작이고, 목요일만 주간 경계라 강조한다. */}
          <div className="grid grid-cols-7 gap-1 pb-1">
            {weekdays.map((weekday) => (
              <span
                key={weekday}
                className={cn(
                  "px-1 text-caption",
                  weekday === RESET_WEEKDAY_LABEL
                    ? "font-semibold text-primary"
                    : "text-ink-muted",
                )}
              >
                {weekday}
              </span>
            ))}
          </div>

          {isLoading && weeks.length === 0 ? (
            <div className="flex flex-col gap-1">
              {/* 실제 줄 높이와 같은 값이어야 로딩이 끝날 때 격자가 튀지 않는다. */}
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-[6.75rem]" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {grid.map((week) => (
                <div key={week.rowKey} className="grid grid-cols-7 gap-1">
                  {week.days.map((day) => {
                    const clears = clearsByDay.get(day.dayKey) ?? [];
                    const isToday = day.dayKey === todayDayKey;
                    const dayTotal = sumShare(clears);
                    const isWeekHovered = day.weekKey === hoverWeekKey;

                    const content = (
                      <>
                        <span className="flex w-full items-center justify-between gap-1">
                          <span
                            className={cn(
                              "text-caption tabular-nums",
                              /*
                                달 밖의 날도 **글자 색을 낮추지 않는다** — 날짜 숫자는
                                읽는 정보이고, `ink-placeholder` 는 라이트에서 2.46:1 이라
                                AA 미달이다(§4). 구분은 아래 점선 테두리와 배경이 진다.
                              */
                              isToday
                                ? "font-semibold text-primary"
                                : "text-ink-muted",
                            )}
                          >
                            <Numeric>{dayOfMonthLabel(day.dayKey)}</Numeric>
                          </span>

                          {/*
                            주차 배지는 **목요일 칸에만** 붙는다. 줄이 두 주차에 걸치므로
                            주차를 아는 단위가 줄이 아니라 칸이다(§ week-range 머리말).
                          */}
                          {day.weekStart ? (
                            <span
                              title={`${shortWeekLabel(day.weekKey)} · ${formatWeekRange(day.weekKey)}`}
                              onMouseEnter={() => setHoverWeekKey(day.weekKey)}
                              onMouseLeave={() => setHoverWeekKey(null)}
                              className={cn(
                                /*
                                  ★ 배경을 진하게 만들지 않는다. `primary/35` 로 올렸더니
                                    `pnpm contrast` 가 **라이트 3.59:1 · 다크 3.20:1**
                                    (필요 4.5)로 잡았다 — 12px 600 글자라 면제 대상도
                                    아니다(§4). 배경은 통과값인 `/15` 로 고정하고, hover
                                    표시는 **테두리 색**이 진다. 테두리는 UI 경계라 3:1
                                    기준이고 `primary` 는 양쪽 테마에서 통과한다.
                                    자리 밀림을 막으려고 평소에도 투명 테두리를 둔다.
                                */
                                "cursor-help rounded-full border bg-primary/15 px-1.5 py-0.5 text-caption font-semibold text-primary transition-colors duration-150",
                                isWeekHovered ? "border-primary" : "border-transparent",
                              )}
                            >
                              <Numeric>{shortWeekLabel(day.weekKey)}</Numeric>
                            </span>
                          ) : null}
                        </span>

                        {clears.length === 0 ? null : (
                          <>
                            {/*
                              ── 아이콘 줄 — **한 줄에 정확히 4칸** ──────────────
                              `flex-wrap` 이 아니라 `grid-cols-4` 다. 줄바꿈에 맡기면 폭에
                              따라 3개씩·2개씩으로 흐트러지고, 그러면 아래 `+N` 과 메소가
                              칸마다 다른 높이에 앉는다 — 발주자가 없애 달라고 한 바로 그
                              흔들림이다.

                              ★ 아이콘은 `fluid` 다 — 칸 폭을 채우되 32px 을 넘지 않는다.
                                예전에는 `sm`(32px 고정)이었고, 줄이려고 `w-full`/`max-w-8`
                                을 밖에서 덮어쓰려다 되돌린 적이 있다. 클래스를 밖에서
                                싸우게 하는 대신 **`BossIcon` 이 그 크기를 하나 갖도록**
                                했다(2026-08-25). 어느 쪽이 이길지가 생성된 CSS 순서에
                                달리는 문제가 애초에 사라진다.
                            */}
                            <span className="grid w-full grid-cols-4 gap-0.5">
                              {clears.slice(0, MAX_ICONS_PER_DAY).map((clear) => (
                                <BossIcon
                                  key={clear.clearId}
                                  bossDifficultyId={clear.bossDifficultyId}
                                  difficulty={clear.difficulty}
                                  size="fluid"
                                />
                              ))}
                            </span>

                            {/* 넘친 개수는 **아이콘 아랫줄**에 따로 선다(발주자 지시). */}
                            {clears.length > MAX_ICONS_PER_DAY ? (
                              <span className="rounded-full border border-border bg-hover-surface px-1.5 py-0.5 text-caption text-ink">
                                +
                                <Numeric>
                                  {clears.length - MAX_ICONS_PER_DAY}
                                </Numeric>
                              </span>
                            ) : null}

                            {/*
                              메소는 **칸 맨 아래**에 고정한다(`mt-auto`). 격자 한 줄의 칸은
                              높이가 같으므로, `+N` 이 있든 없든 같은 줄의 금액이 한 선에
                              나란히 놓인다 — 눈으로 날짜별 금액을 비교할 수 있게 된다.
                            */}
                            <MesoAmount
                              value={dayTotal}
                              compact
                              suffix={false}
                              tone="accent"
                              className="mt-auto text-caption font-semibold"
                            />
                          </>
                        )}
                      </>
                    );

                    const boxClass = cn(
                      /*
                        높이는 **네 층이 다 들어가는 값으로 고정**한다 — 날짜 줄(16) +
                        아이콘 줄(32) + `+N` 줄(20) + 금액 줄(16) + 사이 간격(12) +
                        안쪽 여백(12) ≈ 108px. 기록이 없는 칸까지 같은 높이라 줄이 들쭉날쭉
                        하지 않고, 기록이 생겨도 격자가 밀리지 않는다.
                      */
                      "flex min-h-[6.75rem] flex-col items-start gap-1 rounded-md border border-border p-1.5 text-left",
                      /*
                        달 밖의 날 = **점선 테두리**. 색 대비를 낮추는 대신 형태로
                        구분한다(§4 — 읽는 글자는 `ink-muted` 아래로 내려가지 않는다).
                      */
                      day.outside ? "border-dashed bg-hover-surface" : "bg-background",
                      isToday && "border-primary",
                      /*
                        주차 배지에 손을 올린 동안만 그 주 7칸을 물들인다. 상시 표시하던
                        목요일 왼쪽 굵은 선을 대신하는 자리다(파일 머리말).
                        ★ 배경·테두리는 **`isToday` 뒤에** 와야 한다. `cn` 은 tailwind-merge
                          라 뒤에 온 같은 그룹 클래스가 이기고, 강조 중에는 그쪽이 이겨야
                          7칸이 같은 모양으로 보인다.
                      */
                      isWeekHovered && "border-primary bg-primary/10",
                    );

                    /*
                      기록이 없는 날은 **버튼이 아니다.** 눌러도 빈 창만 뜨는 버튼을
                      늘어놓으면 탭 순서가 42칸으로 늘어나고 키보드 사용자가 아무것도
                      없는 칸을 하나씩 지나야 한다.
                    */
                    return clears.length === 0 ? (
                      <div key={day.dayKey} data-calendar-cell className={boxClass}>
                        {content}
                      </div>
                    ) : (
                      <button
                        key={day.dayKey}
                        data-calendar-cell
                        type="button"
                        onClick={() => onSelectDay(day.dayKey)}
                        className={cn(
                          boxClass,
                          "cursor-pointer transition-colors duration-150 hover:border-primary hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        )}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/*
        ── 주차 칩 ─────────────────────────────────────────────────────────
        줄 옆에 붙어 있던 주차 라벨과 합계가 간 곳이다. 격자가 월요일 시작이 되면서 줄과
        주차가 더 이상 일대일이 아니므로, 주차는 **격자 밖에서** 따로 센다. 금액은 뷰가 낸
        `total_income_meso` 를 그대로 쓴다 — 날짜 칸을 더해 만들지 않는다.
      */}
      {weekKeys.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-ink-muted">주차별 합계</span>
          {weekKeys.map((key) => {
            const entry = weekByKey.get(key);
            return entry === undefined ? (
              <span
                key={key}
                title={`${shortWeekLabel(key)} · ${formatWeekRange(key)}`}
                onMouseEnter={() => setHoverWeekKey(key)}
                onMouseLeave={() => setHoverWeekKey(null)}
                className="flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1"
              >
                <span className="text-caption font-semibold text-ink">
                  <Numeric>{shortWeekLabel(key)}</Numeric>
                </span>
                {/*
                  ⚠️ `ink-placeholder` 를 쓰지 않는다. 라이트 모드에서 `#a1a1aa` / `#fafafa`
                     = **2.46:1** 로 AA(4.5:1) 에 한참 못 미치고, §4 는 그 토큰을 입력
                     플레이스홀더·장식 아이콘·비활성 전용으로 제한한다. 이 문구는 사용자가
                     읽는 글자다. `ink-muted` 는 라이트 4.63 · 다크 9.66 으로 둘 다 통과한다.
                */}
                <span className="text-caption text-ink-muted">기록 없음</span>
              </span>
            ) : (
              <button
                key={key}
                type="button"
                title={`${shortWeekLabel(key)} · ${formatWeekRange(key)}`}
                onClick={() => onSelectWeek(key)}
                /*
                  칩도 격자를 물들인다 — 배지와 같은 상태를 쓴다. 칩은 `<button>` 이라
                  키보드 초점을 받으므로 `onFocus`/`onBlur` 까지 걸어 두면 마우스 없이도
                  같은 강조를 볼 수 있다.
                */
                onMouseEnter={() => setHoverWeekKey(key)}
                onMouseLeave={() => setHoverWeekKey(null)}
                onFocus={() => setHoverWeekKey(key)}
                onBlur={() => setHoverWeekKey(null)}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 transition-colors duration-150 hover:border-primary hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span className="text-caption font-semibold text-ink">
                  <Numeric>{shortWeekLabel(key)}</Numeric>
                </span>
                <MesoAmount
                  value={entry.totalIncomeMeso}
                  compact
                  suffix={false}
                  tone="accent"
                  className="text-caption font-semibold"
                />
              </button>
            );
          })}
        </div>
      )}

      {!isLoading && weeks.length === 0 ? (
        /*
          빈 달 — **오류처럼 보이면 안 된다**(§0.3). 격자는 그대로 두고 아래에 한 문장만
          더한다. 격자를 지우고 빈 상태 카드로 바꾸면 "달력이 사라졌다"로 읽힌다.
        */
        <p className="text-body-sm text-ink-muted">
          이 달에는 기록된 클리어가 없습니다. 일정을 클리어로 체크하거나 인게임 스케줄러를
          동기화하면 날짜 칸에 보스가 쌓입니다.
        </p>
      ) : null}
    </Card>
  );
}
