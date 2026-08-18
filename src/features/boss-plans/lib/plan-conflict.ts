/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 계획 불일치를 **최신성으로 가른다** — 판정이 사는 유일한 곳
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── 무엇이 문제였나 (2026-08-18 발주자: *"저런것들이 많이 나오네"*) ──────────
 * DB 트리거 `character_boss_plans_apply_state()` 의 규칙은 한 줄이다:
 *
 *     has_conflict := manual_active is not null
 *                 and api_registered is not null
 *                 and manual_active is distinct from api_registered
 *
 * 함수 주석이 **"최신성 비교 없음"** 이라고 못박고 있다. 그래서 사용자가 앱에서 방금
 * 켠/끈 순간 **즉시** 충돌이 된다 — 넥슨은 아직 옛 상태를 말하고 있으니까. 노멀을 끄고
 * 하드 흉성·림보를 켠 직후 그 세 줄에 `설정 불일치` 가 한꺼번에 붙은 것이 이 경우다.
 *
 * ── 왜 이것이 그냥 소음인가 ───────────────────────────────────────────────────
 * **우리는 넥슨 인게임 스케줄러에 쓸 수 없다**(§1.1 — 읽기 전용 API 다). 즉 사용자가
 * 앱 안에서 이 경고를 해소할 방법이 없다. 해소 불가능한 경고를 행마다 띄우는 것은
 * 수익 화면에서 같은 문단을 11번 반복하던 것과 같은 종류의 결함이다.
 *
 * ── 그렇다고 정보를 없애지도 않는다 ───────────────────────────────────────────
 * §1 상 **인게임 목록이 실제 계획**이고 우리 수동 설정은 그 위에 얹는 선호다. 넥슨이
 * "이 보스 안 돈다"고 **계속** 말하는데 우리만 켜 두면 12개 카운터 예측이 틀어진다.
 * 그건 알 가치가 있다. 그래서 지우는 대신 **두 상태로 가른다**:
 *
 *   pending   수동 결정이 마지막 API 관측보다 **나중** → "게임에 아직 반영되지 않음".
 *             경고가 아니다. 넥슨 데이터는 ~15분 늦고 전날치는 다음 날 02:00 에
 *             들어오므로(§1.1), 방금 바꾼 설정이 한동안 이렇게 보이는 것은 **정상**이다.
 *   diverged  API 관측이 수동 결정보다 **나중인데도** 값이 다름 → 진짜 어긋남.
 *             다음 동기화가 이미 지나갔는데도 게임은 여전히 다른 말을 하고 있다.
 *
 * ── 왜 트리거가 아니라 여기서 판정하는가 ─────────────────────────────────────
 * 정공법은 `character_boss_plans_apply_state()` 를 고쳐 `has_conflict` 자체를 최신성
 * 기준으로 계산하는 것이다. 하지만 **미적용 마이그레이션이 이미 하나 밀려 있고**
 * (`20260818110000_boss_plan_party_size.sql`), 그 위에 새 마이그레이션을 얹으면 적용
 * 순서가 꼬인다. 두 타임스탬프는 이미 테이블에 있으므로(`manual_set_at` ·
 * `api_observed_at`) **그 둘을 화면까지 내려 표시 계층에서 가른다.** DB 의
 * `has_conflict` 는 여전히 "두 값이 다른가"의 단일 출처이고, 이 모듈은 거기에
 * **최신성 한 겹만** 얹는다 — 규칙을 두 벌로 만들지 않는다.
 *
 * 마이그레이션을 다시 정리할 때 이 판정을 트리거로 옮기게 되면, 이 파일은
 * `hasConflict` 를 그대로 돌려주는 얇은 어댑터로 남으면 된다.
 *
 * ⚠️ `server-only` 를 넣지 않는다. 서버 repo 의 집계와 화면의 배지가 **같은 판정**을
 *    써야 하기 때문이다. 화면마다 다른 판정이 보이는 것이 원래 고치려는 문제다.
 */

/**
 * `none`     두 출처가 같거나 한쪽이 미판단 — 표시할 것이 없다.
 * `pending`  우리 설정이 더 최신 — 게임 반영 대기. **경고하지 않는다.**
 * `diverged` 넥슨 관측이 더 최신인데도 다름 — 이때만 알린다.
 */
export type PlanConflictState = "none" | "pending" | "diverged";

