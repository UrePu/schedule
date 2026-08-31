import { kstWeekdayKo } from "@/components/domain/kst-format";
import {
  DAY_MINUTES,
  addKstDays,
  kstDayKey,
  kstIsoWeekday,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import type { TimeRange } from "@/types/domain";

/**
 * 겹쳐보기 시간표의 **좌표 계산**. 순수 함수만 두고 렌더는 컴포넌트가 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자정 넘김을 끊지 않기 위한 좌표계 (이 파일의 존재 이유)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 행 = 하루(목→수 7행), 가로축 = 그날 00:00 KST 로부터의 **분**.
 *
 * 핵심은 축을 1440 에서 끊지 않는다는 것이다. 22:00~02:00 구간은
 * `1320 → 1560` 이라는 **하나의 사각형**으로 그려지고, 축에는 `24:00`, `27:00`
 * 같은 눈금이 계속 이어진다. 하루를 24시간에서 자르면 이 구간은 두 행으로
 * 쪼개져 "밤 10시부터 새벽 2시까지"라는 한 덩어리가 화면에서 사라진다
 * (DB 가 굳이 `end_minute > 1440` 을 허용한 이유와 같다 — DB-SCHEMA §10-2).
 *
 * 구간은 **시작 시각이 속한 KST 날짜의 행**에 통째로 배치된다. 그래서 금요일 새벽
 * 02:00 까지 이어지는 구간은 "목요일 행의 오른쪽 끝"에 나타난다 — 사람들이
 * "목요일 밤"이라고 말하는 것과 같은 배치다.
 *
 * 축의 시작/끝은 **그 주에 실제로 등장하는 구간에 맞춰 좁힌다.** 아무도 새벽 4시에
 * 안 하는데 00:00~24:00 을 다 그리면 저녁 시간대가 눈금 몇 픽셀로 뭉갠다.
 */

/** 눈금 간격(분). 3시간마다 축 라벨을 찍는다. */
const TICK_MINUTES = 180;

/** 축이 아무리 좁아도 최소 이만큼은 보여 준다(6시간). */
const MIN_AXIS_SPAN = 360;

export interface DayRow {
  readonly dayKey: string;
  /** ISO 요일 1=월 … 7=일 */
  readonly isoWeekday: number;
  /** 예) `8/13 목` — aria-label·title 처럼 한 덩어리로 읽어야 할 때. */
  readonly label: string;
  /**
   * 예) `목` — **행에서 가장 먼저 읽혀야 하는 값**이다.
   * 스케줄 화면에서 사람은 "며칠"보다 "무슨 요일"로 먼저 생각한다.
   */
  readonly weekdayLabel: string;
  /** 예) `8/13` */
  readonly dateLabel: string;
  readonly isWeekend: boolean;
  /** 이 행의 00:00 KST 절대 시각. */
  readonly dayStart: Date;
}

/** 조회 구간을 하루짜리 행으로 자른다. 주간 범위면 목→수 7행이 나온다. */
export function buildDayRows(range: TimeRange): readonly DayRow[] {
  const rows: DayRow[] = [];
  const lastKey = kstDayKey(new Date(range.to.getTime() - 1));

  let cursor = kstMoment(kstDayKey(range.from), 0);
  for (let guard = 0; guard < 62; guard += 1) {
    const dayKey = kstDayKey(cursor);
    const isoWeekday = kstIsoWeekday(kstMoment(dayKey, 720));
    const weekdayLabel = kstWeekdayKo(cursor);
    const dateLabel = formatKst(cursor, "M/d");
    rows.push({
      dayKey,
      isoWeekday,
      label: `${dateLabel} ${weekdayLabel}`,
      weekdayLabel,
      dateLabel,
      isWeekend: isoWeekday === 6 || isoWeekday === 7,
      dayStart: cursor,
    });
    if (dayKey >= lastKey) break;
    cursor = addKstDays(cursor, 1);
  }

  return rows;
}

export interface RowSegment<T> {
  readonly key: string;
  readonly dayKey: string;
  /** 그날 00:00 KST 기준 분. **1440 을 넘을 수 있다**(자정 넘김). */
  readonly startMinute: number;
  readonly endMinute: number;
  readonly datum: T;
}

interface Instantish {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * 절대 시각 구간을 "시작 날짜 행 + 그날 00:00 기준 분" 좌표로 옮긴다.
 * 구간은 **쪼개지 않는다.** 자정을 넘으면 `endMinute` 가 1440 을 넘을 뿐이다.
 */
export function projectToDayRows<T extends Instantish>(
  items: readonly T[],
  dayKeys: ReadonlySet<string>,
  keyOf: (item: T, index: number) => string,
): readonly RowSegment<T>[] {
  const segments: Array<RowSegment<T>> = [];

  items.forEach((item, index) => {
    const dayKey = kstDayKey(item.startsAt);
    if (!dayKeys.has(dayKey)) return;

    segments.push({
      key: keyOf(item, index),
      dayKey,
      startMinute: minutesFromKstDay(item.startsAt, dayKey),
      endMinute: minutesFromKstDay(item.endsAt, dayKey),
      datum: item,
    });
  });

  return segments;
}

export interface OverlayAxis {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly ticks: readonly number[];
  /** 축이 24:00 을 넘는가 = 자정 넘김 구간이 존재하는가. */
  readonly hasOvernight: boolean;
}

/** 기본 축(18:00~24:00). 표시할 구간이 하나도 없을 때 쓴다. */
const FALLBACK_AXIS: OverlayAxis = {
  startMinute: 18 * 60,
  endMinute: DAY_MINUTES,
  ticks: [18 * 60, 21 * 60, DAY_MINUTES],
  hasOvernight: false,
};

/**
 * 실제로 그려질 구간들에 맞춰 가로축 범위를 정한다.
 *
 * 축은 **모든 행이 공유**한다. 행마다 축이 다르면 세로로 비교할 수 없고,
 * 겹침을 한눈에 본다는 목적 자체가 무너진다.
 */
export function computeOverlayAxis(
  segments: ReadonlyArray<{
    readonly startMinute: number;
    readonly endMinute: number;
  }>,
): OverlayAxis {
  if (segments.length === 0) return FALLBACK_AXIS;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    min = Math.min(min, segment.startMinute);
    max = Math.max(max, segment.endMinute);
  }

  let startMinute = Math.floor(min / TICK_MINUTES) * TICK_MINUTES;
  let endMinute = Math.ceil(max / TICK_MINUTES) * TICK_MINUTES;

  if (endMinute - startMinute < MIN_AXIS_SPAN) {
    endMinute = startMinute + MIN_AXIS_SPAN;
  }
  // 자정 넘김이 있으면 24:00 구분선이 축 안에 들어와야 의미가 산다.
  if (endMinute > DAY_MINUTES && startMinute > DAY_MINUTES - TICK_MINUTES) {
    startMinute = DAY_MINUTES - TICK_MINUTES;
  }

  const ticks: number[] = [];
  for (let m = startMinute; m <= endMinute; m += TICK_MINUTES) {
    ticks.push(m);
  }

  return {
    startMinute,
    endMinute,
    ticks,
    hasOvernight: endMinute > DAY_MINUTES,
  };
}

/** 분 좌표 → 축 위의 백분율(0~100). 축 밖은 잘라 낸다. */
export function toAxisPercent(minute: number, axis: OverlayAxis): number {
  const span = axis.endMinute - axis.startMinute;
  if (span <= 0) return 0;
  const ratio = (minute - axis.startMinute) / span;
  return Math.min(100, Math.max(0, ratio * 100));
}

/** 구간을 축 위의 `left` / `width` 백분율로. 너무 얇아 사라지지 않게 최소 폭을 준다. */
export function toAxisBox(
  startMinute: number,
  endMinute: number,
  axis: OverlayAxis,
): { readonly left: number; readonly width: number } {
  const left = toAxisPercent(startMinute, axis);
  const right = toAxisPercent(endMinute, axis);
  return { left, width: Math.max(right - left, 0.6) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 드래그가 **빈칸을 건너뛴다** — 선택이 다른 겹침 구간으로 넘어가는 규칙
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 왜 구간을 넘게 했는가 — 그리고 왜 **구간 밖 시각은 여전히 못 고르는가**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 보고(2026-08-31): *"여기서 저 ----- 선이 안내려간다고"* — 세로 격자에서 18:50 에
 * 멈춘 플레이헤드를 가리킨 말이다.
 *
 * 원인: 드래그 핸들러가 **누를 때 정해진 구간 하나**에 좌표를 가두고 있었다
 * (`clampToSegment*`). 그래서 잡힌 일정이 겹침을 18:50 에서 끊어 놓으면, 아래 22:00
 * 구간이 눈에 보이는데도 선은 18:50 을 넘지 못했다. 그 구간으로 가려면 **직접 클릭**하는
 * 길밖에 없었는데, 사용자는 선을 끌어 내리려 한다 — 화면이 손잡이를 주고서 그 손잡이로는
 * 갈 수 없는 곳을 보여 준 셈이다.
 *
 * 그래서 이 함수가 **포인터가 지금 어느 구간에 속하는지**를 매번 다시 판정한다. 넘어간
 * 뒤에도 `clampToSegment*` 는 그대로 걸린다 — 즉 **구간 밖 시각은 끝내 선택되지 않는다.**
 * 겹침 구간 밖은 그 시각에 사람이 다 있다는 보장이 없는 자리이고, 그 시각을 등록하면
 * 화면이 "가능하다"고 거짓말한 것이 된다(§1.4 — 거짓 unavailable 은 슬롯 하나를 놓치지만
 * **거짓 available 은 못 오는 사람을 예약한다**). 바뀐 것은 *어느 구간 안인가*이지
 * *구간 안이어야 하는가*가 아니다.
 *
 * ⚠️ 이것은 **막대를 잇는 장치가 아니다.** 빈칸은 데이터가 진짜로 끊긴 자리로 그대로
 *    남고(위 `buildOverlayGapMap` 머리말), 여기서 바뀌는 것은 *선택*뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 빈칸 **위**에 있을 때는 어떻게 하는가 — 가장 가까운 구간에 붙인다
 * ─────────────────────────────────────────────────────────────────────────────
 * 후보는 둘이었다.
 *   (a) 직전 구간 끝에 머문다 → 빈칸이 세 시간이면 그 세 시간 내내 선이 얼어 있다.
 *       발주자가 신고한 증상(*"선이 안내려간다"*)과 **구분되지 않는다.** 고치려던 것과
 *       똑같이 보이는 동작을 남기는 것은 고친 것이 아니다.
 *   (b) **거리가 더 가까운 구간**으로 붙는다 → 빈칸 절반을 지나는 순간 아래 구간 시작으로
 *       넘어간다. 사용자는 "끌면 따라온다"는 것을 즉시 확인하고, 되돌리면 대칭으로 되돌아
 *       온다(진행 방향을 기억하지 않으므로 이력에 따라 결과가 달라지지 않는다).
 * (b)를 택했다. 진행 방향으로 "다음 구간 시작에 붙는" 안도 검토했지만, 방향을 기억해야
 * 하므로 같은 좌표에서 위/아래 어디서 왔는지에 따라 선이 다른 곳에 서게 된다 — 같은 자리를
 * 가리키는데 답이 둘인 조작은 신뢰할 수 없다.
 *
 * ★ 어느 경우에도 **선이 사라지거나 첫 구간으로 튀지 않는다.** 구간이 하나라도 있으면
 *   반드시 그중 하나를 돌려주고, 축 위/아래로 벗어나면 각각 첫/마지막 구간이 가장 가까운
 *   구간이 되어 자연스럽게 끝에 머문다. 구간이 하나뿐이면 언제나 그 구간이라 기존 동작과
 *   **완전히 같다.**
 * ★ 동점(빈칸 정확히 한가운데)은 **앞 구간**이 이긴다. 규칙이 결정적이어야 같은 좌표가
 *   늘 같은 답을 준다.
 */
export function pickDragTargetSegment<T>(
  segments: readonly RowSegment<T>[],
  minute: number,
): RowSegment<T> | undefined {
  let best: RowSegment<T> | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    const distance =
      minute < segment.startMinute
        ? segment.startMinute - minute
        : minute >= segment.endMinute
          ? minute - segment.endMinute
          : 0;
    // `<` 라서 동점이면 먼저 만난 구간(= 앞 구간)이 남는다.
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// 겹침 밴드의 **빈칸이 왜 비었는가**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ 빈칸은 **잇는 것이 아니라 설명하는 것**이다 — 이 절을 지우지 말 것
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 보고(2026-08-31): *"일정관리에 세로 겹침 ui 기준 중간에 빈칸이 있으면 바가 서로
 * 연결이 안됨"*. 원인을 되물으니: *"일정이 있어서 중간에 끊어진경우? 혹은 서로 시간이
 * 안맞아서 중간이 비어있는경우 둘다 생기는거같은데"*.
 *
 * ★ **막대를 이어 붙이면 안 된다.** 좌표(`toAxisBox`)는 정확한 퍼센트라 실제로 인접한
 *   구간은 이미 붙어 있다. 즉 빈칸은 렌더 결함이 아니라 **데이터가 진짜로 끊긴 자리**다.
 *   그 자리를 이으면 아무도 갈 수 없는 시간이 "갈 수 있는 시간"으로 그려진다 — §1.4 가
 *   못 박은 **거짓 available** 이다: *"거짓 unavailable 은 슬롯 하나를 놓치지만, 거짓
 *   available 은 못 오는 사람을 예약한다."* 나중에 "좀 이어 달라"는 요청이 다시 와도
 *   답은 이 주석이다.
 *
 * 진짜 결함은 따로 있었다. 끊기는 이유가 **둘인데 화면에서는 똑같은 빈칸**이었고,
 * 사용자가 할 일은 정반대다.
 *   1) **이미 잡힌 일정이 그 시간을 먹었다** -> 그 일정을 옮긴다.
 *   2) **그냥 시간이 안 맞는다**(최소 인원 미달 포함) -> 시간을 조율하거나 인원을 줄인다.
 * 개인 레인에는 1)이 secondary 실선으로 이미 그려져 있는데 **겹침 밴드에만 없었다.**
 * 아래 계산이 그 정보를 밴드 좌표로 옮긴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 언제 "일정 때문"이라고 말해도 되는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 겹침 창은 `availability_overlap(..., p_min_count)` 이 **minCount 명 이상**일 때만
 * 만든다. 그러므로 어떤 순간을 "일정 때문에 비었다"고 부를 수 있는 조건은
 * **`일정 빼기 전 가능 인원 >= minCount`** 하나다. 이걸 확인하지 않으면 애초에 두 명뿐이라
 * 잡을 수 없던 시간까지 일정 탓으로 뒤집어씌우게 된다 — 원인을 말해 주려고 만든 표시가
 * 틀린 원인을 말하는 셈이라, 아무 말도 안 하느니만 못하다.
 * 조건을 못 넘긴 자리는 2)로 분류하되, 걸려 있는 일정은 툴팁에 **사실로만** 덧붙인다.
 */

