"use client";

import { Clock, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  Button,
  Card,
  CardTitle,
  Input,
  Label,
  NO_NATIVE_SPINNER,
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
  Skeleton,
  StepButton,
} from "@/components/ui";
import {
  bossMinutesFromPlans,
  characterBossMinutes,
  distributeByRatio,
  formatApproxDuration,
  summarizeCharacterDurations,
  type CharacterDurationSummary,
} from "@/lib/domain/boss-duration-distribute";
import { cn } from "@/lib/utils";

import type { CharacterBossPlan, CharacterChecklist } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `/boss-plans` 맨 위 — **캐릭터별 총 진행 시간** + **총 시간을 넣으면 나눠 주기**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-10-21): *"총 진행 시간도 맨위에 뜨게 바꾸고 … 아예 총 진행시간을 입력하면
 * 알아서 분배해주는 기능을 넣어주던가"*.
 *
 * ★ **숫자는 `!숙제` 와 같은 규칙으로 센다** — `summarizeCharacterDurations`
 *   (`@/lib/domain/boss-duration-distribute` 머리말 1절: 켜짐 ∧ 주간·시즌 ∧ 시세를 앎).
 *   "남음"의 전체 합은 `!숙제` 의 `약 N시간` 과 같은 값이다(추적 캐릭터 명단이 같다 —
 *   체크리스트는 추적 중·사라지지 않은 캐릭터만 싣는다). 월간(검은 마법사)은 빠진다.
 * ★ **선택된 캐릭터는 계획 쿼리의 값으로** 센다. 그 쿼리가 낙관적 갱신을 받으므로, 아래
 *   목록에서 한 보스의 분을 고치거나 나누기를 저장하는 즉시 맨 위 숫자가 따라온다. 나머지
 *   캐릭터는 체크리스트(무효화로 갱신)에서 센다.
 * ★ 나누기의 비율은 **본캐 배율의 역수**다(사람이 고친 값이 아니다 — 그 파일 머리말 2절).
 * ★ 숫자는 **각 줄의 인원으로 친 시간**이다(줄의 인원 칸 — 1 이면 솔로). 사람이 넣지 않은 보스는
 *   그 캐릭터의 다른 값으로 읽은 세기 k 로 보정된 추정이라, 보스 하나만 넣어도 총·남음이
 *   함께 움직인다(`boss-duration-estimate` 머리말 3절).
 *   저장 전에 "지금 → 새 값" 미리보기를 보여 주고, 사람이 고친 값도 덮어쓴다는 사실을
 *   그 미리보기가 말한다.
 */

export interface DurationOverviewProps {
  /** 추적 캐릭터 전원(체크리스트 쿼리). 비어 있으면 부르는 쪽이 이미 빈 상태를 그린다. */
  readonly checklist: readonly CharacterChecklist[];
  readonly selectedId: string | null;
  /** 선택 캐릭터의 계획(계획 쿼리 — 낙관적 값 포함). 아직 없으면 `undefined`. */
  readonly selectedPlans: readonly CharacterBossPlan[] | undefined;
  readonly selectedPlansLoading: boolean;
  readonly selectedPlansError: boolean;
  readonly onSelect: (characterId: string) => void;
  /** 나눈 결과 저장. 바뀌는 보스만 넘어온다. */
  readonly onSave: (
    characterId: string,
    items: readonly { bossDifficultyId: string; durationMinutes: number }[],
  ) => void;
  readonly isSaving: boolean;
  /** 마지막 저장 실패 문구(서버 문구 그대로). 없으면 `null`. */
  readonly saveError: string | null;
}

