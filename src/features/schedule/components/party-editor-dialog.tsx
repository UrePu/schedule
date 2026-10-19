"use client";

import { Swords, TriangleAlert, UserRound } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import {
  Button,
  Dialog,
  ErrorState,
  HelperText,
  Input,
  Label,
} from "@/components/ui";
import { PARTY_TITLE_HINT, buildPartyTitle } from "@/lib/domain/party-title";
import { cn } from "@/lib/utils";
import type {
  BossCatalogEntry,
  BossDifficultyId,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import { MemberPicker, type PendingGuest } from "./member-select-grid";

/*
 * ★ 2026-10-16 (2단계) — `PartyBossPicker` import 가 **없어졌다.** 보스는 보스 묶음이
 *   소유하고(`party_bundle_bosses`) 고치는 자리는 묶음 편집 창 하나다. 근거는 위
 *   `initialBossIds` 머리말.
 */
import { PartyShareSection } from "./party-share-section";

/**
 * 파티 만들기 / 로스터 편집 다이얼로그.
 *
 * 두 흐름을 한 컴포넌트로 둔 이유: 화면이 하는 일이 **"이름 + 구성원 정하기"** 로 같다.
 * 다른 것은 저장 시 호출하는 함수뿐이라, 폼을 두 벌로 나누면 규칙(번호 부여 안내,
 * 이름 자동 요약)이 두 곳에서 갈라진다.
 *
 * ⚠️ 번호는 **파티 단위**다. 편집 중에도 기존 구성원의 번호는 그대로 유지되고,
 *    새로 들어온 사람만 저장 시점에 `max + 1` 을 받는다 (§1.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 닉네임만으로도 사람을 넣을 수 있다 (발주 요구)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: "그냥 닉네임만으로도 파티 만들수있게 해야함. 상대방이 참여 안할수도있잖아."
 *
 * 그래서 후보 목록(체크박스 격자)과 **별개로** 닉네임 입력 칸이 있다. 여기 적은 이름은
 * 저장할 때 비로소 게스트로 만들어진다 — 입력하자마자 만들면 창을 취소했을 때 아무
 * 파티에도 속하지 않은 유령 게스트가 DB 에 남는다.
 *
 * 저장 전의 이름은 **아직 번호가 없다.** 게스트도 저장 시점에 `max + 1` 을 받고,
 * 나중에 초대 링크로 계정을 승계해도 그 번호는 유지된다(`claim_guest_profile` 이
 * `member_no` 를 건드리지 않는다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 파티는 **보스 목록을 갖는다** (발주 요구, 2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"애초에 파티 생성을할때 보스를 정해두고 하니. 파티 정보 자체에 보스가 등록된다.
 * … 한번 생성된 묶음은 … 이름 줄임말로 줄여서 … 묶음 제목이 익세 하대 하카 2인 이
 * 되는거임."*
 *
 * 그래서 이 창에서 보스를 고르고, 그 순서와 인원으로 **제목이 자동으로 만들어진다.**
 *
 * ⚠️ **사용자가 적은 제목을 자동 생성이 덮으면 안 된다.** 판정은 값 비교가 아니라
 *    `parties.name_is_custom` 비트 하나로 한다. 그래서 이름 칸의 초기값이 갈린다:
 *      · 자동 제목인 파티(`nameIsCustom = false`) → 칸을 **비우고** 자동 제목을
 *        placeholder 로 보여 준다. 손대지 않고 저장하면 계속 자동이다.
 *      · 사람이 적은 제목(`nameIsCustom = true`) → 그 이름을 칸에 넣는다.
 *    자동 제목을 칸에 채워 두면 사용자가 손대지 않고 저장하는 순간 "사람이 정한 이름"
 *    으로 굳어 버려, 이후 보스를 바꿔도 제목이 영영 따라오지 않는다.
 */

export type PartyEditorMode = "create" | "edit";

export interface PartyEditorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly mode: PartyEditorMode;
  /**
   * 편집 대상 파티. **편집 모드에서만** 값이 있고, 분배 배율 섹션이 이 값으로 조회한다.
   * 만들기 모드에는 아직 파티가 없으므로 `null` 이다.
   */
  readonly partyId?: PartyId | null;
  /** 편집 모드일 때의 현재 파티 이름. */
  readonly initialName?: string;
  /**
   * 그 이름이 **사람이 적은 것**인가. `false` 면 자동 제목이므로 이름 칸을 비워 두고
   * 자동 제목을 placeholder 로 보여 준다(위 ⚠️ 참고). 만들기 모드는 언제나 `false`.
   */
  readonly initialNameIsCustom?: boolean;
  /** 편집 모드일 때의 현재 구성원(번호 · 참여 캐릭터 포함). */
  readonly currentMembers?: readonly PartyMember[];
  /**
   * 열람자 본인. **만들기 모드에서 기본 선택**이고, 인원수 계산에서도 빠지지 않는다.
   *
   * 서버는 생성자를 언제나 파티에 넣는다(`createParty` — 소유자가 없는 파티는 편집할
   * 사람이 없다). 그 사실을 화면이 반영하지 않으면 제목의 `N인` 이 저장값과 1 만큼
   * 어긋난다 — 2인 파티를 만들면서 미리보기는 `1인` 이라고 말하게 된다.
   */
  readonly viewerPersonId?: PersonId | null;
  /**
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   이 파티의 보스 — **미리보기 전용이고 고칠 수 없다** (2026-10-16, 2단계)
   *   ═══════════════════════════════════════════════════════════════════════
   *
   * 2026-10-16 까지 이 창 안에는 `PartyBossPicker` 가 있었다. 그것이 **없어졌다**:
   * 보스는 이제 **보스 묶음**이 소유하고(`party_bundle_bosses`), 한 파티가 조합을
   * 여럿 들 수 있다. 그 상태에서 "이 파티의 보스" 를 이 창에서 고치게 하면
   *   · 어느 묶음을 고친 것인지 화면이 말할 수 없고(번호 최소 묶음이라는 답은
   *     사용자가 모르는 규칙이다),
   *   · 같은 사실을 두 곳에서 정하게 되어 **반드시 갈라진다**(§1.1.1 의 그 규칙).
   * 고치는 자리는 `/parties` 의 **묶음 목록 → 편집** 하나다.
   *
   * 그런데 값은 **여전히 필요하다** — 파티의 자동 제목이 보스 줄임말로 만들어지므로
   * (`refreshPartyAutoName` 이 서버에서 같은 함수를 부른다) 이름 칸의 placeholder 가
   * 그것을 모르면 **거짓 미리보기**가 된다(`우레푸 외 3명` 이라고 적고 저장하면
   * `익세 하대 3인` 이 되는 상태). 그래서 읽기만 한다.
   */
  readonly initialBossIds?: readonly BossDifficultyId[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * **내가 이 파티에 데려갈 캐릭터** — 고치는 입구가 여기에도 있어야 하는 이유
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 발주 지시(2026-10-16): 복사한 파티에서 바로 **"보스와 캐릭터만"** 고치게 한다.
   * 복사 직후 열리는 창이 이 창인데, 그 전까지 캐릭터를 고르는 자리는 **파티 띠의
   * 로스터 아래 한 곳**뿐이었다 — 창을 닫고 그 줄을 찾아 내려가야 했다. 즉 발주가
   * 지정한 흐름("복사 → 창에서 보스와 캐릭터를 고친다")이 성립하지 않았다.
   *
   * ⚠️ **새 API 를 만들지 않았다.** 저장은 부모가 이미 들고 있는
   *    `PUT /api/schedule/parties/{id}/character`(→ `updateMyPartyCharacter`)가 하고,
   *    이 창은 고른 값을 올려 보낸다. 그래서 파티 띠의 같은 선택과 **같은 뮤테이션 ·
   *    같은 낙관적 반영 · 같은 롤백**을 공유한다 — 두 입구가 두 규칙을 갖지 않는다.
   * ⚠️ 이 값은 창의 `저장` 버튼을 **기다리지 않는다**(분배 배율 섹션과 같은 규약).
   *    `party_participants.character_id` 는 로스터·이름과 다른 컬럼이고, 한 버튼으로
   *    묶으면 이번에 추가한 사람의 참가자 행이 아직 없는 상태를 다뤄야 한다.
   *
   * `characters` 가 비어 있거나 `onChangeMyCharacter` 가 없으면 **칸을 그리지 않는다** —
   * 만들기 모드(아직 참가자 행이 없다)와 비로그인이 그 경우다.
   */
  readonly characters?: readonly RunCharacterOption[];
  /** 지금 지정된 캐릭터. `null` = 지정 안 함(본캐 이름으로 표시된다). */
  readonly myCharacterId?: string | null;
  /** `null` 이면 선택 칸 자체를 그리지 않는다(만들기 모드 · 비로그인). */
  readonly onChangeMyCharacter?: ((characterId: string | null) => void) | null;
  readonly people: readonly Person[];
  readonly isPeopleLoading: boolean;
  readonly isPeopleError: boolean;
  readonly onPeopleRetry: () => void;
  /** 고를 수 있는 보스 전부(일간은 서버가 이미 뺐다 — `@/lib/domain/boss-scope`). */
  readonly bosses: readonly BossCatalogEntry[];
  readonly onSubmit: (input: {
    /** 빈 문자열이면 "자동 제목을 쓴다"는 뜻이다. 서버가 그렇게 해석한다. */
    readonly name: string;
    readonly memberPersonIds: readonly PersonId[];
    /** 새로 만들어 넣을 게스트의 닉네임. 기존 게스트는 `memberPersonIds` 쪽이다. */
    readonly guestNames: readonly string[];
    /**
     * `guestNames` 중 **같은 이름이 이미 있는 걸 보고도 새로 만들라**고 사용자가 고른 것
     * (2026-10-19). 서버는 이 목록에 없는 이름만 기존 게스트로 재사용한다 —
     * 근거는 `member-select-grid.tsx` 머리말과 `schedule-repo.resolveGuestNames`.
     */
    readonly forceNewGuestNames: readonly string[];
    /*
      ★ 2026-10-16 — `bossDifficultyIds` · `bossDurationMinutes` 가 **빠졌다.** 보스는
        묶음이 소유하므로 이 창이 보낼 값이 아니다(위 `initialBossIds` 머리말). 남겨
        두면 "구성원만 고치려고 연 창" 이 보스 목록을 함께 덮어쓰는 길이 열려 있게 된다.
    */
  }) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
}

export function PartyEditorDialog({
  open,
  onClose,
  mode,
  partyId = null,
  initialName = "",
  initialNameIsCustom = false,
  currentMembers = [],
  viewerPersonId = null,
  initialBossIds = [],
  characters = [],
  myCharacterId = null,
  onChangeMyCharacter = null,
  people,
  isPeopleLoading,
  isPeopleError,
  onPeopleRetry,
  bosses,
  onSubmit,
  isSubmitting,
  submitError,
}: PartyEditorDialogProps) {
  const nameId = useId();
  const characterId = useId();

  /*
    자동 제목이면 칸을 비워 둔다 — 손대지 않고 저장했을 때 "사람이 정한 이름"으로
    굳지 않게 하려는 것이다(상단 ⚠️ 참고).
  */
  const [name, setName] = useState(initialNameIsCustom ? initialName : "");
  /*
    ★ 2026-10-16 — 보스 **상태 셋이 없어졌다**(`bossIds` · `bossDurations` ·
      `editedBossIds`). 이 창은 보스를 고치지 않으므로 들고 있을 이유가 없고, 들고
      있으면 다음 사람이 "여기서도 저장된다" 고 읽는다. `initialBossIds` 는 이름
      미리보기에만 쓰이는 **읽기 전용 프롭**이다(그쪽 머리말).
  */
  const [selectedIds, setSelectedIds] = useState<readonly PersonId[]>(() => {
    /*
      편집 모드는 현재 로스터가 곧 초기 선택이다(본인이 이미 들어 있다).
      만들기 모드는 **본인을 미리 체크**한다 — 서버가 어차피 넣기 때문이고,
      체크되지 않은 채로 두면 `N인` 이 저장값과 1 만큼 어긋난다.
    */
    if (currentMembers.length > 0) {
      return currentMembers.map((member) => member.personId);
    }
    return viewerPersonId === null ? [] : [viewerPersonId];
  });
  /**
   * 저장 전까지는 이름일 뿐이다. 저장 시 서버가 게스트로 만들거나 **같은 이름의 기존
   * 게스트를 재사용**한다(`forceNew` 가 그 갈림길이다 — `member-select-grid.tsx`).
   * 입력칸·검증은 `MemberPicker` 가 가진다.
   */
  const [guests, setGuests] = useState<readonly PendingGuest[]>([]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const handleToggle = useCallback((personId: PersonId) => {
    setSelectedIds((current) =>
      current.includes(personId)
        ? current.filter((id) => id !== personId)
        : [...current, personId],
    );
  }, []);

  const handleAddGuest = useCallback((guest: PendingGuest) => {
    setGuests((current) => [...current, guest]);
  }, []);

  const handleRemoveGuest = useCallback((value: string) => {
    setGuests((current) => current.filter((entry) => entry.name !== value));
  }, []);

  /**
   * 실제로 저장될 구성원. 본인을 체크에서 뺐더라도 서버가 다시 넣으므로 **여기서도 넣는다**
   * — 화면이 저장 결과와 다른 인원을 말하면 제목의 `N인` 이 어긋난다.
   */
  const effectiveMemberIds = useMemo<readonly PersonId[]>(
    () =>
      viewerPersonId === null || selectedIds.includes(viewerPersonId)
        ? selectedIds
        : [viewerPersonId, ...selectedIds],
    [selectedIds, viewerPersonId],
  );

  const selectedNames = effectiveMemberIds
    .map((id) => people.find((person) => person.personId === id)?.displayName)
    .filter((value): value is string => value !== undefined);
  const allNames = [...selectedNames, ...guests.map((guest) => guest.name)];

  const totalCount = effectiveMemberIds.length + guests.length;

  /*
    ── 자동 제목 ─────────────────────────────────────────────────────────────
    조합 규칙의 주인은 `@/lib/domain/party-title` 하나다. 서버가 저장할 때 부르는 것과
    **같은 함수**라 미리보기와 실제 저장 값이 갈라질 수 없다.

    보스가 하나도 없으면 예전 규칙(`우레푸 외 3명`)으로 돌아간다 — 이때도 규칙은
    `data/schedule-queries.ts` 의 `summarizePartyName` 과 같은 문장이다.
    정원(`N인`)은 서버가 `default_capacity = 구성원 수` 로 저장하므로 여기서도 같은 수를 쓴다.
  */
  const bossShortNames = useMemo(() => {
    const byId = new Map(
      bosses.map((entry) => [entry.bossDifficultyId, entry.shortName]),
    );
    /*
      ⚠️ **이 창이 고칠 수 없는 값**으로 미리보기를 만든다(2026-10-16). 서버의 자동
         제목이 그 보스들로 만들어지므로(`refreshPartyAutoName`), 여기서 빼면
         placeholder 가 거짓이 된다. 보스를 바꾸면 제목도 바뀌지만 그 일은 **묶음 편집**
         에서 일어나고, 그쪽 창이 자기 미리보기를 따로 그린다.
    */
    return initialBossIds.map((id) => byId.get(id) ?? id);
  }, [initialBossIds, bosses]);

  const memberSummaryName =
    allNames.length === 0
      ? "새 파티"
      : allNames.length === 1
        ? allNames[0]
        : `${allNames[0]} 외 ${allNames.length - 1}명`;

  const autoName =
    buildPartyTitle(bossShortNames, Math.max(totalCount, 1)) ??
    memberSummaryName;

  const canSubmit = totalCount > 0 && !isSubmitting;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "새 파티 만들기" : "파티 편집"}
      description={
        mode === "create"
          ? "보스마다 같이 가는 사람이 다릅니다. 조합별로 파티를 따로 두세요."
          : "구성원과 분배 배율을 여기서 정합니다. 빠진 사람의 번호는 비워 두고, 새로 들어온 사람은 다음 번호를 받습니다."
      }
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body-sm text-ink">
            <strong className="font-semibold tabular-nums">{totalCount}</strong>
            명 선택
            {guests.length > 0 ? (
              <span className="text-ink-muted">
                {" "}
                (닉네임 추가 {guests.length}명)
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              취소
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={() =>
                onSubmit({
                  name,
                  memberPersonIds: selectedIds,
                  guestNames: guests.map((guest) => guest.name),
                  /* 동명이인으로 **일부러** 만들 이름만. 나머지는 서버가 재사용한다. */
                  forceNewGuestNames: guests
                    .filter((guest) => guest.forceNew)
                    .map((guest) => guest.name),
                })
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
            저장됩니다. {PARTY_TITLE_HINT}
          </HelperText>
        </div>

        {/*
          ── 보스는 **여기서 고치지 않는다** (2026-10-16, 2단계) ────────────────
          ★ 안내를 남기는 이유: 버튼만 지우면 사용자는 "보스 편집이 없어졌다" 로 읽고
            찾아 헤맨다. **어디로 갔는지**를 한 줄로 말하는 것이 지우는 일의 절반이다.
          ★ 왜 갔는가: 한 파티가 보스 조합을 여럿 들 수 있게 되면서(묶음), "이 파티의
            보스" 라는 말이 가리키는 대상이 하나가 아니게 됐다(위 `initialBossIds` 머리말).
          ★ 아래 묶음 카드는 **같은 화면**에 있다 — 창을 닫으면 바로 보이므로 링크가
            필요하지 않고, 없는 버튼을 가리키지도 않는다.
        */}
        <div className="flex flex-col gap-1.5">
          <Label>
            <span className="inline-flex items-center gap-1.5">
              <Swords aria-hidden size={14} className="text-primary" />
              묶어서 도는 보스
            </span>
          </Label>
          <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
            보스는 이제 <strong className="font-semibold">보스 묶음</strong>{" "}
            마다 따로 정합니다. 이 창을 닫고 아래{" "}
            <strong className="font-semibold">보스 묶음</strong> 목록에서
            추가·편집해 주세요 — 같은 사람끼리 보스 조합만 다르면 파티를 새로
            만들 필요가 없습니다.
            {initialBossIds.length === 0
              ? null
              : ` 지금 이 파티의 대표 묶음에는 ${String(initialBossIds.length)}개가 등록돼 있습니다.`}
          </p>
        </div>

        {/*
          ── 내가 데려갈 캐릭터 ─────────────────────────────────────────────
          ★ **자리가 보스 바로 아래**다. 발주가 말한 복사 후 손질이 *"보스와 캐릭터"*
            두 가지이므로, 그 둘이 붙어 있어야 창을 열어 아래로 훑는 동작 하나로
            끝난다. 구성원 격자·게스트 추가는 복사본에서 손댈 일이 드물다.
          ★ `<Label htmlFor>` 가 실제 `<select>` 하나를 가리킨다 — 파티 띠의 같은
            칸과 동일한 접근성 배선이다.
        */}
        {onChangeMyCharacter === null || characters.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={characterId}>
              <span className="inline-flex items-center gap-1.5">
                <UserRound aria-hidden size={14} className="text-primary" />
                내가 데려갈 캐릭터
              </span>
            </Label>
            {/*
              ⚠️ 지정이 없으면 **그 사실과 결과를 함께** 말한다(파티 띠의 같은 경고와
                 한 문장이다). §4 — 면과 아이콘이 주황을 지고 **문장은 ink** 다.
                 빨강이 아니다: 실패가 아니라 임박한 문제다.
            */}
            {myCharacterId === null ? (
              <p className="flex items-start gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2 py-1.5 text-body-sm text-ink">
                <TriangleAlert
                  aria-hidden
                  size={16}
                  className="mt-0.5 shrink-0 text-chip-soon-fg"
                />
                <span>
                  아직 정하지 않았습니다. 정해 두지 않으면{" "}
                  <strong className="font-semibold">
                    남이 이 파티로 일정을 잡을 때
                  </strong>{" "}
                  내 참가 기록에 캐릭터가 비어, 넥슨에서 보스를 깨도 그 일정에
                  클리어가 붙지 않습니다.
                </span>
              </p>
            ) : null}
            <select
              id={characterId}
              value={myCharacterId ?? ""}
              onChange={(event) =>
                onChangeMyCharacter(
                  event.target.value === "" ? null : event.target.value,
                )
              }
              disabled={isSubmitting}
              className={cn(
                "h-control-md w-full max-w-80 min-w-0 rounded-md border border-border bg-surface px-3",
                "text-body-sm text-ink transition duration-200 outline-none",
                "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                "disabled:cursor-not-allowed disabled:opacity-40",
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
            <HelperText>
              이 선택은{" "}
              <strong className="font-semibold">아래 ‘저장’ 과 무관하게</strong>{" "}
              바로 저장됩니다. 같은 파티를 캐릭터만 바꿔 여러 벌 돌 때, 복사한
              파티에서 여기만 고치면 됩니다.
            </HelperText>
          </div>
        )}

        {/*
          ── 찾기 · 추가 · 후보 격자 ─────────────────────────────────────────
          ★ 2026-10-19 — **한 덩어리가 됐다**(발주: *"검색과 추가를 둘다넣어야지
            캐릭터 많아지는데 직접 다 읽어야돼?"*). 그 전까지 "닉네임으로 추가" 칸이
            후보 격자와 따로 위에 있었고 격자에는 검색이 없었다 — 후보 70명을 눈으로
            훑는 대신 이름을 다시 적게 만드는 배치였고, 그래서 같은 이름의 게스트가
            8종 생겼다(실측·경위는 `member-select-grid.tsx` 머리말).
          ★ 로딩·빈·오류 세 갈래도 그쪽이 가진다 — 두 창이 같은 블록을 각자 베껴
            들고 있던 것이 이번에 한 벌로 합쳐졌다.
        */}
        <MemberPicker
          people={people}
          selectedIds={selectedSet}
          onToggle={handleToggle}
          currentMembers={currentMembers}
          guests={guests}
          onAddGuest={handleAddGuest}
          onRemoveGuest={handleRemoveGuest}
          isPeopleLoading={isPeopleLoading}
          isPeopleError={isPeopleError}
          onPeopleRetry={onPeopleRetry}
          disabled={isSubmitting}
        />

        {totalCount === 0 ? (
          <HelperText tone="error">
            최소 한 명은 있어야 파티가 됩니다. 후보에서 고르거나 닉네임을 적어
            주세요.
          </HelperText>
        ) : null}

        {/*
          ── 분배 배율 (2026-08-19 발주자: *"분배조율도 파티 설정에 있어야된다고 했잖슴"*) ──
          ★ **편집 모드에서만** 나온다. 만들기 모드에는 아직 참가자 행(`party_participants.id`)
            이 없어 비율을 걸 대상이 없다 — 만들고 나서 다시 열면 여기에 뜬다.
          ★ 위 구성원 편집과 **저장 버튼이 다르다.** 구성원은 이 창의 `저장` 이 한 번에
            보내고, 비율은 자기 버튼으로 즉시 저장한다. 한 버튼으로 묶으면 이번에 추가한
            사람의 참가자 id 가 아직 없는 채로 비율을 만들어야 한다.
        */}
        {mode === "edit" && partyId !== null ? (
          <div className="border-t border-border pt-4">
            <PartyShareSection partyId={partyId} />
          </div>
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
