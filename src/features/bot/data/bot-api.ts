/**
 * 봇 설정의 **브라우저 쪽 데이터 경계**.
 *
 * `features/invites/data/invite-api.ts` 와 같은 규약이다:
 *   - 실패는 `Error` 하나로 접고, 서버가 준 한국어 문구를 그대로 보여 준다.
 *   - `@/lib/supabase/*` 를 import 하지 않는다(이 파일은 클라이언트 번들에 들어간다).
 */

import type {
  BotBoundParty,
  BotLinkCode,
  BotLinkCodeKind,
  BotSetupState,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
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
        `[bot] 요청을 처리하지 못했습니다. (HTTP ${String(response.status)})`,
    );
  }
  return body as T;
}

export async function fetchBotSetupState(): Promise<BotSetupState> {
  return request<BotSetupState>("/api/bot/setup");
}

/**
 * 연결 코드를 발급한다.
 *
 * ⚠️ 돌려받은 `code` 원문은 **이 응답에만 존재한다.** 다시 발급하면 이전 코드는 죽는다.
 */
export async function createBotLinkCode(kind: BotLinkCodeKind): Promise<BotLinkCode> {
  return request<BotLinkCode>("/api/bot/link-codes", {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
}

export async function updatePartyChannel(
  partyId: string,
  channelId: string | null,
): Promise<BotBoundParty> {
  const body = await request<{ party: BotBoundParty }>("/api/bot/parties/binding", {
    method: "PUT",
    body: JSON.stringify({ partyId, channelId }),
  });
  return body.party;
}
