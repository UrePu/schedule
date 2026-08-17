import { CalendarClock } from "lucide-react";

import { TimeUntil, WeekLabel, formatKstFull } from "@/components/domain";
import { Card, CardOverline, CardTitle } from "@/components/ui";
import { getNextReset, getWeekKey } from "@/lib/time/week";

/**
 * 이번 주 요약 — 주차 라벨 + **목요일 00:00 KST 초기화까지 남은 시간**.
 *
 * 경계 계산은 전부 `lib/time/week.ts` 에 위임한다. 이 파일에는 날짜 산술이 한 줄도 없다 —
 * 주간 경계를 두 곳에서 계산하기 시작하면 반드시 갈라지고, 그 오차는 목요일 새벽에만
 * 드러나서 재현이 어렵다.
 *
 * `now` 를 주입받는 이유: 서버 렌더 시각과 하이드레이션 시각이 다르면 "3일 뒤"가 한 프레임
 * 어긋난다. 페이지가 한 번 만든 `now` 를 카드마다 그대로 흘려보낸다.
 */

export interface WeekSummaryCardProps {
  readonly now: Date;
  readonly className?: string;
}

export function WeekSummaryCard({ now, className }: WeekSummaryCardProps) {
  const reset = getNextReset(now);

  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <CalendarClock aria-hidden size={20} className="mt-0.5 text-primary" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardOverline>이번 주</CardOverline>
            {/*
              `WeekLabel` 은 `<div>` 라 `<h3>`(CardTitle) 안에 넣을 수 없다 —
              헤딩의 내용 모델은 phrasing content 뿐이다. 제목은 주차 키만 담고
              초기화 시각은 아래 별도 줄이 맡는다.
            */}
            <CardTitle className="text-body-lg tabular-nums">
              {getWeekKey(now)}
            </CardTitle>
            <WeekLabel
              date={now}
              hideIcon
              showWeekKey={false}
              className="text-body-sm"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-body-sm text-ink-muted">주간 초기화까지</p>
          <TimeUntil
            target={reset}
            now={now}
            // 주간 초기화는 몇 시간 전부터 "임박"이라고 말할 사건이 아니다. 남은 시간이
            // 하루 이내로 들어왔을 때만 tertiary 로 경고한다(빨강은 실패 전용, §4).
            imminentWithinMs={24 * 60 * 60 * 1000}
            className="text-body font-semibold"
          />
          <p className="text-body-sm text-ink-muted tabular-nums">
            {formatKstFull(reset)} KST
          </p>
        </div>
      </div>
    </Card>
  );
}
