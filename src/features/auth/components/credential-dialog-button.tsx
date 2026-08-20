"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Button, Dialog } from "@/components/ui";

import { CredentialManager } from "./credential-manager";

/**
 * 계정 · API 키 관리를 여는 버튼 + 모달.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 재사용 가능한 조각으로 뽑았나 — **키 없음에는 동선이 있어야 한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * "이 계정 키가 이 브라우저에 없습니다"라고만 말하고 끝내면, 사용자는 어디로 가야 하는지
 * 모른 채 설정 화면을 뒤져야 한다. 그래서 그 안내가 뜨는 자리(체크리스트)에서
 * **곧바로** 키를 넣을 수 있어야 하고, 관리 › 기타의 버튼과 **같은 모달**이어야 한다 —
 * 두 벌이면 하나만 고쳐지는 날이 온다.
 *
 * ⚠️ 캐릭터 선택 모달과 **중첩하지 않는다.** 네이티브 `<dialog>` 를 겹쳐 열면 Esc 와
 *    포커스 복귀가 사용자 의도와 어긋난다. 이 버튼은 언제나 형제로 놓인다.
 */

export interface CredentialDialogButtonProps {
  readonly className?: string;
  readonly label?: string;
  readonly variant?: "primary" | "secondary" | "ghost";
  readonly size?: "sm" | "md";
}

export function CredentialDialogButton({
  className,
  label = "계정 · 키 관리",
  variant = "secondary",
  size = "sm",
}: CredentialDialogButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        <KeyRound aria-hidden size={size === "sm" ? 14 : 16} />
        {label}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="계정 · API 키 관리"
        description="넥슨 계정마다 키가 하나씩 필요합니다. 부계정 캐릭터를 함께 보려면 그 계정의 키를 추가로 등록하세요."
      >
        <CredentialManager />
      </Dialog>
    </>
  );
}
