import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  PartyRunResponse,
  PartyRunsResponse,
  ScheduledRunWire,
} from "@/features/schedule/data/schedule-queries";
import {
  createPartyRuns,
  fetchPartyRuns,
} from "@/features/schedule/server/schedule-repo";
import { addKstDays } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import type { ScheduledRun } from "@/types/domain";

/**
 * `GET  /api/schedule/parties/{partyId}/runs?weekKey=2026-W33` — 그 주차의 일정
 * `POST /api/schedule/parties/{partyId}/runs` — 일정 등록(세션 필요)
 *
 * ★ 주차 키는 **KST 목요일 00:00 경계**다(§1). 빠지면 서버의 "지금"으로 채운다.
 * ★ `Date` 는 JSON 으로 못 나가므로 `scheduledAt` 만 ISO 문자열로 내보낸다.
 *   클라이언트(`schedule-queries.ts`)가 `new Date(...)` 로 되돌린다.
 */

const WEEK_KEY_PATTERN = /^\d{4}-W\d{2}$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const personIdSchema = z
  .string()
  .regex(UUID_PATTERN, "사람 식별자 형식이 올바르지 않습니다.");

/**
 * ⚠️ 타입 오류 문구까지 한국어로 못박는다. `z.string()` 만 쓰면 **필드를 빼먹었을 때**
 *    zod 기본 영문("Invalid input: expected string, received undefined")이 그대로 화면에
 *    나간다 — `readJsonBody` 가 첫 issue 의 message 를 그대로 쓰기 때문이다.
 *    `.regex()` 의 문구는 형식이 틀렸을 때만 쓰이므로 누락을 덮지 못한다.
 */
const characterIdSchema = z
  .string({ error: "어느 캐릭터로 갈지 선택해 주세요." })
  .regex(UUID_PATTERN, "캐릭터 식별자 형식이 올바르지 않습니다.");

/**
 * 보스는 **배열**로 받는다 — "보통 묶어서 가니 등록된 보스를 체크해서 시간대를 등록"
 * (발주 원문). 단수 `bossDifficultyId` 도 계속 받는데, 계획 화면의 일정 만들기 모달이
 * 그 모양으로 보내고 있기 때문이다. **저장 경로는 하나**(`createPartyRuns`)라 두 입력이
 * 다르게 동작할 여지는 없다.
 */
const createRunSchema = z
  .object({
    bossDifficultyId: z.string().min(1).max(64).optional(),
    bossDifficultyIds: z
      .array(z.string().min(1).max(64))
      .max(24, "한 번에 등록할 수 있는 보스는 24개까지입니다.")
      .optional(),
    scheduledAt: z.string().min(1, "일정 시각이 필요합니다."),
    durationMinutes: z.number().int().min(5).max(600),
    entryPartySize: z.number().int().min(1).max(24),
    participantPersonIds: z.array(personIdSchema).max(24),
    /**
     * ★ **필수다.** 결정석 12개 상한이 캐릭터당이라(§1) 캐릭터 없는 일정은 수익 계산에
     *   들어갈 수 없다. 소유·추적 검증은 repo 가 하며 남의 캐릭터는 400 이다.
     */
    characterId: characterIdSchema,
    note: z.string().max(500).nullable(),
    /**
     * **고정팟** — 이번 주를 포함해 몇 주치를 같은 요일·시각으로 잡을 것인가
     * (2026-08-19 발주자: *"매주 같은시간에 가는 파티도 있어"*).
     *
     * 상한 8주는 임의가 아니라 **되돌리는 비용**에서 나왔다. 반복은 행으로 펼쳐지므로
     * 취소하려면 한 건씩 지워야 하고, 보스 4개 × 8주면 이미 32건이다.
     */
    repeatWeeks: z
      .number({ error: "반복 주 수 형식이 올바르지 않습니다." })
      .int("반복 주 수는 정수여야 합니다.")
      .min(1, "반복 주 수는 1 이상이어야 합니다.")
      .max(8, "한 번에 잡을 수 있는 것은 8주치까지입니다.")
      .optional(),
  })
  .refine(
    (value) =>
      (value.bossDifficultyIds?.length ?? 0) > 0 ||
      value.bossDifficultyId !== undefined,
    { message: "등록할 보스를 하나 이상 선택해 주세요." },
  );