/** 하루 안의 분 구간. 1440 을 넘을 수 있다(자정 넘김 — 이 파일 머리말). */
interface MinuteSpan {
  readonly startMinute: number;
  readonly endMinute: number;
}

export type OverlayGapCause =
  /** 1) 이미 잡힌 일정이 먹었다. 그 일정만 없었으면 여기 겹침이 생겼다. */
  | "booked"
  /** 2) 그냥 안 겹친다(또는 최소 인원 미달). */
  | "unmatched";

export interface OverlayGapSegment {
  readonly key: string;
  readonly dayKey: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly cause: OverlayGapCause;
  /** 다른 일정을 빼기 **전** 이 시간에 가능했던 사람 수. */
  readonly availableCount: number;
  /** 그중 다른 일정에 묶여 빠진 사람 수. */
  readonly blockedCount: number;
  /** 막고 있는 일정의 보스 이름(등장 순, 중복 제거). */
  readonly bossNames: readonly string[];
  /**
   * 가능했던 사람 **전원**이 다른 일정에 걸렸는가.
   * "전원"의 기준은 파티 전체가 아니라 **그 시각에 원래 가능했던 사람**이다 — 자고 있는
   * 사람까지 분모에 넣으면 어떤 구간도 "전원"이 될 수 없어 구분 자체가 죽는다.
   */
  readonly isFullyBlocked: boolean;
}

