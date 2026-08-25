import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 매일 밤 예약 동기화 — **목요일 리셋 전에 그 주 기록을 확보한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"매일 저녁 23시 55분에 동기화를 돌린다고 치면"* ·
 * *"주간 최대 결정석이 차면 굳이 돌리지마"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 필요한가 — 실제로 하루치를 잃었다
 * ─────────────────────────────────────────────────────────────────────────────
 * 8/19 저녁에 돈 보스가 원장에 없다. 8/20 00:00(목) 주간 초기화가 지나면서 넥슨의
 * `complete_flag` 가 꺼졌고, API 는 "언제 깼는지"를 알려 주지 않으므로 **그 주 기록은
 * 영영 복구할 수 없다.** 사람이 자정 전에 앱을 열었어야만 남는 구조였다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 하지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **마지막 15분은 여전히 못 건진다.** 넥슨 데이터는 ~15분 지연된다(§1.1). 23:50 에
 *    돌면 대략 23:35 시점의 상태를 본다. 그 뒤에 잡은 보스는 이 작업으로도 못 가져오며,
 *    그건 우리가 고칠 수 있는 종류의 문제가 아니다.
 * ⚠️ **폴링이 아니다.** 하루 한 번이고, 대상은 아래 규칙으로 더 좁힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출량 (실측 기반)
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터 1명 = 넥슨 1콜. 현재 추적 28명(사람당 4~7명)이고 개발 키 한도는 **하루 1,000콜**
 * 이라, 밤 작업 한 번은 사람당 0.7% 수준이다. 실제 최대 사용일도 78콜이었다.
 * 초당 한도(5콜)는 **자격증명별로 간격을 벌려** 지킨다 — 아래 `KEY_GAP_MS`.
 */

import { buildServerNexonContext } from "@/features/auth/server/nexon-proxy";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";

import { syncCharacterScheduler } from "./sync-scheduler";

/**
 * 같은 **키**로 나가는 호출 사이의 최소 간격.
 *
 * 개발 키가 초당 5콜이라 200ms 가 딱 한도이고, 지터를 감안해 250ms(초당 4콜)로 둔다 —
 * 브라우저 쪽 `nexon-pacer` 와 같은 값이다. 키가 다르면 한도도 따로이므로 **키별로만**
 * 벌린다. 전부 직렬로 돌리면 28명이 7초를 그냥 흘려보낸다.
 */
const KEY_GAP_MS = 250;

