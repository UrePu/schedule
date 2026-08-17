"use client";

import { Plus, UsersRound } from "lucide-react";

import { SeatNumber } from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  FilterChip,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import type { Party, PartyId, PartyMember } from "@/types/domain";

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
}: PartyBarProps) {
  const selectedParty =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;

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
                  {members.map((member) => (
                    <li
                      key={member.personId}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-3 pl-1"
                    >
                      <SeatNumber seatNo={member.seatNo} size="md" />
                      <span
                        className="max-w-32 truncate text-body-sm text-ink"
                        title={member.displayName}
                      >
                        {member.displayName}
                      </span>
                      {member.isGuest ? (
                        <span className="text-caption text-ink-muted">
                          게스트
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
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
