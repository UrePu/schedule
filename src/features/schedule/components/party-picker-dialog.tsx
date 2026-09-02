"use client";

import { Check, Settings2, UsersRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, Dialog, EmptyState } from "@/components/ui";
import { characterFirstName } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type { Party, PartyId, PartyMemberBrief } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 고르기 — **드롭다운에서 모달로** (발주 지시 2026-09-02)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 원문: *"파티 선택을 모달로 변경해서 캐릭터도 좀 보이게 해줘. 가시성이 너무 구린거같기도 해"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `<select>` 가 여기서 진 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 어제 선택지에 파티원을 실었더니(`세쌀카2인523 — 더저(무르겨르), 라온내일`) 이름만
 * 보이던 문제는 풀렸지만 새 문제가 생겼다. `<option>` 은 **글자 한 줄**만 담는다:
 *
 * · 파티 이름과 파티원이 같은 굵기·같은 색으로 한 줄에 이어 붙는다. 무엇이 이름이고
 *   무엇이 사람인지 **글자 모양으로는 구분되지 않는다.**
 * · 닫힌 상태에서 브라우저가 잘라 버린다. 정작 구분에 쓰이는 뒷부분(파티원)이 먼저 잘린다.
 * · 글자 크기·줄 간격을 우리가 정할 수 없다. 열 줄이 넘으면 그냥 빽빽한 문단이다.
 *
 * 모달은 그 셋을 전부 해결한다 — **두 줄**을 쓸 수 있어 이름은 굵게, 파티원은 아래
 * 작은 글씨로 갈라 놓고, 폭이 넉넉해 잘리지 않으며, 현재 선택에 체크를 붙일 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터를 **앞세워** 적는다 (2026-09-02: *"캐릭터 실제로 보여주고싶은데"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 `participantLabel` 이 만든 `더저(무르겨르)` 를 그대로 썼는데, 그 규칙은
 * **사람이 주인공**이라 본캐로 참여하면 괄호를 붙이지 않는다(`더저(더저)` 는 소음이니까).
 * 그래서 절반의 사람은 캐릭터가 화면에 아예 나오지 않았다.
 *
 * 여기서 알고 싶은 것은 "이 파티에 **어느 캐릭이** 들어가 있나"이므로 순서를 뒤집는다 —
 * `무르겨르 더저` 처럼 **캐릭터가 앞, 계정이 뒤**이고 둘이 같으면 한 번만 적는다.
 * 판정은 `lib/domain/participant-label.ts` 의 `characterFirstName` 하나가 소유한다.
 * 캐릭터를 안 고른 사람은 **본캐 닉네임이 곧 그 캐릭터**다(§2.1) — "미정" 같은
 * 꼬리표를 덧대지 않는다. 레벨·직업은 고른 사람만 붙는다.
 *
 * ⚠️ **번호(`member_no`)는 적지 않는다.** 방에서 `1번` 이라 부르는 그 번호는 빈자리를
 *    재사용하지 않으므로(§1.4) 목록 순서와 어긋날 수 있고, 여기서 순번을 새로 매기면
 *    화면이 방과 다른 번호를 말하게 된다. 고르는 데 필요한 것은 이름이지 번호가 아니다.
 */

/**
 * 구성원 하나 = **초상화 + 캐릭터명 + 레벨/직업 + 계정** 칩 하나.
 *
 * 발주 지시(2026-09-02): *"추적캐릭터에서 보여주는 그 캐릭터가 보이게"*.
 *
 * ★ **실패한 URL 자체를 담는다**(`CharacterCard` 와 같은 기법). 불리언이면 새 URL 이
 *   들어올 때 effect 로 초기화해야 하는데, 그건 이벤트가 아니라 프롭 변화를 쫓는 동기화라
 *   렌더 연쇄를 만든다. URL 을 담아 두면 비교 한 번으로 초기화가 저절로 된다.
 * ★ 그림이 없거나 깨졌으면 **아무것도 그리지 않는다.** 이름이 이미 그 캐릭터를
 *   가리키므로 빈 네모를 두면 칩마다 높이가 들쭉날쭉해질 뿐이다 — 카드가 아니라 칩이다.
 */
function MemberChip({ member }: { readonly member: PartyMemberBrief }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = characterFirstName(member);
  const showImage =
    member.characterImageUrl !== null &&
    failedUrl !== member.characterImageUrl;

  /*
    레벨·직업은 캐릭터를 고른 구성원만 갖는다. 없으면 조용히 이름만 선다 —
    모르는 값을 `Lv.?` 로 지어내지 않는다.
  */
  const spec = [
    member.characterLevel === null
      ? null
      : `Lv.${String(member.characterLevel)}`,
    member.characterClass,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return (
    <span className="inline-flex items-center gap-1 rounded bg-neutral-100 py-0.5 pl-0.5 pr-1.5 text-caption">
      {showImage && member.characterImageUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- 넥슨 CDN 이라 도메인 등록이 필요하고, 24px 고정이라 최적화 이득이 없다.
        <img
          src={member.characterImageUrl}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          className="size-6 shrink-0 rounded object-contain"
          onError={() => setFailedUrl(member.characterImageUrl)}
        />
      ) : null}
      <span className="font-medium text-ink-label">{name.lead}</span>
      {spec === "" ? null : (
        <span className="text-ink-muted tabular-nums">{spec}</span>
      )}
      {name.account === null ? null : (
        <span className="text-ink-muted">{name.account}</span>
      )}
    </span>
  );
}

export interface PartyPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelect: (partyId: PartyId) => void;
}

