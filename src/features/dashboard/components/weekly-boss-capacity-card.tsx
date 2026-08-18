import { Swords, TriangleAlert } from "lucide-react";

import { Numeric } from "@/components/domain";
import { Card, CardOverline, CardTitle, EmptyState } from "@/components/ui";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { cn } from "@/lib/utils";

import type { WeeklyBossCapacity } from "../lib/weekly-boss-capacity";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 **몇 개 더 돌아야 하는가** — 90개 천장 카드가 있던 자리
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-18): *"천장90개로 하지말고 현재 선택된 캐릭터 갯수 위주로 몇개
 * 보스 돌아야하는지."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 카드가 지키는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **주인공은 남은 개수다.** 큰 글자는 `44개 남음` 이고, `84 중 40 완료` 는 그 아래
 *    근거로 붙는다. 90개 천장 카드는 반대였다 — 큰 숫자가 "얼마나 썼나"였고, 사용자가
 *    이 화면에서 실제로 묻는 것("오늘 뭘 더 돌지")에 답하지 않았다.
 * 2. **분모는 `추적 캐릭터 수 × 캐릭터당 상한` 이다.** 12개 상한은 캐릭터당이라(§1)
 *    합산 분자에 캐릭터 하나의 상한을 붙이면 `40 / 12` 같은 값이 나온다. 계산과 그 근거는
 *    전부 `../lib/weekly-boss-capacity` 에 있고 이 파일은 **그리기만** 한다.
 * 3. **추적 0명은 오류가 아니라 빈 상태다.** 분모가 0 이라 비율을 그릴 수 없고, 그때
 *    할 일은 "캐릭터를 먼저 고르는 것"이므로 그 동선을 카드 안에 둔다.
 * 4. **90개 천장을 다시 끌어오지 않는다.** 그 경고는 수익 화면(`/income`)의
 *    `AccountCrystalCapCard` 가 그대로 맡는다 — 지운 것이 아니라 자리를 옮겼다.
 *
 * §4 준수:
 * - 경고는 **tertiary orange**. red 는 실패·취소 전용이라 여기 오지 않는다.
 * - 주황은 **배경·아이콘·막대**만 진다. 읽어야 하는 문장은 `text-ink` 다
 *   (주황 본문은 라이트 모드에서 AA 미달).
 * - 문장은 `text-body-sm`(14px) 이상. `text-caption`(12px)은 숫자 주석에만.
 * - 캐릭터 칩은 360px 에서 줄바꿈으로 흘러 가로 스크롤을 만들지 않는다.
 */

export interface WeeklyBossCapacityCardProps {
  readonly capacity: WeeklyBossCapacity;
  readonly className?: string;
}

/** 소진 막대. 값이 아니라 **상태**를 색으로 말한다 — 상한을 채운 캐릭터가 있으면 주황. */
function CapacityMeter({
  cleared,
  limit,
  alert,
}: {
  readonly cleared: number;
  readonly limit: number;
  readonly alert: boolean;
}) {
  const ratio = limit <= 0 ? 0 : Math.min(cleared / limit, 1);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-hover-surface"
      role="presentation"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-200",
          alert ? "bg-tertiary" : "bg-primary",
        )}
        style={{ width: `${String(Math.round(ratio * 100))}%` }}
      />
    </div>
  );
}

/**
 * 캐릭터별 남은 칸 — **칩 한 줄**이다.
 *
 * 체크리스트가 바로 아래에서 캐릭터마다 12칸 그리드를 이미 그리므로, 여기서 같은 목록을
 * 또 세로로 쌓으면 같은 정보가 대시보드에 세 번 나온다. 대신 "누구를 더 돌려야 하는가"만
 * 한눈에 남기고(남은 것이 많은 순), *무엇을* 돌지는 아래 체크리스트가 답한다.
 * 다 돈 캐릭터는 완료 색으로 죽여서 목록이 여전히 **할 일**로 읽히게 한다.
 */
function CharacterSlotChip({
  name,
  remaining,
}: {
  readonly name: string;
  readonly remaining: number | null;
}) {
  const done = remaining === 0;
  return (
    <li
      className={cn(
        "flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-body-sm",
        done
          ? "border-chip-done-border bg-chip-done-bg text-ink-muted"
          : "border-border bg-background text-ink",
      )}
    >
      <span className="min-w-0 max-w-32 truncate">{name}</span>
      {remaining === null ? (
        <span className="shrink-0 text-ink-muted">상한 미확인</span>
      ) : (
        <span className="shrink-0 font-semibold">
          <Numeric>{remaining}</Numeric>
          {done ? "" : "개"}
        </span>
      )}
    </li>
  );
}

