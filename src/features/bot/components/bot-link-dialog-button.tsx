"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import {
  createBotLinkCode,
  fetchBotSetupState,
  updatePartyChannel,
} from "../data/bot-api";
import type { BotLinkCode, BotLinkCodeKind } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 채팅방 연결 — **설정이지 매일 보는 화면이 아니다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * §1.1.1 의 판단을 그대로 따른다: 처음 한 번, 그리고 방을 추가할 때만 여는 화면이므로
 * 대시보드 본문을 차지하지 않고 **버튼 뒤 모달**로 접는다.
 *
 * 이 창이 하는 일은 셋뿐이다.
 *   1. **계정 연결 코드** 발급 — 방에서 `!연결 <코드>` 로 "내가 나다"를 밝힌다.
 *      닉네임은 언제든 바뀌므로 **신원의 유일한 출발점**이 이것이다(§2.3).
 *   2. **방 연결 코드** 발급 — 방 하나를 서버에 처음 붙일 때 클라이언트가 소모한다.
 *   3. **파티 → 방 지정** — 알림은 사람이 아니라 **파티에 묶인 방**으로 간다(§2.3).
 *      고르지 않으면 웹 전용 파티이고 푸시가 없다. 그게 정상 상태다.
 *
 * ⚠️ **코드 원문은 발급 직후 한 번만 보인다.** 서버는 해시만 갖고 있어 다시 보여 줄 수
 *    없고, 다시 발급하면 이전 코드는 즉시 죽는다. 그 사실을 문구로 명시한다.
 *
 * ⚠️ 이 화면은 **어떤 클라이언트도 배포하지 않는다.** "이 계약을 만족하는 클라이언트를
 *    연결할 수 있다"까지가 우리가 말할 수 있는 전부다.
 *
 * 상태 셋(§0.3): 조회 중 스켈레톤 · 방이 없을 때 빈 상태 · 실패 시 `ErrorState`.
 */

export interface BotLinkDialogButtonProps {
  readonly className?: string;
}

export function BotLinkDialogButton({ className }: BotLinkDialogButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" size="sm" className={className} onClick={() => setOpen(true)}>
        <MessageSquare aria-hidden size={16} />
        채팅방 연결
      </Button>
      {open ? <BotLinkDialog key="bot-link" onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BotLinkDialog({ onClose }: { readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<BotLinkCode | null>(null);

  const setup = useQuery({
    ...dbQueryOptions(queryKeys.db.bot.setup()),
    queryFn: fetchBotSetupState,
  });

  const issue = useMutation({
    mutationFn: (kind: BotLinkCodeKind) => createBotLinkCode(kind),
    onSuccess: (code) => setIssued(code),
  });

  const bind = useMutation({
    mutationFn: (input: { partyId: string; channelId: string | null }) =>
      updatePartyChannel(input.partyId, input.channelId),
    onSuccess: () => {
      // §2.4 Rule 5 — 무효화 대상 키를 명시한다.
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.bot.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="채팅방 연결"
      description="명령으로 일정과 결정석을 확인하고, 파티 알림을 받을 방을 정합니다."
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">연결 코드</h3>
          <p className="text-body-sm text-ink-muted">
            방에서 <span className="font-mono">!연결 코드</span> 를 입력하면 그 방의 내
            메시지가 이 계정으로 인식됩니다. 닉네임은 바뀔 수 있어 식별에 쓰지 않습니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={issue.isPending}
              onClick={() => issue.mutate("member_link")}
            >
              내 계정 연결 코드
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={issue.isPending}
              onClick={() => issue.mutate("channel_pair")}
            >
              새 방 연결 코드
            </Button>
          </div>

          {issue.isError ? (
            <p className="text-body-sm text-error">{issue.error.message}</p>
          ) : null}

          {issued === null ? (
            <HelperText>코드는 10분 동안만 유효합니다.</HelperText>
          ) : (
            <div className="flex flex-col gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
              <p className="font-mono text-subhead tracking-[0.2em] text-ink">{issued.code}</p>
              <p className="text-body-sm text-ink">
                {issued.kind === "member_link"
                  ? "방에 !연결 " + issued.code + " 를 입력하세요."
                  : "이 코드로 방 하나를 서버에 연결할 수 있습니다."}
              </p>
              <p className="text-body-sm text-ink">
                이 코드는 지금 한 번만 보입니다. 다시 발급하면{" "}
                <strong className="font-semibold">이전 코드는 즉시 사용할 수 없게 됩니다.</strong>
              </p>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">연결된 방과 파티 알림</h3>

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
              title="아직 연결된 방이 없습니다"
              description="위에서 방 연결 코드를 발급한 뒤, 그 코드를 사용하는 클라이언트를 방에 두면 여기에 나타납니다."
            />
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {setup.data.channels.map((channel) => (
                  <li
                    key={channel.channelId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
                  >
                    <span className="text-body-sm text-ink">
                      {channel.displayName ?? "이름 미확인"}
                      {channel.owner ? " · 내가 연결한 방" : ""}
                    </span>
                    <span
                      className={cn(
                        "text-caption",
                        channel.linked ? "text-ink-muted" : "text-tertiary",
                      )}
                    >
                      {channel.status === "degraded"
                        ? "배달 실패 상태"
                        : channel.linked
                          ? "계정 연결됨"
                          : "계정 미연결"}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="text-body-sm text-ink-muted">
                알림은 사람이 아니라 <strong className="font-semibold">파티에 묶인 방</strong>
                으로 갑니다. 고르지 않으면 알림 없이 웹에서만 쓰는 파티입니다.
              </p>

              {setup.data.parties.length === 0 ? (
                <HelperText>아직 참여 중인 파티가 없습니다.</HelperText>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {setup.data.parties.map((party) => (
                    <li
                      key={party.partyId}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                        {party.name}
                      </span>
                      <select
                        aria-label={`${party.name} 알림이 갈 방`}
                        value={party.channelId ?? ""}
                        disabled={bind.isPending}
                        onChange={(event) =>
                          bind.mutate({
                            partyId: party.partyId,
                            channelId: event.target.value === "" ? null : event.target.value,
                          })
                        }
                        className={cn(
                          "h-control-sm min-w-0 appearance-none rounded-md border border-border bg-surface",
                          "py-1 pr-3 pl-2.5 text-body-sm text-ink",
                          "transition duration-200 outline-none",
                          "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                          "disabled:cursor-not-allowed disabled:bg-background disabled:text-ink/50",
                        )}
                      >
                        <option value="">알림 없음</option>
                        {setup.data.channels.map((channel) => (
                          <option key={channel.channelId} value={channel.channelId}>
                            {channel.displayName ?? "연결된 방"}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}

              {bind.isError ? (
                <p className="text-body-sm text-error">{bind.error.message}</p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
