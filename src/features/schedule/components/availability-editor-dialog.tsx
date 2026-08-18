"use client";

import { CalendarX2, Eraser, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { NumericText, formatKstDayKey } from "@/components/domain";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Label,
  Radio,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import {
  DAY_MINUTES,
  addKstDays,
  describeDayMinute,
  formatDayMinute,
  kstDayKey,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityPattern,
  AvailabilityPatternInput,
  IsoWeekday,
} from "@/types/domain";

import {
  SLOT_COUNT,
  SLOT_MINUTES,
  describeInterval,
  patternsToSlots,
  slotSetsEqual,
  slotsToPatterns,
  splitByGridFit,
  validatePatterns,
} from "../lib/pattern-slots";
import {
  WeeklyPatternGrid,
  type PatternGridColumn,
} from "./weekly-pattern-grid";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 내 가능 시간 편집기 (§1.4) — 이 앱이 작동하기 위한 **입력 쪽**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 겹쳐보기 화면은 오래도록 **읽기만** 있었다. 넣는 곳이 없으니 모두의 시간표가 비어
 * 있었고, 앱의 1순위 가치(§1.2)가 통째로 작동하지 않았다. 이 다이얼로그가 그 구멍이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 층을 **탭으로 가른다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 저장 의미가 다르기 때문이다.
 *   · **요일별 반복 패턴** — 한 주의 최종 모양을 만들고 마지막에 **저장**한다(초안 → 커밋).
 *   · **특이사항(제외)**   — 한 건씩 **즉시** 등록·삭제된다.
 * 한 화면에 섞으면 "지금 누른 것이 저장된 건가?"를 사용자가 알 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 특이사항은 **빼기 전용이다** — 만들지 않은 것들
 * ─────────────────────────────────────────────────────────────────────────────
 * 사유 입력 없음. 메모 없음. "대신 이 시간에 됨" 없음. 발주자가 정확히 이만큼만 요구했고,
 * 패턴이 덮지 않는 시간이 필요하면 **패턴을 넓히는 것**이 답이다 (§1.4).
 * 그리고 제외의 적용은 **DB 의 `resolve_availability()`** 가 벽시계 순간 단위로 한다 —
 * "목요일 제외"는 수요일 22:00~02:00 패턴에서 넘어온 목 00:00~02:00 까지 지운다.
 * 앱에서 다시 계산하지 않는다(웹·봇이 갈라지지 않게 하는 유일한 방법).
 */

// ─────────────────────────────────────────────────────────────────────────────
// 세로 구간(밴드) — 60칸을 늘 다 보여 줄 필요는 없다
// ─────────────────────────────────────────────────────────────────────────────

interface Band {
  readonly id: "evening" | "day" | "all";
  readonly label: string;
  readonly firstSlot: number;
}

/**
 * 밴드는 **보이는 범위**일 뿐 데이터가 아니다. 밴드 밖에 칠해진 칸은 상태에 그대로
 * 남아 있고 저장에도 포함된다 — 안 보인다고 지워지면 그게 가장 나쁜 사고다.
 * 그래서 편집기를 열 때 **이미 칠해진 가장 이른 칸을 담는 밴드로 자동 확장**한다.
 */
const BANDS: readonly Band[] = [
  { id: "evening", label: "저녁 18시~", firstSlot: 18 * 2 },
  { id: "day", label: "낮 08시~", firstSlot: 8 * 2 },
  { id: "all", label: "하루 전체", firstSlot: 0 },
];

function bandForEarliestSlot(slots: ReadonlySet<string>): Band["id"] {
  let earliest = SLOT_COUNT;
  for (const key of slots) {
    const slot = Number.parseInt(key.slice(key.indexOf(":") + 1), 10);
    if (Number.isInteger(slot) && slot < earliest) earliest = slot;
  }
  if (earliest >= 18 * 2) return "evening";
  if (earliest >= 8 * 2) return "day";
  return "all";
}

// ─────────────────────────────────────────────────────────────────────────────
// 특이사항 시각 선택지 — 격자와 **같은 30분 해상도**
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

/** 특이사항을 등록할 수 있는 앞쪽 창(주). 그보다 먼 휴가는 그때 가서 넣는 편이 정확하다. */
const EXCEPTION_HORIZON_DAYS = 56;

export interface AvailabilityEditorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 서버가 정한 기준 시각. 날짜 하한(오늘)을 여기서 뽑는다. */
  readonly now: Date;
  /** 겹쳐보기와 **같은 요일 순서**. 주간 초기화 기준으로 회전해서 넘어온다. */
  readonly columns: readonly PatternGridColumn[];

  readonly patterns: readonly AvailabilityPattern[];
  readonly isPatternsLoading: boolean;
  readonly isPatternsError: boolean;
  readonly onPatternsRetry: () => void;
  readonly onSavePatterns: (
    patterns: readonly AvailabilityPatternInput[],
  ) => void;
  readonly isSavingPatterns: boolean;
  readonly savePatternsError: Error | null;

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

type Tab = "pattern" | "exception";

export function AvailabilityEditorDialog({
  open,
  onClose,
  now,
  columns,
  patterns,
  isPatternsLoading,
  isPatternsError,
  onPatternsRetry,
  onSavePatterns,
  isSavingPatterns,
  savePatternsError,
  exceptions,
  isExceptionsLoading,
  isExceptionsError,
  onExceptionsRetry,
  onAddException,
  onDeleteException,
  isAddingException,
  deletingExceptionId,
  exceptionError,
}: AvailabilityEditorDialogProps) {
  const [tab, setTab] = useState<Tab>("pattern");

  // ── 패턴 초안 ────────────────────────────────────────────────────────────
  const { editable, preserved } = useMemo(
    () => splitByGridFit(patterns),
    [patterns],
  );

  const savedSlots = useMemo(() => patternsToSlots(editable), [editable]);

  const [slots, setSlots] = useState<ReadonlySet<string>>(savedSlots);
  const [band, setBand] = useState<Band["id"]>(() =>
    bandForEarliestSlot(savedSlots),
  );

  /**
   * 서버 값이 늦게 도착하거나(첫 조회) 저장 후 갱신되면 초안을 다시 맞춘다.
   *
   * 렌더 중 상태 조정은 React 가 권장하는 "prop 변화에 맞춰 상태 조정" 패턴이다.
   * `id` 목록을 서명으로 쓰므로 **내용이 같으면 다시 맞추지 않는다**(사용자가 편집 중일 때
   * 재조회가 초안을 날리지 않는다). 저장하면 행이 통째로 새로 만들어져 서명이 바뀌고,
   * 그때는 저장된 모양으로 정확히 수렴한다.
   */
  const signature = useMemo(
    () => [...patterns].map((pattern) => pattern.id).sort().join(","),
    [patterns],
  );
  const [loadedSignature, setLoadedSignature] = useState(signature);
  if (loadedSignature !== signature) {
    setLoadedSignature(signature);
    setSlots(savedSlots);
    setBand(bandForEarliestSlot(savedSlots));
  }

  const dirty = !slotSetsEqual(slots, savedSlots);
  const draft = useMemo(() => slotsToPatterns(slots), [slots]);
  const violations = useMemo(() => validatePatterns(draft), [draft]);

  const weekdayLabel = useCallback(
    (weekday: IsoWeekday) =>
      columns.find((column) => column.isoWeekday === weekday)?.label ??
      String(weekday),
    [columns],
  );

  /** 목록에서 한 구간 지우기 — 마우스 없이도 되돌릴 수 있어야 한다. */
  const removeInterval = useCallback(
    (target: AvailabilityPatternInput) => {
      const remaining = draft.filter(
        (interval) =>
          !(
            interval.weekday === target.weekday &&
            interval.startMinute === target.startMinute &&
            interval.endMinute === target.endMinute
          ),
      );
      setSlots(patternsToSlots(remaining));
    },
    [draft],
  );

  const activeBand = BANDS.find((entry) => entry.id === band) ?? BANDS[0];

  const canSavePatterns =
    dirty && violations.length === 0 && !isSavingPatterns && !isPatternsLoading;

  const handleSavePatterns = useCallback(() => {
    // 격자로 표현할 수 없는 줄(30분 격자에 안 맞거나 30:00 을 넘는 구간)은 **손대지 않고**
    // 그대로 돌려보낸다. 편집기에 안 보인다는 이유로 남의 데이터를 지우지 않는다.
    onSavePatterns([
      ...draft,
      ...preserved.map((pattern) => ({
        weekday: pattern.weekday,
        startMinute: pattern.startMinute,
        endMinute: pattern.endMinute,
      })),
    ]);
  }, [draft, onSavePatterns, preserved]);

  // ── 특이사항 폼 ──────────────────────────────────────────────────────────
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
      title="내 가능 시간 설정"
      description="한 번 등록하면 매주 그대로 적용됩니다. 특정 날짜만 안 될 때는 특이사항으로 빼세요."
      footer={
        tab === "pattern" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p
              aria-live="polite"
              className={cn(
                "text-body-sm",
                dirty ? "font-semibold text-ink" : "text-ink-muted",
              )}
            >
              {dirty
                ? "저장하지 않은 변경이 있습니다."
                : "저장된 상태와 같습니다."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSlots(savedSlots)}
                disabled={!dirty || isSavingPatterns}
              >
                <RotateCcw aria-hidden size={14} />
                되돌리기
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                닫기
              </Button>
              <Button
                size="sm"
                onClick={handleSavePatterns}
                disabled={!canSavePatterns}
              >
                {isSavingPatterns ? "저장 중…" : "저장"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              닫기
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/* 탭 */}
        <div
          role="tablist"
          aria-label="가능 시간 편집 방식"
          className="flex gap-1 rounded-md bg-neutral-100 p-1"
        >
          {(
            [
              { id: "pattern", label: "요일별 반복 패턴" },
              { id: "exception", label: "특이사항(제외)" },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 text-body-sm font-semibold transition duration-200",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                /* 활성 탭에는 hover 가 없었다 — 이미 열린 탭인지 눌리는지 구분이 안 됐다. */
                tab === entry.id
                  ? "bg-surface text-primary shadow-subtle hover:bg-primary-subtle"
                  : "text-ink-muted hover:bg-hover-strong hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === "pattern" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-body-sm text-ink-muted">
                가능한 시간을 <strong className="font-semibold">끌어서</strong>{" "}
                칠하세요. 칠한 칸을 다시 끌면 지워집니다. 키보드는 화살표로
                이동, <kbd className="font-mono">Space</kbd> 로 칠하기 시작,{" "}
                <kbd className="font-mono">Shift</kbd>+화살표로 구간을
                넓힙니다.
              </p>
              <p className="text-body-sm text-ink-muted">
                <strong className="font-semibold text-tertiary">24:00</strong>{" "}
                아래는 <strong className="font-semibold">익일</strong>입니다.
                수요일 22:00 에서 익일 02:00 까지 이어 칠하면 끊기지 않은{" "}
                <strong className="font-semibold">한 구간</strong>으로
                저장됩니다. 저장 단위는 30분입니다. 휴대폰에서는 왼쪽 시간 눈금을
                끌어 스크롤하세요.
              </p>
            </div>

            {/* 보이는 시간대 */}
            <div className="flex flex-wrap items-center gap-2">
              <span id={`${scopeName}-band`} className="text-body-sm text-ink-label">
                보이는 시간대
              </span>
              <div
                role="group"
                aria-labelledby={`${scopeName}-band`}
                className="flex flex-wrap gap-1.5"
              >
                {BANDS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={band === entry.id}
                    onClick={() => setBand(entry.id)}
                    className={cn(
                      "h-control-sm rounded-full border px-3 text-body-sm font-medium transition duration-200",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      band === entry.id
                        ? "border-primary bg-primary-subtle text-primary"
                        : "border-border bg-surface text-ink-muted hover:text-ink",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>

            {isPatternsError ? (
              <ErrorState
                title="내 가능 시간을 불러오지 못했습니다"
                description="지금 저장하면 기존 값을 덮어쓸 수 있어 편집을 막았습니다. 다시 시도해 주세요."
                onRetry={onPatternsRetry}
                className="py-6"
              />
            ) : isPatternsLoading ? (
              <SkeletonGroup label="내 가능 시간을 불러오는 중">
                <Skeleton className="h-64" />
              </SkeletonGroup>
            ) : (
              <div className="max-h-[52vh] overflow-y-auto rounded-md border border-border">
                <WeeklyPatternGrid
                  columns={columns}
                  selected={slots}
                  onChange={setSlots}
                  firstSlot={activeBand.firstSlot}
                  lastSlot={SLOT_COUNT - 1}
                  disabled={isSavingPatterns}
                />
              </div>
            )}

            {violations.length > 0 ? (
              /* 경고는 tertiary orange — 면과 아이콘이 주황, 문장은 잉크다 (§4). */
              <section className="flex flex-col gap-1 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3">
                <h3 className="text-body-sm font-semibold text-chip-soon-fg">
                  저장할 수 없는 구간이 있습니다
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {violations.map((violation) => (
                    <li
                      key={`${violation.weekday}-${violation.startMinute}`}
                      className="text-body-sm text-ink-label"
                    >
                      {weekdayLabel(violation.weekday)}요일{" "}
                      {describeDayMinute(violation.startMinute)}~
                      {describeDayMinute(violation.endMinute)} — {violation.reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* 칠한 결과를 문장으로 — 그리고 지우는 두 번째 경로. */}
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-body-sm font-semibold text-ink-label">
                  등록될 시간 {draft.length}구간
                </h3>
                {slots.size > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSlots(new Set())}
                    disabled={isSavingPatterns}
                  >
                    <Eraser aria-hidden size={14} />
                    전부 지우기
                  </Button>
                ) : null}
              </div>

              {draft.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-surface px-3 py-4 text-center text-body-sm text-ink-muted">
                  아직 칠한 시간이 없습니다. 위 격자에서 가능한 시간을 끌어
                  칠해 주세요.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {draft.map((interval) => (
                    <li
                      key={`${interval.weekday}-${interval.startMinute}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
                    >
                      <span className="min-w-0 text-body-sm text-ink">
                        <strong className="font-semibold">
                          {weekdayLabel(interval.weekday)}
                        </strong>{" "}
                        <NumericText>{describeInterval(interval)}</NumericText>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${weekdayLabel(interval.weekday)}요일 ${describeInterval(interval)} 구간 지우기`}
                        onClick={() => removeInterval(interval)}
                        disabled={isSavingPatterns}
                      >
                        <Trash2 aria-hidden size={14} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {preserved.length > 0 ? (
                <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink-muted">
                  이 격자로 표현할 수 없는 구간 {preserved.length}개(30분 눈금에
                  맞지 않거나 익일 06:00 을 넘김)는 그대로 유지됩니다.
                </p>
              ) : null}
            </section>

            {savePatternsError ? (
              <ErrorState
                title="저장하지 못했습니다"
                description="칠한 내용은 그대로 남아 있습니다. 다시 저장해 주세요."
                detail={savePatternsError.message}
                className="py-6"
              />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-body-sm text-ink-muted">
              평소 패턴에서 <strong className="font-semibold">빼기만</strong>{" "}
              합니다. 사유는 적지 않습니다. 하루를 통째로 빼면 그날 KST 에 속한{" "}
              <strong className="font-semibold">모든 순간</strong>이 빠집니다 —
              전날 밤에서 넘어온 새벽 시간도 함께 빠집니다.
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
                  {isAddingException ? "등록 중…" : "특이사항 추가"}
                </Button>
              </div>
            </div>

            {exceptionError ? (
              <ErrorState
                title="특이사항을 처리하지 못했습니다"
                detail={exceptionError.message}
                className="py-6"
              />
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-body-sm font-semibold text-ink-label">
                등록된 특이사항 (앞으로 8주)
              </h3>

              {isExceptionsError ? (
                <ErrorState
                  title="특이사항을 불러오지 못했습니다"
                  onRetry={onExceptionsRetry}
                  className="py-6"
                />
              ) : isExceptionsLoading ? (
                <SkeletonGroup label="특이사항을 불러오는 중">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </SkeletonGroup>
              ) : sortedExceptions.length === 0 ? (
                <EmptyState
                  icon={<CalendarX2 size={24} />}
                  title="아직 등록한 특이사항이 없습니다"
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
                        aria-label={`${formatKstDayKey(exception.dayKey)} 특이사항 삭제`}
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
        )}
      </div>
    </Dialog>
  );
}
