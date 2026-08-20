import "server-only";

/**
 * 넥슨 호출 게이트웨이 — **모든 넥슨 호출이 지나가는 단 하나의 문.**
 *
 * `client.ts` 는 "요청 1건을 어떻게 보내는가"만 안다. 여기서 그 위에 세 겹을 얹는다.
 *
 * 1. **쿨다운(서킷브레이커)** — 429 / `OPENAPI00007` 을 받으면 그 키의 호출을 즉시 멈춘다.
 *    한도를 넘긴 상태에서 재시도하면 예산만 더 태우고 아무것도 얻지 못한다.
 * 2. **캐시** — 15분. 넥슨 데이터가 15분 지연되므로 그 안의 재조회는 새 정보가 0이다.
 * 3. **장부** — 실제로 나간 호출만 `nexon_api_quota_usage` 에 적는다.
 *    캐시 적중은 호출이 아니므로 적지 않는다. (적으면 장부가 현실과 갈라진다.)
 *
 * 순서가 중요하다. 쿨다운 → 캐시 → 호출 순이 아니라 **캐시 → 쿨다운 → 호출**이다.
 * 한도를 넘긴 상태에서도 이미 받아 둔 데이터는 보여 줄 수 있어야 하기 때문이다.
 */

import type { AdminDb } from "@/lib/supabase/admin-db";
import {
  buildNexonCacheKey,
  getNexonCached,
  setNexonCached,
} from "./cache";
import type {
  NexonEndpointDeps,
  NexonRawFetch,
  NexonRequestOptions,
} from "./client";
import { nexonRequest } from "./client";
import {
  NEXON_CACHE_TTL_MS,
  NEXON_RATE_LIMIT_COOLDOWN_MS,
} from "./constants";
import { isNexonApiError, NexonApiError } from "./errors";
import { nextMaintenanceRecheckAt } from "@/lib/time/nexon-maintenance";

import { recordNexonCall } from "./quota";
import type { NexonCallOutcome } from "./types";

/**
 * 키 해시별 쿨다운 만료 시각.
 *
 * **자격증명 id 가 아니라 키 해시로 잠근다.** 아직 DB 에 등록되지 않은 키
 * (로그인 검증 중인 키)도 429 를 맞을 수 있고, 그때도 똑같이 멈춰야 하기 때문이다.
 */
const cooldownUntil = new Map<string, number>();

function isCoolingDown(apiKeyHash: string, now: number): boolean {
  const until = cooldownUntil.get(apiKeyHash);
  if (until === undefined) return false;
  if (until <= now) {
    cooldownUntil.delete(apiKeyHash);
    return false;
  }
  return true;
}

function startCooldown(apiKeyHash: string, now: number): void {
  cooldownUntil.set(apiKeyHash, now + NEXON_RATE_LIMIT_COOLDOWN_MS);
}

/**
 * 점검 중이라고 판정된 동안은 **키와 무관하게 전부** 멈춘다.
 *
 * ★ **키 해시별이 아니라 전역이다.** 429 는 그 키 하나의 문제지만 점검은 넥슨 전체가
 *   닫힌 것이라, 다른 키로 돌아가면 될 이유가 없다. 키별로 잠그면 자격증명 3개짜리
 *   계정이 점검 한 번에 세 번 두드린다.
 * ★ 이 값은 **프로세스 메모리**다. 서버리스라 인스턴스가 바뀌면 초기화되고, 그때 한 번
 *   더 부딪힌다. 그래도 두는 이유는 한 인스턴스가 캐릭터 수십 명을 연속으로 도는 것이
 *   실제 소비의 대부분이기 때문이다 — 그 사슬을 첫 실패에서 끊는 것만으로 대부분이 준다.
 *   DB 로 올리면 인스턴스 간에도 공유되지만, 점검 판정을 쓰겠다고 매 호출 앞에 왕복을
 *   하나 더 다는 것은 값이 맞지 않는다.
 */
let maintenanceUntil: number | null = null;

function isUnderMaintenance(now: number): boolean {
  if (maintenanceUntil === null) return false;
  if (maintenanceUntil <= now) {
    maintenanceUntil = null;
    return false;
  }
  return true;
}

function startMaintenanceHold(now: number): void {
  const until = nextMaintenanceRecheckAt(new Date(now)).getTime();
  // 이미 더 늦게까지 잡아 뒀다면 당기지 않는다.
  maintenanceUntil = maintenanceUntil === null ? until : Math.max(maintenanceUntil, until);
}

/** 테스트·수동 검증용. */
export function clearNexonCooldowns(): void {
  cooldownUntil.clear();
  maintenanceUntil = null;
}

