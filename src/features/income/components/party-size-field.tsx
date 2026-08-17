"use client";

import { useState } from "react";

import { Input } from "@/components/ui";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 입장 인원 — 행의 **보조 입력** (§1.3 D3)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 결정석 표시가는 **솔로 기준**이고 실수령액은 `floor(가격 / 입장 인원)` 이다. 인원이
 * 틀리면 그 한 건의 수익이 최대 **6배**로 잡힌다. D3 는 인원을 "실제로 들어간 인원"으로
 * 정의하고 **사용자가 고칠 수 있어야 한다**고 못박았다 — 이 입력이 그 수단이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 캐릭터 드롭다운보다 **뒤**에 있는가
 * ─────────────────────────────────────────────────────────────────────────────
 * "매일 만지는 것이 앞, 가끔 고치는 것이 뒤"다. 어느 캐릭터로 도는지는 주마다 바뀌지만
 * 입장 인원은 한 번 맞추면 그 판에 대해 끝난다. 그래서 캐릭터가 행의 주 조작이고
 * 인원은 폭 좁은 숫자 칸이다.
 *
 * ★ 그래도 **행에서 치우지는 않았다.** 접기 뒤에 숨기면 6배 과대 계상을 고치는 유일한
 *   수단이 안 보이는 곳으로 간다. 대신 **미확인 행만 눈에 띄게** 해서(부모가 배지와
 *   경고를 붙인다) 손댈 곳이 스스로 드러나게 했다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 상한은 **막지 않는다** (§1.3 D5)
 * ─────────────────────────────────────────────────────────────────────────────
 * `max_party = 6` 값 대부분은 보스별 1차 출처가 아니라 세대 규칙에서 유도한 값이다
 * (개별 확인은 11건뿐). 실제 파티가 그 값을 넘는데 저장이 막히면 사용자는 앱을 못 쓴다.
 *   → 드롭다운(1~max)이 아니라 **숫자 입력**인 이유가 이것이다. 선택지로 만들면 상한
 *     초과가 구조적으로 불가능해져 소프트 상한이 하드 상한으로 바뀐다.
 *   → `max` 속성은 보스 상한이 아니라 **DB CHECK 범위(1~24)** 로 건다. 보스 상한 초과는
 *     부모가 경고 문장으로만 처리한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 커밋은 **Enter 또는 포커스 이탈**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 글자마다 저장하면 `1` → `12` 를 입력하는 사이에 "1명" 저장이 한 번 끼어들어
 * 금액이 잠깐 6배로 튄다. 반대로 별도 "적용" 버튼을 두면 누르지 않은 값이 저장된 줄 알고
 * 창을 닫는 사람이 생긴다. 그래서 **값을 다 입력한 순간**(Enter / 다른 곳 클릭 / Tab)에
 * 한 번만 보낸다. 저장이 끝나면 서버가 낸 새 값으로 부모가 이 입력을 다시 시작시킨다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기서 금액을 미리 계산해 보여 주지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * `floor(가격/n)` 을 화면에서 미리 그리면 그것이 **두 번째 구현**이 된다. 저장 후 DB 가
 * 낸 값(`crystal_share_meso`)이 옳고, 미리보기와 어긋나는 순간 어느 쪽이 맞는지 아무도
 * 모르게 된다. 그래서 저장 전에는 아무 숫자도 약속하지 않는다.
 */

export interface PartySizeFieldProps {
  readonly id: string;
  /** 현재 저장된 값. 이 값이 바뀌면 부모가 `key` 로 초기화한다. */
  readonly partySize: number;
  readonly disabled?: boolean;
  readonly onSubmit: (partySize: number) => void;
  readonly "aria-describedby"?: string;
}

/** DB CHECK 범위. 여기서만 막는다 — 보스별 상한과 교차 검증하지 않는다(§1.3 D5). */
export const PARTY_SIZE_MIN = 1;
export const PARTY_SIZE_MAX = 24;

export function PartySizeField({
  id,
  partySize,
  disabled = false,
  onSubmit,
  "aria-describedby": describedBy,
}: PartySizeFieldProps) {
  const [draft, setDraft] = useState(String(partySize));

  const parsed = Number.parseInt(draft, 10);
  const isValid =
    Number.isInteger(parsed) &&
    parsed >= PARTY_SIZE_MIN &&
    parsed <= PARTY_SIZE_MAX;
  const changed = isValid && parsed !== partySize;

  function commit(): void {
    if (changed && !disabled) {
      onSubmit(parsed);
      return;
    }
    // 잘못된 값을 남긴 채 포커스를 떠나면 저장된 값으로 되돌린다 — 화면에 저장되지 않은
    // 숫자가 남아 있으면 사용자는 그것이 반영된 줄 안다.
    if (!isValid) setDraft(String(partySize));
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={PARTY_SIZE_MIN}
          /* ★ max 는 보스 상한이 아니라 DB CHECK 범위다 (§1.3 D5). */
          max={PARTY_SIZE_MAX}
          step={1}
          value={draft}
          invalid={!isValid}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="h-control-sm w-16 px-2 py-1 tabular-nums"
        />
        <span className="text-caption text-ink-muted">명</span>
      </div>
      {!isValid ? (
        <p className="text-body-sm text-error">
          {PARTY_SIZE_MIN}~{PARTY_SIZE_MAX} 사이의 정수
        </p>
      ) : null}
    </div>
  );
}
