"use client";

import { Swords } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import {
  Button,
  Dialog,
  ErrorState,
  HelperText,
  Input,
  Label,
  WizardSteps,
  type WizardStep,
} from "@/components/ui";
import { resolveBossDuration } from "@/lib/domain/boss-duration-estimate";
import { PARTY_TITLE_HINT, buildPartyTitle } from "@/lib/domain/party-title";
import { DEFAULT_RUN_MINUTES } from "@/lib/domain/run-grouping";
import type {
  BossCatalogEntry,
  BossDifficultyId,
  PartyId,
  Person,
  PersonId,
} from "@/types/domain";

import { MemberPicker, type PendingGuest } from "./member-select-grid";

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
    /**
     * `guestNames` 중 **같은 이름이 이미 있는 걸 보고도 새로 만들라**고 사용자가 고른 것
     * (2026-10-19). 서버는 이 목록에 없는 이름만 기존 게스트로 재사용한다 —
     * 근거는 `member-select-grid.tsx` 머리말과 `schedule-repo.resolveGuestNames`.
     */
    readonly forceNewGuestNames: readonly string[];
    readonly bossDifficultyIds: readonly BossDifficultyId[];
    /**
     * 보스별 소요 시간(분). `bossDifficultyIds` 와 같은 자리끼리 짝이고 `null` 은
     * "정하지 않음"이다.
     *
     * ★ **건드리지 않았으면 `undefined`** 다. 파티 만들기는 보스 목록을 그대로 저장하는
     *   경로라, 아무도 고치지 않은 분을 실어 보내면 전부 "정하지 않음"으로 한 번 더
     *   쓰는 왕복만 늘어난다(부모가 그 왕복을 건너뛴다).
     */
    readonly bossDurationMinutes?: readonly (number | null)[];
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

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [bossIds, setBossIds] = useState<readonly BossDifficultyId[]>([]);
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
  const [bossDurations, setBossDurations] = useState<
    readonly (number | null)[]
  >([]);
  const [editedBossIds, setEditedBossIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [selectedIds, setSelectedIds] = useState<readonly PersonId[]>(() =>
    viewerPersonId === null ? [] : [viewerPersonId],
  );
  /**
   * 저장 전까지 줄 세워 둔 신규 게스트. **검증·입력칸은 `MemberPicker` 가 가진다** —
   * 두 창이 같은 블록을 각자 들고 있어 한쪽만 고치는 일이 반복됐다(그 파일 머리말).
   */
  const [guests, setGuests] = useState<readonly PendingGuest[]>([]);

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

  const allNames = useMemo(() => {
    const picked = effectiveMemberIds
      .map((id) => people.find((person) => person.personId === id)?.displayName)
      .filter((value): value is string => value !== undefined);
    return [...picked, ...guests.map((guest) => guest.name)];
  }, [effectiveMemberIds, guests, people]);

  const totalCount = effectiveMemberIds.length + guests.length;

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

  /*
    저장이 끝나면 **자동으로** 4단계로 옮긴다. effect 로 `setStep` 을 부르는 대신
    렌더 중에 유도한다 — 저장 성공은 `createdPartyId` 하나로 표현되므로 파생 값으로
    충분하고, effect 를 쓰면 한 프레임 동안 3단계가 남아 깜빡인다.

    ⚠️ **이 값이 이 컴포넌트의 유일한 현재 단계다.** `step` 은 저장 전까지만 뜻이 있고
       저장 뒤에는 2 에 멈춰 있다(위 유도의 대가). 화면은 `effectiveStep` 으로 그리면서
       버튼 동작만 `step` 을 보고 있었고, 그래서 4단계의 **완료를 누르면 `step === 2`
       갈래가 다시 돌아 파티가 한 번 더 만들어졌다**(발주 보고 2026-09-02: *"완료눌러도
       모달이 종료가 안되고 계속 누를수있음 / 실제로 더 생성도 됨"*).
       파생 단계를 만들었으면 **읽는 곳을 하나도 남기지 말고** 전부 그쪽으로 옮겨야 한다.
  */
  const effectiveStep = createdPartyId !== null ? 3 : step;

  const canAdvance = steps[effectiveStep]?.complete === true;

  const goNext = () => {
    if (!canAdvance || isSubmitting) return;
    if (effectiveStep < 2) {
      setStep(effectiveStep + 1);
      return;
    }
    if (effectiveStep === 2) {
      /*
        3단계 끝 = 저장. 4단계(분배)는 참가자 행이 있어야 열 수 있어서다(머리말).
        부모가 `createdPartyId` 를 채워 주면 아래 렌더가 4단계로 넘어간다.
        ★ 여기에 닿으려면 `createdPartyId` 가 `null` 이어야 한다(위 유도) — 이미 만든
          파티를 두 번 만드는 길이 구조적으로 막힌다.
      */
      onSubmit({
        name,
        memberPersonIds: selectedIds,
        guestNames: guests.map((guest) => guest.name),
        /* 동명이인으로 **일부러** 만들기로 한 이름만. 나머지는 서버가 재사용한다. */
        forceNewGuestNames: guests
          .filter((guest) => guest.forceNew)
          .map((guest) => guest.name),
        bossDifficultyIds: bossIds,
        ...(editedBossIds.size > 0
          ? { bossDurationMinutes: bossDurations }
          : {}),
      });
      return;
    }
    onClose();
  };

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
          <div className="flex min-w-0 flex-col gap-4">
            {/*
              ★ 2026-10-19 — **찾기·추가·후보 격자가 한 덩어리**가 됐다. 예전에는
                "닉네임으로 추가" 칸이 격자와 따로 위에 있어서 사용자가 **찾아보지도
                않고 바로 적었고**, 그래서 같은 이름의 게스트가 8종 생겼다(그 파일
                머리말에 실측이 있다). 로딩·빈·오류 세 갈래도 그쪽이 가진다.
            */}
            <MemberPicker
              people={people}
              selectedIds={selectedSet}
              onToggle={handleToggle}
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
              onChange={handleBossStructureChange}
              durations={bossDurations}
              onDurationEdit={handleBossDurationEdit}
              /*
                빈 칸의 흐린 숫자 = 저장될 구성원 전원이 간다고 본 배율 합산 추정
                (`resolveBossDuration`). 아직 저장 전이라 누가 어느 캐릭터로 가는지 모르므로
                전원 미보정(본캐 기준)이다 — 일정을 잡을 때 실제 캐릭터로 다시 접힌다.
              */
              fallbackMinutesOf={(bossDifficultyId) =>
                resolveBossDuration({
                  bossDifficultyId,
                  bundleMinutes: null,
                  participants: effectiveMemberIds.map(() => null),
                  fallbackMinutes: DEFAULT_RUN_MINUTES,
                }).minutes
              }
              fallbackNote={
                effectiveMemberIds.length <= 1
                  ? "혼자 기준 예상 시간"
                  : `${String(effectiveMemberIds.length)}인 기준 예상 시간`
              }
              disabled={isSubmitting}
            />
            <HelperText>
              여기 등록해 두면 시간을 잡을 때 체크만 하면 됩니다. 체크한 보스는
              시작 시각부터 <strong className="font-semibold">차례로</strong>{" "}
              일정이 잡힙니다. 보스마다{" "}
              <strong className="font-semibold">소요 시간</strong>을 정해 두면
              일정의 끝 시각이 그 합으로 계산됩니다 — 비워 두면 일정을 잡는
              캐릭터에 정해 둔 값, 그것도 없으면 칸에 흐리게 적힌 기본값으로
              봅니다. 지금 안 정해도 나중에 바꿀 수 있습니다.
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

const STEP_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "비워 두면 보스 조합으로 제목이 자동으로 만들어집니다.",
  1: "이 파티에 들어갈 사람입니다. 계정이 없는 사람은 닉네임만으로 넣을 수 있습니다.",
  2: "이 파티가 묶어서 도는 보스입니다. 고른 순서대로 일정이 잡힙니다.",
  3: "결정석을 나누는 비율입니다. 기본은 균등이라 그대로 둬도 됩니다.",
};
