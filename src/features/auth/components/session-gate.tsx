"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ErrorState, Skeleton, SkeletonGroup } from "@/components/ui";

import { useSessionQuery } from "../data/auth-queries";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `SessionGate` — **클라이언트가 아는 세션이 이긴다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 있는가 — 관측된 증상(2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 상태에서 `/` 를 열면 랜딩("파티원 시간이 겹치는 지점을…")이 나오는데,
 * **같은 화면 아래쪽 계정 패널은 "로그인됨 · 더저"** 로 정상 표시된다. 로컬 dev(3000),
 * 로컬 프로덕션 빌드, Vercel 에서 모두 재현됐다. `/boss-plans` 와 `/schedule` 은
 * 멀쩡한데, 그 둘은 서버에서 로그인 분기를 하지 않고 클라이언트가 그린다.
 *
 * 즉 **RSC 렌더 경로에서만 세션 쿠키 판정이 null 로 떨어지고, Route Handler
 * (`GET /api/auth/me`) 경로에서는 정상**이다. 근본 원인 추적은 이 컴포넌트의 일이 아니다.
 * 이 컴포넌트가 하는 일은 하나 — **서버 판정이 실패해도 클라이언트가 아는 세션이 이기게
 * 하는 것**이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 "로딩 중 = 랜딩" 이면 안 되는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 세션 조회가 끝날 때까지 `fallback`(랜딩)을 그리면, 고치려던 증상이 **짧아지기만 하고
 * 그대로 남는다** — 로그인한 사람이 매번 랜딩을 한 번 본다. 그래서 힌트 쿠키
 * (`m_schedule_signed_in`, `server/session.ts`)로 "이 브라우저는 자기가 로그인돼 있다고
 * 믿는가"를 먼저 묻고, 믿는다면 **스켈레톤**을 그리며 기다린다. 믿지 않으면 기다릴
 * 이유가 없으므로 **즉시** `fallback` 이다 — 진짜 비로그인 방문자에게 스켈레톤을
 * 보여 주는 것도 똑같이 나쁜 깜빡임이다.
 *
 * ⚠️ 힌트 쿠키는 **인증 수단이 아니다.** 값은 `"1"` 하나뿐이고 위조해도 얻는 것은
 *    "랜딩 대신 스켈레톤을 잠깐 본다"뿐이다. 실제 판정은 늘 `/api/auth/me` 가 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 하이드레이션 불일치를 구조로 막는다
 * ─────────────────────────────────────────────────────────────────────────────
 * `document.cookie` 를 `useState` 초기화 함수에서 읽으면 서버 렌더(=쿠키 없음)와 첫
 * 클라이언트 렌더(=쿠키 있음)가 갈라져 하이드레이션 경고가 뜬다. 그래서
 *
 *   - `useSyncExternalStore` 의 **`getServerSnapshot`** 이 서버가 넘겨준 값
 *     (`serverHint`)을 그대로 돌려준다. React 는 SSR 과 **하이드레이션 시점**에 이 값을
 *     쓰므로 서버 HTML 과 첫 클라이언트 렌더가 항상 같다.
 *   - 실제 `document.cookie` 판독(`getSnapshot`)은 하이드레이션이 끝난 뒤에 일어나고,
 *     값이 다르면 React 가 알아서 한 번 더 렌더한다. `useState` 초기화 함수에서 읽는
 *     방식과 달리 이 경로에는 불일치 자체가 없다.
 *
 * `serverHint` 는 RSC 에서 `readSignedInHint()` 로 읽는다. 그 경로에서도 쿠키가 비어
 * 오면 `false` 가 되고, 그때는 클라이언트가 마운트 직후 같은 판정을 내린다 — 결과는
 * 같고, 깜빡임이 한 프레임 생길 뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버가 심어 둔 `{ user: null }` 을 그대로 믿지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 루트 레이아웃(`app/layout.tsx`)은 `loadCurrentUser()` 결과를 세션 캐시에 **심는다.**
 * RSC 판정이 실패한 요청에서는 그 값이 `{ user: null }` 이고, `session` 티어의
 * staleTime 은 30초라 캐시는 **30초 동안 그 null 을 신선한 값으로 취급한다.**
 * 그러면 게이트가 곧바로 랜딩으로 떨어져 이 컴포넌트가 존재할 이유가 사라진다.
 *
 * 그래서 **힌트가 있는데 캐시가 비로그인이라고 말하면 딱 한 번 강제로 다시 묻는다**
 * (`refetch()`). 이 재조회는 넥슨을 타지 않는 우리 DB 왕복 1건이고, 정상 경로
 * (서버가 사용자를 안 요청)에서는 애초에 일어나지 않는다.
 */

/**
 * ⚠️ **`server/session.ts` 의 `SIGNED_IN_HINT_COOKIE_NAME` 과 같은 값이어야 한다.**
 * 그 모듈은 `import "server-only"` 라 클라이언트 번들에서 import 할 수 없어 리터럴이
 * 두 곳에 있다. 값을 바꾼다면 두 곳을 함께 바꿔야 하며, 검증은 한 줄이다:
 * `grep -rn "m_schedule_signed_in" src` 가 정확히 두 곳(+이 주석)만 나와야 한다.
 */
const SIGNED_IN_HINT_COOKIE = "m_schedule_signed_in=1";

/**
 * `useSyncExternalStore` 의 `getSnapshot`. **하이드레이션 이후에만** 호출된다.
 * 불리언을 돌려주므로 "매번 새 객체" 경고와 무관하다.
 */
function hasSignedInHintCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((entry) => entry.trim() === SIGNED_IN_HINT_COOKIE);
}

