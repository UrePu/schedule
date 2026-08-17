"use client";

import { KeyRound, LogOut } from "lucide-react";
import type { ReactNode } from "react";

import {
  Button,
  Card,
  CardDescription,
  CardOverline,
  CardTitle,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";

import {
  useLogoutMutation,
  useSessionQuery,
} from "../data/auth-queries";
import { maskApiKey } from "../lib/api-key";
import { useStoredApiKey } from "../lib/use-stored-api-key";
import type { LoginResponse } from "../types";
import { ApiKeyLoginForm } from "./api-key-login-form";

/**
 * 로그인 상태를 통째로 그리는 패널. 로딩 · 비로그인 · 로그인 · 에러 네 상태가 전부 있다(DoD §0.3).
 *
 * ★ **비로그인은 에러가 아니라 상태다.** `/api/auth/me` 가 200 `{ user: null }` 로
 *   답하도록 만든 이유가 여기 있다 — 홈과 공개 시간표는 세션 없이 열려야 한다.
 *   `isError` 로 떨어지는 것은 서버가 정말 죽었을 때뿐이다.
 *
 * 표시 정체성은 **본캐 닉네임**이다(§2.1). 키도 내부 id 도 화면에 나오지 않는다 —
 * 저장된 키는 언제나 `maskApiKey()` 를 거친 뒤에만 렌더된다.
 */
export interface AuthPanelProps {
  onLoggedIn?: (result: LoginResponse) => void;
  /**
   * 로그인 상태에서 로그아웃 옆에 붙는 동작들(캐릭터 선택 열기 등).
   *
   * 슬롯으로 둔 이유: 캐릭터 선택은 `features/characters` 소관인데 인증 패널이 그걸
   * 직접 import 하면 두 기능이 서로를 부르는 모양이 된다. 조립은 화면이 한다.
   */
  actions?: ReactNode;
  className?: string;
}

export function AuthPanel({ onLoggedIn, actions, className }: AuthPanelProps) {
  const session = useSessionQuery();
  const logout = useLogoutMutation();
  const storedKey = useStoredApiKey();

  if (session.isPending) {
    return (
      <SkeletonGroup className={className} label="로그인 상태를 확인하는 중">
        <Skeleton className="h-6 w-40" />
        <Skeleton shape="text" className="w-64" />
        <Skeleton className="h-control-md w-32" />
      </SkeletonGroup>
    );
  }

  if (session.isError) {
    return (
      <ErrorState
        className={className}
        title="로그인 상태를 확인하지 못했습니다"
        description="잠시 후 다시 시도해 주세요. 공개 시간표는 로그인 없이도 볼 수 있습니다."
        onRetry={() => void session.refetch()}
      />
    );
  }

  const user = session.data?.user ?? null;

  if (user === null) {
    return <ApiKeyLoginForm className={className} onSuccess={onLoggedIn} />;
  }

  const identity = user.mainCharacterName ?? user.displayName;

  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <CardOverline>로그인됨</CardOverline>
          <CardTitle>{identity}</CardTitle>
          <CardDescription>
            {user.mainWorldName !== null ? `${user.mainWorldName} · ` : ""}
            캐릭터 {user.characterCount}명 중 {user.trackedCharacterCount}명 추적 중
            {" · "}
            등록된 키 {user.credentials.length}개
          </CardDescription>
        </div>

        {storedKey !== null ? (
          // ★ 원문은 절대 렌더하지 않는다. 어느 키인지 알아볼 정도만 남긴다.
          //   크기·색을 올린 이유: 마스킹된 키는 사용자가 **읽어서 대조하는 식별자**라
          //   장식이 아니다. 12px + `ink-placeholder` 조합은 라이트 2.56:1 / 다크
          //   raised 면 4.17:1 로 어느 테마에서도 읽히지 않았다.
          <p className="flex items-center gap-2 font-mono text-body-sm text-ink-muted">
            <KeyRound aria-hidden size={14} />
            {maskApiKey(storedKey)}
          </p>
        ) : null}

        {user.trackedCharacterCount === 0 ? (
          // 빈 상태: 가입 직후에는 추적 대상이 0이다(옵트인, §2.1.1).
          <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink-muted">
            아직 추적 중인 캐릭터가 없습니다. 캐릭터를 골라야 보스 일정이 동기화됩니다.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden size={14} />
            {logout.isPending ? "로그아웃 중…" : "로그아웃"}
          </Button>
        </div>

        {/* 필수 표기(§1.1)라 반드시 읽혀야 한다 — 14px + ink-muted. */}
        <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
      </div>
    </Card>
  );
}
