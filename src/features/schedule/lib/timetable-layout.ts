import { groupConsecutiveRuns } from "@/lib/domain/run-grouping";
import type { TimetableRun } from "@/features/schedule/types";

import {
  computeOverlayAxis,
  projectToDayRows,
  type OverlayAxis,
} from "./overlay-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 시간표의 **좌표 계산**. 순수 함수만 두고 렌더는 컴포넌트가 한다.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 겹쳐보기와 **같은 좌표계를 쓴다** — 축을 두 벌 만들지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * `overlay-layout.ts` 가 이미 "하루 = 한 칸, 축 = 그날 00:00 KST 로부터의 분,
 * **1440 에서 끊지 않는다**"를 구현해 두었고, 그 규칙은 여기서도 글자 그대로 옳다.
 * 그래서 날짜 칸 만들기(`buildDayRows`) · 절대시각 → 분 좌표(`projectToDayRows`) ·
 * 축 범위 결정(`computeOverlayAxis`)을 **그대로 가져다 쓴다.**
 *
 * 다른 것은 **화면에 놓는 방향 하나**다. 겹쳐보기는 가로축이 시간이고, 이 화면은
 * 에타 시간표처럼 세로축이 시간이다(발주 참고 이미지). 축 위의 백분율은 같은 값이므로
 * 컴포넌트가 `left/width` 대신 `top/height` 에 꽂기만 하면 된다 — 계산을 복제하면
 * 자정 넘김 처리가 두 곳에서 갈라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 블록은 **런 하나가 아니라 이어 도는 묶음 하나**다
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스 한 판은 20분이라, 런마다 블록을 그리면 22:00 · 22:20 · 22:40 이 실오라기 세 개가
 * 된다. 사람이 실제로 비워 둬야 하는 것은 **22:00~23:00 한 덩어리**이고, 발주자가
 * 2026-08-20 에 지적한 것도 정확히 그 지점이다(*"시간 배정이 처음과 끝으로 되어야할듯"*).
 *
 * 그래서 `groupConsecutiveRuns()` 로 접는다 — 같은 파티 · 같은 KST 날짜 · 30분 이내 연속.
 * 판정 규칙은 목록 화면과 카톡 `!일정` 이 쓰는 것과 **같은 함수**다. 규칙이 갈라지면
 * 같은 일정이 화면마다 다른 개수로 보인다.
 *
 * ⚠️ 그러므로 입력은 **시각 오름차순으로 정렬돼 있어야 한다.** 정렬은 조회가 한다
 *    (`timetable-repo.fetchMyTimetable`).
 */

/**
 * 시각을 `Date` 로 되살린 런.
 *
 * 배선 타입(`TimetableRun`)은 JSON 을 건너와야 해서 시각이 문자열이다. 좌표 계산은
 * 밀리초 산술을 하므로 **경계에서 한 번만** 되살리고, 그 뒤로는 이 타입이 흐른다.
 * 컴포넌트도 이 타입을 받으므로 `new Date()` 가 렌더마다 반복되지 않는다.
 */
export type TimetableRunAt = Omit<TimetableRun, "scheduledAt"> & {
  readonly scheduledAt: Date;
};

/** 시간표 블록 하나 = 이어 도는 한 덩어리. */
export interface TimetableBlock {
  readonly key: string;
  readonly dayKey: string;
  /** 그날 00:00 KST 기준 분. **1440 을 넘을 수 있다**(자정 넘김). */
  readonly startMinute: number;
  readonly endMinute: number;
  /** 같은 시간대에 겹친 블록들 안에서 이 블록이 설 자리(0-기반). */
  readonly lane: number;
  /** 그 겹침 무리의 총 자리 수. 블록 폭 = `1 / laneCount`. */
  readonly laneCount: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly partyId: string;
  readonly partyName: string;
  readonly partyNo: number | null;
  /**
   * 이 덩어리에서 내가 데려가는 캐릭터. 보스마다 다른 캐릭터로 갈 수 있어 **배열**이며,
   * 미지정은 담지 않는다(`null` 을 "이름"인 척 그리지 않는다).
   */
  readonly characterNames: readonly string[];
  /** 덩어리에 속한 런들. 보스 얼굴을 이 순서대로 늘어놓는다. */
  readonly runs: readonly TimetableRunAt[];
}

export interface TimetableLayout {
  readonly axis: OverlayAxis;
  readonly blocks: readonly TimetableBlock[];
}

/** 런 길이가 비어 있을 때 가정하는 분. `run-grouping` 과 같은 값을 본다. */
const DEFAULT_RUN_MINUTES = 20;

