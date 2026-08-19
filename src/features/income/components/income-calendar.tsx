"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";

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
  CALENDAR_WEEKDAYS,
  calendarWeekKeys,
  dayOfMonthLabel,
  formatMonthKey,
  monthCalendarWeeks,
  shiftMonthKey,
  shortWeekLabel,
} from "../lib/week-range";
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
 * 그래서 격자는 `월 화 수 목 금 토 일` 로 돌아오고, **주간 경계는 목요일 칸이 진다**:
 *   · 목요일 칸 = 왼쪽 강조선 + `W33` 배지 → "여기서 이번 주가 시작한다"
 *   · 줄 옆 합계는 **없앴다.** 한 줄이 두 주차에 걸치므로 줄에 붙은 합계는 이제 거짓말이
 *     된다. 주차 합계는 격자 아래 **주차 칩**과 그 아래 주차별 내역 카드가 답한다.
 *
 * 달 경계에서 앞뒤 달의 날짜가 딸려 오는데 **지우지 않는다.** 그 칸에도 기록이 있을 수
 * 있고 빈 칸은 "안 돌았다"로 읽힌다. 구분은 **점선 테두리와 배경**이 지고 글자 색은 낮추지
 * 않는다 — 날짜 숫자는 읽는 정보이고, 흐리게 만들려면 `ink-placeholder`(라이트 2.46:1) 로
 * 내려가야 해서 AA 를 깬다(§4).
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

/** 한 칸에 그리는 보스 아이콘 최대 개수. 넘치면 `+N` 으로 접는다. */
const MAX_ICONS_PER_DAY = 3;

/** 격자에서 목요일이 놓이는 칸 번호(월요일 시작이라 0-based 로 3). 머리글 강조에 쓴다. */
const THURSDAY_COLUMN = 3;

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
  const grid = useMemo(() => monthCalendarWeeks(monthKey), [monthKey]);
  /** 격자가 건드리는 주차. 격자 아래 칩이 이 순서로 늘어선다. */
  const weekKeys = useMemo(() => calendarWeekKeys(grid), [grid]);

  /** 클리어를 **KST 달력 날짜**로 흩는다. 주 단위 응답을 날짜 격자로 옮기는 유일한 지점. */
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
        주차(<span className="font-semibold text-primary">W33</span>)가 붙습니다.
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
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="min-w-[40rem]">
          {/* 요일 머리글. 월요일 시작이고, 목요일만 주간 경계라 강조한다. */}
          <div className="grid grid-cols-7 gap-1 pb-1">
            {CALENDAR_WEEKDAYS.map((weekday, index) => (
              <span
                key={weekday}
                className={cn(
                  "px-1 text-caption",
                  index === THURSDAY_COLUMN
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
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-20" />
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
                            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-caption font-semibold text-primary">
                              <Numeric>{shortWeekLabel(day.weekKey)}</Numeric>
                            </span>
                          ) : null}
                        </span>

                        {clears.length === 0 ? null : (
                          <>
                            <span className="flex flex-wrap items-center gap-0.5">
                              {clears.slice(0, MAX_ICONS_PER_DAY).map((clear) => (
                                <BossIcon
                                  key={clear.clearId}
                                  bossDifficultyId={clear.bossDifficultyId}
                                  difficulty={clear.difficulty}
                                  size="sm"
                                />
                              ))}
                              {clears.length > MAX_ICONS_PER_DAY ? (
                                <span className="rounded-full border border-border bg-hover-surface px-1.5 py-0.5 text-caption text-ink">
                                  +
                                  <Numeric>
                                    {clears.length - MAX_ICONS_PER_DAY}
                                  </Numeric>
                                </span>
                              ) : null}
                            </span>
                            <MesoAmount
                              value={dayTotal}
                              compact
                              suffix={false}
                              tone="accent"
                              className="text-caption font-semibold"
                            />
                          </>
                        )}
                      </>
                    );

                    const boxClass = cn(
                      "flex min-h-20 flex-col items-start gap-1 rounded-md border border-border p-1.5 text-left",
                      /*
                        달 밖의 날 = **점선 테두리**. 색 대비를 낮추는 대신 형태로
                        구분한다(§4 — 읽는 글자는 `ink-muted` 아래로 내려가지 않는다).
                      */
                      day.outside ? "border-dashed bg-hover-surface" : "bg-background",
                      // 주간 초기화 지점. 굵은 왼쪽 선이 "여기서 새 주가 시작한다"를 말한다.
                      day.weekStart && "border-l-4 border-l-primary",
                      isToday && "border-primary",
                    );

                    /*
                      기록이 없는 날은 **버튼이 아니다.** 눌러도 빈 창만 뜨는 버튼을
                      늘어놓으면 탭 순서가 42칸으로 늘어나고 키보드 사용자가 아무것도
                      없는 칸을 하나씩 지나야 한다.
                    */
                    return clears.length === 0 ? (
                      <div key={day.dayKey} className={boxClass}>
                        {content}
                      </div>
                    ) : (
                      <button
                        key={day.dayKey}
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
                onClick={() => onSelectWeek(key)}
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
