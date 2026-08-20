import { CalendarRange, ChevronRight, Users } from "lucide-react";
import Link from "next/link";

import { Numeric } from "@/components/domain";
import { Button, Card, CardOverline, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";

import type { DashboardParty } from "@/features/dashboard/server/dashboard-repo";

/**
 * 내 파티 목록 (§1.2 1순위로 가는 진입점).
 *
 * 각 행은 `/schedule` 로 들어간다. 지금 `/schedule` 은 쿼리로 파티를 고르는 경로가 없어
 * 첫 파티를 기본 선택하므로, 링크에 `?party=` 를 붙이지 않았다 — **동작하지 않는 파라미터를
 * 미리 심어 두면 다음 사람이 그게 지원된다고 믿는다.** 파티 선택은 그 화면의 파티 바에서
 * 한다.
 *
 * 여기 나오는 파티는 **내가 속한 것만**이다. 공개 파티 게시판이 아니다
 * (`dashboard-repo.fetchMyParties` 주석 참고).
 */

/*
 * 여기 있던 `VISIBILITY_LABEL`(비공개 / 링크 공유 / 공개)은 카드를 줄이면서 화면에서
 * 빠졌다(2026-08-19). 공개 범위는 `/schedule` 의 파티 바가 그대로 보여 준다 — 대시보드의
 * 한 줄짜리 목록에서 매번 되풀이할 값이 아니다.
 */

export interface MyPartiesCardProps {
  readonly parties: readonly DashboardParty[];
  readonly className?: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 — **작게 줄였다** (발주자: *"여기 파티 2개를 작게 바꾸고"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 파티마다 두 줄(이름 + `비공개 · 구성원 2명 · 이번 주 일정 4건`)을 쓰는 큰
 * 카드가 두 칸을 차지했다. 그런데 대시보드에서 이 카드가 실제로 하는 일은 **"내 파티가
 * 뭐가 있고, 눌러서 겹쳐보기로 간다"** 뿐이다 — 공개 범위·구성원 수는 그 화면에 가면 다
 * 있고, 이번 주 일정 건수는 이제 옆의 '가장 가까운 보스' 카드가 **실제 시각으로** 말한다.
 *
 * 그래서 한 줄에 이름과 인원만 남기고 상세는 뺐다. 지운 정보는 전부 `/schedule` 에 있다.
 */
export function MyPartiesCard({ parties, className }: MyPartiesCardProps) {
  return (
    <Card className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Users aria-hidden size={18} className="text-primary" />
          <CardOverline>내 파티</CardOverline>
          <CardTitle className="text-body-sm">
            <Numeric>{String(parties.length)}</Numeric>개
          </CardTitle>
        </div>
        <Link href="/schedule" className="shrink-0">
          <Button variant="secondary" size="sm">
            <CalendarRange aria-hidden size={14} />
            겹쳐보기
          </Button>
        </Link>
      </div>

      {parties.length === 0 ? (
        /*
          빈 상태는 한 문장으로 접었다. 큰 `EmptyState` 는 이 작아진 카드에서 카드보다
          커지고, 바로 위 버튼이 이미 갈 곳을 말하고 있다.
        */
        <p className="text-body-sm text-ink-muted">
          아직 파티가 없습니다. 겹쳐보기 화면에서 만들면 여기에 나타납니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {parties.map((party) => (
            <li key={party.partyId}>
              <Link
                href="/schedule"
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 transition duration-200 hover:border-border-strong hover:bg-hover-strong"
              >
                <span className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink">
                  {party.name}
                </span>
                {/*
                  `ink-muted` 가 아니라 `ink-label` 인 이유: 이 행은 hover 시 배경이
                  hover 전용 면(`hover-strong`)으로 올라가는데, 예전 `ink-muted`(#71717a)는
                  그 위에서 라이트 **3.88:1** 로 AA 미달이었다. 2026-08-19 대비 감사 뒤
                  `ink-muted` 도 hover 면에서 4.91:1 이 됐지만, 수치가 붙는 자리라 한 단계
                  진한 `ink-label` 을 그대로 둔다(hover 라이트 8.39:1 / 다크 8.97:1).
                */}
                <span className="shrink-0 text-caption text-ink-label tabular-nums">
                  <Numeric>{String(party.memberCount)}</Numeric>명
                </span>
                <ChevronRight
                  aria-hidden
                  size={14}
                  className="shrink-0 text-ink-muted"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
