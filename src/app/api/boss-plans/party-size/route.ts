import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  applyPlanPartySizesToClears,
  setCharacterBossPlanPartySize,
} from "@/features/boss-plans/server/boss-plan-repo";
import type {
  ApplyPlanPartySizeResult,
  CharacterPlanResponse,
} from "@/features/boss-plans/types";

/**
 * 보스 계획의 **기본 파티 인원수** (마이그레이션 21).
 *
 * `PUT  /api/boss-plans/party-size` — "이 보스는 N인으로 돈다"를 정한다 (`null` = 해제)
 * `POST /api/boss-plans/party-size` — 이미 쌓인 **미확인** 클리어에 그 값을 일괄 적용
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `../route.ts` 의 PUT 에 얹지 않았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 옆 파일의 `PUT /api/boss-plans` 는 계획을 **켜고 끄는** 경로다(`manual_active`).
 * 인원수는 그것과 다른 축이고, DB 쪽에서도 일부러 함수를 갈라 놓았다(마이그레이션 21-2) —
 * 한 함수가 둘을 함께 쓰면 "인원만 고쳤는데 보스가 켜지는" 사고가 실제로 가능해진다.
 * 경로를 합치면 그 분리가 API 표면에서 도로 사라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /api/schedule/availability/patterns` · `PUT /api/boss-plans` 와 동일하게
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 응답으로 준다 — 화면이 부분 갱신을 조립하지 않는다
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ★ **`max_party` 초과를 막지 않는다**(§1.3 D5). `max_party` 는 대부분 세대 규칙에서
 *   유도된 추정치라 CHECK 로 굳히면 진짜 파티를 거부한다. 그래서 서버가 검사하는 것은
 *   `boss_clears.party_size` / `party_runs.entry_party_size` 와 같은 **1~24** 뿐이고,
 *   초과는 화면이 주황 경고로 알린다.
 * ★ **소급 적용은 되돌릴 수 없다.** 그래서 `dryRun` 이 있고, 화면은 건수를 먼저 보여 주고
 *   확인을 받은 뒤에만 `dryRun: false` 로 부른다. 대상 판정은 DB 함수 하나에만 있어
 *   미리보기와 실행이 어긋날 수 없다.
 */

const characterIdSchema = z.uuid("캐릭터 식별자 형식이 올바르지 않습니다.");
const bossDifficultyIdSchema = z
  .string()
  .trim()
  .min(1, "보스 항목이 필요합니다.")
  .max(64, "보스 항목 형식이 올바르지 않습니다.");

/**
 * `null` 은 **설정 해제**다(미설정으로 되돌리기). 0 이 아니다 —
 * "정하지 않음"과 "1인"은 다른 상태이고, 합치면 §1.3 D3 의 과대 계상이 조용히 남는다.
 * 범위(1~24)는 DB CHECK 와 같은 경계를 그대로 옮긴 것이다. 여기서 걸러야 사용자가 한국어
 * 문구를 받는다 — DB 까지 내려가면 Postgres 의 영어 제약 위반 메시지가 난다.
 */
const setPartySizeSchema = z.object({
  characterId: characterIdSchema,
  bossDifficultyId: bossDifficultyIdSchema,
  partySize: z
    .number()
    .int("인원수는 정수여야 합니다.")
    .min(1, "인원수는 1명 이상이어야 합니다.")
    .max(24, "인원수는 24명 이하여야 합니다.")
    .nullable(),
});

const applySchema = z.object({
  characterId: characterIdSchema,
  /** 기본값을 `true`(미리보기)로 둔다 — 빠뜨렸을 때 되돌릴 수 없는 쪽으로 실패하지 않는다. */
  dryRun: z.boolean().default(true),
});

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setPartySizeSchema);
    const bundle = await setCharacterBossPlanPartySize(
      session.uid,
      body.characterId,
      body.bossDifficultyId,
      body.partySize,
    );
    return jsonOk<CharacterPlanResponse>(bundle);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/party-size#PUT");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, applySchema);
    const outcome = await applyPlanPartySizesToClears(
      session.uid,
      body.characterId,
      body.dryRun,
    );
    return jsonOk<ApplyPlanPartySizeResult>(outcome);
  } catch (error) {
    return handleRouteError(error, "api/boss-plans/party-size#POST");
  }
}
