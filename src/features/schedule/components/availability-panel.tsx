"use client";

import {
  CalendarRange,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  TriangleAlert,
  UserRoundX,
} from "lucide-react";
import { useMemo } from "react";

import { NumericText, WeekLabel, formatKstDayKey } from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  FilterChip,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { formatDayMinute } from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import type {
  AvailabilityException,
  AvailabilityInterval,
  OverlapWindow,
  PartyMember,
  RunCommitment,
  TimeRange,
} from "@/types/domain";

import { OverlayDayGrid } from "./overlay-day-grid";
import { OverlayGrid, OverlayLegend } from "./overlay-grid";

/**
 * 왼쪽 패널 — 선택한 사람들의 가능 시간을 겹쳐 보여 준다 (§1.4).
 *
 * 로딩(Skeleton) / 빈 상태(선택 없음 · 겹침 없음) / 에러(재시도)를 모두 여기서 가른다.
 * "겹치는 시간이 없다"는 **오류가 아니라 사실**이므로 ErrorState 가 아니라 EmptyState 다.
 */

export interface AvailabilityPanelProps {
  /*
   * ⚠️ `now` 는 **더 이상 받지 않는다.** 주차 라벨이 `range.from`(보고 있는 주의 시작)을
   *    쓰기 때문이다 — `now` 를 넘기면 다음 주를 보면서도 머리글이 이번 주라고 말한다.
   *    `WeekLabel` 은 날짜에서 주차를 뽑기만 하고 남은 시간을 세지 않으므로 이 교체로
   *    잃는 정보가 없다.
   */
  readonly range: TimeRange;
  /** 이번 주 기준 몇 주 뒤를 보고 있는가. 0 이면 이번 주. */
  readonly weekOffset: number;
  /** 주차 이동. **비로그인·고정 화면이면 `null`** 이고 그때는 버튼이 아예 없다. */
  readonly onWeekOffsetChange: ((offset: number) => void) | null;
  /** 선택된 파티원 (seatNo 오름차순). */
  readonly members: readonly PartyMember[];
  readonly intervals: readonly AvailabilityInterval[];
  readonly overlapWindows: readonly OverlapWindow[];
  readonly exceptions: readonly AvailabilityException[];
  /**
   * 이미 등록된 보스 일정이 잡아먹은 시간. 겹침 결과에서는 **이미 빠져 있고**, 이 값은
   * 그 사실을 "이미 일정 있음" 으로 **보여 주기 위한** 것이다 (§1.4 · 조용히 사라지면 안 된다).
   */
  readonly commitments: readonly RunCommitment[];
  /** 파티원 전체 이름 조회용(예외 메모에 이름을 붙인다). */
  readonly memberNameById: ReadonlyMap<string, string>;
  /** `"all"` = 전원. 숫자면 "k명 이상". */
  /**
   * 가능 시간을 하나도 등록하지 않아 **겹침 분모에서 빠진** 사람들의 표시 이름.
   * 비어 있으면 아무도 빠지지 않았다는 뜻이라 안내 줄 자체가 나오지 않는다.
   */
  readonly unscheduledNames: readonly string[];
  readonly minCountChoice: number | "all";
  readonly effectiveMinCount: number;
  readonly onMinCountChange: (choice: number | "all") => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly selectedWindowKey: string | null;
  readonly onSelectWindow: (window: OverlapWindow, startsAt?: Date) => void;
  /** 고른 시작 시각 — 격자의 `▶────` 막대가 여기서 뻗는다. */
  readonly selectedStartsAt: Date | null;
  /** 겹침을 클릭했다 — 등록 모달을 연다. */
  readonly onOpenComposer: () => void;
  /** 지금 보고 있는 파티 이름. 번호·구성원이 어느 파티 것인지 밝힌다. */
  readonly partyName: string | null;
  /**
   * 내 가능 시간 편집기를 여는 동선. **비로그인은 `null`** 이다 — 쓰기가 불가능한
   * 버튼을 띄워 두고 눌렀을 때 막는 것은 나쁜 동선이라 항목 자체를 감춘다.
   */
  readonly onEditAvailability: (() => void) | null;
  /**
   * 열람자 본인이 반복 패턴을 하나라도 등록했는가.
   *
   * ★ 이 값이 화면의 **가장 중요한 빈 상태**를 가른다. "0시간"이 아니라 "아직 등록하지
   *   않았다"이며, 등록하러 가는 버튼이 함께 있어야 한다. 예전에는 이 구분이 없어
   *   화면이 조용히 비어 있었고, 그 상태에서 할 일이 무엇인지 알 방법이 없었다.
   */
  readonly viewerHasPattern: boolean;
  readonly isViewerPatternLoading: boolean;
}

