"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LinkIcon, PartyPopper, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { ApiKeyLoginForm } from "@/features/auth/components";
import { queryKeys } from "@/lib/query-keys";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  ErrorState,
} from "@/components/ui";
import type { InviteClaimResult, InviteSummary } from "@/types/domain";

import { claimInviteToken } from "../data/invite-api";

/**
 * 초대 링크 화면 (`/invite/[token]`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면이 하는 일은 하나다 — **"이 게스트를 내 계정으로 받는다"**
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요구: 링크를 쓰면 그 사람이 끼어 있던 파티가 **전부** 딸려온다. 그래서 화면은
 * 먼저 **무엇이 딸려오는지**(파티 이름 목록)를 보여 주고, 그다음에 받을지 묻는다.
 * 이름만 보고 "이게 뭐지" 하며 API 키를 넣게 만들지 않는다.
 *
 * ★ **비로그인도 내용을 본다.** 받는 사람은 대개 아직 계정이 없다. 로그인해야만 보이면
 *   무엇에 로그인하는지 모르는 채로 키를 넣게 된다. 서버가 세션 없이도 200 을 준다.
 * ★ **로그인하면 곧바로 승계한다.** 로그인 → 다시 버튼 누르기 2단계는, 첫 단계를 마친
 *   사람이 "됐나?" 하고 화면을 떠나기 딱 좋다. `ApiKeyLoginForm` 의 `onSuccess` 에서
 *   승계를 이어 붙여 한 동작으로 만든다.
 *
 * 상태 셋(§0.3)은 전부 있다:
 *   - **빈 상태** — 쓸 수 없는 링크(만료/사용됨). 오류가 아니라 안내다(빨강 금지, §4).
 *   - **로딩** — 승계 중 버튼이 "받는 중…" 으로 바뀌고 비활성화된다.
 *   - **오류** — 서버가 준 한국어 문구를 그대로 보여 준다.
 */

export interface InviteClaimPanelProps {
  /** 링크의 원문 토큰. 승계 요청 본문으로만 나간다(경로·쿼리에 다시 싣지 않는다). */
  readonly token: string;
  /** 서버가 미리 풀어 준 내용. 쓸 수 없는 링크면 `null`. */
  readonly summary: InviteSummary | null;
  readonly isSignedIn: boolean;
}

export function InviteClaimPanel({
  token,
  summary,
  isSignedIn,
}: InviteClaimPanelProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [claimed, setClaimed] = useState<InviteClaimResult | null>(null);

  const claim = useMutation({
    mutationFn: () => claimInviteToken(token),
    onSuccess: (result) => {
      setClaimed(result);
      /*
        승계는 **파티 · 구성원 · 가용시간 · 일정**을 한꺼번에 바꾼다. 하나만 날리면
        화면 절반이 옛 답을 들고 남으므로 DB 네임스페이스를 통째로 무효화한다.
        넥슨 응답(`"nexon"`)은 건드리지 않는다 — 쿼터를 태울 이유가 없다.
      */
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.root() });
      // 서버 컴포넌트가 그린 이 페이지의 세션·초대 상태도 새로 그린다.
      router.refresh();
    },
  });

  /** 로그인 직후 이어서 승계한다. 사용자에게는 한 동작으로 보인다. */
  const handleLoggedIn = useCallback(() => {
    claim.mutate();
  }, [claim]);

  // ── 쓸 수 없는 링크 ─────────────────────────────────────────────────────
  if (summary === null) {
    return (
      <Card>
        <EmptyState
          icon={<LinkIcon size={24} />}
          title="이 초대 링크는 쓸 수 없습니다"
          description="링크가 만료되었거나 이미 사용되었습니다. 초대한 사람에게 새 링크를 받아 주세요."
          action={
            <Link href="/schedule">
              <Button size="sm" variant="secondary">
                일정 화면으로
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  // ── 승계 완료 ───────────────────────────────────────────────────────────
  if (claimed !== null) {
    return (
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2">
            <PartyPopper aria-hidden size={20} className="mt-0.5 text-primary" />
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle>파티를 모두 가져왔습니다</CardTitle>
              <CardDescription>
                {summary.guestDisplayName} 님으로 들어가 있던 자리가 이제 내
                계정입니다. 파티 안 번호는 그대로 유지됩니다.
              </CardDescription>
            </div>
          </div>

          <ul className="flex flex-col gap-1.5">
            {claimed.partyNames.length === 0 ? (
              <li className="text-body-sm text-ink-muted">
                딸려온 파티가 없습니다. 초대한 사람이 파티에 넣어 주면 바로
                보입니다.
              </li>
            ) : (
              claimed.partyNames.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink"
                >
                  <CheckCircle2
                    aria-hidden
                    size={16}
                    className="shrink-0 text-success"
                  />
                  <span className="truncate">{name}</span>
                </li>
              ))
            )}
          </ul>

          {claimed.mergedParticipants > 0 ? (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
              이미 내 계정으로 들어가 있던 파티{" "}
              <strong className="font-semibold">
                {claimed.mergedParticipants}
              </strong>
              개는 한 자리로 합쳤습니다.
            </p>
          ) : null}

          <Link href="/schedule">
            <Button>겹쳐보기 열기</Button>
          </Link>
        </div>
      </Card>
    );
  }

  // ── 받기 전 ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2">
            <Users aria-hidden size={20} className="mt-0.5 text-primary" />
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle>
                {summary.guestDisplayName} 님으로 초대되었습니다
              </CardTitle>
              <CardDescription>
                아래 파티에 이미 자리가 잡혀 있습니다. 링크를 받으면 그 자리가
                모두 내 계정으로 옮겨 오고, 파티원들의 가능 시간이 바로 보입니다.
              </CardDescription>
            </div>
          </div>

          {summary.partyNames.length === 0 ? (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
              아직 들어가 있는 파티가 없습니다. 링크를 받아 두면 초대한 사람이
              파티에 넣는 즉시 내 화면에 나타납니다.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {summary.partyNames.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-ink"
                >
                  <Users aria-hidden size={16} className="shrink-0 text-ink-muted" />
                  <span className="truncate">{name}</span>
                </li>
              ))}
            </ul>
          )}

          {isSignedIn ? (
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => claim.mutate()}
                disabled={claim.isPending}
              >
                {claim.isPending ? "받는 중…" : "내 계정으로 받기"}
              </Button>
              <p className="text-body-sm text-ink-muted">
                지금 로그인한 계정으로 가져옵니다. 다른 계정으로 받으려면 먼저
                로그아웃해 주세요.
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
              받으려면 넥슨 API 키로 로그인해야 합니다. 로그인하면 곧바로 이
              자리가 계정에 붙습니다.
            </p>
          )}

          {claim.error !== null ? (
            <ErrorState
              title="받지 못했습니다"
              detail={claim.error.message}
              className="py-6"
            />
          ) : null}
        </div>
      </Card>

      {isSignedIn ? null : (
        <ApiKeyLoginForm onSuccess={handleLoggedIn} />
      )}
    </div>
  );
}
