import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  fetchWeeklyIncomeDetail,
  unsetLedgerClear,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `DELETE /api/income/clears/{clearId}?weekKey=2026-W35` — **클리어 해제** (세션 필요)
 *
 * 응답 `{ detail }` — 옆 두 라우트(`party-size` · `character`)와 같은 화면 전체다.
 * 한 줄이 사라지면 캐릭터 소계 · 주간 합계 · 12개 카운터가 전부 함께 움직인다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지적 2026-09-01 — *"이 화면에 클리어 해제 없고"*
 * ─────────────────────────────────────────────────────────────────────────────
 * 수정 창에는 인원·캐릭터를 고치는 길만 있었다. 그런데 틀린 기록의 가장 흔한 형태는
 * **"안 잡았는데 들어와 있는 것"**이고, 그건 인원을 아무리 고쳐도 사라지지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `PUT { cleared: false }` 가 아니라 `DELETE` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 자원은 **원장의 한 줄**이고 여기서 하는 일은 그 줄을 없애는 것이다(넥슨 관측이 있으면
 * 눕힐 뿐이라는 것은 저장 방식의 사정이지, 부르는 쪽이 알아야 할 일이 아니다).
 * `runs/{runId}/clear` 가 `PUT { cleared }` 인 것은 그쪽 자원이 **일정**이라 켜고 끄는
 * 두 방향이 모두 필요하기 때문이다. 여기서 다시 켜는 길은 `/boss-status` 의 12칸이다.
 *
 * 판정·권한은 전부 `unsetLedgerClear()` 안에 있다 — 남의 기록은 404 이며 존재조차 알리지
 * 않는다(옆 두 라우트와 같은 규약).
 *
 * ★ **넥슨 호출 0건.**
 */

const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ clearId: string }> },
): Promise<Response> {
  try {
    const { clearId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    /*
      주차는 **쿼리로** 받는다. DELETE 본문은 프록시·클라이언트마다 취급이 달라 믿을 것이
      못 된다. 없으면 지금 주차로 그린다 — 화면은 자기가 보고 있는 주차를 넘긴다.
    */
    const raw = new URL(request.url).searchParams.get("weekKey");
    const parsed = raw === null ? null : weekKeySchema.safeParse(raw);
    if (parsed !== null && !parsed.success) {
      throw ApiError.badRequest(
        "주차 형식이 올바르지 않습니다. 2026-W35 형태로 보내 주세요.",
      );
    }

    await unsetLedgerClear(session.uid, clearId);

    const detail = await fetchWeeklyIncomeDetail(
      session.uid,
      parsed?.data ?? getWeekKey(new Date()),
    );
    return jsonOk<WeeklyIncomeResponse>({ detail });
  } catch (error) {
    return handleRouteError(error, "api/income/clears/[clearId]#DELETE");
  }
}
