"use client";

import Link from "next/link";

import {
  Bomb,
  ChevronsUpDown,
  Copy,
  Plus,
  Send,
  Settings2,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  BossFaceRow,
  MemberFaceRow,
  MyCharacterMark,
  SeatNumber,
  myPartyLens,
  resolveMyPartyOption,
  type PartyOptionData,
} from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
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

import { PartyPickerDialog } from "./party-picker-dialog";
import { withJosa } from "@/lib/text/josa";

/**
 * 파티 전환 + 선택한 파티의 로스터 (§1.4 상단).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 파티가 여러 개인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스마다 같이 가는 사람이 다르다. 하나의 고정 파티를 가정하면 실제 사용이 안 된다.
 * 그래서 파티를 고르면 **구성원과 보스 목록이 전부 그 파티 것**으로 바뀐다.
 *
 * ⚠️ **번호는 파티 단위다.** 같은 사람이 A파티에서 3번, B파티에서 2번일 수 있다.
 *   그래서 로스터 아래에 "이 번호는 이 파티 안에서만 유효하다"를 명시한다 —
 *   카톡에서 "3번한테 33" 이 어느 파티 3번인지 헷갈리면 그대로 사고다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 전환 UI 는 **버튼 하나 + 모달**이다 (발주 2026-10-19)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"이거 파티 대가리 너무 작으니까 다른 파티에서 고르는것처럼 추가 모달
 * 여는걸로 바꿔"*
 *
 * 2026-10-19 까지 이 자리는 **가로 스크롤 칩 띠**(`PartyOption` 의 `chip` 밀도)였다.
 * 얼굴이 **20px**(`FACE_BOX.chip` = `size-5`)에 넷까지(`MAX_FACES_CHIP`)라, 실측된 파티
 * 이름이 `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 **캐릭터 이름으로만** 갈리는 이
 * 도메인에서 "누가 있는 파티인가" 를 알아볼 수 없었다. 활성 파티가 **33개**(실측)라
 * 띠는 언제나 잘린 채 가로로 흘렀고, 그 가로 스크롤 자체가 불만의 본체였다.
 *
 * 지금은:
 *   · 이 카드 안에는 **고른 파티 하나**가 얼굴 **40px**(`card` 밀도)로 보인다.
 *   · 바꾸는 일은 `PartyPickerDialog` 가 받는다 — **일정 잡기 창과 같은
 *     `PartyOptionGrid`** 이고, 33개를 이름·파티원·캐릭터로 찾는 검색이 함께 있다.
 *   · 가로 스크롤은 **없다.** 띠가 없어졌으므로 생길 자리가 없다.
 *
 * ★ 여는 버튼은 **얼굴 줄을 공용 컴포넌트에서 가져다 쓴다**(`BossFaceRow` ·
 *   `MemberFaceRow` · `MyCharacterMark`). `PartyOption` 을 그대로 쓰지 않은 이유는
 *   그것이 `<button aria-pressed>` 라서다 — 이 버튼이 하는 일은 "이 파티를 고른다" 가
 *   아니라 **"고르는 창을 연다"**(`aria-haspopup="dialog"`)이고, 버튼 안에 버튼을 넣을
 *   수도 없다. 얼굴 크롭 배율·실루엣·`+N` 접기 같은 **어려운 부분은 전부 공용**이다.
 */

export interface PartyBarProps {
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelectParty: (partyId: PartyId) => void;
  /**
   * 파티 만들기 / 편집. **`null` 이면 그 버튼을 그리지 않는다.**
   *
   * 일정 관리 화면(2026-08-25 분리)에서는 파티를 **고르기만** 한다 — 만들기·편집은
   * 파티 관리 화면의 일이다. 비활성이 아니라 아예 감추는 이유는, 여기서는 그 동작이
   * "지금 할 수 없는 것"이 아니라 **이 화면의 일이 아니기** 때문이다. 비활성 버튼은
   * "조건을 채우면 된다"고 말하는데 그건 거짓이 된다.
   */
  readonly onCreateParty: (() => void) | null;
  readonly onEditRoster: (() => void) | null;
  /**
   * **파티 복사** (발주 2026-10-16). `null` 이면 버튼을 그리지 않는다 —
   * `onCreateParty` 와 같은 규칙이고, 복사는 만들기의 변형이므로 같은 조건에서 보인다.
   *
   * ⚠️ **임시방편이다.** 자세한 근거는 `schedule-repo.copyParty` 머리말에 있다 —
   *    이 버튼은 파티 개수를 **더 빨리 늘린다.**
   */
  readonly onCopyParty: (() => void) | null;
  readonly isCopying: boolean;
  readonly copyErrorMessage: string | null;
  /**
   * 파티 해체(터트리기). **만든 사람에게만** 버튼이 보인다(`Party.isOwner`).
   *
   * 확인 절차는 이 컴포넌트가 갖는다 — 되돌릴 수 없는 동작이라 한 번 더 묻는 것이
   * 화면의 책임이고, 부모는 "눌렀다"만 받으면 된다.
   */
  readonly onDisbandParty: () => void;
  readonly isDisbanding: boolean;
  readonly disbandErrorMessage: string | null;
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
  /*
   * ★ `isSavingMyCharacter` / `myCharacterError` 가 사라졌다 (낙관적 업데이트,
   *   2026-08-18). 선택은 즉시 반영되므로 잠글 이유가 없고, 실패는 값이 되돌아가면서
   *   롤백 알림이 말한다(`@/lib/query/optimistic`). 여기 문구를 남겨 두면 같은 사건을
   *   두 번, 그것도 값이 이미 되돌아간 뒤에 말하게 된다.
   */
  /** 게스트에게 초대 링크를 보낸다. 게스트가 아닌 구성원에게는 버튼이 없다. */
  readonly onInviteGuest: (member: PartyMember) => void;
}

