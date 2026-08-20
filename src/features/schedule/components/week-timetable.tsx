"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

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

import { RunDetailDialog } from "./run-detail-dialog";
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

/**
 * 한 시간의 세로 픽셀.
 *
 * ★ **가장 짧은 블록이 두 줄을 담을 수 있는 값**으로 정한다 — 이것이 이 상수의 유일한
 *   근거다. 보스 한 판은 20분이고 묶이지 않은 20분짜리 런은 흔하다. 126px/시간이면
 *   20분 = **42px** 이고, 아래 `BLOCK_MIN_PX` 계산대로 두 줄이 들어간다.
 *
 * ⚠️ 2026-08-20 정정. 처음에 100 으로 잡았다가 20분 블록이 **33px** 이 됐고, 거기에
 *    "44px 미만이면 글자를 넣지 않는다"는 규칙이 겹쳐 **아이콘 하나만 있는 빈 블록**이
 *    화면에 나갔다(발주 지적: *"뭐 아무것도 안써있는데?"*). 게이트가 아니라 높이가
 *    틀렸던 것이다 — 잘린 글자를 피하려다 아무 글자도 없는 칸을 만들었다.
 */
const HOUR_PX = 126;

/**
 * 블록이 아무리 짧아도 이만큼은 차지한다.
 *
 * 산술: `py-1`(8px) + 얼굴·보스명 줄 16px + 파티·캐릭터 줄 14px = **38px**. 여유 4px 을
 * 더해 42px 이고, 이는 `HOUR_PX` 기준 20분과 정확히 같다 — 즉 **실제로는 20분 미만
 * 런에서만 발동한다.** 그래서 이 하한이 이웃 블록을 밀고 들어가는 일이 사실상 없다.
 */
const BLOCK_MIN_PX = 42;

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

/** 블록에 얼굴을 몇 개까지 늘어놓는가. 넘치면 `+N`. */
const MAX_FACES = 3;

/**
 * 얼굴을 **칸 높이에 맞춘다** (발주 지시 2026-08-20: *"이미지 살짝더 키워서 셀높이에
 * 딱 맞춰줘"*).
 *
 * 블록의 실제 픽셀 높이에서 안팎 여백(`py-1` 8px + 테두리 2px)을 뺀 값이 얼굴이 쓸 수
 * 있는 높이다. 상·하한이 필요한 이유:
 *   - 하한 18px — 그 아래로는 보스가 무엇인지 알아볼 수 없어 얼굴이 장식이 된다.
 *   - 상한 40px — 1시간짜리 블록(126px)에서 얼굴만 커지면 옆의 글자가 눌린다.
 *   - 얼굴이 둘 이상이면 28px — 40px 짜리 셋이면 120px 이라 폭 120px 칸을 통째로 먹는다.
 *
 * ★ 이 규칙이 성립하는 전제는 **상세가 모달로 빠졌다**는 것이다(`run-detail-dialog.tsx`).
 *   블록이 명단까지 책임지던 때였다면 얼굴에 이만큼 내줄 수 없었다.
 */
function faceSize(blockPx: number, faceCount: number): number {
  const available = blockPx - 10;
  const cap = faceCount > 1 ? 28 : 40;
  return Math.max(18, Math.min(available, cap));
}

export interface WeekTimetableProps {
  readonly weekKey: WeekKey;
  /** 서버가 정한 기준 시각. 오늘 칸 강조가 하이드레이션에서 흔들리지 않게 주입한다. */
  readonly now: Date;
  /** 이번 주 범위(목 00:00 ~ 다음 목 00:00). **데이터가 아니라 렌더 기준점**이다. */
  readonly range: TimeRange;
}

