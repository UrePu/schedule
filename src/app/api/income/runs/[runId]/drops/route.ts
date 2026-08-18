import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  addRunDrop,
  fetchWeeklyIncomeDetail,
} from "@/features/income/server/income-repo";
import type { WeeklyIncomeResponse } from "@/features/income/types";
import { getWeekKey } from "@/lib/time/week";

/**
 * `POST /api/income/runs/{runId}/drops` — 그 일정에서 나온 드랍을 기록한다 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요구: *"드랍은 어디서 하는건지 모르겠네"* → *"드랍 넣고"* (2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * DB 는 처음부터 완비돼 있었고 **쓰기 경로만 없었다.** 수익 화면이 `dropIncomeMeso` 를
 * 표시하고 있었지만 값이 언제나 0 이었던 이유가 이것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **판매액은 필수가 아니다** — 그것이 이 엔드포인트의 핵심 계약이다
 * ─────────────────────────────────────────────────────────────────────────────
 * `saleAmountMeso: null` 은 "아직 안 팔았다"이며 **0 이 아니다**(`run_drops` 컬럼 주석).
 * 그런 행은 `v_run_drop_settlement` 에 아예 나타나지 않아 합계에서 빠지고,
 * `v_weekly_unsold_drops` 가 건수로만 센다. 아이템만 먼저 적고 나중에 금액을 채우는
 * 것이 기본 흐름이므로 스키마에서 `.nullable()` 이 아니라 **기본값이 `null`** 이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다 (`.../runs/[runId]` · `availability/patterns`)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 화면 전체**를 돌려준다 — 드랍 하나를 넣으면 그 런의 목록,
 *      드랍 합계, 미판매 건수, 총합이 **동시에** 움직인다. 부분 갱신을 조립하면
 *      화면이 잠깐 서로 어긋난 숫자를 말한다.
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * 권한(파티원 ∧ `going`)과 값 정규화는 전부 `addRunDrop()` 이 한다. 라우트에 복제하지 않는다.
 */

const addDropSchema = z.object({
  itemName: z
    .string({ error: "아이템 이름 형식이 올바르지 않습니다." })
    .min(1, "아이템 이름을 입력해 주세요.")
    .max(100, "아이템 이름은 100자까지 입력할 수 있습니다."),
  /**
   * ★ 기본값이 `null` 이다. 보내지 않으면 **미판매**로 기록된다.
   *   0 으로 접지 않는 이유는 파일 머리말과 §1.3 D4 를 보라.
   */
  saleAmountMeso: z
    .number({ error: "판매액 형식이 올바르지 않습니다." })
    .int("판매액은 정수로 입력해 주세요.")
    .min(0, "판매액은 0 이상이어야 합니다.")
    .nullable()
    .default(null),
  /**
   * `custom` 은 받지 않는다 — 건별 비율(`run_drop_shares`)을 만드는 UI 가 없고,
   * 런 단위 사용자 지정 비율을 `party_default` 가 이미 그대로 따른다
   * (`DropShareMode` 주석). DB 쪽 지원은 살아 있다.
   */
  shareMode: z.enum(["party_default", "solo"]).default("party_default"),
  soloParticipantId: z.uuid("독식 대상 형식이 올바르지 않습니다.").nullable().default(null),
  note: z.string().max(500, "메모는 500자까지 입력할 수 있습니다.").nullable().default(null),
  /** 응답으로 다시 그릴 주차. 화면이 보고 있는 주차를 그대로 넘긴다. */
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, addDropSchema);
    const weekKey = body.weekKey ?? getWeekKey(new Date());

    await addRunDrop(session.uid, {
      runId,
      itemName: body.itemName,
      saleAmountMeso: body.saleAmountMeso,
      shareMode: body.shareMode,
      soloParticipantId: body.soloParticipantId,
      note: body.note,
      weekKey,
    });

    const detail = await fetchWeeklyIncomeDetail(session.uid, weekKey);
    return jsonOk<WeeklyIncomeResponse>({ detail }, 201);
  } catch (error) {
    return handleRouteError(error, "api/income/runs/[runId]/drops#POST");
  }
}