export interface NexonGatewayContext {
  /** 사용자가 보낸 원문 키. **여기서만 살아 있고 어디에도 저장되지 않는다.** */
  readonly apiKey: string;
  /** `hashApiKey(apiKey)`. 캐시 격리와 쿨다운의 키. */
  readonly apiKeyHash: string;
  /**
   * 호출량을 적을 자격증명. **null 이면 적지 않는다.**
   * 최초 로그인처럼 아직 credential 행이 없는 순간이 실제로 존재한다
   * (FK 가 있어서 없는 행에 적을 수 없다).
   */
  readonly credentialId: string | null;
  readonly db: AdminDb;
  /** 응답 캐시 수명. 기본 15분. */
  readonly cacheTtlMs?: number;
  /**
   * `credentialId` 가 null 이라 장부에 적지 못한 호출을 받아 두는 곳.
   *
   * 최초 가입은 순서가 이렇게 꼬여 있다 — **키가 유효한지 알아야 계정을 만들고,
   * 계정을 만들어야 credential 행이 생기며, credential 이 있어야 FK 때문에 장부를
   * 적을 수 있다.** 그래서 그 한 건은 여기에 담아 두었다가 credential 이 생긴 직후에
   * 흘려보낸다. 담아 두지 않으면 **가입 때 쓴 호출이 장부에서 통째로 사라진다.**
   */
  readonly onUnattributedCall?: (outcome: NexonCallOutcome) => void;
  /**
   * **실제로 나간 호출이 성공했을 때** 한 번 불린다. 캐시 적중에는 불리지 않는다.
   *
   * 존재 이유는 딱 하나 — 넥슨 프록시의 **키 백필**이다(CLAUDE.md §2.1.2). 브라우저가
   * localStorage 에서 꺼내 보낸 키를 서버에 보관하려면 "그 키가 지금 유효한가"를 알아야
   * 하는데, 그것을 무료로 알 수 있는 유일한 순간이 **방금 그 키로 200 을 받은 직후**다.
   * 검증 전용 호출을 따로 내면 캐릭터마다 1콜을 더 태우게 된다(개발 키 1,000/일).
   *
   * ⚠️ 여기서 던지는 예외는 **삼킨다.** 부가 작업이 실패했다고 사용자가 요청한 데이터를
   *    못 받게 되면 안 된다.
   */
  readonly onCallSucceeded?: () => Promise<void>;
}

/**
 * 게이트웨이를 통과하는 요청 실행기를 만든다.
 * `fetchCharacterList(apiKey, deps)` 처럼 엔드포인트 래퍼에 그대로 끼운다.
 */
export function createNexonGateway(
  context: NexonGatewayContext,
): Required<NexonEndpointDeps> {
  const ttlMs = context.cacheTtlMs ?? NEXON_CACHE_TTL_MS;

  const request: NexonRawFetch = async <T>(
    args: NexonRequestOptions<T>,
  ): Promise<T> => {
    const now = Date.now();
    const cacheKey = buildNexonCacheKey(
      context.apiKeyHash,
      args.path,
      args.query,
    );

    const cached = getNexonCached<T>(cacheKey, now);
    if (cached !== undefined) return cached;

    /*
      ★ 점검 판정을 **쿼터 쿨다운보다 먼저** 본다. 점검이면 어느 키로도 안 되므로,
        키별 판정을 먼저 하는 것은 순서가 뒤집힌 것이다.
    */
    if (isUnderMaintenance(now)) {
      throw new NexonApiError({
        kind: "maintenance",
        detail: "직전 응답이 점검이라 호출하지 않았습니다.",
      });
    }

    if (isCoolingDown(context.apiKeyHash, now)) {
      // 이미 막힌 걸 아는 상태에서 또 부르지 않는다.
      throw new NexonApiError({
        kind: "quota_exceeded",
        detail: "직전 429 로 쿨다운 중이라 호출하지 않았습니다.",
      });
    }

    // 콜백 안에서 대입하므로 지역 변수 대신 홀더를 쓴다
    // (지역 `let` 은 클로저 대입이 타입 좁히기와 어긋난다).
    const holder: { outcome: NexonCallOutcome | null } = { outcome: null };

    try {
      const result = await nexonRequest<T>({
        apiKey: args.apiKey,
        path: args.path,
        query: args.query,
        schema: args.schema,
        timeoutMs: args.timeoutMs,
        onOutcome: (value) => {
          holder.outcome = value;
          args.onOutcome?.(value);
        },
      });

      setNexonCached(cacheKey, result, ttlMs, now);

      // ★ 실제로 나간 호출이 200 을 받았을 때만. 캐시 적중은 위에서 이미 반환됐다.
      if (holder.outcome !== null && context.onCallSucceeded !== undefined) {
        try {
          await context.onCallSucceeded();
        } catch (hookError) {
          // 부가 작업의 실패가 응답을 깨뜨리면 안 된다. 남기고 그대로 진행한다.
          console.warn(
            `[nexon-gateway] 호출 성공 후처리 실패: ${
              hookError instanceof Error ? hookError.message : String(hookError)
            }`,
          );
        }
      }

      return result;
    } catch (error) {
      if (isNexonApiError(error)) {
        if (error.kind === "quota_exceeded") startCooldown(context.apiKeyHash, now);
        /*
          점검을 한 번 받으면 **다음 확인 시각까지 통째로 멈춘다.** 그 시각은
          `nextMaintenanceRecheckAt` 이 정한다 — 정기 점검이면 오전 10시, 이미 10시를
          넘겼다면 패치날로 보고 오후 2시다(발주자 설명, 2026-08-20).
        */
        if (error.kind === "maintenance") startMaintenanceHold(now);
      }
      throw error;
    } finally {
      // ★ 캐시 적중은 여기까지 오지 않는다. 실제로 나간 호출만 적힌다.
      if (holder.outcome !== null) {
        if (context.credentialId !== null) {
          await recordNexonCall(
            context.db,
            context.credentialId,
            holder.outcome,
          );
        } else {
          context.onUnattributedCall?.(holder.outcome);
        }
      }
    }
  };

  return { request };
}
