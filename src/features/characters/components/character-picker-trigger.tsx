"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";
import { ApiRequestError } from "@/features/auth/data/auth-api";
import {
  authQueryKeys,
  useSessionUser,
} from "@/features/auth/data/auth-queries";
import type { MeResponse } from "@/features/auth/types";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import { queryKeys } from "@/lib/query-keys";
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

  /**
   * 추적 캐릭터 저장 — **낙관적**.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * 무엇이 예측 가능한가
   * ─────────────────────────────────────────────────────────────────────────
   * 선택 결과는 사용자가 방금 고른 그것이다 — `is_tracked` 는 `characterIds` 에
   * 들어 있는가, `is_main` 은 `mainCharacterId` 와 같은가. 서버가 새로 만들어 주는
   * 값이 없으므로(행도 id 도 이미 있다) 지어낼 것이 없다.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * 왜 창을 먼저 닫는가
   * ─────────────────────────────────────────────────────────────────────────
   * 이 조작의 결과는 창 안이 아니라 **창 뒤**에 있다(홈의 12칸 분모, 체크리스트 섹션).
   * 응답을 기다렸다 닫으면 사용자는 결과가 보이지 않는 창을 몇백 ms 붙들고 있게 된다.
   * 실패하면 창은 이미 닫혔으므로 창 안의 문구로는 알릴 수 없다 — 그래서 롤백 알림이
   * 필요했고, 이 뮤테이션이 그 알림의 첫 번째 이유다(`@/components/ui/toast`).
   *
   * ⚠️ 낙관적으로 덮는 것은 **모달 자신의 목록**뿐이다(`db.characters.list()`).
   *    홈의 분모·체크리스트·등록 폼 후보는 그 순간 화면에 없으므로 예전처럼 무효화만
   *    한다 — 보이지 않는 것은 어긋나 보일 수 없다. 세션의 `trackedCharacterCount`
   *    (버튼 옆 `추적 N명`)는 **버튼과 함께 보이므로** 함께 낙관적으로 고친다.
   */
  const save = useOptimisticMutation({
    mutationFn: (selection: TrackedCharacterSelection) =>
      saveTrackedCharacters(selection),
    optimistic: (selection) => [
      cachePatch<readonly TrackableCharacter[]>(
        characterQueryKeys.list(),
        (current) =>
          current.map((character) => ({
            ...character,
            isTracked: selection.characterIds.includes(character.id),
            isMain: selection.mainCharacterId === character.id,
          })),
      ),
      cachePatch<MeResponse>(authQueryKeys.session(), (current) =>
        current.user === null
          ? current
          : {
              ...current,
              user: {
                ...current.user,
                trackedCharacterCount: selection.characterIds.length,
              },
            },
      ),
    ],
    invalidate: () => [
      queryKeys.db.characters.forRuns(),
      queryKeys.db.bossPlans.root(),
      queryKeys.db.dashboard.root(),
    ],
    rollbackTitle: "추적 캐릭터를 저장하지 못했습니다",
    rollbackDescription: (selection) =>
      `${String(selection.characterIds.length)}명을 추적하도록 바꾸려던 것을 되돌렸습니다. 예전 목록 그대로입니다.`,
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
      /*
       * ★ 추적 명단은 이 화면 밖에서도 곳곳의 분모·목록이다:
       *   - 대시보드의 주간 보스 칸 분모는 `추적 캐릭터 수 × 12` 다 (§1.1.1).
       *   - 주간 체크리스트와 `/boss-plans` 의 캐릭터 칩이 같은 명단에서 나온다.
       *   - 일정 등록 폼의 "데려갈 캐릭터" 목록도 추적 대상만 담는다.
       *   저장 응답이 갱신해 주는 것은 **모달 자신의 목록**뿐이라, 나머지는 무효화가
       *   유일한 갱신 경로다. 예전에는 이것이 없어 캐릭터를 추가해도 홈의 분모가
       *   새로고침 전까지 옛 숫자였다 (§2.4 Rule 1).
       *
       *   ★ 그 세 건은 이제 `invalidate` 로 올라갔다 — **성공뿐 아니라 실패에도**
       *     돌아야 하기 때문이다. 롤백은 이 모달의 캐시만 되돌리므로, 실패 경로에서
       *     무효화가 빠지면 그쪽 화면이 어중간한 값을 들고 남을 여지가 생긴다.
       */
    },
    onSettled: () => {
      /*
       * 창은 성공·실패 어느 쪽이든 이미 닫혀 있다(아래 `onSave` 참고). 여기서는
       * 제어 모드 부모가 다시 열어 둔 경우를 대비해 한 번 더 닫는다 — 두 번 닫아도
       * 부작용이 없고, 열린 채 남는 쪽은 사용자가 같은 선택을 두 번 저장하게 만든다.
       */
      setOpen(false);
    },
  });

  /*
   * ★ 창 안의 실패 문구는 **창이 아직 열려 있을 때만** 의미가 있다. 낙관적 저장은
   *   누르는 즉시 닫으므로 대개 이 값은 화면에 닿지 않고, 실패는 롤백 알림이 말한다.
   *   그래도 남겨 둔다 — 부모가 제어 모드로 창을 다시 열어 둔 경우(추적 0명이면 홈이
   *   자동으로 연다)에는 여기가 유일한 자리이기 때문이다.
   */
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
        /*
          ★ **누르는 즉시 닫는다.** 이 조작의 결과는 창 뒤에 있고(홈의 12칸 분모 ·
            체크리스트), 목록 자체는 낙관적으로 이미 바뀌어 있다. 응답을 기다렸다
            닫으면 사용자는 결과가 보이지 않는 창을 몇백 ms 붙들고 있게 된다.
        */
        onSave={(next) => {
          setOpen(false);
          save.mutate(next);
        }}
        /*
          ★ `isSaving` 을 넘기지 않는다. 창이 이미 닫혀 있어 표시할 자리가 없고,
            제어 모드로 열려 있는 경우에도 값은 낙관적으로 바뀐 뒤라 잠글 이유가 없다.
        */
        saveErrorMessage={saveErrorMessage}
      />
    </>
  );
}
