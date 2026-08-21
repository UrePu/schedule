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
const HOUR_PX_PHONE = 160;
const HOUR_PX = 126;

/**
 * 시간 축을 CSS 변수로 내보낸다.
 *
 * ⚠️ **문자열을 조합해서 만들지 않는다.** Tailwind 는 소스를 정적 스캔해 클래스를
 *    수집하므로 `` `[--hour:${HOUR_PX_PHONE}px]` `` 같은 런타임 조합은 빌드 결과에서
 *    통째로 사라진다(같은 경고가 `components/domain/boss-difficulty.ts` 에도 있다).
 *    그래서 완성된 리터럴을 적고, 위 두 상수와 **손으로 맞춘다** — 한쪽만 고치면
 *    축(CSS)과 계산(JS)이 갈리므로 셋을 함께 고칠 것.
 */
const HOUR_VAR = "[--hour:160px] md:[--hour:126px]";

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

/** 블록 안쪽 여백 + 위아래 테두리. 내용이 실제로 쓸 수 있는 높이의 차감분. */
const BLOCK_PADDING_PX = 10;

/** 두 줄(보스명 12px bold + 파티·캐릭터 11px, 둘 다 leading-tight)이 차지하는 높이. */
const TEXT_ROWS_PX = 30;

/** 세로로 쌓을 때 얼굴이 이보다 작아질 바에는 가로로 눕힌다. */
const MIN_STACKED_FACE_PX = 22;

/**
 * **가로 배치**(짧은 블록) 얼굴 상한. 얼굴이 글자와 폭을 나눠 갖는 배치라 이보다 키우면
 * 글자가 설 자리를 잃는다 — 아래 ⚠️ 참고.
 *
 * 30 → 34 (2026-08-21). 세로 배치 얼굴과의 **차이를 좁히기 위해** 함께 올렸다.
 * 34px 은 20분 블록(42px)에서 여백을 뺀 높이와 거의 같아, 사실상 그 블록이 낼 수 있는
 * 최대치다. 34px + 여백을 빼면 글자에 100px 남짓이 남아 `익세` 는 잘리지 않는다.
 */
const MAX_FACE_PX = 34;

/** 얼굴이 이보다 작으면 보스를 알아볼 수 없다. */
const MIN_FACE_PX = 16;

/**
 * 세로 배치에서 얼굴 **한 변의 상한**.
 *
 * `MAX_FACE_PX` 와 따로 두는 이유: 그 값은 얼굴이 **글자와 폭을 나눠 가지는** 가로 배치의
 * 상한이고, 세로 배치에서는 얼굴이 폭을 통째로 쓰므로 다른 값이 맞다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 이 값은 `MAX_FACE_PX` 와 **함께** 움직여야 한다 (2026-08-21)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한때 56 이었는데, 짧은 블록의 30px 과 나란히 놓이니 **1.87배 차이**가 나 두 블록이 서로
 * 다른 체계처럼 보였다 — 발주 지적: *"2개 차이가 너무 큰데"*.
 *
 * 원인은 얼굴 크기가 **블록 높이를 따라간다**는 점이다. 그런데 소요 시간은 블록 높이가
 * 이미 말하고 있으므로, 얼굴 크기가 그것을 한 번 더 말할 이유가 없다 — 지금은 그저
 * "공간을 채운다"는 부수 효과일 뿐이고, 그 부수 효과가 통일감을 깨면 손해다.
 *
 * 그래서 큰 쪽을 44 로 낮추고 작은 쪽을 34 로 올려 **1.38배**까지 좁혔다(발주 선택 C).
 * 한쪽만 깎지 않은 이유는 그러면 전체적으로 얼굴이 작아져 저해상도 아이콘이 더 불리해지기
 * 때문이다. 이 둘을 다시 만질 때는 **반드시 같이** 볼 것.
 */
const MAX_GRID_FACE_PX = 44;

