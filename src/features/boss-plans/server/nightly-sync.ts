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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 규모 한계는 **상한이 아니라 시간 예산**이 정한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-27): *"ㅇㅇ 상한 버셀 수파베이스 싹다 해봐"*.
 *
 * 예전 값은 **200** 이었고, 그것이 실질 수용 인원이었다 — 인당 6캐릭이면 33명에서
 * 막힌다. 더 나빴던 것은 **막히는 방식**이다: `.limit(200)` 이 조용히 잘라 내고,
 * 잘린 캐릭터는 아무도 다시 부르지 않으며, 로그에도 아무 흔적이 없었다.
 * "동기화가 안 된다"는 신고가 들어와도 원인을 볼 수가 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇이 실제로 시간을 먹는가 — 실측 (2026-08-27)
 * ─────────────────────────────────────────────────────────────────────────────
 * 자격증명(키)별로 **병렬**, 키 안에서는 250ms 간격 **직렬**이다. 그래서 벽시계 시간은
 * 사람 수가 아니라 **가장 긴 키의 캐릭터 수**가 정한다.
 *
 *     추적 36캐릭 / 키 10개 / 가장 큰 키 6캐릭 → 13.9초
 *     13.9초 ÷ 6캐릭 = 캐릭터당 **약 2.3초** (250ms 간격 + 넥슨 왕복 + DB 쓰기)
 *
 * 즉 **인당 6캐릭이면 사람이 몇이 늘어도 각 갈래는 ~14초**다. 늘어나는 것은 갈래의
 * 수뿐이라, 진짜 위험은 "오래 걸린다"가 아니라 **한꺼번에 너무 많이 쏜다**이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 세 가지로 나눠 막는다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `MAX_CHARACTERS`         — 사고 방지선. 용량 한도가 아니다.
 *   · `START_BUDGET_MS`        — **시간**으로 끊는다. 넘으면 잘라 내는 것이 아니라
 *                                **다음 시간으로 미룬다**(`deferred`).
 *   · `MAX_PARALLEL_CREDENTIALS` — 동시에 진행하는 갈래 수.
 *
 * ★ 어느 쪽으로 끊기든 **반드시 숫자로 보고한다.** 조용히 줄이는 것이 이번 변경이
 *   없애려는 결함 그 자체다.
 */

/**
 * 한 번의 실행이 만질 수 있는 최대 캐릭터 수 — **폭주 방지선**.
 *
 * 200 → 2000. 이 값은 이제 "수용 인원"이 아니라 "질의가 미쳤을 때의 안전핀"이다.
 * 실제 종료 조건은 아래 시간 예산이 맡는다. 인당 6캐릭 기준 **333명**분이라,
 * 여기에 닿기 전에 시간 예산이 먼저 걸린다 — 그게 의도한 순서다.
 */
const MAX_CHARACTERS = 2000;

/**
 * **새 캐릭터를 시작할 수 있는** 시간. 이미 시작한 캐릭터는 끝까지 간다.
 *
 * 바깥 한도가 두 겹이다: pg_net `timeout_milliseconds = 55000`, Vercel `maxDuration = 60`.
 * 둘 중 짧은 쪽(55초) 안에서 **응답까지** 끝나야 하므로, 마지막 캐릭터 한 명분(~2.3초)과
 * 응답 직렬화 여유를 두고 **40초**에서 새 출발을 멈춘다.
 *
 * ★ 잘라 내는 것이 아니라 **미루는 것**이다. 크론이 매시 돌고 후보를 `last_synced_at`
 *   오래된 순으로 뽑으므로, 이번에 밀린 캐릭터가 **다음 시간에 맨 앞**에 선다.
 *   상한으로 자르면 같은 캐릭터가 영원히 잘리지만, 이 방식은 한 바퀴가 보장된다.
 */
const START_BUDGET_MS = 40_000;

/**
 * 동시에 진행하는 **자격증명(키)** 수 상한.
 *
 * 키가 다르면 넥슨 한도도 따로라 병렬 자체는 옳다. 다만 100명이 붙으면 하나의
 * Vercel 함수가 **바깥 HTTP 100 갈래**를 동시에 들게 되고, 그때 느려지는 것은
 * 넥슨 왕복이 아니라 우리 쪽 DB 왕복이다(PostgREST 처리량). 24 갈래 × 6캐릭이면
 * 한 물결이 ~14초라, 40초 예산 안에서 **두 물결 이상**이 돈다.
 */
