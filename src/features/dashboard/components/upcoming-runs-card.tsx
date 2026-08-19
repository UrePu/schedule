import { CalendarClock, ChevronRight, Swords } from "lucide-react";
import Link from "next/link";

import { Numeric, TimeUntil } from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  EmptyState,
} from "@/components/ui";
import { groupRuns } from "@/lib/domain/run-grouping";
import { cn } from "@/lib/utils";

import type { DashboardRun } from "../server/dashboard-repo";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 가장 가까운 보스 일정 — **대시보드에서 "아 보스 언제네"가 바로 보인다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"가장 가까운 파티 보스 일정을 알려주는게 좋아보임. 이번주 남은
 * 주간 보스 이거 탭 없애고"* · *"일정 자체를 알려달라는거지 아까 !일정 처럼. 그래야
 * 대시보드에서도 아 보스 언제네 바로 볼수있잖아."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 밀어냈나
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 자리에는 `WeeklyBossCapacityCard`(**이번 주 남은 주간 보스**)가 있었다. 발주자
 * 지적대로 왼쪽 결정석 수익 카드와 **같은 정보**였다 — 그쪽이 이미 `주간 보스 40 / 84건`
 * 을 같은 분모로 말하고 있었고, 오른쪽은 그 여집합(`44개 더 돌 수 있습니다`)을 캐릭터별로
 * 펼쳐 놓은 것뿐이었다. 두 칸을 같은 사실에 쓰느니 **아직 화면에 없던 사실**(언제 도는가)에
 * 쓰는 것이 맞다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 모양은 `!일정` 과 **같은 함수**가 만든다
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음 규칙(연속·같은 파티·같은 날)과 `익세 하대 하카 : 무르겨르` 로 접는 규칙은
 * `@/lib/domain/run-grouping` 이 소유하고, 카톡 봇의 `!일정` 이 같은 함수를 부른다.
 * 여기서 다시 조립하면 방에서 본 일정과 대시보드가 언젠가 갈린다.
 *
 * ⚠️ **날짜를 항상 적는다**(`reference = null`). 이 카드는 하루짜리 목록이 아니라
 *    "다음에 오는 것들"이라 `21:40` 만으로는 어느 날인지 알 수 없다.
 * ⚠️ 임박 표시는 **주황(tertiary)** 이다. 빨강은 실패·취소 전용이다(§4). 색만으로
 *    전달하지 않도록 `TimeUntil` 이 아이콘과 문구(`3시간 20분 뒤`)를 함께 싣는다.
 */

/** 카드에 그리는 최대 묶음 수. 그 이상은 목록이지 요약이 아니다. */
const MAX_GROUPS = 3;

export interface UpcomingRunsCardProps {
  readonly runs: readonly DashboardRun[];
  /** 기준 시각. **서버가 주입한다** — 남은 시간 표기가 SSR 과 갈리지 않게 한다. */
  readonly now: Date;
  readonly className?: string;
}

export function UpcomingRunsCard({
  runs,
  now,
  className,
}: UpcomingRunsCardProps) {
  /*
    ISO 문자열 → `Date`. 서버는 JSON 으로 보내므로 이 경계에서 한 번만 되돌린다.
    (`scheduledAt` 이 `null` 인 런은 서버가 이미 걸러 냈다 — 카드가 답하는 질문이
     "언제"인데 시각이 없는 런은 답이 되지 않는다.)
  */
  const groups = groupRuns(
    runs.map((run) => ({
      partyId: run.partyId,
      scheduledAt: new Date(run.scheduledAt),
      durationMinutes: run.durationMinutes,
      shortName: run.shortName,
      characterName: run.characterName,
      partyNo: run.partyNo,
    })),
    null,
  ).slice(0, MAX_GROUPS);

  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <CalendarClock aria-hidden size={20} className="mt-0.5 text-primary" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardOverline>다가오는 일정</CardOverline>
            <CardTitle className="text-body-lg">가장 가까운 보스</CardTitle>
          </div>
        </div>
        <Link href="/schedule" className="shrink-0">
          <Button variant="secondary" size="sm">
            일정 화면
            <ChevronRight aria-hidden size={14} />
          </Button>
        </Link>
      </div>

      {groups.length === 0 ? (
        /*
          빈 상태는 **"일정이 없다"** 이지 오류가 아니다(§0.3). 다음에 할 일까지 말한다.
          시각 미정 런만 있는 경우도 여기로 온다 — 그것도 "언제"를 답하지 못하기 때문이다.
        */
        <EmptyState
          icon={<Swords size={24} />}
          title="다가오는 보스 일정이 없습니다"
          description="일정 화면에서 파티원의 가능 시간을 겹쳐 보고 보스 일정을 등록하면, 다음에 도는 보스가 여기 뜹니다."
          action={
            <Link href="/schedule">
              <Button size="sm">일정 잡으러 가기</Button>
            </Link>
          }
          className="py-6"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group, index) => (
            <li
              key={`${group.range}-${String(index)}`}
              className={cn(
                "flex flex-col gap-1.5 rounded-md border border-l-4 border-border bg-surface px-3 py-2",
                // 맨 앞 묶음이 곧 "가장 가까운" 것이다. 왼쪽 보더로 그것만 세운다(§4).
                index === 0 ? "border-l-primary" : "border-l-border",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-body-sm font-semibold text-ink tabular-nums">
                  {group.range}
                  {group.partyNo === null ? null : (
                    <span className="font-medium text-ink-label">
                      {" · "}
                      <Numeric>{String(group.partyNo)}</Numeric>파티
                    </span>
                  )}
                </span>
                {group.startAt === null ? null : (
                  <TimeUntil target={group.startAt} now={now} />
                )}
              </div>

              {/*
                `익세 하대 하카 : 무르겨르` — 한 캐릭터가 한 줄이다. 보스마다 캐릭터
                이름을 되풀이하면 실제로 다른 부분(보스)이 묻힌다.
              */}
              <ul className="flex flex-col gap-0.5">
                {group.lines.map((line) => (
                  <li key={line} className="text-body-sm text-ink-label">
                    {line}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
