import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 시간표 — **"나 언제 어디로 보스 가야 하지"** 하나에만 답한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"일정 에선 정말 나 언제 어디로 보스가야하지? 를 주력으로
 * 보여주는거임"* · *"내가 가는 보스만. 보스 얼굴. 파티 이름 내가 갈 캐릭터 표시하는거
 * 좋을듯"* · *"클릭하면 저 보스에 대한 상세 모달을 여는걸로 변경해 파티 이름, 파티원,
 * 내 캐릭터 등등 전부다 보여주는식으로"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `user_week_runs` RPC 를 쓰지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 RPC 는 `!일정` 이 쓰고 있고 **보스 아이콘 키(`boss_difficulty_id`)와 파티 이름과
 * 명단을 돌려주지 않는다.** 반환 컬럼을 늘리려면 함수를 지웠다 다시 만들어야 하는데
 * (Postgres 는 OUT 컬럼 변경을 `create or replace` 로 못 한다), 그 사이 봇이 부르면 죽는다.
 * 화면 하나 때문에 다른 소비자를 흔들 이유가 없어 **읽기 전용 조회를 따로 둔다.**
 *
 * ⚠️ 그래도 **판정 규칙은 베끼지 않는다.** "내가 가는 런"의 정의는 `run_signups.status =
 *    'going'` + 내 참가자 행 하나뿐이고, 그건 `user_week_runs` 와 글자 그대로 같다.
 *    규칙이 갈라질 여지가 있는 것(묶음 규칙)은 여기서 만들지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 시각 미정 런은 **뺀다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 시간표는 격자 위의 위치가 곧 정보다. 시각이 없는 런은 놓을 자리가 없고, 아무 데나 놓으면
 * 화면이 거짓말을 한다. 그런 런은 '일정 추가' 화면의 목록에서 보이고 거기서 시각을 정한다.
 */

import { ApiError } from "@/features/auth/server/http";
import type {
  TimetableParticipant,
  TimetableRun,
} from "@/features/schedule/types";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { WeekKey } from "@/types/domain";

export type { TimetableRun };

/** 길이를 모르는 런의 기본값(분). `run-grouping` 과 같은 값을 본다. */
const DEFAULT_RUN_MINUTES = 20;

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { readonly message: string } | null;
}

function unwrap<T>(result: QueryResult<T>, context: string): T {
  if (result.error !== null) {
    console.error(`[timetable-repo] ${context}: ${result.error.message}`);
    throw ApiError.internal();
  }
  if (result.data === null) {
    console.error(`[timetable-repo] ${context}: 응답 본문이 비어 있습니다.`);
    throw ApiError.internal();
  }
  return result.data;
}

/**
 * 명단 정렬 — **관리 번호 오름차순.**
 *
 * 참가 여부로 먼저 가르고 싶어지지만 그러면 안 된다. 번호는 카톡에서 `1번` 으로 부르는
 * 식별자라(§1.4) 화면과 대화가 같은 순서를 봐야 하고, 참가 상태는 바뀌는 값이라
 * 정렬 기준이 되면 같은 사람이 어제와 다른 자리에 선다.
 */
function byMemberNo(a: TimetableParticipant, b: TimetableParticipant): number {
  return a.memberNo - b.memberNo;
}

/**
 * 그 사람이 그 주차에 **참가로 등록한** 런 전부. 시각순.
 *
 * ★ 왕복은 **두 단**이다.
 *   1단: 내 참가자 행 → 참가 → 런 → 보스 → 파티, 그리고 내가 데려가는 캐릭터까지.
 *        전부 같은 관계를 따라가므로 PostgREST 임베딩 **하나**로 끝난다.
 *   2단: 그 런들의 **명단 전체** · 파티 번호. 둘 다 1단의 결과(런 id · 파티 id)가 있어야
 *        범위를 정할 수 있고, 서로는 남이라 **같은 단에 나란히** 올린다.
 *
 * ★ 2단을 1단과 합치지 않은 이유: 그러면 파티 번호를 **그 주차 전체**에서 읽어야 하고,
 *   명단은 걸 조건이 아예 없다. 남의 파티 번호까지 서버 메모리로 끌어오는 셈이라
 *   한 단 늘리는 값보다 비싸다.
 *
 * ★ **캐릭터 이름을 따로 조회하지 않는다.** 예전에는 캐릭터 id 를 모아 세 번째 왕복을
 *   돌았는데, `characters(character_name)` 을 그 자리에 임베드하면 같은 값이 함께 온다.
 */
