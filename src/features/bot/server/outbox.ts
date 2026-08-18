import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 아웃박스 — **선제 알림은 클라이언트가 가져간다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇 클라이언트는 가정용 단말이거나 NAT 뒤 컨테이너라 **서버가 부를 수 없다.**
 * 그래서 폴링이다. 중복 발송은 3중으로 막는다(마이그레이션 06 머리말):
 *
 *   1. **`dedupe_key` 유니크** — 적재 시점. 스케줄러가 두 번 돌아도 같은 행에 부딪힌다.
 *   2. **리스(lease)** — 응답 시 `visible_after = now + 60초`. 클라이언트 두 개가
 *      동시에 붙어도 같은 건을 함께 집어가지 못한다.
 *   3. **멱등 ack** — `sent` 로 넘어간 행은 다시 나오지 않는다. 같은 id 를 두 번 ack
 *      해도 두 번째는 아무것도 바꾸지 않는다.
 *
 * ★ **죽은 클라이언트 뒤에 알림이 쌓였다가 한꺼번에 터지는 사고**는 `expires_at` 이
 *   막는다. 리마인더는 보스 시각 +15분, 생성 알림은 2시간이면 만료다(적재 함수가
 *   그렇게 건다). 폴링이 24시간 없으면 적재를 멈추는 별도 규칙을 두지 않은 이유가
 *   그것이다 — 이미 만료로 사라진 것을 한 번 더 막는 규칙은 코드만 늘린다.
 */

import type { AdminDb } from "@/lib/supabase/admin-db";
import type { BotOutboxAckResult, BotOutboxMessage } from "../types";

import { ignoreError, unwrap } from "./shared";

/** 리스 길이(초). 클라이언트가 이 안에 ack 하지 못하면 다시 보인다. */
const LEASE_SECONDS = 60;

/** 한 번에 가져갈 수 있는 최대 건수. 방이 알림으로 도배되는 것을 막는다. */
export const MAX_PICKUP = 5;

/** ack 없는 건의 재노출 간격(초). 5회면 끝난다. */
const BACKOFF_SECONDS = [30, 120, 300, 900, 1800];

/** 다시 시도해도 결과가 같은 실패. 즉시 중단하고 채널을 `degraded` 로 표시한다. */
const NON_RETRYABLE = new Set(["room_not_found", "permission_denied"]);

interface OutboxRow {
  readonly id: string;
  readonly reply: string;
  readonly extra: string[] | null;
  readonly expires_at: string;
  readonly attempts: number;
  readonly max_attempts: number;
}

/**
 * ★ **가시성·만료 비교는 DB 시각으로 한다.**
 *
 * `visible_after` · `expires_at` 는 DB 가 채운 값인데(적재 함수의 `now()`, 리스의
 * 기본값) 앱 시각으로 비교하면 두 시계의 차이만큼 어긋난다. 실제로 이 저장소의 개발
 * 머신은 Supabase 보다 **7.6초 느렸고**, 그 탓에 방금 적재한 알림이 첫 폴링에서
 * 안 보였다. PostgREST 에 `now` 를 넘기면 Postgres 가 `timestamptz 'now'` 로 캐스팅해
 * **DB 트랜잭션 시각**으로 비교한다 — 시계가 하나가 된다.
 */
const DB_NOW = "now";

/** 만료된 건을 정리한다. 폴링마다 한 번이면 충분하다(별도 배치가 필요 없다). */
async function expireStale(db: AdminDb, channelId: string): Promise<void> {
  ignoreError(
    await db
      .from("bot_outbox")
      .update({ state: "expired" })
      .eq("channel_id", channelId)
      .in("state", ["pending", "delivering"])
      .lte("expires_at", DB_NOW),
    "만료 알림 정리",
  );
}

/**
 * 가져가기. **리스를 거는 것까지가 한 동작**이다.
 *
 * ⚠️ 여기서 `attempts` 를 올린다. ack 가 오지 않으면 다음 폴링에서 백오프만큼 뒤에
 *    다시 보이고, `max_attempts` 를 채우면 더 이상 나오지 않는다.
 */
