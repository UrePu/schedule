"use client";

import { useEffect, useSyncExternalStore } from "react";

import { ErrorState } from "@/components/ui";

import { currentLoginHref, replaceWithLogin } from "../lib/session-expiry";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `LoginRedirect` — `SessionGate` 가 "확정 비로그인"이라고 판정했을 때의 `fallback`
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인이 필요한 화면(`/parties` 등)에서 서버가 세션을 못 봤는데 **힌트 쿠키는 있던**
 * 요청만 여기까지 온다. 쿠키가 아예 없으면 서버가 이미 307 로 보냈다
 * (`server/login-required.tsx`). 게이트가 `/api/auth/me` 로 다시 물었는데도 비로그인이면
 * 그때 이 컴포넌트가 그려지고, 마운트 즉시 로그인 화면으로 **바꾼다**.
 *
 * ★ 예전 자리에는 "로그인이 필요합니다" 카드가 있었다. 발주 지시(2026-11-09)로 카드 대신
 *   이동이다 — 카드는 한 번 더 눌러야 하는 막다른 길이었다.
 *
 * ⚠️ 이동하는 동안 한 줄과 **직접 가는 링크**를 남긴다. 이동은 보통 한 프레임 안에 끝나지만,
 *    무엇 때문이든 멈추면 빈 화면이 아니라 갈 곳이 보여야 한다. 링크 주소는 하이드레이션이
 *    끝난 뒤 실제 주소로 채운다(`useSyncExternalStore` — 서버 스냅샷은 `/`) — 렌더 중에
 *    `window` 를 읽으면 서버 HTML 과 첫 클라이언트 렌더가 갈라진다.
 */

/** 주소창은 이벤트를 내보내지 않으므로 구독할 것이 없다. 참조가 고정되도록 모듈 레벨. */
function subscribeToNothing(): () => void {
  return () => {
    /* 해제할 구독이 없다. */
  };
}

/** 서버에는 주소창이 없다 — 로그인 화면 그 자체로 둔다. */
function serverLoginHref(): string {
  return "/";
}

export function LoginRedirect() {
  const href = useSyncExternalStore(
    subscribeToNothing,
    currentLoginHref,
    serverLoginHref,
  );

  useEffect(() => {
    replaceWithLogin();
  }, []);

  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-4 py-10 text-center"
    >
      <p className="text-body-sm text-ink-muted">로그인 화면으로 이동하는 중…</p>
      <a
        href={href}
        className="text-body-sm font-semibold text-primary underline-offset-2 hover:underline"
      >
        바로 가기 →
      </a>
    </div>
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `SessionUnconfirmedNotice` — 서버는 모르는데 클라이언트는 로그인을 안다
 * ═════════════════════════════════════════════════════════════════════════════
 * **RSC 렌더 경로에서만 세션 판정이 null 로 떨어지는 결함**(`app/page.tsx` 머리말 —
 * 2026-08-18 에 처음, 그 뒤 `/income` 에서 한 번 더 겪었다)이 다시 났을 때만 보인다.
 *
 * `/parties` · `/boss-plans` 같은 화면은 서버가 **누구인지 알아야** 첫 화면을 그린다
 * (prefetch · 선택 규칙 · 열람 범위). 서버가 모르는 채로 워크스페이스를 그리면 다시
 * "아직 파티가 없습니다" 같은 거짓 빈 화면이 된다 — 이번 작업이 없애려던 그 증상이다.
 * 그래서 화면 대신 불일치를 그대로 말하고 **새로고침**을 준다. 로그인 화면으로 보내지도
 * 않는다: 이 사람은 로그인돼 있고, 보내면 로그인한 사람이 결함 때문에 튕긴다.
 */
export function SessionUnconfirmedNotice() {
  return (
    <ErrorState
      title="로그인 상태를 확인하지 못했습니다"
      description="로그인은 되어 있는데 서버가 이 화면을 그리는 순간 그 사실을 읽지 못했습니다. 새로고침하면 다시 확인합니다."
      retryLabel="새로고침"
      onRetry={() => {
        window.location.reload();
      }}
    />
  );
}