export function WeeklyBossCapacityCard({
  capacity,
  className,
}: WeeklyBossCapacityCardProps) {
  const {
    trackedCount,
    perCharacterLimit,
    limitTotal,
    clearedTotal,
    remainingTotal,
    overLimitCount,
    characters,
    untrackedClearedCount,
  } = capacity;

  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start gap-2">
        <Swords aria-hidden size={20} className="mt-0.5 text-primary" />
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>
            {trackedCount > 0 && perCharacterLimit !== null ? (
              <>
                추적 <Numeric>{trackedCount}</Numeric>명 ×{" "}
                <Numeric>{perCharacterLimit}</Numeric>
              </>
            ) : (
              "추적 캐릭터 기준"
            )}
          </CardOverline>
          <CardTitle className="text-body-lg">이번 주 남은 주간 보스</CardTitle>
        </div>
      </div>

      {trackedCount === 0 ? (
        /*
          빈 상태 — "0개 했다"가 아니라 **셀 것 자체가 없다**이다.
          분모가 0 이면 나눗셈이 성립하지 않으므로 비율도 막대도 그리지 않는다.
        */
        <EmptyState
          title="추적할 캐릭터를 먼저 고르세요"
          description="캐릭터를 고르면 고른 인원수만큼 이번 주에 돌 수 있는 주간 보스 칸이 잡히고, 몇 개가 남았는지 여기에 표시됩니다."
          action={<CharacterPickerTrigger label="캐릭터 선택하기" />}
          className="py-8"
        />
      ) : limitTotal === null || remainingTotal === null ? (
        /*
          상한을 어디서도 못 읽은 경우. **12를 지어내지 않는다** — 모르는 분모로 그린
          비율은 사용자가 검증할 수 없는 숫자다. 조치(동기화)를 대신 말한다.
        */
        <p className="text-body-sm text-ink-muted">
          아직 캐릭터당 주간 보스 상한을 읽지 못했습니다. 아래 체크리스트에서 인게임
          스케줄러를 한 번 불러오면 추적 <Numeric>{trackedCount}</Numeric>명 기준으로
          남은 칸이 계산됩니다.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-headline text-subhead font-bold text-ink">
              <Numeric>{remainingTotal}</Numeric>개
            </span>
            <span className="text-body-sm text-ink-muted">더 돌 수 있습니다</span>
          </div>

          <CapacityMeter
            cleared={clearedTotal}
            limit={limitTotal}
            alert={overLimitCount > 0}
          />

          <p className="text-body-sm text-ink-label">
            <Numeric>{limitTotal}</Numeric>칸 중{" "}
            <Numeric>{clearedTotal}</Numeric>개 완료 ·{" "}
            <Numeric>{remainingTotal}</Numeric>개 남음
          </p>

          {characters.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {characters.map((entry) => (
                <CharacterSlotChip
                  key={entry.characterId}
                  name={entry.characterName}
                  remaining={entry.remaining}
                />
              ))}
            </ul>
          ) : null}

          {overLimitCount > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>
                캐릭터 {overLimitCount}명이 캐릭터당 상한({perCharacterLimit}개)을
                채웠습니다. 그 캐릭터는 이번 주에 주간 보스를 더 입장할 수 없습니다 —
                남은 칸은 다른 캐릭터의 것입니다.
              </span>
            </p>
          ) : null}

          {untrackedClearedCount > 0 ? (
            <p className="text-body-sm text-ink-muted">
              추적하지 않는 캐릭터의 주간 보스 클리어 {untrackedClearedCount}건은 이
              칸 계산에 넣지 않았습니다. 그 캐릭터의 칸이 분모에 없기 때문이며, 수익
              합계에는 그대로 들어가 있습니다.
            </p>
          ) : null}
        </>
      )}

      {/*
        ★ **항상 그린다.** 그리고 여기서 하는 말은 90개 천장 카드의 `TRACKED_SCOPE_NOTE`
          와 **다르다** — 그 문장은 "일간이 빠져 있어 우리 집계가 실제보다 낮다"인데,
          12개 카운터에는 그 말이 성립하지 않는다. 일간 결정석은 애초에 12에 들어가지
          않으므로(§1, `@/lib/domain/boss-scope` 머리말) 이 숫자는 하한값이 아니라
          **정확한 값**이다. 같은 문장을 재사용했다면 없는 오차를 있다고 말하게 된다.
          그래도 "일간은 여기 없다"는 사실 자체는 밝혀야 사용자가 일간 숙제를 이 칸에서
          찾지 않는다.
      */}
      <p className="text-body-sm text-ink-muted">
        주간 보스만 셉니다. 월간 보스와 일간 보스는 이 칸을 쓰지 않습니다.
      </p>
    </Card>
  );
}
