import { z } from "zod";

import { loadSessionUser } from "@/features/auth/server/account";
import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { SaveTrackedCharactersResponse } from "@/features/characters/data/character-queries";
import { getAdminDb } from "@/lib/supabase/admin-db";

import { loadTrackableCharacters } from "../route";

/**
 * `PUT /api/characters/tracked`
 *
 * 본문 `{ characterIds: string[], mainCharacterId: string | null }`
 * 응답 `{ characters, user }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 라우트가 지키는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * - **세션 필수.** 브라우저는 `characters` 를 직접 쓸 수 없다(인증 모델 (c) — anon 전면
 *   차단). 추적 대상이 바뀌는 경로는 여기 하나뿐이다.
 * - **남의 캐릭터를 섞을 수 없다.** 넘어온 id 가 전부 이 사용자 소유인지 확인한다.
 *   확인을 빼면 `is_tracked` 를 남의 행에 켜 주는 셈이 된다.
 * - **본캐는 반드시 추적 대상.** 표시 정체성이 본캐 닉네임이라(§2.1) 추적하지 않는
 *   본캐는 성립하지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 쓰기 순서가 중요하다 — `characters_one_main_per_user`
 * ─────────────────────────────────────────────────────────────────────────────
 * `characters (user_id) where is_main` 에 **부분 유니크 인덱스**가 걸려 있다. 새 본캐를
 * 먼저 켜면 옛 본캐와 두 행이 동시에 true 가 되는 순간이 생겨 유니크 위반으로 죽는다.
 *   → **전부 false 로 내린 뒤 하나만 true 로 올린다.** 순서를 뒤집으면 실패한다.
 *
 * `app_users.main_character_name` / `main_world_name` 은 **직접 쓰지 않는다.**
 * `characters_sync_main_identity` 트리거가 `is_main = true` 인 행을 보고 스냅샷과
 * 주 키(primary credential)를 함께 옮긴다. 앱이 같은 일을 또 하면 두 진실이 갈라진다.
 *
 * ⚠️ 그 트리거는 `is_main` 이 **켜질 때만** 동작한다. 그래서 본캐를 아예 비우면
 *    (`mainCharacterId: null`) 예전 본캐 닉네임 스냅샷이 그대로 남는다. 이름이 사라져
 *    계정이 무명이 되는 것보다 마지막 이름이 남는 편이 낫다고 보고 그대로 둔다.
 */

/**
 * 상한 500: 실측 계정이 59명이고 이론상 더 많을 수 있으므로 넉넉하되, 무한한 배열을
 * 그대로 받아 `in (...)` 에 넣지는 않는다.
 */
const trackedBodySchema = z.object({
  characterIds: z
    .array(z.uuid("캐릭터 식별자 형식이 올바르지 않습니다."))
    .max(500, "한 번에 저장할 수 있는 캐릭터 수를 넘었습니다."),
  // 없으면 "본캐 미지정"으로 본다. 명시적 null 과 같은 뜻이다.
  mainCharacterId: z.uuid("본캐 식별자 형식이 올바르지 않습니다.").nullish(),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, trackedBodySchema);
    // 중복이 들어와도 결과는 같아야 한다. 여기서 한 번만 접는다.
    const characterIds = [...new Set(body.characterIds)];
    const mainCharacterId = body.mainCharacterId ?? null;

    if (mainCharacterId !== null && !characterIds.includes(mainCharacterId)) {
      throw ApiError.badRequest("본캐는 추적 대상에 포함되어야 합니다.");
    }

    const db = getAdminDb();
    const userId = session.uid;

    // 정지/삭제 계정은 쓰기 전에 막는다. 서명 쿠키는 즉시 폐기가 안 되므로
    // (`server/session.ts`) 계정 상태 확인이 그 구멍을 메우는 자리다.
    const { data: userRow, error: userError } = await db
      .from("app_users")
      .select("status, deleted_at")
      .eq("id", userId)
      .maybeSingle();
    if (userError !== null) throw userError;
    if (
      userRow === null ||
      userRow.deleted_at !== null ||
      userRow.status !== "active"
    ) {
      throw ApiError.accountUnavailable();
    }

    // 소유 확인 — 넘어온 id 가 전부 이 사용자 것인가.
    const { data: ownedRows, error: ownedError } = await db
      .from("characters")
      .select("id")
      .eq("user_id", userId);
    if (ownedError !== null) throw ownedError;

    const ownedIds = new Set((ownedRows ?? []).map((row) => row.id));
    const foreign = characterIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw ApiError.badRequest(
        "이 계정의 캐릭터가 아닌 항목이 포함되어 있습니다. 목록을 새로 불러와 주세요.",
      );
    }

    // (1) 전부 내린다. `is_main` 을 먼저 비워야 부분 유니크 인덱스에 걸리지 않는다.
    const { error: resetError } = await db
      .from("characters")
      .update({ is_tracked: false, is_main: false })
      .eq("user_id", userId);
    if (resetError !== null) throw resetError;

    // (2) 고른 것만 올린다. 빈 선택(전부 해제)도 정상 입력이다.
    if (characterIds.length > 0) {
      const { error: trackError } = await db
        .from("characters")
        .update({ is_tracked: true })
        .eq("user_id", userId)
        .in("id", characterIds);
      if (trackError !== null) throw trackError;
    }

    // (3) 본캐 하나. `user_id` 조건을 함께 거는 것은 소유 확인의 마지막 이중 방어다.
    if (mainCharacterId !== null) {
      const { error: mainError } = await db
        .from("characters")
        .update({ is_main: true })
        .eq("user_id", userId)
        .eq("id", mainCharacterId);
      if (mainError !== null) throw mainError;
    }

    const [characters, user] = await Promise.all([
      loadTrackableCharacters(db, userId),
      loadSessionUser(db, userId),
    ]);
    if (user === null) throw ApiError.accountUnavailable();

    return jsonOk<SaveTrackedCharactersResponse>({ characters, user });
  } catch (error) {
    return handleRouteError(error, "api/characters/tracked#PUT");
  }
}
