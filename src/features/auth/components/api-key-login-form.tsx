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
  isApiKeyInputUsable,
  maskApiKey,
  normalizeApiKeyInput,
} from "../lib/api-key";
import { useAnyStoredApiKey } from "../lib/use-stored-api-key";
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
 * ─────────────────────────────────────────────────────────────────────────────
 * "저장된 키"는 **아무 키 하나**다 (§2.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 저장소는 이제 `credentialId → 원문 키` 맵이라 키가 여러 개 들어 있다. 그런데 로그인은
 * **어느 연결 키로 해도 같은 사람**으로 들어오므로(§2.1), 이 폼은 그중 하나만 있으면
 * 충분하다 — `useAnyStoredApiKey()` 가 사전순으로 결정론적으로 하나를 고른다.
 *
 * ⚠️ **"다른 키 사용"이 저장소를 지우지 않는다.** 예전에는 그 버튼이 유일한 칸을 비우는
 *    동작이었지만, 지금 지우면 **다른 넥슨 계정의 키까지 함께 사라진다.** 그래서 이제는
 *    입력 모드로 전환할 뿐이고, 저장된 키는 그대로 남는다. 전부 지우는 것은 로그아웃뿐이다.
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
  /** 저장된 키가 있어도 **직접 입력**하겠다고 밝힌 상태. 저장소는 건드리지 않는다. */
  const [typingAnotherKey, setTypingAnotherKey] = useState(false);
  const anyStoredKey = useAnyStoredApiKey();
  const login = useLoginMutation();

  const storedKey = typingAnotherKey ? null : anyStoredKey;
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
          setTypingAnotherKey(false);
          onSuccess?.(result);
        },
      },
    );
  }

  /**
   * 입력 모드로 전환만 한다. **저장된 키를 지우지 않는다** — 지우면 다른 넥슨 계정의
   * 키까지 사라져 그 계정 캐릭터가 통째로 동기화 불가가 된다.
   */
  function handleUseAnotherKey(): void {
    setTypingAnotherKey(true);
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
              이 키로 바로 로그인합니다. 연결된 키는 어느 것으로 로그인해도 같은
              계정으로 들어옵니다.
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
              다른 키 입력
            </Button>
          ) : anyStoredKey !== null ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setTypingAnotherKey(false);
                login.reset();
              }}
              disabled={login.isPending}
            >
              저장된 키 사용
            </Button>
          ) : null}
        </div>

        <p className="text-body-sm text-ink-muted">Data based on NEXON Open API</p>
      </form>
    </Card>
  );
}
