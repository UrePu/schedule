"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useId } from "react";

import { BOSS_DIFFICULTY_BORDER_L, MesoAmount } from "@/components/domain";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearRecord, IncomeCharacterOption } from "../types";
import { CharacterSelect } from "./character-select";
import { BossIconSlot, DifficultyChip } from "./difficulty-chip";
import { PartySizeField } from "./party-size-field";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 수정 모달의 한 행 — 보스 · 난이도 · 캐릭터 · 인원 · 내 몫이 **한 줄에**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 레퍼런스 계산기에서 가져온 것은 이 **조밀한 매트릭스**다. 보스마다 카드 한 장을
 * 쌓으면 12줄이 화면 세 개가 되고, 그게 발주자가 "난잡하다"고 한 상태였다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 가져오지 **않은** 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 레퍼런스는 *계획 계산기*라 "이 보스들을 이 인원으로 돌면 얼마"를 **추정**한다.
 * 이 화면은 **이미 일어난 클리어의 원장**이다. 두 개념을 섞으면 사용자는 자기가 보는
 * 숫자가 예상인지 실적인지 모르게 된다. 그래서 여기에는 체크박스로 보스를 켜고 끄는
 * 기능이 없다 — 켜고 끄는 것(클리어 체크)은 모달 밖 일정 목록의 일이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 열 순서 = **손대는 빈도** 순
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터(주 조작) → 인원(가끔) → 내 몫(읽기 전용 결과). 캐릭터는 주마다 바뀌지만
 * 인원은 한 번 맞추면 그 판에 대해 끝나고, 금액은 애초에 우리가 정하는 값이 아니다.
 *
 * ⚠️ **이 행은 숫자를 만들지 않는다.** `내 몫` 은 `boss_clears.crystal_share_meso`
 *    스냅샷 그대로다. 인원을 고치면 서버가 트리거를 다시 돌려 새 값을 주고 화면은 받아
 *    적는다. 캐릭터를 바꾸면 금액은 **아예 움직이지 않는다** — 분배는 사람 단위라
 *    내 캐릭터끼리 옮기는 것은 몫을 바꾸지 않고 12개 카운터의 주인만 바꾼다.
 * ⚠️ 난이도는 **좌측 보더 + 칩**이고(§4), 상태(미확인·초과)는 보더를 덮지 않고 배지와
 *    문장이 담당한다. 채널을 섞으면 둘 다 못 읽는다.
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
};

/**
 * 헤더와 행이 **같은 격자**를 쓴다. 한 곳에서만 정의해야 열이 어긋나지 않는다.
 * 좁은 화면(< 640px)에서는 한 줄에 다 넣을 수 없어 세로로 쌓는다.
 */
export const CLEAR_EDIT_GRID =
  "grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-[2rem_minmax(0,1fr)_10rem_4.5rem_auto] sm:items-center";

export interface ClearEditRowProps {
  readonly clear: ClearRecord;
  readonly options: readonly IncomeCharacterOption[];
  readonly isPending: boolean;
  readonly onPartySizeChange: (clearId: string, partySize: number) => void;
  readonly onCharacterChange: (clearId: string, characterId: string) => void;
}

