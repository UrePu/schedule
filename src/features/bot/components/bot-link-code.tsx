"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button, HelperText } from "@/components/ui";
import { cn } from "@/lib/utils";

import { createBotLinkCode } from "../data/bot-api";
import type { BotLinkCode, BotLinkCodeKind } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 연결 코드 발급 버튼 — **채팅방 연결 창과 가이드가 같은 것을 쓴다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"실제로 가이드 문서에서도 채팅방 연결과 계정연결을 설명해주고
 * 생성도 거기서도 가능하게 해서 그냥 12345 순서대로 따라하면되도록"*.
 *
 * 즉 코드를 발급하는 자리가 **둘**이 됐다(설정 모달 · 가이드). 그래서 발급 UI 를 여기로
 * 뽑았다 — 두 벌로 두면 "코드는 한 번만 보인다"는 경고나 유효 시간 문구가 한쪽에만
 * 고쳐지는 날이 온다(§0.2-1 동일 적용).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 코드가 **두 종류**라는 사실이 이 컴포넌트의 존재 이유다
 * ─────────────────────────────────────────────────────────────────────────────
 *   `channel_pair` — **방**을 서버에 붙인다. 방마다 최초 1회. 클라이언트가 `!페어링` 으로 쓴다.
 *   `member_link`  — **사람**을 그 방에서 식별한다. 사람마다 최초 1회. `!연결` 로 쓴다.
 *
 * 둘을 헷갈리면 아무 일도 일어나지 않고 원인도 안 보인다(글루 문서가 굳이
 * *"방 연결에는 반드시 [새 방 연결 코드] 를 쓰세요"* 라고 적어 둔 이유다). 그래서
 * 발급 버튼과 **그 코드를 어디에 치는지**를 한 덩어리로 묶어 둔다 — 코드만 덜렁 주면
 * 사용자가 다시 어느 쪽인지 골라야 한다.
 *
 * ⚠️ **코드 원문은 발급 직후 한 번만 보인다.** 서버는 해시만 갖고 있어 다시 보여 줄 수
 *    없고, 다시 발급하면 이전 코드는 즉시 죽는다. 그 사실을 반드시 함께 적는다.
 * ⚠️ 각 종류가 **자기 상태를 갖는다.** 예전에는 두 버튼이 `issued` 하나를 공유해서
 *    방 코드를 발급하면 화면에 떠 있던 계정 코드가 사라졌다 — 순서대로 따라 하는
 *    가이드에서는 그게 곧 "4번 하다가 5번 것이 없어졌다"가 된다.
 */

/** 종류마다 다른 문구. 화면이 아니라 여기서 정해야 두 자리가 같은 말을 한다. */
const COPY: Record<
  BotLinkCodeKind,
  { readonly button: string; readonly usage: (code: string) => string }
> = {
  channel_pair: {
    button: "새 방 연결 코드",
    usage: (code) => `방에서 !페어링 ${code} 를 입력하세요.`,
  },
  member_link: {
    button: "내 계정 연결 코드",
    usage: (code) => `방에서 !연결 ${code} 를 입력하세요.`,
  },
};

export interface BotLinkCodeButtonProps {
  readonly kind: BotLinkCodeKind;
  /** 버튼 강조 정도. 가이드에서는 그 단계의 주 동작이라 기본(primary)을 쓴다. */
  readonly variant?: "primary" | "secondary";
  readonly className?: string;
}

export function BotLinkCodeButton({
  kind,
  variant = "primary",
  className,
}: BotLinkCodeButtonProps) {
  const [issued, setIssued] = useState<BotLinkCode | null>(null);

  const issue = useMutation({
    mutationFn: () => createBotLinkCode(kind),
    onSuccess: setIssued,
  });

  const copy = COPY[kind];

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={variant === "primary" ? "primary" : "secondary"}
          disabled={issue.isPending}
          onClick={() => {
            issue.mutate();
          }}
        >
          {issued === null ? copy.button : "다시 발급"}
        </Button>
        {issued === null ? (
          <HelperText>코드는 10분 동안만 유효합니다.</HelperText>
        ) : null}
      </div>

      {issue.isError ? (
        <p className="text-body-sm text-error">{issue.error.message}</p>
      ) : null}

      {issued === null ? null : (
        /*
          경고 톤(`chip-soon-*`)을 쓰는 이유: 이 상자는 "지금 아니면 다시 못 본다"는
          시한부 정보다. red(`failed`)는 실패 전용이라(§4) 여기 쓰면 발급이 실패한
          것처럼 읽힌다.
        */
        <div className="flex flex-col gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
          <p className="font-mono text-subhead tracking-[0.2em] text-ink">
            {issued.code}
          </p>
          <p className="text-body-sm text-ink">{copy.usage(issued.code)}</p>
          <p className="text-body-sm text-ink">
            이 코드는 지금 한 번만 보입니다. 다시 발급하면{" "}
            <strong className="font-semibold">
              이전 코드는 즉시 사용할 수 없게 됩니다.
            </strong>
          </p>
        </div>
      )}
    </div>
  );
}
