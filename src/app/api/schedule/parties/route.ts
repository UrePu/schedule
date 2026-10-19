import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  PartiesResponse,
  PartyResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  createParty,
  fetchParties,
} from "@/features/schedule/server/schedule-repo";

/**
 * `GET  /api/schedule/parties` — 볼 수 있는 파티 목록
 * `POST /api/schedule/parties` — 새 파티(세션 필요)
 *
 * ★ **읽기는 비로그인도 200 이다.** 공개 파티만 담겨 나오며 빈 배열일 수 있다.
 *   401 로 접으면 "비로그인도 공개 시간표를 본다"는 요구(CLAUDE.md §2.1)가 무너지고,
 *   TanStack Query 가 에러 상태로 떨어져 화면이 오류 화면이 된다.
 * ★ **쓰기는 세션이 없으면 401.** 그게 "이 파티는 이 사람 것"을 성립시키는 유일한 근거다.
 */

const personIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "사람 식별자 형식이 올바르지 않습니다.",
  );

/**
 * 닉네임만으로 넣는 사람 (§ 발주 요구 — "그냥 닉네임만으로도 파티 만들수있게 해야함").
 *
 * 경계는 DB CHECK(`guest_profiles.display_name` 1~40자)와 **같은 값**이다. 여기서 걸러야
 * 사용자가 한국어 문구를 받는다 — DB 까지 내려가면 Postgres 의 영어 제약 위반 메시지가
 * 나고, 그 메시지는 `unwrap` 이 500 으로 접어 버린다.
 */
const guestNameSchema = z
  .string()
  .trim()
  .min(1, "닉네임을 입력해 주세요.")
  .max(40, "닉네임은 40자 이하여야 합니다.");

const createPartySchema = z.object({
  // 비어 있어도 된다 — repo 가 구성원 이름으로 요약해 채운다(`우레푸 외 3명`).
  name: z.string().max(60, "파티 이름은 60자 이하여야 합니다."),
  memberPersonIds: z
    .array(personIdSchema)
    .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
  guestNames: z
    .array(guestNameSchema)
    .max(24, "한 번에 추가할 수 있는 게스트는 24명까지입니다.")
    .optional(),
  /**
   * `guestNames` 중 **동명이인으로 새로 만들라**고 사용자가 고른 이름 (2026-10-19).
   *
   * 여기 없는 이름은 서버가 후보 안의 같은 이름 게스트를 **재사용**한다 — 같은 생성
   * 요청이 두 번 들어와도 게스트가 두 벌 생기지 않게 하는 장치다(실측 중복 5건이
   * 3~5초 간격의 재제출이었다). `guestNames` 의 부분집합이 아니어도 **거르지 않는다**:
   * 서버가 교집합만 쓰므로 무해하고, 400 으로 접으면 화면의 사소한 불일치가 저장을
   * 통째로 막는다.
   */
  forceNewGuestNames: z
    .array(guestNameSchema)
    .max(24, "한 번에 추가할 수 있는 게스트는 24명까지입니다.")
    .optional(),
  /**
   * 이 파티가 묶어서 도는 보스. **순서가 곧 제목의 순서**다(`익세 하대 하카 2인`).
   *
   * 만들 때 함께 받는 이유는 제목이 여기서 나오기 때문이다 — 나중에 등록하게 하면
   * 파티가 잠깐 `우레푸 외 2명` 이라는 이름으로 존재했다가 바뀐다.
   */
  bossDifficultyIds: z
    .array(
      z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9_]{0,59}$/,
          "보스 식별자 형식이 올바르지 않습니다.",
        ),
    )
    .max(24, "파티에 등록할 수 있는 보스는 24개까지입니다.")
    .optional(),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    const parties = await fetchParties(session?.uid ?? null);
    return jsonOk<PartiesResponse>({ parties });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties#GET");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, createPartySchema);
    const party = await createParty(session.uid, {
      name: body.name,
      memberPersonIds: body.memberPersonIds,
      guestNames: body.guestNames,
      forceNewGuestNames: body.forceNewGuestNames,
      bossDifficultyIds: body.bossDifficultyIds,
    });
    return jsonOk<PartyResponse>({ party }, 201);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties#POST");
  }
}
