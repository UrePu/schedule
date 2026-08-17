"use client";

import { useCallback, useId, useMemo, useState } from "react";

import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import type { PartyMember, Person, PersonId } from "@/types/domain";

import { MemberSelectGrid } from "./member-select-grid";

/**
 * 파티 만들기 / 로스터 편집 다이얼로그.
 *
 * 두 흐름을 한 컴포넌트로 둔 이유: 화면이 하는 일이 **"이름 + 구성원 정하기"** 로 같다.
 * 다른 것은 저장 시 호출하는 함수뿐이라, 폼을 두 벌로 나누면 규칙(번호 부여 안내,
 * 이름 자동 요약)이 두 곳에서 갈라진다.
 *
 * ⚠️ 번호는 **파티 단위**다. 편집 중에도 기존 구성원의 번호는 그대로 유지되고,
 *    새로 들어온 사람만 저장 시점에 `max + 1` 을 받는다 (§1.4).
 */

export type PartyEditorMode = "create" | "edit";

export interface PartyEditorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly mode: PartyEditorMode;
  /** 편집 모드일 때의 현재 파티 이름. */
  readonly initialName?: string;
  /** 편집 모드일 때의 현재 구성원(번호 포함). */
  readonly currentMembers?: readonly PartyMember[];
  readonly people: readonly Person[];
  readonly isPeopleLoading: boolean;
  readonly isPeopleError: boolean;
  readonly onPeopleRetry: () => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly memberPersonIds: readonly PersonId[];
  }) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
}

export function PartyEditorDialog({
  open,
  onClose,
  mode,
  initialName = "",
  currentMembers = [],
  people,
  isPeopleLoading,
  isPeopleError,
  onPeopleRetry,
  onSubmit,
  isSubmitting,
  submitError,
}: PartyEditorDialogProps) {
  const nameId = useId();

  const [name, setName] = useState(initialName);
  const [selectedIds, setSelectedIds] = useState<readonly PersonId[]>(() =>
    currentMembers.map((member) => member.personId),
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const seatNoByPersonId = useMemo(
    () =>
      new Map(
        currentMembers.map((member) => [member.personId, member.seatNo] as const),
      ),
    [currentMembers],
  );

  const handleToggle = useCallback((personId: PersonId) => {
    setSelectedIds((current) =>
      current.includes(personId)
        ? current.filter((id) => id !== personId)
        : [...current, personId],
    );
  }, []);

  const selectedNames = selectedIds
    .map((id) => people.find((person) => person.personId === id)?.displayName)
    .filter((value): value is string => value !== undefined);

  const autoName =
    selectedNames.length === 0
      ? "새 파티"
      : selectedNames.length === 1
        ? selectedNames[0]
        : `${selectedNames[0]} 외 ${selectedNames.length - 1}명`;

  const canSubmit = selectedIds.length > 0 && !isSubmitting;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "새 파티 만들기" : "구성원 편집"}
      description={
        mode === "create"
          ? "보스마다 같이 가는 사람이 다릅니다. 조합별로 파티를 따로 두세요."
          : "빠진 사람의 번호는 비워 둡니다. 새로 들어온 사람은 다음 번호를 받습니다."
      }
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body-sm text-ink">
            <strong className="font-semibold tabular-nums">
              {selectedIds.length}
            </strong>
            명 선택
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              취소
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={() =>
                onSubmit({ name, memberPersonIds: selectedIds })
              }
            >
              {isSubmitting
                ? "저장 중…"
                : mode === "create"
                  ? "파티 만들기"
                  : "저장"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>파티 이름</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={autoName}
            autoComplete="off"
          />
          <HelperText>
            비워 두면 <strong className="font-semibold">{autoName}</strong> 로
            저장됩니다.
          </HelperText>
        </div>

        {isPeopleError ? (
          <ErrorState
            title="사람 목록을 불러오지 못했습니다"
            onRetry={onPeopleRetry}
            className="py-6"
          />
        ) : isPeopleLoading ? (
          <SkeletonGroup label="사람 목록을 불러오는 중">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <Skeleton key={index} className="h-20" />
              ))}
            </div>
          </SkeletonGroup>
        ) : people.length === 0 ? (
          <EmptyState
            title="함께할 사람이 없습니다"
            description="초대 링크를 보내거나 친구를 추가하면 여기에 나타납니다."
          />
        ) : (
          <MemberSelectGrid
            people={people}
            selectedIds={selectedSet}
            onToggle={handleToggle}
            seatNoByPersonId={seatNoByPersonId}
          />
        )}

        {selectedIds.length === 0 ? (
          <HelperText tone="error">
            최소 한 명은 있어야 파티가 됩니다.
          </HelperText>
        ) : null}

        {submitError ? (
          <ErrorState
            title="저장하지 못했습니다"
            detail={submitError.message}
            className="py-6"
          />
        ) : null}
      </div>
    </Dialog>
  );
}
