import "server-only";

import { cache } from "react";

import { loadSessionUser } from "./account";
import { readSession } from "./session";

import type { SessionUser } from "../types";

import { getAdminDb } from "@/lib/supabase/admin-db";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "지금 이 요청을 보낸 사람" — **요청당 한 번만** DB 를 읽는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 루트 레이아웃이 세션을 캐시에 심게 되면서(§2.4 Rule 1) 같은 요청 안에서
 * 레이아웃과 페이지가 **둘 다** 계정을 조회하게 됐다. 왕복 하나당 고정비가 큰
 * 환경(실측 `/api/auth/me` 0.30초)에서 같은 값을 두 번 묻는 것은 그대로 손해다.
 *
 * `cache()` 는 React 가 제공하는 **요청 범위** 메모이제이션이다. 모듈 레벨 캐시가
 * 아니므로 §2.4 Rule 2 가 경고하는 "한 사람의 데이터가 다음 방문자에게 나가는" 사고와
 * 무관하다 — 요청이 끝나면 함께 사라진다.
 *
 * ⚠️ **던지지 않는다.** 쿠키가 없으면 `readSession()` 이 null 을 주고 여기서도 null 을
 *    돌려준다. 이 성질이 깨지면 루트 레이아웃이 던지면서 **네 화면이 전부 500** 이 된다
 *    (DoD §0.3 — 비로그인 200 보장).
 *
 * ⚠️ 정지·삭제 계정은 **null 로 취급한다.** `/api/auth/me` 와 같은 판정이다. 다만
 *    쿠키 삭제는 여기서 하지 않는다 — 레이아웃 렌더 중 쿠키를 쓰면 Next 가 거부한다.
 *    폐기는 지금까지처럼 `/api/auth/me` 가 맡는다.
 */
export const loadCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await readSession();
  if (session === null) return null;

  const user = await loadSessionUser(getAdminDb(), session.uid);
  if (user === null || user.status !== "active") return null;
  return user;
});
