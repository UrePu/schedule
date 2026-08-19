import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  LEDGER_MAX_WEEKS,
  fetchIncomeLedger,
} from "@/features/income/server/income-repo";
import type { IncomeLedgerResponse } from "@/features/income/types";
import { weekStartOfKey } from "@/features/income/lib/week-range";

/**
 * `GET /api/income/ledger?from=2026-W28&to=2026-W33` — 주차 범위의 원장 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **비로그인은 401 이다.** `/api/income` 과 같은 경계다
 * ─────────────────────────────────────────────────────────────────────────────
 * 공개 시간표가 공개하는 것은 "언제 무슨 보스를 간다"까지이고(§2.1), 개인의 **수익 금액**은
 * 거기에 들어가지 않는다. `boss_clears` 와 수익 뷰는 anon 에게 GRANT 자체가 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 커서가 아니라 **범위**인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 응답을 쓰는 화면이 둘이고 요구가 다르다.
 *   · **달력**: "이 달을 덮는 주" — 특정 범위를 정확히 집어야 한다.
 *   · **주차 목록**: "최근 N주" + 더 보기 — 뒤로 늘려 가면 된다.
 * 범위 하나로 둘 다 표현되고, 캐시 키도 `(from, to)` 하나로 정리된다. "더 볼 것이
 * 남았는가"는 응답의 `earliestWeekKey` 가 답한다 — 서버가 커서를 들고 있을 이유가 없다.
 *
 * ⚠️ **범위 상한이 있다**(`LEDGER_MAX_WEEKS`). 상한이 없으면 한 요청이 원장 전체를 끌어와
 *    응답이 수 MB 가 된다. 넘기면 400 이며 **조용히 잘라 주지 않는다** — 잘린 줄 모르고
 *    "그 기간엔 기록이 없다"로 읽는 쪽이 더 나쁘다.
 *
 * **넥슨 호출 0건.** 결정석 가격도 수익도 우리 DB 에만 있다(§1.1).
 */

/** `2026-W33` 형태만 받는다. DB CHECK(`^[0-9]{4}-W[0-9]{2}$`)와 같은 모양이다. */
const weekKeySchema = z.string().regex(/^\d{4}-W\d{2}$/);

const querySchema = z.object({
  from: weekKeySchema,
  to: weekKeySchema,
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const params = new URL(request.url).searchParams;
    const parsed = querySchema.safeParse({
      from: params.get("from"),
      to: params.get("to"),
    });
    if (!parsed.success) {
      throw ApiError.badRequest(
        "조회할 주차 범위가 올바르지 않습니다. from·to 를 2026-W33 형태로 보내 주세요.",
      );
    }

    /*
      주차 키는 문자열 비교만으로 시간 순서가 맞지만(`2025-W52 < 2026-W01`), **주 수**는
      문자열로 셀 수 없다. 실제 시각으로 되돌려 센다 — 그 변환은 `week-range.ts` 하나가
      소유하고 `getWeekStart()` 위에 얹혀 있다.
    */
    let span: number;
    try {
      span =
        Math.round(
          (weekStartOfKey(parsed.data.to).getTime() -
            weekStartOfKey(parsed.data.from).getTime()) /
            WEEK_MS,
        ) + 1;
    } catch {
      throw ApiError.badRequest("주차 키를 해석할 수 없습니다. (예: 2026-W33)");
    }

    if (span <= 0) {
      throw ApiError.badRequest("from 이 to 보다 뒤일 수 없습니다.");
    }
    if (span > LEDGER_MAX_WEEKS) {
      throw ApiError.badRequest(
        `한 번에 조회할 수 있는 기간은 ${String(LEDGER_MAX_WEEKS)}주까지입니다. 범위를 좁혀 주세요.`,
      );
    }

    const ledger = await fetchIncomeLedger(
      session.uid,
      parsed.data.from,
      parsed.data.to,
    );
    return jsonOk<IncomeLedgerResponse>(ledger);
  } catch (error) {
    return handleRouteError(error, "api/income/ledger#GET");
  }
}
