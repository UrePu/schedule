"use client";

import Link from "next/link";
import { Settings2, UsersRound } from "lucide-react";
import { useId } from "react";

import { Button, ErrorState, Skeleton } from "@/components/ui";
import { participantLabel } from "@/lib/domain/participant-label";
import type { Party, PartyId, PartyMember } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 화면의 파티 줄 — **고르는 것 하나, 확인하는 것 하나**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"파티 설정은 좀 다르게 안되나? 일정짜기에 드롭다운으로
 * 선택하도록? 그 드롭다운 오른쪽에 파티원 설명해주면 되고. 저 설명은 필요없을거같은데."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 덜어냈는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 있던 `PartyBar` 는 파티 칩 줄 · 구성원 줄 · 내 참여 캐릭터 선택 · 안내 두 문단 ·
 * 해체 버튼까지 얹혀 **화면 위쪽 절반을 먹었다.** 정작 이 화면에서 파티에 대해 하는 일은
 * **"어느 파티인가"를 고르는 것 하나**뿐이다. 나머지는 전부 파티 관리(`/parties`)의 일이다.
 *
 * · 칩 → **드롭다운.** 파티가 6개만 돼도 칩 줄이 가로로 넘쳐 스크롤이 생긴다. 고르는
 *   행위는 한 번뿐이라 늘 펼쳐 둘 이유가 없다.
 * · 구성원은 **드롭다운 오른쪽에 한 줄**로. "누가 들어 있나"는 확인용이라 읽히기만 하면
 *   되고, 고치는 것은 여기서 하지 않는다.
 * · 안내 문단(`번호는 … 재사용하지 않습니다` · `부캐로 참여하면 …`)은 **뺐다.** 규칙
 *   설명은 그 규칙을 **쓰는 자리**(파티 관리)에 있어야 하고, 매일 보는 화면에서 매번
 *   같은 문장을 읽히면 그때부터 아무도 읽지 않는다.
 *
 * ⚠️ **내 참여 캐릭터 선택도 여기 없다.** `party_participants.character_id` 는 파티 설정이라
 *    `/parties` 로 갔다. 일정에 데려갈 캐릭터는 **런마다 다를 수 있는 다른 값**이고
 *    (`run_signups.character_id`), 그건 등록 모달 3단계가 묻는다. 둘을 같은 화면에 두면
 *    어느 쪽을 고치는지 알 수 없다.
 */

export interface PartySelectBarProps {
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelectParty: (partyId: PartyId) => void;
  readonly members: readonly PartyMember[];
  readonly isPartiesLoading: boolean;
  readonly isPartiesError: boolean;
  readonly onPartiesRetry: () => void;
  readonly isMembersLoading: boolean;
}

export function PartySelectBar({
  parties,
  selectedPartyId,
  onSelectParty,
  members,
  isPartiesLoading,
  isPartiesError,
  onPartiesRetry,
  isMembersLoading,
}: PartySelectBarProps) {
  const selectId = useId();

  if (isPartiesError) {
    return (
      <ErrorState
        title="파티 목록을 불러오지 못했습니다"
        description="잠시 후 다시 시도해 주세요."
        onRetry={onPartiesRetry}
      />
    );
  }

  if (isPartiesLoading) {
    return <Skeleton className="h-12 w-full" />;
  }

  /*
    파티가 없으면 **고를 것이 없다.** 빈 드롭다운을 띄우는 대신 갈 곳을 말한다 —
    이 화면에서는 파티를 만들 수 없으므로 막다른 길이 되지 않게 해야 한다.
  */
  if (parties.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
        <p className="text-body-sm text-ink">
          아직 파티가 없습니다. 파티를 만들면 각자의 가능 시간이 겹쳐서 보입니다.
        </p>
        <Link href="/parties">
          <Button size="sm">
            <UsersRound aria-hidden size={16} />
            파티 만들러 가기
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex shrink-0 items-center gap-2">
        <label
          htmlFor={selectId}
          className="text-caption font-semibold text-ink-muted"
        >
          파티
        </label>
        <select
          id={selectId}
          value={selectedPartyId ?? ""}
          onChange={(event) => onSelectParty(event.target.value)}
          className="h-9 max-w-[16rem] rounded-md border border-border bg-background px-2.5 text-body-sm font-semibold text-ink"
        >
          {parties.map((party) => (
            <option key={party.partyId} value={party.partyId}>
              {party.name}
            </option>
          ))}
        </select>
      </div>

      {/*
        구성원 — 드롭다운 **오른쪽**(발주 지시). 번호를 함께 적는다: 카톡에서 `1번` 으로
        부르는 그 번호와 같은 값이라(§1.4), 화면과 대화가 같은 것을 가리켜야 한다.
        고정 폭을 주지 않고 흐르게 둔다 — 2명이면 짧게, 6명이면 한 줄을 채운다.
      */}
      {isMembersLoading ? (
        <Skeleton className="h-6 w-40" />
      ) : members.length === 0 ? (
        <p className="text-body-sm text-ink-muted">구성원이 없습니다.</p>
      ) : (
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {members.map((member) => (
            <li key={member.personId} className="flex items-center gap-1.5">
              <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-hover-strong text-overline tabular-nums text-ink-muted">
                {member.seatNo}
              </span>
              {/*
                이름 조합 규칙의 주인은 `participantLabel` 하나다 — 겹쳐보기 좌측·런
                참가자 목록과 **같은 함수**라야 부캐로 들어간 사람이 화면마다 다른
                이름으로 보이지 않는다.
              */}
              <span className="truncate text-body-sm text-ink">
                {participantLabel(member)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        고치러 가는 문. 이 화면에서 파티를 못 고치게 한 이상, **어디서 고치는지**는
        말해 줘야 한다. `ghost` 라 눈에 띄지 않게 두되 자리는 늘 같다.
      */}
      <Link href="/parties" className="shrink-0">
        <Button variant="ghost" size="sm">
          <Settings2 aria-hidden size={16} />
          파티 관리
        </Button>
      </Link>
    </div>
  );
}