export function PartyPickerDialog({
  open,
  onClose,
  parties,
  selectedPartyId,
  onSelect,
}: PartyPickerDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="파티 고르기"
      description="고른 파티의 가능 시간이 겹쳐서 보이고, 일정도 그 파티에 잡힙니다."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-sm text-ink-muted tabular-nums">
            파티 {parties.length}개
          </p>
          {/*
            만들기·고치기는 여기서 하지 않는다(§1.1.1 — 이 화면은 "언제"만 묻는다).
            그래도 **어디서 하는지**는 말해 줘야 막다른 길이 되지 않는다.
          */}
          <Link href="/parties">
            <Button variant="ghost" size="sm">
              <Settings2 aria-hidden size={16} />
              파티 관리
            </Button>
          </Link>
        </div>
      }
    >
      {parties.length === 0 ? (
        <EmptyState
          icon={<UsersRound size={24} />}
          title="아직 파티가 없습니다"
          description="파티를 만들면 각자의 가능 시간이 겹쳐서 보입니다."
          className="py-8"
        />
      ) : (
        /*
          목록이 길어질 수 있으므로 **모달 안에서만** 스크롤한다. 실측 계정이 11개이고
          파티는 조합마다 하나씩 늘어난다(§1.1.1).
        */
        <ul className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
          {parties.map((party) => {
            const selected = party.partyId === selectedPartyId;
            return (
              <li key={party.partyId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(party.partyId);
                    onClose();
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary-subtle"
                      : "border-border bg-surface hover:bg-hover-surface",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body-sm font-semibold text-ink">
                      {party.name}
                    </span>
                    {/*
                      ── 파티원 = **캐릭터 칩** ─────────────────────────────
                      이름이 서로 비슷해서(`발벨3인` 이 둘) 실제로 구분에 쓰이는 것은
                      이 줄이다. 그래서 한 줄로 이어 붙이지 않고 **칩으로 끊는다** —
                      `무르겨르 더저 라온내일` 은 세 사람인지 두 사람인지 알 수 없지만
                      칩은 경계가 보인다.

                      칩 안은 `캐릭터 · 계정` 순이다(`characterFirstName`). 앞이
                      캐릭터인 이유는 보스에 실제로 들어가는 것이 캐릭터이기 때문이고,
                      본캐로 들어간 사람은 계정명이 같으므로 한 번만 적는다.
                      12px 은 §4 가 허용하는 범위다 — 문장이 아니라 **이름 나열**이고
                      판단은 위 굵은 줄이 먼저 받는다.
                    */}
                    {party.members.length > 0 ? (
                      <span className="flex flex-wrap items-center gap-1">
                        {party.members.map((member, index) => (
                          <MemberChip
                            key={`${member.displayName}-${String(index)}`}
                            member={member}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="text-caption text-ink-muted">
                        {party.memberCount}명
                      </span>
                    )}
                  </span>
                  {/*
                    선택 표시는 **체크 + 테두리 + 면색** 세 채널이다. 색 하나로만 말하면
                    색각 이상에서 어느 것이 선택된 파티인지 알 수 없다(§4).
                  */}
                  {selected ? (
                    <Check
                      aria-hidden
                      size={18}
                      className="shrink-0 text-primary"
                    />
                  ) : null}
                  <span className="sr-only">{selected ? "선택됨" : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
