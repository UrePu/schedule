"use client";

import { CalendarX2 } from "lucide-react";
import { useMemo } from "react";

import { MesoAmount } from "@/components/domain";
import { Dialog, EmptyState, ErrorState } from "@/components/ui";

import type {
  ClearRecord,
  IncomeCharacterOption,
  LedgerDrop,
} from "../types";
import { groupClearsByCharacter } from "../lib/clear-order";
import { CLEAR_EDIT_GRID, ClearEditRow } from "./clear-edit-row";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 원장 상세 — **달력의 하루**와 **주차 한 줄**이 같은 창을 연다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 지시(2026-08-19): *"개별수정 가능하도록해"*, 그리고 날짜를 누르면
 * *"그날 상세: 보스 · 캐릭터 · 인원 · 수령액 · 드랍"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 수정 로직을 **다시 만들지 않았다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 줄의 편집기는 `ClearEditRow` 이고, 그 행은 `IncomeEditDialog`(이번 주 전체를
 * 캐릭터별로 묶어 고치는 창)가 이미 쓰고 있다. 이 창은 **행 묶음만 다르게** 준다 —
 * 하루치 또는 한 주치. 저장 경로도 같은 mutation 두 개(`set_clear_party_size` /
 * 캐릭터 재귀속)라 금액 재계산 규약이 한 벌로 유지된다.
 *
 * 캐릭터별 클리어 목록(예전 `CharacterIncomeCard`)이 화면에서 빠지면서 그쪽에 있던
 * 유일한 수정 진입점이 사라졌는데, **여기와 주차 목록이 그 자리를 대신한다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 저장 버튼이 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 칸을 고치면 그 자리에서 저장되고 서버가 다시 만든 화면이 내려온다. 모아서 저장하면
 * 창을 닫는 순간 어디까지 반영됐는지 알 수 없고, 12개 상한 경고처럼 **다른 행의 결과에
 * 달린 표시**가 저장 전까지 거짓말을 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 클리어는 **캐릭터별로 나뉘고 항상 같은 순서로** 선다 (2026-08-25 발주자)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"캐릭터별로 분리해서 정렬해서 보여주고. 보스 난이도에따라서 항상 정렬되도록"*.
 * 예전에는 서버가 준 순서(= 기록된 순서)를 그대로 그려서, 같은 하루를 두 번 열면 줄이
 * 다른 자리에 있을 수 있었다. 12개 상한이 캐릭터당이라(§1) 어차피 사람이 읽는 단위도
 * 캐릭터다.
 *
 * 순서의 근거는 `../lib/clear-order` 가 갖는다 — 캐릭터는 `options` 순서(본캐 → 레벨),
 * 보스는 `sort_order` 내림차순. 이 창이 자기 규칙을 따로 갖지 않는다.
 *
 * ⚠️ **이 창은 숫자를 만들지 않는다.** `내 몫`은 `boss_clears.crystal_share_meso`
 *    스냅샷이고 드랍의 몫은 `v_run_drop_settlement.amount_meso` 다. 캐릭터 소계도
 *    그 스냅샷의 합일 뿐이며, 가격 미확인(`null`)은 더하지 않고 따로 센다(§1.3 D4).
 */

export interface LedgerClearDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 창 제목. 하루면 `8/17 (월)`, 한 주면 `2026-W33`. */
  readonly title: string;
  readonly description: string;
  readonly clears: readonly ClearRecord[];
  readonly drops: readonly LedgerDrop[];
  readonly options: readonly IncomeCharacterOption[];
  readonly pendingClearId: string | null;
  readonly errorMessage: string | null;
  readonly onPartySizeChange: (clearId: string, partySize: number) => void;
  readonly onCharacterChange: (clearId: string, characterId: string) => void;
  /** 클리어 해제. 확인은 행이 먼저 받고 이것을 부른다. */
  readonly onRemove: (clearId: string) => void;
}

