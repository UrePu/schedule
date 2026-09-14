"use client";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import type { IncomeCharacterOption } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 드롭다운 — 수정 모달에서 **행의 주 조작**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * "이 보스를 어느 캐릭터로 돌았는가". §1 에서 클리어의 단위는 사람이 아니라 캐릭터이고
 * 주간 12개 상한도 캐릭터당이므로, 보스 한 줄에 캐릭터가 오는 것이 원래 자연스럽다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 네이티브 `<select>` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 새 의존성을 넣을 수 없고(§2), 커스텀 드롭다운은 키보드 조작(↑↓·Home/End·타이핑 점프)과
 * 모바일 네이티브 피커를 손으로 다시 만들어야 한다. `Dialog` 가 네이티브 `<dialog>` 를
 * 고른 것과 정확히 같은 판단이다. 모양은 토큰으로 맞추고 동작은 브라우저에 맡긴다.
 *
 * ★ 후보는 **추적 중인 내 캐릭터뿐**이다(§2.1.1). 목록은 서버가 만들고
 *   (`fetchMyRunCharacters`) 화면은 거르지 않는다.
 * ★ 지금 걸려 있는 캐릭터가 후보에 없을 수 있다. 그때 그 값을 목록에서 빼 버리면
 *   `<select>` 가 **다른 캐릭터를 선택된 것처럼** 보여 준다. 그래서 비활성 항목으로
 *   남겨 현재 상태를 사실대로 표시한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 후보에 없는 **사유가 셋**이고, 사용자가 할 일이 각각 다르다 (2026-09-14) ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * | 사유 | 표시 | 사용자가 할 일 |
 * |---|---|---|
 * | 캐릭터 행이 사라짐(`characterId === null`) | `캐릭터 없음` | 없음(기록만 남았다) |
 * | 추적을 껐다 | `(추적 해제됨)` | 캐릭터 선택에서 **체크를 켠다** |
 * | 넥슨 목록에서 사라졌다 | `(넥슨 목록에서 사라짐)` | 체크를 **끈다** — 되살릴 수 없다 |
 *
 * 셋째가 이번에 새로 생겼다. 후보 목록(`fetchMyRunCharacters`)이 유령을 빼기 시작하면서,
 * **추적이 켜져 있는데도** `(추적 해제됨)` 이라고 말하게 됐다 — 사용자가 "내가 껐나?" 하고
 * 모달을 열면 체크는 켜져 있다. **거짓말이고, 시키는 행동도 반대다.**
 * 화면은 사유를 스스로 알 수 없으므로 서버가 `characterMissing` 으로 말해 준다.
 */

export interface CharacterSelectProps {
  readonly id: string;
  /** 지금 이 클리어가 귀속된 캐릭터. `null` = 캐릭터가 삭제되어 연결이 끊긴 상태. */
  readonly characterId: string | null;
  /** 후보에 없을 때 비활성 항목으로 보여 줄 현재 이름. */
  readonly characterName: string | null;
  /**
   * 그 캐릭터가 **넥슨 목록에서 사라졌는가**. `false` 면 후보에 없는 이유는 추적 해제다.
   * 둘을 가르지 않으면 유령에게 `(추적 해제됨)` 이라는 **거짓 라벨**이 붙는다(머리말).
   */
  readonly characterMissing?: boolean;
  readonly options: readonly IncomeCharacterOption[];
  readonly disabled?: boolean;
  readonly onChange: (characterId: string) => void;
  readonly "aria-describedby"?: string;
}

export function CharacterSelect({
  id,
  characterId,
  characterName,
  characterMissing = false,
  options,
  disabled = false,
  onChange,
  "aria-describedby": describedBy,
}: CharacterSelectProps) {
  const known = options.some((option) => option.characterId === characterId);

  return (
    <div className="relative flex min-w-0 items-center">
      <select
        id={id}
        value={characterId ?? ""}
        disabled={disabled || options.length === 0}
        aria-describedby={describedBy}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "" && next !== characterId) onChange(next);
        }}
        className={cn(
          "h-control-sm w-full min-w-0 appearance-none rounded-md border border-border bg-surface",
          // 우측 패딩은 화살표 아이콘 자리(12px 아이콘 + 여백).
          "py-1 pr-7 pl-2.5",
          "text-body-sm text-ink",
          "transition duration-200 outline-none",
          "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
          "disabled:cursor-not-allowed disabled:bg-background disabled:text-ink/50",
        )}
      >
        {/*
          현재 값이 후보에 없는 세 경우를 **사실대로** 그린다(머리말의 표).
          어느 쪽이든 이름은 남기고 다시 고를 수만 없게 비활성으로 둔다.
        */}
        {characterId === null ? (
          <option value="" disabled>
            캐릭터 없음
          </option>
        ) : known ? null : (
          <option value={characterId} disabled>
            {characterName ??
              (characterMissing ? "사라진 캐릭터" : "추적하지 않는 캐릭터")}{" "}
            {characterMissing ? "(넥슨 목록에서 사라짐)" : "(추적 해제됨)"}
          </option>
        )}
        {options.map((option) => (
          <option key={option.characterId} value={option.characterId}>
            {option.name}
            {option.worldName === null ? "" : ` · ${option.worldName}`}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        size={14}
        className="pointer-events-none absolute right-2 text-ink-muted"
      />
    </div>
  );
}