/**
 * 쿠키는 변경 이벤트를 내보내지 않으므로 구독할 것이 없다. 그래도 훅이 도는 이유는,
 * React 가 마운트 직후 `getSnapshot()` 을 한 번 확인해 서버 스냅샷과 다르면 다시
 * 렌더하기 때문이다 — 우리에게 필요한 것은 정확히 그 한 번이다.
 *
 * ★ 모듈 레벨에 두어 **참조가 고정**된다. 렌더마다 새 함수를 넘기면 React 가 매번
 *   구독을 해제·재등록한다.
 */
function subscribeToNothing(): () => void {
  return () => {
    /* 해제할 구독이 없다. */
  };
}

export interface SessionGateProps {
  /** 로그인 사용자에게 보여줄 화면(대시보드 · 수익 원장). */
  readonly children: ReactNode;
  /** 비로그인 화면(랜딩 · 로그인 안내). */
  readonly fallback: ReactNode;
  /**
   * 서버가 읽은 힌트 쿠키. **SSR 스냅샷**으로만 쓴다 — 권한 판정이 아니다.
   * RSC 에서 `readSignedInHint()` 로 얻는다. 넘기지 않으면 `false` 로 시작하고
   * 마운트 직후 `document.cookie` 로 보정된다.
   */
  readonly serverHint?: boolean;
}

