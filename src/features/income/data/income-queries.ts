/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 수익 — **브라우저 쪽 데이터 접근 경계**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 이 파일의 함수만 부른다. 본문은 전부 `/api/income/...` 호출이다.
 *
 * ⚠️ **Supabase 를 직접 부르지 않는다.** `boss_clears` 와 수익 뷰 7종은 전부
 *    service_role 전용이라(DB-SCHEMA 난제 1·9) 브라우저에는 권한 자체가 없다.
 *    이 파일에는 `fetch` 밖에 없으므로 service_role 키가 이 경로로 샐 수 없다.
 *
 * ⚠️ **넥슨을 한 번도 타지 않는다.** 결정석 가격도 수익도 넥슨 API 에 존재하지 않고
 *    (§1.1) 전부 우리 DB 다. 그래서 캐시 키는 `"db"` 네임스페이스이며 15분 하한의
 *    대상이 아니다.
 *
 * ⚠️ **응답이 언제나 화면 전체다.** 인원을 고치거나 클리어를 체크하면 그 한 줄만이 아니라
 *    캐릭터 합계·사용자 합계·12 상한 경고까지 동시에 움직인다. 부분 갱신을 조립하면
 *    화면이 잠깐 서로 어긋난 숫자를 말하게 되므로, 서버가 다시 만든 전체를 그대로 받는다.
 */

import type {
  AddRunDropInput,
  IncomeLedgerResponse,
  RemoveRunDropInput,
  SetRunClearInput,
  UpdateClearCharacterInput,
  UpdatePartySizeInput,
  UpdateRunDropInput,
  WeeklyIncomeResponse,
} from "../types";

