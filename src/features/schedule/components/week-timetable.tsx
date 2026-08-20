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
 * 한 시간의 세로 크기. **화면 폭에 따라 다르다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 폰에서 더 크게 잡는가 (발주 지시 2026-08-20: *"핸드폰도 격자로 볼수있게 해"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 폰에서 격자를 그리면 **폭이 희소 자원**이 된다 — 360px 화면에서 한 칸이 약 42px 다.
 * 그 폭에 얼굴과 글자를 나란히 놓을 자리는 없으므로 **세로로 쌓아야** 하고, 쌓으려면
 * 블록이 그만큼 높아야 한다. 그런데 폰은 원래 세로가 길다(발주자: *"폰으로 보면 세로가
 * 기니까"*) — 즉 여기서는 높이를 **써도 되는 자원**이다. 그래서 시간 축을 늘려 잡는다.
 *
 * 산술: 폰 160px/시간이면 20분짜리가 **53px** 이고, `py-0.5`(4px) + 얼굴 24px + 이름
 * 줄 14px = 42px 이 들어간다. 데스크톱 126px/시간은 그대로 두는데, 거기서는 폭이 넉넉해
 * 가로로 눕힐 수 있어 그만한 높이가 필요 없기 때문이다.
 *
 * ★ **CSS 변수로 둔 이유**: 화면 폭 판정을 JS 로 하면 서버 렌더에서 폭을 모르므로
 *   하이드레이션 때 격자 높이가 한 번 튄다. `--hour` 를 미디어 쿼리(`md:`)로 갈아 끼우면
 *   첫 페인트부터 옳고, 블록 위치는 어차피 **백분율**이라 컨테이너 높이만 맞으면 된다.
 */
const HOUR_VAR = "[--hour:160px] md:[--hour:126px]";

/**
 * `blockLayout()` 에 넘길 데스크톱 기준 시간당 픽셀.
 *
 * 배치·얼굴 크기 계산은 **데스크톱 값으로만** 한다. 폰에서는 그 결과를 쓰지 않고
 * 언제나 세로로 쌓기 때문이다(`RunBlock` 의 `md:` 분기) — 두 벌을 계산할 이유가 없다.
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

/**
 * 격자 열 정의 — 시각 눈금 칸 + 요일 7칸.
 *
 * 눈금 칸이 폰에서 좁은 이유: 360px 화면에서 3.25rem(52px)을 떼면 요일 한 칸이 39px 로
 * 떨어진다. 2.25rem(36px)이면 `18:00` 이 11px 글자로 아슬하게 들어가면서 요일 칸에
 * 2px 씩을 돌려준다. 데스크톱에서는 폭이 남으므로 원래대로 넉넉히 둔다.
 */
const GRID_COLS =
  "grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] md:grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]";

/**
 * 격자의 가로 최소 폭 — **`md` 이상에서만** 건다.
 *
 * ⚠️ 폰에는 걸지 않는다(발주 지시: *"핸드폰도 격자로 볼수있게 해"*). 최소 폭을 주는
 *    순간 360px 화면은 가로 스크롤이 되고, 미는 동안 시각 눈금 칸이 화면 밖으로 나가
 *    **위치가 시각을 말해 주지 못한다** — 격자의 값이 통째로 사라진다. 폰에서는 칸이
 *    좁아도 7일이 한 화면에 들어와 있는 쪽이 낫다(에타 시간표와 같은 선택).
 *
 * `md` 이상에서 44rem 인 이유: 그 폭에서 한 칸이 약 93px 이고, 더 좁히면 파티 이름이
 * `익검…` 으로 잘려 블록이 아무것도 말하지 않게 된다. 그보다 좁은 창은 창을 줄인
 * 데스크톱의 예외 경로라 스크롤이 남는다.
 */
const MIN_BODY_WIDTH = "md:min-w-[44rem]";

/** 블록에 얼굴을 몇 개까지 늘어놓는가. 넘치면 `+N`. */
const MAX_FACES = 3;

/** 블록 안쪽 여백(`py-1` 8px) + 위아래 테두리 2px. 내용이 실제로 쓸 수 있는 높이의 차감분. */
const BLOCK_PADDING_PX = 10;

/** 두 줄(보스명 12px bold + 파티·캐릭터 11px, 둘 다 leading-tight)이 차지하는 높이. */
const TEXT_ROWS_PX = 30;

/** 세로로 쌓을 때 얼굴이 이보다 작아질 바에는 가로로 눕힌다. */
const MIN_STACKED_FACE_PX = 24;

interface BlockLayout {
  /** `true` = 얼굴을 위, 글자를 아래(세로). `false` = 얼굴을 왼쪽, 글자를 오른쪽(가로). */
  readonly stacked: boolean;
  readonly facePx: number;
}

/**
 * **카드 높이가 배치를 정한다** (발주 지시 2026-08-20: *"카드 높이에 따라서 배치 바뀌게
 * 해줘"*).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 한 배치로는 안 되는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 20분짜리(42px)와 1시간짜리(126px)는 **모양이 다른 상자**다. 같은 배치를 쓰면 한쪽이
 * 반드시 망가진다:
 *   · 가로 배치를 큰 카드에 쓰면 → 남는 높이는 그대로 버리고 글자만 좁은 오른쪽 기둥에
 *     몰려 `익` `세` 처럼 **한 글자씩 세로로 접힌다**(발주자가 보낸 화면이 그것이다).
 *   · 세로 배치를 작은 카드에 쓰면 → 얼굴 줄과 글자 두 줄이 42px 에 안 들어가 잘린다.
 *
 * 그래서 **높이를 재서 고른다.** 세로로 쌓으려면 얼굴 줄 + 글자 두 줄이 다 들어가야 하고,
 * 그러고도 얼굴이 `MIN_STACKED_FACE_PX` 는 돼야 보스를 알아볼 수 있다. 못 미치면 눕힌다.
 *
 * 경계는 `BLOCK_PADDING_PX + TEXT_ROWS_PX + MIN_STACKED_FACE_PX` = **64px**, 즉
 * `HOUR_PX` 기준 약 30분이다. 20분짜리 단발은 가로, 이어 도는 묶음은 대개 세로가 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 얼굴 크기 — **칸 높이에 맞춘다** (같은 날 발주 지시)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"이미지 살짝더 키워서 셀높이에 딱 맞춰줘"*. 쓸 수 있는 높이는 배치에 따라 다르다 —
 * 가로면 내용 높이 전부, 세로면 거기서 글자 두 줄을 뺀 나머지다.
 *
 * 상·하한이 필요한 이유:
 *   - 하한 18px — 그 아래로는 보스가 무엇인지 알아볼 수 없어 얼굴이 장식이 된다.
 *   - 상한 40px — 얼굴만 커지면 옆(또는 아래)의 글자가 눌린다.
 *   - 얼굴이 둘 이상이면 28px — 40px 짜리 셋이면 120px 이라 폭 120px 칸을 통째로 먹는다.
 */
function blockLayout(blockPx: number, faceCount: number): BlockLayout {
  const content = blockPx - BLOCK_PADDING_PX;
  const stackedFace = content - TEXT_ROWS_PX;
  const stacked = stackedFace >= MIN_STACKED_FACE_PX;

  const cap = faceCount > 1 ? 28 : 40;
  const available = stacked ? stackedFace : content;
  return { stacked, facePx: Math.max(18, Math.min(available, cap)) };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 축은 **18:00 ~ 25:00 고정**이고, 벗어난 일정은 접어서 위아래에 붙인다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"기본값을 18시~25시 정도로 주고 그걸 벗어나는 값은 위 혹은
 * 아래에 시간 하이라이트를 넣어줘 중간에 ~ 표시 넣어서 생략하고"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 데이터에 맞추던 것을 고정으로 바꿨나
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 그 주에 실제로 있는 일정에 맞춰 축을 잡았다(`computeOverlayAxis`). 겹쳐보기
 * 화면에서는 그게 옳다 — 거기서는 "언제가 비었나"를 찾는 것이 목적이라 축이 데이터를
 * 따라가야 한다.
 *
 * 이 화면은 목적이 다르다. **주마다 같은 자리에 같은 시간이 있어야** "화요일 9시쯤"이
 * 눈에 익는다. 데이터에 맞추면 새벽 4시 일정 하나 때문에 축이 03:00~09:00 이 되고,
 * 저녁 시간대가 통째로 화면에서 사라진다(발주자가 보낸 화면이 정확히 그것이다).
 *
 * 그래서 축은 고정하고, **벗어난 것은 지우지 않고 접는다**:
 *   · 18:00 이전 시작 → 위쪽 띠
 *   · 25:00 이후 시작 → 아래쪽 띠
 *   · 그 사이에 `~` 를 찍어 **여기 시간이 생략됐다**고 말한다
 * 띠 안에서는 위치가 시각을 뜻하지 않으므로 **블록마다 시각을 글자로 적는다**(발주 요구의
 * "시간 하이라이트"). 위치가 정보를 잃으면 글자가 대신해야 한다.
 */
const AXIS_START_MINUTE = 18 * 60;
const AXIS_END_MINUTE = 25 * 60;

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

  const { blocks } = layout;

  /*
    ★ `layout.axis` 는 **쓰지 않는다.** 그것은 데이터에 맞춰 좁힌 축이고(겹쳐보기와 공유),
      이 화면은 고정 축을 쓴다(위 상수 주석). 계산은 그대로 두되 여기서 안 볼 뿐이다.

    분류는 **시작 시각** 기준이다. 24:50 에 시작해 25:30 에 끝나는 런은 "저녁 일정"이지
    "새벽 일정"이 아니므로 본문에 남는다 — 그런 런을 위해 축 끝만 늘린다.
  */
  const early = blocks.filter((block) => block.startMinute < AXIS_START_MINUTE);
  const late = blocks.filter((block) => block.startMinute >= AXIS_END_MINUTE);
  const main = blocks.filter(
    (block) =>
      block.startMinute >= AXIS_START_MINUTE &&
      block.startMinute < AXIS_END_MINUTE,
  );

  const axis: OverlayAxis = {
    startMinute: AXIS_START_MINUTE,
    // 본문에 남은 런이 25:00 을 넘겨 끝나면 그만큼만 늘린다. 시작은 절대 안 내린다.
    endMinute: main.reduce(
      (end, block) => Math.max(end, block.endMinute),
      AXIS_END_MINUTE,
    ),
    ticks: [],
    hasOvernight: true,
  };

  const spanMinutes = axis.endMinute - axis.startMinute;
  /*
    격자 높이는 **CSS 로 계산한다** — `--hour` 가 화면 폭에 따라 갈리기 때문이다
    (`HOUR_VAR` 주석). 블록 위치는 백분율이라 컨테이너 높이만 맞으면 그대로 따라온다.
  */
  const bodyHeight = `calc(var(--hour) * ${String(spanMinutes / 60)})`;
  /** 배치·얼굴 크기 판정용 데스크톱 기준 픽셀. 폰에서는 쓰이지 않는다. */
  const desktopBodyPx = Math.round((spanMinutes / 60) * HOUR_PX);

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

  const blocksByDay = groupByDay(main);
  const earlyByDay = groupByDay(early);
  const lateByDay = groupByDay(late);

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
    <div
      /*
        ★ `overflow-y-hidden` 을 **명시**한다(발주 지시: *"세로 스크롤바는 없애"*).
          CSS 규칙상 한 축만 `visible` 이 아니면 나머지 축의 `visible` 은 `auto` 로
          계산된다 — 즉 `overflow-x-auto` 만 쓰면 **세로 스크롤바가 딸려 온다.**
          격자 높이는 우리가 정확히 계산하므로 세로로 넘칠 것이 없고, 넘치는 경우
          (블록 최소 높이가 마지막 줄을 살짝 밀 때)는 아래 여백이 흡수한다.
      */
      className={cn(
        "overflow-x-auto overflow-y-hidden rounded-xl border border-border bg-surface",
        HOUR_VAR,
      )}
    >
      <div className={MIN_BODY_WIDTH}>
        {/* ── 머리 행: 요일 ─────────────────────────────────────────────── */}
        <div className={cn("grid border-b border-border", GRID_COLS)}>
          <div aria-hidden />
          {days.map((day) => (
            <DayHeader key={day.dayKey} day={day} isToday={day.dayKey === todayKey} />
          ))}
        </div>

        {/* ── 18:00 이전 — 접어서 위에 ──────────────────────────────────── */}
        <OutlierStrip
          label="이른 시간"
          byDay={earlyByDay}
          days={days}
          todayKey={todayKey}
          onOpen={setOpenKey}
        />

        {/* ── 본문: 시각 눈금 + 7칸 ─────────────────────────────────────── */}
        <div className={cn("grid", GRID_COLS)}>
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
                  bodyHeight={desktopBodyPx}
                  onOpen={() => {
                    setOpenKey(block.key);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        {/* ── 25:00 이후 — 접어서 아래에 ────────────────────────────────── */}
        <OutlierStrip
          label="늦은 시간"
          byDay={lateByDay}
          days={days}
          todayKey={todayKey}
          onOpen={setOpenKey}
          atBottom
        />
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

function groupByDay(
  blocks: readonly TimetableBlock[],
): ReadonlyMap<string, TimetableBlock[]> {
  const byDay = new Map<string, TimetableBlock[]>();
  for (const block of blocks) {
    const bucket = byDay.get(block.dayKey) ?? [];
    bucket.push(block);
    byDay.set(block.dayKey, bucket);
  }
  return byDay;
}

/**
 * 고정 축(18:00~25:00) 밖으로 나간 일정을 **접어서** 붙이는 띠.
 *
 * 발주 지시(2026-08-20): *"그걸 벗어나는 값은 위 혹은 아래에 시간 하이라이트를 넣어줘
 * 중간에 ~ 표시 넣어서 생략하고"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기서는 **위치가 시각을 뜻하지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 격자에서는 블록이 어디 있느냐가 곧 몇 시인가였다. 띠에서는 그 규칙이 깨진다 —
 * 04:00 과 09:00 이 나란히 서 있어도 사이의 5시간은 그려지지 않는다.
 *
 * 그래서 **시각을 글자로 크게 적는다.** 위치가 잃은 정보를 글자가 대신 지지 않으면
 * 화면이 거짓말을 한다(발주 요구의 "시간 하이라이트"가 이것이다).
 * 그리고 띠와 격자 사이에 `~` 를 찍어 **여기 시간이 생략됐다**고 명시한다 — 표시가 없으면
 * 띠가 축의 연장으로 읽혀 04:00 일정이 17시쯤인 줄 알게 된다.
 *
 * ★ 해당 일정이 하나도 없으면 **아무것도 그리지 않는다.** 빈 띠와 `~` 는 "여기 뭔가
 *   있는데 안 보인다"는 잘못된 신호다.
 */
function OutlierStrip({
  label,
  byDay,
  days,
  todayKey,
  onOpen,
  atBottom = false,
}: {
  readonly label: string;
  readonly byDay: ReadonlyMap<string, TimetableBlock[]>;
  readonly days: readonly DayRow[];
  readonly todayKey: string;
  readonly onOpen: (key: string) => void;
  /** 아래쪽 띠인가. `~` 를 띠의 위에 둘지 아래에 둘지가 갈린다. */
  readonly atBottom?: boolean;
}) {
  if (byDay.size === 0) return null;

  const omitted = (
    <div
      aria-hidden
      className={cn("grid", GRID_COLS)}
    >
      <div />
      <div className="col-span-7 flex items-center gap-2 px-2 py-0.5">
        <span className="h-px flex-1 bg-border" />
        <span className="text-overline tabular-nums text-ink-muted">
          ~ 생략 ~
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );

  const strip = (
    <div
      className={cn("grid", GRID_COLS)}
    >
      <div className="flex items-center justify-end px-1 py-1 md:px-1.5">
        <span className="text-overline leading-tight text-ink-muted">{label}</span>
      </div>
      {days.map((day) => (
        <div
          key={day.dayKey}
          className={cn(
            "flex flex-col gap-1 border-l border-border p-1",
            day.dayKey === todayKey ? "bg-primary-subtle/40" : null,
            day.isWeekend && day.dayKey !== todayKey
              ? "bg-hover-surface/50"
              : null,
          )}
        >
          {(byDay.get(day.dayKey) ?? []).map((block) => (
            <StaticRunBlock
              key={block.key}
              block={block}
              onOpen={() => {
                onOpen(block.key);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <>
      {atBottom ? omitted : null}
      {strip}
      {atBottom ? null : omitted}
    </>
  );
}

/**
 * **좌표를 갖지 않는** 블록. 접힌 띠와 모바일 목록이 함께 쓴다.
 *
 * 격자 블록(`RunBlock`)과 달리 높이가 자유롭다 — 위치가 시각을 뜻하지 않으므로 내용이
 * 필요한 만큼만 차지한다. 그래서 배치를 고를 일도 없고(`blockLayout` 이 쓰이지 않는다),
 * 대신 **시각을 첫 줄에 글자로 적는다.** 위치가 잃은 정보를 글자가 대신 진다.
 *
 * ★ 이 컴포넌트가 두 곳에서 쓰이는 것이 모바일 대응을 싸게 만든 이유다. 폰에서는 격자
 *   대신 날짜별 목록을 그리는데, 그 목록의 한 줄이 정확히 이 모양이면 된다.
 */
function StaticRunBlock({
  block,
  onOpen,
}: {
  readonly block: TimetableBlock;
  readonly onOpen: () => void;
}) {
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
    <button
      type="button"
      onClick={onOpen}
      title={full}
      className={cn(
        "flex w-full flex-col gap-0.5 overflow-hidden rounded-md border border-l-4 border-border bg-surface px-1.5 py-1 text-left",
        "transition duration-200 hover:bg-hover-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        BOSS_DIFFICULTY_BORDER_L[difficulty as BossDifficulty],
      )}
    >
      <span className="sr-only">{full} — 상세 보기</span>

      {/*
        **시각을 가장 먼저, 강조해서.** 띠에서는 위치가 시각을 말해 주지 않으므로
        이 줄이 그 역할을 통째로 진다(발주 요구의 "시간 하이라이트").
      */}
      <span
        aria-hidden
        className="text-caption font-bold tabular-nums leading-tight text-primary"
      >
        {timeText}
      </span>

      <span aria-hidden className="flex items-center gap-0.5">
        {faces.map((run) => (
          <span key={run.runId} className="block size-5 shrink-0">
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
    </button>
  );
}

/*
 * ★ 여기 있던 `DayAgenda`(폰용 날짜별 목록)는 **지웠다** (2026-08-20).
 *   *"핸드폰도 격자로 볼수있게 해"* — 폰에서 격자를 포기하는 대신, 시간 축을 늘리고
 *   블록을 세로로 쌓아 격자를 그대로 쓰기로 했다(`HOUR_VAR` 주석). 목록이 남아 있으면
 *   같은 화면을 두 벌로 유지하게 되고, 그중 하나는 반드시 낡는다.
 *   `StaticRunBlock` 은 접힌 띠가 계속 쓰므로 남는다.
 */

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
 * 발주 지시: *"이미지 살짝더 키워서 셀높이에 딱 맞춰줘"* · *"카드 높이에 따라서 배치
 * 바뀌게 해줘"*. **배치와 크기를 함께 정하는 것은 `blockLayout()` 하나**이고, 근거는
 * 거기 머리말에 있다 — 큰 카드는 세로로 쌓고 작은 카드는 눕힌다.
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
  const { stacked, facePx } = blockLayout(blockPx, faces.length);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={full}
      className={cn(
        "absolute flex overflow-hidden rounded-md border border-l-4 border-border bg-surface text-left",
        // 폰은 칸이 42px 남짓이라 좌우 여백부터 아낀다.
        "px-0.5 py-0.5 md:px-1.5 md:py-1",
        /*
          배치 전환(발주 요구 *"카드 높이에 따라서 배치 바뀌게 해줘"*).

          ★ **폰에서는 언제나 세로**다. 거기서는 높이가 아니라 **폭**이 희소 자원이라
            (한 칸 약 42px) 얼굴과 글자를 나란히 놓을 자리가 없다. 그래서 `blockLayout()`
            이 고른 방향은 `md:` 부터만 적용한다 — 판정을 두 벌로 만들지 않는 방법이다.
        */
        "flex-col gap-px md:gap-0.5",
        stacked ? "md:flex-col" : "md:flex-row md:items-center md:gap-1.5",
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

      {/*
        얼굴 — 데스크톱에서는 칸 높이에 맞추고(머리말), 폰에서는 **폭에 맞춘 고정 크기**다.
        `--face` 를 넘겨 `md:` 에서만 그 값을 쓰게 하면, 화면 폭 판정을 JS 로 하지 않아도
        되어 하이드레이션 때 크기가 튀지 않는다.
        `size-full` / `size-[var(--face)]` 이 `BossIcon` 의 기본 크기를 이긴다.
      */}
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {faces.map((run) => (
          <span
            key={run.runId}
            className="block size-5 shrink-0 md:size-[var(--face)]"
            style={{ "--face": `${String(facePx)}px` } as React.CSSProperties}
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

        ⚠️ `min-w-0` 이 없으면 `truncate` 가 동작하지 않는다(플렉스 항목의 기본
           `min-width:auto` 가 내용 폭을 하한으로 잡는다). 세로 배치에서는 `w-full` 도
           필요하다 — 안 그러면 글자가 자기 폭만 차지해 왼쪽에 몰린다.
      */}
      <span
        className={cn(
          "flex min-w-0 flex-col gap-px",
          // 세로로 쌓을 때는 폭을 다 써야 글자가 왼쪽에 몰리지 않는다.
          stacked ? "w-full" : "w-full md:w-auto",
        )}
      >
        <span
          aria-hidden
          className="truncate text-overline leading-tight font-bold text-ink md:text-caption"
        >
          {bossNames.join(" ")}
        </span>
        {/*
          파티·캐릭터 줄은 **폰에서 감춘다.** 한 칸 42px 에서는 `익검…` 으로 잘려
          아무것도 말하지 못하는데, 블록을 누르면 모달이 전부 싣고 있다.
          이름 줄까지 지우면 빈 칸이 되므로 그건 남긴다(2026-08-20 사고).
        */}
        <span
          aria-hidden
          className="hidden truncate text-overline leading-tight text-ink-muted md:block"
        >
          {block.partyName} · {characterText}
        </span>
      </span>
    </button>
  );
}