const MAX_PARALLEL_CREDENTIALS = 24;

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 이 작업이 **대표하는 시각**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 지금은 **매시 50분**에 돈다 (발주 지시 2026-08-25)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"밤 11시 크론 없애고 그냥 매 시간 50분에 크론돌리는게 낫지않나? 결국 아침에
 * 돈사람들은 자동으로 !결정석 했을때 못보네"*
 *
 * 정확한 지적이었다. 밤에만 돌면 아침에 잡은 보스가 **그날 밤까지 어디에도 안 보인다** —
 * `!결정석`·수익 화면·체크리스트가 전부 하루 늦는다. 동기화는 "하루를 마감하는 일"이
 * 아니라 "따라가는 일"이라, 주기가 짧을수록 맞다.
 *
 * 값이 싼 것도 확인했다(실측 2026-08-26):
 *   · 저장 공간 **0 증가.** `character_scheduler_snapshots.snapshot_at` 은 넥슨 관측일
 *     (그날 00:00 KST)이라 **하루 한 행을 덮어쓴다.** 29캐릭 × 24회를 돌려도 29행이다.
 *   · 넥슨 호출은 자격증명마다 `캐릭터 수 × 24`. 가장 큰 키가 6캐릭이라 144/일이고
 *     개발 키 한도는 1,000/일이다. 12칸이 찬 캐릭터는 애초에 건너뛴다.
 *   · 실행 시간 회당 ~11초 → 하루 4~5분.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 **명목 시각이 필요 없어졌다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 명목 시각(`nominalMinuteKst`)은 원래 **Vercel Hobby 크론의 ±59분 오차**를 지우려고
 * 만든 장치다. 공식 문서: *"Vercel cannot assure a timely cron job invocation."*
 * 실제로 23:55 로 걸어 둔 작업이 00:06 에 떠서, 8/24 저녁에 잡은 보스 50건(321억)이
 * 전부 8/25 로 박혔다(2026-08-25 실측).
 *
 * 지금 도는 것은 **pg_cron** 이라 흔들리지 않는다. 지울 오차가 없으므로 명목을 쓰지
 * 않고 **뜬 시각을 그대로** 쓴다 — 오히려 그쪽이 정확하다. 아침에 잡은 보스를 밤 23:55
 * 로 적을 이유가 없다.
 *
 * ★ 목요일 경계도 저절로 풀린다. 매시 도는 상황에서 마지막 pre-reset 실행은 **수 23:50**
 *   이고 그 값은 수요일 주차다. 목 00:50 실행은 이미 초기화된 데이터를 보므로
 *   `complete_flag` 가 전부 false — **기록할 것 자체가 없다.** 예전의 명목/주차 보정과
 *   수요일 10분 스윕은 이 구조에서 할 일이 없어졌다.
 *
 * ⚠️ `nightly` 슬롯과 오차 보정 코드는 **남겨 둔다.** 예약된 곳은 없지만 손으로 한 번
 *    돌릴 자리가 있고, 그때 명목이 어떻게 계산되는지가 위 사고의 기록이기도 하다.
 */

/** Hobby 크론의 최대 지연(문서상 ±59분). 넉넉하게 1시간으로 되돌린다. */
const CRON_DRIFT_MS = 60 * 60 * 1000;

interface CronSlotSpec {
  /**
   * 이 슬롯이 **대표하는 KST 시각**(자정부터의 분).
   *
   * `null` 이면 **뜬 시각을 그대로 쓴다.** 명목 시각은 원래 Vercel Hobby 크론의 ±59분
   * 오차를 지우려고 만든 장치인데, pg_cron 은 흔들리지 않으므로 지울 오차가 없다.
   * 오히려 실제 시각이 더 정확하다 — 아침에 잡은 보스를 밤 23:55 로 적을 이유가 없다.
   */
  readonly nominalMinuteKst: number | null;
  /** 15분 서버 캐시를 건너뛰는가. 캐시 창보다 촘촘히 도는 슬롯만 참이다. */
  readonly bypassCache: boolean;
}

/**
 * 크론 슬롯 정의. **스케줄러 설정과 한 쌍이다.**
 *
 * · `hourly` — pg_cron `50 * * * *` = **매시 50분**. 지금 실제로 도는 것은 이것뿐이다.
 * · `nightly` — 예약된 곳이 없다. 손으로 한 번 돌릴 때를 위해 남겨 둔 이름이다.
 */
