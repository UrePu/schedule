import type { ComponentPropsWithRef, ReactNode } from "react";

import { Card, StatusChip, type StatusTone } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { BossDifficultyId } from "@/types/domain";
import {
  BOSS_DIFFICULTY_BORDER_L,
  BOSS_DIFFICULTY_LABEL,
  BOSS_DIFFICULTY_TEXT,
  type BossDifficulty,
} from "./boss-difficulty";
import { BossIcon } from "./boss-icon";
import { MesoAmount } from "./meso-amount";
import { SeatNumber } from "./seat-number";
import { TimeUntil } from "./time-until";

/**
 * 보스 한 건을 표현하는 카드.
 *
 * 규칙(CLAUDE.md §4): **난이도는 좌측 보더 색으로 인코딩**한다.
 * (PipelinePro 의 "deal card 는 좌측 보더로 스테이지를 한눈에 구분" 규칙을 도메인에 이식)
 *
 * 규칙(CLAUDE.md §1.1): 표시 가격은 **솔로 기준**이고 실지급은 `floor(price / party_size)` 다.
 * `partySize` 를 주면 분배 후 금액을 함께 보여 준다. 생략하면 솔로가 아니라
 * "분배 정보 없음"이므로 솔로 금액만 노출한다.
 *
 * 규칙(CLAUDE.md §1.3 D4): `crystalPrice = null` 은 미확인이며 0 이 아니다 — MesoAmount 가 처리.
 *
 * 난이도 색 매핑은 **여기에 없다.** `./boss-difficulty` 가 유일한 정의처이며,
 * 카드·행·칩·아이콘 슬롯이 전부 그것을 가져다 쓴다.
 */

export interface BossCardProps
  extends Omit<ComponentPropsWithRef<"div">, "title"> {
  bossName: string;
  /**
   * `boss_difficulties.id` — 아이콘을 고르는 열쇠다(`BossIcon`).
   * 파일이 없는 보스는 실루엣 폴백이 뜬다. **오류가 아니다**(§2.1.1 초상화 규약).
   */
  bossDifficultyId: BossDifficultyId;
  difficulty: BossDifficulty;
  /** 예정 시각. 주면 TimeUntil 이 붙는다. */
  scheduledAt?: Date;
  /** TimeUntil 기준 시각. SSR 불일치를 막으려면 주입할 것. */
  now?: Date;
  /** 솔로 기준 결정석 가격. `null` 은 미확인(§1.3 D4). */
  crystalPrice?: number | null;
  /** 입장 시점 파티 인원. 실지급은 floor(price / partySize) (§1.1). */
  partySize?: number;
  /** 완료·임박·실패 상태 칩. 생략하면 칩을 그리지 않는다. */
  status?: StatusTone;
  /** 참가자 번호(§1.4 — 재배열 금지). */
  seatNo?: number;
  /** 카드 우하단 보조 영역. */
  footer?: ReactNode;
}

export function BossCard({
  bossName,
  bossDifficultyId,
  difficulty,
  scheduledAt,
  now,
  crystalPrice,
  partySize,
  status,
  seatNo,
  footer,
  className,
  ...props
}: BossCardProps) {
  const hasPrice = crystalPrice !== undefined;
  const splitValue =
    typeof crystalPrice === "number" && partySize && partySize > 1
      ? Math.floor(crystalPrice / partySize)
      : null;

  return (
    <Card
      className={cn(
        "flex flex-col gap-3 border-l-4",
        BOSS_DIFFICULTY_BORDER_L[difficulty],
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {seatNo === undefined ? null : <SeatNumber seatNo={seatNo} size="sm" />}
          <BossIcon
            bossDifficultyId={bossDifficultyId}
            difficulty={difficulty}
            size="lg"
          />
          <div className="min-w-0">
            <p
              className={cn(
                "text-overline uppercase",
                BOSS_DIFFICULTY_TEXT[difficulty],
              )}
            >
              {BOSS_DIFFICULTY_LABEL[difficulty]}
            </p>
            <p className="truncate font-headline text-body-lg font-semibold text-ink">
              {bossName}
            </p>
          </div>
        </div>
        {status ? <StatusChip status={status} /> : null}
      </div>

      {scheduledAt ? <TimeUntil target={scheduledAt} now={now} /> : null}

      {hasPrice ? (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption text-ink-muted">결정석 (솔로가)</span>
            <MesoAmount
              value={crystalPrice ?? null}
              compact
              tone="accent"
              className="text-body-sm font-semibold"
            />
          </div>
          {splitValue === null ? null : (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-caption text-ink-muted">
                {partySize}인 분배 후
              </span>
              <MesoAmount value={splitValue} compact className="text-body-sm" />
            </div>
          )}
        </div>
      ) : null}

      {footer ? <div className="pt-1">{footer}</div> : null}
    </Card>
  );
}