/**
 * 예외는 **뺄셈 전용**이므로 문구도 "제외"로만 쓴다 (§1.4).
 * "이 시간만 가능" 같은 덧셈 표현을 쓰면 없는 기능을 있는 것처럼 말하게 된다.
 */
function describeException(exception: AvailabilityException): string {
  if (exception.startMinute === null || exception.endMinute === null) {
    return "이 날 전체 제외";
  }
  /*
    ⚠️ 끝 시각에 `describeDayMinute` 를 쓰면 1440 이 `익일 00:00` 으로 나온다. 예외는
       **하루 안에서 닫혀 있으므로**(도메인 타입) 1440 은 언제나 "그날의 끝"이고,
       편집기의 시각 선택지도 `24:00` 으로 적는다. 두 화면이 같은 값을 다르게 부르면
       사용자는 서로 다른 것으로 읽는다.
  */
  return `${formatDayMinute(exception.startMinute)}~${formatDayMinute(exception.endMinute)} 제외`;
}

export function AvailabilityPanel({
  range,
  weekOffset,
  onWeekOffsetChange,
  members,
  intervals,
  overlapWindows,
  exceptions,
  commitments,
  memberNameById,
  unscheduledNames,
  minCountChoice,
  effectiveMinCount,
  onMinCountChange,
  isLoading,
  isError,
  onRetry,
  selectedWindowKey,
  onSelectWindow,
  selectedStartsAt,
  onOpenComposer,
  partyName,
  onEditAvailability,
  viewerHasPattern,
  isViewerPatternLoading,
}: AvailabilityPanelProps) {
  const total = members.length;

  /** 선택 인원에 맞춰 필터 후보를 만든다. 전원 → N-1 → … → 2. */
  const choices = useMemo<ReadonlyArray<number | "all">>(() => {
    const list: Array<number | "all"> = ["all"];
    for (let k = total - 1; k >= 2; k -= 1) list.push(k);
    return list;
  }, [total]);

  const sortedExceptions = useMemo(
    () => [...exceptions].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    [exceptions],
  );

  /**
   * 닉네임만 등록된 사람(게스트).
   *
   * ★ **이들의 레인이 비어 있는 것은 "시간이 없다"가 아니다.** 게스트는 세션이 없어
   *   가능 시간을 스스로 넣을 방법이 자체가 없다. 그 사실을 말해 주지 않으면 사용자는
   *   "저 사람은 아무 때도 안 된다"로 읽고, 그 오해 위에서 일정을 잡는다.
   *   해결책(초대 링크)까지 한 문장에 담는다.
   */
  const guestNames = useMemo(
    () =>
      members
        .filter((member) => member.isGuest)
        .map((member) => member.displayName),
    [members],
  );

  const hasOvernight = useMemo(
    () =>
      intervals.some(
        (interval) =>
          formatKst(interval.startsAt, "yyyy-MM-dd") !==
          formatKst(interval.endsAt, "yyyy-MM-dd"),
      ),
    [intervals],
  );

  /*
    `h-full` — 옆의 「보스 일정 등록」 카드와 **높이를 맞춘다**(발주자 지시, 2026-08-18).
    그리드의 기본 `items-stretch` 가 칸을 같은 높이로 늘리고, 이 클래스가 그 높이를
    카드까지 물려준다. 최대 높이는 걸지 않는다 — 내용이 잘리면 안 되고, 안의 격자는
    이미 자기 스크롤을 갖고 있다.
  */
  return (
    <Card className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <CalendarRange aria-hidden size={18} className="text-primary" />
            <CardTitle className="text-body-lg">일정 짜기</CardTitle>
          </div>
          <p className="text-body-sm text-ink-muted">
            {partyName ? (
              <>
                <strong className="font-semibold text-ink-label">
                  {partyName}
                </strong>{" "}
                구성원의{" "}
              </>
            ) : null}
            반복 패턴에서 특이사항과{" "}
            <strong className="font-semibold text-ink-label">
              이미 등록된 일정
            </strong>
            을 뺀 결과입니다. 겹침 막대를 누르면 옆의 일정 등록에 시간이
            채워집니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onEditAvailability ? (
            <Button variant="secondary" size="sm" onClick={onEditAvailability}>
              <CalendarPlus aria-hidden size={14} />내 가능 시간 설정
            </Button>
          ) : null}
          {/*
            ── 주차 이동 (2026-08-19 발주자: *"이번주만 가능한게 불편해"*) ──────
            다음 주 보스 일정을 미리 잡는 일이 흔한데 이번 주에 갇혀 있으면 그걸 할
            자리가 없었다. `이번 주` 버튼은 지금 보고 있는 주가 이번 주면 비활성이라,
            **버튼 상태 자체가 "지금 어디를 보고 있는지"** 를 말한다.
          */}
          {onWeekOffsetChange === null ? null : (
            <div
              role="group"
              aria-label="주차 이동"
              className="flex items-center gap-1"
            >
              <Button
                variant="secondary"
                size="sm"
                aria-label="이전 주"
                onClick={() => onWeekOffsetChange(weekOffset - 1)}
              >
                <ChevronLeft aria-hidden size={14} />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={weekOffset === 0}
                onClick={() => onWeekOffsetChange(0)}
              >
                이번 주
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label="다음 주"
                onClick={() => onWeekOffsetChange(weekOffset + 1)}
              >
                <ChevronRight aria-hidden size={14} />
              </Button>
            </div>
          )}
          {/*
            ★ 라벨은 **보고 있는 주**를 가리킨다. `now` 를 그대로 넘기면 다음 주를 보면서도
              머리글은 이번 주라고 말한다 — 화면이 거짓말을 하는 자리가 된다.
          */}
          <WeekLabel date={range.from} />
        </div>
      </div>

      {/*
        ★ 가장 자주 마주치는 실패는 "남이 안 넣었다"가 아니라 **내가 안 넣었다**이다.
          그래서 겹침이 없다는 말보다 **먼저** 이 안내를 둔다 — 여기서 할 일이 하나뿐이면
          그것을 맨 위에 두는 편이 맞다. 빨강이 아니라 안내 톤인 이유는 실패가 아니기
          때문이다(§4: 빨강은 실패·취소 전용).
      */}
      {onEditAvailability && !isViewerPatternLoading && !viewerHasPattern ? (
        <section className="flex flex-col gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body-sm text-ink-label">
            <strong className="font-semibold text-ink">
              내 가능 시간이 아직 등록되지 않았습니다.
            </strong>{" "}
            요일별로 한 번만 칠해 두면 매주 그대로 적용됩니다.
          </p>
          <Button size="sm" onClick={onEditAvailability} className="shrink-0">
            <CalendarPlus aria-hidden size={14} />
            지금 등록
          </Button>
        </section>
      ) : null}

      {/*
        게스트 안내. 임박·경고가 아니라 **상태 설명**이라 주황을 쓰지 않는다 —
        주황은 임박·주의용이고(§4), 위의 "내 가능 시간 미등록" 블록과 나란히 두면
        어느 쪽이 급한지 구분되지 않는다. 문장은 잉크로 읽는다.
      */}
      {guestNames.length === 0 ? null : (
        <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
          <strong className="font-semibold">
            {guestNames.length === 1
              ? guestNames[0]
              : `${guestNames[0]} 외 ${guestNames.length - 1}명`}
          </strong>
          은(는) 닉네임만 등록되어 있어 <strong className="font-semibold">가능 시간을
          직접 넣을 수 없습니다.</strong> 위 구성원 목록의 보내기 버튼으로 초대 링크를
          주면, 그 사람이 계정을 만든 뒤부터 여기에 시간이 나타납니다.
        </p>
      )}

      {/* N명 중 k명 이상 필터 — 6인이 다 안 모여도 4명이면 가는 경우가 흔하다. */}
      <div className="flex flex-wrap items-center gap-2">
        <span id="min-count-label" className="text-body-sm text-ink-label">
          최소 인원
        </span>
        <div
          role="group"
          aria-labelledby="min-count-label"
          className="flex flex-wrap gap-1.5"
        >
          {choices.map((choice) => (
            <FilterChip
              key={String(choice)}
              selected={minCountChoice === choice}
              onClick={() => onMinCountChange(choice)}
              disabled={total === 0}
            >
              {choice === "all" ? `전원 ${total}명` : `${choice}명 이상`}
            </FilterChip>
          ))}
        </div>
      </div>

      {/*
        ── 분모에서 빠진 사람 (2026-08-19 발주자) ──────────────────────────────
        *"파티원이 게스트 혹은 시간설정을 아예 안했다면 그냥 내 시간을 겹침으로 표시하게"*

        서버가 가능 시간이 하나도 없는 사람을 겹침 계산에서 뺀다. 그 덕에 게스트가 낀
        파티에서도 화면이 쓸모를 갖지만, **말하지 않으면 `전원 3명` 이 5명 전부라는 뜻으로
        읽힌다.** 그래서 누구를 뺐는지 이름으로 적는다 — 이 한 줄이 없으면 화면이
        "그 시간에 다 된다"고 거짓말한 셈이 된다(§1.4 는 거짓 가능을 가장 비싼 실수로 본다).
      */}
      {unscheduledNames.length === 0 ? null : (
        <p className="flex items-start gap-2 rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
          <UserRoundX aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-muted" />
          <span>
            가능 시간을 등록하지 않은{" "}
            <strong className="font-semibold text-ink">
              {unscheduledNames.join(", ")}
            </strong>{" "}
            <NumericText>{`${String(unscheduledNames.length)}명`}</NumericText>은 겹침
            계산에서 뺐습니다. 이 사람들이 그 시간에 되는지는 <strong className="font-semibold text-ink">모르는 상태</strong>이며, 시간을 등록하면 바로 반영됩니다.
          </span>
        </p>
      )}

      {isError ? (
        <ErrorState
          title="가능 시간을 불러오지 못했습니다"
          description="가용시간 조회는 열람 권한 검사를 거칩니다. 잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<UserRoundX size={24} />}
          title="이 파티에 구성원이 없습니다"
          description="위에서 파티를 고르거나 구성원을 추가하면 각자의 가능 시간이 여기에 겹쳐서 표시됩니다."
        />
      ) : isLoading ? (
        <SkeletonGroup label="가능 시간을 불러오는 중">
          {[0, 1, 2, 3, 4, 5, 6].map((index) => (
            <div key={index} className="flex gap-2">
              <Skeleton className="h-14 w-14 shrink-0" />
              <Skeleton className="h-14 flex-1" />
            </div>
          ))}
        </SkeletonGroup>
      ) : (
        <div className="flex flex-col gap-3">
          {overlapWindows.length === 0 ? (
            <EmptyState
              title={`${effectiveMinCount}명 이상 겹치는 시간이 없습니다`}
              description={
                intervals.length === 0
                  ? "아직 아무도 가능 시간을 등록하지 않았습니다. 먼저 내 시간을 넣고, 파티원에게도 등록을 부탁해 보세요."
                  : commitments.length > 0
                    ? /*
                        ★ 겹침이 사라진 원인이 **이미 잡아 둔 일정**일 수 있다. 그 사실을
                          말하지 않으면 "분명 시간이 되는데 왜 없지?" 가 된다 — 아래
                          격자의 청록 블록이 그 시간을 가리킨다.
                      */
                      "이미 등록된 일정이 그 시간을 쓰고 있을 수 있습니다. 아래 격자에서 「이미 일정 있음」 블록을 확인하거나, 최소 인원을 낮춰 보세요."
                    : "최소 인원을 낮추거나 파티원 구성을 바꿔 보세요. 아래에는 각자의 가능 시간이 그대로 표시됩니다."
              }
              action={
                onEditAvailability ? (
                  <Button variant="secondary" size="sm" onClick={onEditAvailability}>
                    <CalendarPlus aria-hidden size={14} />내 가능 시간 설정
                  </Button>
                ) : undefined
              }
              className="py-6"
            />
          ) : null}

          {/*
            ── 폭에 따라 **축이 돈다** ──────────────────────────────────────
            발주 지시(2026-08-25): *"반응형때는 세로 배치로 변경해줘"*.

            좁은 화면(< md)에서는 시간이 **세로로** 흐르고 하루씩 본다. 가로축은 폭이
            모자란 순간 정보를 잃는데(360px 에서 이름이 `더…` 로 잘리고 겹침 네 덩어리가
            구분되지 않았다), 세로축은 스크롤로 이어 볼 수 있다.

            ★ 두 컴포넌트를 **동시에 마운트하지 않는다.** CSS 로 한쪽만 숨기면 보이지
              않는 격자도 계산·렌더를 다 하고, 이 화면에서 가장 무거운 것이 바로 그
              격자다. `md:hidden` / `hidden md:block` 은 DOM 을 남기므로 그 비용이
              그대로 든다 — 그래도 **CSS 로 가르는 쪽을 택했다.** 자바스크립트로
              폭을 재면 첫 렌더가 서버와 달라져 하이드레이션이 어긋나고, 그 대가가
              더 크다. 대신 안쪽 계산은 둘 다 `useMemo` 라 재렌더에서 다시 돌지 않는다.
          */}
          <div className="md:hidden">
            <OverlayDayGrid
              range={range}
              members={members}
              intervals={intervals}
              overlapWindows={overlapWindows}
              exceptions={exceptions}
              commitments={commitments}
              minCount={effectiveMinCount}
              selectedWindowKey={selectedWindowKey}
              onSelectWindow={onSelectWindow}
              selectedStartsAt={selectedStartsAt}
              onOpenComposer={onOpenComposer}
            />
          </div>

          <div className="hidden md:block">
            <OverlayGrid
              range={range}
              members={members}
              intervals={intervals}
              overlapWindows={overlapWindows}
              exceptions={exceptions}
              commitments={commitments}
              minCount={effectiveMinCount}
              selectedWindowKey={selectedWindowKey}
              onSelectWindow={onSelectWindow}
              onOpenComposer={onOpenComposer}
            />
          </div>

          <OverlayLegend
            total={total}
            minCount={effectiveMinCount}
            hasOvernight={hasOvernight}
          />

          {sortedExceptions.length > 0 ? (
            <section
              aria-label="특이사항"
              className="flex flex-col gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3"
            >
              {/*
                ⚠️ 예전 문구는 "(사유는 선택 사항입니다)" 였다. 사유를 **입력하는 곳이
                   아예 없으므로**(§1.4 — 뺄셈 전용, 사유 없음) 있지도 않은 입력을 있는
                   것처럼 말하는 문장이었다. 화면이 제공하지 않는 것을 약속하지 않는다.
              */}
              <h3 className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-chip-soon-fg">
                <TriangleAlert aria-hidden size={14} />
                특이사항 — 평소 패턴에서 아래 시간이 제외됩니다
              </h3>
              <ul className="flex flex-col gap-1">
                {sortedExceptions.map((exception) => (
                  <li
                    key={exception.id}
                    className="text-body-sm text-ink-label"
                  >
                    {/*
                      예외 날짜(`8/20 목`). 목록의 맨 앞 열이라 세로로 줄이 선다.
                      요일 한 글자는 `NumericText` 가 본문 서체로 남긴다.
                      `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다.
                    */}
                    <span className="font-semibold tabular-nums">
                      <NumericText>
                        {formatKstDayKey(exception.dayKey)}
                      </NumericText>
                    </span>
                    {" · "}
                    <span className="font-semibold">
                      {memberNameById.get(exception.personId) ?? "알 수 없음"}
                    </span>
                    {" — "}
                    {describeException(exception)}
                    {exception.note ? (
                      <span className="text-ink-muted">
                        {" · "}
                        {exception.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
