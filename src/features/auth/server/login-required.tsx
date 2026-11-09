import "server-only";

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  LoginRedirect,
  SessionGate,
  SessionUnconfirmedNotice,
} from "../components";
import { loginHref, returnPathFrom } from "../lib/login-redirect";
import {
  readSession,
  readSignedInHint,
  type SessionPayload,
} from "./session";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인이 필요한 화면의 **진입 처리** — 한 곳에서만 판정한다
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시(2026-11-09): *"로그인이 풀렸으면 그냥 로그인창으로 보내줘"*.
 *
 * 예전 판단은 "리다이렉트하지 않고 200 으로 안내를 그린다"였다(북마크·공유 링크를 중간
 * 경유지로 만들지 않으려고). 그 판단이 뒤집힌 이유는 **안내가 안내로 읽히지 않았기
 * 때문이다** — `/parties` 는 비로그인에게 공개 파티 목록을 그렸고, 로그인이 풀린 사람은
 * 그 빈 목록을 보고 자기 파티가 지워졌다고 믿었다. 북마크 문제는 `?next=` 로 푼다:
 * 로그인하면 보던 주소로 **그대로** 돌아온다(쿼리스트링까지 — `returnPathFrom`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 갈래
 * ─────────────────────────────────────────────────────────────────────────────
 *   ① 서버가 세션을 안다 → 세션을 돌려준다. 페이지는 지금까지처럼 그린다.
 *   ② 세션도 **힌트 쿠키도 없다** → 여기서 307. 첫 HTML 도 그리지 않는다.
 *      세션 만료(30일 — 두 쿠키는 같은 수명으로 함께 심기고 함께 지워진다) · 다른 브라우저 ·
 *      처음 온 사람이 전부 여기다.
 *   ③ 세션은 없는데 **힌트 쿠키는 있다** → **판정하지 않는다.** null 을 돌려주고, 페이지는
 *      `LoginRequiredGate` 를 그린다.
 *
 * ⚠️ ③ 을 ② 와 합치면 안 된다. **RSC 렌더 경로에서만 세션 판정이 null 로 떨어지는 결함을
 *    두 번 겪었다**(`app/page.tsx` · `features/auth/components/session-gate.tsx` 머리말).
 *    그 결함이 다시 나면 로그인한 사람이 로그인 화면으로 튕긴다 — 고치기 전보다 나쁘다.
 *    그래서 힌트가 있으면 `SessionGate` 가 `/api/auth/me` 로 다시 묻고, 정말 비로그인일
 *    때만 `LoginRedirect` 가 보낸다.
 * ⚠️ 힌트 쿠키는 **인증이 아니다.** 위조해서 얻는 것은 307 대신 "게이트가 다시 물어본 뒤
 *    로그인 화면으로 간다"뿐이고, 서버는 이 경로에서 DB 를 한 줄도 읽지 않는다.
 *
 * ⚠️ 이 파일은 `server/session.ts`(server-only)를 import 한다. 그래서 **컴포넌트 배럴
 *    (`components/index.ts`)로 내보내지 않는다** — 클라이언트 번들에 `server-only` 가
 *    끌려가 빌드가 깨진다. 페이지가 이 경로를 직접 import 한다.
 */

/**
 * 세션을 읽고, 없으면 ② 또는 ③ 으로 가른다.
 *
 * @param pathname  그 페이지 자신의 경로(`"/parties"`). 페이지마다 고정이라 인자로 받는다.
 * @param searchParams  그 페이지가 받은 쿼리(이미 `await` 한 값). 돌아갈 주소에 보존된다.
 * @returns 세션(①) 또는 null(③ — 페이지는 `LoginRequiredGate` 를 그린다).
 *          ② 는 돌아오지 않는다(`redirect()` 는 던져서 동작한다).
 *
 * ⚠️ `redirect()` 를 **try/catch 안에서 부르지 않는다**(Next 16 문서) — 던지는 것이 곧
 *    동작이라 잡으면 이동이 사라진다. 이 함수를 부르는 쪽도 try 로 감싸지 않는다.
 */
export async function requireSessionOrLogin(
  pathname: string,
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): Promise<SessionPayload | null> {
  const session = await readSession();
  if (session !== null) return session;

  const signedInHint = await readSignedInHint();
  if (!signedInHint) {
    redirect(loginHref(returnPathFrom(pathname, searchParams)));
  }
  return null;
}

export interface LoginRequiredGateProps {
  /**
   * 클라이언트가 로그인을 확인했을 때 그릴 것.
   *
   * - `/income` · `/friends` 처럼 **스스로 조회하는** 워크스페이스는 그것을 넘긴다.
   * - 서버가 누구인지 알아야만 그릴 수 있는 화면은 **넘기지 않는다** → 불일치 안내
   *   (`SessionUnconfirmedNotice`)와 새로고침. 이 갈래는 RSC 결함일 때만 탄다.
   */
  readonly children?: ReactNode;
}

/**
 * ③ 의 화면. 판정은 `SessionGate` 가 한다 — 그 판정 로직은 **그대로 쓰고 바꾸지 않는다.**
 *
 * `serverHint` 를 `true` 로 고정하는 이유: 이 게이트가 그려지는 요청은 서버가 **세션을
 * 봤거나(`/friends` 처럼 원래 게이트 뒤에서 그리는 화면) 힌트 쿠키를 봤다**
 * (`requireSessionOrLogin` 이 null 을 준 경우는 그것뿐이다). 둘 다 없으면 이미 307 이다.
 * 그러면 첫 HTML 이 `LoginRedirect` 가 아니라 스켈레톤(또는 본 화면)이 되어, 로그인한
 * 사람이 "이동하는 중…"을 한 프레임도 보지 않는다. 실제 쿠키가 다르면 게이트가
 * 하이드레이션 직후 `document.cookie` 로 보정한다.
 */
export function LoginRequiredGate({ children }: LoginRequiredGateProps) {
  return (
    <SessionGate serverHint fallback={<LoginRedirect />}>
      {children ?? <SessionUnconfirmedNotice />}
    </SessionGate>
  );
}
