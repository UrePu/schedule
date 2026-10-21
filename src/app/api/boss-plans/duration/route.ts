import { z } from "zod";

import {
  handleRouteError,
  jsonOk,
  readJsonBody,
  ApiError,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { setCharacterBossPlanDuration } from "@/features/boss-plans/server/boss-plan-repo";
import type { CharacterPlanResponse } from "@/features/boss-plans/types";
import { RUN_DURATION_MAX, RUN_DURATION_MIN } from "@/lib/domain/run-grouping";

/**
 * 보스 계획의 **캐릭터별 소요 시간** (마이그레이션 `20261021130000_character_boss_plan_durations.sql`).
 *
 * `PUT /api/boss-plans/duration` — "이 캐릭터는 이 보스를 N분에 돈다"를 정한다.
 * `durationMinutes = null` = **기본값으로 되돌리기**(입력칸을 비웠을 때).
 *
 * 발주(2026-10-21): *"캐릭별 보스 관리에서 시간 수정 할수 있게. 기본값을 넣어주고 사람이
 * 수정하면 수정되도록."* 기본값은 행에 박지 않고 코드가 계산한다
 * (`@/lib/domain/boss-duration-estimate`).
 *
 * 왜 `party-size` 처럼 따로 두나: 켜기/끄기(`PUT /api/boss-plans`)와 다른 축이고, DB 함수도
 * 한 컬럼만 쓰도록 갈라 두었다 — 경로를 합치면 그 분리가 API 표면에서 사라진다.
 *
 * 규약은 다른 쓰기 API 와 같다: 세션 → 본문 검증(한국어 400) → 바뀐 뒤의 캐릭터 계획 전체
 * 응답 → `handleRouteError`.
 */

const setDurationSchema = z.object({
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
  bossDifficultyId: z
    .string()
    .trim()
    .min(1, "보스 항목이 필요합니다.")
    .max(64, "보스 항목 형식이 올바르지 않습니다."),
  /* 범위는 DB CHECK 와 같은 경계다(숫자의 주인은 `run-grouping`). 여기서 걸러야 한국어 문구가 난다. */
  durationMinutes: z
    .number()
    .int("소요 시간은 정수여야 합니다.")
    .min(RUN_DURATION_MIN, `소요 시간은 ${String(RUN_DURATION_MIN)}분 이상이어야 합니다.`)
    .max(RUN_DURATION_MAX, `소요 시간은 ${String(RUN_DURATION_MAX)}분 이하여야 합니다.`)
    .nullable(),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setDurationSchema);
    const bundle = await setCharacterBossPlanDuration(
      session.uid,
      body.characterId,
      body.bossDifficultyId,
      body.durationMinutes,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/duration#PUT");
  }
}
