import { NEXON_CACHE_TTL_MS } from "@/lib/nexon/constants";

import type { CharacterChecklist } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 자동 동기화의 **정책**만 담은 모듈 — React 도 fetch 도 없다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 훅(`use-scheduler-auto-sync.ts`)은 "언제 어떻게 부를지"를 담고, 이 파일은
 * **"불러야 하는가"** 와 **"실패했을 때 계속할 것인가"** 두 판정만 담는다.
 * 순수 함수라 눈으로 검증되고, 훅을 건드리지 않고도 정책을 바꿀 수 있다.
 */

/**
 * 이 시간 안에 이미 불렀으면 **다시 부르지 않는다.**
 *
 * ★ 값을 새로 정하지 않고 `NEXON_CACHE_TTL_MS`(15분)를 **그대로 쓴다.** 근거가 같기
 *   때문이다 — 넥슨 데이터는 약 15분 지연되므로 그 안에 다시 물어도 **같은 바이트**가
 *   오고 하루 예산만 탄다(§1.1). 두 곳에 각자 숫자를 적으면 한쪽만 바뀌는 날이 온다.
 *
 * 서버 캐시가 이미 15분이라 가드가 없어도 넥슨 호출 자체는 대개 0이 되지만, 그것에
 * 기대면 안 된다:
 *   - 서버 캐시는 **프로세스 메모리**다(`lib/nexon/cache.ts`). 인스턴스가 여러 개거나
 *     재배포 직후면 비어 있어서 그대로 14콜이 나간다.
 *   - 캐시에 맞아도 **왕복 14번 + DB 쓰기 14번**은 그대로 일어난다.
 * 그래서 진짜 가드는 여기, 호출을 **시작하기 전에** 있어야 한다.
 */
export const SCHEDULER_FRESH_WINDOW_MS = NEXON_CACHE_TTL_MS;

/**
 * 판정 근거는 **`snapshot.fetchedAt`** 이다. `snapshotAt` 이 아니다.
 *
 * 두 값의 뜻이 다르다(`character_scheduler_snapshots`):
 *   - `snapshot_at` = 넥슨 응답의 `date`. **데이터 기준 시각**이고 실측값은
 *     `2026-08-17T00:00+09:00` 처럼 **날짜 단위**다. 이걸 쓰면 같은 날 안에서는
 *     아무리 불러도 값이 그대로라 "방금 불렀다"를 표현할 수 없다.
 *   - `fetched_at` = **우리가 넥슨을 부른 시각**. 가드가 막으려는 것이 바로 "우리가
 *     또 부르는 것"이므로 이쪽이 맞다. 같은 `snapshot_at` 행에 upsert 되면서 갱신된다.
 *
 * 스냅샷이 없으면(`null`) 한 번도 안 불렀다는 뜻이라 **항상 대상**이다 —
 * 에러가 아니라 정상 상태다(§1.1).
 */
export function isSchedulerStale(
  fetchedAt: string | null | undefined,
  now: number,
): boolean {
  if (fetchedAt === null || fetchedAt === undefined) return true;

  const fetchedMs = Date.parse(fetchedAt);
  // 파싱 실패는 "모른다"이며, 모르면 신선하다고 우기지 않는다.
  if (Number.isNaN(fetchedMs)) return true;

  // 시계 어긋남으로 미래 시각이 들어오면 `now - fetchedMs` 가 음수가 되어 영원히
  // 신선해진다. 음수는 0으로 접어 "방금 불렀다"로만 취급한다.
  const elapsed = Math.max(now - fetchedMs, 0);
  return elapsed >= SCHEDULER_FRESH_WINDOW_MS;
}

/** 자동 동기화 대상 캐릭터. 화면에 보이는 순서를 그대로 유지한다. */
export function selectStaleCharacterIds(
  characters: readonly CharacterChecklist[],
  now: number,
): readonly string[] {
  return characters
    .filter((entry) => isSchedulerStale(entry.snapshot?.fetchedAt ?? null, now))
    .map((entry) => entry.character.characterId);
}

/**
 * 한 캐릭터가 실패했을 때 **남은 캐릭터도 포기할 것인가.**
 *
 * ★ **재시도 폭주 금지**(§1.1). 특히 `quota_exceeded` 는 429 를 뜻하고, 게이트웨이가
 *   그 자격증명을 60초 쿨다운에 넣는다(`NEXON_RATE_LIMIT_COOLDOWN_MS`). 남은 13명을
 *   계속 쏘면 전부 같은 실패를 받으면서 쿨다운만 연장한다.
 *
 * 축은 두 가지다:
 *   - **자격증명·상류 전체의 문제** → 다음 캐릭터도 똑같이 실패한다 → **중단**.
 *   - **그 캐릭터만의 문제**(추적 해제, ocid 없음/형식 오류) → 나머지는 멀쩡하다 →
 *     그 한 명만 건너뛰고 계속.
 *
 * `kind` 를 못 읽었으면(`null`) **중단** 쪽으로 기운다. 모르는 실패를 14번 반복하는
 * 것보다 한 번에서 멈추고 사용자에게 알리는 편이 예산에 안전하다.
 */
export function shouldAbortAutoSync(kind: string | null | undefined): boolean {
  switch (kind) {
    // 그 캐릭터 하나의 문제 — 나머지는 계속한다.
    case "bad_request": // 추적 해제됨 / ocid 없음 / 내 캐릭터가 아님
    case "invalid_parameter": // 넥슨이 이 파라미터를 거절
    case "invalid_id": // 이 캐릭터의 ocid 가 낡음
      return false;
    // 자격증명·세션·상류 전체의 문제, 그리고 정체불명 — 즉시 멈춘다.
    default:
      return true;
  }
}