/** 판정에 필요한 최소 모양. 뷰 행(snake)과 화면 타입(camel) 양쪽이 이 모양으로 접힌다. */
export interface PlanConflictInput {
  /** DB `has_conflict` — "두 값이 다른가"의 단일 출처. */
  readonly hasConflict: boolean;
  /** `character_boss_plans.manual_set_at` — 사람이 켜고 끈 시각. */
  readonly manualSetAt: string | null;
  /** `character_boss_plans.api_observed_at` — 그 값을 관측한 넥슨 응답의 기준 시각. */
  readonly apiObservedAt: string | null;
}

/**
 * 두 출처가 어긋난 이유를 최신성으로 가른다.
 *
 * ★ 타임스탬프를 못 읽으면 **`diverged` 쪽으로 기운다.** DB CHECK 가
 *   `(manual_active is null) = (manual_set_at is null)` 을 보장하므로 `hasConflict` 인
 *   행에는 두 시각이 반드시 있고, 이 분기는 실제로는 닿지 않는다. 그래도 기울일 방향은
 *   정해 둬야 한다 — 모르는 채로 "곧 사라질 것"이라고 말하면 진짜 어긋남이 영원히
 *   숨는다. 반대로 잘못 알린 경고는 사용자가 한 번 보고 넘긴다.
 */
export function resolvePlanConflictState(
  input: PlanConflictInput,
): PlanConflictState {
  if (!input.hasConflict) return "none";

  const manualMs = parseInstant(input.manualSetAt);
  const apiMs = parseInstant(input.apiObservedAt);
  if (manualMs === null || apiMs === null) return "diverged";

  // 동시각은 `diverged` 다. 같은 순간이면 "우리가 더 최신"이라고 주장할 근거가 없다.
  return manualMs > apiMs ? "pending" : "diverged";
}

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 상태별 개수. 요약 문장이 "몇 개"를 말하려면 화면과 서버가 같은 방식으로 세야 한다. */
export interface PlanConflictTally {
  readonly diverged: number;
  readonly pending: number;
}

export function tallyPlanConflicts(
  rows: readonly PlanConflictInput[],
): PlanConflictTally {
  let diverged = 0;
  let pending = 0;
  for (const row of rows) {
    const state = resolvePlanConflictState(row);
    if (state === "diverged") diverged += 1;
    else if (state === "pending") pending += 1;
  }
  return { diverged, pending };
}

/**
 * 행에 붙는 전문(`title`) — **무엇을 해야 하는지**를 담는다.
 *
 * 예전 문구 `설정 불일치` 는 사용자가 할 일을 하나도 알려 주지 않았다. 우리가 인게임
 * 스케줄러에 쓸 수 없다는 사실(§1.1)까지 포함해 조치를 두 갈래로 적는다 — 게임에서
 * 바꾸거나, 여기 설정을 되돌리거나.
 */
export function describePlanConflict(
  state: PlanConflictState,
  bossDisplayName: string,
): string | null {
  switch (state) {
    case "diverged":
      return (
        `${bossDisplayName} 은(는) 인게임 보스 목록과 다릅니다. ` +
        `여기서 직접 설정한 값이 계획에 그대로 쓰이므로, ` +
        `게임에서 이 보스를 등록/해제하거나 여기 설정을 되돌려 주세요.`
      );
    case "pending":
      return (
        `${bossDisplayName} 은(는) 여기서 바꾼 설정이 아직 인게임 목록에 반영되지 않았습니다. ` +
        `넥슨 데이터는 약 15분 늦게 갱신되니 잠시 뒤 새로고침하면 사라집니다.`
      );
    case "none":
      return null;
  }
}

/**
 * 카드 상단 요약 문장. **행마다 배지를 도배하는 대신 여기서 한 번만** 말한다
 * (수익 화면에서 검증된 처방).
 */
export function divergedSummarySentence(count: number): string {
  return (
    `인게임 보스 목록과 다른 항목이 ${count}개 있습니다 — ` +
    `게임에서 그 보스를 등록/해제하거나, 여기 설정을 되돌려 주세요. ` +
    `그때까지는 여기서 직접 설정한 값이 계획과 12개 카운터 계산에 쓰입니다.`
  );
}

export function pendingSummarySentence(count: number): string {
  return (
    `여기서 바꾼 설정 ${count}개는 아직 인게임 목록에 반영되지 않았습니다. ` +
    `넥슨 데이터는 약 15분 늦게 갱신되고 전날 기록은 다음 날 02:00(KST)에 들어오니, ` +
    `잠시 뒤 새로고침하면 저절로 맞춰집니다.`
  );
}
