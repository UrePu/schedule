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
 * 2026-09-28: 코드가 **한 종류만 남았다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 셋이었다 — `channel_pair`(파티방 붙이기) · `member_link`(사람 식별) ·
 * `direct_pair`(개인톡 붙이기). 방 개념이 사라지면서 방 코드 둘이 내려갔고, 그와 함께
 * 이 컴포넌트가 막으려던 사고("두 코드를 헷갈려 아무 일도 안 일어나는데 원인도 안 보임")
 * 자체가 사라졌다. 글루 문서가 굳이 *"방 연결에는 반드시 [새 방 연결 코드] 를 쓰세요"* 라고
 * 적어 두던 그 혼동이다.
 *
 * ★ **그래도 컴포넌트는 남긴다.** 발급 자리가 여전히 둘이기 때문이다(설정 모달 · 가이드).
 *   두 벌로 두면 "코드는 한 번만 보인다" 같은 경고가 한쪽에만 고쳐지는 날이 온다.
 * ★ `kind` prop 도 남긴다. 값이 하나뿐이지만 `createBotLinkCode(kind)` 가 그것을 그대로
 *   서버에 보내고, 서버는 DB enum 에 남은 옛 값과 섞이지 않게 `kind` 로 좁힌다.
 *
 * ⚠️ **코드 원문은 발급 직후 한 번만 보인다.** 서버는 해시만 갖고 있어 다시 보여 줄 수
 *    없고, 다시 발급하면 이전 코드는 즉시 죽는다. 그 사실을 반드시 함께 적는다.
 */

/** 종류마다 다른 문구. 화면이 아니라 여기서 정해야 두 자리가 같은 말을 한다. */
const COPY: Record<
  BotLinkCodeKind,
  { readonly button: string; readonly usage: (code: string) => string }
> = {
  member_link: {
    button: "내 계정 연결 코드",
    usage: (code: string) => `방에서 !연결 ${code} 를 입력하세요.`,
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
