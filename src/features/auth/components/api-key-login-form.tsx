"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useId, useState } from "react";

import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  HelperText,
  Input,
  Label,
} from "@/components/ui";

import { ApiRequestError } from "../data/auth-api";
import { useLoginMutation } from "../data/auth-queries";
import {
  clearStoredApiKey,
  isApiKeyInputUsable,
  maskApiKey,
  normalizeApiKeyInput,
} from "../lib/api-key";
import { useStoredApiKey } from "../lib/use-stored-api-key";
import type { LoginResponse } from "../types";

/**
 * 넥슨 API 키 로그인 폼.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면이 지키는 것
 * ─────────────────────────────────────────────────────────────────────────────
 * - **키를 그대로 그리지 않는다.** 저장된 키는 마스킹해서 "어느 키인지"만 알려 준다.
 * - 입력 중에도 `type="password"` 라 어깨너머·화면공유에 노출되지 않는다.
 * - 저장된 키가 있으면 **한 번 누르면 로그인**된다. 다시 입력하게 하지 않는다(§2.1.1).
 * - 로딩·에러 상태가 모두 있다(DoD §0.3). 에러 문구는 서버가 준 도메인 문구를 쓴다 —
 *   화면이 `OPENAPI0000X` 를 해석하지 않는다.
 *
 * "저장된 키를 쓸까"를 **별도 상태로 두지 않았다.** 저장소가 곧 진실이므로
 * `useStoredApiKey()` 하나만 본다. "다른 키 사용"은 저장소를 비우는 동작이고,
 * 그 결과로 입력 폼이 나타난다 — 상태 두 개가 어긋날 여지 자체를 없앴다.
 *
 * ⚠️ 키 검증은 **넥슨이 한다.** 접두사 같은 형식으로 미리 판정하지 않는다
 *   (research-NEXON-API #8 에서 그렇게 하지 않기로 정했다). 여기서 막는 건 빈 값뿐이다.
 */

export interface ApiKeyLoginFormProps {
  /** 로그인 성공 후 처리(캐릭터 선택 모달 열기 등). */
  onSuccess?: (result: LoginResponse) => void;
  className?: string;
}

export function ApiKeyLoginForm({
  onSuccess,
  className,
}: ApiKeyLoginFormProps) {
  const inputId = useId();
  const helperId = `${inputId}-helper`;

  const [typedKey, setTypedKey] = useState("");
  const storedKey = useStoredApiKey();
  const login = useLoginMutation();

  const effectiveKey = storedKey ?? typedKey;
  const canSubmit = isApiKeyInputUsable(effectiveKey) && !login.isPending;

  const errorMessage =
    login.error === null
      ? null
      : login.error instanceof ApiRequestError
        ? login.error.message
        : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;

    login.mutate(
      { apiKey: normalizeApiKeyInput(effectiveKey) },
      {
        onSuccess: (result) => {
          // 저장은 mutation 의 onSuccess 가 한다(서버가 유효하다고 말한 키만 남긴다).
          setTypedKey("");
          onSuccess?.(result);
        },
      },
    );
  }

  function handleUseAnotherKey(): void {
    clearStoredApiKey();
    setTypedKey("");
    login.reset();
  }

  return (
    <Card className={className}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>넥슨 API 키로 로그인</CardTitle>
          <CardDescription>
            키는 이 브라우저에만 저장되며, 서버에는 해시만 남습니다.
          </CardDescription>
        </div>

        {storedKey !== null ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>저장된 키</Label>
            <div
              id={inputId}
              className="flex h-control-md items-center gap-2 rounded-md border border-border bg-background px-3 font-mono text-body-sm text-ink-label"
            >
              <KeyRound aria-hidden size={14} />
              <span>{maskApiKey(storedKey)}</span>
            </div>
            <HelperText id={helperId}>
              이 키로 바로 로그인합니다. 다른 계정이면 아래에서 키를 바꿔 주세요.
            </HelperText>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId} required>
              API 키
            </Label>
            <Input
              id={inputId}
              // 화면공유·어깨너머 노출을 막는다. 키는 비밀번호와 같은 취급이다.
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="넥슨 오픈 API 에서 발급한 키를 붙여넣으세요"
              value={typedKey}
              invalid={errorMessage !== null}
              aria-describedby={helperId}
              onChange={(event) => setTypedKey(event.target.value)}
              disabled={login.isPending}
              className="font-mono"
            />
            <HelperText id={helperId}>
              openapi.nexon.com &gt; 내 애플리케이션 에서 발급합니다.
            </HelperText>
          </div>
        )}

        {errorMessage !== null ? (
          <HelperText tone="error" role="alert">
            {errorMessage}
          </HelperText>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!canSubmit}>
            {login.isPending ? (
              <>
                <Loader2 aria-hidden size={14} className="animate-spin" />
                확인하는 중…
              </>
            ) : (
              "로그인"
            )}
          </Button>

          {storedKey !== null ? (
            <Button
              type="button"
              variant="ghost"
              onClick={handleUseAnotherKey}
              disabled={login.isPending}
            >
              다른 키 사용
            </Button>
          ) : null}
        </div>

        <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
      </form>
    </Card>
  );
}
