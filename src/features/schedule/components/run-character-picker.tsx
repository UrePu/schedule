"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, UserRound } from "lucide-react";
import { useState } from "react";

import {
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import { fetchRunParticipantCharacters } from "../data";
import type { RunCharacterCandidate } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 일정에 **데려갈 캐릭터** 고르기 — 일정 상세 창 위에 겹쳐 뜨는 창
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-10-26 · 2026-11-02): *"여기서도 캐릭터 둘다 바꿀수있으면 좋겟는데"*. 상세 창의
 * `내 캐릭터` 줄과 명단의 각 줄이 같은 창을 연다. 내 줄과 파티원 줄의 차이는 후보를 읽는
 * 대상뿐이라 창을 나누지 않았다.
 *
 * ★ **겹쳐 뜨는 창**이다. 상세 창 안에 펼치면 그 아래 `조치` 버튼들이 밀려 내려간다 —
 *   발주자는 버튼 자리가 움직이는 것을 싫어한다. 부모(`RunDetailDialog`)는 이 창을 자기
 *   `Dialog` 의 **형제**로 렌더한다. 자식으로 두면 네이티브 `<dialog>` 의 `close` /
 *   `cancel` 이 React 트리를 타고 부모의 `onClose` 까지 올라가 상세 창도 함께 닫힌다.
 *
 * ★ 후보는 **그 사람의 추적 캐릭터**이고 서버가 정한다(`fetchRunParticipantCharacters`).
 *   이 보스를 이번 주기에 이미 깬 후보에는 한 줄을 붙인다. **내 줄은 표시만** 하고, **남의 줄은
 *   고를 수 없다** — 남의 돈이 움직인다(`RunCharacterCandidate.clearNote` 머리말). 서버도 같은 값으로
 *   409 를 주므로, 비활성은 편의가 아니라 그 거절을 미리 말하는 것이다.
 *
 * ★ "지금 선택됨" 은 **참가 행에 실제로 적힌 값**으로만 그린다(`currentCharacterId`). 파티 기본값으로
 *   떨어져 보이는 캐릭터는 아직 저장된 것이 아니므로 눌러서 저장할 수 있어야 하고, 보스마다
 *   캐릭터가 다른 묶음은 하나를 고르면 전부 맞춰진다.
 *
 * ⚠️ 바꾸는 범위는 **이 일정의 그 사람 참가 행**뿐이다. 파티 관리의 내 캐릭터와 묶음 지정은
 *    그대로라 다음에 잡는 일정은 원래 캐릭터로 간다 — 창이 그렇게 말한다.
 */

/** 누구의 줄을 고르는가. `null` 이면 닫혀 있다. */
export interface RunCharacterPickerTarget {
  /** 그 사람이 불참하지 않은 이 묶음의 런 전부. 권한 확인과 "이미 깼다" 판정의 범위다. */
  readonly runIds: readonly string[];
  readonly participantId: string;
  readonly displayName: string;
  readonly isMe: boolean;
  /**
   * 참가 행에 **실제로 적혀 있고** 묶음 전체가 같은 캐릭터. 그 외에는 `null` 이고 어느 줄도
   * 선택돼 보이지 않는다.
   */
  readonly currentCharacterId: string | null;
  /** 보스마다 참가 행의 캐릭터가 다르다. 고르면 전부 그 캐릭터로 맞춰진다고 말한다. */
  readonly hasMixedCharacters: boolean;
  /** 바꾸면 **일정 날짜보다 먼저 관측된 클리어**의 연결이 끊긴다. 고르기 전에 말한다. */
  readonly willReleaseClear: boolean;
}

export interface RunCharacterPickerProps {
  readonly target: RunCharacterPickerTarget | null;
  readonly onClose: () => void;
  readonly onPick: (candidate: RunCharacterCandidate) => void;
}

