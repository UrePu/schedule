"use client";

import { Scale } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";
import {
  bossMinutesFromPlans,
  characterBossMinutes,
} from "@/lib/domain/boss-duration-distribute";
import { estimateCharacterDurations } from "@/lib/domain/boss-duration-estimate";
import { cn } from "@/lib/utils";

import type { CharacterBossPlan } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "나머지 보스도 이 기준으로 맞추기" — 캐릭터 **솔로** 값 하나 → 그 캐릭터의 나머지
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-10-21): *"부캐일때 어느 한 보스가 15분 걸리면 다른보스들 쫙 계산 가능하지?"*
 * 계산은 `estimateCharacterDurations`(`@/lib/domain/boss-duration-estimate` 머리말 5절):
 *     분(보스) = 넣은 분 × 본캐 배율(기준 보스) / 본캐 배율(보스) → 반올림 → 1~20
 *
 * ★ **명시적 동작이다.** 사람이 고쳐 둔 다른 보스의 값을 덮어쓰므로 묻지 않고 덮지 않는다:
 *   분을 고친 직후 그 줄 바로 아래 한 줄이 뜨고 → "미리보기"(지금 → 새 값) → "이대로 저장".
 *   저장은 총 시간 나누기와 **같은 경로**(`PUT /api/boss-plans/duration/bulk`)다.
 * ★ 이 캐릭터의 **솔로** 값만 바꾼다. 파티 묶음의 분은 건드리지 않는다 — 파티에서 고친 분은
 *   전파하지 않는다(돌먹, 같은 파일 머리말 5절).
 * ★ 기준 줄이 10~19분일 때만 뜬다(머리말 3절 — 짧으면 고정 시간에 묻혀 배율을 못 읽고,
 *   20은 상한이라 "20분 이상"일 수 있다). 부르는 쪽이 그 조건을 거른다.
 * ★ 대상은 이 캐릭터의 **켜진** 보스다(꺼 둔 보스는 목록에서 빠진 것이라 건드리지 않는다).
 *   배율을 모르는 보스(시세 미확인)는 그대로 두고 그 수를 말한다.
 * ★ 저장하지 않아도 화면 숫자는 이미 움직였다 — 비워 둔 보스의 흐린 숫자는 캐릭터 세기 k
 *   로 보정된다(머리말 3절). 이 동작이 하는 일은 **직접 넣어 둔 다른 값까지** 이 기준으로
 *   맞추는 것이다. 그래서 미리보기는 바뀌는 줄만 진하게 적는다.
 */

export interface DurationAnchorFillProps {
  readonly characterName: string;
  /** 그 캐릭터의 계획 전부(꺼 둔 것 포함 — k 와 "지금" 값을 같은 모집단에서 읽는다). */
  readonly plans: readonly CharacterBossPlan[];
  readonly anchor: {
    readonly bossDifficultyId: string;
    readonly bossDisplayName: string;
    readonly minutes: number;
  };
  /** 바뀌는 보스만 넘어온다. */
  readonly onSave: (
    items: readonly { bossDifficultyId: string; durationMinutes: number }[],
  ) => void;
  readonly onDismiss: () => void;
  readonly isSaving: boolean;
  /** 이 동작의 마지막 저장 실패 문구. 없으면 `null`. */
  readonly saveError: string | null;
}

export function DurationAnchorFill({
  characterName,
  plans,
  anchor,
  onSave,
  onDismiss,
  isSaving,
  saveError,
}: DurationAnchorFillProps) {
  const [expanded, setExpanded] = useState(false);

  const targets = plans.filter(
    (plan) => plan.isActive && plan.bossDifficultyId !== anchor.bossDifficultyId,
  );
  const result = estimateCharacterDurations(
    targets.map((plan) => plan.bossDifficultyId),
    anchor.bossDifficultyId,
    anchor.minutes,
  );
  // 부르는 쪽이 10~19분만 넘기므로 닿지 않는다. 닿으면 할 말이 없다.
  if (result.kind !== "applied") return null;

  const bossMinutes = bossMinutesFromPlans(plans);
  const preview = targets.flatMap((plan) => {
    const next = result.minutes.get(plan.bossDifficultyId);
    if (next === undefined) return [];
    return [
      {
        id: plan.bossDifficultyId,
        name: plan.bossDisplayName,
        current: characterBossMinutes(plan.bossDifficultyId, bossMinutes),
        isCustom: plan.durationMinutes !== null,
        next,
        // 저장할 것: 저장된 값과 다를 때만(추정을 따르던 칸은 숫자로 굳는다).
        willWrite: plan.durationMinutes !== next,
      },
    ];
  });
  const writes = preview.filter((row) => row.willWrite);
  const strengthText = result.strength.toFixed(2);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-background px-3 py-2">
      <p className="flex items-start gap-2 text-body-sm text-ink">
        <Scale aria-hidden size={16} className="mt-0.5 shrink-0 text-primary" />
        <span>
          {anchor.bossDisplayName} 솔로 {anchor.minutes}분 기준이면 {characterName} 은(는)
          본캐 배율의 약 <strong className="font-semibold tabular-nums">{strengthText}배</strong>
          입니다. 나머지 보스 {preview.length}개도 이 기준으로 맞출까요?
          {result.unknownIds.length > 0
            ? ` 배율을 모르는 ${String(result.unknownIds.length)}개는 그대로 둡니다.`
            : ""}
        </span>
      </p>

      {expanded ? (
        <>
          <p className="text-body-sm text-ink-muted">
            미리보기 — 저장하면 직접 고쳐 둔 값도 이 값으로 바뀝니다. 파티 묶음에 정해 둔
            분은 바뀌지 않습니다.
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
                      row.willWrite ? "text-ink" : "text-ink-muted",
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
              onClick={() =>
                onSave(
                  writes.map((row) => ({
                    bossDifficultyId: row.id,
                    durationMinutes: row.next,
                  })),
                )
              }
            >
              {isSaving ? "저장 중…" : `이대로 저장(${String(writes.length)}개)`}
            </Button>
            <Button size="sm" variant="ghost" disabled={isSaving} onClick={onDismiss}>
              취소
            </Button>
            {writes.length === 0 ? (
              <span className="text-body-sm text-ink-muted">지금 저장된 값과 같습니다.</span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={preview.length === 0}
            onClick={() => setExpanded(true)}
          >
            나머지 보스도 이 기준으로 맞추기
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            닫기
          </Button>
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
