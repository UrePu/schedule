"use client";

import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";

import { fetchBotSetupState } from "../data/bot-api";

import { BotLinkCodeButton } from "./bot-link-code";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 카톡 봇 연결 — **설정이지 매일 보는 화면이 아니다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * §1.1.1 의 판단을 그대로 따른다: 처음 한 번, 그리고 기기를 바꿀 때만 여는 화면이므로
 * 본문을 차지하지 않고 **버튼 뒤 모달**로 접는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28: 세 가지 일 중 **둘이 사라졌다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 창은 (1) 계정 연결 코드 발급 · (2) **방** 연결 코드 발급 · (3) **파티 → 방** 지정을
 * 했다. 방 개념이 걷히면서 (2)(3)이 근거를 잃었다 — 붙일 방이 없고, 알림이 없으니 목적지도
 * 없다. 남은 것은 (1)과 **그 결과 확인**뿐이다.
 *
 * ★ 목록이 답하는 질문이 바뀌었다. 예전에는 *"어느 방이 붙어 있나"* 였고 지금은
 *   *"어느 이름으로 내가 인식되나"* 다. 이 질문은 여전히 필요하다 — 방에서 닉네임을 바꾸면
 *   `sender_id` 자체가 달라져 연결이 끊기고, 그때 사용자가 보는 것은 "연결해 주세요" 한 줄
 *   뿐이라 **여기서 이름을 확인할 수 있어야** 무슨 일이 일어났는지 알 수 있다.
 *
 * ⚠️ 이 화면은 **어떤 클라이언트도 배포하지 않는다.** "이 계약을 만족하는 클라이언트를
 *    연결할 수 있다"까지가 우리가 말할 수 있는 전부다.
 *
 * 상태 셋(§0.3): 조회 중 스켈레톤 · 연결이 없을 때 빈 상태 · 실패 시 `ErrorState`.
 */

export interface BotLinkDialogButtonProps {
  readonly className?: string;
}

export function BotLinkDialogButton({ className }: BotLinkDialogButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <MessageSquare aria-hidden size={16} />
        카톡 봇 연결
      </Button>
      {open ? <BotLinkDialog key="bot-link" onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** `2026-09-28T12:34:56Z` → `9/28`. 언제 연결했는지만 알면 되므로 연도는 접는다. */
function shortDate(iso: string | null): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(at);
}

function BotLinkDialog({ onClose }: { readonly onClose: () => void }) {
  const setup = useQuery({
    ...dbQueryOptions(queryKeys.db.bot.setup()),
    queryFn: fetchBotSetupState,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="카톡 봇 연결"
      description="방에서 !연결 <코드> 를 입력하면 봇이 내 일정과 수익을 말해 줍니다."
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-body-sm font-semibold text-ink">연결 코드</h3>
          <p className="text-body-sm text-ink-muted">
            봇은 방에서{" "}
            <strong className="font-semibold">닉네임밖에 보지 못합니다.</strong> 아래에서
            코드를 받아 방에{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">!연결 코드</code> 를
            입력하면 &ldquo;이 닉네임이 나&rdquo;라고 알려 주게 됩니다. 처음이라면{" "}
            <Link
              href="/guide"
              className="text-primary underline-offset-2 hover:underline"
            >
              가이드
            </Link>
            를 순서대로 따라가는 편이 빠릅니다.
          </p>
          {/*
            ★ 발급 UI 는 **가이드와 같은 컴포넌트**다(`bot-link-code.tsx`). 두 벌로 두면
              "코드는 한 번만 보인다" 같은 경고가 한쪽에만 고쳐지는 날이 온다.
          */}
          <BotLinkCodeButton kind="member_link" variant="secondary" />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">연결된 닉네임</h3>

          {setup.isPending ? (
            <SkeletonGroup label="연결 상태를 불러오는 중">
              <Skeleton className="h-control-md" />
              <Skeleton className="h-control-md" />
            </SkeletonGroup>
          ) : setup.isError ? (
            <ErrorState
              title="연결 상태를 불러오지 못했습니다"
              detail={setup.error.message}
              onRetry={() => void setup.refetch()}
              className="py-6"
            />
          ) : setup.data.channels.length === 0 ? (
            <EmptyState
              title="아직 연결된 닉네임이 없습니다"
              description="위에서 코드를 받아 방에 !연결 <코드> 를 입력하면 여기에 나타납니다."
            />
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {setup.data.channels.map((identity) => {
                  const since = shortDate(identity.linkedAt);
                  return (
                    <li
                      key={identity.identityId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
                    >
                      <span className="text-body-sm text-ink">
                        {identity.displayName ?? "이름 미확인"}
                      </span>
                      <span className="text-caption text-ink-muted">
                        {since === null ? "연결됨" : `${since} 연결`}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/*
                ⚠️ **방에서 닉네임을 바꾸면 연결이 끊긴다.** 카톡이 주는 것이 닉네임뿐이라
                   우리가 막을 수 있는 일이 아니다. 말해 두지 않으면 사용자는 봇이 고장
                   났다고 읽는다 — 원인과 할 일(다시 !연결)을 함께 적는다.
              */}
              <p className="text-body-sm text-ink-muted">
                방에서 닉네임을 바꾸면 연결이 끊깁니다. 그때는 코드를 다시 받아{" "}
                <code className="rounded bg-hover-surface px-1 font-mono">!연결</code> 을
                한 번 더 입력하세요. 같은 닉네임은{" "}
                <strong className="font-semibold">한 계정에만</strong> 연결됩니다.
              </p>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
