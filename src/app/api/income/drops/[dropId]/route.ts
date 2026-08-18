import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchWeeklyIncomeDetail,
  removeRunDrop,
  updateRunDrop,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `PATCH  /api/income/drops/{dropId}` — 드랍 수정 (세션 필요)
 * `DELETE /api/income/drops/{dropId}` — 드랍 삭제 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `saleAmountMeso` 는 **세 가지 상태**를 가진다 — 접으면 안 된다
 * ─────────────────────────────────────────────────────────────────────────────
 *   - 필드를 **안 보냄**(`undefined`) → 판매액을 건드리지 않는다
 *   - `null`                          → **미판매로 되돌린다**(트리거가 `sold_at` 도 지운다)
 *   - 숫자                            → 그 금액에 팔았다
 * `null` 과 `undefined` 를 같은 것으로 취급하면 "판매 취소"를 표현할 방법이 없어지고,
 * `null` 을 `0` 으로 바꾸면 "0메소를 벌었다"는 거짓이 된다(§1.3 D4 와 같은 기조).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 런이 아니라 드랍 id 로 부르는가
 * ─────────────────────────────────────────────────────────────────────────────
 * `run_drops.id` 하나로 대상이 확정된다. 런을 경유하면 같은 이름의 아이템이 두 건일 때
 * 구분할 수 없고, 권한 검사는 어차피 드랍 → 런을 따라가며 하므로 얻는 것도 없다.
 * 권한(파티원 ∧ `going`)과 값 정규화는 전부 repo 함수가 소유한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 응답은 **화면 전체**다
 * ─────────────────────────────────────────────────────────────────────────────
 * 판매액 한 칸을 채우면 그 드랍의 내 몫, 주간 드랍 합계, 미판매 건수, 총합이 동시에
 * 움직인다. 어느 것도 화면이 계산하지 않으므로(전부 DB 뷰) 서버가 다시 만든 전체를
 * 그대로 돌려준다.
 */

const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

const updateDropSchema = z
  .object({
    itemName: z
      .string({ error: "아이템 이름 형식이 올바르지 않습니다." })
      .min(1, "아이템 이름을 입력해 주세요.")
      .max(100, "아이템 이름은 100자까지 입력할 수 있습니다.")
      .optional(),
    /** `null` = 미판매로 되돌림. 생략 = 그대로 둠. 둘은 다른 뜻이다. */
    saleAmountMeso: z
      .number({ error: "판매액 형식이 올바르지 않습니다." })
      .int("판매액은 정수로 입력해 주세요.")
      .min(0, "판매액은 0 이상이어야 합니다.")
      .nullable()
      .optional(),
    /** `custom` 은 받지 않는다 — 이유는 `DropShareMode` 주석. */
    shareMode: z.enum(["party_default", "solo"]).optional(),
    soloParticipantId: z
      .uuid("독식 대상 형식이 올바르지 않습니다.")
      .nullable()
      .optional(),
    note: z
      .string()
      .max(500, "메모는 500자까지 입력할 수 있습니다.")
      .nullable()
      .optional(),
    weekKey: weekKeySchema.optional(),
  })
  .refine(
    (value) =>
      value.itemName !== undefined ||
      value.saleAmountMeso !== undefined ||
      value.shareMode !== undefined ||
      value.soloParticipantId !== undefined ||
      value.note !== undefined,
    { message: "수정할 내용이 없습니다." },
  );

/** `?weekKey=` 를 읽는다. 없으면 지금이 속한 주차 — KST 목요일 00:00 경계다. */
function readWeekKey(request: Request): string {
  const raw = new URL(request.url).searchParams.get("weekKey");
  if (raw === null) return getWeekKey(new Date());
  const parsed = weekKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest("주차 형식이 올바르지 않습니다. (예: 2026-W33)");
  }
  return parsed.data;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ dropId: string }> },
): Promise<Response> {
  try {
    const { dropId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, updateDropSchema);
    const weekKey = body.weekKey ?? getWeekKey(new Date());

    await updateRunDrop(session.uid, {
      dropId,
      weekKey,
      ...(body.itemName !== undefined ? { itemName: body.itemName } : {}),
      ...(body.saleAmountMeso !== undefined
        ? { saleAmountMeso: body.saleAmountMeso }
        : {}),
      ...(body.shareMode !== undefined ? { shareMode: body.shareMode } : {}),
      ...(body.soloParticipantId !== undefined
        ? { soloParticipantId: body.soloParticipantId }
        : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });

    const detail = await fetchWeeklyIncomeDetail(session.uid, weekKey);
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income/drops/[dropId]#PATCH");
  }
}

/**
 * 삭제. **되돌릴 수 없다** — 딸린 `run_drop_shares` 도 cascade 로 함께 사라진다.
 * 그래서 화면이 확인 단계를 둔다(`credential-manager` 의 키 삭제와 같은 규약).
 *
 * 본문 대신 `?weekKey=` 를 쓴다. `DELETE` 에 본문을 싣는 것은 프록시·`fetch` 구현에 따라
 * 조용히 버려질 수 있고, 여기서 필요한 값은 "응답으로 무슨 주차를 다시 그릴까" 하나뿐이다.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ dropId: string }> },
): Promise<Response> {
  try {
    const { dropId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const weekKey = readWeekKey(request);
    await removeRunDrop(session.uid, dropId);

    const detail = await fetchWeeklyIncomeDetail(session.uid, weekKey);
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income/drops/[dropId]#DELETE");
  }
}
