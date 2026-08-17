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
  removeCharacterBossPlan,
  setCharacterBossPlan,
} from "@/features/boss-plans/server/boss-plan-repo";
import type { CharacterPlanResponse } from "@/features/boss-plans/types";

/**
 * 캐릭터별 "매주 가는 보스" 계획 (DB-SCHEMA 난제 16).
 *
 * `GET    /api/boss-plans?characterId=…`                      — 계획 + 이번 주 진행 상황
 * `PUT    /api/boss-plans`                                     — 켜기/끄기
 * `DELETE /api/boss-plans?characterId=…&bossDifficultyId=…`    — 목록에서 삭제
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 전부 Route Handler 를 거치는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 테이블·뷰·함수가 **전부 service_role 전용**이다(마이그레이션 19-10 — anon/authenticated
 * 는 `REVOKE ALL`). 브라우저에서 Supabase 를 직접 부를 방법이 없고, 열람 범위("본인만")는
 * `can_view_character_plans()` 가 판정하며 repo 가 그것을 강제한다.
 *
 * ★ **12개 초과를 여기서 막지 않는다.** DB 도 막지 않는다(난제 16-3) — 계획은 탐색적이라
 *   후보를 올려 두고 끄는 과정을 지나기 때문이다. 초과는 뷰의 `weekly_over_limit` 으로
 *   화면이 **경고만** 한다.
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
      throw ApiError.badRequest("삭제할 보스 항목을 지정해 주세요.");
    }

    const bundle = await removeCharacterBossPlan(
      session.uid,
      characterId,
      parsedBoss.data,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans#DELETE");
  }
}
