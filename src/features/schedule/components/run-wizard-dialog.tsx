"use client";

import { Search, Swords, Users } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { BossIcon } from "@/components/domain";
import { BOSS_DIFFICULTY_BORDER_L } from "@/components/domain/boss-difficulty";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  HelperText,
  Input,
  Label,
  WizardSteps,
  type WizardStep,
} from "@/components/ui";
import type { CharacterBossPlan } from "@/features/boss-plans/types";
import { participantLabel } from "@/lib/domain/participant-label";
import {
  formatDayMinute,
  kstMoment,
  minutesFromTimeText,
} from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  BossCatalogEntry,
  BossDifficultyId,
  CreateRunBundleInput,
  OverlapWindow,
  PartyBoss,
  PartyId,
  PartyMember,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";
import type { DayRow } from "../lib/overlay-layout";
import { DEFAULT_DURATION_MINUTES, FIXED_PARTY_WEEKS } from "../lib/run-defaults";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 일정 등록 — **시간 → 보스 → 참여자**, 한 번에 하나씩
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"보스 일정등록은 모달로 띄우도록 해. 지금 너무 헷갈리게
 * 되어있으니 시간(고정), 보스, 참여자 순서대로 고르면 모달 자체가 넘어가도록 변경해"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 순서가 이것인가 — 뒤 단계가 앞 단계에 **의존한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 임의로 정한 차례가 아니다.
 *   · **시간이 먼저**여야 한다. 겹침 막대를 눌러 들어오면 시간은 이미 정해져 있고,
 *     그 시간이 곧 "누가 올 수 있는가"의 범위다.
 *   · **보스가 두 번째**다. 몇 보스를 고르느냐가 총 소요 시간을 정하고(순차 배치),
 *     그래야 참여자에게 "몇 시부터 몇 시까지"를 말할 수 있다.
 *   · **참여자가 마지막**이다. 인원수가 결정석 1/n 의 분모라(§1.3 D3), 보스가 정해진
 *     뒤에야 "이 조합을 이 인원으로 가면 얼마"라는 미리보기가 성립한다.
 * 그래서 앞 단계로는 돌아갈 수 있어도 **건너뛰지는 못한다**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 고정팟이 **실제로 저장되게 만든다** — 예전에는 이름표뿐이었다
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 `RunComposer` 에도 고정팟 체크박스가 있었지만 `isFixedParty` 가 `onSubmit` 에
 * **한 번도 실리지 않았다.** 켜면 버튼 글자가 `고정팟 4주치 등록` 으로 바뀌는데 실제로는
 * 한 주만 등록됐다 — 조용히 틀리는 종류라 아무도 신고하지 않는다. 여기서는
 * `repeatWeeks` 를 payload 에 실어 보낸다(Route Handler 는 이미 받고 있었다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자동으로 넘어가지 **않는** 곳
 * ─────────────────────────────────────────────────────────────────────────────
 * 단계 이동은 `다음`(또는 Enter)이 한다. 보스와 참여자는 **여러 개를 고르는** 자리라,
 * 하나 누를 때마다 넘어가면 두 번째를 고를 수가 없다. 대신 각 단계가 답해지는 즉시
 * `다음` 이 활성화되고 표시줄에 완료 표시가 들어와, "이제 넘어가도 된다"가 눈에 보인다.
 */

export interface RunWizardDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly partyId: PartyId | null;
  readonly partyName: string | null;
  readonly dayRows: readonly DayRow[];
  /** 왼쪽 겹쳐보기에서 고른 창. 있으면 1단계가 이미 채워진 채로 열린다. */
  readonly selectedWindow: OverlapWindow | null;
  /**
   * 격자에서 막대를 **끌어서** 고른 시작 시각. `null` 이면 겹침의 시작 시각을 쓴다.
   * 이 둘을 가르지 않으면 22시~02시 겹침에서 23시를 골라도 22시가 채워진다.
   */
  readonly selectedStartsAt: Date | null;
  readonly bosses: readonly BossCatalogEntry[];
  readonly partyBosses: readonly PartyBoss[];
  /**
   * 처음 체크해 둘 보스. 부모가 **파티 보스 − 이번 주 이미 잡은 보스**로 계산해 준다.
   *
   * ★ 이 기본값을 마법사가 직접 만들지 않는 이유: 계획 조회(`is_cleared`)가 부모에
   *   있고, 같은 규칙을 여기서 다시 쓰면 두 벌이 된다. 창은 **받은 값으로 시작**만 한다.
   */
  readonly initialBossIds: readonly BossDifficultyId[];
  readonly plans: readonly CharacterBossPlan[];
  readonly members: readonly PartyMember[];
  readonly characters: readonly RunCharacterOption[];
  readonly characterId: string | null;
  readonly onCharacterIdChange: (characterId: string) => void;
  readonly onSubmit: (input: CreateRunBundleInput) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
}