export const CRON_SLOTS = {
  hourly: { nominalMinuteKst: null, bypassCache: false },
  nightly: { nominalMinuteKst: 23 * 60 + 55, bypassCache: false },
} as const satisfies Record<string, CronSlotSpec>;

export type CronSlot = keyof typeof CRON_SLOTS;

/**
 * 이 실행이 대표하는 시각. `null` 이면 **뜬 시각을 그대로 쓴다**는 뜻이다.
 *
 * 오차 보정(1시간 빼기)은 명목 시각이 있는 슬롯에만 의미가 있다. 오차가 0~+59분이므로
 * 1시간을 빼면 어느 경우든 걸어 둔 그 날로 떨어진다.
 */
function nominalRunAt(firedAt: Date, slot: CronSlot): Date | null {
  const minute = CRON_SLOTS[slot].nominalMinuteKst;
  if (minute === null) return null;

  const intendedDay = kstDayKey(new Date(firedAt.getTime() - CRON_DRIFT_MS));
  const nominal = kstMoment(intendedDay, minute);

  /*
    ★ **미래로는 못 간다.** 제 시각에 뜬 실행에서는 명목이 항상 과거라 이 절이 아무것도
      하지 않는다. 무는 경우는 **일정 밖 호출**뿐이다 — 배관을 확인하려고 낮에 손으로
      한 번 불렀더니 오늘 아침에 잡은 보스가 `23:55 클리어` 로 박혔다(2026-08-25 실측).
  */
  return nominal.getTime() > firedAt.getTime() ? firedAt : nominal;
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
  /**
   * 이 실행이 **알고 있던 12칸 면제 보스 수**(메이린 같은 시즌 보스).
   *
   * 건너뛰기 판정이 이 집합을 쓰므로, 0 이면 면제 예외가 아예 동작하지 않았다는 뜻이다.
   * 배포가 밀렸는지 마스터가 비었는지를 응답만 보고 가릴 수 있게 밖으로 낸다 —
   * 이게 없어서 "왜 아직도 5명이 건너뛰어지지?" 를 추측으로 쫓았다(2026-08-25).
   */
  readonly exemptBosses: number;
  /**
   * 시간 예산에 걸려 **이번 회차에 시작조차 못 한** 캐릭터 수.
   *
   * 실패가 아니다 — 다음 시간에 맨 앞에 선다(`last_synced_at` 오래된 순 정렬).
   * 0 이 아닌 값이 매시 계속 찍히면 그때가 물리적으로 한 시간에 한 바퀴가 안 도는
   * 시점이고, 크론 주기나 `MAX_PARALLEL_CREDENTIALS` 를 손볼 신호다.
   */
  readonly deferred: number;
  /**
   * `MAX_CHARACTERS` 안전핀에 걸려 **후보 목록에서 잘려 나간** 캐릭터 수.
   *
   * ⚠️ 0 이 아니면 비정상이다. 예전에는 이 값이 없어서 조용히 잘렸다.
   */
  readonly truncated: number;
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
 * ★ 다만 상한만 보고 끊으면 **12칸을 안 먹는 보스를 놓친다.** 두 종류가 있다:
 *     · 월간 — 검은 마법사는 12칸을 쓰지 않으므로(§1) 주간이 꽉 찬 뒤에 잡을 수 있다.
 *     · 면제 주간 — 메이린 같은 시즌 보스는 `cycle=weekly` 인데도 12칸 밖이다(2026-08-25).
 *   그래서 "이번 달 월간 계획도, 이번 주 면제 보스도 남지 않았을 때"만 건너뛴다.
 *   ⚠️ 월간은 **계획**으로, 면제 주간은 **마스터**로 판단한다. 이유는 아래 주석 참고 —
 *      계획은 동기화가 만드는 산출물이라 건너뛰기 판단에 쓰면 스스로를 막는다.
 * ★ 일간은 추적 범위 밖이라(§1, 2026-08-18) 판단에 넣지 않는다.
 */
async function selectCandidates(
  db: AdminDb,
  now: Date,
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly skipped: number;
  readonly exemptBosses: number;
  readonly truncated: number;
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
  /*
    ★ **오래 안 부른 순서로 뽑는다**(2026-08-27). 예전에는 정렬이 없어서, 상한에 걸리면
      *어느* 캐릭터가 잘리는지가 **정렬 운**이었다 — 같은 캐릭터가 매번 잘려 영원히
      동기화되지 않아도 아무도 모른다.
      `last_synced_at` 오래된 순(한 번도 안 부른 `null` 이 맨 앞)으로 세우면, 상한이든
      시간 예산이든 어디서 끊기더라도 **다음 회차에 밀린 쪽이 맨 앞**에 선다.
      매시 도는 크론이라 이 규칙 하나로 한 바퀴가 보장된다.
    ★ 상한은 `MAX_CHARACTERS + 1` 로 읽는다. 딱 상한만큼 읽으면 "정확히 상한"과 "더
      있는데 잘렸다"를 구분할 수 없다 — 한 행을 더 읽어 **잘렸다는 사실 자체**를 안다.
  */
  const trackedResult = await db
    .from("characters")
    .select("id")
    .eq("is_tracked", true)
    .not("ocid", "is", null)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CHARACTERS + 1);
  if (trackedResult.error !== null) {
    console.error(
      `[nightly-sync] 추적 캐릭터 조회 실패: ${trackedResult.error.message}`,
    );
    return { candidates: [], skipped: 0, exemptBosses: 0, truncated: 0 };
  }
  const trackedRows = trackedResult.data ?? [];
  const truncated = Math.max(trackedRows.length - MAX_CHARACTERS, 0);
  if (truncated > 0) {
    /*
      ⚠️ **조용히 넘어가지 않는다.** 이 경고가 없어서 "동기화가 안 된다"를 추측으로
         쫓았다. 안전핀에 닿았다는 것은 설정을 손봐야 한다는 뜻이지 정상이 아니다.
    */
    console.warn(
      `[nightly-sync] 추적 캐릭터가 안전핀(${String(MAX_CHARACTERS)})을 넘었습니다 — ` +
        `${String(truncated)}명 이상이 이번 회차 후보에서 빠집니다. MAX_CHARACTERS 를 올리거나 ` +
        `크론 주기를 조정하세요.`,
    );
  }
  const characterIds = trackedRows.slice(0, MAX_CHARACTERS).map((row) => row.id);
  if (characterIds.length === 0)
    return { candidates: [], skipped: 0, exemptBosses: 0, truncated };

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
    return { candidates: [], skipped: 0, exemptBosses: 0, truncated };
  }

  const rows = (sourceResult.data ?? []).filter(
    (row) => row.allow_server_side_use !== false,
  );
  if (rows.length === 0)
    return { candidates: [], skipped: 0, exemptBosses: 0, truncated };

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

  /**
   * 캐릭터별 이번 주 주간 클리어 수 — **12칸을 먹는 것만** 센다.
   *
   * ★ 시즌 보스는 **주기가 이미 다르므로** `cycle === "weekly"` 하나로 걸러진다
   *   (2026-08-26). 그전에는 주간이면서 12칸 면제라는 두 조건이었다. 플래그 검사를
   *   남겨 두는 것은 "주간인데 12칸 면제"가 앞으로 생길 수 있어서다 — 그때도 세면
   *   11개만 잡은 캐릭터가 "다 찼다"가 되어 동기화가 통째로 건너뛰어진다.
   */
  const weeklyCount = new Map<string, number>();
  for (const row of weeklyResult.data ?? []) {
    if (row.character_id === null) continue;
    const entry = cycles.get(row.boss_difficulty_id);
    if (entry?.cycle !== "weekly") continue;
    if (!entry.countsTowardWeeklyLimit) continue;
    weeklyCount.set(row.character_id, (weeklyCount.get(row.character_id) ?? 0) + 1);
  }

  /*
    ── 12칸 면제 보스는 **계획이 아니라 마스터로** 판단한다 ─────────────────────
    처음에는 월간과 똑같이 "이 캐릭터의 활성 계획에 면제 보스가 있는가"로 짰다.
    실측에서 그게 **닭과 달걀**임이 드러났다(2026-08-25):

      킴잔델은 12/12 라 건너뛰어진다 → 동기화가 안 돈다 → 메이린 계획이 만들어지지
      않는다 → 계획이 없으니 예외가 안 걸린다 → 영원히 건너뛰어진다.

    계획은 **동기화가 만드는 산출물**이라, 건너뛸지 말지를 그것으로 정하면 스스로를
    막는다. 그래서 기준을 마스터로 옮긴다 — "면제 보스가 존재하는데 이 캐릭터가 이번 주
    아직 안 잡았다"면 부른다. 계획 유무를 묻지 않으므로 첫 동기화도 통과한다.

    ★ 난이도가 아니라 **보스 단위**로 센다. 한 캐릭터가 노멀과 하드를 둘 다 돌지는 않으니
      난이도로 세면 "전부 잡음"이 영원히 성립하지 않아 건너뛰기가 죽는다.
    ★ 다 잡고 나면 조건이 거짓이 되어 건너뛰기가 **스스로 돌아온다.** 메이린 입장이
      끝나(2026-09-16) 마스터에서 released 가 내려가면 집합이 비고 예전 동작 그대로다.
  */
  const { getBossCatalog } = await import("@/lib/boss-master");
  const exemptBossIds = new Set(
    getBossCatalog(now)
      .filter(
        (entry) =>
          entry.released &&
          /*
            ★ 판정이 `cycle === "season"` 으로 **간단해졌다**(2026-08-26). 예전에는
              "주간인데 12칸 면제"라는 두 조건이었는데, 시즌이 별도 주기가 되면서
              그 조합이 곧 주기 하나로 표현된다. 12칸 면제 플래그는 그대로 남아 있지만
              여기서 쓸 이유가 없다 — 여기서 묻는 것은 "12칸이 차도 더 갈 수 있는가"이고
              그 답은 주기가 준다.
          */
          entry.cycle === "season",
      )
      .map((entry) => entry.bossId),
  );

  /** 이번 주에 이미 잡은 (캐릭터, 면제 **보스**). 난이도는 접는다. */
  const exemptDone = new Set<string>();
  for (const row of weeklyResult.data ?? []) {
    if (row.character_id === null) continue;
    const entry = cycles.get(row.boss_difficulty_id);
    if (entry === undefined) continue;
    if (!exemptBossIds.has(entry.bossId)) continue;
    exemptDone.add(`${row.character_id}:${entry.bossId}`);
  }

  /** 이 캐릭터에게 아직 안 잡은 면제 보스가 남았는가. */
  const hasExemptRemaining = (characterId: string): boolean =>
    [...exemptBossIds].some((bossId) => !exemptDone.has(`${characterId}:${bossId}`));

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

  /*
    ★ `.in("character_id", …)` 은 **넘긴 순서를 지켜 주지 않는다.** 오래된 순으로 뽑아
      놓고 여기서 순서를 잃으면 정렬이 아무 일도 하지 않은 것이 된다(시간 예산에 걸릴
      때 누가 밀리는지가 다시 운에 맡겨진다). `characterIds` 의 자리로 되돌린다.
  */
  const staleRank = new Map(characterIds.map((id, index) => [id, index]));
  const orderedRows = [...rows].sort(
    (a, b) =>
      (staleRank.get(a.character_id ?? "") ?? Number.MAX_SAFE_INTEGER) -
      (staleRank.get(b.character_id ?? "") ?? Number.MAX_SAFE_INTEGER),
  );

  for (const row of orderedRows) {
    const characterId = row.character_id;
    const userId = row.user_id;
    const credentialId = row.credential_id;
    if (characterId === null || userId === null || credentialId === null) continue;
    if (!tracked.has(characterId)) continue;

    const full = (weeklyCount.get(characterId) ?? 0) >= weeklyLimit;
    if (
      full &&
      !monthlyPending.has(characterId) &&
      !hasExemptRemaining(characterId)
    ) {
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

  return { candidates, skipped, exemptBosses: exemptBossIds.size, truncated };
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
  /** 주차·달 판정의 기준. 명목이 없으면 **뜬 시각**이 곧 기준이다. */
  const basisAt = nominalAt ?? now;
  /*
    ★ 후보 선별도 **명목 시각**으로 한다(2026-08-25). `now` 를 넘기면 목요일 00:06 에 뜬
      실행이 **새 주차**를 기준으로 12칸을 세게 되고, 그 주차에는 클리어가 아직 하나도 없어
      "다 찼으니 건너뛴다"가 통째로 무력화된다 — 결과가 기록될 주차(= 명목 주차)와 판단에
      쓰는 주차가 갈리면 안 된다. 월간 판정의 달 경계도 같은 이유로 함께 옮겨진다.
  */
  const { candidates, skipped, exemptBosses, truncated } = await selectCandidates(
    db,
    basisAt,
  );

  /*
    후보는 **오래 안 부른 순**으로 온다. Map 은 삽입 순서를 지키므로, 이렇게 담으면
    **가장 오래 밀린 캐릭터를 가진 키가 맨 앞 물결**에 든다 — 동시성 상한에 걸려
    뒤로 밀리더라도 밀리는 쪽이 매번 같은 사람이 되지 않는다.
  */
  const byCredential = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byCredential.get(candidate.credentialId) ?? [];
    list.push(candidate);
    byCredential.set(candidate.credentialId, list);
  }

  let synced = 0;
  let failed = 0;
  let noServerKey = 0;
  let deferred = 0;

  /** 새 캐릭터를 **시작해도 되는가**. 이미 시작한 건은 예산과 무관하게 끝까지 간다. */
  const withinBudget = (): boolean => Date.now() - startedAt < START_BUDGET_MS;

  await runWithConcurrency(
    [...byCredential.entries()],
    MAX_PARALLEL_CREDENTIALS,
    async ([credentialId, list]) => {
      const first = list[0];
      if (first === undefined) return;

      /*
        ★ 예산 검사가 **키를 잡기 전에도** 있어야 한다. `buildServerNexonContext` 는
          금고에서 키를 꺼내 복호화하는 DB 왕복이라, 어차피 한 명도 못 부를 상황에서
          그 비용을 낼 이유가 없다.
      */
      if (!withinBudget()) {
        deferred += list.length;
        return;
      }

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
        /*
          ⚠️ **자르지 않고 미룬다.** 예산을 넘으면 남은 캐릭터를 `deferred` 로 세고
             빠진다. 매시 도는 크론이 `last_synced_at` 오래된 순으로 뽑으므로 이들이
             다음 회차 맨 앞에 선다 — 상한으로 잘라 내던 예전 방식은 같은 캐릭터가
             영원히 잘려도 알 방법이 없었다.
        */
        if (index > 0 && !withinBudget()) {
          deferred += list.length - index;
          break;
        }
        if (index > 0) await delay(KEY_GAP_MS);
        try {
          /*
            명목이 없는 슬롯(`hourly`)은 **아무것도 덮지 않는다.** 그러면 클리어 시각이
            `sync-scheduler` 의 기본 경로(넥슨 관측일 + 실제 호출 시각)로 정해지는데,
            매시 도는 상황에서는 그게 가장 정확하다 — 오차가 최대 한 시간이고 날짜·주차가
            어긋날 여지가 없다(목요일 00:50 실행은 이미 초기화된 데이터를 보므로 기록할
            것 자체가 없다).
          */
          await syncCharacterScheduler(
            context,
            candidate.characterId,
            nominalAt === null ? {} : { clearedAtOverride: nominalAt },
          );
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
    },
  );

  if (deferred > 0) {
    /*
      ⚠️ 실패가 아니라 **다음 시간으로 미뤘다**는 보고다. 매시 계속 찍히면 그때가
         한 시간에 한 바퀴가 안 도는 시점이고, 크론 주기나 동시성 상한을 손볼 신호다.
    */
    console.warn(
      `[nightly-sync] 시간 예산(${String(START_BUDGET_MS)}ms)에 걸려 ` +
        `${String(deferred)}명을 다음 회차로 미뤘습니다.`,
    );
  }

  return {
    synced,
    skipped,
    failed,
    noServerKey,
    exemptBosses,
    deferred,
    truncated,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 항목을 **최대 `limit` 갈래**로 동시에 흘린다.
 *
 * `Promise.all(items.map(...))` 은 전부 한꺼번에 쏜다. 갈래 하나하나가 바깥 HTTP + DB
 * 왕복을 드는 이 작업에서는, 사람이 늘수록 **동시 갈래가 그대로 늘어나** 우리 쪽
 * PostgREST 처리량이 먼저 무너진다. 여기서는 일꾼을 `limit` 개만 세워 두고 각자
 * 다음 항목을 집어 가게 한다 — 짧은 갈래가 끝나면 바로 다음 것을 잡으므로, 물결을
 * 맞춰 기다리는 방식보다 벽시계가 짧다.
 *
 * 일꾼이 던지면 그 갈래가 죽는다. 그래서 `worker` 는 **스스로 예외를 삼켜야 한다** —
 * 호출부가 캐릭터마다 try/catch 를 두는 것이 그 계약이다.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(Math.min(limit, items.length), 0) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        await worker(item);
      }
    },
  );
  await Promise.all(workers);
}
