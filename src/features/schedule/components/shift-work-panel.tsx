"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import {
  Button,
  ErrorState,
  HelpHint,
  Label,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import {
  DAY_MINUTES,
  addKstDays,
  describeDayMinute,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { AvailabilityCycle, DaySelection } from "@/types/domain";

import {
  clearMyAvailabilityCycle,
  fetchMyAvailabilityCycle,
  fetchMyAvailabilityPatterns,
  fetchMyShifts,
  mutateMyShifts,
  saveMyAvailabilityCycle,
  saveMyAvailabilityPatterns,
  type ShiftMutationInput,
} from "../data/schedule-queries";
import {
  BANDS,
  type Band,
  bandForEarliestSlot,
  resolveBand,
} from "../lib/grid-bands";
import {
  MAX_CYCLE_DAYS,
  SLOT_COUNT,
  cycleAxis,
  patternsToSlots,
  slotSetsEqual,
  slotsToPatterns,
  splitByGridFit,
} from "../lib/pattern-slots";
import { WeeklyPatternGrid, type PatternGridColumn } from "./weekly-pattern-grid";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 교대 · 달력 — N일 주기 패턴(A) · 날짜별 가능 시간 선택(B)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-20): *"내 가능시간에 2교대 3교대 하는사람도 등록할수있게"*
 *
 * 요일 패턴으로는 교대를 적을 수 없다. 교대는 **요일이 아니라 N일 주기**로 돌기 때문이다
 * (주주야야비비 6일 · 4조 3교대 8일 · 격주 14일). 그래서 두 가지를 함께 둔다.
 *
 *   A. **N일 주기 패턴** — 규칙적으로 도는 사람. 칸마다 가능한 시간을 한 번 칠하면 끝난다.
 *   B. **가능 시간 달력** — 근무표가 매달 따로 나오는 사람. 그 날 가능한 시간대를 찍는다.
 *
 * 둘은 배타가 아니다. A로 기본 순환을 깔고, 흔들리는 날만 B로 덮을 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ B 는 **뺄셈이 아니라 선택이다** (2026-08-20 발주자: *"가능시간선택으로 바꿔"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 "근무시간을 빼는" 모델이었다. 그런데 교대는 근무만 도는 게 아니라 **자는 시간도
 * 같이 돈다** — 야간 근무 다음 날 오전은 근무가 아닌데 자고 있어서 못 한다. 뺄셈 모델은
 * 사용자에게 자기 하루를 통째로 설명하라고 요구했고(근무 + 수면), 하나만 빠뜨리면 자는
 * 시간이 "가능" 으로 남았다. §1.4 가 가장 비싸다고 못박은 거짓 "가능" 이다.
 *
 * 선택 모델은 그 설명을 요구하지 않는다. "이 날은 20시~24시 가능" 한 마디면 끝이고,
 * 말하지 않은 시간은 그냥 가능하지 않다. 세 상태뿐이다:
 *   평소대로(지정 없음) · 종일 안 됨 · 이 시간대만 가능.
 * 계산은 DB 한 곳이 한다(`resolve_availability` · 마이그레이션 35).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 이 패널은 자기 조회를 스스로 갖는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 주기·프리셋·배정은 요일 격자와 쓰는 데이터가 다르고, 부모를 거쳐 프롭으로
 * 내리면 편집기 프롭이 열 개 넘게 늘어난다. 키가 같으면 TanStack 이 요청을 합쳐 주므로
 * 부모가 같은 것을 또 읽어도 왕복은 한 번이다(§2.4 규칙 1 — 조각의 주인은 캐시다).
 *
 * ★ 무효화는 언제나 `availability.root()` 하나다. 주기가 바뀌면 같은 패턴 행이 **다른
 *   날짜에** 붙고, 근무를 찍으면 겹쳐보기·겹침 질의의 답이 함께 바뀐다.
 */

/** 달력에 한 번에 보여 줄 달의 개수. 근무표는 보통 한 달 단위로 나온다. */
const CALENDAR_WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

interface MonthGrid {
  readonly monthKey: string;
  readonly title: string;
  readonly from: string;
  readonly to: string;
  readonly weeks: readonly (readonly (string | null)[])[];
}

/**
 * 달력 격자(월요일 시작). 발주자가 수익 달력에서 고른 것과 같은 시작 요일이다 —
 * 한 앱 안에서 달력의 시작 요일이 화면마다 다르면 그 자체가 오독의 원인이 된다.
 */
function buildMonthGrid(monthKey: string): MonthGrid {
  const [year, month] = monthKey.split("-").map((part) => Number.parseInt(part, 10));
  const first = kstMoment(`${monthKey}-01`, 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // ISO 요일 1(월) … 7(일) → 앞에 비는 칸 수.
  const lead = kstIsoWeekday(first) - 1;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 0; day < daysInMonth; day += 1) {
    cells.push(kstDayKey(addKstDays(first, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  return {
    monthKey,
    title: `${String(year)}년 ${String(month)}월`,
    from: `${monthKey}-01`,
    to: kstDayKey(addKstDays(first, daysInMonth - 1)),
    weeks,
  };
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map((part) => Number.parseInt(part, 10));
  const index = (year * 12 + (month - 1)) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return `${String(nextYear)}-${String(nextMonth).padStart(2, "0")}`;
}

/** 시각 선택지 — 격자와 같은 30분 눈금. 자정 넘김(익일 06:00)까지 고른다. */
const TIME_OPTIONS: readonly number[] = Array.from(
  { length: (DAY_MINUTES + 6 * 60) / 30 + 1 },
  (_, index) => index * 30,
);

export interface ShiftWorkPanelProps {
  /** 서버가 정한 기준 시각. 기준일 기본값과 달력의 첫 달을 여기서 뽑는다. */
  readonly now: Date;
}

export function ShiftWorkPanel({ now }: ShiftWorkPanelProps) {
  const queryClient = useQueryClient();
  const todayKey = kstDayKey(now);
  const [monthKey, setMonthKey] = useState(() => todayKey.slice(0, 7));
  const month = useMemo(() => buildMonthGrid(monthKey), [monthKey]);

  const cycleQuery = useQuery({
    queryKey: queryKeys.db.availability.myCycle(),
    queryFn: fetchMyAvailabilityCycle,
    staleTime: 60_000,
  });
  const patternsQuery = useQuery({
    queryKey: queryKeys.db.availability.myPatterns(),
    queryFn: fetchMyAvailabilityPatterns,
    staleTime: 60_000,
  });
  const shiftsQuery = useQuery({
    queryKey: queryKeys.db.availability.myShifts(month.from, month.to),
    queryFn: () => fetchMyShifts(month.from, month.to),
    staleTime: 60_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.db.availability.root(),
    });
  }, [queryClient]);

  // ── A. 주기 ──────────────────────────────────────────────────────────────
  const cycle = cycleQuery.data ?? null;
  /**
   * 주기가 **확실히** 없다 — 조회가 끝났고 행이 없는 상태. 로딩·에러 중에는 단정하지
   * 않는다(모르는 것을 "없다" 로 말하는 순간 그게 곧 거짓말이 된다).
   *
   * ★ 이 값이 아래 달력의 **문구를 바꾼다.** 교대 · 달력 방식에서 "평소 패턴" 은
   *   주기 격자뿐이고(마이그레이션 36 — 요일축은 읽지 않는다), 주기가 없으면 평소가
   *   아예 **존재하지 않는다.** 그때 「평소대로」는 정상 시간으로 되돌린다는 뜻이 아니라
   *   그 날을 **완전 불가**로 만든다 — 이름과 결과가 정반대였다. 이름을 사실에 맞춘다.
   */
  const hasNoCycle = cycleQuery.isSuccess && cycle === null;
  const cycleDaysId = useId();
  const anchorId = useId();
  const [draftDays, setDraftDays] = useState(6);
  const [draftAnchor, setDraftAnchor] = useState(todayKey);

  const saveCycle = useMutation({
    mutationFn: (input: AvailabilityCycle) => saveMyAvailabilityCycle(input),
    onSuccess: invalidate,
  });
  const dropCycle = useMutation({
    mutationFn: clearMyAvailabilityCycle,
    onSuccess: invalidate,
  });

  /*
    주기축 격자. 열은 주기 칸이며 **표시 순서 = 데이터 순서**다 — 요일과 달리 회전할
    기준(주간 초기화)이 없다. 라벨은 사람이 세는 방식대로 1번부터 붙이고, 저장되는
    번호는 0부터다. 그 어긋남은 여기 한 줄에만 있다.
  */
  const cycleColumns: readonly PatternGridColumn[] = useMemo(
    () =>
      cycle === null
        ? []
        : Array.from({ length: cycle.cycleDays }, (_, index) => ({
            value: index,
            label: `${String(index + 1)}번`,
            isWeekend: false,
          })),
    [cycle],
  );

  const cyclePatterns = useMemo(
    () =>
      (patternsQuery.data ?? []).filter((pattern) => pattern.cycleDay !== null),
    [patternsQuery.data],
  );
  const { editable: cycleEditable, preserved: cyclePreserved } = useMemo(
    () => splitByGridFit(cyclePatterns),
    [cyclePatterns],
  );
  const savedCycleSlots = useMemo(
    () => patternsToSlots(cycleEditable),
    [cycleEditable],
  );
  const [cycleSlots, setCycleSlots] = useState<ReadonlySet<string>>(savedCycleSlots);
  /*
    ★ **보이는 시간대는 요일 격자와 같은 밴드를 쓴다** (2026-09-03 결함 수정).
      예전에는 `firstSlot={16}`(08:00)이 손으로 박혀 있어 00:00~08:00 을 아예 칠할 수도
      볼 수도 없었다. 교대 근무자에게 새벽은 핵심 구간이고, 게다가 24:00 이후에 칠한 칸은
      저장할 때 다음 칸의 00:00~ 으로 정규화되는데 그 자리가 숨어 있어 **저장한 것이
      사라진 것처럼 보였다.** 초기값은 이미 칠해진 가장 이른 칸을 담는 밴드다.
  */
  const [cycleBandId, setCycleBandId] = useState<Band["id"]>(() =>
    bandForEarliestSlot(savedCycleSlots),
  );
  const cycleBandGroupId = useId();

  /* 서버 값이 늦게 오거나 저장으로 갱신되면 초안을 다시 맞춘다(요일 격자와 같은 규칙). */
  const cycleSignature = useMemo(
    () => cyclePatterns.map((pattern) => pattern.id).sort().join(","),
    [cyclePatterns],
  );
  const [loadedCycleSignature, setLoadedCycleSignature] = useState(cycleSignature);
  if (loadedCycleSignature !== cycleSignature) {
    setLoadedCycleSignature(cycleSignature);
    setCycleSlots(savedCycleSlots);
    setCycleBandId(bandForEarliestSlot(savedCycleSlots));
  }
  const cycleBand = resolveBand(cycleBandId);

  const cycleDirty = !slotSetsEqual(cycleSlots, savedCycleSlots);
  const saveCyclePatterns = useMutation({
    mutationFn: () => {
      const axis = cycleAxis(cycle?.cycleDays ?? 1);
      return saveMyAvailabilityPatterns(
        [
          ...slotsToPatterns(cycleSlots, axis),
          // 격자로 표현할 수 없는 줄은 손대지 않고 그대로 돌려보낸다.
          ...cyclePreserved.map((pattern) => ({
            weekday: null,
            cycleDay: pattern.cycleDay,
            startMinute: pattern.startMinute,
            endMinute: pattern.endMinute,
          })),
        ],
        "cycle",
      );
    },
    onSuccess: invalidate,
  });

  // ── B. 가능 시간 달력 ────────────────────────────────────────────────────
  const presets = shiftsQuery.data?.presets ?? [];
  /*
    날짜 → 그 날의 지정. **`null` 과 "없음" 이 다르다**:
      · 맵에 없음   → 평소 패턴 그대로
      · 값이 `null` → 그 날은 종일 불가
      · 값이 id     → 그 날은 그 시간대만 가능
    배열 기본값을 밖에 두면 매 렌더 새 배열이라 useMemo 가 무의미해진다. 안에서 푼다.
  */
  const assignedBy = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const assignment of shiftsQuery.data?.assignments ?? []) {
      map.set(assignment.workDate, assignment.presetId);
    }
    return map;
  }, [shiftsQuery.data]);

  /** 지금 달력에 칠할 것. `DaySelection` 세 갈래를 그대로 쥔다. */
  const [brush, setBrush] = useState<DaySelection>({ kind: "clear" });
  const nameId = useId();
  const startId = useId();
  const endId = useId();
  const [presetName, setPresetName] = useState("");
  /* 기본값은 흔한 저녁 보스 시간대다 — 근무시간이 아니라 **노는 시간**을 적는 칸이다. */
  const [presetStart, setPresetStart] = useState(20 * 60);
  const [presetEnd, setPresetEnd] = useState(24 * 60);

  const shiftMutation = useMutation({
    mutationFn: (input: ShiftMutationInput) => mutateMyShifts(input),
    onSuccess: invalidate,
  });

  const range = useMemo(
    () => ({ from: month.from, to: month.to }),
    [month.from, month.to],
  );

  const paintDay = useCallback(
    (dayKey: string) => {
      /*
        같은 것을 다시 누르면 **평소대로**로 돌아간다 — 잘못 찍었을 때 되돌리는 길이 늘
        있어야 한다. 맵에 키가 있는지부터 본다: 값이 `null`(종일 불가)인 것과 지정이
        아예 없는 것은 다른 상태다.
      */
      const assigned = assignedBy.has(dayKey);
      const current = assignedBy.get(dayKey) ?? null;
      const same =
        assigned &&
        (brush.kind === "blocked"
          ? current === null
          : brush.kind === "preset" && current === brush.presetId);

      shiftMutation.mutate({
        action: "assign",
        dayKeys: [dayKey],
        selection: same ? { kind: "clear" } : brush,
        range,
      });
    },
    [assignedBy, brush, range, shiftMutation],
  );

  const trimmedName = presetName.trim();
  const canAddPreset =
    trimmedName.length > 0 &&
    presetEnd > presetStart &&
    presetEnd - presetStart <= DAY_MINUTES &&
    !shiftMutation.isPending;

  return (
    <div className="flex flex-col gap-5">
      {/* ── A. 주기 ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
            교대 주기
            <HelpHint label="교대 주기 도움말">
              <span className="flex flex-col gap-1.5">
                <span>
                  주기 길이는 근무가 같은 모양으로 도는 간격입니다. 주주야야비비는 6일,
                  4조 3교대는 8일, 격주는 14일입니다.
                </span>
                <span>
                  이 방식(교대 · 달력)에서는 아래 주기 격자와 날짜별 지정만 쓰입니다.
                  요일별 반복에 등록해 둔 시간은 지워지지 않으므로, 방식을 되돌리면
                  그대로 다시 쓰입니다.
                </span>
              </span>
            </HelpHint>
          </h3>
          <p className="text-body-sm text-ink-muted">
            근무가 <strong className="font-semibold">며칠마다</strong> 같은 모양으로
            도는지 정합니다.
          </p>
        </div>

        {cycleQuery.isError ? (
          <ErrorState
            title="교대 주기를 불러오지 못했습니다"
            description="지금 저장하면 기존 값을 덮어쓸 수 있어 편집을 막았습니다."
            onRetry={() => void cycleQuery.refetch()}
            className="py-4"
          />
        ) : cycleQuery.isLoading ? (
          <SkeletonGroup label="교대 주기를 불러오는 중">
            <Skeleton className="h-10" />
          </SkeletonGroup>
        ) : cycle === null ? (
          <div className="flex flex-col gap-3">
            {/*
              ★ **주기가 없으면 달력에 찍은 날 말고는 전부 0** 이다 (마이그레이션 36).
                36 이전에는 주기가 꺼져 있어도 요일 패턴이 쓰였기 때문에 이 상태가
                위험하지 않았다 — 지금은 이 방식에서 요일 패턴을 **아예 읽지 않으므로**
                주기 없음 = 달력에 찍지 않은 모든 날이 불가다. 정작 덜 위험한 "주기는
                켰는데 격자가 빔" 에는 경고가 있었는데 더 위험한 이쪽에는 없었다.
                경고는 tertiary orange — 면과 아이콘이 주황, 문장은 잉크다 (§4).
            */}
            <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3 text-body-sm text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-chip-soon-fg"
              />
              <span>
                <strong className="font-semibold">
                  지금은 아래 달력에 찍은 날만 가능합니다.
                </strong>{" "}
                주기를 켜지 않으면 찍지 않은 날은 가능한 시간이 없는 것으로
                계산됩니다. 매주 같은 요일에 논다면 아래 <strong className="font-semibold">방식 바꾸기</strong>로{" "}
                <strong className="font-semibold">요일별 반복</strong>으로
                되돌리는 편이 맞습니다.
              </span>
            </p>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={cycleDaysId}>주기(일)</Label>
                <input
                  id={cycleDaysId}
                  type="number"
                  min={2}
                  max={MAX_CYCLE_DAYS}
                  value={draftDays}
                  onChange={(event) =>
                    setDraftDays(Number.parseInt(event.target.value, 10) || 2)
                  }
                  className="h-control-md w-24 rounded-md border border-border bg-surface px-3 text-body-sm text-ink outline-none focus:border-primary focus:ring-[3px] focus:ring-focus-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={anchorId}>이 날이 1번 칸</Label>
                <input
                  id={anchorId}
                  type="date"
                  value={draftAnchor}
                  onChange={(event) => setDraftAnchor(event.target.value)}
                  className="h-control-md rounded-md border border-border bg-surface px-3 text-body-sm text-ink outline-none focus:border-primary focus:ring-[3px] focus:ring-focus-ring"
                />
              </div>
              <Button
                size="sm"
                onClick={() =>
                  saveCycle.mutate({
                    cycleDays: Math.min(Math.max(draftDays, 2), MAX_CYCLE_DAYS),
                    anchorDate: draftAnchor,
                  })
                }
                disabled={saveCycle.isPending || draftAnchor === ""}
              >
                {saveCycle.isPending ? "켜는 중…" : "주기 켜기"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-body-sm text-ink">
                <strong className="font-semibold">{cycle.cycleDays}일 주기</strong>
                {" · "}
                {cycle.anchorDate} 이 1번 칸
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dropCycle.mutate()}
                disabled={dropCycle.isPending}
              >
                주기 끄기
              </Button>
            </div>

            {/*
              ⚠️ `patternsQuery.isError` 를 함께 본다. 조회가 실패하면 `savedCycleSlots`
                 도 빈 집합이라, 그대로 두면 **불러오지 못한 것**을 "아직 아무것도 칠하지
                 않았다" 로 단정해 버린다 — 화면이 없는 사실을 말하는 자리가 된다.
            */}
            {savedCycleSlots.size === 0 && !cycleDirty && !patternsQuery.isError ? (
              /* 경고는 tertiary orange — 면과 아이콘이 주황, 문장은 잉크다 (§4). */
              <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg p-3 text-body-sm text-ink">
                아직 주기 격자에 아무것도 칠하지 않아{" "}
                <strong className="font-semibold">가능한 시간이 없는 상태</strong>입니다.
                아래에서 칸마다 가능한 시간을 칠하고 저장해 주세요.
              </p>
            ) : null}

            {/* 보이는 시간대 — 요일 격자와 같은 밴드(`lib/grid-bands`). */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                id={cycleBandGroupId}
                className="text-body-sm text-ink-label"
              >
                보이는 시간대
              </span>
              <div
                role="group"
                aria-labelledby={cycleBandGroupId}
                className="flex flex-wrap gap-1.5"
              >
                {BANDS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={cycleBandId === entry.id}
                    onClick={() => setCycleBandId(entry.id)}
                    className={cn(
                      "h-control-sm rounded-full border px-3 text-body-sm font-medium transition duration-200",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      cycleBandId === entry.id
                        ? "border-primary bg-primary-subtle text-primary"
                        : "border-border bg-surface text-ink-muted hover:text-ink",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>

            {/*
              ★ **에러면 편집 자체를 막는다** — 요일 격자와 같은 보호다
                (`availability-editor-dialog.tsx` 의 `isPatternsError` 분기).
                조회가 실패하면 `savedCycleSlots` 가 빈 집합으로 그려지고, 한 칸만
                칠해도 `cycleDirty` 가 참이 되어 저장이 열린다. 그 저장은 주기축 행을
                **전부 지우고** 방금 칠한 것만 남긴다 — `cyclePreserved` 도 빈 배열이라
                격자 밖 구간까지 함께 사라진다. 문구·재시도 동선을 요일 격자와 똑같이
                맞춰 둔다(같은 사고를 두 화면이 다르게 설명하면 안 된다).
            */}
            {patternsQuery.isError ? (
              <ErrorState
                title="주기 격자를 불러오지 못했습니다"
                description="지금 저장하면 기존 값을 덮어쓸 수 있어 편집을 막았습니다. 다시 시도해 주세요."
                onRetry={() => void patternsQuery.refetch()}
                className="py-4"
              />
            ) : patternsQuery.isLoading ? (
              <SkeletonGroup label="주기 격자를 불러오는 중">
                <Skeleton className="h-48" />
              </SkeletonGroup>
            ) : (
              <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border">
                <WeeklyPatternGrid
                  columns={cycleColumns}
                  selected={cycleSlots}
                  onChange={setCycleSlots}
                  firstSlot={cycleBand.firstSlot}
                  lastSlot={SLOT_COUNT - 1}
                  disabled={saveCyclePatterns.isPending}
                  axis="cycle"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <p
                aria-live="polite"
                className={cn(
                  "mr-auto text-body-sm",
                  cycleDirty ? "font-semibold text-ink" : "text-ink-muted",
                )}
              >
                {cycleDirty
                  ? "저장하지 않은 변경이 있습니다."
                  : "저장된 상태와 같습니다."}
              </p>
              {/*
                조회 실패 중에는 둘 다 막는다. 저장은 남의 행을 지우고, 되돌리기는
                "빈 집합" 이라는 **틀린 기준값**으로 초안을 되돌린다.
              */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCycleSlots(savedCycleSlots)}
                disabled={
                  !cycleDirty ||
                  saveCyclePatterns.isPending ||
                  patternsQuery.isError
                }
              >
                되돌리기
              </Button>
              <Button
                size="sm"
                onClick={() => saveCyclePatterns.mutate()}
                disabled={
                  !cycleDirty ||
                  saveCyclePatterns.isPending ||
                  patternsQuery.isError
                }
              >
                {saveCyclePatterns.isPending ? "저장 중…" : "주기 격자 저장"}
              </Button>
            </div>

            {saveCyclePatterns.isError ? (
              <ErrorState
                title="저장하지 못했습니다"
                description="칠한 내용은 그대로 남아 있습니다. 다시 저장해 주세요."
                detail={saveCyclePatterns.error.message}
                className="py-4"
              />
            ) : null}
          </div>
        )}
      </section>

      {/* ── B. 가능 시간 달력 ─────────────────────────────────────────── */}
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
            가능 시간 달력
            <HelpHint label="가능 시간 달력 도움말">
              <span className="flex flex-col gap-1.5">
                <span>
                  근무·수면을 설명할 필요가 없습니다. 되는 시간만 고르면 되고, 고르지 않은
                  시간은 그냥 되지 않습니다.
                </span>
                {/*
                  ⚠️ 예전 문구는 **거짓이었다**: *"지정한 날은 그 날에 걸린 평소 패턴을
                     통째로 대체합니다"*. 이 방식에서 평소 패턴은 주기 격자뿐인데,
                     주기를 켜지 않은 사람에게는 대체될 평소가 없다. 그 사람이 지정을
                     지우면 정상 시간으로 돌아가는 게 아니라 그 날이 **완전 불가**가 된다.
                */}
                <span>
                  같은 것을 다시 누르면 그 날의 지정이 지워집니다. 지정한 날은 그 날에
                  걸린 주기 격자를 통째로 대체합니다 — 전날 밤에서 넘어온 새벽 시간도
                  함께 사라집니다.
                </span>
                <span>
                  <strong className="font-semibold">
                    주기를 켜지 않았다면 지정을 지운 날은 가능한 시간이 없습니다.
                  </strong>{" "}
                  되돌릴 평소 패턴이 없기 때문입니다(요일별 반복은 이 방식에서 읽지
                  않습니다).
                </span>
                <span>근무표가 매달 따로 나오는 경우에 쓰면 좋습니다.</span>
              </span>
            </HelpHint>
          </h3>
          <p className="text-body-sm text-ink-muted">
            달력에 시간대를 찍으면{" "}
            <strong className="font-semibold">그 날은 그 시간만 가능</strong>해집니다.
          </p>
        </div>

        {/* 칠할 것 — 평소대로 · 종일 안 됨 · 시간대들 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={brush.kind === "clear"}
            onClick={() => setBrush({ kind: "clear" })}
            className={cn(
              "h-control-sm rounded-full border px-3 text-body-sm font-medium transition duration-200",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              brush.kind === "clear"
                ? "border-primary bg-primary-subtle text-primary"
                : "border-border bg-surface text-ink-muted hover:text-ink",
            )}
          >
            <Eraser aria-hidden size={13} className="mr-1 inline align-[-2px]" />
            {/*
              ★ 주기가 없으면 「평소대로」가 **거짓말**이다 — 돌아갈 평소가 없고, 결과는
                그 날이 완전 불가가 되는 것이다. 그럴 때는 이 브러시가 실제로 하는 일
                그대로 「지정 지우기」로 읽히게 한다. 라벨 하나로 뜻이 갈리므로 설명은
                위 도움말이 함께 맡는다.
            */}
            {hasNoCycle ? "지정 지우기" : "평소대로"}
          </button>
          <button
            type="button"
            aria-pressed={brush.kind === "blocked"}
            onClick={() => setBrush({ kind: "blocked" })}
            className={cn(
              "h-control-sm rounded-full border px-3 text-body-sm font-medium transition duration-200",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              brush.kind === "blocked"
                ? "border-primary bg-primary-subtle text-primary"
                : "border-border bg-surface text-ink-muted hover:text-ink",
            )}
          >
            <Ban aria-hidden size={13} className="mr-1 inline align-[-2px]" />
            종일 안 됨
          </button>
          {presets.map((preset) => (
            <span key={preset.id} className="inline-flex items-center">
              <button
                type="button"
                aria-pressed={
                  brush.kind === "preset" && brush.presetId === preset.id
                }
                onClick={() => setBrush({ kind: "preset", presetId: preset.id })}
                className={cn(
                  "h-control-sm rounded-l-full border px-3 text-body-sm font-medium transition duration-200",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  brush.kind === "preset" && brush.presetId === preset.id
                    ? "border-primary bg-primary-subtle text-primary"
                    : "border-border bg-surface text-ink-muted hover:text-ink",
                )}
              >
                {preset.name}{" "}
                {/*
                  ★ 시간은 **읽으라고 적는 숫자**다. `ink-placeholder` 는 자리표시자
                    전용이라 여기서는 대비 미달(2.3:1)이었다 — 숫자 주석은 `ink-muted`
                    아래로 내려가지 않는다 (§4 가독성 규칙).
                */}
                <span className="text-caption text-ink-muted">
                  {describeDayMinute(preset.startMinute)}~
                  {describeDayMinute(preset.endMinute)}
                </span>
              </button>
              <button
                type="button"
                aria-label={`${preset.name} 시간대 삭제`}
                onClick={() =>
                  shiftMutation.mutate({
                    action: "deletePreset",
                    presetId: preset.id,
                    range,
                  })
                }
                disabled={shiftMutation.isPending}
                className="h-control-sm rounded-r-full border border-l-0 border-border bg-surface px-2 text-ink-muted transition duration-200 hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Trash2 aria-hidden size={13} />
              </button>
            </span>
          ))}
        </div>

        {/* 시간대 추가 */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-background p-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={nameId}>시간대 이름</Label>
            <input
              id={nameId}
              value={presetName}
              maxLength={12}
              placeholder="야간근무날"
              onChange={(event) => setPresetName(event.target.value)}
              className="h-control-md w-28 rounded-md border border-border bg-surface px-3 text-body-sm text-ink outline-none placeholder:text-ink-placeholder focus:border-primary focus:ring-[3px] focus:ring-focus-ring"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={startId}>가능 시작</Label>
            <select
              id={startId}
              value={presetStart}
              onChange={(event) =>
                setPresetStart(Number.parseInt(event.target.value, 10))
              }
              className="h-control-md rounded-md border border-border bg-surface px-2 text-body-sm text-ink outline-none focus:border-primary focus:ring-[3px] focus:ring-focus-ring"
            >
              {TIME_OPTIONS.filter((minute) => minute < DAY_MINUTES).map((minute) => (
                <option key={minute} value={minute}>
                  {describeDayMinute(minute)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={endId}>가능 끝</Label>
            <select
              id={endId}
              value={presetEnd}
              onChange={(event) =>
                setPresetEnd(Number.parseInt(event.target.value, 10))
              }
              className="h-control-md rounded-md border border-border bg-surface px-2 text-body-sm text-ink outline-none focus:border-primary focus:ring-[3px] focus:ring-focus-ring"
            >
              {TIME_OPTIONS.filter((minute) => minute > 0).map((minute) => (
                <option key={minute} value={minute}>
                  {describeDayMinute(minute)}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            onClick={() => {
              shiftMutation.mutate({
                action: "createPreset",
                preset: {
                  name: trimmedName,
                  startMinute: presetStart,
                  endMinute: presetEnd,
                },
                range,
              });
              setPresetName("");
            }}
            disabled={!canAddPreset}
          >
            <Plus aria-hidden size={14} />
            시간대 추가
          </Button>
        </div>

        {shiftMutation.isError ? (
          <ErrorState
            title="가능 시간을 저장하지 못했습니다"
            description="잠시 후 다시 시도해 주세요."
            detail={shiftMutation.error.message}
            className="py-4"
          />
        ) : null}

        {/* 달력 */}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="이전 달"
            onClick={() => setMonthKey(shiftMonthKey(monthKey, -1))}
          >
            <ChevronLeft aria-hidden size={16} />
          </Button>
          <p className="text-body-sm font-semibold text-ink">{month.title}</p>
          <Button
            variant="ghost"
            size="sm"
            aria-label="다음 달"
            onClick={() => setMonthKey(shiftMonthKey(monthKey, 1))}
          >
            <ChevronRight aria-hidden size={16} />
          </Button>
        </div>

        {shiftsQuery.isError ? (
          <ErrorState
            title="가능 시간 지정을 불러오지 못했습니다"
            description="잠시 후 다시 시도해 주세요."
            onRetry={() => void shiftsQuery.refetch()}
            className="py-4"
          />
        ) : shiftsQuery.isLoading ? (
          <SkeletonGroup label="가능 시간 지정을 불러오는 중">
            <Skeleton className="h-56" />
          </SkeletonGroup>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {CALENDAR_WEEKDAY_LABELS.map((label) => (
              <div
                key={label}
                className="pb-1 text-center text-caption text-ink-muted"
              >
                {label}
              </div>
            ))}
            {month.weeks.flat().map((dayKey, index) => {
              if (dayKey === null) {
                return <div key={`empty-${String(index)}`} aria-hidden />;
              }
              /*
                세 상태를 **여기서 한 번에** 가른다. `has` 를 먼저 보는 것이 중요하다 —
                지정이 없는 날(평소대로)과 종일 안 되는 날은 둘 다 preset 이 없지만
                뜻이 정반대다.
              */
              const assigned = assignedBy.has(dayKey);
              const presetId = assignedBy.get(dayKey) ?? null;
              const preset = presets.find((entry) => entry.id === presetId) ?? null;
              const blocked = assigned && preset === null;
              const isToday = dayKey === todayKey;

              return (
                <button
                  key={dayKey}
                  type="button"
                  onClick={() => paintDay(dayKey)}
                  disabled={shiftMutation.isPending}
                  /*
                    ★ 브러시 라벨과 **같은 규칙**을 여기에도 적용한다(§0.2 — 하나 고칠 때
                      같은 곳을 전부 찾아 함께 고친다). 주기가 없으면 지정이 없는 날은
                      "평소대로" 가 아니라 **가능한 시간이 없는 날**이다. 화면 글자만
                      고치고 스크린리더에는 옛 거짓말을 남겨 둘 수 없다.
                  */
                  aria-label={`${dayKey} ${
                    blocked
                      ? "종일 안 됨"
                      : preset === null
                        ? hasNoCycle
                          ? "지정 없음 — 가능한 시간 없음"
                          : "평소대로"
                        : `${preset.name} ${describeDayMinute(preset.startMinute)}부터 ${describeDayMinute(preset.endMinute)}까지 가능`
                  }`}
                  className={cn(
                    "flex min-h-[3.25rem] flex-col items-start gap-0.5 rounded-md border p-1.5 text-left transition duration-200",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    /*
                      ★ 색이 뜻을 나른다. 시간대가 있으면 primary(가능), 종일 안 되는 날은
                        중립 회색 면 — **빨강은 쓰지 않는다.** §4 가 빨강을 실패·취소로
                        묶어 뒀고, "그날 약속이 있다"는 실패가 아니다.
                    */
                    /*
                      ⚠️ 안 되는 날은 **가라앉힌다**(`bg-background`). 예전에는 `hover-strong`
                        을 썼는데, 같은 버튼 안에서 시간대 이름(`text-primary`)이 그 면 위에
                        올 수 있어 다크에서 4.27:1 로 미달이었다(`pnpm contrast`). 배경을
                        낮추면 대비도 살고, "이 날은 비활성" 이라는 뜻도 함께 읽힌다.
                    */
                    blocked
                      ? "border-border bg-background"
                      : preset === null
                        ? "border-border bg-surface hover:bg-hover-surface"
                        : "border-primary bg-primary-subtle",
                    isToday && "ring-1 ring-primary",
                  )}
                >
                  <span className="text-caption text-ink-muted tabular-nums">
                    {Number.parseInt(dayKey.slice(8), 10)}
                  </span>
                  {blocked ? (
                    <span className="truncate text-caption font-semibold text-ink-muted">
                      안 됨
                    </span>
                  ) : preset === null ? null : (
                    <>
                      <span className="truncate text-caption font-semibold text-primary">
                        {preset.name}
                      </span>
                      {/*
                        이름만으로는 "그래서 몇 시?" 를 못 읽는다. 달력 한 칸에서 시간을
                        확인할 수 있어야 칩 목록을 왕복하지 않는다.
                      */}
                      <span className="truncate text-caption text-ink-muted tabular-nums">
                        {describeDayMinute(preset.startMinute)}~
                        {describeDayMinute(preset.endMinute)}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {presets.length === 0 ? (
          <p className="text-body-sm text-ink-muted">
            먼저 위에서 시간대를 하나 만들면 달력에 찍을 수 있습니다.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/*
 * ⚠️ `useMyAvailabilityCycle` 은 **삭제됐다** (2026-09-03). 요일 격자가 "지금 주기를 쓰는
 *    중" 을 알아야 했던 이유는 두 방식이 동시에 살아 있었기 때문인데, 이제 방식이 배타라
 *    (마이그레이션 36) 요일 격자는 애초에 `mode === "weekly"` 일 때만 그려진다.
 *    주기 상태를 물어볼 이유 자체가 사라졌다.
 */
