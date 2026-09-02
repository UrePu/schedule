"use client";

import { Check, Settings2, UserRound, UsersRound } from "lucide-react";
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
 * 캐릭터를 안 고른 사람은 **본캐가 그 캐릭터**다(§2.1) — "미정" 같은 꼬리표를 덧대지
 * 않고, 본캐 행에서 사진·레벨까지 끌어온다(`schedule-repo.loadMainCharacters`).
 *
 * ⚠️ **번호(`member_no`)는 적지 않는다.** 방에서 `1번` 이라 부르는 그 번호는 빈자리를
 *    재사용하지 않으므로(§1.4) 목록 순서와 어긋날 수 있고, 여기서 순번을 새로 매기면
 *    화면이 방과 다른 번호를 말하게 된다. 고르는 데 필요한 것은 이름이지 번호가 아니다.
 */

/**
 * 구성원 하나 = **네모 초상화 한 칸** + 그 아래 이름.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 칩에서 **타일로** (발주 지시 2026-09-02: *"너무 작잖아... 직업 없애고 그냥 네모네모
 * 하게 해 진짜 너무 작아"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 한 줄짜리 칩 안에 24px 그림을 끼워 넣었다. 얼굴을 보여 주려고 넣은 그림이
 * 24px 이면 **무엇을 넣었는지 알아볼 수가 없다** — 그 크기에서 캐릭터는 색깔 점이다.
 * 게다가 직업까지 같은 줄에 서면서 한 사람이 `[▪ 쌍욱 Lv.285 칼리 죠린]` 이 됐고,
 * 실제로 읽히는 것은 그중 아무것도 아니었다.
 *
 * ★ 그림을 **64px 정사각**으로 키우고 이름을 아래로 내린다. 가로로 나열하던 것을
 *   칸으로 만들면 사람 수만큼 폭을 먹는 대신 얼굴이 실제로 보인다.
 * ★ **직업을 뺐다.** 파티를 고를 때 필요한 것은 "누가 있나"이고, 직업은 그 판단에
 *   쓰이지 않으면서 줄에서 가장 긴 글자였다. 레벨은 두 글자라 남긴다.
 * ★ **그림이 없어도 네모는 그린다.** 칩일 때는 빈 네모가 높이를 흔들어 뺐지만, 타일은
 *   칸이 이미 정사각이라 비어 있어도 줄이 흔들리지 않는다 — 오히려 빈 칸이 "이 사람은
 *   아직 사진이 없다"를 말해 준다(게스트가 그렇다).
 * ★ **실패한 URL 자체를 담는다**(`CharacterCard` 와 같은 기법). 불리언이면 새 URL 이
 *   들어올 때 effect 로 초기화해야 하는데, 그건 이벤트가 아니라 프롭 변화를 쫓는 동기화라
 *   렌더 연쇄를 만든다. URL 을 담아 두면 비교 한 번으로 초기화가 저절로 된다.
 */
function MemberTile({ member }: { readonly member: PartyMemberBrief }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = characterFirstName(member);
  const showImage =
    member.characterImageUrl !== null &&
    failedUrl !== member.characterImageUrl;

  return (
    <span
      /*
        `title` 에 계정까지 넣는다. 타일 아래에는 캐릭터 이름만 서므로, 부캐로 들어간
        사람이 누구인지는 여기서 확인한다 — 두 줄을 쓰면 타일 높이가 사람마다 달라진다.
      */
      title={
        name.account === null ? name.lead : `${name.lead} · ${name.account}`
      }
      className="flex w-16 shrink-0 flex-col items-center gap-1"
    >
      <span className="flex size-16 items-center justify-center overflow-hidden rounded-md border border-border bg-neutral-100">
        {showImage && member.characterImageUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- 넥슨 CDN 이라 도메인 등록이 필요하고, 64px 고정이라 최적화 이득이 없다.
          <img
            src={member.characterImageUrl}
            alt=""
            width={64}
            height={64}
            loading="lazy"
            /*
              ★ **칸 안에서 1.7배로 키운다**(발주 지시 2026-09-02: *"네모 박스는
                좋은데 안에 캐릭터 크기 지금보다 1.7배는 키워야함"*).
                넥슨 초상화는 캔버스 가장자리에 **투명 여백이 넓게** 들어 있어서,
                `object-contain` 으로 캔버스 전체를 맞추면 정작 캐릭터는 칸의 절반도
                차지하지 못한다. 박스를 키우는 대신 **그림을 키워 여백을 잘라낸다** —
                박스 크기는 그대로라 타일 격자가 흔들리지 않는다(부모가 `overflow-hidden`).
            */
            className="size-full scale-[1.7] object-contain"
            onError={() => setFailedUrl(member.characterImageUrl)}
          />
        ) : (
          <UserRound aria-hidden size={22} className="text-ink-placeholder" />
        )}
      </span>
      <span className="w-full truncate text-center text-caption font-medium text-ink-label">
        {name.lead}
      </span>
      {member.characterLevel === null ? null : (
        <span className="text-overline tabular-nums text-ink-muted">
          Lv.{member.characterLevel}
        </span>
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
          ── **두 열** (발주 지시 2026-09-02: *"카드 반으로 잘라서 2열배치"*) ────
          모달 폭이 1,024px 까지 쓰므로 한 열로 세우면 카드 하나가 가로로 늘어지고
          세로로만 길어졌다 — 파티가 열 개가 넘으면 전부 보려고 스크롤해야 한다.
          반으로 잘라 두 열로 놓으면 같은 높이에 **두 배가 보인다.**
          좁은 화면(<640px)에서는 한 열이다 — 거기서 두 열은 카드당 150px 이라
          얼굴 타일 두 개도 안 들어간다.
          ★ `items-stretch` + 버튼 `h-full` — 옆 카드와 파티원 수가 달라도 높이가 맞는다.
        */
        <ul className="grid max-h-[60vh] grid-cols-1 items-stretch gap-2 overflow-y-auto sm:grid-cols-2">
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
                    "flex h-full w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
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
                      ── 파티원 = **얼굴 타일 줄** ──────────────────────────
                      이름이 서로 비슷해서(`발벨3인` 이 둘) 실제로 구분에 쓰이는 것은
                      이 줄이다. 그래서 글자로 이어 붙이는 대신 **얼굴을 띄운다** —
                      사람은 이름보다 그림을 훨씬 빨리 알아본다.
                      크기와 근거는 `MemberTile` 머리말에 있다.
                    */}
                    {party.members.length > 0 ? (
                      <span className="flex flex-wrap items-start gap-2 pt-1">
                        {party.members.map((member, index) => (
                          <MemberTile
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
