"use client";

import { CredentialDialogButton } from "@/features/auth/components";

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
 * ★ **기능은 그대로다.** 진입만 접었다 — 키 추가·목록·409 처리(§2.1)가 전부 살아 있다.
 *
 * ⚠️ 실제 버튼과 모달은 `CredentialDialogButton`(features/auth) 이 갖고 있다. 같은 모달로
 *    가는 입구가 여기 말고 **체크리스트의 "키 없음" 안내**에도 필요해졌기 때문이며
 *    (§2.1 — 계정마다 키가 따로라 브라우저에 키가 빠질 수 있다), 두 벌로 구현하면
 *    하나만 고쳐지는 날이 온다. 이 파일은 대시보드 헤더에서의 **이름표**로만 남는다.
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
  return <CredentialDialogButton className={className} />;
}
