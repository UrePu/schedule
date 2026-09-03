"use client";

import { Eraser, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { NumericText } from "@/components/domain";
import {
  Button,
  Dialog,
  ErrorState,
  HelpHint,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { describeDayMinute } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  AvailabilityMode,
  AvailabilityPattern,
  AvailabilityPatternInput,
} from "@/types/domain";

import { BANDS, type Band, bandForEarliestSlot, resolveBand } from "../lib/grid-bands";
import {
  SLOT_COUNT,
  describeInterval,
  patternColumn,
  patternsToSlots,
  slotSetsEqual,
  slotsToPatterns,
  splitByGridFit,
  validatePatterns,
} from "../lib/pattern-slots";
import { ShiftWorkPanel } from "./shift-work-panel";
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
 * ★ 방식은 **2택이고, 한 번에 하나만 열린다** (2026-09-03 발주자 지시)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 이 창이 탭 셋(요일별 반복 / 교대 · 달력 / 특이사항)이었고, 앞의 둘이 **동시에
 * 살아 있었다.** 그래서 계산이 소리 없이 섞였다 — 실측으로 토요일 요일 패턴 14:00~23:30
 * 이 통째로 지워지고 달력의 15:00~24:00 이 대신 적용됐는데 어느 쪽이 이겼는지 화면
 * 어디에도 없었다. 이제 방식은 **여는 순간 이미 정해져 있고**(`AvailabilityModeDialog`),
 * 이 창은 고른 쪽 하나만 그린다. 제목이 어느 방식인지 말하고, `방식 바꾸기` 로 돌아간다.
 *
 * 셋째 탭이던 **제외 시간**은 `AvailabilityExceptionsDialog` 로 나갔다. 제외는 두 방식
 * 어느 쪽을 골랐든 마지막에 똑같이 빠지므로 방식과 나란히 두면 3택처럼 읽힌다.
 */

export interface AvailabilityEditorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 서버가 정한 기준 시각. 교대 패널의 기준일·달력 첫 달을 여기서 뽑는다. */
  readonly now: Date;
  /**
   * 지금 쓰는 방식. **이 값이 무엇을 그릴지 전부 정한다** — 둘을 함께 그리지 않는다.
   * 고르는 일은 부모(방식 선택 모달)가 이미 끝냈다.
   */
  readonly mode: AvailabilityMode;
  /** `방식 바꾸기` — 이 창을 닫고 방식 선택 모달을 다시 연다. 갇히지 않게 하는 길이다. */
  readonly onChangeMode: () => void;
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
}