interface GroupSpan {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly runs: readonly TimetableRunAt[];
}

function endOf(run: TimetableRunAt): number {
  return (
    run.scheduledAt.getTime() +
    (run.durationMinutes || DEFAULT_RUN_MINUTES) * 60 * 1000
  );
}

/**
 * 겹치는 블록에 자리를 나눠 준다.
 *
 * ★ 자리 수는 **날짜 전체가 아니라 겹침 무리마다** 센다. 하루 안에서 21시에 두 개가
 *   겹치고 23시에 하나뿐이라면, 23시 블록은 폭을 반으로 줄일 이유가 없다. 날짜 단위로
 *   세면 겹치지도 않은 블록이 평생 반쪽으로 남는다.
 *
 * 무리는 "지금까지 나온 끝 시각의 최댓값보다 늦게 시작하면 새 무리"로 끊는다.
 */
function packLanes(
  spans: readonly (GroupSpan & {
    readonly dayKey: string;
    readonly startMinute: number;
    readonly endMinute: number;
  })[],
): readonly { readonly lane: number; readonly laneCount: number }[] {
  const result = spans.map(() => ({ lane: 0, laneCount: 1 }));

  const byDay = new Map<string, number[]>();
  spans.forEach((span, index) => {
    const bucket = byDay.get(span.dayKey) ?? [];
    bucket.push(index);
    byDay.set(span.dayKey, bucket);
  });

  for (const indices of byDay.values()) {
    indices.sort((a, b) => spans[a].startMinute - spans[b].startMinute);

    let cluster: number[] = [];
    let clusterEnd = Number.NEGATIVE_INFINITY;
    // 무리 안에서 각 자리가 언제 비는지.
    let laneEnds: number[] = [];

    const flush = () => {
      const laneCount = Math.max(laneEnds.length, 1);
      for (const index of cluster) result[index].laneCount = laneCount;
      cluster = [];
      laneEnds = [];
      clusterEnd = Number.NEGATIVE_INFINITY;
    };

    for (const index of indices) {
      const span = spans[index];
      if (span.startMinute >= clusterEnd) flush();

      let lane = laneEnds.findIndex((end) => end <= span.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(span.endMinute);
      } else {
        laneEnds[lane] = span.endMinute;
      }

      result[index].lane = lane;
      cluster.push(index);
      clusterEnd = Math.max(clusterEnd, span.endMinute);
    }
    flush();
  }

  return result;
}

/**
 * 내가 가는 런 목록 → 시간표 블록 + 공유 축.
 *
 * `dayKeys` 는 그릴 날짜 칸의 집합이다(`buildDayRows` 가 만든 것). 그 밖의 날짜에
 * 걸린 런은 **조용히 버린다** — 이번 주만 그리는 화면이라 다음 주 런이 끼어들 자리가 없다.
 */
export function buildTimetableLayout(
  runs: readonly TimetableRun[],
  dayKeys: ReadonlySet<string>,
): TimetableLayout {
  const groups = groupConsecutiveRuns<TimetableRunAt>(
    runs.map((run) => ({ ...run, scheduledAt: new Date(run.scheduledAt) })),
  );

  const spans: GroupSpan[] = groups.flatMap((group) => {
    const first = group[0];
    if (first === undefined || first.scheduledAt === null) return [];
    const lastEnd = Math.max(...group.map((run) => endOf(run)));
    return [
      {
        startsAt: first.scheduledAt,
        endsAt: new Date(lastEnd),
        runs: group,
      },
    ];
  });

  const segments = projectToDayRows(spans, dayKeys, (_span, index) =>
    String(index),
  );

  const axis = computeOverlayAxis(segments);

  const placed = segments.map((segment) => ({
    ...segment.datum,
    dayKey: segment.dayKey,
    startMinute: segment.startMinute,
    endMinute: segment.endMinute,
  }));

  const lanes = packLanes(placed);

  return {
    axis,
    blocks: placed.map((span, index) => {
      const first = span.runs[0];
      return {
        key: span.runs.map((run) => run.runId).join("+"),
        dayKey: span.dayKey,
        startMinute: span.startMinute,
        endMinute: span.endMinute,
        lane: lanes[index].lane,
        laneCount: lanes[index].laneCount,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        partyId: first?.partyId ?? "",
        partyName: first?.partyName ?? "",
        partyNo: first?.partyNo ?? null,
        characterNames: [
          ...new Set(
            span.runs.flatMap((run) =>
              run.characterName === null ? [] : [run.characterName],
            ),
          ),
        ],
        runs: span.runs,
      };
    }),
  };
}