function normalizeSpans(spans: readonly MinuteSpan[]): MinuteSpan[] {
  return spans
    .filter((span) => span.endMinute > span.startMinute)
    .map((span) => ({
      startMinute: span.startMinute,
      endMinute: span.endMinute,
    }))
    .sort((a, b) => a.startMinute - b.startMinute);
}

/** 겹치거나 맞닿은 구간을 하나로 합친다. */
function mergeSpans(spans: readonly MinuteSpan[]): MinuteSpan[] {
  const merged: Array<{ startMinute: number; endMinute: number }> = [];
  for (const span of normalizeSpans(spans)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, span.endMinute);
      continue;
    }
    merged.push({ startMinute: span.startMinute, endMinute: span.endMinute });
  }
  return merged;
}

/** `base` 에서 `holes` 를 도려낸다. */
function subtractSpans(
  base: readonly MinuteSpan[],
  holes: readonly MinuteSpan[],
): MinuteSpan[] {
  let remaining = normalizeSpans(base);
  for (const hole of holes) {
    const next: MinuteSpan[] = [];
    for (const span of remaining) {
      if (
        hole.endMinute <= span.startMinute ||
        hole.startMinute >= span.endMinute
      ) {
        next.push(span);
        continue;
      }
      if (hole.startMinute > span.startMinute) {
        next.push({
          startMinute: span.startMinute,
          endMinute: hole.startMinute,
        });
      }
      if (hole.endMinute < span.endMinute) {
        next.push({ startMinute: hole.endMinute, endMinute: span.endMinute });
      }
    }
    remaining = next;
  }
  return remaining;
}

