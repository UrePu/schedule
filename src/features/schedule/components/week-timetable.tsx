"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { BossIcon } from "@/components/domain";
import {
  BOSS_DIFFICULTY_BORDER_L,
  type BossDifficulty,
} from "@/components/domain/boss-difficulty";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { fetchMyTimetable } from "@/features/schedule/data";
import {
  buildDayRows,
  toAxisPercent,
  type DayRow,
  type OverlayAxis,
} from "@/features/schedule/lib/overlay-layout";
import {
  buildTimetableLayout,
  type TimetableBlock,
} from "@/features/schedule/lib/timetable-layout";
import { DAY_MINUTES, kstDayKey } from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { TimeRange, WeekKey } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 시간표 — **"나 언제 어디로 보스 가야 하지"** 에만 답한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"에타의 시간표인데. (…) 일정 에선 정말 나 언제 어디로 보스가야하지?
 * 를 주력으로 보여주는거임"* · *"내가 가는 보스만. 보스 얼굴. 파티 이름 내가 갈 캐릭터
 * 표시하는거 좋을듯"*
 *
 * 그래서 이 화면에 **없는 것**들이 중요하다. 파티 명단도, 남의 가능 시간도, 수익도 없다.
 * 그 넷은 각각 자기 화면을 갖고 있고, 여기 얹으면 "내 일정"이 그 안에 묻힌다 —
 * 대시보드가 정확히 그래서 없어졌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 세로축이 시간인가 (겹쳐보기와 방향이 반대다)
 * ─────────────────────────────────────────────────────────────────────────────
 * `/schedule` 의 겹쳐보기는 **가로축이 시간**이다. 거기서는 "여러 사람"이 세로로 쌓여야
 * 겹침이 보이기 때문이다. 이 화면에 쌓을 사람은 나 하나뿐이고, 대신 **7일을 나란히**
 * 놓아야 "이번 주 어디가 비었나"가 보인다. 그래서 축이 돌아간다.
 * 좌표 계산 자체는 같은 모듈을 공유한다(`timetable-layout.ts` 머리말).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 칸 순서는 **목 → 수**. 월요일부터가 아니다
 * ─────────────────────────────────────────────────────────────────────────────
 * 주간 초기화가 KST 목요일 00:00 이므로(§1) 이 시간표의 "한 주"는 목요일에 시작한다.
 * 월요일을 왼쪽 끝에 두면 같은 화면 안에서 초기화 선이 한가운데를 지나가고, "이번 주에
 * 아직 몇 개 남았나"가 눈으로 읽히지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **데이터는 캐시가 소유한다** (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버 컴포넌트가 같은 조회를 돌려 캐시에 심고(`dehydrateQueries`), 여기서 `useQuery` 로
 * 인수한다. 키가 `queryKeys.db.runs.*` 아래에 있어 **일정을 만들거나 시각을 옮기는
 * 뮤테이션이 이미 무효화하고 있다** — 새 무효화를 추가할 필요가 없었다.
 */

/** 한 시간의 세로 픽셀. 40분짜리 묶음이 67px 이 되어 두 줄이 들어간다. */
const HOUR_PX = 100;

/** 시각 눈금 칸의 폭. `21:00` 이 잘리지 않는 최소치. */
const GUTTER = "3.25rem";

/**
 * 가로 최소 폭. 이보다 좁으면 **가로 스크롤**한다.
 *
 * 7칸 × 약 120px 이 하한이다 — 그 아래에서는 파티 이름이 `익검…` 으로 잘려 블록이
 * 아무것도 말하지 않게 된다. 360px 폰에서 7일을 다 보여 주려다 정보를 지우느니
 * 스크롤을 쓴다(에타 시간표도 같은 선택을 한다).
 */
const MIN_BODY_WIDTH = "54rem";

/** 이 높이(px) 아래로는 글자를 넣지 않는다 — 잘린 글자는 없는 것만 못하다. */
const HEIGHT_FOR_TEXT = 44;
/** 이 높이부터 파티·캐릭터 줄까지 넣는다. */
const HEIGHT_FOR_DETAIL = 62;

/** 블록에 얼굴을 몇 개까지 늘어놓는가. 넘치면 `+N`. */
const MAX_FACES = 3;

export interface WeekTimetableProps {
  readonly weekKey: WeekKey;
  /** 서버가 정한 기준 시각. 오늘 칸 강조가 하이드레이션에서 흔들리지 않게 주입한다. */
  readonly now: Date;
  /** 이번 주 범위(목 00:00 ~ 다음 목 00:00). **데이터가 아니라 렌더 기준점**이다. */
  readonly range: TimeRange;
}

