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
  groupBossesByRoster,
  groupConsecutiveRuns,
} from "@/lib/domain/run-grouping";
import type { AdminDb } from "@/lib/supabase/admin-db";

import {
  DAY_MINUTES,
  kstDayKey,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";

import { DIVIDER, lines } from "../lib/plaintext";
import type { BotOutboxAckResult, BotOutboxMessage } from "../types";

import {
  fetchChannelDigestMinutes,
  fetchPartyReminderMinutes,
  fetchRoomWeekRuns,
  type NoticeRun,
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

/*
  ⚠️ DB 함수 `enqueue_due_reminders` 를 부르던 래퍼가 여기 있었다. **지웠다.**
     그 함수는 런 **하나**를 기준으로 적재하는데, 발주자가 등록 알림에서 지적한 것과 같은
     이유로 리마인더도 **묶음 단위**여야 한다(20분 간격 네 보스면 "30분 전"이 네 번 온다).
     묶는 규칙은 TS(`groupConsecutiveRuns`)에 있으므로 적재도 앱으로 내려왔다.
     새 구현은 아래 `enqueueDueReminders` 다.
*/

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 알림 본문 — **세 알림이 같은 모양을 쓴다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 등록 알림 · 정기 알림 · 리마인더가 각자 다른 모양이면 방에서는 세 종류의 봇이 말하는
 * 것처럼 보인다. 그래서 본문 조립은 여기 하나뿐이다.
 *
 *   8/19(수) 21:40 ~ 22:40 · 1파티
 *   익세 하대 하카 :
 *   더저(무르겨르), 라온내일
 *   노유 :
 *   더저, 라온내일
 *
 * ★ **참가자 이름을 접지 않는다.** 카카오톡·텔레그램 키워드 알림은 메시지에 그 단어가
 *   있을 때만 울린다(발주 지시 2026-08-19). 이름이 접히면 접힌 사람에게는 알림이 가지
 *   않으므로, 알림의 목적 자체가 무너진다.
 * ★ 대신 **명단이 같은 보스끼리 한 줄로** 묶는다(`groupBossesByRoster`). 이름은 다 남기고
 *   되풀이만 없앤다.
 */
function renderNoticeBody(
  runs: readonly NoticeRun[],
  reference: Date | null,
): readonly string[] {
  return groupConsecutiveRuns(runs).flatMap((group, index) => {
    const partyNo = group.find((run) => run.partyNo !== null)?.partyNo ?? null;
    const suffix = partyNo === null ? "" : ` · ${String(partyNo)}파티`;
    return [
      ...(index === 0 ? [] : [""]),
      `${formatRunGroupRange(group, reference)}${suffix}`,
      ...groupBossesByRoster(group).flatMap((line) => [
        `${line.bosses.join(" ")} :`,
        line.roster,
      ]),
    ];
  });
}

/** 아웃박스에 한 건 넣는다. 이미 같은 키가 있으면 아무것도 하지 않는다. */
async function enqueueOne(
  db: AdminDb,
  input: {
    readonly channelId: string;
    readonly dedupeKey: string;
    readonly reply: string;
    readonly expiresAt: Date;
    readonly now: Date;
  },
): Promise<number> {
  const rows = unwrap(
    await db
      .from("bot_outbox")
      .upsert(
        {
          channel_id: input.channelId,
          dedupe_key: input.dedupeKey,
          reply: input.reply,
          expires_at: input.expiresAt.toISOString(),
          visible_after: input.now.toISOString(),
        },
        { onConflict: "channel_id,dedupe_key", ignoreDuplicates: true },
      )
      .select("id"),
    "알림 적재",
  );
  return rows.length;
}

/**
 * 등록 알림 — 한 번의 등록은 **한 번의 알림**이다.
 *
 * 발주 지적(2026-08-19): *"3개 한번에 추가했는데 여러번 보내는건 별로임."*
 * 등록은 한 번의 행동인데 알림이 세 번 오면 방에서는 세 가지 일로 읽힌다.
 *
 * ⚠️ **실패해도 던지지 않는다.** 알림을 못 쌓았다고 방금 만든 일정을 되돌릴 수는 없다.
 */
export async function enqueueRunsCreatedNotice(
  db: AdminDb,
  runIds: readonly string[],
  now: Date,
): Promise<number> {
  if (runIds.length === 0) return 0;

  try {
    const rows = unwrap(
      await db.from("party_runs").select("id,party_id").in("id", [...runIds]),
      "등록 런 조회",
    );
    const partyIds = new Set(rows.map((row) => row.party_id));
    const channels = new Set<string>();
    for (const partyId of partyIds) {
      const result = await db.rpc("party_notify_channel_ids", { p_party_id: partyId });
      for (const id of (result.data ?? []) as string[]) channels.add(id);
    }
    if (channels.size === 0) return 0;

    const wanted = new Set(runIds);
    const dedupeKey = `run_created_batch:${createHash("sha256")
      .update([...runIds].sort().join(","), "utf8")
      .digest("hex")
      .slice(0, 40)}`;

    let inserted = 0;
    for (const channelId of channels) {
      // 방 기준으로 다시 읽어 **그 방이 볼 수 있는 것만** 담는다.
      const all = await fetchRoomWeekRuns(db, channelId, now);
      const mine = all.filter((run) => wanted.has(run.runId));
      if (mine.length === 0) continue;

      const reply = lines(
        `📌 일정 ${String(mine.length)}건 등록`,
        DIVIDER,
        ...renderNoticeBody(mine, null),
        DIVIDER,
      );
      inserted += await enqueueOne(db, {
        channelId,
        dedupeKey,
        reply,
        expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        now,
      });
    }
    return inserted;
  } catch (error) {
    console.warn(
      `[bot] 등록 알림 적재 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

/**
 * 리마인더 — **묶음 단위**로 한 번. 런마다 보내지 않는다.
 *
 * 20분 간격으로 네 보스를 이어 도는데 런마다 "30분 전"이 오면 알림이 네 번 온다. 발주자가
 * 등록 알림에서 지적한 것과 **같은 문제**이므로 같은 규칙(`groupConsecutiveRuns`)으로 묶고,
 * 묶음의 **첫 런 기준**으로 시각을 잰다.
 *
 * ★ 늦게 적재된 알림은 스스로 죽는다 — 제 시각 +10분까지만 유효하다. 서버가 잠깐 멈췄다가
 *   T-3 에 깨어나 "30분 전"을 보내면 그건 거짓말이다.
 */
async function enqueueDueReminders(
  db: AdminDb,
  channelId: string,
  now: Date,
  runs: readonly NoticeRun[],
  offsetsByParty: ReadonlyMap<string, readonly number[]>,
): Promise<number> {
  if (runs.length === 0) return 0;

  const GRACE_MS = 10 * 60 * 1000;
  let inserted = 0;

  for (const group of groupConsecutiveRuns(runs)) {
    const first = group[0];
    if (first === undefined || first.scheduledAt === null) continue;
    const offsets = offsetsByParty.get(first.partyId) ?? [];
    if (offsets.length === 0) continue;

    const startMs = first.scheduledAt.getTime();
    for (const minutes of offsets) {
      const fireAt = startMs - minutes * 60 * 1000;
      if (now.getTime() < fireAt) continue;
      const expiresAt = new Date(Math.min(startMs, fireAt + GRACE_MS));
      if (expiresAt.getTime() <= now.getTime()) continue;

      const reply = lines(
        `⏰ ${String(minutes)}분 전`,
        DIVIDER,
        ...renderNoticeBody(group, now),
        DIVIDER,
      );
      inserted += await enqueueOne(db, {
        channelId,
        // 묶음은 **첫 런**으로 식별한다. 앞에 런이 추가되면 묶음이 달라지므로 키도 달라진다.
        dedupeKey: `run_remind:${first.runId}:T-${String(minutes)}`,
        reply,
        expiresAt,
        now,
      });
    }
  }
  return inserted;
}

/**
 * 방 정기 알림 — `!알림 09시` 로 정한 시각에 그날 일정을 한 번.
 *
 * ★ **지난 시각을 소급해 보내지 않는다.** 종일 멈춰 있던 서버가 저녁에 깨어나 아침 9시
 *   알림을 보내면 그건 알림이 아니라 오작동이다.
 * ★ 그날 일정이 **없으면 보내지 않는다.** "오늘 일정 없음"을 매일 아침 받는 것은 잡음이다.
 */
async function enqueueDueDigests(
  db: AdminDb,
  channelId: string,
  now: Date,
  runs: readonly NoticeRun[],
  minutes: readonly number[],
): Promise<number> {
  if (minutes.length === 0) return 0;

  const dayKey = kstDayKey(now);
  const nowMinute = minutesFromKstDay(now, dayKey);

  const GRACE_MINUTES = 60;
  const due = minutes.filter(
    (minute) => nowMinute >= minute && nowMinute - minute <= GRACE_MINUTES,
  );
  if (due.length === 0) return 0;

  const today = runs.filter(
    (run) => run.scheduledAt !== null && kstDayKey(run.scheduledAt) === dayKey,
  );
  if (today.length === 0) return 0;

  const reply = lines(
    "📅 오늘 일정",
    DIVIDER,
    ...renderNoticeBody(today, now),
    DIVIDER,
  );

  let inserted = 0;
  for (const minute of due) {
    inserted += await enqueueOne(db, {
      channelId,
      dedupeKey: `room_digest:${dayKey}:${String(minute)}`,
      reply,
      expiresAt: new Date(now.getTime() + GRACE_MINUTES * 60 * 1000),
      now,
    });
  }
  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────
// 폴링 간격 — **다음 알림까지의 거리로 정한다**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 최소 간격. 알림이 코앞일 때 쓰는 값이며 **예전의 고정값**이기도 하다.
 * 이보다 좁히지 않는 이유: 30초보다 촘촘해 봐야 사람이 체감하지 못하고 호출만 는다.
 */
const MIN_POLL_SEC = 30;

/**
 * 최대 간격. **줄이는 일의 대부분은 이 값이 한다.**
 *
 * 5분으로 잡은 근거는 실측이다(2026-08-20): 방 5개가 30초로 돌아 하루 14,400회를 두드리는데
 * 그중 실제로 보낼 것이 있던 경우는 거의 없었다 — 예정된 런이 0건이고 정기 알림은 방 하나에
 * 하루 한 번뿐이었다. 상한을 5분으로 두면 그 조용한 시간의 호출이 **1/10** 로 준다.
 *
 * ⚠️ 그런데도 알림이 늦지 않는 이유가 아래 `nextDueAt` 이다. 상한은 **아무 일도 예정되지
 *    않았을 때만** 적용되고, 발사 시각이 다가오면 간격이 저절로 좁아진다.
 */
const MAX_POLL_SEC = 300;

/**
 * 이 방에서 **다음으로 무언가 나갈 시각**. 없으면 `null`.
 *
 * ★ 적재(`enqueueDue*`)와 **같은 데이터·같은 규칙**을 쓴다. 시각 계산이 두 벌이 되면
 *   언젠가 한쪽만 고쳐지고, 그 순간 "화면이 말한 시각"과 "실제로 깨어나는 시각"이 갈린다.
 *   그래서 이 함수는 조회를 하지 않고 이미 읽어 둔 값만 받는다.
 * ★ 정기 알림은 **그날 일정이 있을 때만** 실제로 나가지만, 여기서는 그 조건을 보지 않는다.
 *   일찍 깨어나는 것은 무해하고(빈 응답 한 번), 늦게 깨어나는 것은 알림이 늦는 것이다.
 *   판단이 갈리면 **일찍 깨어나는 쪽**으로 기운다.
 */
function nextDueAt(
  now: Date,
  runs: readonly NoticeRun[],
  offsetsByParty: ReadonlyMap<string, readonly number[]>,
  digestMinutes: readonly number[],
): Date | null {
  const nowMs = now.getTime();
  let earliest: number | null = null;
  const consider = (ms: number) => {
    if (ms <= nowMs) return;
    if (earliest === null || ms < earliest) earliest = ms;
  };

  // 리마인더 — 적재와 **같은 묶음 규칙**(`groupConsecutiveRuns`)으로 첫 런 기준.
  for (const group of groupConsecutiveRuns(runs)) {
    const first = group[0];
    if (first === undefined || first.scheduledAt === null) continue;
    const offsets = offsetsByParty.get(first.partyId) ?? [];
    const startMs = first.scheduledAt.getTime();
    for (const minutes of offsets) consider(startMs - minutes * 60 * 1000);
  }

  // 정기 알림 — 오늘 남은 시각, 없으면 내일 첫 시각.
  if (digestMinutes.length > 0) {
    const dayKey = kstDayKey(now);
    for (const minute of digestMinutes) {
      consider(kstMoment(dayKey, minute).getTime());
      // 오늘 것이 이미 지났으면 내일 같은 시각이 다음 후보다(`+1440분`).
      consider(kstMoment(dayKey, minute + DAY_MINUTES).getTime());
    }
  }

  return earliest === null ? null : new Date(earliest);
}

export interface OutboxPumpResult {
  /** 이번 폴링에서 새로 적재된 알림 수. 진단용이며 응답에 싣지 않는다. */
  readonly inserted: number;
  /** 런너에게 돌려줄 다음 폴링 간격(초). */
  readonly pollIntervalSec: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 폴링 한 번이 하는 일 전부 — **적재하고, 다음에 언제 올지 정해 준다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 예전에는 라우트가 `enqueueDueReminders` 와 `enqueueDueDigests` 를 따로 불렀고, **둘 다
 * 이 방의 이번 주 런을 각자 읽었다** — 같은 조회가 폴링마다 두 번 나갔다. 이제 한 번 읽어
 * 둘에 나눠 주고, **같은 데이터로 다음 폴링 시각까지 계산한다.**
 *
 * ★ 조회는 3개(런 · 파티 오프셋 · 방 정기시각)로 예전과 같거나 적다. 폴링 자체가 줄어드는
 *   위에 조회도 늘지 않으므로 순수하게 이득이다.
 * ★ **보낼 것이 있으면 최소 간격**을 돌려준다. 한 번에 `MAX_PICKUP` 만 가져가므로 밀린 것이
 *   더 있을 수 있고, 그때 5분을 기다리게 하면 알림이 줄줄이 밀린다.
 */
export async function pumpChannelSchedule(
  db: AdminDb,
  channelId: string,
  now: Date,
  hasPendingDelivery: boolean,
): Promise<OutboxPumpResult> {
  const [runs, offsetsByParty, digestMinutes] = await Promise.all([
    fetchRoomWeekRuns(db, channelId, now),
    fetchPartyReminderMinutes(db, channelId),
    fetchChannelDigestMinutes(db, channelId),
  ]);

  const inserted =
    (await enqueueDueReminders(db, channelId, now, runs, offsetsByParty)) +
    (await enqueueDueDigests(db, channelId, now, runs, digestMinutes));

  if (hasPendingDelivery || inserted > 0) {
    return { inserted, pollIntervalSec: MIN_POLL_SEC };
  }

  const due = nextDueAt(now, runs, offsetsByParty, digestMinutes);
  if (due === null) return { inserted, pollIntervalSec: MAX_POLL_SEC };

  /*
    발사 시각에 **정확히 맞춰** 깨어나면 그 순간의 시계 오차로 한 박자 놓칠 수 있다.
    한 주기 일찍 깨우는 대신 `MIN_POLL_SEC` 을 하한으로 두어 늦지 않게 한다.
  */
  const seconds = Math.floor((due.getTime() - now.getTime()) / 1000);
  return {
    inserted,
    pollIntervalSec: Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, seconds)),
  };
}
