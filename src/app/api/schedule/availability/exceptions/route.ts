import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  AvailabilityExceptionResponse,
  DeletedExceptionResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  createMyAvailabilityException,
  deleteMyAvailabilityException,
} from "@/features/schedule/server/schedule-repo";

/**
 * `POST   /api/schedule/availability/exceptions`      — 특이사항(제외) 한 건 등록
 * `DELETE /api/schedule/availability/exceptions?id=…` — 한 건 삭제
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 조회는 **여기 없다.** `GET /api/schedule/availability?kind=exceptions` 가 이미 한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그쪽에는 열람 권한 필터(`can_view_availability`)가 붙어 있다. 여기에 "내 것만" 읽는
 * 두 번째 조회를 만들면 같은 데이터에 규칙이 두 벌 생기고, 한쪽만 고치는 사고가 난다.
 * 편집 화면은 `personIds=<본인>` 으로 그 경로를 그대로 쓴다 — 본인은 언제나 열람 가능하다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **뺄셈 전용이고, 그게 전부다** (CLAUDE.md §1.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 본문에 `note`(사유) 자리가 **없다.** 발주자가 "이유는 없어도 됨"이라고 했고, 사유 입력을
 * 만들면 곧 "필수인가?"라는 질문이 따라온다. "대신 이 시간에 됨" 같은 덧셈 변형도 없다 —
 * 패턴이 덮지 않는 시간이 필요하면 **패턴을 넓히는 것**이 답이다.
 *
 * ★ 제외 구간은 **하루 안에서 닫힌다**(`0 ~ 1440`). "목요일 제외"가 목요일이라는 날짜와
 *   정확히 같은 뜻이어야 하기 때문이다. 수요일 22:00~02:00 패턴에서 넘어온 목 00:00~02:00
 *   까지 지우는 일은 **DB 의 `resolve_availability()` 가 벽시계 순간 단위로** 처리한다
 *   (multirange 뺄셈). 앱은 그 계산을 다시 하지 않는다.
 *
 * 규약(세션 확인 · `ApiError` · `handleRouteError` · 컬렉션/자원 응답)은 다른 쓰기
 * 라우트(`POST /api/schedule/parties` 등)와 같다.
 */

const dayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다.");

const exceptionIdSchema = z.uuid("특이사항 식별자 형식이 올바르지 않습니다.");

const createSchema = z
  .object({
    dayKey: dayKeySchema,
    // 둘 다 null = 그날 전체 제외. 1440 = 자정(그날 끝).
    startMinute: z
      .number()
      .int()
      .min(0, "제외 시작 시각이 하루 범위를 벗어납니다.")
      .max(1439, "제외 시작 시각이 하루 범위를 벗어납니다.")
      .nullable(),
    endMinute: z
      .number()
      .int()
      .min(1, "제외 끝 시각이 올바르지 않습니다.")
      .max(1440, "제외는 하루 안에서 끝나야 합니다. 다음 날은 따로 등록해 주세요.")
      .nullable(),
  })
  .refine(
    (value) =>
      (value.startMinute === null) === (value.endMinute === null),
    { message: "시간대를 지정하려면 시작과 끝을 모두 보내야 합니다." },
  )
  .refine(
    (value) =>
      value.startMinute === null ||
      value.endMinute === null ||
      value.endMinute > value.startMinute,
    { message: "제외 시간의 끝이 시작보다 빠릅니다." },
  );

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, createSchema);
    const exception = await createMyAvailabilityException(session.uid, {
      dayKey: body.dayKey,
      startMinute: body.startMinute,
      endMinute: body.endMinute,
    });
    return jsonOk<AvailabilityExceptionResponse>({ exception }, 201);
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/exceptions#POST");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const raw = new URL(request.url).searchParams.get("id") ?? "";
    const parsed = exceptionIdSchema.safeParse(raw);
    if (!parsed.success) {
      throw ApiError.badRequest("삭제할 특이사항을 지정해 주세요.");
    }

    // 소유 확인은 repo 가 `user_id` 조건으로 한다 — 남의 행은 애초에 지워지지 않는다.
    const deletedId = await deleteMyAvailabilityException(
      session.uid,
      parsed.data,
    );
    return jsonOk<DeletedExceptionResponse>({ deletedId });
  } catch (error) {
    return handleRouteError(
      error,
      "api/schedule/availability/exceptions#DELETE",
    );
  }
}