export function PartyBar({
  parties,
  selectedPartyId,
  onSelectParty,
  onCreateParty,
  onEditRoster,
  onCopyParty,
  isCopying,
  copyErrorMessage,
  onDisbandParty,
  isDisbanding,
  disbandErrorMessage,
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
  onInviteGuest,
}: PartyBarProps) {
  const characterSelectId = useId();
  const selectedParty =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;

  /**
   * 해체 확인을 펼쳐 둔 파티. **파티 id 로 기억한다** — 확인 중에 다른 파티로 옮기면
   * 열려 있던 확인이 그 파티의 것처럼 보이게 되고, 그 상태에서 누르면 엉뚱한 파티가 터진다.
   */
  const [confirmingDisbandId, setConfirmingDisbandId] =
    useState<PartyId | null>(null);

  /**
   * 파티 고르는 창이 열려 있는가 (발주 2026-10-19).
   *
   * **순수 화면 상태라 여기 산다.** 부모로 올리면 `/parties` 가 자기 화면의 어느 창이
   * 떠 있는지를 하나 더 알아야 하는데, 이 창은 고른 결과(`onSelectParty`) 말고는 부모에
   * 전할 것이 없다 — 해체 확인(`confirmingDisbandId`)이 여기 사는 것과 같은 선이다.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  const isConfirmingDisband =
    selectedParty !== null && confirmingDisbandId === selectedParty.partyId;

  /** 이 파티에서의 내 자리. 없으면(공개 파티를 구경 중) 캐릭터 선택도 없다. */
  const myMembership =
    viewerPersonId === null
      ? null
      : (members.find((member) => member.personId === viewerPersonId) ?? null);

  /*
    ── 칩마다 **내가 데려가는 캐릭터** ─────────────────────────────────────────
    발주 2026-10-16: 실측된 파티들이 `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 **캐릭터
    이름으로만** 갈리므로, 파티를 고르는 자리에 그 축이 보여야 한다.

    ★ **새 조회가 없다.** 판정 열쇠는 이 컴포넌트가 이미 받고 있는 `characters`
      (`fetchMyRunCharacters`)이고, 파티별 재료는 `Party.members` 에 이미 실려 있다.
    ★ **선택된 파티만 확정값을 쓴다.** `members`(= `fetchPartyMembers`)에는
      `party_participants.character_id` 가 그대로 있어 "지정 없음" 을 가릴 수 있다.
      나머지 칩은 목록 payload 만 가지므로 추론으로 떨어지고, 가를 수 없는 경우는
      `assigned: null` 이 된다(§ `resolveMyPartyOption` 머리말).
  */
  const lens = useMemo(() => myPartyLens(characters), [characters]);
  const partyOptions = useMemo<readonly PartyOptionData[]>(
    () =>
      parties.map((party) => ({
        ...party,
        mine: resolveMyPartyOption(
          party.members,
          lens,
          party.partyId === selectedPartyId && myMembership !== null
            ? myMembership.characterId !== null
            : undefined,
        ),
      })),
    [parties, lens, selectedPartyId, myMembership],
  );

  /** 여는 버튼이 그리는 **고른 파티 하나**. 없으면 버튼이 "고르세요" 라고 말한다. */
  const selectedOption =
    partyOptions.find((party) => party.partyId === selectedPartyId) ?? null;

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
        <div className="flex flex-wrap items-center gap-2">
          {/*
            ★ **`파티 편집` 이 `새 파티` 옆으로 올라왔다** (2026-08-19 발주자:
              *"파티 / 구성원 편집이 아니라 새파티 옆에 파티 편집으로 넣고"*).
              예전에는 아래 로스터 줄에 `구성원 편집` 이라는 이름으로 있었는데, 그 창은
              구성원만 고치는 곳이 아니다 — 이름·보스·**분배 배율**까지 그 안에 있다.
              이름과 자리를 실제 내용에 맞췄다.
            ★ 파티를 고르지 않았으면 편집할 대상이 없으므로 비활성이다. 감추지 않는 이유는
              버튼이 사라졌다 나타나면 사용자가 그 자리를 다시 찾아야 하기 때문이다.
          */}
          {onEditRoster === null ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onEditRoster}
              disabled={selectedParty === null}
            >
              <Settings2 aria-hidden size={16} />
              파티 편집
            </Button>
          )}
          {/*
            ★ **복사는 `파티 편집` 과 `새 파티` 사이**다. 이 버튼이 하는 일이 정확히
              그 둘 사이에 있다 — 있는 파티를 바탕으로 **새** 파티를 만든다.
            ★ 고르지 않았으면 복사할 대상이 없으므로 비활성이다(`파티 편집` 과 같은 규칙).
            ⚠️ **남의 공개 파티는 복사하지 못한다** — 서버가 구성원만 허용한다
              (`copyParty` 의 `requirePartyMembership`). `members` 가 비어 있는 파티가
              그것이므로 화면도 같은 선으로 막는다. 눌러 봐야 403 인 버튼을 두면
              "권한이 없다" 를 실패로 배우게 된다.
          */}
          {onCopyParty === null ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onCopyParty}
              disabled={
                selectedParty === null ||
                selectedParty.members.length === 0 ||
                isCopying
              }
            >
              <Copy aria-hidden size={16} />
              {isCopying ? "복사 중…" : "파티 복사"}
            </Button>
          )}
          {onCreateParty === null ? null : (
            <Button variant="secondary" size="sm" onClick={onCreateParty}>
              <Plus aria-hidden size={16} />새 파티
            </Button>
          )}
          {/*
            ★ **만든 사람에게만 보인다**(발주 요구 2026-08-20). `isOwner` 가 아니면 버튼
              자체가 없다 — 눌러 봐야 403 인 버튼을 두면 "권한이 없다"를 실패로 배우게 된다.
              물론 판정은 서버가 한다. 이 숨김은 안내이지 방어가 아니다.
            ★ 자리는 `새 파티` **오른쪽 끝**이다. 되돌릴 수 없는 동작을 자주 쓰는 버튼
              사이에 끼우면 오조작이 는다.
          */}
          {selectedParty?.isOwner === true ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmingDisbandId(
                  isConfirmingDisband ? null : selectedParty.partyId,
                );
              }}
              className="text-error hover:text-error"
            >
              <Bomb aria-hidden size={16} />
              {isConfirmingDisband ? "해체 취소" : "파티 해체"}
            </Button>
          ) : null}
        </div>
      </div>

      {/*
        ── 해체 확인 ────────────────────────────────────────────────────────
        ★ **"정말 하시겠습니까?" 만 묻지 않는다**(`credential-manager` 가 세운 규칙).
          사용자가 판단할 근거가 없으면 누르는 것 말고 할 수 있는 게 없고, 되돌릴 수 없는
          동작에서 그건 곧 사고다. 그래서 **무엇이 사라지고 무엇이 남는지**를 먼저 말한다.
        ★ 특히 **수익 기록이 남는다는 사실**을 반드시 말한다. 겁을 주는 확인창은 안전한
          것이 아니라 그냥 나쁜 것이고, 그 오해 때문에 안 쓰는 파티를 계속 안고 가게 된다.
      */}
      {isConfirmingDisband && selectedParty !== null ? (
        <div className="flex flex-col gap-2 rounded-md border border-error bg-background p-pad-md">
          <p className="text-body-sm font-semibold text-ink">
            {withJosa(selectedParty.name, "을/를")} 해체합니다.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink-muted">
            <li>
              구성원 {members.length}명과 이 파티의 일정이 모든 화면에서
              사라집니다.
            </li>
            <li>
              이미 기록된{" "}
              <strong className="text-ink">
                결정석·드랍 수익은 그대로 남습니다.
              </strong>
            </li>
            <li>
              되돌리는 화면은 없습니다. 다시 쓰려면 파티를 새로 만들어야 합니다.
            </li>
          </ul>
          {disbandErrorMessage === null ? null : (
            <HelperText tone="error" role="alert">
              {disbandErrorMessage}
            </HelperText>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={onDisbandParty}
              disabled={isDisbanding}
            >
              {isDisbanding ? "해체하는 중…" : "해체합니다"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDisbandId(null)}
              disabled={isDisbanding}
            >
              그만두기
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        복사 실패는 **해체 확인과 같은 자리**에서 말한다. 토스트로만 말하면 사라진 뒤
        무엇이 안 됐는지 되짚을 길이 없고, 복사는 "눌렀는데 아무 일도 안 일어난" 것과
        구별되어야 한다.
      */}
      {copyErrorMessage === null ? null : (
        <HelperText tone="error" role="alert">
          {copyErrorMessage}
        </HelperText>
      )}

      {isPartiesError ? (
        <ErrorState
          title="파티 목록을 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={onPartiesRetry}
        />
      ) : isPartiesLoading ? (
        /*
          ★ 모양이 **여는 버튼 하나**로 바뀌었다(2026-10-19). 예전의 칩 세 장짜리
            스켈레톤은 없어진 띠를 약속하므로 그대로 두면 거짓말이 된다.
        */
        <SkeletonGroup label="파티 목록을 불러오는 중">
          <Skeleton className="h-28 w-full" />
        </SkeletonGroup>
      ) : parties.length === 0 ? (
        <EmptyState
          title="아직 파티가 없습니다"
          description="같이 보스 갈 사람들과 그 파티가 도는 보스를 묶어 둡니다. 그러면 시간표의 빈 칸을 눌러 이 파티를 고르는 것만으로 일정이 잡힙니다."
          action={
            /*
              만들기가 이 화면의 일이 아닐 때는 **어디로 가야 하는지**를 말한다.
              버튼만 지우면 빈 화면이 막다른 길이 된다.
            */
            onCreateParty === null ? (
              <Link href="/parties">
                <Button size="sm">
                  <Plus aria-hidden size={16} />
                  파티 관리로 가기
                </Button>
              </Link>
            ) : (
              <Button size="sm" onClick={onCreateParty}>
                <Plus aria-hidden size={16} />첫 파티 만들기
              </Button>
            )
          }
        />
      ) : (
        <>
          {/*
            ── 고른 파티 + 바꾸기 (발주 2026-10-19) ──────────────────────────
            ★ **얼굴이 40px 이다**(`card` 밀도). 20px 칩에서는 누가 있는 파티인지
              알아볼 수 없다는 것이 발주 내용이고, 이 자리에는 파티가 **하나만**
              오므로 큰 얼굴을 쓸 폭이 그대로 생긴다.
            ★ 접근성 — 이름은 **`sr-only` 한 줄 + 본문**이 함께 만든다. `aria-label`
              로 덮으면 `MyCharacterMark` 가 싣고 있는 `sr-only` 경고문("남이 일정을
              잡으면 클리어가 붙지 않습니다")이 통째로 사라진다. 지금 구조에서는
              버튼 이름이 "지금 고른 파티 … 본캐 림흉 돌먹 3명 … 내 캐릭터 …" 로
              읽히고, `aria-haspopup="dialog"` 가 눌렀을 때 창이 뜬다고 말한다.
            ⚠️ **`relative` 를 뺄 수 없다.** `sr-only` 는 `position: absolute` 이고,
               위치 잡힌 조상이 없으면 포함 바탕이 뷰포트가 되어 **페이지
               `scrollWidth` 를 밀어 올린다**(`MyCharacterMark` 머리말의 실측 사건:
               폭 400px 에서 385 → 780). 그 표식이 이 버튼 안에도 들어온다.
            ★ 폭 320px 가드: 제목 줄은 `flex-wrap` + `min-w-0 truncate`, 얼굴 줄은
              공용 컴포넌트가 이미 `flex-wrap` + `shrink-0` 다. 가로로 넘칠 수 있는
              것은 글자뿐이고 그것은 잘린다.
          */}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-haspopup="dialog"
            className={cn(
              "relative flex w-full min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-left",
              "transition duration-200 hover:border-primary hover:bg-hover-surface",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
          >
            <span className="sr-only">
              지금 고른 파티 — 눌러서 파티 {parties.length}개 중에서 바꾸기:
            </span>
            <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">
                {selectedOption?.name ?? "파티를 고르세요"}
              </span>
              {selectedOption === null ? null : (
                <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                  {selectedOption.memberCount}명
                  {selectedOption.bosses.length === 0
                    ? ""
                    : ` · 보스 ${String(selectedOption.bosses.length)}`}
                </span>
              )}
              {/*
                `바꾸기` 는 **글자로** 말한다. 아이콘만 두면 이 카드가 눌리는
                것인지가 모양으로만 전해지고, 그건 추측이다. 14px(`text-body-sm`)
                하한을 지킨다(§4).
              */}
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-body-sm text-ink-muted">
                <ChevronsUpDown aria-hidden size={14} />
                바꾸기
              </span>
            </span>

            {selectedOption === null ||
            selectedOption.mine === null ||
            selectedOption.mine === undefined ? null : (
              <MyCharacterMark mine={selectedOption.mine} density="card" />
            )}

            {/*
              ★ `max` 는 **공용 목록과 같은 6**이다 — 보스 파티 상한이 대개 6인이라
                거의 모든 파티가 접히지 않는다(`party-option.tsx` 의 `MAX_FACES`).
                접지 않는 선택(`null`)은 24인 파티에서 얼굴 줄이 네 줄이 된다.
            */}
            {selectedOption === null ? null : (
              <>
                <BossFaceRow
                  bosses={selectedOption.bosses}
                  max={6}
                  density="card"
                />
                <MemberFaceRow
                  members={selectedOption.members}
                  max={6}
                  density="card"
                />
              </>
            )}
          </button>

          <PartyPickerDialog
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            parties={partyOptions}
            selectedPartyId={selectedPartyId}
            onSelect={(partyId) => {
              /*
                고르면 **창이 닫힌다.** 이 창의 질문은 하나뿐이고, 고른 뒤에도 열려
                있으면 "더 할 일이 남았나" 가 된다(일정 잡기 창이 고르는 순간 다음
                단계로 넘어가는 것과 같은 규칙).
              */
              setPickerOpen(false);
              onSelectParty(partyId);
            }}
            onCreateParty={onCreateParty}
          />

          {/* 선택한 파티의 로스터 */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-body-sm font-semibold text-ink">
                {selectedParty?.name ?? "파티를 선택하세요"}
                <span className="ml-2 text-body-sm font-normal text-ink-muted tabular-nums">
                  {members.length}명
                </span>
              </h3>
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
                description="위 ‘파티 편집’ 에서 같이 갈 사람을 추가하세요."
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
                    {/*
                      ── 지정이 없으면 **그 사실과 결과를 함께** 말한다 (발주 2026-10-16) ──
                      ★ 위 칩의 주황 표식과 **같은 사실**이고, 여기가 그것을 고치는
                        자리다. 칩은 "문제가 있다" 까지만 말할 수 있고(폭이 그만큼이다)
                        조치는 이 줄이 가진다.
                      ★ §4 — 경고는 **면과 아이콘이** 주황을 지고 **문장은 ink** 다.
                        주황 본문은 라이트·다크 어느 쪽에서도 AA 에 못 미친다.
                      ★ 빨강이 아니다. 실패도 취소도 아니고 **임박한 문제**다(§4).
                    */}
                    {myMembership.characterId === null ? (
                      <p className="flex items-start gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2 py-1.5 text-body-sm text-ink">
                        <TriangleAlert
                          aria-hidden
                          size={16}
                          className="mt-0.5 shrink-0 text-chip-soon-fg"
                        />
                        <span>
                          이 파티에 데려갈 캐릭터를 아직 정하지 않았습니다. 정해
                          두지 않으면{" "}
                          <strong className="font-semibold">
                            남이 이 파티로 일정을 잡을 때
                          </strong>{" "}
                          내 참가 기록에 캐릭터가 비어, 넥슨에서 보스를 깨도 그
                          일정에 클리어가 붙지 않습니다.
                        </span>
                      </p>
                    ) : null}
                    <select
                      id={characterSelectId}
                      value={myMembership.characterId ?? ""}
                      onChange={(event) =>
                        onChangeMyCharacter(
                          event.target.value === "" ? null : event.target.value,
                        )
                      }
                      className={cn(
                        "h-control-md w-full max-w-80 min-w-0 rounded-md border border-border bg-surface px-3",
                        "text-body-sm text-ink transition duration-200 outline-none",
                        "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                      )}
                    >
                      <option value="">지정 안 함 (본캐 이름으로 표시)</option>
                      {characters.map((entry) => (
                        <option
                          key={entry.characterId}
                          value={entry.characterId}
                        >
                          {entry.name}
                          {entry.isMain ? " (본캐)" : ""}
                          {entry.worldName === null
                            ? ""
                            : ` · ${entry.worldName}`}
                        </option>
                      ))}
                    </select>
                    <HelperText>
                      부캐로 참여하면 파티 목록에{" "}
                      <strong className="font-semibold">본캐(부캐)</strong> 로
                      표시됩니다.
                    </HelperText>
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
