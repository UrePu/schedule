"use client";

import { Swords, UserPlus, X } from "lucide-react";
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
import {
  PARTY_TITLE_HINT,
  buildPartyTitle,
} from "@/lib/domain/party-title";
import type {
  BossCatalogEntry,
  BossDifficultyId,
  PartyId,
  PartyMember,
  Person,
  PersonId,
} from "@/types/domain";

import { MemberSelectGrid } from "./member-select-grid";
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

  /*
    자동 제목이면 칸을 비워 둔다 — 손대지 않고 저장했을 때 "사람이 정한 이름"으로
    굳지 않게 하려는 것이다(상단 ⚠️ 참고).
  */
  const [name, setName] = useState(initialNameIsCustom ? initialName : "");
  const [bossIds, setBossIds] =
    useState<readonly BossDifficultyId[]>(initialBossIds);
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
            onChange={setBossIds}
            disabled={isSubmitting}
          />
          <HelperText>
            여기 등록해 두면 시간을 잡을 때 체크만 하면 됩니다. 체크한 보스는
            시작 시각부터 <strong className="font-semibold">차례로</strong>{" "}
            일정이 잡힙니다.
          </HelperText>
        </div>

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
              계정이 없는 사람도 닉네임만으로 넣을 수 있습니다. 나중에 초대 링크를
              보내면 그 사람 계정에 이 파티가 그대로 붙습니다.
            </HelperText>
          ) : (
            <HelperText tone="error">{guestHint}</HelperText>
          )}

          {guestNames.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {guestNames.map((value) => (
                <li key={value}>
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary bg-primary-subtle py-1 pr-1 pl-3">
                    <span className="truncate text-body-sm text-ink" title={value}>
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