/** 한 번의 실행이 만질 수 있는 최대 캐릭터 수. 폭주 방지용 상한이다. */
const MAX_CHARACTERS = 200;

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 작업이 **대표하는 시각** — 뜬 시각이 아니라 걸어 둔 시각
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"크론에 그냥 시간을 박아서 이 크론에서 잡힌건 그 시간으로
 * 무조건 박히게 만들어"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 뜬 시각을 못 쓰는가
 * ─────────────────────────────────────────────────────────────────────────────
 * **Vercel Hobby 크론은 ±59분 오차가 있다.** 공식 문서: *"Vercel cannot assure a timely
 * cron job invocation. (…) a cron job configured as `0 1 * * *` will trigger anywhere
 * between 1:00 am and 1:59 am."* (Hobby 정밀도 = **시간 단위**, 최소 간격 = **하루 1회**.)
 *
 * 그래서 `vercel.json` 에 23:55 로 걸어 둔 작업이 실제로는 **00:06 에 떴고**, 8/24 저녁에
 * 잡은 보스 50건(321억)이 전부 8/25 로 박혔다(2026-08-25 실측).
 *
 * 시각을 앞당기는 것만으로는 못 푼다 — 오차가 한 시간이라 자정을 확실히 피하려면 23:00
 * 이전으로 옮겨야 하고, 그러면 정작 저녁 클리어를 놓친다. 그래서 **판단을 시각이 아니라
 * 규칙으로** 옮긴다: 이 작업이 발견한 클리어는 언제 떴든 **걸어 둔 시각**에 박힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 어느 **날**의 23:55 인가 — 뜬 시각에서 오차 폭만큼 되돌린다
 * ─────────────────────────────────────────────────────────────────────────────
 * 오차가 0 ~ +59분이므로 실제 실행은 `23:55 ~ 00:54` 사이다. 거기서 **1시간을 빼면**
 * 어느 경우든 걸어 둔 그 날로 떨어진다.
 *   23:56 − 1h = 22:56 → 그날 ✓      00:06 − 1h = 23:06 → 전날 ✓
 *   00:54 − 1h = 23:54 → 전날 ✓
 * 그 날의 23:55 를 이 실행의 명목 시각으로 삼는다.
 *
 * ⚠️ `vercel.json` 의 cron 식과 **같은 값이어야 한다.** 한쪽만 고치면 명목 시각이 실제
 *    의도와 어긋난다. 항상 함께 고칠 것 — cron 식 · 아래 `CRON_SLOTS`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 목요일만은 **명목으로도 못 구한다** — 그래서 수요일에 한 번 더 일찍 돈다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-08-25): *"목요일 넘어갈때만좀 확실히 해야될거같은데. 목 새벽에 잡히는건
 * 어떡함?"*
 *
 * 명목 시각은 **주차 배정**을 고쳐 준다(`recordApiClears` 참고). 고치지 못하는 것이 하나
 * 남는다 — **주간 초기화가 넥슨 쪽에 반영되고 나면 볼 것이 없다.** 목요일 00:00 을 지나
 * 초기화가 API 에 도착하면 `complete_flag` 가 전부 `false` 라, 수요일에 잡은 보스는
 * 어느 시각으로 박을지 이전에 **존재 자체가 사라진다.** 늦게 뜬 실행은 빈손으로 돌아온다.
 *
 * `55 14 * * *` 의 실제 실행 창은 `23:55 ~ 00:54` 이고 그 대부분이 자정 **뒤**다.
 * 다른 요일에는 상관없다(주간 `complete_flag` 는 그 주 내내 남는다). 수요일 밤만 다르다.
 *
 * 그래서 **수요일에만** 초기화 전 창을 따로 둔다(`preReset` 슬롯 = 명목 23:00 KST).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `preReset` 은 **한 번이 아니라 10분마다** 돈다 — 그리고 캐시를 건너뛴다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-08-25): *"수요일은 11시부터 10분마다 강제로 돌게할수있음?"*
 *
 * 한 번만 돌면 그 순간의 넥슨 스냅샷(≈15분 전)까지만 본다. 23:00 한 방이면 22:45 까지고,
 * 그 뒤 한 시간에 잡은 보스는 초기화와 함께 사라진다. 10분 간격으로 23:00~23:50 을 훑으면
 * 마지막 실행이 대략 **23:35까지**를 보고, 중간에 로그아웃·캐시샵을 거친 캐릭터는
 * 넥슨이 즉시 갱신하므로(§1.1) 그 자리에서 잡힌다.
 *
 * ★ 그래서 이 슬롯만 **서버 캐시를 건너뛴다**(`bypassCache`). 게이트웨이 캐시는 15분이고
 *   그 읽기는 TTL 을 다시 보지 않으므로, 우회하지 않으면 2·3번째 호출이 넥슨을 부르지도
 *   않고 첫 번째와 같은 바이트를 돌려준다 — 10분 간격이 그냥 사라진다.
 *   다른 슬롯은 우회하지 않는다. 캐시가 존재할 이유가 없어지고 쿼터만 타기 때문이다.
 *
 * ★ 비용은 캐릭터당 최대 6콜(23:00·10·20·30·40·50)이고, 12칸이 찬 캐릭터는 `selectCandidates`
 *   가 매 회차마다 다시 걸러 내므로 실제로는 회차가 갈수록 싸진다. 개발 키 1,000/일 기준
 *   추적 28명이라도 자릿수가 남는다.
 *
 * ⚠️ **Vercel Hobby 크론으로는 이 간격을 못 만든다** — 최소 간격이 하루 1회, 정밀도가
 *    시간 단위다. 그래서 10분 스윕은 **Supabase `pg_cron`** 이 이 라우트를 때려서 만든다
 *    (`supabase/migrations/20260825140000_pre_reset_sweep_cron.sql`).
 *    `vercel.json` 의 `0 14 * * 3` 은 그대로 남겨 둔다 — pg_cron 이 꺼져 있어도 수요일에
 *    최소 한 번은 돌게 하는 보험이다.
 *
 * ⚠️ 남는 구멍: 수요일 23:35 이후에 잡고 **로그아웃도 안 한** 클리어. 그 창은 런 종료 후
 *    자동 동기화와 화면의 '클리어 확인' 버튼이 맡는다 — 크론을 자정 뒤로 더 밀면 이 좁은
 *    구멍이 아니라 **하루치 전부**가 초기화에 쓸려 위험해지므로 여기서 더 밀지 않는다.
 */

