"use client";

import { Swords, TriangleAlert, UserPlus, UserRound, X } from "lucide-react";
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

import { MemberSelectGrid } from "./member-select-grid";
import { DEFAULT_RUN_MINUTES } from "@/lib/domain/run-grouping";

import { PartyBossPicker } from "./party-boss-picker";
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
  /** 편집 모드일 때 이 파티에 이미 등록된 보스 — **순서 그대로**. */
  readonly initialBossIds?: readonly BossDifficultyId[];
  /**
   * 그 보스들의 소요 시간(분) — `initialBossIds` 와 **같은 자리끼리** 짝이다.
   * `null` = 정하지 않음. 길이가 모자라면 `PartyBossPicker` 가 `null` 로 메운다.
   */
  readonly initialBossDurations?: readonly (number | null)[];
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
    /** 이 파티가 묶어서 도는 보스 — **순서가 곧 제목·배치 순서**다. */
    readonly bossDifficultyIds: readonly BossDifficultyId[];
    /**
     * 보스별 소요 시간(분). `bossDifficultyIds` 와 같은 자리끼리 짝이고 `null` 은
     * "정하지 않음"이다.
     *
     * ★ ═══════════════════════════════════════════════════════════════════════
     *   **건드리지 않았으면 `undefined`** 다 — 부모가 그때 필드를 생략한다.
     *   ═══════════════════════════════════════════════════════════════════════
     *   이 창은 **구성원만 고치려고** 여는 경우가 많다. 그때도 분 배열을 실어 보내면
     *   서버가 그 값으로 덮어쓰고, 사용자가 손대지도 않은 보스 시간이 저장할 때마다
     *   한 번씩 확정된다. 생략하면 DB 함수가 delete 전에 스냅샷을 떠 **기존 값을
     *   보존한다**(§ `SetPartyBossesInput.durationMinutes`).
     */
    readonly bossDurationMinutes?: readonly (number | null)[];
  }) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
}

