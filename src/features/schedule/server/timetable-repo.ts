import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이번 주 시간표 — **"나 언제 어디로 보스 가야 하지"** 하나에만 답한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"일정 에선 정말 나 언제 어디로 보스가야하지? 를 주력으로
 * 보여주는거임"* · *"내가 가는 보스만. 보스 얼굴. 파티 이름 내가 갈 캐릭터 표시하는거
 * 좋을듯"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `user_week_runs` RPC 를 쓰지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 RPC 는 `!일정` 과 대시보드 카드가 함께 쓰고 있고 **보스 아이콘 키(`boss_difficulty_id`)
 * 와 파티 이름을 돌려주지 않는다.** 반환 컬럼을 늘리려면 함수를 지웠다 다시 만들어야 하는데
 * (Postgres 는 OUT 컬럼 변경을 `create or replace` 로 못 한다), 그 사이 봇이 부르면 죽는다.
 * 화면 하나 때문에 두 소비자를 흔들 이유가 없어 **읽기 전용 조회를 따로 둔다.**
 *
 * ⚠️ 그래도 **판정 규칙은 베끼지 않는다.** "내가 가는 런"의 정의는 `run_signups.status =
 *    'going'` + 내 참가자 행 하나뿐이고, 그건 `user_week_runs` 와 글자 그대로 같다.
 *    규칙이 갈라질 여지가 있는 것(명단 문구·묶음 규칙)은 여기서 만들지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 시각 미정 런은 **뺀다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 시간표는 격자 위의 위치가 곧 정보다. 시각이 없는 런은 놓을 자리가 없고, 아무 데나 놓으면
 * 화면이 거짓말을 한다. 그런 런은 '일정 추가' 화면의 목록에서 보이고 거기서 시각을 정한다.
 */

import { ApiError } from "@/features/auth/server/http";
import type { TimetableRun } from "@/features/schedule/types";
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
 * 그 사람이 그 주차에 **참가로 등록한** 런 전부. 시각순.
 *
 * ★ 왕복은 **두 단**이다.
 *   1단: 내 참가자 행 → 참가 → 런 → 보스 → 파티. 전부 같은 관계를 따라가므로
 *        PostgREST 임베딩 **하나**로 끝난다.
 *   2단: 파티 번호 · 캐릭터 이름. 둘 다 1단의 결과(파티 id · 캐릭터 id)가 있어야
 *        범위를 정할 수 있고, 서로는 남이라 **같은 단에 나란히** 올린다.
 *
 * ★ 2단을 1단과 합치지 않은 이유: 그러면 파티 번호를 **그 주차 전체**에서 읽어야 한다.
 *   남의 파티 번호까지 서버 메모리로 끌어오는 셈이고(응답에 나가지는 않지만 읽을 이유가
 *   없다), 방이 늘수록 그 낭비가 커진다. 한 단 늘리는 값보다 비싸다.
 */
export async function fetchMyTimetable(
  userId: string,
  weekKey: WeekKey,
): Promise<readonly TimetableRun[]> {
  const db = getAdminDb();

  const signups = unwrap(
    await db
      .from("run_signups")
      /*
        ★ 선택 문자열은 **리터럴이어야 한다.** 배열을 `join` 으로 이어 붙이면
          PostgREST 타입 추론이 통째로 죽어(`GenericStringError`) 임베딩 필드가
          전부 `any` 도 아닌 오류 타입이 된다.
        ★ `!inner` — 내 참가자 행이 아닌 것, 취소된 런은 부모까지 걸러 낸다.
      */
      .select(
        "character_id,party_participants!inner(user_id,character_id,left_at,party_id),party_runs!inner(id,party_id,scheduled_at,duration_minutes,week_key,cancelled_at,status,boss_difficulties!inner(id,korean_name,difficulty,short_name),parties!inner(name))",
      )
      .eq("status", "going")
      .eq("party_participants.user_id", userId)
      .is("party_participants.left_at", null)
      .eq("party_runs.week_key", weekKey)
      .is("party_runs.cancelled_at", null)
      .neq("party_runs.status", "cancelled"),
    "내 주간 일정 조회",
  );

  const partyIds = [
    ...new Set(
      signups.flatMap((row) =>
        row.party_runs === null ? [] : [row.party_runs.party_id],
      ),
    ),
  ];

  /*
    캐릭터 이름은 **런 지정 → 파티 지정** 순으로 떨어진다. DB 함수
    `run_participant_names` 의 `coalesce(s.character_id, pp.character_id)` 와 같은 순서다 —
    이 규칙이 화면마다 다르면 같은 사람이 어떤 화면에서는 "미지정"으로 보인다(2026-08-20 사고).
  */
  const characterIds = [
    ...new Set(
      signups.flatMap((row) => {
        const resolved = row.character_id ?? row.party_participants?.character_id;
        return typeof resolved === "string" ? [resolved] : [];
      }),
    ),
  ];

  const [numbers, characters] = await Promise.all([
    partyIds.length === 0
      ? Promise.resolve([])
      : (async () =>
          unwrap(
            await db
              .from("party_room_numbers")
              .select("party_id,party_no")
              .eq("week_key", weekKey)
              .in("party_id", partyIds),
            "파티 번호 조회",
          ))(),
    characterIds.length === 0
      ? Promise.resolve([])
      : (async () =>
          unwrap(
            await db
              .from("characters")
              .select("id,character_name")
              .in("id", characterIds),
            "캐릭터 이름 조회",
          ))(),
  ]);

  const characterNameById = new Map(
    characters.map((row) => [row.id, row.character_name]),
  );

  const partyNoById = new Map(numbers.map((row) => [row.party_id, row.party_no]));

  return signups
    .flatMap((row): readonly TimetableRun[] => {
      const run = row.party_runs;
      const boss = run?.boss_difficulties;
      const party = run?.parties;
      // 시각 미정은 격자에 놓을 자리가 없다(머리말).
      if (run === null || boss === null || party === null) return [];
      if (run.scheduled_at === null) return [];

      const resolvedCharacterId =
        row.character_id ?? row.party_participants?.character_id ?? null;

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
            resolvedCharacterId === null
              ? null
              : (characterNameById.get(resolvedCharacterId) ?? null),
        },
      ];
    })
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
}
