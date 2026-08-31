import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 개인톡 알림 — **파티와 상관없이 내 캐릭터가 걸린 모든 일정**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-31):
 *   *"개인톡으로 몇명만 가능하도록 해서 파티와상관없이 나와연관된 모든 알림을 주게"*
 *   *"내가 등록한 모든 일정에 대한 알림. 오늘 몇건 오늘 몇시 둘다. 직접지정"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이미 있던 알림과 무엇이 다른가 — **축이 방이 아니라 사람이다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `outbox.ts` 의 `enqueueDueReminders` · `enqueueDueDigests` 는 **방**을 기준으로 돈다:
 * 그 방에 묶인 파티의 런만 본다. 그래서 내 파티들이 서로 다른 방에 묶여 있으면 알림도
 * 갈라지고, 아예 방에 안 묶인 파티(웹 전용)는 알림이 없다. 발주 지시는 그 반대다 —
 * **`run_signups.status = 'going'` 하나가 조건**이고 파티가 어디에 묶였는지는 보지 않는다.
 * 그 조회를 이미 `user_week_runs`(→ `fetchMyRuns`)가 하고 있으므로 새 조회를 만들지 않았다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 예약 테이블이 없는 이유 · 게이트가 있는 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * · **예약 없음** — `bot_outbox` 의 `(channel_id, dedupe_key)` 유니크 인덱스가 멱등성을
 *   이미 보장한다. 같은 키를 두 번 넣으면 두 번째가 DB 에서 거부되므로, 크론이 두 번
 *   돌아도 방에는 한 번만 나간다. 예약 표를 두면 일정이 바뀔 때 예약을 지우는 코드와
 *   그 정합성 문제가 새로 생기고, 사는 것은 없다.
 * · **게이트 있음** — 크론이 10분 주기라 하루 144번이다. 그때마다 HTTP 를 때리면 보낼
 *   것이 없는 대부분이 헛돈다. `bot_direct_notify_pending()` 이 참일 때만 이 코드가
 *   불린다(마이그레이션 `20260831120100`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SQL 이 "누구"를, 이 파일이 "무엇을" 정한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 연속 런 묶기 규칙(`lib/domain/run-grouping.ts`)은 웹 시간표와 `!일정` 이 함께 쓰는
 * TS 함수다. SQL 에 같은 규칙을 또 쓰면 그날부터 봇과 화면이 다른 묶음을 그린다.
 * 그래서 SQL 은 **"지금 이 사람에게 보낼 것이 있다"까지만** 답하고, 어느 묶음을 어떤
 * 문구로 보낼지는 여기서 다시 계산한다.
 *
 * ⚠️ 그 결과 **SQL 이 참인데 여기서 0건**인 경우가 정상적으로 생긴다. 한 묶음에 런이
 *    여럿이면 SQL 은 런마다 발사 시각을 보지만 우리는 **묶음의 첫 런**으로만 보내기
 *    때문이다. 손해는 HTTP 한 번이다. 반대 방향(SQL 이 거짓인데 보낼 것이 있는 경우)은
 *    알림이 조용히 사라지는 것이라 절대 허용하지 않는다 — SQL 조건이 항상 더 넓다.
 */

import {
  groupConsecutiveRuns,
  groupRuns,
  type RunGroup,
} from "@/lib/domain/run-grouping";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";

import { DIVIDER, clipList, lines } from "../lib/plaintext";
import {
  fetchGoingCounts,
  fetchMyRuns,
  fetchNotificationPrefs,
  listDirectNotifyTargets,
  type MyRun,
} from "./bot-repo";
import { enqueueOne } from "./outbox";

/**
 * 크론 주기(분). **DB `bot_notify_tick_minutes()` 와 같은 값이어야 한다.**
 * 이 값이 발사 창의 폭이다 — 좁히면 어느 틱에도 안 걸리는 사각이 생긴다.
 */
const TICK_MINUTES = 10;

/**
 * 임박 알림이 스스로 죽는 시간(분). 만료 시각은 `min(시작 시각, 발사 시각 + 이 값)` 이다.
 *
 * ⚠️ **10분이 아니라 20분인 이유**(파티방 리마인더와 다르다). 파티방 쪽은 런너가 30초~5분
 *    간격으로 폴링하는 **그 순간에** 적재되므로 적재와 배달 사이가 거의 0이다. 개인톡은
 *    적재하는 쪽이 **크론(10분 주기)**이고 가져가는 쪽이 **폴링(최대 5분)**이라 둘이
 *    따로 논다 — 발사 창의 끝(+10분)에 적재된 건은 만료가 1분밖에 안 남아 그대로 사라진다.
 *    실제로 그렇게 만들었다가 알림이 조용히 유실되는 구조였다.
 *    10(크론 창) + 5(폴링 상한) + 여유 5 = 20.
 *
 * ★ 그래도 **시작 시각을 넘기지 않는다.** 보스가 시작한 뒤 도착하는 "곧 시작합니다"는
 *   알림이 아니라 오작동이다. 문구의 "약 N분 뒤"는 적재 시점 기준이라 배달이 늦으면
 *   그만큼 어긋나는데, 그 오차의 상한이 곧 이 값이고 그래서 **"약"** 이라고 적는다.
 */
const IMMINENT_GRACE_MINUTES = 20;

/**
 * 요약이 유효한 시간(분). `outbox.ts` 의 방 정기 알림(`GRACE_MINUTES = 60`)과 같은 값이다.
 * 규칙을 둘로 나눌 이유가 없다 — 아침 요약이 정오에 도착하면 이미 지난 일정이 섞인다.
 */
const DIGEST_GRACE_MINUTES = 60;

export interface DirectNotifySummary {
  /** 게이트가 골라 준 사람 수. */
  readonly targets: number;
  /** 실제로 아웃박스에 새로 들어간 건수. 0 은 **정상**이다(위 ⚠️ 참고). */
  readonly inserted: number;
}

/**
 * 게이트가 참일 때 크론이 부른다(`GET /api/bot/notify`).
 *
 * ⚠️ **한 사람이 실패해도 나머지는 보낸다.** 개인톡은 사람마다 독립이라, 하나가
 *    터졌다고 전부 멈추면 무관한 사람의 알림이 사라진다.
 */
export async function runDirectNotifications(
  db: AdminDb,
  now: Date,
): Promise<DirectNotifySummary> {
  const targets = await listDirectNotifyTargets(db, now);
  let inserted = 0;

  for (const target of targets) {
    try {
      inserted += await notifyOne(db, target, now);
    } catch (error) {
      console.warn(
        `[bot] 개인톡 알림 실패(channel=${target.channelId}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return { targets: targets.length, inserted };
}

async function notifyOne(
  db: AdminDb,
  target: {
    readonly userId: string;
    readonly channelId: string;
    readonly imminent: boolean;
    readonly digest: boolean;
  },
  now: Date,
): Promise<number> {
  const [runs, prefs] = await Promise.all([
    loadUpcomingRuns(db, target.userId, now),
    fetchNotificationPrefs(db, target.userId),
  ]);
  if (runs.length === 0) return 0;

  const goingCounts = await fetchGoingCounts(
    db,
    runs.map((run) => run.runId),
  );

  let inserted = 0;
  if (target.imminent && prefs.leadMinutes !== null) {
    inserted += await enqueueImminent(
      db,
      target.channelId,
      target.userId,
      runs,
      goingCounts,
      prefs.leadMinutes,
      now,
    );
  }
  if (target.digest) {
    inserted += await enqueueDigest(
      db,
      target.channelId,
      target.userId,
      runs,
      goingCounts,
      now,
    );
  }
  return inserted;
}

/**
 * 앞으로 있을, 아직 안 잡은 내 런.
 *
 * ★ **주차를 두 개 읽는다.** 주 경계가 KST 목요일 00:00 이라(§1), 수요일 23:45 에
 *   30분 뒤 일정은 **다음 주차 키**에 들어 있다. 이번 주만 읽으면 목요일로 넘어가는
 *   런이 통째로 안 보이고, 하필 그게 주간 보스가 몰리는 시각이다.
 * ★ **이미 잡은 런은 뺀다.** `!일정` 과 같은 규칙이다 — 할 일 목록이지 트로피 진열장이
 *   아니다. 여기서 안 거르면 다 돌고 자는 사람을 30분 전에 깨운다.
 * ★ 시각 미정 런도 뺀다. "몇 시에 온다"를 말할 수 없으면 알릴 것이 없다.
 */
async function loadUpcomingRuns(
  db: AdminDb,
  userId: string,
  now: Date,
): Promise<readonly MyRun[]> {
  const [thisWeek, nextWeek] = await Promise.all([
    fetchMyRuns(db, userId, { kind: "week", weekOffset: 0 }, now),
    fetchMyRuns(db, userId, { kind: "week", weekOffset: 1 }, now),
  ]);

  const byId = new Map<string, MyRun>();
  for (const run of [...thisWeek, ...nextWeek]) {
    if (run.cleared) continue;
    if (run.scheduledAt === null) continue;
    if (run.scheduledAt.getTime() <= now.getTime()) continue;
    byId.set(run.runId, run);
  }

  return [...byId.values()].sort(
    (a, b) => (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0),
  );
}

/**
 * 임박 — **묶음 단위로 한 번.** 런마다 보내지 않는다.
 *
 * 20분 간격 네 보스를 이어 도는데 런마다 "30분 뒤"가 오면 알림이 네 번 온다. 파티방
 * 리마인더가 이미 같은 이유로 묶음 단위이고(`outbox.ts`), 규칙도 같은 함수를 쓴다.
 *
 * ★ dedupe_key 는 **묶음의 첫 런**으로 잡는다(`run:<run_id>:user:<user_id>:imminent`).
 *   앞에 런이 추가되면 묶음이 달라지므로 키도 달라진다 — 그때는 다시 한 번 나가는 것이
 *   맞다. 사람이 "앞에 하나 더 붙었다"는 사실을 알아야 하기 때문이다.
 * ★ 문구의 "약 N분 뒤"는 **설정한 리드타임이 아니라 실제 남은 시간**이다. 크론이 10분
 *   주기라 리드타임을 그대로 적으면 최대 10분 틀린 말을 하게 된다.
 */
async function enqueueImminent(
  db: AdminDb,
  channelId: string,
  userId: string,
  runs: readonly MyRun[],
  goingCounts: ReadonlyMap<string, number>,
  leadMinutes: number,
  now: Date,
): Promise<number> {
  let inserted = 0;

  for (const chunk of groupConsecutiveRuns(runs)) {
    const first = chunk[0];
    if (first === undefined || first.scheduledAt === null) continue;

    const startMs = first.scheduledAt.getTime();
    const fireMs = startMs - leadMinutes * 60_000;
    // 아직 이르다 / 이미 창을 지났다.
    if (now.getTime() < fireMs) continue;
    if (now.getTime() >= fireMs + TICK_MINUTES * 60_000) continue;

    const expiresAt = new Date(
      Math.min(startMs, fireMs + IMMINENT_GRACE_MINUTES * 60_000),
    );
    if (expiresAt.getTime() <= now.getTime()) continue;

    const group = groupRuns(chunk, now)[0];
    if (group === undefined) continue;

    const remainMinutes = Math.max(1, Math.round((startMs - now.getTime()) / 60_000));
    const reply = lines(
      `⏰ 약 ${String(remainMinutes)}분 뒤 · ${group.range}`,
      DIVIDER,
      ...clipList([...group.lines], 8),
      partyLine(group, chunk, goingCounts),
    );

    inserted += await enqueueOne(db, {
      channelId,
      dedupeKey: `run:${first.runId}:user:${userId}:imminent`,
      reply,
      expiresAt,
      now,
    });
  }

  return inserted;
}

/**
 * 오늘 요약 — 하루 한 통. 발주 지시의 *"오늘 몇건 오늘 몇시"* 가 이것이다.
 *
 * ★ **오늘 남은 것만** 담는다. 이미 지난 시각을 아침 요약처럼 늘어놓으면 읽는 사람이
 *   무엇을 해야 하는지 알 수 없다.
 * ★ 일정이 없는 날은 **아예 보내지 않는다**(호출부에서 `runs` 가 비면 여기 오지 않고,
 *   여기서도 오늘 것이 0건이면 0을 돌려준다). "오늘 일정 없음"을 매일 아침 받는 것은
 *   잡음이다 — 방 정기 알림과 같은 판단이다.
 * ★ 건수는 **런 수**다(묶음 수가 아니다). `오늘 3건` 인데 줄이 두 개인 것은 세 보스를
 *   이어 도는 묶음이 하나 있다는 뜻이고, 그 사실은 줄 안에 그대로 보인다.
 */
async function enqueueDigest(
  db: AdminDb,
  channelId: string,
  userId: string,
  runs: readonly MyRun[],
  goingCounts: ReadonlyMap<string, number>,
  now: Date,
): Promise<number> {
  const dayKey = kstDayKey(now);
  const today = runs.filter(
    (run) => run.scheduledAt !== null && kstDayKey(run.scheduledAt) === dayKey,
  );
  if (today.length === 0) return 0;

  const body = groupConsecutiveRuns(today).flatMap((chunk, index) => {
    const group = groupRuns(chunk, now)[0];
    if (group === undefined) return [];
    return [
      // 묶음 사이는 빈 줄 하나. `!일정` 답장과 같은 모양이라 방에서 같은 것으로 읽힌다.
      ...(index === 0 ? [] : [""]),
      `${group.range}${partySuffix(group, chunk, goingCounts)}`,
      ...group.lines,
    ];
  });

  const reply = lines(
    `🔔 오늘 ${String(today.length)}건`,
    DIVIDER,
    ...clipList(body, 14),
  );

  return enqueueOne(db, {
    channelId,
    dedupeKey: `user:${userId}:digest:${dayKey}`,
    reply,
    expiresAt: new Date(now.getTime() + DIGEST_GRACE_MINUTES * 60_000),
    now,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티 표기 — 이름 + 인원
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ **번호가 아니라 이름을 적는다.** `party_no` 는 방+주차 안에서만 유일해서 파티가
//   하나뿐인 방에서는 모든 줄이 `1파티` 로 찍혀 아무것도 구분하지 못한다 — `!일정`
//   헤더와 등록 알림이 2026-08-21 에 같은 이유로 이름으로 바뀌었다(§0.2-1 형제 위치).
//   번호는 `!분배 1번 33` 처럼 **입력**에 쓰는 값이고 절대 재부여되지 않는다(§1.4).
// ★ 인원은 `going` 등록 수다. 1/n 분배의 분모이자 "몇 명이 가나"에 답한다.

function goingCount(
  chunk: readonly MyRun[],
  goingCounts: ReadonlyMap<string, number>,
): number | null {
  const first = chunk[0];
  if (first === undefined) return null;
  return goingCounts.get(first.runId) ?? null;
}

/** `콜라이제없어 · 3인` — 임박 알림의 마지막 줄. */
function partyLine(
  group: RunGroup,
  chunk: readonly MyRun[],
  goingCounts: ReadonlyMap<string, number>,
): string | null {
  const count = goingCount(chunk, goingCounts);
  const parts = [
    group.partyName === "" ? null : group.partyName,
    count === null ? null : `${String(count)}인`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** ` · 콜라이제없어 · 3인` — 요약에서는 시각 뒤에 붙인다. */
function partySuffix(
  group: RunGroup,
  chunk: readonly MyRun[],
  goingCounts: ReadonlyMap<string, number>,
): string {
  const line = partyLine(group, chunk, goingCounts);
  return line === null ? "" : ` · ${line}`;
}
