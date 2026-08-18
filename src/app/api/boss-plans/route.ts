import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchCharacterPlanBundle,
  resetCharacterBossPlanToApi,
  setCharacterBossPlan,
} from "@/features/boss-plans/server/boss-plan-repo";
import type { CharacterPlanResponse } from "@/features/boss-plans/types";

/**
 * 캐릭터별 "매주 가는 보스" 계획 (DB-SCHEMA 난제 16).
 *
 * `GET    /api/boss-plans?characterId=…`                      — 계획 + 이번 주 진행 상황
 * `PUT    /api/boss-plans`                                     — 켜기/끄기
 * `DELETE /api/boss-plans?characterId=…&bossDifficultyId=…`    — 내 판단 지우기(인게임 기준으로)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 전부 Route Handler 를 거치는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 테이블·뷰·함수가 **전부 service_role 전용**이다(마이그레이션 19-10 — anon/authenticated
 * 는 `REVOKE ALL`). 브라우저에서 Supabase 를 직접 부를 방법이 없고, 열람 범위("본인만")는
 * `can_view_character_plans()` 가 판정하며 repo 가 그것을 강제한다.
 *
 * ★ **13번째 주간 보스 켜기는 막힌다** (발주자 지시, 2026-08-18). 2025-08-21 패치 이후
 *   13번째는 입장 자체가 불가능하므로(§1) 켜 봐야 갈 수 없다. 판정과 문구는 repo 의
 *   `assertWeeklyPlanSlotAvailable()` 한 곳에 있고 여기서는 그 `ApiError` 를 그대로 흘린다 —
 *   라우트에 규칙을 다시 적으면 봇 경로와 갈라진다. **월간은 그 12에 들어가지 않고**,
 *   **끄기는 언제나 통과하며**, 이미 넘어 있는 계획을 강제로 잘라내지도 않는다.
 *
 * ★ **DELETE 는 "삭제"가 아니다.** 행을 지우면 다음 동기화가
 *   `registration_flag = true` 를 보고 되살리므로(발주자 보고, 2026-08-18) 목록에서 빼는
 *   일은 `PUT { active: false }` 가 맡는다 — `manual_active = false` 라는 묘비가 남아
 *   동기화가 이길 수 없다. DELETE 는 **내 판단을 지우고 인게임 목록에 맡기는** 경로이며,
 *   그래서 넥슨이 등록 중인 보스는 **다시 나타나는 것이 정상**이다.
 */

const characterIdSchema = z.uuid("캐릭터 식별자 형식이 올바르지 않습니다.");
const bossDifficultyIdSchema = z
  .string()
  .trim()
  .min(1, "보스 항목이 필요합니다.")
  .max(64, "보스 항목 형식이 올바르지 않습니다.");

const setPlanSchema = z.object({
  characterId: characterIdSchema,
  bossDifficultyId: bossDifficultyIdSchema,
  active: z.boolean(),
});

function requireCharacterId(request: Request): string {
  const raw = new URL(request.url).searchParams.get("characterId") ?? "";
  const parsed = characterIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest("캐릭터를 지정해 주세요.");
  }
  return parsed.data;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const characterId = requireCharacterId(request);
    const bundle = await fetchCharacterPlanBundle(session.uid, characterId);
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans#GET");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setPlanSchema);
    const bundle = await setCharacterBossPlan(
      session.uid,
      body.characterId,
      body.bossDifficultyId,
      body.active,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans#PUT");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const characterId = requireCharacterId(request);
    const rawBoss =
      new URL(request.url).searchParams.get("bossDifficultyId") ?? "";
    const parsedBoss = bossDifficultyIdSchema.safeParse(rawBoss);
    if (!parsedBoss.success) {
      throw ApiError.badRequest("설정을 되돌릴 보스 항목을 지정해 주세요.");
    }

    const bundle = await resetCharacterBossPlanToApi(
      session.uid,
      characterId,
      parsedBoss.data,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans#DELETE");
  }
}