export function RunCharacterPicker({
  target,
  onClose,
  onPick,
}: RunCharacterPickerProps) {
  const candidatesQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.runs.participantCharacters(
        target?.runIds ?? [],
        target?.participantId ?? "none",
      ),
    ),
    queryFn: () =>
      fetchRunParticipantCharacters(
        target?.runIds ?? [],
        target?.participantId ?? "",
      ),
    enabled: target !== null,
  });

  if (target === null) return null;

  const runCount = target.runIds.length;
  const scope = target.hasMixedCharacters
    ? `지금 보스마다 캐릭터가 다릅니다. 고르면 이 일정의 보스 ${String(runCount)}개가 모두 그 캐릭터로 맞춰집니다.`
    : runCount > 1
      ? `이 일정의 보스 ${String(runCount)}개에 모두 적용됩니다.`
      : "이 일정에만 적용됩니다.";

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        target.isMe ? "데려갈 캐릭터" : `${target.displayName}님이 데려갈 캐릭터`
      }
      description={`${scope} ${target.isMe ? "파티 관리의 내 캐릭터는" : "그분이 파티 관리에 정해 둔 캐릭터는"} 그대로입니다.`}
      className="sm:max-w-md"
    >
      <div className="flex flex-col gap-3">
        {/*
          ★ 주황 면 + **문장은 ink**(§4 — 주황 본문은 AA 미달). 돈이 움직일 수 있는 일이라 고르기
            **전에** 말한다. 인원 문장은 `clearReleasePatch` 가 실제로 하는 일과 같아야 한다.
        */}
        {target.willReleaseClear ? (
          <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
            이 일정 날짜보다 먼저 기록된 클리어가 붙어 있습니다. 캐릭터를 바꾸면 그 클리어는 이
            일정에서 떨어져 원래 캐릭터의 기록으로 남습니다. 직접 고친 인원이 아니면 계획에 적은
            인원으로 돌아가고(계획이 없으면 1인), 금액도 그 인원으로 다시 계산됩니다.
          </p>
        ) : null}

        {candidatesQuery.isPending ? (
          <SkeletonGroup label="캐릭터 목록을 불러오는 중">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </SkeletonGroup>
        ) : candidatesQuery.isError ? (
          <ErrorState
            title="캐릭터 목록을 불러오지 못했습니다"
            detail={candidatesQuery.error.message}
            onRetry={() => void candidatesQuery.refetch()}
          />
        ) : candidatesQuery.data.length === 0 ? (
          <EmptyState
            title="고를 수 있는 캐릭터가 없습니다"
            description={
              target.isMe
                ? "기타 › 추적 캐릭터에서 데려갈 캐릭터를 먼저 추적해 주세요."
                : `${target.displayName}님이 추적 중인 캐릭터가 없습니다. 추적은 본인만 정할 수 있습니다.`
            }
          />
        ) : (
          <>
            <ul className="flex flex-col gap-1" aria-label="고를 수 있는 캐릭터">
              {candidatesQuery.data.map((candidate) => (
                <CandidateRow
                  key={candidate.characterId}
                  candidate={candidate}
                  selected={candidate.characterId === target.currentCharacterId}
                  lockedBecauseCleared={
                    !target.isMe &&
                    candidate.clearNote !== null &&
                    candidate.characterId !== target.currentCharacterId
                  }
                  onSelect={() => {
                    if (candidate.characterId === target.currentCharacterId) {
                      onClose();
                      return;
                    }
                    onPick(candidate);
                  }}
                />
              ))}
            </ul>
            <HelperText>12칸과 수익은 고른 캐릭터로 셉니다.</HelperText>
          </>
        )}
      </div>
    </Dialog>
  );
}

function CandidateRow({
  candidate,
  selected,
  lockedBecauseCleared,
  onSelect,
}: {
  readonly candidate: RunCharacterCandidate;
  readonly selected: boolean;
  /** 남의 줄이고 이 캐릭터가 이미 깼다. 눌리지 않고 이유를 함께 적는다. */
  readonly lockedBecauseCleared: boolean;
  readonly onSelect: () => void;
}) {
  const meta = [
    candidate.className,
    candidate.level === null ? null : `Lv.${String(candidate.level)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        disabled={lockedBecauseCleared}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left",
          "transition duration-150 outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-focus-ring",
          selected
            ? "border-primary bg-primary-subtle hover:bg-primary-subtle-hover"
            : lockedBecauseCleared
              ? "cursor-not-allowed border-border bg-background"
              : "border-border bg-surface hover:bg-hover-surface",
        )}
      >
        <Portrait imageUrl={candidate.imageUrl} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-body-sm font-semibold",
              selected
                ? "text-primary"
                : lockedBecauseCleared
                  ? "text-ink-muted"
                  : "text-ink",
            )}
          >
            {candidate.name}
          </span>
          {meta === "" ? null : (
            <span className="truncate text-caption tabular-nums text-ink-muted">
              {meta}
            </span>
          )}
          {/* 라벨 한 토막이라 caption 이다(§4). 경고가 아니라 사실이므로 색을 주지 않는다. */}
          {candidate.clearNote === null ? null : (
            <span className="text-caption font-semibold text-ink">
              {candidate.clearNote}
              {lockedBecauseCleared ? " · 본인만 고를 수 있습니다" : ""}
            </span>
          )}
        </span>
        {selected ? (
          <Check aria-hidden size={16} className="shrink-0 text-primary" />
        ) : null}
      </button>
    </li>
  );
}

/**
 * 초상화 한 칸.
 *
 * ★ `MemberFace` 와 **같은 구도**(`scale-[5]` — 근거는 `party-option.tsx` 머리말)다. 그쪽은 파티원
 *   brief 를 받아 이름 표기까지 만드는 컴포넌트라 후보 한 줄에 쓰려면 없는 칸을 지어내야 한다.
 * ★ 없거나 깨지면 실루엣이다. 오류가 아니라 정상 상태다(§2.1.1). 실패한 URL 자체를 담는 이유도
 *   `MemberFace` 와 같다.
 */
function Portrait({ imageUrl }: { readonly imageUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage =
    imageUrl !== null && imageUrl !== "" && failedUrl !== imageUrl;

  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-neutral-100">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          className="size-full scale-[5] object-contain"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <UserRound
          aria-hidden
          strokeWidth={1.5}
          className="size-1/2 text-ink-muted"
        />
      )}
    </span>
  );
}
