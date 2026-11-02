import { NEXON_CACHE_TTL_MS } from "@/lib/nexon/constants";

import type { CharacterChecklist, ChecklistCharacter } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 동기화의 **정책**만 담은 모듈 — React 도 fetch 도 없다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 훅(`use-scheduler-auto-sync.ts`)은 "언제 어떻게 부를지"를 담고, 이 파일은
 * **"불러야 하는가"** 와 **"실패했을 때 계속할 것인가"** 두 판정만 담는다.
 * 순수 함수라 눈으로 검증되고, 훅을 건드리지 않고도 정책을 바꿀 수 있다.
 *
 * 진입 시 자동 동기화와 사람이 누르는 **전체 갱신**이 함께 쓴다. 시간 기준은 자동에만
 * 있다(넥슨 지연 창 15분). 전체 갱신은 키가 있는 캐릭터를 전부 부른다.
 */

/** 키가 없어 부르지 못한 캐릭터 1건. **실패가 아니라 상태다.** */
export interface MissingKeyCharacter {
  readonly characterId: string;
  readonly characterName: string;
  /**
   * 필요한 자격증명. `null` 이면 **어느 계정 소속인지조차 모른다**(옛 행) —
   * 그건 "키를 넣어라"와는 다른 상태이므로 문구도 달라야 한다.
   */
  readonly credentialId: string | null;
  /** 그 자격증명에 붙은 이름. 자격증명이 있어도 이름은 비어 있을 수 있다. */
  readonly credentialLabel: string | null;
}

/**
 * 이번 배치에서 캐릭터 하나에 쓸 재료.
 *
 * `apiKey` 가 `null` 이면 **서버가 DB 에서 꺼내 쓴다**(§2.1.2) — 실패가 아니라 기본 경로다.
 * 값이 있으면 하위 호환 겸 백필용으로 함께 보낸다.
 */
export interface SyncPlanItem {
  readonly characterId: string;
  readonly credentialId: string;
  /** 실패를 말할 때 어느 키인지 부르는 이름. 원문·마스킹이 아니라 사용자가 붙인 이름이다. */
  readonly credentialLabel: string | null;
  readonly apiKey: string | null;
}

/** 캐릭터 하나를 부를 수 있는가. 부를 수 없으면 "키 없음" 항목이 나온다. */
export type SyncKeyResolution =
  | { readonly kind: "callable"; readonly item: SyncPlanItem }
  | { readonly kind: "missing"; readonly missing: MissingKeyCharacter };

/**
 * ★ 부를 수 있는 근거가 하나도 없으면 **부르지 않는다.** 다른 계정 키를 대신 보내면
 *   넥슨이 `OPENAPI00004` 로 거절하면서 호출량만 태운다(§1.0 실측). 이 캐릭터는 실패가
 *   아니라 "키 없음"으로 세어 화면이 조치를 안내한다.
 *
 *   근거는 둘이다 — **서버에 그 계정 키가 있거나**(§2.1.2, 기본 경로), 이 브라우저에
 *   원문이 있거나. 후자는 함께 보내 백필까지 겸한다.
 */
export function resolveSyncKey(
  character: Pick<
    ChecklistCharacter,
    | "characterId"
    | "name"
    | "credentialId"
    | "credentialLabel"
    | "serverKeyAvailable"
  >,
  apiKeys: Readonly<Record<string, string>>,
): SyncKeyResolution {
  const { characterId, name, credentialId, credentialLabel, serverKeyAvailable } =
    character;
  const localKey =
    credentialId === null ? null : (apiKeys[credentialId] ?? null);

  if (credentialId === null || (!serverKeyAvailable && localKey === null)) {
    return {
      kind: "missing",
      missing: {
        characterId,
        characterName: name,
        credentialId,
        credentialLabel,
      },
    };
  }
  return {
    kind: "callable",
    item: { characterId, credentialId, credentialLabel, apiKey: localKey },
  };
}

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

/** 키로 가른 캐릭터들. */
export interface CharactersByKey {
  /** 부를 수 있는 캐릭터. 화면에 보이는 순서 그대로다. */
  readonly targets: readonly SyncPlanItem[];
  readonly missingKey: readonly MissingKeyCharacter[];
}

