/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 연속한 런을 한 묶음으로 — **규칙의 유일한 소유자**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(원문, 2026-08-19):
 *   "일정등록할때 4개 보스를 선택하면 4개를 묶어서 하나의 보스 일정으로 바꿔줘
 *    21:00 ~ 22:00"
 *
 * 그 전까지 목록은 런마다 `21시 1파티 <보스> (명단)` 을 통째로 반복했다. 네 줄 중 실제로
 * 다른 부분은 **보스 이름뿐**인데 시각·파티·명단이 세 번 더 적혔고, 그래서 눈이 어디를
 * 봐야 하는지 알 수 없었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `features/` 가 아니라 `lib/domain/` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * **웹 일정 화면과 카톡/텔레그램 봇이 같은 곳에서 끊어야 한다.** 봇이 한 묶음으로 보여 준
 * 일정을 웹이 네 덩어리로 그리면 같은 것을 보고 있다는 감각이 끊긴다.
 * 봇 쪽 구현은 `features/bot/server/*` 에 있고 거기엔 `import "server-only"` 가 걸려 있어
 * 클라이언트 컴포넌트가 못 가져다 쓴다. 그래서 규칙만 **환경 중립인 이 파일**로 내린다.
 * (`participant-label.ts` 가 이미 같은 이유로 여기에 있다.)
 *
 * ⚠️ 이 파일은 **문구를 만들지 않는다.** 보스 줄(`보스 : 이름들`)은 DB `format_run_entry`
 *    가, 카드 렌더링은 웹이 갖는다. 여기가 아는 것은 "어디서 끊는가"와 "헤더의 시각 범위"
 *    둘뿐이다.
 */

import { kstDayKey } from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import { kstWeekdayKo } from "@/components/domain/kst-format";

/**
 * 앞 런이 끝난 뒤 이만큼 안에 다음 런이 시작하면 **같은 묶음**이다.
 *
 * 30분인 근거: 보스를 이어 도는 사람의 쉬는 시간이 대체로 그 안이고, 그보다 벌어지면
 * "저녁 먹고 다시"에 가까워 한 덩어리로 읽히지 않는다. 실측(20분 간격 4연속)은 어느 값을
 * 골라도 한 묶음이라, 이 상수가 그 케이스를 좌우하지는 않는다.
 */
export const GROUP_GAP_MS = 30 * 60 * 1000;

/** 런 길이가 비어 있을 때 가정하는 분. **끊는 판정에만** 쓰이므로 보수적으로 짧게 잡는다. */
const DEFAULT_RUN_MINUTES = 20;

/** 묶는 데 필요한 최소 정보. 웹 `ScheduledRun` 과 봇 `RoomRun` 이 둘 다 만족한다. */
export interface GroupableRun {
  readonly partyId: string;
  /** `null` = 시각 미정. 묶이지 않고 혼자 선다. */
  readonly scheduledAt: Date | null;
  readonly durationMinutes: number | null;
}

/**
 * **시간순으로 정렬된** 런을 연속 묶음으로 접는다. 정렬은 호출하는 쪽 책임이다
 * (양쪽 다 이미 `scheduled_at` 오름차순으로 읽어 온다).
 *
 * 끊는 조건은 셋이고 하나라도 걸리면 새 묶음이다.
 *   1. **파티가 다르다** — 다른 파티 일정이 한 헤더 아래 섞이면 누가 가는지 읽을 수 없다.
 *   2. **KST 날짜가 다르다** — `23:50 ~ 00:05` 같은 헤더는 날짜를 숨겨 오해를 만든다.
 *      주 경계가 KST 목요일 00:00 이라(§1) 자정을 넘는 묶음은 실제로 생긴다.
 *   3. 앞 런이 **끝난 뒤** `GROUP_GAP_MS` 보다 벌어졌다.
 *
 * ⚠️ **시각 미정 런은 묶지 않는다.** 순서를 모르는 것을 시간 묶음에 끼우면 헤더가 거짓말을
 *    한다. 각자 혼자 선 묶음이 되어 목록 끝(정렬상 nulls last)에 모인다.
 */
export function groupConsecutiveRuns<T extends GroupableRun>(
  runs: readonly T[],
): readonly (readonly T[])[] {
  const groups: T[][] = [];
  let current: T[] | null = null;

  for (const run of runs) {
    if (run.scheduledAt === null) {
      current = null;
      groups.push([run]);
      continue;
    }

    const previous = current?.[current.length - 1];
    if (current !== null && previous !== undefined && previous.scheduledAt !== null) {
      const previousEnd =
        previous.scheduledAt.getTime() +
        (previous.durationMinutes ?? DEFAULT_RUN_MINUTES) * 60 * 1000;
      const breaks =
        previous.partyId !== run.partyId ||
        kstDayKey(previous.scheduledAt) !== kstDayKey(run.scheduledAt) ||
        run.scheduledAt.getTime() - previousEnd > GROUP_GAP_MS;
      if (breaks) current = null;
    }

    if (current === null) {
      current = [run];
      groups.push(current);
    } else {
      current.push(run);
    }
  }

  return groups;
}

/**
 * 묶음 헤더의 시각 부분. `8/19(수) 21:00 ~ 22:00` · `21:00` · `시간미정`.
 *
 * ⚠️ 끝 시각은 **마지막 런의 시작 시각**이며 끝나는 시각이 아니다. 발주 예시가
 *    `21:00 ~ 22:00` 인데 마지막 런이 22:00 **시작**이라 그렇다. 종료(22:20)를 쓰면 더
 *    정확하지만 발주자가 쓴 표기와 달라진다 — 표기를 바꾸려면 여기 한 곳만 고치면 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `reference` 가 `null` 이면 **날짜를 언제나 붙인다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 DB `format_kst_when` 과 똑같이 "기준일과 다를 때만" 붙였는데, **한 주 목록에서
 * 그 규칙은 틀렸다.** `!일정` 은 이번 주 전체를 보여 주므로 오늘 것만 날짜가 사라지고
 * 나머지는 붙어, 어느 줄이 오늘인지 알 수 없는 채 날짜만 들쭉날쭉해진다. 발주자가
 * *"이번주 일정인데 날짜/요일이 없다"* 고 지적한 것이 이것이다.
 * (같은 주의가 `scheduled-run-list.tsx` 의 `sequence` 주석에 이미 적혀 있었는데 —
 *  *"한 주 목록이라 `21:00` 만으로는 어느 날인지 알 수 없다"* — 봇에서 어겼다.)
 *
 * 그래서 호출하는 쪽이 **명시적으로** 고른다.
 *   - 주 단위 목록(웹 일정 화면, `!일정`)      → `null`. 날짜를 항상 적는다.
 *   - 하루가 이미 제목에 있는 목록(`!일정 오늘`) → 그 날짜. 시각만 적는다.
 */
export function formatRunGroupRange(
  runs: readonly GroupableRun[],
  reference: Date | null,
): string {
  const start = runs[0]?.scheduledAt ?? null;
  if (start === null) return "시간미정";

  const head =
    reference !== null && kstDayKey(start) === kstDayKey(reference)
      ? formatKst(start, "HH:mm")
      : `${formatKst(start, "M/d")}(${kstWeekdayKo(start)}) ${formatKst(start, "HH:mm")}`;

  const lastStart = runs[runs.length - 1]?.scheduledAt ?? null;
  // 런이 하나뿐이면 `21:00 ~ 21:00` 이 되지 않게 범위를 접는다.
  if (lastStart === null || lastStart.getTime() === start.getTime()) return head;

  return `${head} ~ ${formatKst(lastStart, "HH:mm")}`;
}
