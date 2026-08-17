import "server-only";

/**
 * 넥슨 호출량 장부.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 우리가 직접 세는가
 * ─────────────────────────────────────────────────────────────────────────────
 * **잔여 호출량 헤더가 존재하지 않는다**(실측 `NEXON-API#12` — 응답 헤더 20종을 전부
 * 훑었지만 rate-limit 계열이 하나도 없다). 넥슨은 한도를 넘긴 뒤에야 `OPENAPI00007`
 * 로 알려 준다. 즉 "얼마나 남았나"를 알 수 있는 방법은 **우리 장부뿐**이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 우리 숫자로 **차단하지 않는가**
 * ─────────────────────────────────────────────────────────────────────────────
 * 한도는 키 종류에 따라 1,000/일(개발)과 20,000,000/일(서비스)로 4자리나 차이 난다.
 * 그런데 우리는 **키 종류를 판별하지 않기로 이미 결정했다**(research-NEXON-API #8 —
 * 접두사로 키를 판별하는 로직은 넣지 않는다). 개발 키 기준으로 하드 차단하면
 * 서비스 키 사용자를 1,000콜에서 막아 버린다. 반대로 서비스 키 기준이면 아무 의미가 없다.
 *
 * → **경고는 우리 장부로, 차단은 넥슨의 429 로.** 429 를 받으면 `gateway.ts` 의
 *   쿨다운이 그 자격증명의 호출을 즉시 멈춘다. 추측으로 막지 않고 사실로 막는다.
 */

import { formatKst } from "@/lib/time/week";

import type { AdminDb } from "@/lib/supabase/admin-db";
import {
  NEXON_DAILY_BUDGET_WARN_RATIO,
  NEXON_DEV_KEY_DAILY_BUDGET,
} from "./constants";
import type { NexonCallOutcome } from "./types";

/**
 * 호출량 버킷의 날짜 키.
 *
 * **KST 기준이다.** 넥슨의 일일 한도가 KST 로 리셋되므로 UTC 로 세면 매일 9시간이
 * 엉뚱한 버킷에 들어간다. DB 의 `public.day_key(timestamptz)` 와 같은 값
 * (`YYYY-MM-DD`)을 내도록 맞춰 두었다.
 */
export function nexonQuotaDayKey(at: Date = new Date()): string {
  return formatKst(at, "yyyy-MM-dd");
}

export interface NexonQuotaSnapshot {
  readonly dayKey: string;
  readonly callCount: number;
  readonly errorCount: number;
  readonly throttledCount: number;
  /** 개발 키 기준 잔여. 서비스 키면 의미 없는 값이라 **경고용으로만** 쓴다. */
  readonly devBudgetRemaining: number;
  readonly nearDevBudget: boolean;
}

const PG_UNIQUE_VIOLATION = "23505";
const MAX_CAS_ATTEMPTS = 4;

/**
 * 호출 1건을 장부에 적는다.
 *
 * **동시성**: `call_count = call_count + 1` 을 한 문장으로 쓸 수 없으므로
 * (PostgREST 에는 원자적 증가가 없고, 이 앱은 DB 함수를 새로 만들 수 없는 작업 범위다)
 * **compare-and-set** 으로 처리한다 — 읽은 값과 같을 때만 갱신하고, 아니면 다시 읽는다.
 * 낙관적 재시도라 경합에서도 카운트를 잃지 않는다.
 *
 * **실패해도 요청을 깨뜨리지 않는다.** 장부를 못 적는 것보다 사용자 요청이 죽는 쪽이 나쁘다.
 * 대신 서버 로그에 남긴다.
 */
export async function recordNexonCall(
  db: AdminDb,
  credentialId: string,
  outcome: NexonCallOutcome,
  at: Date = new Date(),
): Promise<void> {
  const dayKey = nexonQuotaDayKey(at);
  const errorDelta = outcome.ok ? 0 : 1;
  const throttledDelta = outcome.rateLimited ? 1 : 0;

  try {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { data: existing, error: selectError } = await db
        .from("nexon_api_quota_usage")
        .select("id, call_count, error_count, throttled_count")
        .eq("credential_id", credentialId)
        .eq("day_key", dayKey)
        .maybeSingle();

      if (selectError !== null) throw selectError;

      if (existing === null) {
        const { error: insertError } = await db
          .from("nexon_api_quota_usage")
          .insert({
            credential_id: credentialId,
            day_key: dayKey,
            call_count: 1,
            error_count: errorDelta,
            throttled_count: throttledDelta,
            last_called_at: at.toISOString(),
          });

        if (insertError === null) return;
        // 같은 순간에 다른 요청이 먼저 만들었다 → 갱신 경로로 다시 돈다.
        if (insertError.code !== PG_UNIQUE_VIOLATION) throw insertError;
        continue;
      }

      const { data: updated, error: updateError } = await db
        .from("nexon_api_quota_usage")
        .update({
          call_count: existing.call_count + 1,
          error_count: existing.error_count + errorDelta,
          throttled_count: existing.throttled_count + throttledDelta,
          last_called_at: at.toISOString(),
        })
        .eq("id", existing.id)
        // ★ CAS: 우리가 읽은 값 그대로일 때만 쓴다. 아니면 남이 먼저 올렸다는 뜻.
        .eq("call_count", existing.call_count)
        .select("id");

      if (updateError !== null) throw updateError;
      if (updated !== null && updated.length > 0) return;
    }

    console.warn(
      `[nexon/quota] 호출량 기록이 경합으로 ${MAX_CAS_ATTEMPTS}회 실패했습니다. credentialId=${credentialId} dayKey=${dayKey}`,
    );
  } catch (error) {
    console.error(
      "[nexon/quota] 호출량 기록 실패(요청은 계속 진행합니다):",
      error instanceof Error ? error.message : error,
    );
  }
}

/** 오늘(KST) 이 자격증명이 쓴 호출량. 없으면 0 으로 채운 스냅샷을 돌려준다. */
export async function readQuotaSnapshot(
  db: AdminDb,
  credentialId: string,
  at: Date = new Date(),
): Promise<NexonQuotaSnapshot> {
  const dayKey = nexonQuotaDayKey(at);

  const { data, error } = await db
    .from("nexon_api_quota_usage")
    .select("call_count, error_count, throttled_count")
    .eq("credential_id", credentialId)
    .eq("day_key", dayKey)
    .maybeSingle();

  if (error !== null) throw error;

  const callCount = data?.call_count ?? 0;

  return {
    dayKey,
    callCount,
    errorCount: data?.error_count ?? 0,
    throttledCount: data?.throttled_count ?? 0,
    devBudgetRemaining: Math.max(NEXON_DEV_KEY_DAILY_BUDGET - callCount, 0),
    nearDevBudget:
      callCount >= NEXON_DEV_KEY_DAILY_BUDGET * NEXON_DAILY_BUDGET_WARN_RATIO,
  };
}
