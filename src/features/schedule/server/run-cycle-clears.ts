import "server-only";

import { ApiError } from "@/features/auth/server/http";
import { sameBossClearSiblingsOf } from "@/lib/domain/same-boss-clear";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";

import {
  isRunClearedElsewhere,
  type CycleClearFacts,
  type RunCycleTarget,
} from "../lib/run-clear-relation";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "이 캐릭터가 이번 주기에 그 보스를 깼는가" — **조회는 여기 하나다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 읽는 곳이 셋이다: 웹 시간표(`timetable-repo`) · 카톡 `!일정`(`bot-repo.fetchMyRuns`) · 일정 상세의
 * 캐릭터 후보(`schedule-repo`). 두 벌이 되면 웹과 봇이 다른 말을 한다 — 봇 쪽 머리말이 이미 경고한다.
 * 판정(순수 함수)은 `lib/run-clear-relation.ts` 가 소유하고, 여기는 재료만 모은다.
 *
 * ★ 왕복 한 번이다. 주간이면 그 주차로 충분하지만 월간은 **그 달 전체**를 봐야 해서 가장 이른 런의
 *   달부터 넓게 읽고, 정확히 가르는 일은 `isClearInRunCycle` 이 한다. 주는 달을 넘나들 수 있다.
 * ⚠️ 켜진 행만 읽는다. 사람이 해제한 행은 "깼다" 가 아니다.
 * ⚠️ 읽기 실패는 던진다. 남의 돈을 지키는 판정(N1)이 이 값을 쓰므로 "모르면 통과" 로 접으면 안 된다.
 *    봇처럼 **표시만** 하는 쪽은 부르는 곳에서 잡는다.
 */
export async function loadCycleClears(
  db: AdminDb,
  ownerUserId: string,
  characterIds: readonly string[],
  runs: readonly RunCycleTarget[],
): Promise<readonly CycleClearFacts[]> {
  const ids = [...new Set(characterIds)];
  const bossIds = [...new Set(runs.map((run) => run.bossDifficultyId))];
  if (ids.length === 0 || bossIds.length === 0) return [];

  const weekFilter = `week_key.in.(${[...new Set(runs.map((run) => run.weekKey))].join(",")})`;
  const earliestDay = runs
    .flatMap((run) =>
      run.scheduledAtIso === null ? [] : [kstDayKey(new Date(run.scheduledAtIso))],
    )
    .sort()[0];

  const { data, error } = await db
    .from("boss_clears")
    .select(
      "character_id,boss_difficulty_id,week_key,run_id,source,cleared_at,created_at,effective_cleared,manual_cleared",
    )
    .eq("user_id", ownerUserId)
    .eq("effective_cleared", true)
    .in("character_id", ids)
    .in("boss_difficulty_id", [...sameBossClearSiblingsOf(bossIds)])
    .or(
      earliestDay === undefined
        ? weekFilter
        : `${weekFilter},cleared_at.gte.${kstMoment(`${earliestDay.slice(0, 7)}-01`, 0).toISOString()}`,
    );
  if (error !== null) {
    console.error(`[run-cycle-clears] 이번 주기 클리어 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }
  return data ?? [];
}

/**
 * 내 런들 중 **데려가는 캐릭터가 그 보스를 이미 깼고 그 클리어가 이 일정의 것이 아닌** 런.
 *
 * 런 정보를 이미 들고 있는 시간표는 `loadCycleClears` + `isRunClearedElsewhere` 를 직접 쓰고, 런 id 만
 * 아는 봇은 이것을 쓴다(`user_week_runs` RPC 는 보스 id 도 캐릭터 id 도 돌려주지 않는다).
 *
 * ★ 캐릭터는 **런 지정 → 파티 기본값** 순이다 — 시간표의 `characterId` 와 같은 폴백이어야 웹과 봇이
 *   같은 런을 가리킨다.
 */
export async function loadRunIdsClearedElsewhere(
  db: AdminDb,
  userId: string,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();

  const { data, error } = await db
    .from("run_signups")
    .select(
      "run_id,character_id,party_participants!inner(user_id,left_at,character_id),party_runs!inner(boss_difficulty_id,scheduled_at,week_key)",
    )
    .in("run_id", [...runIds])
    .eq("party_participants.user_id", userId)
    .is("party_participants.left_at", null);
  if (error !== null) {
    console.error(`[run-cycle-clears] 내 런 조회 실패: ${error.message}`);
    throw ApiError.internal();
  }

  const targets = (data ?? []).flatMap((row): readonly RunCycleTarget[] => {
    const run = row.party_runs;
    if (run === null) return [];
    return [
      {
        runId: row.run_id,
        characterId: row.character_id ?? row.party_participants?.character_id ?? null,
        bossDifficultyId: run.boss_difficulty_id,
        scheduledAtIso: run.scheduled_at,
        weekKey:
          run.week_key ??
          getWeekKey(run.scheduled_at === null ? new Date() : new Date(run.scheduled_at)),
      },
    ];
  });

  const clears = await loadCycleClears(
    db,
    userId,
    targets.flatMap((target) =>
      target.characterId === null ? [] : [target.characterId],
    ),
    targets,
  );
  return new Set(
    targets
      .filter((target) => isRunClearedElsewhere(target, clears))
      .map((target) => target.runId),
  );
}