export async function pickupOutbox(
  db: AdminDb,
  channelId: string,
  max: number,
  now: Date,
): Promise<readonly BotOutboxMessage[]> {
  await expireStale(db, channelId);

  const rows = unwrap(
    await db
      .from("bot_outbox")
      .select("id,reply,extra,expires_at,attempts,max_attempts")
      .eq("channel_id", channelId)
      .in("state", ["pending", "delivering"])
      .lte("visible_after", DB_NOW)
      .gt("expires_at", DB_NOW)
      .order("created_at", { ascending: true })
      .limit(Math.min(Math.max(max, 1), MAX_PICKUP)),
    "아웃박스 조회",
  ) as OutboxRow[];

  const deliverable = rows.filter((row) => row.attempts < row.max_attempts);
  if (deliverable.length === 0) {
    ignoreError(
      await db
        .from("bot_channels")
        .update({ last_polled_at: now.toISOString() })
        .eq("id", channelId),
      "폴링 시각 갱신",
    );
    return [];
  }

  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  await Promise.all([
    ...deliverable.map(async (row) =>
      ignoreError(
        await db
          .from("bot_outbox")
          .update({
            state: "delivering",
            visible_after: leaseUntil,
            attempts: row.attempts + 1,
          })
          .eq("id", row.id),
        "아웃박스 리스 설정",
      ),
    ),
    (async () =>
      ignoreError(
        await db
          .from("bot_channels")
          .update({ last_polled_at: now.toISOString() })
          .eq("id", channelId),
        "폴링 시각 갱신",
      ))(),
  ]);

  return deliverable.map((row) => ({
    id: row.id,
    reply: row.reply,
    ...(row.extra !== null && row.extra.length > 0 ? { extra: row.extra } : {}),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
  }));
}

/**
 * 배달 확인.
 *
 * ★ **`sent` 는 되돌아가지 않는다.** 이미 `sent` 인 행에 다시 ack 가 오면 아무것도
 *   바꾸지 않는다 — 그것이 "같은 id 를 두 번 받아도 안전하다"의 실체다.
 * ★ 재시도 가능한 실패는 `pending` 으로 되돌리고 백오프만큼 미룬다. 비재시도 실패는
 *   즉시 `failed` 로 끝내고 채널을 `degraded` 로 표시한다(웹앱이 배너를 그릴 근거).
 */
export async function ackOutbox(
  db: AdminDb,
  channelId: string,
  results: readonly BotOutboxAckResult[],
  now: Date,
): Promise<number> {
  if (results.length === 0) return 0;

  const rows = unwrap(
    await db
      .from("bot_outbox")
      .select("id,reply,extra,expires_at,attempts,max_attempts")
      .eq("channel_id", channelId)
      .in("state", ["pending", "delivering"])
      .in(
        "id",
        results.map((result) => result.id),
      ),
    "ack 대상 조회",
  ) as OutboxRow[];

  const byId = new Map(rows.map((row) => [row.id, row]));
  let applied = 0;
  let degrade = false;

  for (const result of results) {
    const row = byId.get(result.id);
    if (row === undefined) continue; // 이미 sent/failed/expired — 멱등하게 무시한다.

    if (result.status === "sent") {
      ignoreError(
        await db
          .from("bot_outbox")
          .update({ state: "sent", delivered_at: now.toISOString() })
          .eq("id", row.id)
          .in("state", ["pending", "delivering"]),
        "아웃박스 배달 확정",
      );
      applied += 1;
      continue;
    }

    const reason = result.error ?? "unknown";
    const terminal = NON_RETRYABLE.has(reason) || row.attempts >= row.max_attempts;
    if (NON_RETRYABLE.has(reason)) degrade = true;

    const backoff = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)] ?? 1800;
    ignoreError(
      await db
        .from("bot_outbox")
        .update(
          terminal
            ? { state: "failed", last_error: reason.slice(0, 200) }
            : {
                state: "pending",
                last_error: reason.slice(0, 200),
                visible_after: new Date(now.getTime() + backoff * 1000).toISOString(),
              },
        )
        .eq("id", row.id)
        .in("state", ["pending", "delivering"]),
      "아웃박스 실패 처리",
    );
    applied += 1;
  }

  if (degrade) {
    ignoreError(
      await db.from("bot_channels").update({ status: "degraded" }).eq("id", channelId),
      "채널 상태 저하 표시",
    );
  }

  return applied;
}

/**
 * 런 알림 적재 — **문구도 중복 방지도 DB 가 소유한다**(마이그레이션 13-5).
 *
 * 앱이 문구를 만들면 웹 미리보기와 봇 실제 발송이 갈라진다. 그래서 여기서 하는 일은
 * **타이밍뿐**이다: 참가자 등록이 끝난 **뒤에** 한 번 부른다.
 *
 * 반환값 0 은 정상이다 — 그 파티가 어느 방에도 바인딩돼 있지 않거나(웹 전용 파티),
 * 이미 같은 `dedupe_key` 로 적재된 경우다.
 *
 * ⚠️ **실패해도 던지지 않는다.** 알림을 못 쌓았다고 방금 만든 일정을 되돌릴 수는 없다.
 */
export async function enqueueRunNotice(
  db: AdminDb,
  runId: string,
  kind: "created" | "remind" = "created",
): Promise<number> {
  const result = await db.rpc("enqueue_run_notice", { p_run_id: runId, p_kind: kind });
  if (result.error !== null) {
    console.warn(`[bot] 런 알림 적재 실패(run=${runId}): ${result.error.message}`);
    return 0;
  }
  return typeof result.data === "number" ? result.data : 0;
}