export function WeekTimetable({ weekKey, now, range }: WeekTimetableProps) {
  const timetableQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.runs.timetable(weekKey)),
    queryFn: () => fetchMyTimetable(weekKey),
  });

  const days = useMemo(() => buildDayRows(range), [range]);
  const runs = timetableQuery.data;

  const layout = useMemo(
    () =>
      runs === undefined
        ? null
        : buildTimetableLayout(runs, new Set(days.map((day) => day.dayKey))),
    [runs, days],
  );

  const todayKey = kstDayKey(now);

  if (layout === null) {
    return timetableQuery.isError ? (
      <ErrorState
        title="이번 주 일정을 불러오지 못했습니다"
        detail={timetableQuery.error.message}
        onRetry={() => void timetableQuery.refetch()}
      />
    ) : (
      <Skeleton className="h-96" />
    );
  }

  if (layout.blocks.length === 0) {
    return (
      <EmptyState
        icon={<CalendarPlus aria-hidden size={22} className="text-primary" />}
        title="이번 주에 잡힌 내 일정이 없습니다"
        description={
          <>
            파티에 참가로 등록된 일정만 여기에 나옵니다. 아직 시각을 정하지 않은
            일정은 &lsquo;일정 추가&rsquo; 화면의 목록에 있습니다.
          </>
        }
        action={
          <Link href="/schedule">
            <Button>일정 잡으러 가기 →</Button>
          </Link>
        }
      />
    );
  }

  const { axis, blocks } = layout;
  const spanMinutes = axis.endMinute - axis.startMinute;
  const bodyHeight = Math.round((spanMinutes / 60) * HOUR_PX);

  /*
    시각 눈금. 축이 24:00 을 넘을 수 있으므로 `25:00` `26:00` 이 그대로 나온다 —
    사람들이 실제로 그렇게 말하고, 24 로 되돌리면 어느 날인지가 흐려진다.
  */
  const hourTicks: number[] = [];
  for (
    let minute = Math.ceil(axis.startMinute / 60) * 60;
    minute <= axis.endMinute;
    minute += 60
  ) {
    hourTicks.push(minute);
  }

  const blocksByDay = new Map<string, TimetableBlock[]>();
  for (const block of blocks) {
    const bucket = blocksByDay.get(block.dayKey) ?? [];
    bucket.push(block);
    blocksByDay.set(block.dayKey, bucket);
  }

  return (
    /*
      넓은 내용은 **자기 컨테이너 안에서** 가로 스크롤한다. 페이지 본문이 가로로
      밀리면 다른 화면 요소까지 함께 흔들린다.
    */
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <div style={{ minWidth: MIN_BODY_WIDTH }}>
        {/* ── 머리 행: 요일 ─────────────────────────────────────────────── */}
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: `${GUTTER} repeat(7, minmax(0, 1fr))` }}
        >
          <div aria-hidden />
          {days.map((day) => (
            <DayHeader key={day.dayKey} day={day} isToday={day.dayKey === todayKey} />
          ))}
        </div>

        {/* ── 본문: 시각 눈금 + 7칸 ─────────────────────────────────────── */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `${GUTTER} repeat(7, minmax(0, 1fr))` }}
        >
          {/* 시각 눈금 칸. 라벨은 선 **위에** 앉는다(선이 곧 그 시각이다). */}
          <div className="relative" style={{ height: bodyHeight }}>
            {hourTicks.map((minute) => (
              <span
                key={minute}
                className="absolute right-1.5 -translate-y-1/2 text-overline tabular-nums text-ink-muted"
                style={{ top: `${String(toAxisPercent(minute, axis))}%` }}
              >
                {formatHourTick(minute)}
              </span>
            ))}
          </div>

          {days.map((day) => (
            <div
              key={day.dayKey}
              className={cn(
                "relative border-l border-border",
                day.dayKey === todayKey ? "bg-primary-subtle/40" : null,
                day.isWeekend && day.dayKey !== todayKey ? "bg-hover-surface/50" : null,
              )}
              style={{ height: bodyHeight }}
            >
              {/* 시각선. 24:00 은 **날짜가 바뀌는 선**이라 굵게 긋는다. */}
              {hourTicks.map((minute) => (
                <div
                  key={minute}
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 border-t",
                    minute === DAY_MINUTES
                      ? "border-border-strong"
                      : "border-border/60",
                  )}
                  style={{ top: `${String(toAxisPercent(minute, axis))}%` }}
                />
              ))}

              {(blocksByDay.get(day.dayKey) ?? []).map((block) => (
                <RunBlock key={block.key} block={block} axis={axis} height={bodyHeight} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** `21:00` · 24:00 을 넘으면 `25:00`. 자정 넘김을 되돌리지 않는다. */
function formatHourTick(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:00`;
}

function formatClock(date: Date): string {
  return formatKst(date, "HH:mm");
}

function DayHeader({
  day,
  isToday,
}: {
  readonly day: DayRow;
  readonly isToday: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-0.5 border-l border-border px-1 py-2",
        isToday ? "bg-primary-subtle" : null,
      )}
    >
      {/*
        요일이 먼저다 — 스케줄 화면에서 사람은 "며칠"보다 "무슨 요일"로 먼저 생각한다
        (`overlay-layout.ts` 의 `weekdayLabel` 주석과 같은 근거).
        오늘은 **색과 굵기 두 채널**로 말한다(§4 — 색 단독 금지).
      */}
      <span
        className={cn(
          "text-body-sm",
          isToday ? "font-bold text-primary" : "font-semibold text-ink",
        )}
      >
        {day.weekdayLabel}
        {isToday ? <span className="sr-only"> (오늘)</span> : null}
      </span>
      <span className="text-overline tabular-nums text-ink-muted">
        {day.dateLabel}
      </span>
    </div>
  );
}

/**
 * 블록 하나.
 *
 * ★ 높이에 따라 **글자를 덜어 낸다.** 20분짜리 묶음은 33px 이라 두 줄이 들어가지 않는데,
 *   억지로 넣으면 잘린 글자가 남아 오히려 못 읽는다. 대신 `title` 이 언제나 전부를 싣고,
 *   보조기기에는 `sr-only` 로 같은 문장을 준다 — 시각적으로 줄인 것이 정보 손실이 되지
 *   않게 하는 쪽이다.
 * ★ 좌측 4px 보더는 **난이도 전용 채널**이다(§4). 묶음에 난이도가 섞이면 첫 보스 기준이며,
 *   얼굴이 옆에 다 늘어서 있으므로 색이 유일한 단서가 되는 경우가 없다.
 */
function RunBlock({
  block,
  axis,
  height,
}: {
  readonly block: TimetableBlock;
  readonly axis: OverlayAxis;
  readonly height: number;
}) {
  const top = toAxisPercent(block.startMinute, axis);
  const bottom = toAxisPercent(block.endMinute, axis);
  const heightPct = Math.max(bottom - top, 1);
  const pixels = (heightPct / 100) * height;

  const bossNames = block.runs.map((run) => run.shortName ?? run.bossKoreanName);
  const timeText = `${formatClock(block.startsAt)}~${formatClock(block.endsAt)}`;
  const characterText =
    block.characterNames.length === 0
      ? "캐릭터 미지정"
      : block.characterNames.join(", ");
  const full = `${timeText} · ${bossNames.join(" ")} · ${block.partyName} · ${characterText}`;

  const faces = block.runs.slice(0, MAX_FACES);
  const overflow = block.runs.length - faces.length;

  const difficulty = block.runs[0]?.difficulty ?? "normal";

  return (
    <Link
      href={`/schedule?partyId=${encodeURIComponent(block.partyId)}`}
      title={full}
      className={cn(
        "absolute left-0.5 flex flex-col gap-0.5 overflow-hidden rounded-md border border-l-4 border-border bg-surface px-1.5 py-1",
        "transition duration-200 hover:bg-hover-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        BOSS_DIFFICULTY_BORDER_L[difficulty as BossDifficulty],
      )}
      style={{
        top: `${String(top)}%`,
        height: `${String(heightPct)}%`,
        width: `calc(${String(100 / block.laneCount)}% - 0.25rem)`,
        left: `calc(${String((100 / block.laneCount) * block.lane)}% + 0.125rem)`,
      }}
    >
      <span className="sr-only">{full}</span>

      <span aria-hidden className="flex items-center gap-0.5">
        {faces.map((run) => (
          <BossIcon
            key={run.runId}
            bossDifficultyId={run.bossDifficultyId}
            difficulty={run.difficulty}
            size="sm"
            className="size-5 rounded-sm"
          />
        ))}
        {overflow > 0 ? (
          <span className="text-overline tabular-nums text-ink-muted">
            +{overflow}
          </span>
        ) : null}
      </span>

      {pixels >= HEIGHT_FOR_TEXT ? (
        <span
          aria-hidden
          className="truncate text-caption font-bold leading-tight text-ink"
        >
          {bossNames.join(" ")}
        </span>
      ) : null}

      {pixels >= HEIGHT_FOR_DETAIL ? (
        <span
          aria-hidden
          className="truncate text-overline leading-tight text-ink-muted"
        >
          {block.partyName}
          {block.characterNames.length > 0 ? ` · ${characterText}` : null}
        </span>
      ) : null}
    </Link>
  );
}