/** Hobby 크론의 최대 지연(문서상 ±59분). 넉넉하게 1시간으로 되돌린다. */
const CRON_DRIFT_MS = 60 * 60 * 1000;

interface CronSlotSpec {
  /** 이 슬롯이 **대표하는 KST 시각**(자정부터의 분). */
  readonly nominalMinuteKst: number;
  /** 15분 서버 캐시를 건너뛰는가. 반복해서 도는 슬롯만 참이다(머리말). */
  readonly bypassCache: boolean;
}

/**
 * 크론 슬롯 정의. **스케줄러 설정과 한 쌍이다** — 한쪽만 고치면 명목 시각이 어긋난다.
 *
 * · `nightly`  — `vercel.json` `55 14 * * *` = 매일 23:55 KST · 1회
 * · `preReset` — `pg_cron` `*\/10 14 * * 3` = 수요일 23:00~23:50 KST · 10분마다
 *                (+ `vercel.json` `0 14 * * 3` 이 같은 슬롯의 보험으로 한 번 더)
 */
export const CRON_SLOTS = {
  nightly: { nominalMinuteKst: 23 * 60 + 55, bypassCache: false },
  preReset: { nominalMinuteKst: 23 * 60, bypassCache: true },
} as const satisfies Record<string, CronSlotSpec>;

export type CronSlot = keyof typeof CRON_SLOTS;

/**
 * 이 실행이 대표하는 시각. 뜬 시각이 언제든 **걸어 둔 그 날의 그 시각(KST)**.
 *
 * 오차가 0 ~ +59분이므로 1시간을 빼면 어느 슬롯이든 걸어 둔 그 날로 떨어진다.
 */
