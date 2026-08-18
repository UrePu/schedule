"use client";

import { Plus, Send, UsersRound } from "lucide-react";
import { useId } from "react";

import { SeatNumber } from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  FilterChip,
  HelperText,
  Label,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { participantAltCharacterName } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type {
  Party,
  PartyId,
  PartyMember,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

/**
 * 파티 전환 + 선택한 파티의 로스터 (§1.4 상단).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 파티가 여러 개인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스마다 같이 가는 사람이 다르다. 하나의 고정 파티를 가정하면 실제 사용이 안 된다.
 * 그래서 파티를 고르면 **왼쪽 겹쳐보기와 오른쪽 일정 목록이 전부 그 파티 것**으로 바뀐다.
 *
 * ⚠️ **번호는 파티 단위다.** 같은 사람이 A파티에서 3번, B파티에서 2번일 수 있다.
 *   그래서 로스터 아래에 "이 번호는 이 파티 안에서만 유효하다"를 명시한다 —
 *   카톡에서 "3번한테 33" 이 어느 파티 3번인지 헷갈리면 그대로 사고다.
 *
 * 전환 UI 는 `FilterChip` 을 쓴다. 새 프리미티브를 만들지 않았고, 좁은 화면에서는
 * 가로 스크롤로 흘러 모바일에서도 전환된다.
 */

export interface PartyBarProps {
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelectParty: (partyId: PartyId) => void;
  readonly onCreateParty: () => void;
  readonly onEditRoster: () => void;
  readonly members: readonly PartyMember[];
  readonly isPartiesLoading: boolean;
  readonly isPartiesError: boolean;
  readonly onPartiesRetry: () => void;
  readonly isMembersLoading: boolean;
  readonly isMembersError: boolean;
  readonly onMembersRetry: () => void;
  /**
   * 열람자 본인. 비로그인은 `null` 이고, 그때는 참여 캐릭터 선택도 초대 버튼도 없다 —
   * 둘 다 쓰기라 서버가 401 로 거른다.
   */
  readonly viewerPersonId: PersonId | null;
  /** 내가 이 파티에 데려갈 수 있는 캐릭터(추적 대상만). */
  readonly characters: readonly RunCharacterOption[];
  readonly onChangeMyCharacter: (characterId: string | null) => void;
  readonly isSavingMyCharacter: boolean;
  readonly myCharacterError: Error | null;
  /** 게스트에게 초대 링크를 보낸다. 게스트가 아닌 구성원에게는 버튼이 없다. */
  readonly onInviteGuest: (member: PartyMember) => void;
}

export function PartyBar({
  parties,
  selectedPartyId,
  onSelectParty,
  onCreateParty,
  onEditRoster,
  members,
  isPartiesLoading,
  isPartiesError,
  onPartiesRetry,
  isMembersLoading,
  isMembersError,
  onMembersRetry,
  viewerPersonId,
  characters,
  onChangeMyCharacter,
  isSavingMyCharacter,
  myCharacterError,
  onInviteGuest,
}: PartyBarProps) {
  const characterSelectId = useId();
  const selectedParty =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;

  /** 이 파티에서의 내 자리. 없으면(공개 파티를 구경 중) 캐릭터 선택도 없다. */
  const myMembership =
    viewerPersonId === null
      ? null
      : (members.find((member) => member.personId === viewerPersonId) ?? null);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UsersRound aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">파티</CardTitle>
          <span className="text-body-sm text-ink-muted tabular-nums">
            {parties.length}개
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={onCreateParty}>
          <Plus aria-hidden size={16} />새 파티
        </Button>
      </div>

      {isPartiesError ? (
        <ErrorState
          title="파티 목록을 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={onPartiesRetry}
        />
      ) : isPartiesLoading ? (
        <SkeletonGroup label="파티 목록을 불러오는 중">
          <div className="flex gap-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-chip w-32" />
            ))}
          </div>
        </SkeletonGroup>
      ) : parties.length === 0 ? (
        <EmptyState
          title="아직 파티가 없습니다"
          description="같이 보스 갈 사람들로 파티를 만들면 각자의 가능 시간이 겹쳐서 표시됩니다."
          action={
            <Button size="sm" onClick={onCreateParty}>
              <Plus aria-hidden size={16} />첫 파티 만들기
            </Button>
          }
        />
      ) : (
        <>
          {/* 좁은 화면에서는 가로로 흘려 스크롤한다. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div
              role="group"
              aria-label="파티 선택"
              className="flex w-max gap-2"
            >
              {parties.map((party) => (
                <FilterChip
                  key={party.partyId}
                  selected={party.partyId === selectedPartyId}
                  onClick={() => onSelectParty(party.partyId)}
                  title={`${party.name} · ${party.memberCount}명`}
                >
                  <span className="max-w-40 truncate">{party.name}</span>
                  <span className="tabular-nums opacity-80">
                    {party.memberCount}
                  </span>
                </FilterChip>
              ))}
            </div>
          </div>

          {/* 선택한 파티의 로스터 */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-body-sm font-semibold text-ink">
                {selectedParty?.name ?? "파티를 선택하세요"}
                <span className="ml-2 text-body-sm font-normal text-ink-muted tabular-nums">
                  {members.length}명
                </span>
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={onEditRoster}
                disabled={selectedParty === null}
              >
                구성원 편집
              </Button>
            </div>

            {isMembersError ? (
              <ErrorState
                title="구성원을 불러오지 못했습니다"
                onRetry={onMembersRetry}
                className="py-6"
              />
            ) : isMembersLoading ? (
              <SkeletonGroup label="구성원을 불러오는 중">
                <div className="flex flex-wrap gap-2">
                  {[0, 1, 2, 3].map((index) => (
                    <Skeleton key={index} className="h-8 w-24" />
                  ))}
                </div>
              </SkeletonGroup>
            ) : members.length === 0 ? (
              <EmptyState
                title="구성원이 없습니다"
                description="구성원 편집에서 같이 갈 사람을 추가하세요."
                className="py-6"
              />
            ) : (
              <>
                <ul className="flex flex-wrap gap-2">
                  {members.map((member) => {
                    /*
                      `더저(메검메)` 조합은 `lib/domain/participant-label.ts` 가 소유한다.
                      본캐와 부캐를 다른 무게로 그리려고 문자열 대신 부캐 이름만 받는다 —
                      한 문자열로 붙여 자르면 긴 닉네임에서 괄호 안이 통째로 사라진다.
                    */
                    const altCharacterName =
                      participantAltCharacterName(member);
                    const canInvite = member.isGuest && viewerPersonId !== null;
                    return (
                      <li
                        key={member.personId}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-1",
                          canInvite ? "pr-1" : "pr-3",
                        )}
                      >
                        <SeatNumber seatNo={member.seatNo} size="md" />
                        <span
                          className="max-w-32 truncate text-body-sm text-ink"
                          title={member.displayName}
                        >
                          {member.displayName}
                        </span>
                        {altCharacterName === null ? null : (
                          <span
                            className="max-w-28 truncate text-body-sm text-ink-muted"
                            title={`부캐 ${altCharacterName}`}
                          >
                            ({altCharacterName})
                          </span>
                        )}
                        {member.isGuest ? (
                          <span className="text-caption text-ink-muted">
                            게스트
                          </span>
                        ) : null}
                        {/*
                          게스트에게만 초대 버튼이 붙는다. 이 링크 한 장으로 그 사람이
                          끼어 있는 파티가 **전부** 상대 계정에 붙는다(발주 요구).
                          비로그인은 서버가 401 이라 아예 그리지 않는다.
                        */}
                        {canInvite ? (
                          <button
                            type="button"
                            onClick={() => onInviteGuest(member)}
                            aria-label={`${member.displayName} 초대 링크 보내기`}
                            title={`${member.displayName} 초대 링크 보내기`}
                            className={cn(
                              "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                              "text-ink-muted transition duration-200",
                              "hover:bg-primary-subtle hover:text-primary",
                              "focus-visible:ring-[3px] focus-visible:ring-focus-ring focus-visible:outline-none",
                            )}
                          >
                            <Send aria-hidden size={14} />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>

                {/*
                  ── 내가 이 파티에 데려가는 캐릭터 ─────────────────────────────
                  파티 단위 값(`party_participants.character_id`)이라 여기가 자리다.
                  런 단위로 다른 캐릭터를 데려가는 것은 일정 목록의 참가 신청이 따로 한다.
                  고칠 수 있는 것은 **내 행 하나**뿐이다.
                */}
                {myMembership === null || characters.length === 0 ? null : (
                  <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                    <Label htmlFor={characterSelectId}>내 참여 캐릭터</Label>
                    <select
                      id={characterSelectId}
                      value={myMembership.characterId ?? ""}
                      disabled={isSavingMyCharacter}
                      onChange={(event) =>
                        onChangeMyCharacter(
                          event.target.value === "" ? null : event.target.value,
                        )
                      }
                      className={cn(
                        "h-control-md w-full max-w-80 min-w-0 rounded-md border border-border bg-surface px-3",
                        "text-body-sm text-ink transition duration-200 outline-none",
                        "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                        "disabled:cursor-not-allowed disabled:bg-background",
                      )}
                    >
                      <option value="">지정 안 함 (본캐 이름으로 표시)</option>
                      {characters.map((entry) => (
                        <option key={entry.characterId} value={entry.characterId}>
                          {entry.name}
                          {entry.isMain ? " (본캐)" : ""}
                          {entry.worldName === null ? "" : ` · ${entry.worldName}`}
                        </option>
                      ))}
                    </select>
                    {myCharacterError === null ? (
                      <HelperText>
                        부캐로 참여하면 파티 목록에{" "}
                        <strong className="font-semibold">본캐(부캐)</strong> 로
                        표시됩니다.
                      </HelperText>
                    ) : (
                      <HelperText tone="error">
                        {myCharacterError.message}
                      </HelperText>
                    )}
                  </div>
                )}

                <p className="text-body-sm text-ink-muted">
                  번호는 <strong>{selectedParty?.name}</strong> 안에서만
                  유효합니다. 같은 사람이라도 파티가 다르면 번호가 다릅니다.
                  빠진 번호는 재사용하지 않습니다.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
