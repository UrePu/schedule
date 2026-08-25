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
  WizardSteps,
  type WizardStep,
} from "@/components/ui";
import { PARTY_TITLE_HINT, buildPartyTitle } from "@/lib/domain/party-title";
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
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 만들기 — **한 번에 하나만 묻는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"파티생성시에 파티이름, 파티원, 갈 보스, 분배 순서대로
 * 한번에 하나의 정보만 입력하도록 해봐"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 쪼개는가 — 한 창에 다 넣으니 **무엇을 먼저 해야 하는지가 안 보였다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 `PartyEditorDialog` 는 이름·보스·게스트·후보목록·분배를 한 화면에 세로로
 * 쌓았다. 그래서 스크롤 없이는 저장 버튼이 안 보였고, 정작 **필수는 구성원 하나뿐**인데
 * 다섯 덩어리가 똑같은 무게로 늘어서 있었다. 순서를 강제하면 그 무게가 드러난다.
 *
 * ★ **편집은 이 창이 하지 않는다.** 만들기 전용이다 — 편집은 이미 만들어진 파티의
 *   각 부분을 따로 고치는 일이라 순서를 강제할 이유가 없고, 강제하면 이름 한 글자
 *   고치려고 네 단계를 지나야 한다. 편집은 `/parties` 의 파티 상세가 맡는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 분배는 **파티가 생긴 뒤에만** 물을 수 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * 분배 배율은 `party_participants.id` 에 걸린다. 만들기 전에는 그 행이 없으므로
 * 4단계를 진짜 4번째에 두려면 **3단계 끝에서 파티를 먼저 만들어야 한다.**
 * 그래서 이 창은 3단계 "다음"이 곧 저장이고, 4단계는 방금 만들어진 파티의 분배를
 * 손보는 **마무리 화면**이다. 4단계는 건너뛸 수 있다 — 기본값(균등)이 이미 옳다.
 *
 * ⚠️ 그러므로 4단계에서 "취소"는 없다. 파티는 이미 만들어졌고, 되돌리는 것은
 *    해체이지 취소가 아니다. 그 자리에는 **완료**만 둔다.
 */

/** DB CHECK(`guest_profiles.display_name` 1~40자)와 같은 경계. */
const GUEST_NAME_MAX_LENGTH = 40;

export interface PartyWizardDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 열람자 본인 — 서버가 어차피 파티에 넣으므로 화면도 미리 넣는다. */
  readonly viewerPersonId: PersonId | null;
  readonly people: readonly Person[];
  readonly isPeopleLoading: boolean;
  readonly isPeopleError: boolean;
  readonly onPeopleRetry: () => void;
  readonly bosses: readonly BossCatalogEntry[];
  readonly onSubmit: (input: {
    readonly name: string;
    readonly memberPersonIds: readonly PersonId[];
    readonly guestNames: readonly string[];
    readonly bossDifficultyIds: readonly BossDifficultyId[];
  }) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
  /**
   * 저장이 끝나 파티가 생기면 그 id. **이 값이 채워지는 순간 4단계로 넘어간다.**
   * 부모가 뮤테이션 결과를 여기로 흘려 준다 — 창이 직접 저장하지 않는 이유는
   * 캐시 무효화·선택 전환 같은 뒷일이 전부 부모(워크스페이스)의 일이기 때문이다.
   */
  readonly createdPartyId: PartyId | null;
}

