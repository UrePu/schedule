/**
 * 초대·승계의 **브라우저 쪽 데이터 경계**.
 *
 * 화면은 이 파일의 함수만 부르고, 본문은 전부 `/api/invites/...` 호출이다.
 * `features/schedule/data/schedule-queries.ts` 와 같은 규약이다:
 *   - 실패는 **`Error` 하나로** 접는다. 화면은 상태 코드가 아니라 "실패했다"만 알면 되고,
 *     서버가 준 한국어 문구를 그대로 보여 준다.
 *   - `@/lib/supabase/*` 를 import 하지 않는다(이 파일은 클라이언트 번들에 들어간다).
 */

import type { GuestInvite, InviteClaimResult, PersonId } from "@/types/domain";

export interface GuestInviteResponse {
  readonly invite: GuestInvite;
}
export interface InviteClaimResponse {
  readonly result: InviteClaimResult;
}

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
        `[invites] 요청을 처리하지 못했습니다. (HTTP ${response.status})`,
    );
  }
  return body as T;
}

/**
 * 게스트에게 초대 링크를 발급한다. **세션이 필요하다.**
 *
 * ⚠️ 돌려받는 `token` 원문은 **이 응답에만 존재한다.** 서버는 해시만 갖고 있으므로
 *    화면이 잃어버리면 재발급뿐이고, 재발급하면 이전 링크는 즉시 죽는다.
 */
export async function createGuestInvite(
  guestPersonId: PersonId,
): Promise<GuestInvite> {
  const body = await request<GuestInviteResponse>("/api/invites", {
    method: "POST",
    body: JSON.stringify({ guestPersonId }),
  });
  return body.invite;
}

/**
 * 초대 링크를 내 계정으로 승계한다. **세션이 필요하다.**
 *
 * ★ 성공하면 그 사람이 끼어 있던 파티가 **전부** 내 계정에 붙는다 — 서버의
 *   `claim_guest_profile()` 이 한 트랜잭션으로 옮긴다.
 * ★ 파티 안 **번호(`member_no`)는 유지된다** (§1.4).
 */
export async function claimInviteToken(
  token: string,
): Promise<InviteClaimResult> {
  const body = await request<InviteClaimResponse>("/api/invites/claim", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return body.result;
}

/**
 * 초대 링크의 절대 URL. **브라우저에서만 부른다** (origin 이 필요하다).
 *
 * 서버가 만들지 않는 이유: 배포 도메인을 서버가 알려면 환경 변수가 하나 더 필요한데,
 * 그 값이 실제 접속 도메인과 어긋나면 **아무도 못 여는 링크**가 만들어진다.
 * 사용자가 지금 보고 있는 origin 이 가장 정확한 답이다.
 */
export function inviteUrl(token: string): string {
  const origin =
    typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/invite/${encodeURIComponent(token)}`;
}
