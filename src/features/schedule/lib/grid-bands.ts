import { SLOT_COUNT } from "./pattern-slots";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 세로 구간(밴드) — 60칸을 늘 다 보여 줄 필요는 없다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ 여기 있는 이유: **요일 격자와 교대 주기 격자가 같은 것을 써야 한다.**
 *   예전에는 이 셋이 편집기 파일 안에만 있었고, 주기 격자는 `firstSlot={16}` 을
 *   손으로 박아 놓은 탓에 00:00~08:00 을 아예 칠할 수도 볼 수도 없었다. 교대 근무자에게
 *   새벽은 핵심 구간이고, 게다가 24:00 이후만 칠하면 저장할 때 다음 칸 00:00~ 으로
 *   정규화되는데 그 자리가 숨어 있어 **저장한 것이 사라진 것처럼 보였다.**
 *   정의를 두 벌로 두면 같은 사고가 또 갈라져 재발하므로 한 곳에 둔다.
 */

export interface Band {
  readonly id: "evening" | "day" | "all";
  readonly label: string;
  readonly firstSlot: number;
}

/**
 * 밴드는 **보이는 범위**일 뿐 데이터가 아니다. 밴드 밖에 칠해진 칸은 상태에 그대로
 * 남아 있고 저장에도 포함된다 — 안 보인다고 지워지면 그게 가장 나쁜 사고다.
 * 그래서 편집기를 열 때 **이미 칠해진 가장 이른 칸을 담는 밴드로 자동 확장**한다.
 */
export const BANDS: readonly Band[] = [
  { id: "evening", label: "저녁 18시~", firstSlot: 18 * 2 },
  { id: "day", label: "낮 08시~", firstSlot: 8 * 2 },
  { id: "all", label: "하루 전체", firstSlot: 0 },
];

export function bandForEarliestSlot(slots: ReadonlySet<string>): Band["id"] {
  let earliest = SLOT_COUNT;
  for (const key of slots) {
    const slot = Number.parseInt(key.slice(key.indexOf(":") + 1), 10);
    if (Number.isInteger(slot) && slot < earliest) earliest = slot;
  }
  if (earliest >= 18 * 2) return "evening";
  if (earliest >= 8 * 2) return "day";
  return "all";
}

/** 밴드 id → 밴드. 못 찾으면 첫 밴드(저녁)로 떨어진다. */
export function resolveBand(id: Band["id"]): Band {
  return BANDS.find((entry) => entry.id === id) ?? BANDS[0];
}