function covers(span: MinuteSpan, minute: number): boolean {
  return span.startMinute <= minute && minute < span.endMinute;
}

/** 사람이 붙은 행 구간 — 가용 구간과 잡힌 일정이 공유하는 최소 모양. */
type PersonRowSegment = RowSegment<{ readonly personId: string }>;
type CommitmentRowSegment = RowSegment<{
  readonly personId: string;
  readonly shortName: string;
}>;

export interface OverlayGapInput {
  /** 겹침 창(이미 잡힌 일정이 빠진 결과). */
  readonly windows: readonly RowSegment<unknown>[];
  /** 개인 가능 시간 — **일정을 빼기 전** 원본. 반사실("일정만 없었다면")의 근거다. */
  readonly intervals: readonly PersonRowSegment[];
  readonly commitments: readonly CommitmentRowSegment[];
  /** 겹침 창을 만든 최소 인원. 원인 판정의 기준이다(위 머리말). */
  readonly minCount: number;
}

/**
 * 날짜별 **빈칸 사유** 구간. 가로·세로 두 화면이 **이 함수 하나**를 쓴다 — 각자 구현하면
 * 같은 상황에서 다른 말을 하게 되고, 그때 사용자는 어느 쪽을 믿어야 할지 알 수 없다.
 */
export function buildOverlayGapMap(
  input: OverlayGapInput,
): ReadonlyMap<string, readonly OverlayGapSegment[]> {
  const dayKeys = new Set<string>([
    ...input.windows.map((segment) => segment.dayKey),
    ...input.commitments.map((segment) => segment.dayKey),
  ]);

  const byDay = new Map<string, readonly OverlayGapSegment[]>();
  for (const dayKey of dayKeys) {
    const gaps = computeDayGaps(
      dayKey,
      input.windows.filter((segment) => segment.dayKey === dayKey),
      input.intervals.filter((segment) => segment.dayKey === dayKey),
      input.commitments.filter((segment) => segment.dayKey === dayKey),
      input.minCount,
    );
    if (gaps.length > 0) byDay.set(dayKey, gaps);
  }
  return byDay;
}

