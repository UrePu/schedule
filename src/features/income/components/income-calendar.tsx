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
  WEEK_START_WEEKDAYS,
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
 * ★ 한 줄이 **정확히 한 주**다 — 격자를 목요일부터 시작한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 앱의 회계 단위는 주(**목 00:00 KST 리셋**, §1)이고 12개 상한도 주 단위다. 그런데
 * 흔한 일요일 시작 달력에 주차 구분선을 덧그리면 **한 줄이 두 주에 걸친다.** 그러면 줄
 * 옆에 붙는 "그 주 합계"가 어느 줄의 합인지 알 수 없고, 달력이 주차 개념을 정면으로
 * 헷갈리게 만든다.
 *   → 그래서 격자 자체를 **목~수**로 돌렸다. 한 줄 = 한 주이고, 줄 왼쪽의 주차 라벨
 *     (`W33`)과 합계가 그 줄 전체를 가리킨다. 요일 머리글 `목 금 토 일 월 화 수` 가 곧
 *     경계 표시라 구분선을 덧그릴 필요조차 없다.
 *
 * 달 경계에서 앞뒤 달의 날짜가 딸려 오는데 **지우지 않는다.** 줄 옆의 합계는 그 주
 * 전체의 합인데 칸 일부를 비우면 합계와 칸의 합이 달라 보인다. 구분은 **점선 테두리와
 * 배경**이 지고 글자 색은 낮추지 않는다 — 날짜 숫자는 읽는 정보이고, 흐리게 만들려면
 * `ink-placeholder`(라이트 2.46:1) 로 내려가야 해서 AA 를 깬다(§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 모바일
 * ─────────────────────────────────────────────────────────────────────────────
 * 7칸 + 라벨 열을 좁은 화면에 욱여넣으면 아이콘도 숫자도 못 읽는다. **가로 스크롤**로
 * 처리하고(`overflow-x-auto` + `min-w`), 페이지 본문은 절대 가로로 밀리지 않게 한다.
 * 주 합계는 라벨 열에 세로로 쌓여 스크롤 없이도 첫 화면에서 보인다.
 *
 * ⚠️ **숫자를 만들지 않는다.** 날짜 칸의 금액은 그 날 클리어들의 `crystal_share_meso`
 *    스냅샷 합이다(원장 값의 부분합일 뿐 새 규칙이 아니다). 주 합계는 뷰가 낸 값을
 *    그대로 쓴다 — 우리가 날짜 칸을 더해 만들지 않는다.
 * ⚠️ 날짜 숫자와 배지는 `text-caption`(12px) 이다. §4 가 12px 을 허용하는 것은 **라벨과
 *    수치 주석**이며, 이 달력에는 읽어야 하는 문장이 들어가지 않는다.
 */

/** 한 칸에 그리는 보스 아이콘 최대 개수. 넘치면 `+N` 으로 접는다. */
const MAX_ICONS_PER_DAY = 3;

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
  todayDayKey,
  className,
}: IncomeCalendarProps) {
  const grid = useMemo(() => monthCalendarWeeks(monthKey), [monthKey]);

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
        한 줄이 한 주입니다 — 주간 초기화가 <strong className="font-semibold text-ink">목요일 00:00</strong>{" "}
        이라 달력도 목요일부터 시작합니다. 날짜를 누르면 그날 돈 보스와 수령액을 볼 수 있고,
        거기서 캐릭터와 입장 인원을 고칠 수 있습니다.
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
        <div className="min-w-[44rem]">
          {/* 요일 머리글. 목요일이 첫 칸이라는 사실 자체가 주 경계 표시다. */}
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-1 pb-1">
            <span className="text-caption text-ink-muted">주차</span>
            {WEEK_START_WEEKDAYS.map((weekday, index) => (
              <span
                key={weekday}
                className={cn(
                  "px-1 text-caption",
                  // 목요일 = 주의 시작. 강조해 두면 경계가 눈에 남는다.
                  index === 0 ? "font-semibold text-primary" : "text-ink-muted",
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
              {grid.map((week) => {
                const entry = weekByKey.get(week.weekKey);
                return (
                  <div
                    key={week.weekKey}
                    className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-1"
                  >
                    {/*
                      주차 라벨 + 그 주 합계. **뷰가 낸 값**이며 날짜 칸을 더해 만들지 않는다.
                      왼쪽 굵은 보더가 "여기서 한 주가 시작한다"를 말한다.
                    */}
                    <div className="flex flex-col justify-center gap-0.5 rounded-md border border-l-4 border-border border-l-primary bg-background px-1.5 py-2">
                      <span className="text-caption font-semibold text-ink">
                        <Numeric>{shortWeekLabel(week.weekKey)}</Numeric>
                      </span>
                      {entry === undefined ? (
                        /*
                          ⚠️ `ink-placeholder` 를 쓰지 않는다. 라이트 모드에서
                             `#a1a1aa` / `#fafafa` = **2.46:1** 로 AA(4.5:1) 에 한참 못 미치고,
                             §4 는 그 토큰을 입력 플레이스홀더·장식 아이콘·비활성 전용으로
                             제한한다. 이 문구는 사용자가 읽는 글자다.
                             `ink-muted` 는 라이트 4.63 · 다크 9.66 으로 양쪽 다 통과한다.
                        */
                        <span className="text-caption text-ink-muted">
                          기록 없음
                        </span>
                      ) : (
                        <MesoAmount
                          value={entry.totalIncomeMeso}
                          compact
                          suffix={false}
                          tone="accent"
                          className="text-caption font-semibold"
                        />
                      )}
                    </div>

                    {week.days.map((day) => {
                      const clears = clearsByDay.get(day.dayKey) ?? [];
                      const isToday = day.dayKey === todayDayKey;
                      const dayTotal = sumShare(clears);

                      const content = (
                        <>
                          <span
                            className={cn(
                              "text-caption tabular-nums",
                              /*
                                달 밖의 날도 **글자 색을 낮추지 않는다** — 날짜 숫자는
                                읽는 정보이고, `ink-placeholder` 는 라이트에서 2.46:1 이라
                                AA 미달이다(§4). 구분은 아래 점선 테두리와 배경이 진다.
                              */
                              isToday ? "font-semibold text-primary" : "text-ink-muted",
                            )}
                          >
                            <Numeric>{dayOfMonthLabel(day.dayKey)}</Numeric>
                          </span>

                          {clears.length === 0 ? null : (
                            <>
                              <span className="flex flex-wrap items-center gap-0.5">
                                {clears
                                  .slice(0, MAX_ICONS_PER_DAY)
                                  .map((clear) => (
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
                        day.outside
                          ? "border-dashed bg-hover-surface"
                          : "bg-background",
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
                );
              })}
            </div>
          )}
        </div>
      </div>

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