export function WeekTimetable({ weekKey, now, range }: WeekTimetableProps) {
  /*
    열려 있는 블록. **블록 객체 자체를 들고 있지 않고 키만 들고 있다** — 재조회로 배열이
    갈리면 예전 객체가 낡은 명단을 계속 보여 주기 때문이다. 키로 매 렌더 다시 찾으면
    모달이 언제나 최신 값을 그리고, 그 사이 사라진 일정은 자연스럽게 닫힌다.
  */
  const [openKey, setOpenKey] = useState<string | null>(null);

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

  /*
    키로 매 렌더 다시 찾는다(위 `openKey` 주석). 재조회 뒤 사라진 일정이면 `undefined`
    가 되어 모달이 스스로 닫힌다 — 지워진 일정의 명단을 계속 띄우고 있지 않는다.
  */
  const openBlock = blocks.find((entry) => entry.key === openKey) ?? null;

  return (
    <>
    {/*
      넓은 내용은 **자기 컨테이너 안에서** 가로 스크롤한다. 페이지 본문이 가로로
      밀리면 다른 화면 요소까지 함께 흔들린다.
    */}
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
                <RunBlock
                  key={block.key}
                  block={block}
                  axis={axis}
                  bodyHeight={bodyHeight}
                  onOpen={() => {
                    setOpenKey(block.key);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>

    <RunDetailDialog
      block={openBlock}
      onClose={() => {
        setOpenKey(null);
      }}
    />
    </>
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
 * ─────────────────────────────────────────────────────────────────────────────
 * 링크가 아니라 **버튼**이다 — 누르면 상세 모달이 열린다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-08-20): *"이거 클릭하면 저 보스에 대한 상세 모달을 여는걸로 변경해"*.
 * 예전에는 `/schedule?partyId=…` 로 가는 링크였는데, "무슨 일정인지 확인하고 싶다"에
 * 화면 전환으로 답하는 셈이라 되돌아오는 비용이 컸다. 수정하러 가는 길은 모달 바닥에
 * 그대로 남아 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 얼굴이 칸 높이를 채운다 — 그리고 그게 가능한 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"이미지 살짝더 키워서 셀높이에 딱 맞춰줘"*. 크기 계산은 `faceSize()` 에 있다.
 *
 * 이게 성립하는 것은 **상세가 모달로 빠졌기 때문**이다. 블록이 명단까지 책임지던 때라면
 * 얼굴에 내줄 높이가 없었다. 남은 두 줄(보스명 · 파티·캐릭터)은 이제 "잘려도 되는" 값이다 —
 * 전부가 `title` 과 `sr-only` 와 모달에 있다.
 *
 * ⚠️ 2026-08-20 사고 기록: 처음에는 "높이가 모자라면 글자를 뺀다"로 만들었다가 20분짜리
 *    런이 33px 이 되면서 **얼굴 하나만 있고 아무 글자도 없는 블록**이 나갔다
 *    (*"뭐 아무것도 안써있는데?"*). 잘린 글자보다 나쁜 것이 빈 칸이다. 그래서 지금은
 *    두 줄을 **항상** 그리고, 대신 `HOUR_PX`·`BLOCK_MIN_PX` 로 그 높이를 보장한다.
 *
 * ★ 좌측 4px 보더는 **난이도 전용 채널**이다(§4). 묶음에 난이도가 섞이면 첫 보스 기준이며,
 *   얼굴이 옆에 다 늘어서 있으므로 색이 유일한 단서가 되는 경우가 없다.
 */
function RunBlock({
  block,
  axis,
  bodyHeight,
  onOpen,
}: {
  readonly block: TimetableBlock;
  readonly axis: OverlayAxis;
  /** 격자 본문의 픽셀 높이. 블록의 실제 높이를 알아야 얼굴 크기를 정할 수 있다. */
  readonly bodyHeight: number;
  readonly onOpen: () => void;
}) {
  const top = toAxisPercent(block.startMinute, axis);
  const bottom = toAxisPercent(block.endMinute, axis);
  const heightPct = Math.max(bottom - top, 1);

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

  // `minHeight` 하한이 실제 높이를 밀어 올릴 수 있으므로 얼굴도 그 값을 봐야 한다.
  const blockPx = Math.max((heightPct / 100) * bodyHeight, BLOCK_MIN_PX);
  const facePx = faceSize(blockPx, faces.length);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={full}
      className={cn(
        "absolute flex items-center gap-1.5 overflow-hidden rounded-md border border-l-4 border-border bg-surface px-1.5 py-1 text-left",
        "transition duration-200 hover:bg-hover-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        BOSS_DIFFICULTY_BORDER_L[difficulty as BossDifficulty],
      )}
      style={{
        top: `${String(top)}%`,
        height: `${String(heightPct)}%`,
        /*
          짧은 런이 두 줄을 잃지 않게 하는 하한. `HOUR_PX` 기준 20분과 같은 값이라
          실제로는 20분 미만에서만 발동하고, 그래서 이웃 블록을 밀지 않는다.
        */
        minHeight: `${String(BLOCK_MIN_PX)}px`,
        width: `calc(${String(100 / block.laneCount)}% - 0.25rem)`,
        left: `calc(${String((100 / block.laneCount) * block.lane)}% + 0.125rem)`,
      }}
    >
      <span className="sr-only">{full} — 상세 보기</span>

      {/* 얼굴 — 칸 높이에 맞춘다(머리말). `size-full` 이 `BossIcon` 의 기본 크기를 이긴다. */}
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {faces.map((run) => (
          <span
            key={run.runId}
            className="block shrink-0"
            style={{ width: facePx, height: facePx }}
          >
            <BossIcon
              bossDifficultyId={run.bossDifficultyId}
              difficulty={run.difficulty}
              size="sm"
              className="size-full rounded-sm"
            />
          </span>
        ))}
        {overflow > 0 ? (
          <span className="text-overline tabular-nums text-ink-muted">
            +{overflow}
          </span>
        ) : null}
      </span>

      {/*
        두 줄은 **언제나** 그린다. 좁아서 잘리는 것은 정보 손실이 아니다 — 전부가
        `title`·`sr-only`·모달에 있다. 빈 칸과 다른 점이 정확히 이것이다.
      */}
      <span className="flex min-w-0 flex-col gap-px">
        <span
          aria-hidden
          className="truncate text-caption font-bold leading-tight text-ink"
        >
          {bossNames.join(" ")}
        </span>
        <span
          aria-hidden
          className="truncate text-overline leading-tight text-ink-muted"
        >
          {block.partyName} · {characterText}
        </span>
      </span>
    </button>
  );
}
