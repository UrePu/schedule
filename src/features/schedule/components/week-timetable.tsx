"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { BossIcon } from "@/components/domain";
import {
  BOSS_DIFFICULTY_BORDER_L,
  type BossDifficulty,
} from "@/components/domain/boss-difficulty";
import { ErrorState, Skeleton } from "@/components/ui";
import { useSessionUser } from "@/features/auth/data/auth-queries";
import { fetchMyTimetable } from "@/features/schedule/data";
import {
  buildDayRows,
  snapAxisMinute,
  toAxisPercent,
  type DayRow,
  type OverlayAxis,
} from "@/features/schedule/lib/overlay-layout";
import {
  buildTimetableLayout,
  type TimetableBlock,
} from "@/features/schedule/lib/timetable-layout";
import { usePostRunSync } from "@/features/schedule/lib/use-post-run-sync";

import { RunDetailDialog } from "./run-detail-dialog";
import { TimetableRefreshButton } from "./timetable-refresh-button";
import { TimetableRunDialog } from "./timetable-run-dialog";
import { DAY_MINUTES, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
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
 * 없어진 `일정 계획` 화면의 겹쳐보기는 **가로축이 시간**이었다. 거기서는 "여러 사람"이
 * 세로로 쌓여야 겹침이 보였기 때문이다. 이 화면에 쌓을 사람은 나 하나뿐이고, 대신
 * **7일을 나란히** 놓아야 "이번 주 어디가 비었나"가 보인다. 그래서 축이 돌아간다.
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-09-28 — 이 화면이 **일정을 잡는 곳이기도 하다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"일정표를 항상 띄우고 일정 계획칸을 삭제. 일정표에서 특정 구간을 눌러
 * 파티를 고르는것으로 변경."*
 *
 * 그래서 격자는 더 이상 **출력만 하는 표가 아니라 입력면**이다. 빈 칸을 누르면 그 칸의
 * 시각이 곧 시작 시각이 되고(`SLOT_MINUTES` 로 스냅), 파티만 고르면 그 파티에 등록된
 * 보스로 일정이 잡힌다(`timetable-run-dialog.tsx`).
 *
 * ⚠️ 그래서 **일정이 하나도 없어도 격자를 그린다.** 예전에는 빈 주에 안내 카드를
 *    대신 그렸는데, 그 순간 누를 칸이 화면에서 사라져 **일정을 새로 잡을 입구가 없어진다** —
 *    가장 필요한 때에 입구가 없는 셈이다. 안내는 격자 위 한 줄로 내렸다.
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
/**
 * 축 끝 = **24:30** (발주 지시 2026-08-21: *"맨밑에 25 이거 짤리는데 그냥 24:30까지만
 * 보여주자"*).
 *
 * 25:00 이 끝이면 그 라벨이 격자 **맨 아래 선 위에 가운데 정렬**돼 절반이 컨테이너 밖으로
 * 나가고, `overflow-y-hidden` 이 그것을 자른다. 24:30 으로 당기면 마지막 **정시** 라벨이
 * 24:00 이 되어 92.3% 지점에 온다 — 잘릴 일이 없다.
 *
 * ⚠️ 잘림 자체는 아래 `tickShift()` 가 따로 막는다. 늦은 런이 축을 밀어 25:00 이 다시
 *    등장할 수 있기 때문이다(축 끝은 `max(AXIS_END_MINUTE, 본문 런의 끝)`).
 *    즉 이 상수는 **기본 화면을 24:30 에서 끊는다**는 뜻이지, 잘림 방지책이 아니다.
 */
const AXIS_END_MINUTE = 24 * 60 + 30;

/**
 * 빈 칸을 눌렀을 때 시작 시각을 **끊어 맞추는 단위**. 보조선(`subTicks`)의 간격이기도 하다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-10-04 — 20 → **10분** (발주 요청: *"20분단위로만 클릭되는거 불편해.
 *   10분단위로"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1분 단위로 받지 않는 이유는 그대로다 — `21:07 시작` 같은 일정은 아무도 원하지 않고,
 * 블록이 격자와 어긋나 표가 거짓말처럼 보인다. 바뀐 것은 **얼마나 촘촘한가**뿐이다.
 *
 * ⚠️ **보스 한 판의 소요 시간(`DEFAULT_DURATION_MINUTES` = 20분)과 다른 값이다.**
 *    예전에는 둘이 우연히 같아서 한 상수처럼 보였지만 역할이 다르다 — 이쪽은 "어디에
 *    잡히나", 그쪽은 "얼마나 걸리나"다. **같이 고치지 말 것.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 보조선과의 어긋남을 어떻게 풀었나 — **선을 10분으로 통일했다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 선은 20분인데 잡히는 곳이 10분이면 "왜 선이 아닌 데 잡히지"가 된다. 셋 중에 골랐다:
 *   ① 보조선을 10분으로 통일              ← **이것을 골랐다**
 *   ② 20분 선은 두고 10분 지점만 더 옅게
 *   ③ 선은 그대로 두고 호버 라벨이 대신 말하게
 *
 * ①의 근거는 **원래 20분이었던 이유 그 자체**다. 그 선의 존재 이유가 "눈에 보이는 선과
 * 실제로 잡히는 시각이 같다"였으므로, 스냅이 10분으로 내려가면 선도 따라 내려가는 것이
 * 같은 규칙을 지키는 유일한 길이다. 20분 리듬은 사라지지 않는다 — 20은 10의 배수라
 * 블록 경계는 여전히 선 위에 정확히 떨어지고, 시간 구조는 정시선(`/60`)이 잡는다.
 *
 * ②를 버린 이유는 §4 가 못 박아 둔 것이다: *"같은 알파 단계가 근검정에서 뭉개진다."*
 * 다크의 `--dk-border` 는 `#2e2e36` 으로 이미 약해서, `/60 · /25` 위에 세 번째 단계를
 * 더하면 라이트에서만 세 층으로 보이고 다크에서는 두 층으로 합쳐진다 — 즉 **다크에서는
 * 10분 지점이 그냥 안 보인다.** 테마마다 다른 격자를 그리는 셈이라 못 쓴다.
 * ③은 호버가 없는 터치에서 아무 단서도 남지 않아 단독으로는 부족하다(호버 라벨과 스냅
 * 선은 ①과 **함께** 들어간다 — 선이 "어디에 잡히나"를, 라벨이 "몇 시인가"를 말한다).
 *
 * 밀도 검산: 10분 = 데스크톱 21px(`HOUR_PX` 126) · 폰 26.7px(`HOUR_PX_PHONE` 160).
 * 선 사이가 20px 아래로 내려가면 다시 볼 것.
 */
const SLOT_MINUTES = 10;

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

  /**
   * 등록 창이 열려 있는 **시작 시각**. `null` 이면 닫혀 있다.
   *
   * 시각 자체를 상태로 들고 있는 것이 핵심이다 — "어느 칸을 눌렀나"가 아니라 "몇 시부터
   * 잡을 것인가"가 창이 필요로 하는 전부이고, 칸을 들고 있으면 재조회로 배열이 갈릴 때
   * 참조가 낡는다(`openKey` 가 키만 들고 있는 것과 같은 이유).
   */
  const [composeAt, setComposeAt] = useState<Date | null>(null);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 호버 읽기값 — **상태가 아니라 DOM 에 직접 쓴다** (2026-10-04)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 발주 요청: *"일정쪽 표에 마우스 호버 하면 시간좀 뜨게 해줘"*.
   *
   * `useState` 로 커서를 따라가면 `pointermove` 마다(초당 60회) 이 컴포넌트가 다시
   * 그려진다. 격자에는 열마다 보조선 39개 + 시각선 7개가 있어 한 번에 **300개가 넘는
   * 절대 위치 노드**를 재조정하게 되고, 정작 바뀌는 것은 떠 있는 라벨 하나뿐이다.
   *
   * 그래서 리렌더를 **한 번도 일으키지 않는다**:
   *   · 라벨과 스냅 선은 항상 마운트해 두고 `opacity` 로만 켠다(레이아웃이 안 움직인다).
   *   · 자리는 핸들러가 `style.transform` 에 직접 쓴다.
   *   · 글자와 선 위치는 **스냅 값이 실제로 바뀔 때만** 다시 쓴다(`readoutRef` 비교) —
   *     10분 띠를 넘지 않는 움직임은 `transform` 한 줄로 끝난다.
   * ⚠️ 그래서 이 노드들에 React 가 소유하는 `style` prop 을 **주지 않는다.** 주면
   *    다음 렌더에서 React 가 우리가 쓴 값을 되돌린다.
   */
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const hoverTimeRef = useRef<HTMLSpanElement>(null);
  const hoverDayRef = useRef<HTMLSpanElement>(null);
  const hoverLineRef = useRef<HTMLDivElement>(null);
  /** 마지막으로 글자에 쓴 `요일|분`. 같으면 글자·선·측정을 전부 건너뛴다. */
  const readoutRef = useRef<string>("");
  /** 위 비교에서 건너뛸 때 쓰는 라벨 크기 캐시. 글자가 바뀔 때만 다시 잰다. */
  const labelSizeRef = useRef<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  /*
    ★ 쓰기 가능 여부는 **세션이 정한다.** 비로그인에게 빈 칸을 눌리게 해 두면 창을 열고
      나서야 401 을 만나게 된다 — 닿을 수 없는 곳을 띄워 두는 것은 나쁜 동선이다
      (`nav-routes.ts` 의 `requiresAuth` 와 같은 판단).
  */
  const viewer = useSessionUser();
  const viewerPersonId = viewer?.id ?? null;

  const timetableQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.runs.timetable(weekKey)),
    queryFn: () => fetchMyTimetable(weekKey),
  });

  const days = useMemo(() => buildDayRows(range), [range]);
  const runs = timetableQuery.data;

  /*
    끝난 런의 캐릭터를 **넥슨 지연 창(15분) 뒤에** 한 번 동기화한다
    (발주 지시 2026-08-21 · `usePostRunSync` 머리말). 훅이 스스로 대상·시점·중복을
    판정하므로 여기서는 데이터만 넘긴다.
  */
  usePostRunSync(runs);

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

  const { blocks } = layout;
  /*
    ⚠️ 비어 있어도 **격자를 그대로 그린다**(머리말 ★). 안내는 격자를 대신하지 않고
       그 위에 한 줄로 붙는다 — 누를 칸이 없어지면 일정을 잡을 입구가 사라진다.
  */
  const isEmptyWeek = blocks.length === 0;

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

  /*
    ── 보조선 (발주 제안 2026-08-21: *"20분마다 희미한 가로줄을 하나 더 두는건어떰?"*)
    ────────────────────────────────────────────────────────────────────────────
    ★ **간격은 `SLOT_MINUTES` 다 — 리터럴 20 이 여기 박혀 있었다**(2026-10-04 정리).
      이 선의 존재 이유가 "눈에 보이는 선 = 실제로 잡히는 시각"이므로 스냅 단위와
      **같은 상수를 읽어야** 한다. 두 숫자를 따로 적어 두면 한쪽만 고쳐지고, 실제로
      그렇게 될 뻔했다(스냅을 10분으로 내리던 날 선은 20분에 남아 있었다).
      ⚠️ 간격을 바꾸려면 `SLOT_MINUTES` 를 고칠 것. 여기서 다시 숫자를 적지 말 것.
    ★ 정시(60분 배수)는 **빼고** 만든다 — 이미 시각선이 그 자리에 있고, 겹쳐 그리면
      그 줄만 두 겹이 되어 진해진다.
  */
  const subTicks: number[] = [];
  for (
    let minute = Math.ceil(axis.startMinute / SLOT_MINUTES) * SLOT_MINUTES;
    minute <= axis.endMinute;
    minute += SLOT_MINUTES
  ) {
    if (minute % 60 !== 0) subTicks.push(minute);
  }

  const blocksByDay = groupByDay(main);
  const earlyByDay = groupByDay(early);
  const lateByDay = groupByDay(late);

  /*
    키로 매 렌더 다시 찾는다(위 `openKey` 주석). 재조회 뒤 사라진 일정이면 `undefined`
    가 되어 모달이 스스로 닫힌다 — 지워진 일정의 명단을 계속 띄우고 있지 않는다.
  */
  const openBlock = blocks.find((entry) => entry.key === openKey) ?? null;

  /*
    키보드로 눌렀을 때 잡히는 시각(축 한가운데). **버튼의 접근 이름에 그대로 싣는다** —
    호버 라벨은 마우스만 볼 수 있으므로, 그 값이 글자로도 있어야 "호버로만 알 수 있는
    정보"가 생기지 않는다(`slotMinuteFromClick` 의 `detail === 0` 분기와 같은 값이다).
  */
  const keyboardSlotMinute = snapAxisMinute(0.5, axis, SLOT_MINUTES);

  const hideHoverReadout = () => {
    readoutRef.current = "";
    if (hoverLabelRef.current !== null) {
      hoverLabelRef.current.style.opacity = "0";
    }
    if (hoverLineRef.current !== null) {
      hoverLineRef.current.style.opacity = "0";
    }
  };

  /**
   * 커서 → 그 자리의 **스냅된** 시각을 라벨과 선으로 띄운다.
   *
   * ⚠️ **스냅된 값을 보여 준다.** 커서의 날것 위치(`21:07`)를 띄우면 눌렀을 때
   *    `21:00` 이 들어가 라벨이 거짓말이 된다. 라벨·선·클릭이 모두 `snapAxisMinute`
   *    한 벌을 공유하는 이유가 그것이다.
   */
  const moveHoverReadout = (event: React.PointerEvent<HTMLDivElement>) => {
    /*
      ⚠️ **터치·펜에는 호버가 없다.** 탭 한 번으로도 `pointermove` 가 한 발 들어오는데,
         그걸 받으면 라벨이 떠서 손가락 아래 화면을 가리고 **잔상으로 남는다**(떠날
         이벤트가 없다). 그래서 입력 종류로 막는다 — 클릭 등록 자체는 아래 `onClick`
         이라 호버 장치가 없어도 그대로 동작한다.
    */
    if (event.pointerType !== "mouse") return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    /*
      `data-slot-day` 는 **빈 칸 버튼만** 갖는다. 블록은 버튼보다 뒤에 그려져 포인터를
      먼저 먹으므로 블록 위에서는 이 탐색이 `null` 이고, 라벨도 뜨지 않는다 —
      거기는 누르면 상세 창이지 등록이 아니다. 눈금 칸·여백도 같은 이유로 걸러진다.
    */
    const slot = target?.closest<HTMLElement>("[data-slot-day]") ?? null;
    const label = hoverLabelRef.current;
    const line = hoverLineRef.current;
    if (slot === null || label === null || line === null) {
      hideHoverReadout();
      return;
    }

    const rect = slot.getBoundingClientRect();
    if (rect.height <= 0) {
      hideHoverReadout();
      return;
    }

    const dayLabel = slot.dataset.slotDay ?? "";
    const minute = snapAxisMinute(
      (event.clientY - rect.top) / rect.height,
      axis,
      SLOT_MINUTES,
    );

    const readout = `${dayLabel}|${String(minute)}`;
    if (readout !== readoutRef.current) {
      readoutRef.current = readout;
      if (hoverTimeRef.current !== null) {
        hoverTimeRef.current.textContent = formatAxisClock(minute);
      }
      if (hoverDayRef.current !== null) {
        hoverDayRef.current.textContent = dayLabel;
      }
      /*
        스냅 선 — 눌렀을 때 **일정이 시작될 자리**를 그 칸 폭으로 그대로 긋는다.
        `position: fixed` 인 이유: 격자 컨테이너가 `overflow-x-auto overflow-y-hidden`
        이라 안쪽에 두면 위아래 끝에서 잘린다. 칸의 화면 좌표를 그대로 쓰면 잘릴 일이 없다.
        1px 을 빼서 2px 선의 가운데가 그 시각에 오게 한다.
      */
      line.style.left = `${String(Math.round(rect.left))}px`;
      line.style.width = `${String(Math.round(rect.width))}px`;
      line.style.top = `${String(
        Math.round(
          rect.top + (toAxisPercent(minute, axis) / 100) * rect.height - 1,
        ),
      )}px`;
      // 글자가 바뀌었으니 폭·높이를 다시 잰다(여기서만 강제 레이아웃이 일어난다).
      labelSizeRef.current = {
        width: label.offsetWidth,
        height: label.offsetHeight,
      };
    }

    /*
      ── 라벨 자리 ──────────────────────────────────────────────────────
      커서 **오른쪽 아래로 14px** 비켜 놓는다. 커서에 깔리면 띄운 값을 못 읽는다.
      화면 밖으로 넘칠 쪽에서는 **반대쪽으로 접는다** — 클램프만 하면 라벨이 커서를
      향해 되밀려 와 결국 커서 아래로 들어간다(맨 오른쪽 칸·맨 아래 줄이 정확히 그 경우다).
      접어도 모자라는 아주 좁은 창에서는 마지막으로 화면 안쪽으로 밀어 넣는다.
    */
    const { width, height } = labelSizeRef.current;
    const gap = 14;
    const edge = 8;
    const fitsRight = event.clientX + gap + width + edge <= window.innerWidth;
    const fitsBelow = event.clientY + gap + height + edge <= window.innerHeight;
    const x = fitsRight
      ? event.clientX + gap
      : event.clientX - gap - width;
    const y = fitsBelow
      ? event.clientY + gap
      : event.clientY - gap - height;
    label.style.transform = `translate3d(${String(
      Math.round(Math.min(Math.max(x, edge), window.innerWidth - width - edge)),
    )}px, ${String(
      Math.round(
        Math.min(Math.max(y, edge), window.innerHeight - height - edge),
      ),
    )}px, 0)`;
    label.style.opacity = "1";
  };

  return (
    <>
    {/*
      ── 이번 주에 일정이 하나도 없을 때 ───────────────────────────────────
      격자를 **대신하지 않고** 그 위에 한 줄로 붙는다(머리말 ★). 무엇이 없는지와
      무엇을 하면 되는지를 같이 말한다 — 안내가 "없다"만 말하면 사용자는 다음
      행동을 모른다.
    */}
    {isEmptyWeek ? (
      <p className="mb-2 rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink-muted">
        이번 주에 잡힌 내 일정이 없습니다. 파티에{" "}
        <strong className="font-semibold">참가</strong>로 등록된 일정만 여기에
        나옵니다.
        {viewerPersonId === null
          ? null
          : " 아래 격자의 빈 칸을 누르면 그 시각으로 일정을 잡을 수 있습니다."}
      </p>
    ) : null}

    {/*
      ── "방금 잡았는데 안 뜬다" 용 새로고침 (발주 지시 2026-08-24) ──────────
      자동 동기화(런 종료 + 10분)가 로그아웃 전에 걸려 빈손으로 돌아왔을 때 쓰는 문이다.
      부를 대상이 없으면(전부 클리어) 스스로 사라진다.
    */}
    <TimetableRefreshButton runs={runs ?? []} className="mb-2" />

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
        <div
          className={cn("grid", GRID_COLS)}
          /*
            ★ 호버 핸들러는 **격자에 하나만** 붙인다. 요일 칸마다 붙이면 같은 함수가
              7벌이 되고, 매 렌더 7개가 새로 만들어진다. 이벤트는 어차피 올라오므로
              어느 칸이었는지는 `event.target` 이 말해 준다(`moveHoverReadout`).
            ⚠️ 비로그인에게는 빈 칸 버튼 자체가 없어 띄울 것이 없다 — 핸들러도 달지 않는다.
          */
          onPointerMove={
            viewerPersonId === null ? undefined : moveHoverReadout
          }
          onPointerLeave={viewerPersonId === null ? undefined : hideHoverReadout}
        >
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
            {hourTicks.map((minute) => {
              const percent = toAxisPercent(minute, axis);
              return (
                <span
                  key={minute}
                  className={cn(
                    "absolute right-1.5 text-overline tabular-nums whitespace-nowrap text-ink-muted",
                    // 양 끝 눈금은 기준선을 바꿔 잘리지 않게 한다(`tickShift` 주석).
                    tickShift(percent),
                  )}
                  style={{ top: `${String(percent)}%` }}
                >
                  {formatHourTick(minute)}
                  <span className="hidden md:inline">:00</span>
                </span>
              );
            })}
          </div>

          {days.map((day) => (
            <div
              key={day.dayKey}
              className={cn(
                "relative border-l border-border",
                /*
                  ── 오늘 열 (발주 요청 2026-10-04: *"오늘이 하이라이트좀 됐으면"*) ──
                  옛 표현은 `bg-primary-subtle/40` **배경 하나**였다. 흰 면 대비
                  **1.05:1** — 20분 보조선까지 깔린 격자에서는 사실상 안 보인다.
                  요청은 "없다"가 아니라 "안 보인다"였다.

                  → 세기를 **농도가 아니라 윤곽**으로 올린다. 좌우 **2px primary 레일**은
                    흰 면 6.29:1 / 다크 면 5.70:1 로 1px `border` 선과 혼동될 수가 없다.
                    농도만 올리는 길은 다크에서 막혀 있다 — §4 가 적어 둔 대로 같은 알파
                    단계가 근검정에서 뭉개지므로, 양쪽에서 똑같이 사는 채널은 굵기와 색이다.
                    배경은 덤으로 꽉 채운다(`/40` → 전체, 1.12 / 1.13:1).

                  ★ 레일이 **머리 행·접힌 띠와 같은 격자 열**에 서므로(`GRID_COLS` 공유)
                    세 토막이 끊긴 조각이 아니라 하나의 **세로 통로**로 읽힌다.
                  ★ 글자 대비는 흔들리지 않는다 — 블록(`RunBlock`)은 `bg-surface` /
                    `bg-background` 로 **불투명**해서 열 배경 위에 글자가 직접 앉는 자리가
                    아예 없다. 열 틴트를 올려도 AA 를 다시 계산할 짝이 생기지 않는다.
                  ★ 주말 배경과의 승부는 그대로다 — 토·일이 오늘이면 **오늘이 이긴다**
                    (아래 줄의 `day.dayKey !== todayKey`). 세기를 올렸으니 더욱 그래야 한다.
                */
                day.dayKey === todayKey
                  ? "border-x-2 border-primary bg-primary-subtle"
                  : null,
                day.isWeekend && day.dayKey !== todayKey ? "bg-hover-surface/50" : null,
              )}
              style={{ height: bodyHeight }}
            >
              {/*
                ── 빈 칸 = **일정을 잡는 입구** (발주 지시 2026-09-28) ──────
                칸 전체를 덮는 버튼을 **블록보다 먼저** 그린다. 나중에 오는 형제가
                위에 쌓이므로 블록을 누르면 블록이 먹고(상세 모달), 빈 곳을 누르면
                이것이 먹는다(등록 창). z-index 를 손으로 매길 필요가 없다.

                ⚠️ 비로그인에게는 **아예 그리지 않는다.** 쓰기는 전부 401 이라 창을
                   열어 봐야 오류만 보게 된다(공개 시간표는 200 이어야 한다).

                ★ **보조선·시각선보다 앞으로 옮겼다** (2026-10-04). hover 배경
                  (`primary-subtle-hover` = `#d8dfff`)은 **불투명**이라, 버튼이 선들
                  뒤에 있던 동안에는 마우스를 올린 바로 그 칸의 격자선이 통째로 덮여
                  사라졌다 — 시각을 고르는 중인 칸에서만 위치 단서가 없어지는 셈이다.
                  순서를 뒤집으면 선이 틴트 위에 남는다. 선 쪽에는
                  `pointer-events-none` 이 필요하다(아래 ⚠️).
              */}
              {viewerPersonId === null ? null : (
                <button
                  type="button"
                  /*
                    호버 핸들러가 "지금 빈 칸 위인가"와 "어느 요일인가"를 이 속성으로
                    읽는다(`moveHoverReadout`). 격자에 핸들러를 하나만 두기 위한 표식이라
                    요일 칸마다 콜백을 새로 만들지 않아도 된다.
                  */
                  data-slot-day={day.label}
                  className={cn(
                    "absolute inset-0 w-full cursor-copy",
                    /*
                      ⚠️ hover 면은 `primary-subtle-hover` 다 — `primary-subtle/50` 이
                         아니다. 오늘 열의 바탕이 이제 `primary-subtle` **전체**라서,
                         같은 색의 반투명을 그 위에 얹으면 **hover 가 사라진다**(눌릴 수
                         있는지 알 수 없게 된다). 이 토큰은 globals.css 가 "이미
                         primary-subtle 로 칠해진 면의 hover" 용으로 만든 것이라 정확히
                         이 상황을 위한 값이다. 흰 열에서도 옛 1.06:1 → 1.32:1 로 또렷해진다
                         (다크 1.26:1 · 오늘 열 위 라이트 1.18 / 다크 1.12).
                    */
                    "transition duration-200 hover:bg-primary-subtle-hover",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                  )}
                  /*
                    ★ **접근 이름에 시각이 들어간다** (2026-10-04). 마우스 사용자는
                      호버 라벨로 자리의 시각을 보지만, 키보드로 이 버튼에 닿은 사람은
                      호버가 없다. 키보드 활성화는 좌표가 없어 축 한가운데로 떨어지므로
                      (`slotMinuteFromClick` 의 `detail === 0`), **그 값을 말해 준다** —
                      그러면 호버로만 알 수 있는 정보가 하나도 남지 않는다.
                      시각은 잡은 뒤 상세 창의 `시각 옮기기` 로 고칠 수 있다.
                  */
                  aria-label={`${day.label} 빈 칸 — 보스 일정 잡기. 마우스로는 누른 자리의 시각(${String(SLOT_MINUTES)}분 단위)으로, 키보드로는 ${formatAxisClock(keyboardSlotMinute)} 부터 잡힙니다.`}
                  onClick={(event) => {
                    /*
                      등록 창이 열리는 순간 라벨을 거둔다 — 창 위로 떠 있을 자리가 아니고,
                      창을 닫을 때까지 포인터가 격자를 떠나지 않으면 잔상으로 남는다.
                    */
                    hideHoverReadout();
                    setComposeAt(
                      kstMoment(
                        day.dayKey,
                        slotMinuteFromClick(event, axis),
                      ),
                    );
                  }}
                />
              )}

              {/*
                보조선. 간격은 `SLOT_MINUTES`(10분) — **눈에 보이는 선이 곧 잡히는
                시각**이다(상수 주석). **시각선보다 먼저** 그린다 — 뒤에 오는 형제가
                위에 쌓이므로, 같은 자리에서 겹칠 일이 없더라도 진한 선이 나중에 와야
                안전하다. `border-border/25` 는 시각선(`/60`)의 절반보다 옅어 "칸을
                나누지만 읽는 선은 아니다"로 읽힌다. 라벨은 붙이지 않는다 — 정시 라벨로
                위치가 특정되고, 10분마다 숫자를 찍으면 눈금 칸이 글자로 가득 찬다.

                ⚠️ `pointer-events-none` 이 **필수**다. 이제 빈 칸 버튼 위에 깔리므로,
                   이것이 포인터를 먹으면 선을 지날 때마다 `event.target` 이 버튼을
                   벗어나 라벨이 깜빡인다(10분마다 한 번씩 꺼졌다 켜진다).
              */}
              {subTicks.map((minute) => (
                <div
                  key={`sub-${String(minute)}`}
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 border-t border-border/25"
                  style={{ top: `${String(toAxisPercent(minute, axis))}%` }}
                />
              ))}

              {/* 시각선. 24:00 은 **날짜가 바뀌는 선**이라 굵게 긋는다. */}
              {hourTicks.map((minute) => (
                <div
                  key={minute}
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-x-0 border-t",
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

    {/*
      ── 호버 읽기값: **스냅 선 + 떠다니는 라벨** (발주 요청 2026-10-04) ───────
      *"마우스 호버 하면 시간좀 뜨게 해줘 … 10분단위로 호버시 시간 나오도록"*

      두 조각이 역할을 나눈다:
        · **선** — 누르면 **어디에** 잡히는지. 그 칸 폭으로 그어 요일까지 같이 말한다.
        · **라벨** — 그 자리가 **몇 시**인지. 커서를 따라다녀 눈을 옮기지 않아도 읽힌다.

      ★ 글자는 `text-body-sm`(14px). 읽으라고 띄우는 값이라 §4 의 12px 하한에 걸어 두지
        않는다 — 옆의 날짜·요일만 `text-caption`(12px) 보조 표기다.
      ★ 면은 앱의 떠다니는 라벨 규격(`ui/tooltip.tsx`)과 같은 `bg-ink` + `text-neutral-50`
        이다. 이미 양쪽 테마에서 검증된 짝이고(다크에서 둘이 함께 뒤집힌다), 격자 위
        어떤 배경에 겹쳐도 대비가 흔들리지 않는 유일한 선택이다.
      ★ 둘 다 `position: fixed` — 격자 컨테이너가 `overflow-x-auto overflow-y-hidden`
        이라 안쪽에 두면 맨 위·맨 아래 칸에서 잘린다.
      ★ `aria-hidden` — 보조기기에는 빈 칸 버튼의 접근 이름이 같은 값을 말한다(위 ★).
      ⚠️ `style` prop 을 주지 않는다. 자리와 `opacity` 는 핸들러가 DOM 에 직접 쓰고,
         React 가 `style` 을 소유하면 다음 렌더에서 되돌린다.
    */}
    {viewerPersonId === null ? null : (
      <>
        <div
          ref={hoverLineRef}
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-40 h-0.5 w-0 bg-primary opacity-0"
        />
        <div
          ref={hoverLabelRef}
          aria-hidden
          className={cn(
            "pointer-events-none fixed left-0 top-0 z-40 flex items-baseline gap-1.5",
            "rounded-tooltip bg-ink px-2 py-1 opacity-0 shadow-overlay",
            "transition-opacity duration-100",
          )}
        >
          <span
            ref={hoverTimeRef}
            className="text-body-sm font-bold leading-tight tabular-nums text-neutral-50"
          />
          <span
            ref={hoverDayRef}
            className="text-caption leading-tight tabular-nums text-neutral-50"
          />
        </div>
      </>
    )}

    {/*
      ★ `days` 와 `viewerPersonId` 를 넘기는 이유는 **상세 창이 조치를 갖기 때문**이다
        (2026-09-28). 시각 옮기기의 요일 선택지는 이 화면이 이미 계산해 둔 그 주의
        날짜 칸이어야 하고 — 창이 따로 만들면 격자와 다른 주를 그릴 수 있다 —
        쓰기 가능 여부는 여기와 **같은 세션 판정**을 써야 한다.
    */}
    <RunDetailDialog
      block={openBlock}
      onClose={() => {
        setOpenKey(null);
      }}
      days={days}
      viewerPersonId={viewerPersonId}
    />

    {/*
      등록 창. `key` 에 시각을 넣어 **칸을 바꿔 누르면 다시 마운트**되게 한다 —
      앞서 고른 파티가 남아 있으면 "다른 칸을 눌렀는데 이미 골라져 있는" 상태가 된다.
    */}
    <TimetableRunDialog
      key={composeAt === null ? "compose-none" : composeAt.toISOString()}
      startsAt={composeAt}
      onClose={() => {
        setComposeAt(null);
      }}
      viewerPersonId={viewerPersonId}
    />
    </>
  );
}

/**
 * 클릭 위치 → **그 칸의 시작 분**.
 *
 * ★ 포인터가 없는 활성화(키보드 Enter/Space)는 `detail === 0` 이다. 그때 좌표는 0 이라
 *   그대로 쓰면 언제나 축의 맨 위(18:00)가 되고, 키보드 사용자는 시각을 고를 수 없다.
 *   그래서 **축 한가운데**로 떨어뜨리고, 그 값을 버튼의 접근 이름에 적어 둔다
 *   (`keyboardSlotMinute`) — 틀린 시각을 조용히 잡는 것보다 낫다.
 * ★ 끊어 맞추는 식 자체는 `snapAxisMinute` 가 갖는다. 호버 라벨이 **같은 식**을 불러야
 *   띄운 값과 잡히는 값이 같다(2026-10-04, 그 함수 머리말).
 */
function slotMinuteFromClick(
  event: React.MouseEvent<HTMLButtonElement>,
  axis: OverlayAxis,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio =
    event.detail === 0 || rect.height <= 0
      ? 0.5
      : (event.clientY - rect.top) / rect.height;

  return snapAxisMinute(ratio, axis, SLOT_MINUTES);
}

/**
 * 축 좌표(분) → `21:10` / `25:00`. 24:00 을 넘겨도 되돌리지 않는다 — 시각 눈금
 * (`formatHourTick`)과 같은 규칙이어야 호버 라벨과 눈금이 서로를 설명한다.
 */
function formatAxisClock(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
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
            /*
              본문 열과 **똑같은 세기**여야 한다. 띠는 격자 바로 위/아래에 같은
              `GRID_COLS` 로 붙으므로, 한쪽만 올리면 세로 통로가 띠에서 끊겨
              "머리와 몸이 따로 노는" 것으로 보인다(본문 열 주석 참고).
            */
            day.dayKey === todayKey
              ? "border-x-2 border-primary bg-primary-subtle"
              : null,
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
 * 눈금 라벨이 격자 **위아래 끝에서 잘리지 않게** 하는 세로 보정.
 *
 * 라벨은 선 위에 가운데(`-translate-y-1/2`) 앉는 것이 기본이다 — 선이 곧 그 시각이므로
 * 그게 옳다. 그런데 첫 눈금(0%)과 마지막 눈금(100%)은 그 절반이 컨테이너 밖으로 나가고
 * `overflow-y-hidden` 이 잘라 버린다. 발주 지적(2026-08-21): *"맨밑에 25 이거 짤리는데"*.
 *
 * 그래서 양 끝에서만 기준선을 바꾼다 — 위 끝은 선 **아래**, 아래 끝은 선 **위**에 붙인다.
 * 반 글자만큼 어긋나지만 잘려서 못 읽는 것보다 낫고, 가운데 눈금들은 그대로 정확하다.
 *
 * ★ 축을 24:30 으로 당긴 것(`AXIS_END_MINUTE`)과 **별개의 안전장치**다. 늦은 런이 축을
 *   밀면 25:00 이 다시 맨 아래에 설 수 있으므로, 상수만 고치고 끝내면 재발한다.
 */
function tickShift(percent: number): string {
  if (percent <= 0.5) return "translate-y-0";
  if (percent >= 99.5) return "-translate-y-full";
  return "-translate-y-1/2";
}

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
      /*
        ⚠️ `aria-current="date"` — 색·굵기·배지는 전부 **보이는** 채널이다. 보조기기에는
           따로 말해 줘야 하고, 그 자리를 예전에는 `sr-only` 글자가 메우고 있었다
           (아래 배지가 그 글자를 **눈에 보이게** 대체한다).
      */
      aria-current={isToday ? "date" : undefined}
      className={cn(
        "relative flex flex-col items-center gap-0.5 border-l border-border px-1 py-2",
        /*
          오늘: 좌·우 2px primary 레일. 본문 열과 **같은 격자 열·같은 굵기**라 머리 행에서
          시작한 통로가 격자까지 그대로 이어진다.
          ⚠️ 위쪽 선은 **테두리로 주지 않는다.** 가로 테두리는 칸 높이를 2px 밀어 올려
             오늘 칸의 요일 글자만 이웃보다 내려앉는다(격자 행은 높이를 공유하지만
             테두리는 칸마다 따로 먹는다). 그래서 아래의 **절대 위치 띠**로 그린다 —
             `site-nav` 의 모바일 상단 인디케이터와 같은 수법이고, 배치를 1px 도 안 건드린다.
             세로 테두리는 높이에 영향이 없어 그대로 테두리로 둔다.
        */
        isToday ? "border-x-2 border-primary bg-primary-subtle" : null,
      )}
    >
      {/* 통로의 **천장**. 좌우 레일과 만나 오늘 칸을 닫힌 윤곽으로 만든다. */}
      {isToday ? (
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
      ) : null}

      {/*
        요일이 먼저다 — 스케줄 화면에서 사람은 "며칠"보다 "무슨 요일"로 먼저 생각한다
        (`overlay-layout.ts` 의 `weekdayLabel` 주석과 같은 근거).
        오늘은 **네 채널**로 말한다(§4 — 색 단독 금지): 색 · 굵기 · 윤곽(2px 레일) ·
        글자(`오늘` 배지). 색맹·흑백 인쇄·저대비 화면 어디서도 최소 하나는 남는다.
      */}
      <span
        className={cn(
          "text-body-sm",
          // 라이트 5.62:1 · 다크 5.07:1 (primary / primary-subtle) — 둘 다 AA 통과.
          isToday ? "font-bold text-primary" : "font-semibold text-ink",
        )}
      >
        {day.weekdayLabel}
      </span>
      <span
        className={cn(
          "text-overline tabular-nums",
          // 날짜도 함께 켠다 — 요일만 물들면 머리 칸이 반만 오늘인 것처럼 보인다.
          isToday ? "font-bold text-primary" : "text-ink-muted",
        )}
      >
        {day.dateLabel}
      </span>

      {/*
        ── `오늘` 배지 ────────────────────────────────────────────────
        예전에는 이 글자가 `sr-only` 였다 — 스크린리더만 알고 **눈으로는 못 봤다.**
        발주 요청이 가리킨 곳이 정확히 여기다.

        ★ **칸 폭을 꽉 채우는 띠**(`w-full`)로 만든다. 알약 모양으로 좌우 여백을 주면
          폰에서 한 칸 내용 폭이 30px 안팎인데 `오늘`(12px 두 글자 ≈ 24px)에 좌우
          패딩이 붙어 **칸을 넘친다.** 띠는 글자를 가운데 두기만 하므로 가장 좁은
          칸에서도 넘칠 수가 없고, 데스크톱에서는 열 머리의 탭 라벨처럼 읽힌다.
        ★ 12px(`text-caption`)은 §4 가 **배지·라벨에 허용한** 하한이다. 문장이 아니다.
        ★ `tracking-normal` — `text-overline` 이 아니라 `text-caption` 이라 자간이
          문제될 일은 없지만, 두 글자짜리 띠에서 자간이 폭을 밀지 않게 못박아 둔다.
        대비: 흰 글자/primary 라이트 **6.29:1**, 다크 면 글자/밝은 primary **5.70:1**.
      */}
      {isToday ? (
        <span className="w-full rounded-sm bg-primary py-px text-center text-caption font-bold leading-snug tracking-normal text-surface">
          오늘
        </span>
      ) : null}
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
 * 예전에는 일정 화면으로 가는 링크였는데, "무슨 일정인지 확인하고 싶다"에
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
  /*
    묶음 전체를 잡았는가. **전부** 잡았을 때만 블록을 통째로 죽인다 — 하나라도 남았으면
    그 블록은 여전히 "가야 할 곳"이고, 흐리게 만들면 남은 보스를 놓친다.
    (발주 지적 2026-08-21: *"일정은 클리어 연동이 안되네?"* — 연동은 되고 있었고
     화면이 그 사실을 안 그렸다.)
  */
  const allCleared = block.runs.every((run) => run.clearedAt !== null);

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
        // 다 잡은 묶음은 **한 단계 물러난다.** 지우지는 않는다 — 오늘 뭘 했는지도 정보다.
        allCleared ? "bg-background" : null,
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
            {/*
              잡은 보스는 **얼굴을 흐리고 체크를 얹는다.** 색(흐림) 단독은 §4 가 금지하므로
              체크 표시가 함께 간다 — 흐림만 두면 "이미지가 안 불러와졌나"로 읽힌다.
            */}
            <span className="relative block size-full">
              <BossIcon
                bossDifficultyId={run.bossDifficultyId}
                difficulty={run.difficulty}
                size="sm"
                className={cn(
                  "size-full rounded-sm",
                  run.clearedAt === null ? null : "opacity-40 grayscale",
                )}
              />
              {run.clearedAt === null ? null : (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Check
                    aria-hidden
                    size={16}
                    strokeWidth={3}
                    className="text-success"
                  />
                </span>
              )}
            </span>
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
          className={cn(
            "truncate text-caption font-bold leading-tight",
            allCleared ? "text-ink-muted" : "text-ink",
          )}
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