interface ApiErrorShape {
  readonly error: { readonly message?: unknown };
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = (body as Partial<ApiErrorShape>).error;
  if (typeof candidate !== "object" || candidate === null) return null;
  const message = (candidate as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * 실패는 `Error` 하나로 접는다. 화면은 상태 코드가 아니라 "실패했다"만 알면 되고,
 * 서버가 준 한국어 문구를 그대로 보여 준다 — "캐릭터를 먼저 지정해 주세요"처럼
 * 사용자가 취해야 할 조치가 문구마다 다르기 때문이다.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      extractMessage(body) ??
        `[income] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
    );
  }
  return body as T;
}

/**
 * 달력 + 주차별 내역 (`from ~ to` 주차, 양 끝 포함).
 *
 * ★ **캘린더와 주차 목록이 이 함수 하나를 함께 쓴다.** 둘 다 "주차 범위의 원장"을 보므로
 *   조회를 나누면 같은 데이터를 두 번 받고, 한쪽만 갱신되는 순간 두 화면이 서로 다른
 *   숫자를 말한다. 캐시 키도 `queryKeys.db.income.ledger(from, to)` 하나다.
 */
export function fetchIncomeLedger(
  fromWeekKey: string,
  toWeekKey: string,
): Promise<IncomeLedgerResponse> {
  const query = new URLSearchParams({ from: fromWeekKey, to: toWeekKey });
  return request<IncomeLedgerResponse>(`/api/income/ledger?${query.toString()}`);
}

/** 그 주차의 수익 상세 전체. */
export function fetchWeeklyIncomeDetail(
  weekKey: string,
): Promise<WeeklyIncomeResponse> {
  const query = new URLSearchParams({ weekKey });
  return request<WeeklyIncomeResponse>(`/api/income?${query.toString()}`);
}

/**
 * 입장 인원을 고친다 (§1.3 D3).
 *
 * ★ **보스별 상한을 넘겨도 저장된다** (§1.3 D5). `max_party` 값 대부분이 세대 규칙에서
 *   유도된 것이라 실제 파티가 그 값을 넘는데 막히면 사용자가 앱을 못 쓴다. 초과는
 *   화면이 경고로만 처리한다.
 */
export function updateClearPartySize(
  input: UpdatePartySizeInput,
): Promise<WeeklyIncomeResponse> {
  return request<WeeklyIncomeResponse>(
    `/api/income/clears/${encodeURIComponent(input.clearId)}/party-size`,
    {
      method: "PUT",
      body: JSON.stringify({
        partySize: input.partySize,
        weekKey: input.weekKey,
      }),
    },
  );
}

/**
 * 클리어를 다른 내 캐릭터에 귀속시킨다 (§1 — 클리어의 단위는 캐릭터).
 *
 * ★ **금액을 바꾸는 요청이 아니다.** 분배는 사람 단위라 내 캐릭터끼리 옮겨도 내 몫은
 *   그대로이고, 움직이는 것은 캐릭터별 12개 카운터와 월드별 집계다. 그래도 응답은
 *   화면 전체다 — 캐릭터별 소계와 상한 경고가 동시에 재배치되기 때문이다.
 */
export function updateClearCharacter(
  input: UpdateClearCharacterInput,
): Promise<WeeklyIncomeResponse> {
  return request<WeeklyIncomeResponse>(
    `/api/income/clears/${encodeURIComponent(input.clearId)}/character`,
    {
      method: "PUT",
      body: JSON.stringify({
        characterId: input.characterId,
        weekKey: input.weekKey,
      }),
    },
  );
}

/** 일정을 클리어로 표시하거나 해제한다. 넥슨 관측값은 덮어쓰지 않는다(난제 6). */
export function setRunClear(
  input: SetRunClearInput,
): Promise<WeeklyIncomeResponse> {
  return request<WeeklyIncomeResponse>(
    `/api/income/runs/${encodeURIComponent(input.runId)}/clear`,
    {
      method: "PUT",
      body: JSON.stringify({
        cleared: input.cleared,
        weekKey: input.weekKey,
      }),
    },
  );
}

/**
 * 그 일정에서 나온 드랍을 기록한다.
 *
 * ★ **판매액은 필수가 아니다.** `saleAmountMeso: null` 이 정상 입력이고 "아직 안
 *   팔았다"를 뜻한다 — 0 이 아니다. 그런 건은 합계에서 빠지고 미판매 건수로만 세어진다.
 * ★ **분배 비율을 여기서 보내지 않는다.** 우리가 넘기는 것은 방식(`shareMode`)뿐이고
 *   누가 얼마를 가져가는지는 `distribute_meso()` 와 정산 뷰가 정한다. 화면이 1/n 을
 *   다시 적으면 웹과 카톡 봇의 답이 갈라진다.
 */
export function addRunDrop(
  input: AddRunDropInput,
): Promise<WeeklyIncomeResponse> {
  return request<WeeklyIncomeResponse>(
    `/api/income/runs/${encodeURIComponent(input.runId)}/drops`,
    {
      method: "POST",
      body: JSON.stringify({
        itemName: input.itemName,
        saleAmountMeso: input.saleAmountMeso,
        shareMode: input.shareMode,
        soloParticipantId: input.soloParticipantId,
        note: input.note,
        weekKey: input.weekKey,
      }),
    },
  );
}

/**
 * 드랍을 고친다 — **나중에 판매액을 채우는 것이 주 용도다.**
 *
 * ⚠️ 보내지 않은 필드는 서버가 건드리지 않는다. 특히 `saleAmountMeso` 는
 *    생략(그대로 둠) · `null`(미판매로 되돌림) · 숫자(판매됨)가 **서로 다른 뜻**이라
 *    `undefined` 인 키를 그대로 실어 보낸다(`JSON.stringify` 가 알아서 뺀다).
 */
export function updateRunDrop(
  input: UpdateRunDropInput,
): Promise<WeeklyIncomeResponse> {
  return request<WeeklyIncomeResponse>(
    `/api/income/drops/${encodeURIComponent(input.dropId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        itemName: input.itemName,
        saleAmountMeso: input.saleAmountMeso,
        shareMode: input.shareMode,
        soloParticipantId: input.soloParticipantId,
        note: input.note,
        weekKey: input.weekKey,
      }),
    },
  );
}

/**
 * 드랍을 지운다. **되돌릴 수 없다** — 화면이 확인 단계를 거친 뒤에만 부른다.
 *
 * 주차는 본문이 아니라 질의 문자열로 보낸다(`DELETE` 본문은 구현에 따라 버려진다).
 */
export function removeRunDrop(
  input: RemoveRunDropInput,
): Promise<WeeklyIncomeResponse> {
  const query = new URLSearchParams({ weekKey: input.weekKey });
  return request<WeeklyIncomeResponse>(
    `/api/income/drops/${encodeURIComponent(input.dropId)}?${query.toString()}`,
    { method: "DELETE" },
  );
}
