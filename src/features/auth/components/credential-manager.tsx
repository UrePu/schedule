"use client";

import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Plus, ShieldAlert, X } from "lucide-react";
import { useId, useState } from "react";

import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
  StatusChip,
} from "@/components/ui";

import { ApiRequestError } from "../data/auth-api";
import {
  useAddCredentialMutation,
  useCredentialsQuery,
} from "../data/auth-queries";
import { isApiKeyInputUsable, normalizeApiKeyInput } from "../lib/api-key";
import { useCredentialKeyMasks } from "../lib/use-stored-api-key";
import type { CredentialSummary } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 등록된 넥슨 API 키 관리 (CLAUDE.md §2.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * §2.1 은 **한 사람이 넥슨 계정을 여러 개 갖는다**고 규정한다. 키 하나는 그 키를 발급한
 * 계정의 캐릭터만 읽으므로, 부계정 캐릭터를 함께 보려면 그 계정의 키를 **추가로** 등록하는
 * 수밖에 없다. 서버(`POST /api/auth/credentials`)는 이미 동작했는데 화면에 진입점이
 * 없어서 기능이 존재하지 않는 것과 같았다. 이 컴포넌트가 그 구멍을 메운다.
 *
 * ── 마스킹된 키는 어디서 오는가 ──────────────────────────────────────────────
 * **서버가 아니다.** 원문 키는 DB 에 저장하지 않으므로(§2.1.1) 서버는 마스킹조차 만들 수
 * 없다. 화면에 보이는 `test_5••••••••fb0d` 는 **그 키를 실제로 입력한 브라우저**가
 * localStorage 에 남겨 둔 마스킹 스냅샷이다(`lib/api-key.ts`). 그래서 다른 기기에서
 * 등록한 키에는 마스킹이 없고, 그것은 오류가 아니라 정상 상태라 그렇게 표시한다.
 *
 * ── 409 는 뭉개지 않는다 ─────────────────────────────────────────────────────
 * 이미 다른 사람에게 묶인 키를 조용히 옮기면 계정 탈취다. 서버가 409
 * `key_owned_by_other_account` 로 거부하며, 화면은 그 종류를 **다른 실패와 구분해**
 * 원인이 보이는 문구로 안내한다. "요청을 처리하지 못했습니다" 로 접으면 사용자는 자기
 * 키가 왜 거부됐는지 영원히 알 수 없다.
 *
 * ── 주 키(primary)와 로그인 자격은 무관하다 ─────────────────────────────────
 * `isPrimary` 는 "본캐가 속한 계정의 키"라는 뜻일 뿐이고, 어느 키로 로그인해도 같은
 * 사람으로 들어온다(§2.1). 그래서 배지는 "주 키"라고만 쓰고 "로그인용" 같은 말을 쓰지 않는다.
 */

function formatValidatedAt(value: string | null): string {
  if (value === null) return "확인 이력 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 이력 없음";
  // 표시는 언제나 KST 고정(§2). Intl 이 타임존을 직접 받으므로 별도 변환이 없다.
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

interface CredentialRowProps {
  readonly credential: CredentialSummary;
  readonly maskedKey: string | null;
}

function CredentialRow({ credential, maskedKey }: CredentialRowProps) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-pad-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-headline text-body font-semibold text-ink">
          {credential.label ?? "이름 없는 키"}
        </span>
        {credential.isPrimary ? (
          <StatusChip status="done" title="본캐가 속한 계정의 키입니다.">
            주 키
          </StatusChip>
        ) : null}
        {credential.isInvalidated ? (
          // 실패(빨강)가 맞다 — 이 키로는 더 이상 넥슨을 부를 수 없다(§4).
          <StatusChip status="failed">사용 불가</StatusChip>
        ) : null}
      </div>

      <p className="flex items-center gap-2 font-mono text-body-sm text-ink-muted">
        <KeyRound aria-hidden size={14} className="shrink-0" />
        {maskedKey ?? (
          <span className="font-sans">
            다른 기기에서 등록되어 이 브라우저에는 키가 없습니다
          </span>
        )}
      </p>

      <p className="text-body-sm text-ink-muted tabular-nums">
        넥슨 계정 {credential.nexonAccountCount}개 · 캐릭터{" "}
        {credential.characterCount}명 · 마지막 확인{" "}
        {formatValidatedAt(credential.lastValidatedAt)}
      </p>
    </li>
  );
}

export interface CredentialManagerProps {
  readonly className?: string;
}