export function ClearEditRow({
  clear,
  options,
  isPending,
  onPartySizeChange,
  onCharacterChange,
}: ClearEditRowProps) {
  const baseId = useId();
  const characterId = `${baseId}-character`;
  const partySizeId = `${baseId}-party-size`;
  const noteId = `${baseId}-note`;

  const notes: string[] = [];
  if (clear.partySizeUnconfirmed) {
    notes.push(
      "넥슨 API 에는 파티 정보가 없어 이 기록의 인원은 아무도 확인한 적이 없습니다. 지금 값이 기본값 1명이라면 파티로 돌았을 때 수익이 최대 6배로 잡혀 있습니다.",
    );
  }
  if (clear.overMaxParty && clear.maxParty !== null) {
    notes.push(
      `이 보스에 확인된 최대 인원은 ${clear.maxParty}명입니다. 값은 그대로 저장되지만 수익이 실제보다 작게 잡힐 수 있으니 한 번 확인해 주세요.`,
    );
  }
  if (clear.shareMeso === null) {
    notes.push(
      "이 보스의 결정석 가격이 아직 확인되지 않았습니다. 합계에서 제외했으며 0 으로 더하지 않습니다.",
    );
  }

  return (
    <li
      className={cn(
        CLEAR_EDIT_GRID,
        "rounded-md border border-l-4 border-border bg-surface px-3 py-2.5",
        BOSS_DIFFICULTY_BORDER_L[clear.difficulty],
        isPending && "opacity-60",
      )}
    >
      {/* ① 보스 아이콘 자리 — 에셋이 생기기 전까지 난이도 색이 채운다. */}
      <div className="hidden sm:block">
        <BossIconSlot difficulty={clear.difficulty} />
      </div>

      {/* ② 보스 이름 + 난이도 칩 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="sm:hidden">
          <BossIconSlot difficulty={clear.difficulty} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태다(난이도 포함). */}
          <span className="truncate text-body-sm font-semibold text-ink">
            {clear.bossDisplayName}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <DifficultyChip difficulty={clear.difficulty} />
            <span className="text-caption text-ink-muted">
              {clear.cycle === null ? "주기 미상" : CYCLE_LABEL[clear.cycle]}
              {clear.countsTowardWeeklyLimit ? "" : " · 12 카운터 제외"}
            </span>
          </span>
        </div>
      </div>

      {/* ③ 캐릭터 — 행의 주 조작 */}
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={characterId}
          className="text-caption text-ink-muted sm:sr-only"
        >
          캐릭터
        </label>
        <CharacterSelect
          id={characterId}
          characterId={clear.characterId}
          characterName={clear.characterName}
          options={options}
          disabled={isPending}
          onChange={(next) => onCharacterChange(clear.clearId, next)}
        />
      </div>

      {/* ④ 입장 인원 — 보조 입력. 미확인이면 아래 배지가 눈에 띈다. */}
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={partySizeId}
          className="text-caption text-ink-muted sm:sr-only"
        >
          입장 인원
        </label>
        <PartySizeField
          /* 저장이 끝나 새 값이 내려오면 입력칸도 그 값으로 다시 시작한다. */
          key={`${clear.clearId}-${clear.partySize}`}
          id={partySizeId}
          partySize={clear.partySize}
          disabled={isPending}
          aria-describedby={notes.length > 0 ? noteId : undefined}
          onSubmit={(next) => onPartySizeChange(clear.clearId, next)}
        />
        {/*
          확인 상태를 **행에서 바로** 보여 준다. 인원을 고치면 `set_clear_party_size()` 가
          `party_size_confirmed` 를 올리므로, 저장 직후 이 배지가 "확인 필요"에서
          "확인됨"으로 바뀐다 — 사용자가 자기 조작의 결과를 화면에서 확인할 수 있다.
        */}
        {clear.partySizeUnconfirmed ? (
          <span className="inline-flex items-center gap-1 text-caption text-ink">
            <TriangleAlert aria-hidden size={12} className="shrink-0 text-tertiary" />
            확인 필요
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
            <CircleCheck aria-hidden size={12} className="shrink-0 text-success" />
            확인됨
          </span>
        )}
      </div>

      {/* ⑤ 내 몫 — 읽기 전용. DB 스냅샷을 그대로 옮긴다. */}
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span className="text-caption text-ink-muted sm:sr-only">내 몫</span>
        <MesoAmount
          value={clear.shareMeso}
          compact
          suffix={false}
          tone="accent"
          className="text-body-sm font-semibold"
        />
      </div>

      {/*
        경고는 격자 밖 전체 폭에 둔다. 열 안에 넣으면 열 폭이 문장에 끌려다니고,
        문장 하한이 14px 이라(§4) 좁은 칸에서 두세 줄로 접힌다.
        색은 **tertiary orange** 다 — red 는 실패·취소 전용(§4).
      */}
      {notes.length > 0 ? (
        <ul id={noteId} className="flex flex-col gap-1.5 sm:col-span-5">
          {notes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2.5 py-1.5 text-body-sm text-ink"
            >
              <TriangleAlert
                aria-hidden
                size={14}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
