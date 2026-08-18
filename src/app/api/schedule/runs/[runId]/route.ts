import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  RunEditResponse,
  RunRemovalResponse,
  ScheduledRunWire,
} from "@/features/schedule/data/schedule-queries";
import {
  removePartyRun,
  updatePartyRun,
} from "@/features/schedule/server/schedule-repo";
import type { ScheduledRun, UpdateRunInput } from "@/types/domain";

/**
 * `PATCH  /api/schedule/runs/{runId}` — 일정 수정 / 취소 되돌리기 (세션 필요)
 * `DELETE /api/schedule/runs/{runId}` — 일정 취소 **또는** 삭제 (세션 필요)
 *
 * 발주 지시(2026-08-18): *"일정 수정 취소 삭제 하는 부분은 api 부터 먼저 만들고 있어"*
 * → 이 파일은 **서버까지만**이다. 화면 버튼은 다음 작업에서 붙는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다 (`availability/patterns` · `boss-plans` · `.../runs`)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 돌려준다 — 화면이 부분 갱신을 조립하지 않아도 된다
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 취소인지 삭제인지는 **서버가 판정한다** (`removePartyRun`)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자 확정 정책: *"클리어 붙은것은 취소, 안붙은건 삭제 가능하게 하고"*
 * 클라이언트가 먼저 물어보고 다시 부르는 왕복은 만들지 않는다 — 그 사이에 같이 간
 * 사람이 클리어를 체크하면 판정이 뒤집힌다. 무엇을 했는지는 `outcome` 이 말한다.
 *
 * ⚠️ `Date` 는 JSON 으로 못 나가므로 `scheduledAt` 만 ISO 문자열로 내보낸다.
 *   클라이언트(`schedule-queries.ts`)가 `new Date(...)` 로 되돌린다 — `POST` 와 같다.
 *
 * ⚠️ **`runNo` 는 어느 경로에서도 다시 매기지 않는다** (§1.4). 응답 타입에 번호를
 *   바꾸는 자리가 없고, 요청 스키마에도 없다.
 */

/*
 * ★ 응답 타입(`RunEditResponse` / `RunRemovalResponse`)은 **여기 없다.**
 *   다른 wire 타입과 함께 `features/schedule/data/schedule-queries.ts` 가 소유한다 —
 *   그것이 Route Handler 와 브라우저가 공유하는 계약의 자리이고, 화면이 서버 모듈을
 *   import 하지 않아도 되게 만드는 경계다(이 파일의 다른 import 를 보면 알 수 있듯,
 *   반대 방향 의존은 `server-only` 때문에 애초에 성립하지 않는다).
 */

/**
 * ⚠️ 타입 오류 문구까지 한국어로 못박는다. zod 기본 영문이 `readJsonBody` 를 통해
 *    그대로 화면에 나가기 때문이다(`.../runs/route.ts` 의 같은 주석 참고).
 *
 * ★ `bossDifficultyId` 를 **받지 않는다.** 이유는 `UpdateRunInput`(domain.ts) 주석 —
 *   요약하면 이미 붙은 클리어가 다른 보스의 수익을 가리키게 되고, 보스를 잘못 고른
 *   런은 아직 클리어가 없어 **삭제되는** 상태라 지우고 다시 등록하는 편이 싸다.
 * ★ `weekKey` 도 받지 않는다 — `party_runs.week_key` 는 `scheduled_at` 에서 파생되는
 *   생성 컬럼이다.
 */
const updateRunSchema = z
  .object({
    /** `null` = 시각 미정으로 되돌린다(겹쳐보기로 다시 조율). */
    scheduledAt: z
      .string({ error: "일정 시각 형식이 올바르지 않습니다." })
      .min(1, "일정 시각이 필요합니다.")
      .nullable()
      .optional(),
    durationMinutes: z
      .number({ error: "소요 시간 형식이 올바르지 않습니다." })
      .int()
      .min(5, "소요 시간은 5분 이상이어야 합니다.")
      .max(600, "소요 시간은 600분을 넘을 수 없습니다.")
      .optional(),
    /** §1.3 D3 — 입장 실제 인원은 **사용자가 고칠 수 있어야 한다.** */
    entryPartySize: z
      .number({ error: "파티 인원수 형식이 올바르지 않습니다." })
      .int()
      .min(1, "파티 인원수는 1명 이상이어야 합니다.")
      .max(24, "파티 인원수는 24명을 넘을 수 없습니다.")
      .optional(),
    note: z.string().max(500, "메모는 500자까지 입력할 수 있습니다.").nullable().optional(),
    /**
     * `false` 만 받는다 = **취소 되돌리기(복구).**
     * 취소는 `DELETE` 하나가 소유한다 — 같은 일을 두 경로가 하면 반드시 갈라진다.
     */
    cancelled: z.literal(false).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "수정할 내용이 없습니다.",
  });

function toWire(run: ScheduledRun): ScheduledRunWire {
  return { ...run, scheduledAt: run.scheduledAt?.toISOString() ?? null };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, updateRunSchema);

    /*
      문자열 → `Date` 변환은 **여기 한 곳**에서 한다. repo 가 `Date` 를 받는 것은
      `CreateRunInput` 과 같은 규약이고, 해석 실패는 DB 까지 내려가기 전에 끊는다.
      `undefined`(안 보냄)와 `null`(시각 미정으로 되돌림)은 서로 다른 뜻이라 접지 않는다.
    */
    let scheduledAt: Date | null | undefined;
    if (body.scheduledAt !== undefined) {
      if (body.scheduledAt === null) {
        scheduledAt = null;
      } else {
        const parsed = new Date(body.scheduledAt);
        if (Number.isNaN(parsed.getTime())) {
          throw ApiError.badRequest("일정 시각을 해석할 수 없습니다.");
        }
        scheduledAt = parsed;
      }
    }

    const input: UpdateRunInput = {
      runId,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      ...(body.durationMinutes !== undefined
        ? { durationMinutes: body.durationMinutes }
        : {}),
      ...(body.entryPartySize !== undefined
        ? { entryPartySize: body.entryPartySize }
        : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
    };

    const result = await updatePartyRun(session.uid, input);
    return jsonOk<RunEditResponse>({
      run: toWire(result.run),
      partyId: result.partyId,
      weekKey: result.weekKey,
      previousWeekKey: result.previousWeekKey,
      runs: result.runs.map(toWire),
    });
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]#PATCH");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const result = await removePartyRun(session.uid, runId);
    return jsonOk<RunRemovalResponse>({
      outcome: result.outcome,
      runId: result.runId,
      partyId: result.partyId,
      weekKey: result.weekKey,
      runs: result.runs.map(toWire),
    });
  } catch (error) {
    return handleRouteError(error, "api/schedule/runs/[runId]#DELETE");
  }
}