/**
 * 전체 갱신 대상 선별 — **키가 있는 추적 캐릭터 전부.**
 *
 * - **실패 기억(`scheduler-sync-memo`)은 보지 않는다.** 사람이 직접 누른 것은 언제나
 *   통과한다 — 그 기억의 머리말이 정한 탈출구이고, 카드별 새로고침과 같다.
 * - 사라진 캐릭터는 여기 오지 않는다. 서버가 체크리스트에서 이미 뺐다(`missing_since`).
 */
export function splitCharactersByKey(
  characters: readonly CharacterChecklist[],
  apiKeys: Readonly<Record<string, string>>,
): CharactersByKey {
  const targets: SyncPlanItem[] = [];
  const missingKey: MissingKeyCharacter[] = [];

  for (const entry of characters) {
    const resolved = resolveSyncKey(entry.character, apiKeys);
    if (resolved.kind === "missing") missingKey.push(resolved.missing);
    else targets.push(resolved.item);
  }

  return { targets, missingKey };
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
 *
 * 중단의 **범위**(배치 전체인가, 그 키만인가)는 `isCredentialScopedFailure` 가 가른다.
 */
export function shouldAbortAutoSync(kind: string | null | undefined): boolean {
  switch (kind) {
    // 그 캐릭터 하나의 문제 — 나머지는 계속한다.
    case "bad_request": // 추적 해제됨 / ocid 없음 / 내 캐릭터가 아님
    case "invalid_parameter": // 넥슨이 이 파라미터를 거절
    case "invalid_id": // 이 캐릭터의 ocid 가 낡음
    /*
     * 이 캐릭터가 **다른 넥슨 계정** 소속이라 지금 키로는 못 읽는다(§2.1).
     * 한 사람이 계정을 여러 개 쓰는 것이 정상이므로, 이건 배치를 멈출 이유가 아니라
     * **그 캐릭터만 건너뛸** 이유다. 멈추면 뒤에 있는 같은 계정 캐릭터까지 놓친다.
     */
    case "credential_mismatch":
    /*
     * 그 **자격증명 하나**의 키가 아직 서버에 없다(§2.1.2). 다른 계정 캐릭터는 멀쩡히
     * 돌아가므로 멈출 이유가 없다 — 멈추면 키가 다 올라가 있는 계정까지 함께 놓친다.
     */
    case "server_key_missing":
      return false;
    /*
     * ★ **점검은 중단이 확정이다.** `default` 가 이미 `true` 라 동작은 같지만, 여기 적어
     *   두는 이유는 이 판단이 **우연이 아니라 의도**임을 남기기 위해서다. 점검은 넥슨
     *   전체가 닫힌 것이라 남은 캐릭터 전부가 같은 실패를 받는다 — 추적 캐릭터 11명이면
     *   11번을 확실히 버리는 셈이고, 개발 키 하루 1,000콜에서 그 낭비는 점검 6시간 동안
     *   대시보드를 열 때마다 되풀이된다.
     * ★ 게이트웨이도 같은 판단을 서버 쪽에서 한 번 더 한다(`startMaintenanceHold`).
     *   두 겹인 것은 중복이 아니다 — 이쪽은 브라우저의 직렬 루프를 끊고, 저쪽은 이 판정을
     *   모르는 다른 진입점(수동 버튼·다른 탭)까지 막는다.
     */
    case "maintenance":
    // 자격증명·세션·상류 전체의 문제, 그리고 정체불명 — 즉시 멈춘다.
    default:
      return true;
  }
}

/**
 * 멈춰야 하는 실패 중 **그 키 하나의 문제**인 것.
 *
 * 한 사람이 넥슨 계정을 여러 개 쓰므로(§2.1), 부계정 키 하나가 만료됐다고 본계정 캐릭터까지
 * 포기하면 실패 하나가 나머지를 막는다. 이 종류는 **같은 키의 남은 캐릭터만** 건너뛰고,
 * 다른 키는 계속 부른다. 호출은 키마다 많아야 한 번 더 나갈 뿐이라 재시도 폭주가 아니다.
 */
export function isCredentialScopedFailure(
  kind: string | null | undefined,
): boolean {
  switch (kind) {
    case "invalid_key":
    case "quota_exceeded":
    case "forbidden":
      return true;
    default:
      return false;
  }
}
