import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { NumericText } from "@/components/domain";
import { buttonClass } from "@/components/ui";
import {
  formatWeekRange,
  shiftWeekKey,
  weekScopeLabel,
} from "@/lib/time/week-key";
import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주 이동 — `← 10/9(목) ~ 10/15(수) →`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-12): *"이번주일정만 볼수있고 다음주 일정이 없어. 다음주것도
 * 설정할수있게 위에 움직이는 버튼 만들어줘"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **버튼이 아니라 링크다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 보고 있는 주의 주인은 URL(`?week=2026-W42`)이고(`app/page.tsx` 주석), 그래서 이동은
 * 상태 변경이 아니라 **다른 주소로 가는 일**이다. 앵커로 두면 세 가지가 공짜로 따라온다:
 *   · 서버가 **그 주를 프리페치**한다 → 주를 옮길 때 스켈레톤이 번쩍이지 않는다.
 *   · 가운데 클릭·새 탭·주소 복사가 그대로 동작한다("다음 주 이거 봐"를 보낼 수 있다).
 *   · 뒤로 가기가 보던 주로 돌아간다.
 * 모양은 `buttonClass()` 로 진짜 버튼과 **같은 조합**을 쓴다 — 클래스를 손으로 베끼면
 * 버튼 스타일을 고칠 때 이쪽만 옛 모습으로 남는다(`nexon-key-issue-link` 와 같은 판단).
 *
 * `scroll={false}`: 주를 옮기는 것은 같은 화면 안의 이동이라 스크롤 위치를 유지해야
 * 한다. 아래 격자에서 22시를 보고 있었는데 주를 넘길 때마다 맨 위로 튀면 쓸 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 범위 제한은 **없다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 과거도 미래도 간다. 지난 주를 보는 것은 "지난주에 뭐 돌았지"에 답한다. 그 대가로 생길
 * 수 있었던 넥슨 호출 폭주는 **읽기 경로가 아니라 동기화 경로에서** 막았다 —
 * `use-post-run-sync.ts` 와 `timetable-refresh-button.tsx` 의 주차 가드.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 접근성
 * ─────────────────────────────────────────────────────────────────────────────
 * · 화살표 링크는 아이콘뿐이라 `aria-label` 이 **어느 주로 가는지까지** 말한다
 *   (`이전 주 · 10/2(목) ~ 10/8(수)`). "이전"만으로는 어디로 가는지 알 수 없다.
 * · 가운데 라벨이 `aria-live="polite"` 다. 주 이동은 **소프트 내비게이션**이라 포커스가
 *   누른 링크에 그대로 남고 페이지도 다시 읽히지 않는다 — 화면만 바뀌면 스크린리더
 *   사용자는 아무 변화도 듣지 못한다. 이 노드는 이동 전후로 **같은 DOM 자리에 살아남아**
 *   글자만 바뀌므로 live region 이 그 변화를 읽어 준다.
 *
 * 폭 400px: `flex-wrap` 이고 가운데 라벨만 줄어든다(`min-w-0`). 한 줄에 안 들어가면
 * `이번 주` 링크가 다음 줄로 내려가고, 그래도 좁으면 라벨 글자가 두 줄이 된다 —
 * 어느 경우에도 **가로로는 넘치지 않는다.**
 */

export interface WeekNavProps {
  /** 보고 있는 주. */
  readonly weekKey: string;
  /** 서버가 계산한 **지금** 주차. `이번 주` 링크를 보일지 정한다. */
  readonly currentWeekKey: string;
  readonly className?: string;
}

/** 주차 → 그 주를 보는 주소. 이번 주는 파라미터 없이 `/` 다(짧은 쪽이 기본). */
function weekHref(weekKey: string, currentWeekKey: string): string {
  return weekKey === currentWeekKey ? "/" : `/?week=${weekKey}`;
}

export function WeekNav({ weekKey, currentWeekKey, className }: WeekNavProps) {
  const previousWeek = shiftWeekKey(weekKey, -1);
  const nextWeek = shiftWeekKey(weekKey, 1);
  const isCurrentWeek = weekKey === currentWeekKey;

  return (
    <nav
      aria-label="주 이동"
      className={cn("flex w-full flex-wrap items-center gap-1.5", className)}
    >
      <Link
        href={weekHref(previousWeek, currentWeekKey)}
        scroll={false}
        aria-label={`이전 주 · ${formatWeekRange(previousWeek)}`}
        title={`이전 주 · ${formatWeekRange(previousWeek)}`}
        className={buttonClass("secondary", "sm", "cursor-pointer px-2")}
      >
        <ChevronLeft aria-hidden size={16} />
      </Link>

      <p
        aria-live="polite"
        className="min-w-0 flex-1 text-center text-body-sm text-ink"
      >
        <span className="font-semibold">{weekScopeLabel(weekKey, currentWeekKey)}</span>{" "}
        <NumericText className="text-ink-muted">
          {formatWeekRange(weekKey)}
        </NumericText>
      </p>

      <Link
        href={weekHref(nextWeek, currentWeekKey)}
        scroll={false}
        aria-label={`다음 주 · ${formatWeekRange(nextWeek)}`}
        title={`다음 주 · ${formatWeekRange(nextWeek)}`}
        className={buttonClass("secondary", "sm", "cursor-pointer px-2")}
      >
        <ChevronRight aria-hidden size={16} />
      </Link>

      {/*
        이번 주일 때는 그리지 않는다. 눌러도 제자리인 링크는 없느니만 못하고, 이 줄에서
        가장 아까운 것이 폭이다(`income-calendar` 의 `오늘` 버튼은 같은 이유로
        `disabled` 인데, 거기는 달 이동이 늘 세 칸으로 고정된 자리라 사라지면 줄이 흔들린다 —
        여기는 라벨이 가변폭이라 사라져도 줄이 흔들리지 않는다).
      */}
      {isCurrentWeek ? null : (
        <Link
          href="/"
          scroll={false}
          className={buttonClass("ghost", "sm", "cursor-pointer")}
        >
          이번 주
        </Link>
      )}
    </nav>
  );
}
