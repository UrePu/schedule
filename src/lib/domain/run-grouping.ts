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
 * ★ 끝 시각은 **마지막 런이 끝나는 시각**이다 (2026-08-20 정정).
 *
 *   처음에는 마지막 런의 **시작** 시각을 썼다. 발주 예시가 `21:00 ~ 22:00` 이었고 그때
 *   마지막 런이 22:00 시작이었기 때문인데, 그 해석이 틀렸다. 실제로 이런 화면이 나갔다:
 *
 *     `익세 카칼`  (20분짜리 2개)  → `22:00 ~ 22:20`   ← 실제로는 22:40 까지
 *     `익칼 하발 하벨` (20분짜리 3개) → `22:00 ~ 22:40`   ← 실제로는 23:00 까지
 *
 *   발주 지적(2026-08-20): *"세가지인데 40분밖에 안됨. (…) 시간 배정이 처음과 끝으로
 *   되어야할듯"*. 맞는 지적이다 — 이 헤더를 읽는 사람은 **언제까지 비워 둬야 하는지**를
 *   알고 싶은 것이고, 마지막 보스의 시작 시각은 그 질문에 답하지 않는다.
 *
 * ★ 그래서 **런이 하나일 때도 범위를 쓴다**(`22:00 ~ 22:20`). 예전에 접었던 이유는
 *   `21:00 ~ 21:00` 이 되기 때문이었는데, 끝 시각을 쓰면 그런 일이 없고 오히려 한 보스의
 *   소요 시간이 드러난다.
 * ★ 소요 시간을 모르면(`durationMinutes === null`) 끝을 지어내지 않고 시작 시각만 쓴다.
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

  const last = runs[runs.length - 1];
  const lastStart = last?.scheduledAt ?? null;
  if (lastStart === null) return head;

  const durationMinutes = last?.durationMinutes ?? null;
  // 소요를 모르면 끝을 지어내지 않는다 — 틀린 종료 시각은 없는 것보다 나쁘다.
  if (durationMinutes === null) {
    return lastStart.getTime() === start.getTime()
      ? head
      : `${head} ~ ${formatKst(lastStart, "HH:mm")}`;
  }

  const endsAt = new Date(lastStart.getTime() + durationMinutes * 60_000);
  if (endsAt.getTime() <= start.getTime()) return head;

  return `${head} ~ ${formatKst(endsAt, "HH:mm")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 명단이 같은 보스끼리 접기 — **키워드 알림이 걸리게** 이름을 부른다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 발주 지시(2026-08-19):
 *   *"알림 기능은 파티 기준이니까 그 파티에 해당하는 사람들의 닉네임을 부르고 해야함
 *     이부분은 본캐(닉네임) 해서
 *       익세 하대 하카 :
 *       더저(무르겨르), 라온내일
 *       노유 :
 *       더저 , 라온내일
 *     이렇게 (…) 키워드알림을 이용하려는거임"*
 *
 * ★ **이름이 본문에 그대로 있어야 한다.** 카카오톡·텔레그램의 키워드 알림은 메시지 안에
 *   그 단어가 있을 때만 울린다. 그래서 알림 문구에서 참가자 이름을 줄이거나 "외 2명"으로
 *   접으면, 접힌 사람에게는 **알림이 가지 않는다.** 이 함수가 존재하는 이유가 그것이다.
 * ★ 그렇다고 보스마다 같은 명단을 되풀이하면 줄만 길어진다. 그래서 **명단이 같은 보스끼리**
 *   한 줄로 묶는다 — 위 예에서 앞의 세 보스는 명단이 같고 마지막 하나만 다르다.
 * ★ 묶음은 **연속된 것만** 접는다. 순서를 바꾸면 도는 차례가 뒤섞여, 방에서 "다음이 뭐지"를
 *   읽을 수 없게 된다.
 */
export interface RosterRun {
  /** 보스 줄임말. `익세` · `하대` · `하카` · `노유`. */
  readonly shortName: string;
  /** 참가자 명단 문자열. `본캐(부캐)` 규칙으로 이미 조립돼 있어야 한다. */
  readonly roster: string;
}

export interface RosterLine {
  readonly bosses: readonly string[];
  readonly roster: string;
}

/** 연속하면서 명단이 같은 보스들을 한 덩이로 접는다. */
export function groupBossesByRoster(
  runs: readonly RosterRun[],
): readonly RosterLine[] {
  const lines: { bosses: string[]; roster: string }[] = [];
  for (const run of runs) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.roster === run.roster) {
      last.bosses.push(run.shortName);
      continue;
    }
    lines.push({ bosses: [run.shortName], roster: run.roster });
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// 캐릭터별로 접은 묶음 — `!일정` 과 대시보드가 **같은 함수**를 본다
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ 이 함수는 원래 `features/bot/server/bot-repo.ts` 에 있었다. 대시보드에 "가장 가까운
//   파티 보스 일정" 카드가 생기면서(발주자 2026-08-19: *"일정 자체를 알려달라는거지 아까
//   !일정 처럼. 그래야 대시보드에서도 아 보스 언제네 바로 볼수있잖아"*) 같은 모양이 두 곳에
//   필요해졌고, 봇 서버 모듈은 클라이언트 컴포넌트가 import 할 수 없다(`AdminDb` 를 끌고
//   온다). 규칙을 베껴 쓰면 두 화면이 언젠가 다른 묶음을 그린다 — 그래서 순수 로직인 이곳으로
//   옮겼다. 봇은 이제 여기서 가져다 쓴다.

/** 캐릭터별로 접기 위해 필요한 최소 정보. */
export interface CharacterRun extends GroupableRun {
  /** `boss_difficulties.short_name` — `익세` · `하대` · `하카` · `노유`. */
  readonly shortName: string;
  /** 이 런에 데려가는 캐릭터. 지정도 파티 기본값도 없으면 `null`. */
  readonly characterName: string | null;
  /** 방+주차에 매인 파티 번호. 방에 안 묶인 파티는 `null` 이며 **정상**이다. */
  readonly partyNo: number | null;
}

/** 한 묶음. `21:40 ~ 22:40` 헤더 하나에 캐릭터별 줄이 달린다. */
export interface RunGroup {
  readonly partyNo: number | null;
  /** 이미 조립된 헤더의 시각 부분. `시간미정` 일 수 있다. */
  readonly range: string;
  /** 헤더의 임박 판정에 쓴다. 시각 미정이면 `null`. */
  readonly startAt: Date | null;
  /** `익세 하대 하카 : 무르겨르` — 캐릭터 하나가 한 줄이다. */
  readonly lines: readonly string[];
}

/**
 * 시간순 런을 묶고, 묶음 안에서 **캐릭터별로 한 줄**로 접는다.
 *
 * ★ 같은 묶음에서 한 캐릭터가 보스 넷을 돈다면 `익세 하대 하카 노유 : 무르겨르` 한 줄이다.
 *   보스마다 캐릭터 이름을 되풀이하면 실제로 다른 부분(보스)이 묻힌다 — 발주자가 이 모양을
 *   직접 그려 보냈다.
 * ★ `reference` 규칙은 `formatRunGroupRange` 와 같다: 주 단위 목록이면 `null` 을 넘겨
 *   날짜를 항상 적는다.
 */
export function groupRuns(
  runs: readonly CharacterRun[],
  reference: Date | null,
): readonly RunGroup[] {
  return groupConsecutiveRuns(runs).map((group) => {
    // 캐릭터가 처음 나온 순서를 유지한다(Map 이 삽입 순서를 지킨다).
    const byCharacter = new Map<string, string[]>();
    for (const run of group) {
      const key = run.characterName ?? "캐릭터 미정";
      const bosses = byCharacter.get(key) ?? [];
      bosses.push(run.shortName);
      byCharacter.set(key, bosses);
    }

    return {
      partyNo: group.find((run) => run.partyNo !== null)?.partyNo ?? null,
      range: formatRunGroupRange(group, reference),
      startAt: group[0]?.scheduledAt ?? null,
      lines: [...byCharacter].map(
        ([character, bosses]) => `${bosses.join(" ")} : ${character}`,
      ),
    };
  });
}
