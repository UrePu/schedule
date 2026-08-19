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

import { createHash } from "node:crypto";

import {
  formatRunGroupRange,
  groupConsecutiveRuns,
} from "@/lib/domain/run-grouping";
import type { AdminDb } from "@/lib/supabase/admin-db";

import { kstDayKey, minutesFromKstDay } from "@/lib/time/kst-wallclock";

import { DIVIDER, lines } from "../lib/plaintext";
import type { BotOutboxAckResult, BotOutboxMessage } from "../types";

import {
  fetchChannelDigestMinutes,
  fetchRoomDayRuns,
} from "./bot-repo";
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

/**
 * 때가 된 파티 런 알림을 아웃박스에 적재한다.
 *
 * 판정(어느 런이 · 몇 분 전 회차가 · 아직 안 나갔는지)은 전부 DB `enqueue_due_reminders`
 * 가 갖는다. 여기서 조건을 다시 적으면 문구·중복·만료 규칙이 두 벌이 된다.
 *
 * @returns 새로 적재된 건수. 0 은 **정상**이다(때가 된 것이 없거나 이미 다 적재됨).
 */
export async function enqueueDueReminders(
  db: AdminDb,
  channelId: string,
  now: Date,
): Promise<number> {
  const result = await db.rpc("enqueue_due_reminders", {
    p_channel_id: channelId,
    p_now: now.toISOString(),
  });
  if (result.error !== null) {
    throw new Error(result.error.message);
  }
  return typeof result.data === "number" ? result.data : 0;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 등록 알림을 **한 번에 묶어서** 적재한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지적(2026-08-19): *"3개 한번에 추가했는데 여러번 보내는건 별로임. 일정 처럼 묶여야해"*
 *
 * 그전까지 `createPartyRuns` 가 만든 런마다 `enqueueRunNotice` 를 한 번씩 불렀고, 세 건을
 * 한 번에 등록하면 말풍선이 세 개 떴다. 등록은 **한 번의 행동**인데 알림이 세 번 오면
 * 방에서는 세 가지 일이 일어난 것으로 읽힌다.
 *
 * ★ 묶는 규칙은 `lib/domain/run-grouping.ts` 를 그대로 쓴다 — `!일정` 이 끊는 자리와
 *   등록 알림이 끊는 자리가 다르면, 같은 일정을 두 모양으로 기억하게 된다.
 * ★ 보스 줄은 여전히 DB `format_run_entry` 가 만든다. 앱이 조립하는 것은 **헤더와 배치**뿐이다.
 * ★ 런이 하나뿐이면 기존 단건 경로로 넘긴다. 묶을 것이 없는데 새 문구 모양을 만들면
 *   같은 뜻의 알림이 두 종류가 된다.
 */
export async function enqueueRunsCreatedNotice(
  db: AdminDb,
  runIds: readonly string[],
  now: Date,
): Promise<number> {
  if (runIds.length === 0) return 0;
  if (runIds.length === 1) {
    const only = runIds[0];
    return only === undefined ? 0 : enqueueRunNotice(db, only, "created");
  }

  try {
    const runRows = unwrap(
      await db
        .from("party_runs")
        .select("id,party_id,scheduled_at,duration_minutes,week_key")
        .in("id", [...runIds])
        .order("scheduled_at", { ascending: true, nullsFirst: false }),
      "등록 런 조회",
    );
    if (runRows.length === 0) return 0;

    const weekKey = runRows[0]?.week_key ?? "";
    const partyIds = [...new Set(runRows.map((row) => row.party_id))];

    const [numbers, entries] = await Promise.all([
      (async () =>
        unwrap(
          await db
            .from("party_room_numbers")
            .select("party_id,party_no")
            .in("party_id", partyIds)
            .eq("week_key", weekKey),
          "파티 번호 조회",
        ))(),
      Promise.all(
        runRows.map(async (row) => {
          const result = await db.rpc("format_run_entry", { p_run_id: row.id });
          return typeof result.data === "string" ? result.data : null;
        }),
      ),
    ]);
    const partyNoById = new Map(numbers.map((row) => [row.party_id, row.party_no]));

    const runs = runRows.flatMap((row, index) => {
      const entry = entries[index];
      if (entry === null || entry === undefined) return [];
      return [
        {
          partyId: row.party_id,
          scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at),
          durationMinutes: row.duration_minutes,
          partyNo: partyNoById.get(row.party_id) ?? null,
          entry,
        },
      ];
    });
    if (runs.length === 0) return 0;

    // 날짜를 언제나 적는다 — 등록 알림은 오늘 것이라는 보장이 없다.
    const body = groupConsecutiveRuns(runs).flatMap((group, index) => {
      const partyNo = group.find((run) => run.partyNo !== null)?.partyNo ?? null;
      const suffix = partyNo === null ? "" : ` · ${String(partyNo)}파티`;
      return [
        ...(index === 0 ? [] : [""]),
        `${formatRunGroupRange(group, null)}${suffix}`,
        ...group.map((run) => run.entry),
      ];
    });

    // `lines()` 가 줄을 잇고 평문 규칙(마크다운 금지·예산)까지 한 번에 건다.
    const reply = lines(
      `📌 일정 ${String(runs.length)}건 등록`,
      DIVIDER,
      ...body,
      DIVIDER,
    );

    /*
      같은 묶음을 두 번 적재하지 않도록 **런 id 집합에서 결정적으로** 키를 만든다.
      id 를 그대로 이으면 키가 길어지므로 해시로 접는다.
    */
    const dedupeKey = `run_created_batch:${createHash("sha256")
      .update([...runIds].sort().join(","), "utf8")
      .digest("hex")
      .slice(0, 40)}`;

    const channelIds = new Set<string>();
    for (const partyId of partyIds) {
      const result = await db.rpc("party_notify_channel_ids", { p_party_id: partyId });
      for (const id of (result.data ?? []) as string[]) channelIds.add(id);
    }
    if (channelIds.size === 0) return 0;

    const inserted = unwrap(
      await db
        .from("bot_outbox")
        .upsert(
          [...channelIds].map((channelId) => ({
            channel_id: channelId,
            dedupe_key: dedupeKey,
            reply,
            expires_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
            visible_after: now.toISOString(),
          })),
          { onConflict: "channel_id,dedupe_key", ignoreDuplicates: true },
        )
        .select("id"),
      "등록 알림 적재",
    );
    return inserted.length;
  } catch (error) {
    // 알림을 못 쌓았다고 방금 만든 일정을 되돌릴 수는 없다(단건 경로와 같은 기조).
    console.warn(
      `[bot] 등록 알림 묶음 적재 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 방 정기 알림 — `!알림 09시` 로 정한 시각에 그날 일정을 한 번
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ★ 런 오프셋 알림(`enqueue_due_reminders`)과 **다른 축**이다. 저쪽은 런마다, 이쪽은
 *   하루에 정해진 횟수. 그래서 dedupe 키도 런이 아니라 **(날짜, 시각)** 으로 만든다.
 * ★ **지난 시각을 소급해 보내지 않는다.** 서버가 종일 멈춰 있다가 저녁에 깨어나면 아침
 *   9시 알림은 이미 쓸모가 없다. 시각으로부터 60분이 지나면 건너뛴다.
 * ★ 그날 일정이 **없으면 보내지 않는다.** "오늘 일정 없음"을 매일 아침 받는 것은 알림이
 *   아니라 잡음이다.
 */
export async function enqueueDueDigests(
  db: AdminDb,
  channelId: string,
  now: Date,
): Promise<number> {
  const minutes = await fetchChannelDigestMinutes(db, channelId);
  if (minutes.length === 0) return 0;

  const dayKey = kstDayKey(now);
  const nowMinute = minutesFromKstDay(now, dayKey);

  /** 시각이 지난 뒤 이 시간까지만 유효하다. 늦게 깨어난 서버가 아침 알림을 저녁에 보내지 않게. */
  const GRACE_MINUTES = 60;
  const due = minutes.filter(
    (minute) => nowMinute >= minute && nowMinute - minute <= GRACE_MINUTES,
  );
  if (due.length === 0) return 0;

  const runs = await fetchRoomDayRuns(db, channelId, dayKey, now);
  if (runs.length === 0) return 0;

  const body = groupConsecutiveRuns(runs).flatMap((group, index) => {
    const partyNo = group.find((run) => run.partyNo !== null)?.partyNo ?? null;
    const suffix = partyNo === null ? "" : ` · ${String(partyNo)}파티`;
    return [
      ...(index === 0 ? [] : [""]),
      // 오늘 것이므로 날짜를 접는다 — 제목이 이미 "오늘"이라고 말한다.
      `${formatRunGroupRange(group, now)}${suffix}`,
      ...group.map((run) => run.entry),
    ];
  });
  const reply = lines("📅 오늘 일정", DIVIDER, ...body, DIVIDER);

  let inserted = 0;
  for (const minute of due) {
    const rows = unwrap(
      await db
        .from("bot_outbox")
        .upsert(
          {
            channel_id: channelId,
            dedupe_key: `room_digest:${dayKey}:${String(minute)}`,
            reply,
            // 그날이 끝나면 가치가 없다.
            expires_at: new Date(now.getTime() + GRACE_MINUTES * 60 * 1000).toISOString(),
            visible_after: now.toISOString(),
          },
          { onConflict: "channel_id,dedupe_key", ignoreDuplicates: true },
        )
        .select("id"),
      "정기 알림 적재",
    );
    inserted += rows.length;
  }
  return inserted;
}
