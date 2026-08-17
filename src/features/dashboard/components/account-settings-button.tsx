"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Button, Dialog } from "@/components/ui";
import { CredentialManager } from "@/features/auth/components";

/**
 * 계정 · API 키 관리를 **버튼 뒤 모달로** 접는다 (§1.1.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 대시보드 본문에서 뺐는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 관리는 **설정이지 매일 보는 것이 아니다.** 처음 한 번, 그리고 부계정 키를 추가할 때
 * 열면 그만인 화면이 첫 화면의 절반을 차지하면서, 사람들이 앱을 여는 이유인
 * **이번 주 체크리스트**를 아래로 밀어냈다.
 *
 * ★ **기능은 그대로다.** 진입만 접었다 — `CredentialManager` 는 한 줄도 바뀌지 않았고
 *   키 추가·목록·409 처리(§2.1)가 전부 살아 있다.
 *
 * ⚠️ 캐릭터 선택 모달(`CharacterPickerTrigger`)은 **이 모달 안에 넣지 않는다.**
 *    네이티브 `<dialog>` 를 중첩해 열면 Esc 와 포커스 복귀가 사용자 의도와 어긋나기
 *    쉽다. 두 모달은 형제로 두고 대시보드 헤더에서 각각 연다.
 */

export interface AccountSettingsButtonProps {
  readonly className?: string;
}

export function AccountSettingsButton({
  className,
}: AccountSettingsButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <KeyRound aria-hidden size={16} />
        계정 · 키 관리
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