function computeDayGaps(
  dayKey: string,
  windows: readonly RowSegment<unknown>[],
  intervals: readonly PersonRowSegment[],
  commitments: readonly CommitmentRowSegment[],
  minCount: number,
): readonly OverlayGapSegment[] {
  const merged = mergeSpans(windows);

  /*
    겹침 막대 **사이**의 빈칸. 바깥쪽(첫 막대 앞·마지막 막대 뒤)은 발주자가 말한
    "바가 서로 연결이 안됨"이 성립하지 않는 자리라 2)로는 다루지 않는다 — 축 끝까지
    표시를 깔면 밴드가 표시로 뒤덮여 정작 막대가 안 보인다.
  */
  const interior: MinuteSpan[] = [];
  for (let i = 0; i + 1 < merged.length; i += 1) {
    const from = merged[i]!.endMinute;
    const to = merged[i + 1]!.startMinute;
    if (to > from) interior.push({ startMinute: from, endMinute: to });
  }

  /*
    1)은 **밴드 어디에 있든** 표시한다. 막대 바깥(예: 20:00~21:00 에 런이 있어 겹침이
    21:00 부터 시작한 경우)에도 "여기는 일정이 먹었다"는 답은 똑같이 유효하고, 런 길이는
    한두 시간이라 화면을 덮지 않는다. 겹침 창과 겹치는 부분은 도려낸다 — 그 시간은
    이미 갈 수 있다고 판정된 시간이라 빈칸이 아니다.
  */
  const bookedRegions = subtractSpans(mergeSpans(commitments), merged);
  const domain = mergeSpans([...interior, ...bookedRegions]);
  if (domain.length === 0) return [];

  /*
    구간을 **인원 구성이 바뀌는 모든 지점**에서 자른다. 자르지 않으면 20:00~23:00 빈칸
    한가운데 21:00~22:00 런 하나가 있을 때 세 시간 전체가 "일정 때문"이 되어, 실제로는
    시간이 안 맞았던 앞뒤 두 시간까지 틀린 원인을 달게 된다.
  */
  const cuts = new Set<number>();
  for (const span of [
    ...interior,
    ...bookedRegions,
    ...intervals,
    ...commitments,
    ...domain,
  ]) {
    cuts.add(span.startMinute);
    cuts.add(span.endMinute);
  }

  const pieces: OverlayGapSegment[] = [];
  for (const span of domain) {
    const points = [...cuts]
      .filter((point) => point > span.startMinute && point < span.endMinute)
      .concat(span.startMinute, span.endMinute)
      .sort((a, b) => a - b);

    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i]!;
      const to = points[i + 1]!;
      if (to <= from) continue;
      const probe = (from + to) / 2;

      const availablePeople = new Set(
        intervals
          .filter((segment) => covers(segment, probe))
          .map((segment) => segment.datum.personId),
      );

      const blockedPeople = new Set<string>();
      const bossNames: string[] = [];
      for (const commitment of commitments) {
        if (!covers(commitment, probe)) continue;
        /*
          원래 그 시간에 못 오던 사람의 런은 겹침을 **줄이지 않았다.** 그 사람을 세면
          "일정 때문"이 부풀려진다.
        */
        if (!availablePeople.has(commitment.datum.personId)) continue;
        blockedPeople.add(commitment.datum.personId);
        if (!bossNames.includes(commitment.datum.shortName)) {
          bossNames.push(commitment.datum.shortName);
        }
      }

      const availableCount = availablePeople.size;
      const blockedCount = blockedPeople.size;
      const cause: OverlayGapCause =
        blockedCount > 0 && availableCount >= minCount ? "booked" : "unmatched";

      // 원인을 일정으로 돌릴 수 없는 자리는 **막대 사이일 때만** 남긴다(위 `interior` 주석).
      if (
        cause === "unmatched" &&
        !interior.some((gap) => gap.startMinute <= from && to <= gap.endMinute)
      ) {
        continue;
      }

      pieces.push({
        key: `${dayKey}-gap-${from}-${to}`,
        dayKey,
        startMinute: from,
        endMinute: to,
        cause,
        availableCount,
        blockedCount,
        bossNames,
        isFullyBlocked: availableCount > 0 && blockedCount === availableCount,
      });
    }
  }

  return mergeAdjacentGaps(pieces);
}

/** 자른 뒤 사실이 같은 이웃 조각은 다시 합친다 — 같은 말을 두 번 그릴 이유가 없다. */
function mergeAdjacentGaps(
  pieces: readonly OverlayGapSegment[],
): readonly OverlayGapSegment[] {
  const merged: OverlayGapSegment[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.endMinute === piece.startMinute &&
      last.cause === piece.cause &&
      last.availableCount === piece.availableCount &&
      last.blockedCount === piece.blockedCount &&
      last.bossNames.join(" ") === piece.bossNames.join(" ")
    ) {
      merged[merged.length - 1] = { ...last, endMinute: piece.endMinute };
      continue;
    }
    merged.push(piece);
  }
  return merged;
}