export function PartyWizardDialog({
  open,
  onClose,
  viewerPersonId,
  people,
  isPeopleLoading,
  isPeopleError,
  onPeopleRetry,
  bosses,
  onSubmit,
  isSubmitting,
  submitError,
  createdPartyId,
}: PartyWizardDialogProps) {
  const nameId = useId();
  const guestId = useId();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [bossIds, setBossIds] = useState<readonly BossDifficultyId[]>([]);
  const [selectedIds, setSelectedIds] = useState<readonly PersonId[]>(() =>
    viewerPersonId === null ? [] : [viewerPersonId],
  );
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

  const allNames = useMemo(() => {
    const picked = effectiveMemberIds
      .map((id) => people.find((person) => person.personId === id)?.displayName)
      .filter((value): value is string => value !== undefined);
    return [...picked, ...guestNames];
  }, [effectiveMemberIds, guestNames, people]);

  const totalCount = effectiveMemberIds.length + guestNames.length;

  /*
    ── 자동 제목 ─────────────────────────────────────────────────────────────
    조합 규칙의 주인은 `@/lib/domain/party-title` 하나다. 서버가 저장할 때 부르는 것과
    **같은 함수**라 미리보기와 실제 저장 값이 갈라질 수 없다.
  */
  const autoName = useMemo(() => {
    const byId = new Map(
      bosses.map((entry) => [entry.bossDifficultyId, entry.shortName]),
    );
    const shortNames = bossIds.map((id) => byId.get(id) ?? id);
    const memberSummary =
      allNames.length === 0
        ? "새 파티"
        : allNames.length === 1
          ? (allNames[0] ?? "새 파티")
          : `${allNames[0] ?? ""} 외 ${allNames.length - 1}명`;
    return buildPartyTitle(shortNames, Math.max(totalCount, 1)) ?? memberSummary;
  }, [allNames, bossIds, bosses, totalCount]);

  /*
    ── 단계 정의 ─────────────────────────────────────────────────────────────
    ★ **1단계(이름)는 언제나 완료다.** 비워 두면 자동 제목이 쓰이므로 "답하지 않음"이
      존재하지 않는다. 그런데도 **첫 단계로 둔 이유**는 발주 지시의 순서이기도 하고,
      이름 칸이 자동 제목 미리보기를 겸해 "이 파티가 무엇인지"를 먼저 보여 주기 때문이다.
    ★ **3단계(보스)도 비어 있어도 된다.** 보스 없는 파티는 예전 규칙(`우레푸 외 3명`)
      으로 제목이 붙고, 일정을 잡을 때 그때그때 고를 수 있다.
    ★ 진짜 필수는 **2단계(파티원)** 하나뿐이다.
  */
  const steps: readonly WizardStep[] = [
    { label: "파티 이름", complete: true },
    { label: "파티원", complete: totalCount > 0 },
    { label: "갈 보스", complete: true },
    { label: "분배", complete: createdPartyId !== null },
  ];

  const canAdvance = steps[step]?.complete === true;

  const goNext = () => {
    if (!canAdvance || isSubmitting) return;
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    if (step === 2) {
      /*
        3단계 끝 = 저장. 4단계(분배)는 참가자 행이 있어야 열 수 있어서다(머리말).
        부모가 `createdPartyId` 를 채워 주면 아래 렌더가 4단계로 넘어간다.
      */
      onSubmit({
        name,
        memberPersonIds: selectedIds,
        guestNames,
        bossDifficultyIds: bossIds,
      });
      return;
    }
    onClose();
  };

  /*
    저장이 끝나면 **자동으로** 4단계로 옮긴다. effect 로 `setStep` 을 부르는 대신
    렌더 중에 유도한다 — 저장 성공은 `createdPartyId` 하나로 표현되므로 파생 값으로
    충분하고, effect 를 쓰면 한 프레임 동안 3단계가 남아 깜빡인다.
  */
  const effectiveStep = createdPartyId !== null ? 3 : step;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 파티 만들기"
      description={STEP_DESCRIPTIONS[effectiveStep] ?? ""}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body-sm text-ink-muted">
            {effectiveStep === 3 ? (
              <span className="text-success">파티를 만들었습니다.</span>
            ) : (
              <>
                <strong className="font-semibold tabular-nums text-ink">
                  {totalCount}
                </strong>
                명 · {bossIds.length > 0 ? `보스 ${bossIds.length}` : "보스 미정"}
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/*
              4단계에는 취소가 없다 — 파티는 이미 만들어졌고 되돌리는 것은 해체다(머리말).
              1단계에도 "이전"이 없어야 하므로 두 버튼 다 조건부다.
            */}
            {effectiveStep > 0 && effectiveStep < 3 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => setStep(effectiveStep - 1)}
              >
                이전
              </Button>
            ) : null}
            {effectiveStep < 3 ? (
              <Button variant="secondary" size="sm" onClick={onClose}>
                취소
              </Button>
            ) : null}
            <Button size="sm" disabled={!canAdvance || isSubmitting} onClick={goNext}>
              {isSubmitting
                ? "만드는 중…"
                : effectiveStep === 2
                  ? "파티 만들기"
                  : effectiveStep === 3
                    ? "완료"
                    : "다음"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <WizardSteps
          steps={steps}
          current={effectiveStep}
          /* 저장 뒤에는 앞 단계로 못 돌아간다 — 이미 만들어진 파티라 되돌릴 것이 없다. */
          onGoTo={
            isSubmitting || createdPartyId !== null
              ? undefined
              : (index) => setStep(index)
          }
        />

        {/* ── 1. 파티 이름 ──────────────────────────────────────────────── */}
        {effectiveStep === 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>파티 이름</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={autoName}
              autoComplete="off"
              autoFocus
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                goNext();
              }}
            />
            <HelperText>
              비워 두면 <strong className="font-semibold">{autoName}</strong> 로
              저장됩니다. {PARTY_TITLE_HINT}
            </HelperText>
          </div>
        ) : null}

        {/* ── 2. 파티원 ─────────────────────────────────────────────────── */}
        {effectiveStep === 1 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={guestId}>닉네임으로 추가</Label>
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
                    // 다이얼로그 안에서 Enter 가 "다음"으로 새는 것을 막는다.
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
                currentMembers={EMPTY_MEMBERS}
              />
            )}

            {totalCount === 0 ? (
              <HelperText tone="error">
                최소 한 명은 있어야 파티가 됩니다. 후보에서 고르거나 닉네임을 적어
                주세요.
              </HelperText>
            ) : null}
          </div>
        ) : null}

        {/* ── 3. 갈 보스 ────────────────────────────────────────────────── */}
        {effectiveStep === 2 ? (
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
              일정이 잡힙니다. 지금 안 정해도 나중에 바꿀 수 있습니다.
            </HelperText>
          </div>
        ) : null}

        {/* ── 4. 분배 ───────────────────────────────────────────────────── */}
        {effectiveStep === 3 && createdPartyId !== null ? (
          <div className="flex flex-col gap-3">
            <PartyShareSection partyId={createdPartyId} />
            <HelperText>
              기본은 균등 분배입니다. 그대로 두려면{" "}
              <strong className="font-semibold">완료</strong>를 누르세요 — 나중에
              파티 관리에서 언제든 바꿀 수 있습니다.
            </HelperText>
          </div>
        ) : null}

        {submitError ? (
          <ErrorState
            title="파티를 만들지 못했습니다"
            detail={submitError.message}
            className="py-6"
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** `MemberSelectGrid` 가 매 렌더 새 배열을 받지 않도록 모듈 상수로 고정한다. */
const EMPTY_MEMBERS: readonly PartyMember[] = [];

const STEP_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "비워 두면 보스 조합으로 제목이 자동으로 만들어집니다.",
  1: "이 파티에 들어갈 사람입니다. 계정이 없는 사람은 닉네임만으로 넣을 수 있습니다.",
  2: "이 파티가 묶어서 도는 보스입니다. 고른 순서대로 일정이 잡힙니다.",
  3: "결정석을 나누는 비율입니다. 기본은 균등이라 그대로 둬도 됩니다.",
};
