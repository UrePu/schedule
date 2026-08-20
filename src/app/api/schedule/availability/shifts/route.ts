import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { ShiftsResponse } from "@/features/schedule/data/schedule-queries";
import { MAX_SPAN_MINUTES } from "@/features/schedule/lib/pattern-slots";
import {
  createMyShiftPreset,
  deleteMyShiftPreset,
  fetchMyShiftAssignments,
  fetchMyShiftPresets,
  setMyShiftAssignments,
} from "@/features/schedule/server/schedule-repo";

/**
 * `GET    ?from=yyyy-MM-dd&to=yyyy-MM-dd` — 가능 시간대 묶음 + 그 범위의 날짜 지정
 * `POST`   — 묶음 추가 / 삭제 / 달력에 찍기 (`action` 으로 구분)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `action` 한 경로인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 쓰기가 **같은 응답**을 돌려준다 — 프리셋 목록과 그 달의 배정 전체다. 화면이 부분
 * 갱신을 조립하지 않아도 되게 하려면 어차피 세 경로가 같은 것을 다시 읽어야 하고, 그러면
 * 경로만 셋으로 늘고 얻는 것이 없다. 조회 범위(`from`/`to`)를 함께 받는 이유도 같다.
 *
 * ★ 대상은 **언제나 세션 본인**이다. 프리셋의 주인 검사는 repo 가, 최종 방어선은 DB
 *   트리거(`shift_assignments_owner_guard`)가 한다.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

const rangeSchema = z.object({
  from: z.string().regex(DAY_KEY, "조회 시작 날짜가 올바르지 않습니다."),
  to: z.string().regex(DAY_KEY, "조회 끝 날짜가 올바르지 않습니다."),
});

const presetShape = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "시간대 이름을 입력해 주세요.")
      .max(12, "시간대 이름은 12자를 넘을 수 없습니다."),
    startMinute: z
      .number()
      .int()
      .min(0, "시작 시각이 하루 범위를 벗어납니다.")
      .max(1439, "시작 시각이 하루 범위를 벗어납니다."),
    // 1440 초과 = 자정 넘김. 22:00~익일 02:00 은 1320~1560 이다.
    endMinute: z
      .number()
      .int()
      .min(1, "끝 시각이 올바르지 않습니다.")
      .max(2880, "끝 시각이 저장 가능한 범위를 벗어납니다."),
  })
  .refine((value) => value.endMinute > value.startMinute, {
    message: "끝이 시작보다 빠릅니다.",
  })
  .refine((value) => value.endMinute - value.startMinute <= MAX_SPAN_MINUTES, {
    message: "한 시간대는 24시간을 넘을 수 없습니다.",
  });

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createPreset"),
    preset: presetShape,
    range: rangeSchema,
  }),
  z.object({
    action: z.literal("deletePreset"),
    presetId: z.string().uuid("시간대를 찾을 수 없습니다."),
    range: rangeSchema,
  }),
  z.object({
    action: z.literal("assign"),
    /** 한 번에 칠하는 날짜들. 한 달 달력을 통째로 칠해도 31개면 충분하다. */
    dayKeys: z
      .array(z.string().regex(DAY_KEY, "날짜 형식이 올바르지 않습니다."))
      .max(62, "한 번에 바꿀 수 있는 날짜 수를 넘었습니다."),
    /*
      세 상태를 **한 값으로** 받는다. `presetId: string | null` 하나로는 "평소대로
      되돌리기"와 "종일 불가"를 구분할 수 없다 — 둘 다 null 이 되기 때문이다.
    */
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("clear") }),
      z.object({ kind: z.literal("blocked") }),
      z.object({
        kind: z.literal("preset"),
        presetId: z.string().uuid("시간대를 찾을 수 없습니다."),
      }),
    ]),
    range: rangeSchema,
  }),
]);

async function payload(
  userId: string,
  from: string,
  to: string,
): Promise<ShiftsResponse> {
  const [presets, assignments] = await Promise.all([
    fetchMyShiftPresets(userId),
    fetchMyShiftAssignments(userId, from, to),
  ]);
  return { presets, assignments, from, to };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const url = new URL(request.url);
    const parsed = rangeSchema.safeParse({
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
    });
    if (!parsed.success) {
      throw new ApiError("bad_request", "조회 범위가 올바르지 않습니다.", 400);
    }

    return jsonOk<ShiftsResponse>(
      await payload(session.uid, parsed.data.from, parsed.data.to),
    );
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/shifts#GET");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, bodySchema);

    if (body.action === "createPreset") {
      await createMyShiftPreset(session.uid, {
        name: body.preset.name,
        startMinute: body.preset.startMinute,
        endMinute: body.preset.endMinute,
      });
    } else if (body.action === "deletePreset") {
      await deleteMyShiftPreset(session.uid, body.presetId);
    } else {
      await setMyShiftAssignments(session.uid, body.dayKeys, body.selection);
    }

    return jsonOk<ShiftsResponse>(
      await payload(session.uid, body.range.from, body.range.to),
    );
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/shifts#POST");
  }
}
