import { CalendarRange, ChevronRight, Users } from "lucide-react";
import Link from "next/link";

import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  EmptyState,
} from "@/components/ui";

import type { DashboardParty } from "../server/dashboard-repo";

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

const VISIBILITY_LABEL: Record<DashboardParty["visibility"], string> = {
  private: "비공개",
  link: "링크 공유",
  public: "공개",
};

export interface MyPartiesCardProps {
  readonly parties: readonly DashboardParty[];
  readonly className?: string;
}

export function MyPartiesCard({ parties, className }: MyPartiesCardProps) {
  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Users aria-hidden size={20} className="mt-0.5 text-primary" />
            <div className="flex min-w-0 flex-col gap-1">
              <CardOverline>내 파티</CardOverline>
              <CardTitle className="text-body-lg">
                파티 {parties.length}개
              </CardTitle>
            </div>
          </div>
          {/*
            **채운 버튼(primary)** 이다. 대시보드 최상단 카드의 주 행동이고, 발주자가
            "파티가 메인"이라고 못박은 화면에서 가장 눈에 띄어야 하는 진입점이다.
            (이전에는 outline 이라 헤더 안에서 묻혔다.)
          */}
          <Link href="/schedule" className="shrink-0">
            <Button size="sm">
              <CalendarRange aria-hidden size={16} />
              겹쳐보기 열기
            </Button>
          </Link>
        </div>

        {parties.length === 0 ? (
          <EmptyState
            icon={<Users size={24} />}
            title="아직 파티가 없습니다"
            description="겹쳐보기 화면에서 파티를 만들면 여기에 나타납니다. 파티원의 가능 시간이 한 화면에 겹쳐 보입니다."
            action={
              <Link href="/schedule">
                <Button size="sm">파티 만들러 가기</Button>
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {parties.map((party) => (
              <li key={party.partyId}>
                <Link
                  href="/schedule"
                  className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 transition duration-200 hover:border-border-strong hover:bg-hover-strong"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-semibold text-ink">
                      {party.name}
                    </span>
                    {/*
                      `ink-muted` 가 아니라 `ink-label` 인 이유: 이 행은 hover 시 배경이
                      hover 전용 면(`hover-strong`)으로 올라가는데, 예전 `ink-muted`(#71717a)는
                      그 위에서 라이트 **3.88:1** 로 AA 미달이었다.
                      2026-08-19 대비 감사에서 라이트 `ink-muted` 를 `#62616a` 로 내려
                      hover 면에서도 4.91:1 이 됐지만, 이 줄은 시간·인원이 나란히 서는
                      **정보 행**이라 한 단계 진한 `ink-label` 을 그대로 둔다
                      (hover 상태 라이트 8.39:1 / 다크 8.97:1).
                    */}
                    <span className="text-body-sm text-ink-label tabular-nums">
                      {VISIBILITY_LABEL[party.visibility]} · 구성원{" "}
                      {party.memberCount}명 · 이번 주 일정{" "}
                      {party.runCountThisWeek}건
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    size={16}
                    className="shrink-0 text-ink-muted"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