/** DB CHECK(`guest_profiles.display_name` 1~40자)와 같은 경계. */
const GUEST_NAME_MAX_LENGTH = 40;

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
  initialBossDurations = [],
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
  const guestId = useId();
  const characterId = useId();

  /*
    자동 제목이면 칸을 비워 둔다 — 손대지 않고 저장했을 때 "사람이 정한 이름"으로
    굳지 않게 하려는 것이다(상단 ⚠️ 참고).
  */
  const [name, setName] = useState(initialNameIsCustom ? initialName : "");
  const [bossIds, setBossIds] =
    useState<readonly BossDifficultyId[]>(initialBossIds);
  /*
    ── 보스별 소요 시간 ────────────────────────────────────────────────────────
    `bossIds` 와 **자리끼리 짝**이다. `PartyBossPicker` 가 추가·빼기·▲▼ 에서 두 배열을
    함께 움직여 주므로(그쪽 `onChange`) 여기서 자리를 다시 맞추지 않는다.

    ★ ═══════════════════════════════════════════════════════════════════════════
      **"값을 고쳤다"는 `editedBossIds` 가 센다 — 구조를 바꿨다고 켜지지 않는다.**
      ═══════════════════════════════════════════════════════════════════════════
      저장 요청에 `bossDurationMinutes` 를 실으면 `set_party_bosses` 가 그 배열로
      **보스 전부의 분을 덮어쓴다.** 생략하면 DB 가 `boss_difficulty_id` 로 키를 잡아
      기존 값을 보존한다. 즉 **순서·추가·삭제에는 배열이 필요 없고**, 실으면 손해만
      본다(60초 stale 캐시의 `null` 이 남이 넣은 40분을 지운다). 그래서 값 수정
      콜백(`onDurationEdit`)이 불릴 때만 센다.
    ★ 빠진 보스의 id 는 **집합에서 지운다.** 고친 보스를 그 자리에서 다시 빼면 보낼
      이유가 사라지므로, 남겨 두면 "안 건드렸는데 덮어쓰는" 요청이 다시 생긴다.
  */
  const [bossDurations, setBossDurations] =
    useState<readonly (number | null)[]>(initialBossDurations);
  const [editedBossIds, setEditedBossIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
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
  /** 저장 전까지는 문자열일 뿐이다. 저장 시 서버가 게스트로 만든다. */
  const [guestNames, setGuestNames] = useState<readonly string[]>([]);
  const [guestDraft, setGuestDraft] = useState("");
  const [guestHint, setGuestHint] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  /** 구조 변경(추가·빼기·▲▼) — **값을 건드린 것으로 세지 않는다**(위 ★). */
  const handleBossStructureChange = (
    nextIds: readonly BossDifficultyId[],
    nextDurations: readonly (number | null)[],
  ) => {
    setBossIds(nextIds);
    setBossDurations(nextDurations);
    setEditedBossIds((prev) => {
      if (prev.size === 0) return prev;
      const kept = new Set(nextIds.filter((id) => prev.has(id)));
      return kept.size === prev.size ? prev : kept;
    });
  };

  /** 값 수정 — **이때만** 저장이 분 배열을 싣는다. */
  const handleBossDurationEdit = (
    bossDifficultyId: BossDifficultyId,
    minutes: number | null,
  ) => {
    setBossDurations((prev) =>
      bossIds.map((id, index) =>
        id === bossDifficultyId ? minutes : (prev[index] ?? null),
      ),
    );
    setEditedBossIds((prev) => new Set(prev).add(bossDifficultyId));
  };

  const handleToggle = useCallback((personId: PersonId) => {
    setSelectedIds((current) =>
      current.includes(personId)
        ? current.filter((id) => id !== personId)
        : [...current, personId],
    );
  }, []);

  const handleAddGuest = useCallback(() => {
    const trimmed = guestDraft.trim();
    if (trimmed === "") {
      setGuestHint("닉네임을 입력해 주세요.");
      return;
    }
    if (trimmed.length > GUEST_NAME_MAX_LENGTH) {
      setGuestHint(`닉네임은 ${GUEST_NAME_MAX_LENGTH}자 이하여야 합니다.`);
      return;
    }
    /*
      같은 요청 안의 중복만 막는다. **이미 있는 사람과 이름이 같아도 막지 않는다** —
      닉네임은 키가 아니고, 같은 이름의 다른 사람이 실제로 있다.
    */
    if (guestNames.includes(trimmed)) {
      setGuestHint("이미 추가한 닉네임입니다.");
      return;
    }
    setGuestNames((current) => [...current, trimmed]);
    setGuestDraft("");
    setGuestHint(null);
  }, [guestDraft, guestNames]);

  const handleRemoveGuest = useCallback((value: string) => {
    setGuestNames((current) => current.filter((entry) => entry !== value));
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
  const allNames = [...selectedNames, ...guestNames];

  const totalCount = effectiveMemberIds.length + guestNames.length;

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
    return bossIds.map((id) => byId.get(id) ?? id);
  }, [bossIds, bosses]);

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
            {guestNames.length > 0 ? (
              <span className="text-ink-muted">
                {" "}
                (닉네임 추가 {guestNames.length}명)
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
                  guestNames,
                  bossDifficultyIds: bossIds,
                  ...(editedBossIds.size > 0
                    ? { bossDurationMinutes: bossDurations }
                    : {}),
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

        {/* ── 이 파티가 묶어서 도는 보스 ─────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <Label>
            <span className="inline-flex items-center gap-1.5">
              <Swords aria-hidden size={14} className="text-primary" />
              묶어서 도는 보스
            </span>
          </Label>
          <PartyBossPicker
            bosses={bosses}
            selectedIds={bossIds}
            onChange={handleBossStructureChange}
            durations={bossDurations}
            onDurationEdit={handleBossDurationEdit}
            disabled={isSubmitting}
          />
          <HelperText>
            여기 등록해 두면 시간을 잡을 때 체크만 하면 됩니다. 체크한 보스는
            시작 시각부터 <strong className="font-semibold">차례로</strong>{" "}
            일정이 잡힙니다. 보스마다{" "}
            <strong className="font-semibold">소요 시간</strong>을 정해 두면
            일정의 끝 시각이 그 합으로 계산됩니다 — 비워 두면{" "}
            {DEFAULT_RUN_MINUTES}분으로 봅니다.
          </HelperText>
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

        {/* ── 닉네임만으로 추가 ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={guestId}>닉네임으로 추가</Label>
          {/*
            360px 에서 입력칸과 버튼이 한 줄에 들어가면 입력칸이 너무 좁아진다.
            좁은 화면에서는 세로로 쌓고, sm 이상에서만 나란히 둔다.
          */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={guestId}
              value={guestDraft}
              onChange={(event) => {
                setGuestDraft(event.target.value);
                setGuestHint(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // 다이얼로그 안에서 Enter 가 폼 제출로 새는 것을 막는다.
                event.preventDefault();
                handleAddGuest();
              }}
              placeholder="예) 콜라이제없어"
              autoComplete="off"
              maxLength={GUEST_NAME_MAX_LENGTH}
              className="sm:flex-1"
            />
            <Button
              variant="secondary"
              onClick={handleAddGuest}
              className="shrink-0"
            >
              <UserPlus aria-hidden size={16} />
              추가
            </Button>
          </div>
          {guestHint === null ? (
            <HelperText>
              계정이 없는 사람도 닉네임만으로 넣을 수 있습니다. 나중에 초대
              링크를 보내면 그 사람 계정에 이 파티가 그대로 붙습니다.
            </HelperText>
          ) : (
            <HelperText tone="error">{guestHint}</HelperText>
          )}

          {guestNames.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {guestNames.map((value) => (
                <li key={value}>
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary bg-primary-subtle py-1 pr-1 pl-3">
                    <span
                      className="truncate text-body-sm text-ink"
                      title={value}
                    >
                      {value}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveGuest(value)}
                      aria-label={`${value} 빼기`}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-muted transition duration-200 hover:bg-hover-strong hover:text-ink"
                    >
                      <X aria-hidden size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
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
            title="후보 목록이 비어 있습니다"
            description="위 칸에 닉네임을 적어 바로 추가할 수 있습니다. 친구를 맺거나 같은 파티가 되면 여기에도 나타납니다."
          />
        ) : (
          <MemberSelectGrid
            people={people}
            selectedIds={selectedSet}
            onToggle={handleToggle}
            currentMembers={currentMembers}
          />
        )}

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