export function CredentialManager({ className }: CredentialManagerProps) {
  const router = useRouter();
  const keyInputId = useId();
  const labelInputId = useId();
  const helperId = `${keyInputId}-helper`;

  const credentials = useCredentialsQuery();
  const masks = useCredentialKeyMasks();
  const addCredential = useAddCredentialMutation();

  const [formOpen, setFormOpen] = useState(false);
  const [typedKey, setTypedKey] = useState("");
  const [typedLabel, setTypedLabel] = useState("");

  const conflict =
    addCredential.error instanceof ApiRequestError &&
    addCredential.error.kind === "key_owned_by_other_account";

  const errorMessage =
    addCredential.error === null
      ? null
      : addCredential.error instanceof ApiRequestError
        ? addCredential.error.message
        : "키를 추가하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  const canSubmit = isApiKeyInputUsable(typedKey) && !addCredential.isPending;

  function closeForm(): void {
    setFormOpen(false);
    setTypedKey("");
    setTypedLabel("");
    addCredential.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;

    const label = typedLabel.trim();
    addCredential.mutate(
      {
        apiKey: normalizeApiKeyInput(typedKey),
        ...(label === "" ? {} : { label }),
      },
      {
        onSuccess: () => {
          closeForm();
          // 대시보드는 서버 컴포넌트다. 새 계정의 캐릭터가 합쳐졌으니 서버 렌더를
          // 다시 받아야 추적 요약·수익 카드가 따라온다.
          router.refresh();
        },
      },
    );
  }

  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="text-body-lg">계정 · 키 관리</CardTitle>
            <CardDescription>
              넥슨 계정마다 키가 따로 발급됩니다. 부계정 키를 추가하면 그 계정의
              캐릭터가 이 계정에 합쳐집니다.
            </CardDescription>
          </div>
          {formOpen ? null : (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => {
                addCredential.reset();
                setFormOpen(true);
              }}
            >
              <Plus aria-hidden size={16} />키 추가
            </Button>
          )}
        </div>

        {/* ── 목록: 로딩 · 에러 · 빈 상태 · 정상 네 가지가 전부 있다(DoD §0.3) ── */}
        {credentials.isPending ? (
          <SkeletonGroup label="등록된 키를 불러오는 중">
            <Skeleton className="h-6 w-40" />
            <Skeleton shape="text" className="w-64" />
          </SkeletonGroup>
        ) : credentials.isError ? (
          <ErrorState
            title="키 목록을 불러오지 못했습니다"
            description="잠시 후 다시 시도해 주세요."
            onRetry={() => void credentials.refetch()}
          />
        ) : credentials.data.length === 0 ? (
          // 실제로는 로그인한 사람에게 최소 1개가 있다. 그래도 빈 상태를 둔다 —
          // 키가 전부 회수된 계정이 이 화면에 도달할 수 있기 때문이다.
          <EmptyState
            icon={<KeyRound size={24} />}
            title="등록된 키가 없습니다"
            description="넥슨 오픈 API 키를 추가하면 그 계정의 캐릭터를 불러옵니다."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {credentials.data.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                maskedKey={masks[credential.id] ?? null}
              />
            ))}
          </ul>
        )}

        {/* ── 키 추가 폼 ─────────────────────────────────────────────────── */}
        {formOpen ? (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3 rounded-md border border-border bg-background p-pad-md"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-headline text-body font-semibold text-ink">
                키 추가
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeForm}
                aria-label="키 추가 취소"
                disabled={addCredential.isPending}
              >
                <X aria-hidden size={16} />
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={labelInputId}>이름 (선택)</Label>
              <Input
                id={labelInputId}
                value={typedLabel}
                maxLength={40}
                placeholder="예: 부계정"
                autoComplete="off"
                disabled={addCredential.isPending}
                onChange={(event) => setTypedLabel(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={keyInputId} required>
                API 키
              </Label>
              <Input
                id={keyInputId}
                // 로그인 폼과 같은 취급 — 화면공유·어깨너머 노출을 막는다.
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="추가할 넥슨 계정의 API 키"
                value={typedKey}
                invalid={errorMessage !== null}
                aria-describedby={helperId}
                disabled={addCredential.isPending}
                onChange={(event) => setTypedKey(event.target.value)}
                className="font-mono"
              />
              <HelperText id={helperId}>
                키는 서버에 저장되지 않습니다. 확인 후 해시만 남습니다.
              </HelperText>
            </div>

            {errorMessage !== null ? (
              conflict ? (
                /*
                  409 는 **원인이 보이는 문구**로 따로 그린다. 일반 오류와 같은 모양으로
                  뭉개면 사용자는 "왜 내 키가 거부됐는지"를 알 수 없다.
                */
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-chip-failed-border bg-chip-failed-bg px-3 py-2"
                >
                  <ShieldAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-error"
                  />
                  <div className="flex flex-col gap-1">
                    <p className="text-body-sm font-semibold text-ink">
                      이 키는 다른 계정에 등록되어 있습니다
                    </p>
                    {/*
                      틴트 배경 위에서는 `ink-muted` 가 라이트 4.42:1 로 AA 를 아슬하게
                      놓친다(다크는 8.22:1 이라 다크만 보면 지나친다). 한 단계 진한
                      `ink-label` 은 라이트 9.55 / 다크 10.93 이다.
                    */}
                    <p className="text-body-sm text-ink-label">
                      한 키는 한 사람에게만 묶입니다. 소유자를 조용히 바꾸면 계정
                      탈취가 되므로 옮겨 붙이지 않습니다. 그 키로 로그인하면 그쪽
                      계정으로 들어갑니다.
                    </p>
                  </div>
                </div>
              ) : (
                <HelperText tone="error" role="alert">
                  {errorMessage}
                </HelperText>
              )
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {addCredential.isPending ? (
                  <>
                    <Loader2 aria-hidden size={14} className="animate-spin" />
                    확인하는 중…
                  </>
                ) : (
                  "추가"
                )}
              </Button>
              <span className="text-body-sm text-ink-muted">
                넥슨 호출 1건을 사용합니다.
              </span>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