export function DurationOverview({
  checklist,
  selectedId,
  selectedPlans,
  selectedPlansLoading,
  selectedPlansError,
  onSelect,
  onSave,
  isSaving,
  saveError,
}: DurationOverviewProps) {
  const rows = useMemo(
    () =>
      checklist.map((entry) => {
        const isSelected = entry.character.characterId === selectedId;
        /*
          ★ 총/남음의 모집단은 **켜진 계획**이고, 세기 k 의 모집단은 **모든 사람 값**(꺼 둔 것
            포함)이다 — 봇 `!숙제`·서버 런 생성과 같은 범위. 선택 캐릭터는 계획 쿼리(꺼 둔 것까지
            싣는다, 낙관적 값 포함)에서, 나머지는 체크리스트의 `bossMinutes` 에서 읽는다.
        */
        const useSelected = isSelected && selectedPlans !== undefined;
        const plans = useSelected
          ? selectedPlans.filter((plan) => plan.isActive)
          : entry.planned;
        const allBossMinutes = useSelected
          ? bossMinutesFromPlans(selectedPlans)
          : entry.bossMinutes;
        return {
          character: entry.character,
          isSelected,
          summary: summarizeCharacterDurations(plans, undefined, allBossMinutes),
        };
      }),
    [checklist, selectedId, selectedPlans],
  );

  const overall = rows.reduce(
    (sum, row) => ({
      total: sum.total + row.summary.totalMinutes,
      remaining: sum.remaining + row.summary.remainingMinutes,
    }),
    { total: 0, remaining: 0 },
  );

  const selectedRow = rows.find((row) => row.isSelected) ?? null;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <CardTitle className="flex items-center gap-2 text-body-lg">
          <Clock aria-hidden size={18} className="text-primary" />
          총 진행 시간
        </CardTitle>
        <p className="text-body-sm text-ink-muted tabular-nums">
          전체 남음{" "}
          <strong className="font-semibold text-ink">
            {formatApproxDuration(overall.remaining)}
          </strong>{" "}
          · 총 {formatApproxDuration(overall.total)}
        </p>
      </div>
      <p className="text-body-sm text-ink-muted">
        켜 둔 주간·시즌 보스의 소요 시간 합입니다(월간 제외). 보스마다 그 줄의 인원으로 친
        시간이고, 비워 둔 보스는 직접 넣은 보스(10분 이상)로 이 캐릭터의 세기를 읽어
        추정합니다. 남음은 이번 주 아직 안 잡은
        보스만 센 값으로, 카톡 <span className="font-mono">!숙제</span> 의 남은 시간과 같은
        계산입니다.
      </p>

      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li key={row.character.characterId} className="min-w-0">
            <button
              type="button"
              aria-pressed={row.isSelected}
              onClick={() => onSelect(row.character.characterId)}
              className={cn(
                "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left",
                "transition duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                row.isSelected
                  ? "border-primary bg-primary-subtle"
                  : "border-border bg-background hover:bg-hover-surface",
              )}
            >
              <span className="w-full truncate text-body-sm font-semibold text-ink">
                {row.character.name}
                {row.character.isMain ? " · 본캐" : ""}
              </span>
              {row.summary.count === 0 ? (
                <span className="text-body-sm text-ink-muted">켜 둔 주간 보스 없음</span>
              ) : (
                <span className="text-body-sm text-ink-muted tabular-nums">
                  남음{" "}
                  <span className="font-semibold text-ink">
                    {formatApproxDuration(row.summary.remainingMinutes)}
                  </span>{" "}
                  · 총 {formatApproxDuration(row.summary.totalMinutes)} ·{" "}
                  {row.summary.count}개
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {selectedRow === null ? null : selectedPlansError ? (
        <p role="alert" className="text-body-sm text-ink">
          {selectedRow.character.name} 의 보스 계획을 불러오지 못해 나누기를 쓸 수 없습니다.
          아래 목록에서 다시 시도해 주세요.
        </p>
      ) : selectedPlansLoading || selectedPlans === undefined ? (
        <Skeleton className="h-24" />
      ) : (
        /* 캐릭터가 바뀌면 칸·미리보기를 새로 시작한다 — 다른 캐릭터의 초안을 물고 있지 않게. */
        <DistributeForm
          key={selectedRow.character.characterId}
          characterId={selectedRow.character.characterId}
          characterName={selectedRow.character.name}
          plans={selectedPlans}
          summary={selectedRow.summary}
          onSave={onSave}
          isSaving={isSaving}
          saveError={saveError}
        />
      )}
    </Card>
  );
}

/** −/+ 한 걸음(분). 총 시간은 수십~수백 분이라 5분 단위가 손에 맞다. 타이핑은 1분 단위. */
const TOTAL_STEP_MINUTES = 5;

interface DistributeFormProps {
  readonly characterId: string;
  readonly characterName: string;
  readonly plans: readonly CharacterBossPlan[];
  readonly summary: CharacterDurationSummary;
  readonly onSave: DurationOverviewProps["onSave"];
  readonly isSaving: boolean;
  readonly saveError: string | null;
}

function DistributeForm({
  characterId,
  characterName,
  plans,
  summary,
  onSave,
  isSaving,
  saveError,
}: DistributeFormProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [draft, setDraft] = useState("");

  const count = summary.count;
  const minTotal = count * RUN_DURATION_MIN;
  const maxTotal = count * RUN_DURATION_MAX;

  if (count === 0) {
    return (
      <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink-muted">
        {characterName} 에게 켜 둔 주간·시즌 보스가 없어 나눌 시간이 없습니다. 아래에서
        보스를 켜거나 추가하면 여기서 총 시간을 나눌 수 있습니다.
      </p>
    );
  }

  const trimmed = draft.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
  const planById = new Map(plans.map((plan) => [plan.bossDifficultyId, plan]));
  // 무게 = 1/(그 줄의 인원 × 본캐 배율) — 3인 줄은 그만큼 짧게 받는다.
  const result =
    parsed === null
      ? null
      : distributeByRatio(
          summary.bossDifficultyIds,
          parsed,
          (id) => planById.get(id)?.defaultPartySize ?? 1,
        );
  const bossMinutes = bossMinutesFromPlans(plans);
  const preview =
    result?.kind === "exact"
      ? summary.bossDifficultyIds.flatMap((id) => {
          const plan = planById.get(id);
          const next = result.minutes.get(id);
          if (plan === undefined || next === undefined) return [];
          return [
            {
              id,
              name: plan.bossDisplayName,
              current: characterBossMinutes(id, bossMinutes, plan.defaultPartySize),
              isCustom: plan.durationMinutes !== null,
              next,
              // 저장할 것: 저장된 값과 다를 때만(기본값을 따르던 칸은 숫자로 굳는다).
              willWrite: plan.durationMinutes !== next,
            },
          ];
        })
      : [];
  const writes = preview.filter((row) => row.willWrite);

  /** −/+ 가 밟고 설 값. 빈 칸·잘못된 값이면 지금 총에서 출발한다. */
  const current = parsed ?? summary.totalMinutes;
  const clampTotal = (value: number) => Math.min(maxTotal, Math.max(minTotal, value));
  const downTo = clampTotal(current - TOTAL_STEP_MINUTES);
  const upTo = clampTotal(current + TOTAL_STEP_MINUTES);

  const problem =
    trimmed === ""
      ? null
      : parsed === null || result === null || result.kind === "invalid"
        ? parsed !== null && parsed >= 1
          ? `보스 ${String(count)}개라 총 ${String(minTotal)}~${String(maxTotal)}분(${formatApproxDuration(minTotal)}~${formatApproxDuration(maxTotal)}) 사이로 넣어 주세요. 보스 한 판은 ${String(RUN_DURATION_MIN)}~${String(RUN_DURATION_MAX)}분입니다.`
          : "1 이상의 정수(분)로 넣어 주세요."
        : null;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={inputId}>{characterName} · 총 진행 시간으로 나누기</Label>
        <p id={hintId} className="text-body-sm text-ink-muted">
          총 시간(분)을 넣으면 보스 {count}개에 보스별 체력 배율의 비율대로(어려운 보스일수록
          길게, 인원이 많은 줄일수록 짧게) 나눕니다. 지금 합은 {summary.totalMinutes}분(
          {formatApproxDuration(summary.totalMinutes)})이고, 넣을 수 있는 범위는{" "}
          {minTotal}~{maxTotal}분입니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1">
          <StepButton
            direction="down"
            onClick={() => setDraft(String(downTo))}
            disabled={isSaving || current <= minTotal}
            aria-label={`총 진행 시간 ${String(downTo)}분으로 줄이기`}
          />
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={minTotal}
            max={maxTotal}
            step={1}
            value={draft}
            placeholder={String(summary.totalMinutes)}
            invalid={problem !== null}
            disabled={isSaving}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            className={cn(
              "h-control-sm w-20 px-1.5 py-1 text-center tabular-nums",
              NO_NATIVE_SPINNER,
            )}
          />
          <StepButton
            direction="up"
            onClick={() => setDraft(String(upTo))}
            disabled={isSaving || current >= maxTotal}
            aria-label={`총 진행 시간 ${String(upTo)}분으로 늘리기`}
          />
          <span className="shrink-0 text-caption text-ink-muted">분</span>
        </span>
        {parsed !== null && problem === null ? (
          <span className="text-body-sm text-ink-muted tabular-nums">
            = {formatApproxDuration(parsed)}
          </span>
        ) : null}
      </div>

      {problem === null ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink"
        >
          <TriangleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-tertiary" />
          <span>{problem}</span>
        </p>
      )}

      {preview.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-ink-muted">
            미리보기 — 합 {result?.kind === "exact" ? result.total : 0}분. 저장하면 직접 고쳐 둔
            값도 이 값으로 바뀝니다.
          </p>
          <ul className="flex flex-col gap-1">
            {preview.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface px-2.5 py-1.5"
              >
                <span className="min-w-0 truncate text-body-sm text-ink">{row.name}</span>
                <span className="text-body-sm text-ink-muted tabular-nums">
                  {row.current}분{row.isCustom ? "(직접)" : "(추정)"} →{" "}
                  <strong
                    className={cn(
                      "font-semibold",
                      row.next === row.current ? "text-ink-muted" : "text-ink",
                    )}
                  >
                    {row.next}분
                  </strong>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={isSaving || writes.length === 0}
              onClick={() => {
                onSave(
                  characterId,
                  writes.map((row) => ({
                    bossDifficultyId: row.id,
                    durationMinutes: row.next,
                  })),
                );
                // 낙관적 갱신이 목록과 맨 위 숫자를 바로 바꾼다 — 초안은 비운다.
                setDraft("");
              }}
            >
              {isSaving ? "저장 중…" : "이대로 저장"}
            </Button>
            <Button size="sm" variant="ghost" disabled={isSaving} onClick={() => setDraft("")}>
              취소
            </Button>
            {writes.length === 0 ? (
              <span className="text-body-sm text-ink-muted">지금 저장된 값과 같습니다.</span>
            ) : null}
          </div>
        </div>
      )}

      {saveError === null ? null : (
        <p role="alert" className="text-body-sm text-error">
          {saveError}
        </p>
      )}
    </div>
  );
}
