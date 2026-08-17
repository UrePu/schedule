"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";
import { ApiRequestError } from "@/features/auth/data/auth-api";
import {
  authQueryKeys,
  useSessionUser,
} from "@/features/auth/data/auth-queries";
import type { MeResponse } from "@/features/auth/types";
import type { TrackedCharacterSelection } from "@/types/domain";

import {
  characterQueryKeys,
  saveTrackedCharacters,
  type TrackableCharacter,
} from "../data";
import { CharacterPickerDialog } from "./character-picker-dialog";

/**
 * 캐릭터 선택 모달의 진입점 + 저장.
 *
 * 열리는 경로가 둘이다(§2.1.1).
 * - **로그인 직후 자동으로** — 추적 대상이 0명이면 홈이 `open` 을 켠다(제어 모드).
 * - **언제든 다시** — 추적 대상은 나중에 바뀐다(새 캐릭터 육성, 부캐 정리).
 *   일회성 온보딩으로 만들면 그때마다 키를 다시 등록해야 하는 막다른 길이 된다.
 *
 * 그래서 `open` 을 주면 부모가 제어하고, 주지 않으면 이 버튼이 스스로 연다.
 */

export interface CharacterPickerTriggerProps {
  readonly label?: string;
  /** 제어 모드. 주지 않으면 버튼이 내부 상태로 연다. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * @deprecated 호환용. 목록이 자격증명 단위가 아니라 **사용자 단위**(우리 DB)가 되어
   * 더 이상 쓰지 않는다. `/schedule` 이 아직 넘기고 있어 남겨 둔다.
   */
  readonly credentialId?: string;
  /**
   * @deprecated 호환용. 초기 선택은 서버의 `is_tracked` / `is_main` 이 진실이며
   * 모달이 직접 읽는다. `/schedule` 이 아직 넘기고 있어 남겨 둔다.
   */
  readonly initialSelection?: TrackedCharacterSelection;
}

export function CharacterPickerTrigger({
  label = "추적할 캐릭터 선택",
  open: controlledOpen,
  onOpenChange,
}: CharacterPickerTriggerProps) {
  const queryClient = useQueryClient();
  const sessionUser = useSessionUser();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;

  function setOpen(next: boolean): void {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const save = useMutation({
    mutationFn: (selection: TrackedCharacterSelection) =>
      saveTrackedCharacters(selection),
    onSuccess: (data) => {
      // 서버가 갱신된 목록과 사용자를 함께 준다 → 재조회 왕복이 없다.
      queryClient.setQueryData<readonly TrackableCharacter[]>(
        characterQueryKeys.list(),
        data.characters,
      );
      // 본캐가 바뀌면 표시 정체성(`main_character_name`)도 트리거로 함께 바뀐다.
      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: data.user,
      });
      setOpen(false);
    },
  });

  const saveErrorMessage =
    save.error === null
      ? null
      : save.error instanceof ApiRequestError
        ? save.error.message
        : "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            save.reset();
            setOpen(true);
          }}
        >
          <Users aria-hidden size={16} />
          {label}
        </Button>
        {sessionUser !== null ? (
          <span className="text-caption text-ink-muted tabular-nums">
            추적 {sessionUser.trackedCharacterCount}명
          </span>
        ) : null}
      </div>

      <CharacterPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        onSave={(next) => save.mutate(next)}
        isSaving={save.isPending}
        saveErrorMessage={saveErrorMessage}
      />
    </>
  );
}
