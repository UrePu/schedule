"use client";

import Link from "next/link";
import { ChevronsUpDown, Settings2, UsersRound } from "lucide-react";
import { useState } from "react";

import { Button, ErrorState, Skeleton } from "@/components/ui";
import { characterFirstName } from "@/lib/domain/participant-label";
import type { Party, PartyId } from "@/types/domain";

import { PartyPickerDialog } from "./party-picker-dialog";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 화면의 파티 줄 — **고르는 것 하나뿐**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"파티 설정은 좀 다르게 안되나? 일정짜기에 드롭다운으로
 * 선택하도록? 저 설명은 필요없을거같은데."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 덜어냈는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 있던 `PartyBar` 는 파티 칩 줄 · 구성원 줄 · 내 참여 캐릭터 선택 · 안내 두 문단 ·
 * 해체 버튼까지 얹혀 **화면 위쪽 절반을 먹었다.** 정작 이 화면에서 파티에 대해 하는 일은
 * **"어느 파티인가"를 고르는 것 하나**뿐이다. 나머지는 전부 파티 관리(`/parties`)의 일이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 고르는 방법이 세 번 바뀌었다 — 그 순서에 이유가 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **칩 줄** → 파티가 6개만 돼도 가로로 넘쳐 스크롤이 생겼다. 고르는 행위는 한 번뿐이라
 *    늘 펼쳐 둘 이유가 없다.
 * 2. **`<select>`** (2026-08-25) → 이름만 보여 줘서 `발벨3인` 이 둘이면 구분이 안 됐다
 *    (2026-09-01: *"이름이 비슷해서 하나도 모르겠음"*). 선택지에 파티원을 실어 고쳤고,
 *    같은 값이 오른쪽 줄에도 있어 중복이던 그 줄은 걷어냈다(*"1,2 필요없잖아"*).
 * 3. **모달** (2026-09-02: *"파티 선택을 모달로 변경해서 캐릭터도 좀 보이게 해줘.
 *    가시성이 너무 구린거같기도 해"*) → `<option>` 은 글자 한 줄이라 이름과 파티원이
 *    같은 굵기로 이어 붙고, 닫히면 뒷부분(=구분에 쓰이는 파티원)부터 잘렸다.
 *    이유와 대안은 `PartyPickerDialog` 머리말에 있다.
 *
 * ★ **이 줄은 여전히 한 줄이다.** 모달로 옮긴 것은 *펼친 목록*이고, 닫혀 있을 때 자리를
 *   더 먹으면 1번의 문제로 되돌아간다. 버튼 안에서 이름(굵게) 위 / 파티원(작게) 아래로
 *   두 줄을 쓰되 둘 다 한 줄로 잘라, 줄 높이는 예전 드롭다운과 비슷하게 유지한다.
 *
 * ⚠️ **내 참여 캐릭터 선택은 여기 없다.** `party_participants.character_id` 는 파티
 *    설정이라 `/parties` 로 갔다. 일정에 데려갈 캐릭터는 **런마다 다를 수 있는 다른 값**
 *    이고(`run_signups.character_id`), 그건 등록 모달 3단계가 묻는다. 둘을 같은 화면에
 *    두면 어느 쪽을 고치는지 알 수 없다.
 */

export interface PartySelectBarProps {
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelectParty: (partyId: PartyId) => void;
  readonly isPartiesLoading: boolean;
  readonly isPartiesError: boolean;
  readonly onPartiesRetry: () => void;
}

export function PartySelectBar({
  parties,
  selectedPartyId,
  onSelectParty,
  isPartiesLoading,
  isPartiesError,
  onPartiesRetry,
}: PartySelectBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

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
    파티가 없으면 **고를 것이 없다.** 빈 모달을 띄우는 대신 갈 곳을 말한다 —
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

  const selected =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;
  /*
    닫힌 줄에는 **캐릭터만** 적는다(2026-09-02: *"캐릭터 실제로 보여주고싶은데"*).
    한 줄뿐이라 `무르겨르 더저 · 라온내일` 처럼 계정까지 붙이면 금세 잘리고, 잘리는
    쪽은 언제나 뒤 — 즉 사람 이름이 아니라 다음 사람의 캐릭터다. 계정까지 온전히 보고
    싶으면 눌러서 모달을 열면 된다. 여기 한 줄은 **어느 파티인지 알아보는 용도**다.
  */
  const memberLine =
    selected === null || selected.members.length === 0
      ? null
      : selected.members
          .map((member) => characterFirstName(member).lead)
          .join(" · ");

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5">
        <span className="shrink-0 text-caption font-semibold text-ink-muted">
          파티
        </span>

        {/*
          입력칸처럼 보이지만 **버튼**이다. `aria-haspopup="dialog"` 로 무엇이 열리는지
          미리 말해 준다 — 낭독기에서 드롭다운으로 오해하면 방향키를 누르게 된다.
        */}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setPickerOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-left transition-colors hover:bg-hover-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-[36rem]"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body-sm font-semibold text-ink">
              {selected?.name ?? "파티를 고르세요"}
            </span>
            {memberLine === null ? null : (
              <span className="truncate text-caption text-ink-muted">
                {memberLine}
              </span>
            )}
          </span>
          <ChevronsUpDown
            aria-hidden
            size={16}
            className="shrink-0 text-ink-muted"
          />
        </button>

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

      <PartyPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        parties={parties}
        selectedPartyId={selectedPartyId}
        onSelect={onSelectParty}
      />
    </>
  );
}
