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

/** 테스트·수동 검증용. */
export function clearNexonCooldowns(): void {
  cooldownUntil.clear();
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
      return result;
    } catch (error) {
      if (isNexonApiError(error) && error.kind === "quota_exceeded") {
        startCooldown(context.apiKeyHash, now);
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