export function RunWizardDialog({
  open,
  onClose,
  partyId,
  partyName,
  dayRows,
  selectedWindow,
  selectedStartsAt,
  bosses,
  partyBosses,
  initialBossIds,
  plans,
  members,
  characters,
  characterId,
  onCharacterIdChange,
  onSubmit,
  isSubmitting,
  submitError,
}: RunWizardDialogProps) {
  const timeId = useId();
  const durationId = useId();
  const searchId = useId();

  const [step, setStep] = useState(0);

  /*
    겹침 창이 있으면 그 값으로 연다. `useState` 초기값으로만 읽는다 — 창이 열려 있는 동안
    부모의 선택이 바뀌어도 사용자가 방금 고친 시각을 덮으면 안 되고, 다시 열 때는 부모가
    `key` 로 새로 마운트한다.
  */
  /** 드래그 시각 > 겹침 시작 시각 순으로 떨어진다. 둘 다 없으면 사용자가 직접 넣는다. */
  const seedAt =
    selectedStartsAt ??
    (selectedWindow === null ? null : new Date(selectedWindow.startsAt));
  const [dayKey, setDayKey] = useState(() => initialDayKey(seedAt, dayRows));
  const [timeText, setTimeText] = useState(() => initialTime(seedAt));
  const [durationText, setDurationText] = useState(
    String(DEFAULT_DURATION_MINUTES),
  );
  const [isFixedParty, setIsFixedParty] = useState(false);
  const [bossIds, setBossIds] = useState<readonly BossDifficultyId[]>(
    () => initialBossIds,
  );
  const [query, setQuery] = useState("");
  /** 뺀 사람만 기억한다 — 기본은 **전원 참여**이고, 그게 대개 맞다. */
  const [excluded, setExcluded] = useState<ReadonlySet<PersonId>>(new Set());

  const startMinutes = minutesFromTimeText(timeText);
  const durationMinutes = Number.parseInt(durationText, 10);
  const durationValid =
    Number.isInteger(durationMinutes) &&
    durationMinutes >= 5 &&
    durationMinutes <= 600;

  const bossById = useMemo(
    () => new Map(bosses.map((entry) => [entry.bossDifficultyId, entry])),
    [bosses],
  );

  /** 고른 보스를 **고른 차례대로**. 서버가 이 순서로 연달아 배치한다. */
  const orderedSelection = useMemo(
    () =>
      bossIds.flatMap((id) => {
        const entry = bossById.get(id);
        return entry === undefined ? [] : [entry];
      }),
    [bossById, bossIds],
  );

  const participants = useMemo(
    () => members.filter((member) => !excluded.has(member.personId)),
    [excluded, members],
  );
  const partySize = participants.length;

  const selectedCharacter =
    characters.find((entry) => entry.characterId === characterId) ?? null;

  const steps: readonly WizardStep[] = [
    { label: "시간", complete: startMinutes !== null && durationValid },
    { label: "보스", complete: orderedSelection.length > 0 },
    {
      label: "참여자",
      complete: partySize >= 1 && selectedCharacter !== null,
    },
  ];

  const canAdvance = steps[step]?.complete === true;
  const canSubmit =
    partyId !== null &&
    steps.every((entry) => entry.complete) &&
    startMinutes !== null &&
    selectedCharacter !== null &&
    !isSubmitting;

  const goNext = () => {
    if (isSubmitting) return;
    if (step < 2) {
      if (!canAdvance) return;
      setStep(step + 1);
      return;
    }
    if (!canSubmit || partyId === null || startMinutes === null) return;
    if (selectedCharacter === null) return;
    onSubmit({
      partyId,
      bossDifficultyIds: orderedSelection.map((entry) => entry.bossDifficultyId),
      scheduledAt: kstMoment(dayKey, startMinutes),
      durationMinutes,
      entryPartySize: partySize,
      participantPersonIds: participants.map((member) => member.personId),
      characterId: selectedCharacter.characterId,
      note: null,
      // ★ 예전 폼이 빠뜨렸던 값(머리말). 1 이면 이번 주 한 번이다.
      repeatWeeks: isFixedParty ? FIXED_PARTY_WEEKS : 1,
    });
  };

  /** 예상 수익 — 가격 미확인은 **더하지 않고 따로 센다** (§1.3 D4). */
  const income = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const entry of orderedSelection) {
      const share = crystalShareMeso(
        entry.crystalPriceMeso,
        Math.max(partySize, 1),
      );
      if (share === null) unknown += 1;
      else known += share;
    }
    return { known, unknown };
  }, [orderedSelection, partySize]);

  const toggleBoss = (id: BossDifficultyId) => {
    setBossIds((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  /*
    보스 후보를 세 묶음으로 나눈다 — 파티가 도는 보스 · 이 캐릭터가 매주 가는 보스 ·
    나머지 전체. 검색어가 있으면 세 묶음을 통틀어 거른다.
  */
  const planIds = useMemo(
    () =>
      new Set(
        plans
          .filter((plan) => plan.isActive)
          .map((plan) => plan.bossDifficultyId),
      ),
    [plans],
  );

  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, "");
  const groups = useMemo(() => {
    const matches = (entry: BossCatalogEntry): boolean => {
      if (normalizedQuery === "") return true;
      return [
        entry.koreanName,
        entry.bossKoreanName,
        entry.shortName,
        entry.bossDifficultyId,
        ...entry.aliases,
      ].some((value) =>
        value.toLowerCase().replace(/\s+/g, "").includes(normalizedQuery),
      );
    };

    const party = partyBosses.flatMap((entry) => {
      const found = bossById.get(entry.bossDifficultyId);
      return found !== undefined && matches(found) ? [found] : [];
    });
    const partySet = new Set(party.map((entry) => entry.bossDifficultyId));

    const planned = bosses.filter(
      (entry) =>
        planIds.has(entry.bossDifficultyId) &&
        !partySet.has(entry.bossDifficultyId) &&
        matches(entry),
    );
    const plannedSet = new Set(planned.map((entry) => entry.bossDifficultyId));

    /*
      나머지 전체는 **검색 중일 때만** 편다. 78개를 늘 펼쳐 두면 위 두 묶음이 묻힌다 —
      파티가 도는 보스를 고르러 온 사람이 대부분이다.
    */
    const rest =
      normalizedQuery === ""
        ? []
        : bosses.filter(
            (entry) =>
              !partySet.has(entry.bossDifficultyId) &&
              !plannedSet.has(entry.bossDifficultyId) &&
              matches(entry),
          );

    return { party, planned, rest };
  }, [bossById, bosses, normalizedQuery, partyBosses, planIds]);

  const totalMinutes = durationValid
    ? durationMinutes * Math.max(orderedSelection.length, 1)
    : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="보스 일정 등록"
      description={
        partyName === null
          ? STEP_DESCRIPTIONS[step]
          : `${partyName} · ${STEP_DESCRIPTIONS[step] ?? ""}`
      }
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body-sm text-ink-muted">
            {startMinutes === null ? (
              "시간을 정해 주세요"
            ) : (
              <>
                <span className="tabular-nums text-ink">
                  {dayLabel(dayKey, dayRows)} {timeText}
                </span>
                {orderedSelection.length > 0 ? (
                  <>
                    {" · "}
                    <span className="tabular-nums">
                      보스 {orderedSelection.length}
                    </span>
                    {totalMinutes === null ? null : (
                      <span className="tabular-nums"> ({totalMinutes}분)</span>
                    )}
                  </>
                ) : null}
                {step === 2 ? (
                  <>
                    {" · "}
                    <span className="tabular-nums">{partySize}명</span>
                  </>
                ) : null}
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {step > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => setStep(step - 1)}
              >
                이전
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={onClose}>
              취소
            </Button>
            <Button
              size="sm"
              disabled={step === 2 ? !canSubmit : !canAdvance}
              onClick={goNext}
            >
              {isSubmitting
                ? "등록 중…"
                : step < 2
                  ? "다음"
                  : isFixedParty
                    ? `고정팟 ${FIXED_PARTY_WEEKS}주치 등록`
                    : orderedSelection.length > 1
                      ? `일정 ${orderedSelection.length}건 등록`
                      : "일정 등록"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <WizardSteps
          steps={steps}
          current={step}
          onGoTo={isSubmitting ? undefined : (index) => setStep(index)}
        />

        {/* ── 1. 시간(고정) ─────────────────────────────────────────────── */}
        {step === 0 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label required>날짜</Label>
              {/*
                요일 칩. `select` 보다 칩이 나은 이유는 **요일이 먼저 읽혀야** 하기
                때문이다 — 사람은 "며칠"이 아니라 "무슨 요일"로 약속을 잡는다.
              */}
              <ul className="flex flex-wrap gap-1.5">
                {dayRows.map((row) => {
                  const active = row.dayKey === dayKey;
                  return (
                    <li key={row.dayKey}>
                      <button
                        type="button"
                        onClick={() => setDayKey(row.dayKey)}
                        aria-pressed={active}
                        className={cn(
                          "flex flex-col items-center rounded-md border px-3 py-1.5 transition duration-200",
                          active
                            ? "border-primary bg-primary-subtle"
                            : "border-border bg-surface hover:bg-hover-strong",
                        )}
                      >
                        <span
                          className={cn(
                            "text-body-sm font-bold",
                            active ? "text-primary" : "text-ink",
                          )}
                        >
                          {row.weekdayLabel}
                        </span>
                        <span className="text-caption tabular-nums text-ink-muted">
                          {row.dateLabel}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={timeId} required>
                  시작 시각
                </Label>
                <Input
                  id={timeId}
                  type="time"
                  value={timeText}
                  onChange={(event) => setTimeText(event.target.value)}
                  autoFocus
                />
                {startMinutes === null ? (
                  <HelperText tone="error">
                    24시간 형식으로 입력해 주세요 (예: 21:00).
                  </HelperText>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={durationId} required>
                  보스당 소요 시간(분)
                </Label>
                <Input
                  id={durationId}
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={600}
                  value={durationText}
                  onChange={(event) => setDurationText(event.target.value)}
                />
                {durationValid ? (
                  <HelperText>
                    보스가 여러 개면 이 간격으로 <strong className="font-semibold">차례로</strong> 잡힙니다.
                  </HelperText>
                ) : (
                  <HelperText tone="error">5~600분 사이여야 합니다.</HelperText>
                )}
              </div>
            </div>

            {/*
              고정팟 — **이제 진짜로 저장된다**(머리말). 몇 주치인지 숫자로 말해 주는 것이
              중요하다: "매주"라고만 적으면 영원히 잡히는 것으로 읽히는데, 실제로는 그
              기간이 지나면 다시 등록해야 한다.
            */}
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <Checkbox
                checked={isFixedParty}
                onChange={(event) => setIsFixedParty(event.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-sm font-semibold text-ink">
                  고정팟 — 매주 같은 시간
                </span>
                <span className="text-body-sm text-ink-muted">
                  이번 주를 포함해{" "}
                  <strong className="font-semibold tabular-nums text-ink">
                    {FIXED_PARTY_WEEKS}주치
                  </strong>
                  가 한 번에 등록됩니다. 못 가는 주는 그 주 일정에서 빠지면 됩니다.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {/* ── 2. 보스 ───────────────────────────────────────────────────── */}
        {step === 1 ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={searchId}>
                보스 <span className="text-ink-muted">(여러 개 선택 가능)</span>
              </Label>
              <div className="relative">
                <Search
                  aria-hidden
                  size={16}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
                />
                <Input
                  id={searchId}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="이름 또는 별칭 — 하카, 하스우, 익세"
                  className="pl-9"
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto pr-1">
              <BossGroup
                title="이 파티가 도는 보스"
                icon={<Swords aria-hidden size={13} className="text-primary" />}
                entries={groups.party}
                selected={bossIds}
                onToggle={toggleBoss}
                emptyHint="파티 관리에서 보스를 등록해 두면 여기서 체크만 하면 됩니다."
              />
              <BossGroup
                title="이 캐릭터가 매주 가는 보스"
                entries={groups.planned}
                selected={bossIds}
                onToggle={toggleBoss}
                emptyHint={null}
              />
              <BossGroup
                title="검색 결과"
                entries={groups.rest}
                selected={bossIds}
                onToggle={toggleBoss}
                emptyHint={
                  normalizedQuery === ""
                    ? "위 칸에 이름을 적으면 전체 보스에서 찾습니다."
                    : null
                }
              />
            </div>

            {orderedSelection.length > 0 && startMinutes !== null ? (
              <div className="rounded-md bg-neutral-100 px-3 py-2">
                <p className="text-caption text-ink-label">고른 차례대로 배치됩니다</p>
                <ol className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {orderedSelection.map((entry, index) => (
                    <li
                      key={entry.bossDifficultyId}
                      className="text-body-sm text-ink"
                    >
                      <span className="tabular-nums text-ink-muted">
                        {formatDayMinute(startMinutes + durationMinutes * index)}
                      </span>{" "}
                      {entry.shortName}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── 3. 참여자 ─────────────────────────────────────────────────── */}
        {step === 2 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label required>
                <span className="inline-flex items-center gap-1.5">
                  <Users aria-hidden size={14} className="text-primary" />
                  참여자
                </span>
              </Label>
              {members.length === 0 ? (
                <HelperText tone="error">
                  파티에 사람이 없습니다. 파티 관리에서 먼저 구성원을 넣어 주세요.
                </HelperText>
              ) : (
                <ul className="flex flex-col gap-1">
                  {members.map((member) => {
                    const checked = !excluded.has(member.personId);
                    return (
                      <li key={member.personId}>
                        <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2">
                          <Checkbox
                            checked={checked}
                            onChange={() => {
                              setExcluded((current) => {
                                const next = new Set(current);
                                if (next.has(member.personId)) {
                                  next.delete(member.personId);
                                } else {
                                  next.add(member.personId);
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="w-5 shrink-0 text-caption tabular-nums text-ink-muted">
                            {member.seatNo}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                            {participantLabel(member)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <HelperText>
                체크한 인원이 그대로{" "}
                <strong className="font-semibold">결정석 1/n 의 분모</strong>가
                됩니다(§1.3 D3).
              </HelperText>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label required>내가 데려갈 캐릭터</Label>
              {characters.length === 0 ? (
                <HelperText tone="error">
                  추적 중인 캐릭터가 없습니다. 설정에서 캐릭터를 먼저 골라 주세요.
                </HelperText>
              ) : (
                <select
                  value={characterId ?? ""}
                  onChange={(event) => onCharacterIdChange(event.target.value)}
                  className="h-10 rounded-md border border-border bg-surface px-3 text-body-sm text-ink"
                >
                  <option value="" disabled>
                    캐릭터 선택
                  </option>
                  {characters.map((entry) => (
                    <option key={entry.characterId} value={entry.characterId}>
                      {entry.name}
                      {entry.isMain ? " (본캐)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <HelperText>
                주간 결정석 12칸이 <strong className="font-semibold">캐릭터당</strong>이라
                캐릭터 없이는 수익이 집계되지 않습니다.
              </HelperText>
            </div>

            {/* 예상 수익 — 미확인 가격은 0 으로 더하지 않는다(§1.3 D4). */}
            {orderedSelection.length > 0 && partySize > 0 ? (
              <p className="rounded-md bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
                예상 결정석{" "}
                <strong className="font-semibold tabular-nums text-ink">
                  {income.known.toLocaleString("ko-KR")}
                </strong>{" "}
                메소 / 1인
                {income.unknown > 0 ? (
                  <span className="text-ink-muted">
                    {" "}
                    (가격 미확인 {income.unknown}건 제외)
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}

        {submitError ? (
          <ErrorState
            title="일정을 등록하지 못했습니다"
            detail={submitError.message}
            className="py-6"
          />
        ) : null}
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const STEP_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "언제 갈지 정합니다. 매주 같은 시간이면 고정팟을 켜세요.",
  1: "무엇을 잡을지 고릅니다. 고른 차례대로 이어서 배치됩니다.",
  2: "누가 갈지 정합니다. 인원수가 결정석 분배의 분모입니다.",
};

function initialDayKey(at: Date | null, dayRows: readonly DayRow[]): string {
  if (at !== null) {
    const key = kstDayKeyOf(at);
    if (dayRows.some((row) => row.dayKey === key)) return key;
  }
  return dayRows[0]?.dayKey ?? "";
}

function initialTime(at: Date | null): string {
  if (at === null) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

function kstDayKeyOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function dayLabel(dayKey: string, dayRows: readonly DayRow[]): string {
  const row = dayRows.find((entry) => entry.dayKey === dayKey);
  return row === undefined ? dayKey : row.label;
}

interface BossGroupProps {
  readonly title: string;
  readonly icon?: React.ReactNode;
  readonly entries: readonly BossCatalogEntry[];
  readonly selected: readonly BossDifficultyId[];
  readonly onToggle: (id: BossDifficultyId) => void;
  /** 비었을 때 보여 줄 문장. `null` 이면 묶음 자체를 그리지 않는다. */
  readonly emptyHint: string | null;
}

function BossGroup({
  title,
  icon,
  entries,
  selected,
  onToggle,
  emptyHint,
}: BossGroupProps) {
  if (entries.length === 0 && emptyHint === null) return null;

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="inline-flex items-center gap-1.5 text-overline uppercase text-ink-muted">
        {icon}
        {title}
      </h3>
      {entries.length === 0 ? (
        <p className="text-body-sm text-ink-muted">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => {
            const checked = selected.includes(entry.bossDifficultyId);
            const order = selected.indexOf(entry.bossDifficultyId);
            return (
              <li key={entry.bossDifficultyId}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md border border-l-4 bg-surface px-3 py-2 transition duration-200",
                    BOSS_DIFFICULTY_BORDER_L[entry.difficulty],
                    checked
                      ? "border-primary bg-primary-subtle"
                      : "border-border hover:bg-hover-strong",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onChange={() => onToggle(entry.bossDifficultyId)}
                  />
                  <BossIcon
                    bossDifficultyId={entry.bossDifficultyId}
                    difficulty={entry.difficulty}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                    {entry.koreanName}
                  </span>
                  {/*
                    고른 차례를 숫자로 보여 준다 — 배치 순서가 곧 이 순서라(§1.4 번호 규칙과
                    같은 취지), 체크만으로는 "몇 번째로 가는지"를 알 수 없다.
                  */}
                  {checked ? (
                    <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-overline font-bold tabular-nums text-white">
                      {order + 1}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
