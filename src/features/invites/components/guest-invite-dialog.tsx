"use client";

import { useMutation } from "@tanstack/react-query";
import { Check, Copy, LinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  Button,
  Dialog,
  ErrorState,
  HelperText,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import type { PartyMember } from "@/types/domain";

import { createGuestInvite, inviteUrl } from "../data/invite-api";

/**
 * 게스트 초대 링크 발급 다이얼로그.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 링크는 **사람에게** 붙고, 그 사람의 파티가 전부 딸려온다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 이 창은 "어느 파티의 링크"라고 말하지 않는다. 발주 요구 그대로 —
 * 1·2·3파티에 끼어 있으면 이 링크 한 장으로 셋 다 상대 계정에 붙는다. 무엇이 딸려오는지
 * 발급 결과에 파티 이름으로 적어 준다.
 *
 * ⚠️ **원문 토큰은 이 화면에만 존재한다.** 서버는 SHA-256 해시만 보관하므로 창을 닫으면
 *    다시 볼 수 없고, 재발급하면 이전 링크가 즉시 죽는다. 그 사실을 문구로 명시한다 —
 *    모르고 재발급하면 이미 보낸 링크가 조용히 망가진다.
 *
 * ⚠️ 게스트는 세션이 없어 **가용시간을 스스로 입력할 수 없다.** 겹쳐보기에서 그 사람이
 *    계속 "가능 시간 미등록"인 이유가 그것이고, 해결책이 바로 이 링크다. 그 인과를
 *    창 안에서 말해 준다.
 *
 * 상태 셋(§0.3): 발급 중 스켈레톤 · 발급 전 안내 · 실패 시 `ErrorState`.
 */

export interface GuestInviteDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 초대할 게스트. 정식 계정 구성원에게는 이 창을 열지 않는다. */
  readonly member: PartyMember | null;
}

export function GuestInviteDialog({
  open,
  onClose,
  member,
}: GuestInviteDialogProps) {
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: (guestPersonId: string) => createGuestInvite(guestPersonId),
  });

  const { mutate: issue } = invite;
  const guestPersonId = member?.personId ?? null;

  /*
    창이 열리는 순간 발급한다. 버튼을 한 번 더 누르게 할 이유가 없다 — 이 창을 여는
    행위 자체가 "링크를 만들어 달라"이기 때문이다.

    ★ 여기서 상태를 초기화하지 않는다. 부모가 열 때마다 `key` 를 갈아 **새로 마운트**하므로
      `copied` 도 mutation 도 이미 초깃값이다. effect 안에서 setState 를 부르면 마운트마다
      연쇄 렌더가 생기고(`react-hooks/set-state-in-effect`), 그 초기화는 어차피 중복이다.
    ★ 이 effect 는 "외부 시스템에 요청을 보낸다"는 effect 의 정석 용도다 — 렌더 결과를
      다시 계산하는 것이 아니다.
  */
  useEffect(() => {
    if (!open || guestPersonId === null) return;
    issue(guestPersonId);
  }, [open, guestPersonId, issue]);

  const token = invite.data?.token ?? null;
  const url = token === null ? null : inviteUrl(token);

  const handleCopy = useCallback(async () => {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // 클립보드 권한이 없을 수 있다. 주소는 화면에 그대로 있으므로 실패가 치명적이지 않다.
      setCopied(false);
    }
  }, [url]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="초대 링크 보내기"
      description={
        member === null
          ? undefined
          : `${member.displayName} 님이 들어가 있는 파티가 이 링크 하나로 전부 따라갑니다.`
      }
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {invite.isPending ? (
          <SkeletonGroup label="초대 링크를 만드는 중">
            <Skeleton className="h-control-md" />
            <Skeleton className="h-16" />
          </SkeletonGroup>
        ) : invite.isError ? (
          <ErrorState
            title="초대 링크를 만들지 못했습니다"
            detail={invite.error.message}
            onRetry={
              guestPersonId === null ? undefined : () => issue(guestPersonId)
            }
            className="py-6"
          />
        ) : url === null ? null : (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <LinkIcon aria-hidden size={16} className="shrink-0 text-primary" />
                {/*
                  주소는 코드성 문자열이라 mono(§4). 길어서 반드시 줄바꿈되어야 하고,
                  360px 에서도 가로 스크롤이 생기면 안 되므로 `break-all` 이다.
                */}
                <p className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-body-sm break-all text-ink">
                  {url}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void handleCopy()}>
                  {copied ? (
                    <Check aria-hidden size={16} />
                  ) : (
                    <Copy aria-hidden size={16} />
                  )}
                  {copied ? "복사했습니다" : "링크 복사"}
                </Button>
                <HelperText>카카오톡·디스코드에 그대로 붙여 넣으세요.</HelperText>
              </div>
            </div>

            {invite.data !== undefined && invite.data.partyNames.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-body-sm text-ink">
                  이 링크로 따라가는 파티
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {invite.data.partyNames.map((name) => (
                    <li
                      key={name}
                      className="max-w-full truncate rounded-full border border-border bg-surface px-3 py-1 text-body-sm text-ink"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/*
              주의 문구 — 임박·주의는 주황이 배경과 아이콘을 지고 **문장은 잉크**다(§4).
              빨강은 실패·취소 전용이라 여기서는 쓰지 않는다.
            */}
            <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
              이 주소는 지금 한 번만 보입니다. 창을 닫으면 다시 볼 수 없고, 다시
              열어 새로 만들면 <strong className="font-semibold">이전 링크는 즉시 사용할 수 없게 됩니다.</strong>
            </p>

            <p className="text-body-sm text-ink-muted">
              닉네임만 등록된 사람은 로그인할 수 없어 가능 시간을 직접 넣지
              못합니다. 이 링크로 계정을 만들면 그때부터 본인 가능 시간이 겹쳐보기에
              나타납니다.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