export function LedgerClearDialog({
  open,
  onClose,
  title,
  description,
  clears,
  drops,
  options,
  pendingClearId,
  errorMessage,
  onPartySizeChange,
  onCharacterChange,
  onRemove,
}: LedgerClearDialogProps) {
  const groups = useMemo(
    () => groupClearsByCharacter(clears, options),
    [clears, options],
  );

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <div className="flex flex-col gap-4">
        {errorMessage !== null ? (
          <ErrorState
            title="변경을 저장하지 못했습니다"
            detail={errorMessage}
            className="py-6"
          />
        ) : null}

        {clears.length === 0 && drops.length === 0 ? (
          /*
            빈 상태 — **오류가 아니다.** 그날/그 주에 기록이 없을 뿐이고, 그건 정상이다.
            달력은 기록이 있는 날만 누를 수 있게 만들었으므로 여기 오는 경로는 드물지만,
            응답이 갱신되는 사이에 빈 묶음이 될 수 있어 문구를 갖춰 둔다(§0.3).
          */
          <EmptyState
            icon={<CalendarX2 size={24} />}
            title="기록이 없습니다"
            description="선택한 기간에 클리어나 드랍 기록이 없습니다. 일정을 클리어로 체크하거나 인게임 스케줄러를 동기화하면 여기에 쌓입니다."
            className="py-10"
          />
        ) : null}

        {clears.length > 0 ? (
          <section className="flex flex-col gap-4">
            <h3 className="font-headline text-body font-semibold text-ink">
              클리어 {clears.length}건 · 캐릭터 {groups.length}명
            </h3>

            {groups.map((group) => (
              <div
                key={group.characterId ?? "unassigned"}
                className="flex flex-col gap-2"
              >
                {/* ── 캐릭터 머리 — 소계까지 함께. 12개 상한이 캐릭터당이라 사람이 읽는
                       단위도 캐릭터다(§1). ─────────────────────────────────── */}
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                    <h4 className="font-headline text-body-sm font-semibold text-ink">
                      {group.characterName}
                    </h4>
                    <span className="text-caption text-ink-muted">
                      {group.worldName ?? "월드 미상"} · {group.clears.length}건
                      {group.unknownPriceCount > 0
                        ? ` · 가격 미확인 ${String(group.unknownPriceCount)}건`
                        : ""}
                    </span>
                  </div>
                  <MesoAmount
                    value={group.shareMeso}
                    compact
                    suffix={false}
                    tone="accent"
                    className="text-body-sm font-semibold"
                  />
                </div>

                {/* 열 이름은 묶음마다 한 번. 좁은 화면에서는 행이 세로로 쌓이고 각 칸이
                    자기 라벨을 갖는다. */}
                <div
                  aria-hidden
                  className={`${CLEAR_EDIT_GRID} hidden px-3 text-caption text-ink-muted sm:grid`}
                >
                  <span />
                  <span>보스</span>
                  <span>캐릭터</span>
                  <span>인원</span>
                  <span className="text-right">내 몫</span>
                  <span />
                </div>

                <ul className="flex flex-col gap-1.5">
                  {group.clears.map((clear) => (
                    <ClearEditRow
                      key={clear.clearId}
                      clear={clear}
                      options={options}
                      isPending={pendingClearId === clear.clearId}
                      onPartySizeChange={onPartySizeChange}
                      onCharacterChange={onCharacterChange}
                      onRemove={onRemove}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}

        {drops.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-headline text-body font-semibold text-ink">
              드랍 {drops.length}건
            </h3>
            {/*
              읽기 전용이다. 드랍의 추가·수정·삭제는 **이번 주 일정 목록**의 드랍 창이
              맡는다 — 드랍은 특정 런에서 나오고 그 자리 사람들끼리 나누므로, 편집기는
              런 옆에 있어야 "누구랑 나누는가"를 다시 유추하지 않는다.
            */}
            <ul className="flex flex-col gap-1.5">
              {drops.map((drop) => (
                <li
                  key={drop.dropId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">
                    {drop.itemName}
                  </span>
                  <span className="shrink-0 text-caption text-ink-muted">
                    {drop.bossDisplayName ?? "일정 미상"}
                  </span>
                  <MesoAmount
                    value={drop.myShareMeso}
                    compact
                    suffix={false}
                    tone="accent"
                    className="min-w-20 shrink-0 justify-end text-body-sm font-semibold"
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {options.length === 0 && clears.length > 0 ? (
          <p className="text-body-sm text-ink-muted">
            추적 중인 캐릭터가 없어 캐릭터를 바꿀 수 없습니다. 홈에서 캐릭터 선택을 열어
            추적할 캐릭터를 고르면 여기서 바꿀 수 있습니다. 입장 인원은 지금도 고칠 수
            있습니다.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
