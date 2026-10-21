import { z } from "zod";

import {
  handleRouteError,
  jsonOk,
  readJsonBody,
  ApiError,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import { setCharacterBossPlanDurations } from "@/features/boss-plans/server/boss-plan-repo";
import type { CharacterPlanResponse } from "@/features/boss-plans/types";
import { RUN_DURATION_MAX, RUN_DURATION_MIN } from "@/lib/domain/run-grouping";

/**
 * `PUT /api/boss-plans/duration/bulk` — 한 캐릭터의 **여러 보스 소요 시간**을 한 번에 정한다.
 *
 * 발주(2026-10-21): *"아예 총 진행시간을 입력하면 알아서 분배해주는 기능을 넣어주던가"*.
 * 부르는 화면이 둘이다 — 총 시간 나누기(배율 역수 비율, `@/lib/domain/boss-duration-distribute`)
 * 와 "나머지 보스도 이 기준으로 맞추기"(솔로 한 줄 기준, `estimateCharacterDurations`).
 * 둘 다 화면이 미리보기로
 * 보여 준 뒤 그 결과를 그대로 보낸다. 여기는 단건 경로(`../route.ts`)와 같은 검증을 보스마다
 * 하고 같은 SQL 함수로 저장한다.
 *
 * 규약은 다른 쓰기 API 와 같다: 세션 → 본문 검증(한국어 400) → 바뀐 뒤의 캐릭터 계획 전체
 * 응답 → `handleRouteError`.
 */

/** 한 캐릭터의 계획은 많아야 수십 개다. 그보다 큰 본문은 실수이거나 남용이다. */
const MAX_ITEMS = 64;

const itemSchema = z.object({
  bossDifficultyId: z
    .string()
    .trim()
    .min(1, "보스 항목이 필요합니다.")
    .max(64, "보스 항목 형식이 올바르지 않습니다."),
  /* 범위는 DB CHECK 와 같은 경계다(숫자의 주인은 `run-grouping`). 단건 경로와 같은 문구. */
  durationMinutes: z
    .number()
    .int("소요 시간은 정수여야 합니다.")
    .min(RUN_DURATION_MIN, `소요 시간은 ${String(RUN_DURATION_MIN)}분 이상이어야 합니다.`)
    .max(RUN_DURATION_MAX, `소요 시간은 ${String(RUN_DURATION_MAX)}분 이하여야 합니다.`)
    .nullable(),
});

const setDurationsSchema = z.object({
  characterId: z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."),
  items: z
    .array(itemSchema)
    .min(1, "저장할 보스가 없습니다.")
    .max(MAX_ITEMS, `한 번에 ${String(MAX_ITEMS)}개까지 저장할 수 있습니다.`)
    .refine(
      (items) =>
        new Set(items.map((item) => item.bossDifficultyId)).size === items.length,
      "같은 보스가 두 번 들어 있습니다.",
    ),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setDurationsSchema);
    const bundle = await setCharacterBossPlanDurations(
      session.uid,
      body.characterId,
      body.items,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/duration/bulk#PUT");
  }
}