export function AvailabilityEditorDialog({
  open,
  onClose,
  now,
  mode,
  onChangeMode,
  columns,
  patterns,
  isPatternsLoading,
  isPatternsError,
  onPatternsRetry,
  onSavePatterns,
  isSavingPatterns,
  savePatternsError,
}: AvailabilityEditorDialogProps) {
  // ── 패턴 초안 ────────────────────────────────────────────────────────────
  /*
    ★ 이 격자는 **요일축만** 다룬다. 주기축 행은 `ShiftWorkPanel` 이 그리므로 여기서는
      걸러 낸다 — 섞어서 그리면 같은 격자에 뜻이 다른 두 축이 겹쳐 그려지고, 저장할 때
      반대쪽 축을 덮어쓴다.
  */
  const weekdayPatterns = useMemo(
    () => patterns.filter((pattern) => pattern.weekday !== null),
    [patterns],
  );
  const { editable, preserved } = useMemo(
    () => splitByGridFit(weekdayPatterns),
    [weekdayPatterns],
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
    () => weekdayPatterns.map((pattern) => pattern.id).sort().join(","),
    [weekdayPatterns],
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

  const bandGroupId = useId();

  const weekdayLabel = useCallback(
    (weekday: number) =>
      columns.find((column) => column.value === weekday)?.label ?? String(weekday),
    [columns],
  );

  /** 목록에서 한 구간 지우기 — 마우스 없이도 되돌릴 수 있어야 한다. */
  const removeInterval = useCallback(
    (target: AvailabilityPatternInput) => {
      const remaining = draft.filter(
        (interval) =>
          !(
            patternColumn(interval) === patternColumn(target) &&
            interval.startMinute === target.startMinute &&
            interval.endMinute === target.endMinute
          ),
      );
      setSlots(patternsToSlots(remaining));
    },
    [draft],
  );

  const activeBand = resolveBand(band);

  const canSavePatterns =
    dirty && violations.length === 0 && !isSavingPatterns && !isPatternsLoading;

  const handleSavePatterns = useCallback(() => {
    // 격자로 표현할 수 없는 줄(30분 격자에 안 맞거나 30:00 을 넘는 구간)은 **손대지 않고**
    // 그대로 돌려보낸다. 편집기에 안 보인다는 이유로 남의 데이터를 지우지 않는다.
    onSavePatterns([
      ...draft,
      ...preserved.map((pattern) => ({
        weekday: pattern.weekday,
        cycleDay: pattern.cycleDay,
        startMinute: pattern.startMinute,
        endMinute: pattern.endMinute,
      })),
    ]);
  }, [draft, onSavePatterns, preserved]);

  /*
    교대 · 달력 쪽에서 보여 줄 보존 안내의 조건. 저장된 요일축 패턴이 하나라도 있을 때만
    말한다 — 남아 있는 것이 없는데 "남아 있습니다" 라고 하면 그 문장이 거짓이 된다.
  */
  const hasWeekdayPatterns = weekdayPatterns.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        mode === "weekly"
          ? "내 가능 시간 — 요일별 반복"
          : "내 가능 시간 — 교대 · 달력"
      }
      description={
        mode === "weekly"
          ? "가능한 시간을 요일 격자에 칠하면 매주 그대로 적용됩니다."
          : "근무 주기 격자와 날짜별 지정으로 가능한 시간을 정합니다."
      }
      footer={
        mode === "weekly" ? (
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
              {/* 돌아갈 길. 이것이 없으면 방식을 잘못 고른 사람이 갇힌다. */}
              <Button variant="ghost" size="sm" onClick={onChangeMode}>
                방식 바꾸기
              </Button>
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
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onChangeMode}>
              방식 바꾸기
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              닫기
            </Button>
          </div>
        )
      }
    >
      {/*
        ★ 닫혀 있으면 **내용을 아예 마운트하지 않는다** (2026-09-03 결함 수정).
          `Dialog` 는 네이티브 `<dialog>` 라 `open=false` 여도 children 을 그대로
          렌더한다. 그래서 교대 방식을 고른 뒤 이 창을 닫아도 `ShiftWorkPanel` 이
          살아남아 주기·프리셋·배정 세 조회를 계속 들고 있었고, `availability.root()`
          무효화가 일어날 때마다 **보이지도 않는 화면을 위해** 다시 조회했다.
          `Dialog` 자체는 계속 마운트한다 — 언마운트하면 `dialog.close()` 가 불리지
          않아 포커스 복귀가 깨진다. 껍데기는 남기고 안쪽만 비운다.
      */}
      {!open ? null : (
        <div className="flex flex-col gap-4">
          {mode === "shift" ? (
            <div className="flex flex-col gap-4">
              {hasWeekdayPatterns ? (
                /*
                  보존 안내다. **경고가 아니므로 주황을 쓰지 않는다** (§4) — "지워졌나?" 를
                  가라앉히는 것이 목적인데 주황을 쓰면 오히려 그 걱정을 키운다.
                */
                <p className="text-body-sm text-ink-muted">
                  요일별 반복에 등록해 둔 시간은 그대로 남아 있으며, 방식을
                  되돌리면 다시 쓰입니다.
                </p>
              ) : null}
              <ShiftWorkPanel now={now} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/*
                ★ **상시 노출은 한 문장이다** (2026-08-20 발주자: *"설명문접고 ? 달아서
                  호버링으로 바꿔봐"*). 조작법·자정 넘김·저장 단위는 처음 한 번만 필요한
                  내용이라 `?` 뒤로 접었다. 지운 것이 아니라 접은 것이고, 키보드·터치에서도
                  열린다(`HelpHint` 머리말).
              */}
              <p className="flex items-center gap-1.5 text-body-sm text-ink-muted">
                <span>
                  가능한 시간을 <strong className="font-semibold">끌어서</strong>{" "}
                  칠하세요. 다시 끌면 지워집니다.
                </span>
                <HelpHint label="가능 시간 격자 도움말">
                  <span className="flex flex-col gap-1.5">
                    <span>
                      키보드: 화살표로 이동 · Space 로 칠하기 시작 · Shift+화살표로 구간
                      넓히기.
                    </span>
                    <span>
                      24:00 아래는 <strong className="font-semibold">익일</strong>입니다.
                      수요일 22:00 에서 익일 02:00 까지 이어 칠하면 끊기지 않은 한 구간으로
                      저장됩니다.
                    </span>
                    <span>
                      저장 단위는 30분입니다. 휴대폰에서는 왼쪽 시간 눈금을 끌어
                      스크롤하세요.
                    </span>
                  </span>
                </HelpHint>
              </p>

              {/* 보이는 시간대 */}
              <div className="flex flex-wrap items-center gap-2">
                <span id={bandGroupId} className="text-body-sm text-ink-label">
                  보이는 시간대
                </span>
                <div
                  role="group"
                  aria-labelledby={bandGroupId}
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
                    axis="weekday"
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
                        key={`${violation.column}-${violation.startMinute}`}
                        className="text-body-sm text-ink-label"
                      >
                        {weekdayLabel(violation.column)}요일{" "}
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
                        key={`${patternColumn(interval)}-${interval.startMinute}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
                      >
                        <span className="min-w-0 text-body-sm text-ink">
                          <strong className="font-semibold">
                            {weekdayLabel(patternColumn(interval))}
                          </strong>{" "}
                          <NumericText>{describeInterval(interval)}</NumericText>
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${weekdayLabel(patternColumn(interval))}요일 ${describeInterval(interval)} 구간 지우기`}
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
          )}
        </div>
      )}
    </Dialog>
  );
}
