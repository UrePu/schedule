import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  PartyBossesResponse,
  PartyBossesSaveResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  fetchPartyBosses,
  setPartyBosses,
} from "@/features/schedule/server/schedule-repo";
/*
 * ★ 소요 시간 경계는 **리터럴로 적지 않는다**(2026-10-11 — 상한을 600 → 20 으로 내리면서
 *   다섯 벌로 복사돼 있던 숫자를 한 곳으로 모았다). 주인은 환경 중립 모듈이다.
 */
import {
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
} from "@/lib/domain/run-grouping";

/**
 * `GET /api/schedule/parties/{partyId}/bosses` — 이 파티가 묶어서 도는 보스 목록
 * `PUT /api/schedule/parties/{partyId}/bosses` — 목록 **전체 교체**(세션 필요)
 *
 * 발주 요구(원문): *"파티 정보 자체에 보스가 등록된다. 같은 파티에 보스가 여러개
 * 있을수도있고 추가될수도있고 삭제될수도있다."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 추가/삭제 API 를 따로 두지 않았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 순서가 의미를 갖는 목록이라(제목이 그 순서로 만들어진다) 부분 갱신으로 시작하면
 * "3번을 지우고 5번을 2번 자리로" 같은 요청이 곧바로 필요해진다. 화면은 이미 최종
 * 목록을 손에 들고 있으므로 그것을 그대로 보내는 편이 규칙이 하나로 남는다 —
 * `PUT /api/schedule/availability/patterns` 와 같은 판단이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 응답으로 돌려준다 (+ 제목이 바뀐 파티도 함께)
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ★ **읽기는 비로그인도 200 이다.** 공개 파티라면 "무엇을 도는 묶음인가"가 보여야
 *   공개할 이유가 생긴다. 볼 수 없는 파티는 404(존재 여부도 알리지 않는다).
 * ★ 마이그레이션 `20260818120000` 미적용 DB 에서는 읽기가 **빈 배열**이고 쓰기는
 *   "마이그레이션을 적용해 주세요"라는 400 이다. 500 이면 로그에만 남아 아무도 못 고친다.
 */

/**
 * `boss_difficulties.id` 는 `^[a-z0-9][a-z0-9_]{0,59}$` 로 CHECK 돼 있다.
 * 여기서 걸러야 사용자가 한국어 문구를 받는다.
 */
const bossDifficultyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{0,59}$/, "보스 식별자 형식이 올바르지 않습니다.");

const setBossesSchema = z
  .object({
    /**
     * 배열 **순서가 곧 표시·연속 배치 순서**다. 빈 배열은 "전부 지운다"이며 정상 입력이다.
     * 상한 24 는 DB 함수 `set_party_bosses` 의 상한과 **같은 경계**다.
     */
    bossDifficultyIds: z
      .array(bossDifficultyIdSchema)
      .max(24, "파티에 등록할 수 있는 보스는 24개까지입니다."),
    /**
     * 보스별 소요 시간(분). `bossDifficultyIds` 와 **같은 자리끼리 짝**이며 원소 `null` 은
     * "이 보스는 정하지 않음"이다(발주 지시 2026-10-11 — *"파티관리에서도 확인 및 수정이
     * 가능해야함"*).
     *
     * ★ **필드를 아예 보내지 않으면 기존 값이 보존된다.** 보스 목록만 저장하는 화면(보스를
     *   고르거나 순서를 바꾸는 창)은 보스당 소요 시간을 들고 있지 않으므로 이 모양이 필요
     *   하다. 보존이 없으면 그런 저장마다 사용자가 건드리지도 않은 값이 날아간다.
     *   ⚠️ 2026-10-11 정정 — 처음에는 근거로 *"로스터 저장 경로가 소요 시간을 모른다"* 를
     *      댔는데 `updatePartyRoster` 는 `party_bosses` 를 건드리지 않는다. 사건은 실재하고
     *      주체가 **그 창이 따로 보내는 이 PUT** 이다(경위:
     *      `schedule-repo.writePartyBosses` 머리말).
     * ★ ⚠️ 세 입력이 **전부 다른 뜻**이다. 생략 = 보존 · `[null,…]` = **전부 지움**(원소
     *   null 이 "정하지 않음"이라 배열을 준 것은 "전부 말했다"는 뜻) · `[]` = 보스 0개.
     *   화면이 "아직 안 적은 칸"을 null 로 채워 보내면 저장마다 값이 날아간다.
     * ★ 1~20 은 `party_runs.duration_minutes` · `party_bosses.duration_minutes` 의 DB
     *   CHECK 와 **같은 경계**다. 여기서 걸러야 사용자가 한국어 문구를 받는다 — DB 까지
     *   내려가면 Postgres 영문 제약 위반이 되고 앱이 500 으로 접는다.
     *   ⚠️ 상한은 2026-10-11 에 600 → **20** 으로 내려왔다(발주 정정: *"보스 하나당
     *      최대시간이 20분"*). 재는 것은 **한 판**이고, 묶어 도는 한 덩이의 길이는 이
     *      값들의 **합**이라 60분 묶음은 그대로 표현된다.
     */
    durationMinutes: z
      .array(
        z
          .number({ error: "소요 시간 형식이 올바르지 않습니다." })
          .int("소요 시간은 정수(분)여야 합니다.")
          .min(
            RUN_DURATION_MIN,
            `소요 시간은 ${String(RUN_DURATION_MIN)}분 이상이어야 합니다.`,
          )
          .max(
            RUN_DURATION_MAX,
            `소요 시간은 ${String(RUN_DURATION_MAX)}분을 넘을 수 없습니다.`,
          )
          .nullable(),
      )
      .max(24)
      .optional(),
  })
  .refine(
    (value) =>
      value.durationMinutes === undefined ||
      value.durationMinutes.length === value.bossDifficultyIds.length,
    {
      /*
        길이가 다르면 **거절한다.** 짧은 쪽을 맞추면 어느 보스의 시간인지 한 칸씩
        어긋나고, 그 어긋남은 화면에 그럴듯하게 그려져 아무도 알아채지 못한다.
        DB 함수도 같은 이유로 예외를 던진다 — 두 경계가 같은 판정을 한다.
      */
      message: "보스 개수와 소요 시간 개수가 다릅니다.",
    },
  );

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    const bosses = await fetchPartyBosses(session?.uid ?? null, partyId);
    return jsonOk<PartyBossesResponse>({ bosses });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/bosses#GET");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, setBossesSchema);
    const result = await setPartyBosses(session.uid, {
      partyId,
      bossDifficultyIds: body.bossDifficultyIds,
      // `undefined` 를 그대로 넘긴다 — DB 가 기존 소요 시간을 보존하는 신호다.
      ...(body.durationMinutes !== undefined
        ? { durationMinutes: body.durationMinutes }
        : {}),
    });
    return jsonOk<PartyBossesSaveResponse>(result);
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/bosses#PUT");
  }
}