export async function fetchMyTimetable(
  userId: string,
  weekKey: WeekKey,
): Promise<readonly TimetableRun[]> {
  const db = getAdminDb();

  const mine = unwrap(
    await db
      .from("run_signups")
      /*
        ★ 선택 문자열은 **리터럴이어야 한다.** 배열을 `join` 으로 이어 붙이면
          PostgREST 타입 추론이 통째로 죽어(`GenericStringError`) 임베딩 필드가
          전부 `any` 도 아닌 오류 타입이 된다.
        ★ `!inner` — 내 참가자 행이 아닌 것, 취소된 런은 부모까지 걸러 낸다.
        ★ `characters(...)` 가 두 곳에 있다. 바깥쪽은 **이 런에 지정한** 캐릭터,
          `party_participants` 안쪽은 **파티 기본값**이며 앞의 것이 없을 때 뒤가 쓰인다.
      */
      .select(
        "character_id,characters(character_name),party_participants!inner(user_id,left_at,party_id,characters(character_name)),party_runs!inner(id,party_id,scheduled_at,duration_minutes,week_key,cancelled_at,status,boss_difficulties!inner(id,korean_name,difficulty,short_name),parties!inner(name))",
      )
      .eq("status", "going")
      .eq("party_participants.user_id", userId)
      .is("party_participants.left_at", null)
      .eq("party_runs.week_key", weekKey)
      .is("party_runs.cancelled_at", null)
      .neq("party_runs.status", "cancelled"),
    "내 주간 일정 조회",
  );

  const runIds = [
    ...new Set(
      mine.flatMap((row) => (row.party_runs === null ? [] : [row.party_runs.id])),
    ),
  ];
  // 갈 곳이 없으면 2단을 돌 이유도 없다. 빈 `in()` 은 조건이 아니라 전체 조회가 된다.
  if (runIds.length === 0) return [];

  const partyIds = [
    ...new Set(
      mine.flatMap((row) =>
        row.party_runs === null ? [] : [row.party_runs.party_id],
      ),
    ),
  ];

  const [roster, numbers] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("run_signups")
          .select(
            "run_id,status,characters(character_name),party_participants!inner(id,member_no,display_name,user_id,left_at,characters(character_name))",
          )
          .in("run_id", runIds)
          .is("party_participants.left_at", null),
        "런 명단 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_room_numbers")
          .select("party_id,party_no")
          .eq("week_key", weekKey)
          .in("party_id", partyIds),
        "파티 번호 조회",
      ))(),
  ]);

  const partyNoById = new Map(numbers.map((row) => [row.party_id, row.party_no]));

  /*
    캐릭터 이름은 **런 지정 → 파티 지정** 순으로 떨어진다. DB 함수
    `run_participant_names` 의 `coalesce(s.character_id, pp.character_id)` 와 같은 순서다 —
    이 규칙이 화면마다 다르면 같은 사람이 어떤 화면에서는 "미지정"으로 보인다(2026-08-20 사고).
  */
  const participantsByRun = new Map<string, TimetableParticipant[]>();
  for (const row of roster) {
    const member = row.party_participants;
    if (row.run_id === null || member === null) continue;

    const bucket = participantsByRun.get(row.run_id) ?? [];
    bucket.push({
      participantId: member.id,
      memberNo: member.member_no,
      displayName: member.display_name,
      characterName:
        row.characters?.character_name ??
        member.characters?.character_name ??
        null,
      status: row.status,
      isMe: member.user_id === userId,
    });
    participantsByRun.set(row.run_id, bucket);
  }
  for (const bucket of participantsByRun.values()) bucket.sort(byMemberNo);

  return mine
    .flatMap((row): readonly TimetableRun[] => {
      const run = row.party_runs;
      const boss = run?.boss_difficulties;
      const party = run?.parties;
      // 시각 미정은 격자에 놓을 자리가 없다(머리말).
      if (run === null || boss === null || party === null) return [];
      if (run.scheduled_at === null) return [];

      return [
        {
          runId: run.id,
          partyId: run.party_id,
          partyName: party.name,
          partyNo: partyNoById.get(run.party_id) ?? null,
          scheduledAt: new Date(run.scheduled_at).toISOString(),
          durationMinutes: run.duration_minutes ?? DEFAULT_RUN_MINUTES,
          bossDifficultyId: boss.id,
          difficulty: boss.difficulty,
          bossKoreanName: boss.korean_name,
          shortName: boss.short_name,
          characterName:
            row.characters?.character_name ??
            row.party_participants?.characters?.character_name ??
            null,
          participants: participantsByRun.get(run.id) ?? [],
        },
      ];
    })
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
}