function nominalRunAt(firedAt: Date, slot: CronSlot): Date {
  const intendedDay = kstDayKey(new Date(firedAt.getTime() - CRON_DRIFT_MS));
  return kstMoment(intendedDay, CRON_SLOTS[slot].nominalMinuteKst);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NightlySyncSummary {
  /** 실제로 넥슨을 부른 캐릭터 수. */
  readonly synced: number;
  /** 주간 상한이 이미 찬 등의 이유로 **부르지 않은** 캐릭터 수. */
  readonly skipped: number;
  /** 호출은 했지만 실패한 캐릭터 수. 한 건의 실패가 나머지를 막지 않는다. */
  readonly failed: number;
  /** 서버에 키가 없어 부를 수 없었던 캐릭터 수(브라우저에만 키가 있는 옛 사용자). */
  readonly noServerKey: number;
  readonly elapsedMs: number;
}

interface Candidate {
  readonly characterId: string;
  readonly userId: string;
  readonly characterName: string;
  readonly credentialId: string;
}

/**
 * 오늘 밤 부를 캐릭터.
 *
 * ★ **주간 결정석 상한이 찼으면 부르지 않는다** (발주 지시: *"주간 최대 결정석이 차면 굳이
 *   돌리지마"*). 12칸이 다 찬 캐릭터는 이번 주에 더 나올 주간 클리어가 없다.
 * ★ 다만 상한만 보고 끊으면 **월간 보스를 놓친다.** 검은 마법사는 12칸을 쓰지 않으므로
 *   (§1) 주간이 꽉 찬 뒤에 잡을 수 있다. 그래서 "이번 달에 아직 기록되지 않은 월간 계획이
 *   하나도 없을 때"만 건너뛴다.
 * ★ 일간은 추적 범위 밖이라(§1, 2026-08-18) 판단에 넣지 않는다.
 */
async function selectCandidates(
  db: AdminDb,
  now: Date,
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly skipped: number;
}> {
  const weekKey = getWeekKey(now);
  const monthStart = kstMoment(`${kstDayKey(now).slice(0, 7)}-01`, 0);

  /*
    ★ **추적 캐릭터를 먼저 고른다.** `v_character_sync_source` 는 계정의 **모든** 캐릭터를
      담고 있어(실측 651행) 뷰에 `limit` 을 먼저 걸면 앞쪽 200행만 보게 되고, 그중 추적
      대상이 몇이나 들었는지는 **정렬 운**이다. 실제로 처음 돌렸을 때 28명 중 6명만 돌았다.
      상한은 "추적 캐릭터가 너무 많을 때"를 막으라고 둔 값이지 대상을 잘라 내라는 값이
      아니므로, 필터를 먼저 적용하고 그 결과에 상한을 건다.
  */
  const trackedResult = await db
    .from("characters")
    .select("id")
    .eq("is_tracked", true)
    .not("ocid", "is", null)
    .limit(MAX_CHARACTERS);
  if (trackedResult.error !== null) {
    console.error(
      `[nightly-sync] 추적 캐릭터 조회 실패: ${trackedResult.error.message}`,
    );
    return { candidates: [], skipped: 0 };
  }
  const characterIds = (trackedResult.data ?? []).map((row) => row.id);
  if (characterIds.length === 0) return { candidates: [], skipped: 0 };

  const sourceResult = await db
    .from("v_character_sync_source")
    .select("character_id,user_id,character_name,ocid,credential_id,allow_server_side_use")
    .in("character_id", characterIds)
    .not("ocid", "is", null)
    .not("credential_id", "is", null);
  if (sourceResult.error !== null) {
    console.error(
      `[nightly-sync] 동기화 대상 조회 실패: ${sourceResult.error.message}`,
    );
    return { candidates: [], skipped: 0 };
  }

  const rows = (sourceResult.data ?? []).filter(
    (row) => row.allow_server_side_use !== false,
  );
  if (rows.length === 0) return { candidates: [], skipped: 0 };

  const [weeklyResult, planResult, monthlyClearResult, limitResult] =
    await Promise.all([
      db
        .from("boss_clears")
        .select("character_id,boss_difficulty_id")
        .in("character_id", characterIds)
        .eq("week_key", weekKey)
        .eq("effective_cleared", true),
      db
        .from("character_boss_plans")
        .select("character_id,boss_difficulty_id")
        .in("character_id", characterIds)
        .eq("is_active", true),
      db
        .from("boss_clears")
        .select("character_id,boss_difficulty_id")
        .in("character_id", characterIds)
        .eq("effective_cleared", true)
        .gte("cleared_at", monthStart.toISOString()),
      db.rpc("weekly_crystal_sell_limit"),
    ]);

  const tracked = new Set(characterIds);
  /** 주간 상한. DB 가 소유하는 값이라 **여기에 12 를 적지 않는다**(§1). */
  const weeklyLimit =
    typeof limitResult.data === "number" && limitResult.data > 0
      ? limitResult.data
      : Number.POSITIVE_INFINITY;

  const { getBossEntryMap } = await import("@/lib/boss-master");
  const allBossIds = [
    ...new Set([
      ...(weeklyResult.data ?? []).map((row) => row.boss_difficulty_id),
      ...(planResult.data ?? []).map((row) => row.boss_difficulty_id),
      ...(monthlyClearResult.data ?? []).map((row) => row.boss_difficulty_id),
    ]),
  ];
  const cycles = getBossEntryMap(allBossIds);

  /** 캐릭터별 이번 주 주간 클리어 수. */
  const weeklyCount = new Map<string, number>();
  for (const row of weeklyResult.data ?? []) {
    if (row.character_id === null) continue;
    if (cycles.get(row.boss_difficulty_id)?.cycle !== "weekly") continue;
    weeklyCount.set(row.character_id, (weeklyCount.get(row.character_id) ?? 0) + 1);
  }

  /** 이번 달에 이미 기록된 (캐릭터, 월간 보스). */
  const monthlyDone = new Set(
    (monthlyClearResult.data ?? [])
      .filter(
        (row) =>
          row.character_id !== null &&
          cycles.get(row.boss_difficulty_id)?.cycle === "monthly",
      )
      .map((row) => `${String(row.character_id)}:${row.boss_difficulty_id}`),
  );

  /** 아직 이번 달 기록이 없는 월간 계획이 남아 있는 캐릭터. */
  const monthlyPending = new Set<string>();
  for (const row of planResult.data ?? []) {
    if (cycles.get(row.boss_difficulty_id)?.cycle !== "monthly") continue;
    if (monthlyDone.has(`${row.character_id}:${row.boss_difficulty_id}`)) continue;
    monthlyPending.add(row.character_id);
  }

  const candidates: Candidate[] = [];
  let skipped = 0;

  for (const row of rows) {
    const characterId = row.character_id;
    const userId = row.user_id;
    const credentialId = row.credential_id;
    if (characterId === null || userId === null || credentialId === null) continue;
    if (!tracked.has(characterId)) continue;

    const full = (weeklyCount.get(characterId) ?? 0) >= weeklyLimit;
    if (full && !monthlyPending.has(characterId)) {
      skipped += 1;
      continue;
    }

    candidates.push({
      characterId,
      userId,
      characterName: row.character_name ?? characterId,
      credentialId,
    });
  }

  return { candidates, skipped };
}

/**
 * 밤 작업 본체.
 *
 * ★ **키별로 직렬**, 키끼리는 병렬이다. 초당 한도는 키마다 따로 걸리므로 서로 다른 키를
 *   기다릴 이유가 없고, 같은 키는 반드시 간격을 벌려야 429 가 나지 않는다(실측: 8/17 에
 *   `throttled_count = 1` 이 기록돼 있다).
 * ★ 한 캐릭터의 실패가 나머지를 막지 않는다. 밤에 도는 작업이 하나 때문에 통째로 멈추면
 *   아침에 아무것도 남아 있지 않다.
 */
export async function runNightlySync(
  now: Date = new Date(),
  slot: CronSlot = "nightly",
): Promise<NightlySyncSummary> {
  const startedAt = Date.now();
  const db = getAdminDb();
  /*
    이 실행이 대표하는 시각. **모든 캐릭터가 같은 값을 본다** — 22초에 걸쳐 도는 동안
    자정을 넘기면 앞뒤 캐릭터가 서로 다른 날에 박히기 때문이다.
  */
  const nominalAt = nominalRunAt(now, slot);
  /*
    ★ 후보 선별도 **명목 시각**으로 한다(2026-08-25). `now` 를 넘기면 목요일 00:06 에 뜬
      실행이 **새 주차**를 기준으로 12칸을 세게 되고, 그 주차에는 클리어가 아직 하나도 없어
      "다 찼으니 건너뛴다"가 통째로 무력화된다 — 결과가 기록될 주차(= 명목 주차)와 판단에
      쓰는 주차가 갈리면 안 된다. 월간 판정의 달 경계도 같은 이유로 함께 옮겨진다.
  */
  const { candidates, skipped } = await selectCandidates(db, nominalAt);

  const byCredential = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byCredential.get(candidate.credentialId) ?? [];
    list.push(candidate);
    byCredential.set(candidate.credentialId, list);
  }

  let synced = 0;
  let failed = 0;
  let noServerKey = 0;

  await Promise.all(
    [...byCredential.entries()].map(async ([credentialId, list]) => {
      const first = list[0];
      if (first === undefined) return;

      const context = await buildServerNexonContext({
        db,
        userId: first.userId,
        credentialId,
        // 10분마다 도는 슬롯만 참(머리말). 아니면 2회차부터 캐시가 같은 값을 돌려준다.
        bypassCache: CRON_SLOTS[slot].bypassCache,
      });
      if (context === null) {
        // 서버에 저장된 키가 없다. 오류가 아니라 "밤에는 건너뛴다"는 상태다(§2.1.2).
        noServerKey += list.length;
        return;
      }

      for (const [index, candidate] of list.entries()) {
        if (index > 0) await delay(KEY_GAP_MS);
        try {
          await syncCharacterScheduler(context, candidate.characterId, {
            clearedAtOverride: nominalAt,
          });
          synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(
            `[nightly-sync] ${candidate.characterName} 동기화 실패: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }),
  );

  return {
    synced,
    skipped,
    failed,
    noServerKey,
    elapsedMs: Date.now() - startedAt,
  };
}
