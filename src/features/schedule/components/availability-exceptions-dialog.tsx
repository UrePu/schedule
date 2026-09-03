"use client";

import { CalendarX2, Trash2 } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { NumericText, formatKstDayKey } from "@/components/domain";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  HelpHint,
  HelperText,
  Label,
  Radio,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import {
  DAY_MINUTES,
  addKstDays,
  formatDayMinute,
  kstDayKey,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
} from "@/types/domain";

import { SLOT_MINUTES } from "../lib/pattern-slots";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 제외 시간(특이사항) — **빼기 전용** (§1.4)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ 왜 별도 창인가 (2026-09-03 발주자: *"특이사항은 가능시간 설정 버튼 옆에 제외시간 입력"*)
 *   가능 시간 방식은 **2택**이 됐다(요일별 반복 / 교대 · 달력). 제외는 그 2택 어느 쪽을
 *   골랐든 **마지막에 똑같이** 빠지므로 방식과 나란히 놓을 수 없다 — 탭으로 두면 3택처럼
 *   보이고, 사람들이 "제외를 고르면 요일 패턴이 없어지나?" 를 묻게 된다.
 *
 * ★ 저장 의미도 다르다. 요일 격자는 한 주의 최종 모양을 만들고 마지막에 **저장**한다
 *   (초안 → 커밋). 제외는 한 건씩 **즉시** 등록·삭제된다. 한 화면에 섞으면 "지금 누른
 *   것이 저장된 건가?" 를 사용자가 알 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 만들지 않은 것들
 * ─────────────────────────────────────────────────────────────────────────────
 * 사유 입력 없음. 메모 없음. "대신 이 시간에 됨" 없음. 발주자가 정확히 이만큼만 요구했고,
 * 패턴이 덮지 않는 시간이 필요하면 **방식 쪽을 넓히는 것**이 답이다 (§1.4).
 * 그리고 제외의 적용은 **DB 의 `resolve_availability()`** 가 벽시계 순간 단위로 한다 —
 * "목요일 제외"는 수요일 22:00~02:00 패턴에서 넘어온 목 00:00~02:00 까지 지운다.
 * 앱에서 다시 계산하지 않는다(웹·봇이 갈라지지 않게 하는 유일한 방법).
 */

// ─────────────────────────────────────────────────────────────────────────────
// 시각 선택지 — 격자와 **같은 30분 해상도**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `<input type="time">` 을 쓰지 않은 이유: **24:00 을 입력할 수 없다.** 자정까지 제외하는
 * 것이 가장 흔한 경우인데 그 값을 표현할 방법이 없다(최대 23:59). 30분 단위 선택지는
 * 격자 해상도와도 맞아 "칠한 것과 뺀 것"이 같은 눈금 위에 놓인다.
 */
const START_OPTIONS: readonly number[] = Array.from(
  { length: DAY_MINUTES / SLOT_MINUTES },
  (_, index) => index * SLOT_MINUTES,
);
const END_OPTIONS: readonly number[] = START_OPTIONS.map(
  (minute) => minute + SLOT_MINUTES,
);

/** 제외를 등록할 수 있는 앞쪽 창(주). 그보다 먼 휴가는 그때 가서 넣는 편이 정확하다. */
const EXCEPTION_HORIZON_DAYS = 56;

export interface AvailabilityExceptionsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 서버가 정한 기준 시각. 날짜 하한(오늘)을 여기서 뽑는다. */
  readonly now: Date;

  readonly exceptions: readonly AvailabilityException[];
  readonly isExceptionsLoading: boolean;
  readonly isExceptionsError: boolean;
  readonly onExceptionsRetry: () => void;
  readonly onAddException: (input: AvailabilityExceptionInput) => void;
  readonly onDeleteException: (exceptionId: string) => void;
  readonly isAddingException: boolean;
  readonly deletingExceptionId: string | null;
  readonly exceptionError: Error | null;
}