interface BlockLayout {
  /** `true` = 얼굴 줄이 위, 글자가 아래(세로). `false` = 얼굴이 왼쪽, 글자가 오른쪽(가로). */
  readonly stacked: boolean;
  /**
   * 얼굴 하나의 크기.
   *
   * ⚠️ **얼굴 개수로 나누지 않는다.** 얼굴은 `md` 이상에서 가로로 서므로 여러 개가
   *    높이를 나눠 갖지 않는다. 개수로 나누면 4연속 묶음에서 얼굴이 8px 이 된다.
   */
  readonly facePx: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 카드 높이가 배치를 정한다 — 그리고 **얼굴은 폭을 독차지하지 않는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 20분짜리(42px)와 1시간짜리(126px)는 모양이 다른 상자다. 한 배치로는 한쪽이 망가진다:
 *   · 가로 배치를 큰 카드에 쓰면 남는 높이를 버린다.
 *   · 세로 배치를 작은 카드에 쓰면 얼굴 줄 + 글자 두 줄이 42px 에 안 들어간다.
 * 그래서 높이를 재서 고른다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 2026-08-21 — 두 번 망가뜨린 자리다. 상한을 함부로 올리지 말 것
 * ─────────────────────────────────────────────────────────────────────────────
 * ① 처음엔 얼굴을 가로 한 줄에 늘어놓고 셋을 넘으면 `+1` 로 접었다. 4연속 묶음(168px)에서
 *    내용이 위에만 몰려 **아래가 통째로 비었고**, 발주자가 *"묶이면 넘 못생김"* 이라 했다.
 * ② 그래서 얼굴을 **세로 기둥**으로 세우고 40px 까지 키웠더니 더 나빠졌다 — 얼굴이 폭을
 *    독차지해 글자가 `하림 하흉 하발 ...` 로 잘렸다(*"장난하냐"*).
 *
 * ①의 진짜 원인은 얼굴 배치가 아니라 **내용이 위에 붙어 있던 것**이었다. 그래서 지금은
 * 배치를 그대로 두고 `justify-center` 로 가운데 정렬만 한다. 빈 공간은 위아래로 갈리고,
 * 글자는 폭을 그대로 쓴다.
 *
 * 상한이 30px 인 이유: 좁은 칸(약 120~150px)에서 40px 짜리 얼굴 기둥은 폭의 3분의 1을
 * 먹는다. 그 폭은 `하림 하흉 하발 하벨` 이 잘리지 않으려면 글자 쪽에 있어야 한다.
 */
function blockLayout(blockPx: number): BlockLayout {
  const content = blockPx - BLOCK_PADDING_PX;
  const stackedFace = content - TEXT_ROWS_PX;
  const stacked = stackedFace >= MIN_STACKED_FACE_PX;

  const available = stacked ? stackedFace : content;
  return {
    stacked,
    facePx: Math.max(MIN_FACE_PX, Math.min(available, MAX_FACE_PX)),
  };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 세로 배치의 얼굴 격자 — **칸이 높으면 2열로 벌려 크게**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-21): *"칸이 넓으니 2줄 배치해봐 사진만 사이즈도 그거에 맞춰서 만들고"*.
 *
 * 한 줄로 늘어놓으면 얼굴 크기가 **폭 ÷ 개수**로 정해져, 4연속 묶음에서 30px 밖에 못 쓴다.
 * 그런데 남는 것은 폭이 아니라 **높이**다(80분 묶음이 168px). 2열로 접으면 한 줄에 둘씩만
 * 서므로 얼굴이 폭의 절반을 쓰고, 대신 줄이 늘어 **높이를 소비한다** — 남는 자원을 쓰는
 * 방향이 정확히 뒤바뀐다.
 *
 * 크기는 **폭과 높이 중 작은 쪽**이다. 폭 제약은 CSS 가 알아서 건다(`w-full` 이 격자 열
 * 너비를 따른다). 높이 제약만 여기서 계산해 `max-w` 로 얹으면 `aspect-square` 가 높이를
 * 따라 줄여 정사각형이 유지된다 — 폰 얼굴과 같은 수법이다.
 *
 * 실측(적용 전 산술, 전부 블록 안에 들어감):
 *   보통 폭(150px) 80분/4런 → 2열2행 **56px** (한 줄이었으면 30px)
 *   md 최소(93px)  80분/4런 → 2열2행 39.5px  (폭이 먼저 걸린다)
 *   60분 단일 런              → 1열1행 56px
 */
function gridFaceCap(blockPx: number, runCount: number): number {
  const cols = runCount >= 2 ? 2 : 1;
  const rows = Math.ceil(runCount / cols);
  const perRow = (blockPx - BLOCK_PADDING_PX - TEXT_ROWS_PX) / rows - 2;
  return Math.max(MIN_FACE_PX, Math.min(perRow, MAX_GRID_FACE_PX));
}

/**
 * 폰 얼굴의 **높이 상한**. 폰은 얼굴이 칸 폭을 가득 쓰는데(글자가 없다) 폭은 화면이
 * 넓어질수록 커지고 블록 높이는 시각이 정하므로 그대로다. 상한이 없으면 `md` 직전에서
 * 얼굴이 블록을 뚫는다(2026-08-20: *"딱 전환되는 순간엔 이미지가 너무 커서 위쪽만 나옴"*).
 */
function phoneFaceMax(blockPx: number, runCount: number): number {
  const per = (blockPx - 6) / Math.max(runCount, 1);
  return Math.max(MIN_FACE_PX, Math.floor(per) - 1);
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
            {/*
              ⚠️ **`:00` 은 `md` 이상에서만 붙인다** (2026-08-21 사고 수정).
                 폰 눈금 칸은 2.25rem(36px)이고 `right-1.5`(6px)를 빼면 30px 이 남는데,
                 `21:00` 은 11px 글자로 약 30px 이라 **경계에 걸린다.** 몇 px 만 넘쳐도
                 왼쪽으로 삐져나가는데, 그쪽은 스크롤로도 닿을 수 없는 영역이라 그대로
                 **잘린다** — 화면에는 `1:00` 만 남는다.
                 발주 지적: *"작게 했을때 시간대가 안맞음. 9시 익세인데 1시로 보임"*.
                 시각 계산은 처음부터 옳았고, **라벨만 앞 글자를 잃고 있었다.**

              ★ 그래서 폰에서는 `21` 만 적는다. 눈금 칸에서 `:00` 은 어차피 모든 줄에
                똑같이 붙는 상수라 정보가 0인데 폭만 먹는다(에타 시간표도 시(hour)만 적는다).
            */}
            {hourTicks.map((minute) => (
              <span
                key={minute}
                className="absolute right-1.5 -translate-y-1/2 text-overline tabular-nums whitespace-nowrap text-ink-muted"
                style={{ top: `${String(toAxisPercent(minute, axis))}%` }}
              >
                {formatHourTick(minute)}
                <span className="hidden md:inline">:00</span>
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
 * 필요한 만큼만 차지한다. 그래서 얼굴 크기를 계산할 일도 없고(`facePerRun` 이 필요 없다),
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

      {/*
        얼굴은 **전부** 그리고 넘치면 다음 줄로 흘린다(`flex-wrap`). 띠 블록은 높이가
        내용에 맞춰 자라므로 접을 이유가 없다 — `+N` 은 어느 보스인지 말하지 못하면서
        자리만 먹었다(2026-08-21: *"묶이면 넘 못생김"*, 격자 블록과 같은 날 함께 걷어냈다).
      */}
      <span aria-hidden className="flex flex-wrap items-center gap-0.5">
        {block.runs.map((run) => (
          <span key={run.runId} className="block size-5 shrink-0">
            <BossIcon
              bossDifficultyId={run.bossDifficultyId}
              difficulty={run.difficulty}
              size="sm"
              className="size-full rounded-sm"
            />
          </span>
        ))}
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

/**
 * 눈금의 **시(hour) 부분**. 24:00 을 넘으면 `25`, `26` 이 그대로 나온다 — 자정 넘김을
 * 되돌리지 않는다(사람들이 실제로 그렇게 말하고, 24 로 접으면 어느 날인지 흐려진다).
 *
 * ⚠️ `:00` 을 붙이지 않는다. 붙이는 쪽은 **화면이 폭을 보고 결정한다** — 좁은 눈금 칸에서
 *    `21:00` 이 잘려 `1:00` 으로 읽히던 사고 때문이다(아래 렌더 주석).
 */
function formatHourTick(minute: number): string {
  return String(Math.floor(minute / 60)).padStart(2, "0");
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
 * 배치는 **하나뿐이다** — 얼굴은 세로 띠, 글자는 그 옆
 * ─────────────────────────────────────────────────────────────────────────────
 * 얼굴이 런마다 하나씩 세로로 서고(`facePerRun` 머리말), 데스크톱에서는 그 오른쪽에
 * 글자 두 줄이 붙는다. 폰에서는 글자를 접어 얼굴 띠만 남는다.
 *
 * ⚠️ 예전에는 높이를 재서 가로/세로를 갈랐다(`blockLayout`). 그 분기를 **없앴다** —
 *    얼굴이 세로로 서면 짧은 블록이든 긴 블록이든 같은 모양이 되고, 높이가 남아 도는
 *    문제(*"묶이면 넘 못생김"*)와 접힌 `+N` 이 함께 사라진다. 분기가 없으니 폰과
 *    데스크톱이 갈라질 자리도 없다.
 *
 * ⚠️ 2026-08-20 사고 기록: 한때 "높이가 모자라면 글자를 뺀다"로 만들었다가 20분짜리
 *    런이 33px 이 되면서 **얼굴 하나만 있고 아무 글자도 없는 블록**이 나갔다
 *    (*"뭐 아무것도 안써있는데?"*). 지금은 데스크톱에서 글자를 조건부로 빼지 않는다.
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
  /** 격자 본문의 데스크톱 기준 픽셀 높이. 배치와 얼굴 크기를 정하는 데 쓴다. */
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

  const difficulty = block.runs[0]?.difficulty ?? "normal";
  const runCount = Math.max(block.runs.length, 1);

  // `minHeight` 하한이 실제 높이를 밀어 올릴 수 있으므로 배치도 그 값을 봐야 한다.
  const blockPx = Math.max((heightPct / 100) * bodyHeight, BLOCK_MIN_PX);
  const { stacked, facePx } = blockLayout(blockPx);

  // 폰은 얼굴만 그리므로 기준 축이 다르다(`phoneFaceMax` 주석).
  const phoneBlockPx = Math.max(
    (heightPct / 100) * ((bodyHeight / HOUR_PX) * HOUR_PX_PHONE),
    BLOCK_MIN_PX,
  );
  const phoneMax = phoneFaceMax(phoneBlockPx, runCount);
  // 세로 배치일 때만 쓰인다 — 가로 배치는 얼굴이 글자와 폭을 나눠 가지므로 `facePx` 다.
  const gridCap = gridFaceCap(blockPx, runCount);

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
          ★ **폰은 언제나 세로 기둥**이다. 글자가 없으므로 얼굴이 칸 폭을 그대로 쓰고,
            세로 위치가 곧 그 보스의 시간대가 된다(발주자: *"20분당 이미지 하나"*).
          ★ `md` 이상에서만 높이로 배치를 고른다. 그리고 **`justify-center`** —
            빈 공간을 아래에 몰아 두지 않고 위아래로 나눈다. 원래 불만이 그것이었다.
        */
        "flex-col justify-evenly gap-px",
        stacked
          ? "md:flex-col md:justify-center md:gap-0.5"
          : "md:flex-row md:items-center md:justify-start md:gap-1.5",
        "transition duration-200 hover:bg-hover-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        BOSS_DIFFICULTY_BORDER_L[difficulty as BossDifficulty],
      )}
      style={{
        top: `${String(top)}%`,
        height: `${String(heightPct)}%`,
        minHeight: `${String(BLOCK_MIN_PX)}px`,
        width: `calc(${String(100 / block.laneCount)}% - 0.25rem)`,
        left: `calc(${String((100 / block.laneCount) * block.lane)}% + 0.125rem)`,
      }}
    >
      <span className="sr-only">{full} — 상세 보기</span>

      {/*
        얼굴. 폰에서는 세로 기둥(칸 폭 가득), `md` 이상에서는 **가로 줄**이다.
        전부 그린다 — `+N` 은 어느 보스인지 말하지 못하면서 자리만 먹었다.
        넘치면 다음 줄로 흘린다(`md:flex-wrap`).
      */}
      <span
        aria-hidden
        className={cn(
          // 폰: 세로 기둥, 얼굴이 칸 폭을 가득 쓴다.
          "flex w-full shrink-0 flex-col items-center justify-evenly gap-px",
          stacked
            ? /*
                세로 배치: **2열 격자**. 한 줄로 늘어놓으면 얼굴이 `폭 ÷ 개수` 로 작아지는데,
                여기서 남는 자원은 폭이 아니라 높이다(`gridFaceCap` 머리말).
                `justify-items-center` — 홀수 개일 때 마지막 하나가 왼쪽에 치우치지 않는다.
              */
              cn(
                "md:grid md:w-full md:justify-items-center md:gap-0.5",
                runCount >= 2 ? "md:grid-cols-2" : "md:grid-cols-1",
              )
            : // 가로 배치(짧은 블록): 얼굴이 왼쪽에 한 줄로 선다.
              "md:w-auto md:flex-row md:flex-wrap md:justify-start md:gap-0.5",
        )}
      >
        {block.runs.map((run) => (
          <span
            key={run.runId}
            className={cn(
              "block aspect-square w-full max-w-[var(--face-max)] shrink-0",
              stacked
                ? // 폭은 격자 열이 정하고, 높이 상한만 얹는다 → 둘 중 작은 쪽이 이긴다.
                  "md:max-w-[var(--face-cap)]"
                : "md:w-[var(--face)] md:max-w-none",
            )}
            style={
              {
                "--face": `${String(Math.round(facePx))}px`,
                "--face-max": `${String(Math.round(phoneMax))}px`,
                "--face-cap": `${String(Math.round(gridCap))}px`,
              } as React.CSSProperties
            }
          >
            <BossIcon
              bossDifficultyId={run.bossDifficultyId}
              difficulty={run.difficulty}
              size="sm"
              className="size-full rounded-sm"
            />
          </span>
        ))}
      </span>

      {/*
        글자는 **`md` 이상에서만**. 폰 한 칸은 42px 이라 잘려서 아무것도 말하지 못하는데,
        그 자리에는 칸을 채운 얼굴이 런마다 하나씩 남는다. 정보는 `title`·`sr-only`·모달이
        전부 싣는다.

        ⚠️ `min-w-0` 이 없으면 `truncate` 가 동작하지 않는다(플렉스 항목의 기본
           `min-width:auto` 가 내용 폭을 하한으로 잡는다).
      */}
      <span
        className={cn(
          "hidden min-w-0 flex-col gap-px md:flex",
          // 세로 배치면 폭을 다 쓰고, 가로 배치면 얼굴 옆의 남은 폭을 전부 가져간다.
          stacked ? "md:w-full" : "md:min-w-0 md:flex-1",
        )}
      >
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
