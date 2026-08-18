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
import {
  useIsHydrated,
  useStoredCredentialIds,
} from "../lib/use-stored-api-key";
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
  /** 원문 키를 들고 있는 자격증명 id 만. 키 자체는 이 컴포넌트에 들어오지 않는다. */
  const storedCredentialIds = useStoredCredentialIds();
  /** 서버 렌더 시점에는 저장소를 못 읽으므로 "키 없음" 경고를 그리면 안 된다. */
  const hydrated = useIsHydrated();

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

  /*
   * ★ **"동기화할 수 있는가"의 판정이 바뀌었다** (§2.1.2).
   *
   *   원문 키를 이제 서버가 암호화해 보관하므로, 이 브라우저에 원문이 없다는 사실만으로는
   *   아무 문제가 아니다 — 서버가 갖고 있으면 그 계정 캐릭터는 그대로 동기화된다. 예전
   *   판정("브라우저에 없으면 경고")을 그대로 두면 다른 기기에서 등록한 키가 멀쩡히
   *   동작하는데도 매번 주황 경고가 뜬다.
   *
   *   그래서 경고 대상은 **서버에도 없고 이 브라우저에도 없는** 키뿐이다.
   */
  const storedIdSet = new Set(storedCredentialIds);
  const serverKeyCount = user.credentials.filter(
    (credential) => credential.hasServerKey,
  ).length;
  const missingKeyCount = user.credentials.filter(
    (credential) => !credential.hasServerKey && !storedIdSet.has(credential.id),
  ).length;

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

        {/*
          ★ 원문은 절대 렌더하지 않는다 — 개수만 말한다. 어느 키인지의 대조는 계정 · 키
            관리 화면(`CredentialManager`)이 마스킹으로 한다.
          ★ 키가 빠진 계정이 있으면 **경고가 아니라 사실**로 알린다. 색은 §4 대로
            tertiary orange(배경·아이콘)이고 문장은 잉크다 — red 는 실패·취소 전용이다.
        */}
        {hydrated ? (
          <p className="flex items-center gap-2 text-body-sm text-ink-muted">
            <KeyRound aria-hidden size={14} className="shrink-0" />
            서버에 보관된 키 {serverKeyCount}개 · 이 브라우저에 저장된 키{" "}
            {storedIdSet.size}개
          </p>
        ) : null}

        {hydrated && missingKeyCount > 0 ? (
          <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
            <KeyRound aria-hidden size={16} className="mt-0.5 shrink-0 text-tertiary" />
            <span>
              등록된 키 {missingKeyCount}개가 아직 서버에 보관되지 않았습니다. 그
              계정의 캐릭터는 인게임 스케줄러를 불러올 수 없으니, 계정 · 키 관리에서
              해당 키를 한 번 입력해 주세요.
            </span>
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