export function SessionGate({
  children,
  fallback,
  serverHint = false,
}: SessionGateProps) {
  const sessionQuery = useSessionQuery();
  const { refetch } = sessionQuery;
  const user = sessionQuery.data?.user ?? null;

  /*
    서버 스냅샷 = 서버가 준 값, 클라이언트 스냅샷 = 진짜 `document.cookie`.
    하이드레이션은 서버 스냅샷으로 이뤄지고, 그 직후 React 가 둘을 비교해 다르면
    한 번 더 렌더한다 → 불일치 경고가 생길 자리가 없다.
  */
  const hint = useSyncExternalStore(
    subscribeToNothing,
    hasSignedInHintCookie,
    () => serverHint,
  );

  /*
    강제 재조회를 **정확히 한 번**만 태우기 위한 표식. state 가 아니라 ref 인 이유는
    이 값이 화면에 나타나지 않기 때문이다(렌더 중에는 읽지 않는다).
  */
  const recheckStarted = useRef(false);
  /** 강제 재조회가 끝났는가. 끝나기 전에는 랜딩 대신 스켈레톤을 그린다. */
  const [rechecked, setRechecked] = useState(false);

  useEffect(() => {
    // 힌트가 없거나 이미 사용자를 알면 다시 물을 이유가 없다.
    if (!hint || user !== null || recheckStarted.current) return;
    recheckStarted.current = true;
    void refetch().finally(() => {
      setRechecked(true);
    });
  }, [hint, user, refetch]);

  // 확정 로그인 → 곧바로 본 화면. 서버 판정이 무엇이었든 여기서 이긴다.
  if (user !== null) return <>{children}</>;

  if (hint) {
    /*
      힌트는 있는데 세션 조회가 실패했다 → **랜딩을 그리지 않는다.** 로그인한 사람에게
      랜딩을 보여 주는 것이 정확히 이 컴포넌트가 고치려는 증상이고, 실패를 비로그인으로
      둔갑시키면 원인을 볼 방법도 사라진다. 에러 상태로 말하고 재시도를 준다(DoD §0.3).
    */
    if (rechecked && sessionQuery.isError) {
      return (
        <ErrorState
          title="로그인 상태를 확인하지 못했습니다"
          description="네트워크가 끊겼거나 서버가 응답하지 않았습니다. 다시 시도해 주세요."
          detail={sessionQuery.error.message}
          onRetry={() => {
            setRechecked(false);
            void refetch().finally(() => {
              setRechecked(true);
            });
          }}
        />
      );
    }
    // 아직 판단 중(최초 조회 or 강제 재조회) → 랜딩 대신 자리표시자.
    if (sessionQuery.isPending || !rechecked) {
      return <SessionGateSkeleton />;
    }
  }

  // 힌트가 없거나, 다시 물어도 비로그인이었다 → 확정 비로그인.
  return <>{fallback}</>;
}

/**
 * 로그인 사용자를 기다리는 동안의 자리표시자.
 *
 * 색은 전부 `Skeleton` 토큰이 진다(§4 — 원시 hex 없음). 모양은 대시보드/수익 화면의
 * 공통 뼈대(제목 한 줄 + 카드 2단 + 목록)만 흉내 낸다 — 두 화면 중 무엇이 뒤에 올지
 * 게이트는 모르므로, 특정 화면을 그대로 베끼면 나머지 한쪽에서 자리가 튄다.
 */
function SessionGateSkeleton() {
  return (
    <SkeletonGroup label="로그인 상태를 확인하는 중" className="gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton shape="text" className="w-24" />
        <Skeleton className="h-8 w-56" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-32" />
    </SkeletonGroup>
  );
}

/**
 * 표시 정체성(본캐 닉네임)을 **캐시에서** 읽는 한 줄짜리 조각.
 *
 * 서버 컴포넌트가 `user.mainCharacterName` 을 props 로 내려보내던 자리를 대체한다.
 * 두 가지를 동시에 고친다:
 *   1. props 는 `invalidateQueries()` 가 닿지 않는 자리다(§2.4 Rule 1). 부계정 키를
 *      추가해 본캐가 바뀌면 대시보드 제목은 즉시 따라오는데 수익 화면만 낡은 채 남았다.
 *   2. `SessionGate` 뒤에서 그려질 때는 **서버가 사용자를 모른다.** props 로는 채울
 *      값 자체가 없다.
 *
 * 정체성은 **본캐 닉네임**이다(§2.1) — 키도 내부 id 도 화면에 나오지 않는다.
 */
export interface SessionIdentityTextProps {
  /** 아직 사용자를 모를 때 보여줄 문구. */
  readonly fallback: string;
}

export function SessionIdentityText({ fallback }: SessionIdentityTextProps) {
  const user = useSessionQuery().data?.user ?? null;
  if (user === null) return <>{fallback}</>;
  return <>{user.mainCharacterName ?? user.displayName}</>;
}