export function AvailabilityExceptionsDialog({
  open,
  onClose,
  now,
  exceptions,
  isExceptionsLoading,
  isExceptionsError,
  onExceptionsRetry,
  onAddException,
  onDeleteException,
  isAddingException,
  deletingExceptionId,
  exceptionError,
}: AvailabilityExceptionsDialogProps) {
  const todayKey = kstDayKey(now);
  const horizonKey = kstDayKey(
    addKstDays(kstMoment(todayKey, 0), EXCEPTION_HORIZON_DAYS),
  );

  const dateId = useId();
  const scopeName = useId();
  const startId = useId();
  const endId = useId();

  const [exceptionDay, setExceptionDay] = useState(todayKey);
  const [wholeDay, setWholeDay] = useState(true);
  const [exceptionStart, setExceptionStart] = useState(20 * 60);
  const [exceptionEnd, setExceptionEnd] = useState(DAY_MINUTES);

  const exceptionRangeInvalid = !wholeDay && exceptionEnd <= exceptionStart;
  const canAddException =
    exceptionDay !== "" && !exceptionRangeInvalid && !isAddingException;

  const handleAddException = useCallback(() => {
    onAddException({
      dayKey: exceptionDay,
      startMinute: wholeDay ? null : exceptionStart,
      endMinute: wholeDay ? null : exceptionEnd,
    });
  }, [exceptionDay, exceptionEnd, exceptionStart, onAddException, wholeDay]);

  const sortedExceptions = useMemo(
    () =>
      [...exceptions].sort(
        (a, b) =>
          a.dayKey.localeCompare(b.dayKey) ||
          (a.startMinute ?? 0) - (b.startMinute ?? 0),
      ),
    [exceptions],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="제외 시간"
      description="특정 날짜만 안 될 때 빼세요. 어떤 방식을 쓰든 마지막에 빠집니다."
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-1.5 text-body-sm text-ink-muted">
          <span>
            평소 가능 시간에서 <strong className="font-semibold">빼기만</strong>{" "}
            합니다. 사유는 적지 않습니다.
          </span>
          <HelpHint label="제외 시간 도움말">
            하루를 통째로 빼면 그날 KST 에 속한{" "}
            <strong className="font-semibold">모든 순간</strong>이 빠집니다 — 전날
            밤에서 넘어온 새벽 시간도 함께 빠집니다.
          </HelpHint>
        </p>

        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={dateId}>날짜</Label>
            <input
              id={dateId}
              type="date"
              value={exceptionDay}
              min={todayKey}
              max={horizonKey}
              onChange={(event) => setExceptionDay(event.target.value)}
              className={cn(
                "h-control-md w-full rounded-md border border-border bg-surface px-3 py-2",
                "text-body-sm text-ink transition duration-200 outline-none",
                "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
              )}
            />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-label text-ink-label">제외 범위</legend>
            <Radio
              name={scopeName}
              checked={wholeDay}
              onChange={() => setWholeDay(true)}
              label="이 날 전체"
            />
            <Radio
              name={scopeName}
              checked={!wholeDay}
              onChange={() => setWholeDay(false)}
              label="시간대 지정"
            />
          </fieldset>

          {!wholeDay ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={startId}>시작</Label>
                <select
                  id={startId}
                  value={exceptionStart}
                  onChange={(event) =>
                    setExceptionStart(Number.parseInt(event.target.value, 10))
                  }
                  className={cn(
                    "h-control-md w-full rounded-md border border-border bg-surface px-2",
                    "text-body-sm text-ink transition duration-200 outline-none",
                    "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                  )}
                >
                  {START_OPTIONS.map((minute) => (
                    <option key={minute} value={minute}>
                      {formatDayMinute(minute)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={endId}>끝</Label>
                <select
                  id={endId}
                  value={exceptionEnd}
                  onChange={(event) =>
                    setExceptionEnd(Number.parseInt(event.target.value, 10))
                  }
                  className={cn(
                    "h-control-md w-full rounded-md border bg-surface px-2",
                    "text-body-sm text-ink transition duration-200 outline-none",
                    "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                    exceptionRangeInvalid ? "border-error" : "border-border",
                  )}
                >
                  {END_OPTIONS.map((minute) => (
                    <option key={minute} value={minute}>
                      {formatDayMinute(minute)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {exceptionRangeInvalid ? (
            <HelperText tone="error">
              끝 시각이 시작보다 빨라야 합니다.
            </HelperText>
          ) : (
            <HelperText>
              자정을 넘겨 빼려면 다음 날에도 한 건 더 등록해 주세요. 그래야
              &ldquo;그 날짜는 안 된다&rdquo;는 말과 저장된 뜻이 정확히
              같아집니다.
            </HelperText>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleAddException}
              disabled={!canAddException}
            >
              {isAddingException ? "등록 중…" : "제외 시간 추가"}
            </Button>
          </div>
        </div>

        {exceptionError ? (
          <ErrorState
            title="제외 시간을 처리하지 못했습니다"
            detail={exceptionError.message}
            className="py-6"
          />
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink-label">
            등록된 제외 시간 (앞으로 8주)
          </h3>

          {isExceptionsError ? (
            <ErrorState
              title="제외 시간을 불러오지 못했습니다"
              onRetry={onExceptionsRetry}
              className="py-6"
            />
          ) : isExceptionsLoading ? (
            <SkeletonGroup label="제외 시간을 불러오는 중">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </SkeletonGroup>
          ) : sortedExceptions.length === 0 ? (
            <EmptyState
              icon={<CalendarX2 size={24} />}
              title="아직 등록한 제외 시간이 없습니다"
              description="야근·여행처럼 평소 패턴이 통하지 않는 날만 위에서 빼 두면 됩니다."
              className="py-6"
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {sortedExceptions.map((exception) => (
                <li
                  key={exception.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
                >
                  <span className="min-w-0 text-body-sm text-ink">
                    <strong className="font-semibold">
                      <NumericText>
                        {formatKstDayKey(exception.dayKey)}
                      </NumericText>
                    </strong>{" "}
                    {exception.startMinute === null ||
                    exception.endMinute === null
                      ? "이 날 전체 제외"
                      : /* 1440 은 `익일 00:00` 이 아니라 `24:00` — 위 선택지와 같은 말이어야 한다. */
                        `${formatDayMinute(exception.startMinute)}~${formatDayMinute(exception.endMinute)} 제외`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${formatKstDayKey(exception.dayKey)} 제외 시간 삭제`}
                    onClick={() => onDeleteException(exception.id)}
                    disabled={deletingExceptionId === exception.id}
                  >
                    <Trash2 aria-hidden size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