function toWire(run: ScheduledRun): ScheduledRunWire {
  return { ...run, scheduledAt: run.scheduledAt?.toISOString() ?? null };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const requested = new URL(request.url).searchParams.get("weekKey");
    if (requested !== null && !WEEK_KEY_PATTERN.test(requested)) {
      throw ApiError.badRequest("주차 키 형식이 올바르지 않습니다.");
    }
    const weekKey = requested ?? getWeekKey(new Date());

    const session = await readSession();
    const runs = await fetchPartyRuns(session?.uid ?? null, partyId, weekKey);
    return jsonOk<PartyRunsResponse>({ runs: runs.map(toWire) });
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/runs#GET");
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, createRunSchema);
    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw ApiError.badRequest("일정 시각을 해석할 수 없습니다.");
    }

    /*
      배열이 오면 그대로, 단수만 오면 길이 1 배열로. **저장은 한 함수**를 지난다 —
      경로가 둘이면 "묶음일 때만 생기는 버그"가 반드시 나온다.
    */
    const bossDifficultyIds =
      body.bossDifficultyIds !== undefined && body.bossDifficultyIds.length > 0
        ? body.bossDifficultyIds
        : body.bossDifficultyId === undefined
          ? []
          : [body.bossDifficultyId];

    /*
      ── 고정팟 ────────────────────────────────────────────────────────────────
      반복은 **행으로 펼친다**(규칙 저장이 아니다 — `CreateRunBundleInput.repeatWeeks`
      주석). 주차마다 `createPartyRuns` 를 그대로 부르므로 검증·번호 부여·알림이
      1주치와 **완전히 같은 경로**를 지난다. 반복 전용 분기를 만들면 "반복일 때만 나는
      버그"가 반드시 생긴다.

      ⚠️ 순차로 만든다. 뒤 주차에서 실패하면 앞 주차는 이미 만들어진 채로 남는다 —
         트랜잭션으로 묶으려면 repo 에 벌크 경로를 새로 내야 하고, 그 대가가 이 기능의
         이득보다 크다. 실패는 그대로 400/500 으로 올라가고, 화면의 목록이 실제로 만들어진
         것을 그대로 보여 준다(우리가 성공했다고 말하지 않는다).
      ★ 7일 가산은 `addKstDays` 로 한다. KST 는 서머타임이 없지만 달력 기준으로 더해야
        주차 경계(목 00:00)와 어긋나지 않는다.
    */
    const repeatWeeks = body.repeatWeeks ?? 1;
    let runs: readonly Awaited<ReturnType<typeof createPartyRuns>>[number][] = [];
    for (let week = 0; week < repeatWeeks; week += 1) {
      const created = await createPartyRuns(session.uid, {
        partyId,
        bossDifficultyIds,
        scheduledAt: addKstDays(scheduledAt, 7 * week),
        durationMinutes: body.durationMinutes,
        entryPartySize: body.entryPartySize,
        participantPersonIds: body.participantPersonIds,
        characterId: body.characterId,
        note: body.note,
      });
      // 화면이 그리는 것은 **보고 있는 주**이므로 첫 주차의 결과만 응답에 싣는다.
      if (week === 0) runs = created;
    }
    const first = runs[0];
    if (first === undefined) {
      throw ApiError.badRequest("등록할 보스를 하나 이상 선택해 주세요.");
    }
    return jsonOk<PartyRunResponse>(
      { run: toWire(first), runs: runs.map(toWire) },
      201,
    );
  } catch (error) {
    return handleRouteError(error, "api/schedule/parties/[partyId]/runs#POST");
  }
}
