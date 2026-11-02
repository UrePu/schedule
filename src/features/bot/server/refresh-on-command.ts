import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 봇 명령을 치면 **그 사람의 캐릭터를 넥슨에서 한 번 새로 받는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-11-02): *"혹시 !숙제 를 했을때 api갱신 한번 요청해서 새로고침해줄수있음?"*
 *
 * 크론은 매시 :50 에만 돈다(§1.1.1). 그래서 방금 깬 보스는 다음 :50 까지 `!숙제` 카드에
 * 남아 있었다. 넥슨 데이터는 **로그아웃·캐시샵 진입 시 즉시 갱신**되므로(§1.1), 사람이
 * 명령을 친 그 순간에 15분 캐시를 건너뛰고 다시 받는 것이 실제로 값을 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 갱신은 답장의 조건이 아니다
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출 시점에 동기화를 **시작**하고, 다 끝나거나 범위별 상한(`replyDeadlineMs`)이 되면
 * 돌아온다. 못 끝낸 캐릭터는 `after()` 안에서 응답 뒤에 이어서 돈다 — 떠 있는 Promise 로
 * 두면 서버리스에서 잘린다.
 * 이 함수는 **던지지 않는다.** 넥슨 오류·쿼터·DB 실패는 전부 로그로만 남고 답장에
 * 섞이지 않는다(§2.1.2 — 키가 없는 것도 오류가 아니다).
 * ⚠️ 상한 뒤의 조회는 여기서 끊지 않는다. 그쪽이 멈추면 라우트가 10초에 오류 답장을 낸다(상수 머리말).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 주간·월간 초기화 직후 20분은 부르지 않는다 (`lib/time/reset-window.ts`)
 * ─────────────────────────────────────────────────────────────────────────────
 * 사람들이 초기화 직후에 `!숙제` 를 치므로 이 경로가 그 구간을 일상적으로 부르게 된다
 * (실측: 최근 30일 4건). 그때 넥슨이 초기화 전 `complete_flag` 를 주면 새 주에 가짜 클리어가
 * 생긴다. 그래서 그 구간에는 호출도 쿨다운 자리도 없이 바로 돌아가고 답장은 DB 기준이다.
 * 응답 뒤로 넘어간 작업이 자정을 넘기면 남은 캐릭터도 시작하지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 답장에 반영되는 것은 **그때까지 끝난 것까지**다
 * ─────────────────────────────────────────────────────────────────────────────
 * 평문 답장(`!검마` · `!결정석` · `!숙제 <닉네임>`)은 기다림이 끝난 뒤 DB 를 읽는다.
 * `!숙제` 카드는 **카톡 크롤러가 주소를 열 때** DB 를 읽으므로(`app/s/[token]/card.png`)
 * 답장 뒤에 끝난 캐릭터도 크롤러보다 먼저 끝나면 그림에 들어간다. 크롤러가 먼저면 그 주소의
 * 그림은 이전 값이고, 다시 친 `!숙제` 는 새 주소(`?t=`)라 갱신된 값을 그린다.
 * 답장 전에 몇 캐릭터가 끝났는지는 마지막 로그 줄의 `응답 전` 이 말한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출 예산 — 사람이 치는 명령이지만 **방 안의 누구나 칠 수 있다**(§2.3)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 대상: 남은 보스가 있고, 크론의 건너뛰기 규칙(12칸 · 월간 · 메이린 예외)을 통과한 캐릭터.
 *   · 초당: 키마다 `KEY_GAP_MS`(250ms = 4콜/초). 개발 키 5콜/초 안쪽이다.
 *   · 쿨다운: 캐릭터마다 `REFRESH_COOLDOWN_MS`. 동시에 두 번 쳐도 호출은 한 번이다(`claim`).
 *   · 일일: 그 키의 오늘 호출이 개발 키 한도의 80%를 넘으면 이 경로만 멈춘다(`prepareContexts`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 알려진 한계 — 고치지 않고 적어 둔다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 키별 간격은 **한 명령 안에서만** 지켜진다. 같은 키로 명령 둘이 겹치거나 웹 버튼과 겹치면
 *     초당 5콜을 넘을 수 있다. 429 를 맞으면 그 캐릭터는 건너뛰고 로그만 남는다.
 *   · 나란히 도는 호출이 몰리면 호출 장부(`recordNexonCall`, 낙관적 재시도 4회)에서 한 건이 빠질 수
 *     있다. 모형에서 180콜 중 1콜(6캐릭 키). 빠지면 플랫폼 로그에 남고 일일 상한이 그만큼 늦게 걸린다.
 *   · 캐시 적중도 `fetched_at` 을 찍는다(`sync-scheduler`). 다른 경로가 15분 캐시를 읽고 지나간
 *     직후라면 넥슨을 부르지 않았는데도 쿨다운에 걸려 이번 명령은 건너뛴다.
 *   · 초기화 구간의 스냅샷: 봇은 구간 안에 새로 부르지 않지만, 직전에 시작한 동기화가 구간 안에서 응답을
 *     받으면 스냅샷·계획에는 초기화 전 값이 남는다. 클리어 기록은 `recordApiClears` 의 가드가 막고, 다음
 *     동기화가 나머지를 덮는다.
 *   · `!결정석` 은 상한이 4초라 콜드 스타트면 이번 답장에 갱신이 안 들어간다(모형 0명). 다음 명령부터
 *     들어간다. 12초 여유와 바꾼 대가다.
 *   · 런너가 병렬인지 모른다. 최근 30일 로그에서 앞 명령이 끝나기 전 다음 명령이 들어온 경우가
 *     784건 중 20건, 그중 다른 발신자 6건이다. 직렬이면 나올 수 없는 패턴이지만 텔레그램 등 다른
 *     경로 가능성은 배제 못 한다. 직렬이라면 상한만큼 기다리는 동안 뒤 명령이 밀린다.
 */

import { after } from "next/server";

import {
  buildServerNexonContext,
  type NexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import {
  KEY_GAP_MS,
  START_BUDGET_MS,
  delay,
  runWithConcurrency,
  selectCandidates,
  type Candidate,
} from "@/features/boss-plans/server/nightly-sync";
import { syncCharacterScheduler } from "@/features/boss-plans/server/sync-scheduler";
import type { NexonRequestOptions } from "@/lib/nexon/client";
import { readQuotaSnapshot } from "@/lib/nexon/quota";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { isInResetWindow } from "@/lib/time/reset-window";

import { fetchRemainingBosses, type RemainingBossScope } from "./bot-repo";

/**
 * `!숙제` · `!검마` 의 답장을 **언제까지 붙잡는가** — `POST` 가 시작된 뒤로 잰 상한(ms).
 *
 * ★ **고정 대기가 아니라 상한이다.** 다 끝나면 그 즉시 답하고, 부를 대상이 없으면(쿨다운 ·
 *   남은 보스 없음) 선별 왕복만 쓰고 바로 답한다. 늦어지는 것은 **실제로 갱신할 때뿐**이다.
 *   시작 시각 기준이라 핸들러 안에서 늦어진 만큼(첫 연결 등)은 기다림이 줄어 서로 쌓이지 않는다.
 *   함수 부팅은 이 시계가 돌기 전이라 그만큼은 더해진다.
 *
 * 왜 6,500 인가(2026-11-02 결정): 캐릭터 한 명 동기화는 넥슨 왕복 포함 약 2.5초다(크론
 * `fetched_at` 간격 p50 2,735ms − 간격 250ms). 처음 잡은 2,200 은 그 한 명도 못 기다려서,
 * 답장 시점 반영이 0명이고 *"새로고침"* 이 크롤러와의 경주에 달린 운이 됐다.
 *
 * ⚠️ **이 상한은 기다림만 끊는다.** 답을 낼 시간이 이 뒤에 남아 있어야 한다.
 *   · 상한 뒤의 답장용 조회는 여기서 끊지 않는다. 명령 서버 시간 실측(최근 30일 783건, 갱신 도입 전):
 *     p99 3,371ms, 최대 48,637ms. 평소 `!숙제` 는 뒤쪽이 수백 ms 라 서버 시간 7초 안쪽에 답한다.
 *   · 서버 안에서 멈추면 라우트가 **POST 시작 10초에 오류 답장**을 낸다(`COMMAND_REPLY_LIMIT_MS`).
 *   · 서버가 응답을 못 하면(함수 부팅 · 네트워크) **여전히 침묵**이다. 런너는 12초(`scripts/OpenchatbotR.js`
 *     `COMMAND_TIMEOUT`, DNS · TLS · 전송 · 응답까지 든 벽시계 전체)를 넘기면 포기하고 방에 아무 말도
 *     하지 않는다. 함수 부팅은 `env.now`(POST 시작)에 안 잡히므로 그만큼 12초에서 따로 빠진다.
 *   **이 값을 더 올리면** 10초 상한에 걸려 오류 답장으로 바뀌는 명령이 늘어난다.
 */
export const REFRESH_REPLY_DEADLINE_MS = 6_500;

/**
 * `!결정석` 의 상한 — 4,000ms.
 *
 * 발주자가 갱신을 직접 요청한 명령이 아니고(*"!숙제 를 했을때"*) 뒤쪽 조회가 무겁다. 최근 30일
 * 실측: `!결정석` p50 1,938 · p90 3,088 · 최대 11,224ms, `!숙제` p50 1,285 · p90 2,261 ·
 * 최대 3,007ms. 그래서 12초 여유를 더 남긴다.
 */
export const REFRESH_REPLY_DEADLINE_CRYSTAL_MS = 4_000;

/**
 * 같은 캐릭터를 다시 부르기까지의 최소 간격 — **5분, 봇 전용**이다.
 *
 * 발주 지시(2026-11-02): *"갱신 제한을 5분으로 잡자"* · *"봇에만걸어"*. 웹 전체 갱신 버튼은 이 제한을
 * 쓰지 않는다 — 방 안의 누구나 칠 수 있는 것은 봇뿐이다(§2.3).
 *
 * 같은 명령을 연달아 쳐도 호출이 늘지 않게 막는다. 이 값이 호출량의 상한을 정한다: 캐릭터당
 * 시간 12콜. 크론·웹 새로고침이 방금 받은 캐릭터도 같이 건너뛴다(`fetched_at`).
 * ⚠️ 대가: 5분 안에 보스를 또 깨고 다시 치면 그 캐릭터는 이번에 안 불린다.
 */
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 한 명령이 동시에 진행하는 캐릭터 수 — **6**.
 *
 * 넥슨 초당 한도는 키별 간격(`pacedGateway`)이 따로 지키므로, 이 값이 묶는 것은 우리 DB
 * 왕복이다. 크론은 한 번에 24갈래까지 도는데 이쪽은 **한 키를 한 물결에 소화할 만큼**만 쓴다
 * (실측 2026-11-02: 키당 최대 6캐릭, 사람당 최대 10캐릭). 직렬로 돌면 6캐릭이 14초 걸려
 * 크론과 같은 값어치밖에 못 하지만, 나란히 돌면 약 3.7초에 끝나 답장 상한 안에 든다.
 */
export const REFRESH_CONCURRENCY = 6;

/** `!결정석` 은 주간·월간을 함께 말하므로 둘 다 본다(`"all"`). */
export type RefreshScope = RemainingBossScope | "all";

function replyDeadlineMs(scope: RefreshScope): number {
  return scope === "all"
    ? REFRESH_REPLY_DEADLINE_CRYSTAL_MS
    : REFRESH_REPLY_DEADLINE_MS;
}

export interface RefreshRequest {
  readonly scope: RefreshScope;
  /** 로그 머리. 명령 이름만 담는다 — 닉네임은 남기지 않는다. */
  readonly tag: string;
  /** `!숙제 <닉네임>` — `resolveMyCharacter()` 가 돌려준 id 여야 한다. */
  readonly characterId?: string;
}

/**
 * 이 파일이 만든 단계 오류. 문구가 **단계 이름 + DB 오류 문구**뿐이라 그대로 로그에 남긴다.
 * 키 · ocid · 닉네임을 여기 싣지 말 것.
 */
class RefreshStepError extends Error {}

/** `error` 를 로그 한 조각으로. 사용자용 문구에는 캐릭터 이름이 들어 있어 쓰지 않는다. */
function errorKind(error: unknown): string {
  if (error instanceof RefreshStepError) return error.message;
  if (error instanceof Error) {
    return "kind" in error ? String(error.kind) : error.name;
  }
  return "unknown";
}

/** 캐릭터 이름 → 남은 금액 합. 값 큰 캐릭터부터 돌리는 정렬 기준이자 "남은 보스 있음" 판정이다. */
async function loadRemainingValues(
  db: AdminDb,
  userId: string,
  request: RefreshRequest,
): Promise<ReadonlyMap<string, number>> {
  const scopes: readonly RemainingBossScope[] =
    request.scope === "all" ? ["weekly", "monthly"] : [request.scope];
  const lists = await Promise.all(
    scopes.map((scope) =>
      fetchRemainingBosses(db, userId, {
        scope,
        ...(request.characterId === undefined
          ? {}
          : { characterId: request.characterId }),
      }),
    ),
  );

  const values = new Map<string, number>();
  for (const list of lists) {
    for (const item of list.items) {
      values.set(
        item.characterName,
        (values.get(item.characterName) ?? 0) + item.shareMeso,
      );
    }
  }
  return values;
}

/**
 * 쿨다운 창 안에 **이미 넥슨을 받은** 캐릭터.
 *
 * ★ `last_synced_at` 이 아니라 스냅샷을 본다. 웹 새로고침과 런 종료 후 동기화가 적는 곳은 이
 *   표뿐이라, 그 컬럼만 보면 그쪽이 방금 받은 캐릭터를 또 부른다.
 */
async function loadRecentlySynced(
  db: AdminDb,
  userId: string,
  cutoffIso: string,
): Promise<ReadonlySet<string>> {
  const { data, error } = await db
    .from("character_scheduler_snapshots")
    .select("character_id, characters!inner(user_id)")
    .eq("characters.user_id", userId)
    .gte("fetched_at", cutoffIso);
  if (error !== null) throw new RefreshStepError(`스냅샷 조회: ${error.message}`);
  return new Set((data ?? []).map((row) => row.character_id));
}

/**
 * 이번 명령이 부를 권리를 **원자적으로** 얻는다 — 이긴 캐릭터 id 만 돌려준다.
 *
 * 스냅샷은 동기화가 끝나야 적히므로, 동시에 온 두 명령은 둘 다 "오래됐다"고 읽는다. 그래서
 * 부르기 전에 조건부 UPDATE 한 문장으로 자리를 잡는다. Postgres 는 먼저 잡은 쪽이 끝난 뒤
 * WHERE 를 다시 평가하므로 두 번째 문장은 그 행을 건드리지 못한다.
 *
 * ★ 새 테이블 없이 `characters.last_synced_at` 을 쓴다. 크론의 "오래 안 부른 순" 정렬이 읽는
 *   값이고 크론도 호출한 캐릭터에 찍으므로(`runNightlySync`), 여기서 찍으면 방금 받은 캐릭터가
 *   그 정렬의 뒤로 간다 — 뜻이 맞는 방향이다.
 * ⚠️ **부를 수 있는 캐릭터만** 넘긴다(호출부). 키가 없는 캐릭터에 찍으면 부르지도 않았는데
 *    크론 줄 뒤로 밀린다.
 * ⚠️ 넥슨 오류가 나도 되돌리지 않는다. 실패한 캐릭터를 곧바로 다시 부르는 것이 이 쿨다운이
 *    막으려는 것이다.
 * ⚠️ 이 문장이 실패하면 **부르지 않는다.** 중복 호출을 못 막는 상태로 호출하지 않는다.
 */
async function claim(
  db: AdminDb,
  userId: string,
  characterIds: readonly string[],
  cutoffIso: string,
  nowIso: string,
): Promise<ReadonlySet<string>> {
  const { data, error } = await db
    .from("characters")
    .update({ last_synced_at: nowIso })
    .eq("user_id", userId)
    .in("id", [...characterIds])
    .or(`last_synced_at.is.null,last_synced_at.lt.${cutoffIso}`)
    .select("id");
  if (error !== null) throw new RefreshStepError(`자리 잡기: ${error.message}`);
  return new Set((data ?? []).map((row) => row.id));
}

/**
 * 같은 키의 호출 사이를 벌리는 게이트웨이. **자리를 동기적으로 예약**하므로 나란히 도는
 * 캐릭터들이 같은 틈을 잡지 않고, DB 왕복이 어떻게 흔들려도 넥슨으로 나가는 간격이 유지된다.
 */
function pacedGateway(
  gateway: NexonProxyContext["gateway"],
): NexonProxyContext["gateway"] {
  let nextSlotAt = 0;
  return {
    request: async <T>(args: NexonRequestOptions<T>): Promise<T> => {
      const now = Date.now();
      const slot = Math.max(now, nextSlotAt);
      nextSlotAt = slot + KEY_GAP_MS;
      if (slot > now) await delay(slot - now);
      return gateway.request(args);
    },
  };
}

/**
 * 자격증명별 컨텍스트. **쓸 수 없는 키는 맵에 없다** — 키가 없는 것도, 오늘 호출이 많은 것도
 * 사용자에게 할 말이 없는 상태라 조용히 건너뛴다(§2.1.2).
 *
 * ★ `bypassCache: true` — 사람이 직접 친 명령이다. 캐시를 읽으면 로그아웃 직후에 쳐도 15분
 *   전 바이트를 돌려줘 이 기능이 하는 일이 없어진다(§1.1 예외).
 * ★ 일일 상한: 개발 키 한도의 80%(`nearDevBudget`)를 넘으면 이 경로만 멈춘다. 5분 쿨다운만으로는
 *   6캐릭 키가 하루 1,728콜까지 갈 수 있어(시간 12회 × 6 × 24) 1,000을 넘고, 그러면 **크론까지
 *   429 를 맞는다.** 남긴 200콜이 크론과 웹 몫이다(실측 키당 하루 최대: 최근 30일 171콜 2026-10-16,
 *   전체 199콜 2026-09-14). 키 종류를 판별하지 않으므로
 *   (`lib/nexon/quota.ts`) 서비스 키도 같은 줄에서 멈추지만, 막히는 것은 이 편의 하나뿐이다.
 */
async function prepareContexts(
  db: AdminDb,
  userId: string,
  targets: readonly Candidate[],
  now: Date,
): Promise<ReadonlyMap<string, NexonProxyContext>> {
  const credentialIds = [...new Set(targets.map((target) => target.credentialId))];
  const contexts = new Map<string, NexonProxyContext>();

  await Promise.all(
    credentialIds.map(async (credentialId) => {
      try {
        const [context, usage] = await Promise.all([
          buildServerNexonContext({ db, userId, credentialId, bypassCache: true }),
          readQuotaSnapshot(db, credentialId, now),
        ]);
        if (context === null || usage.nearDevBudget) return;
        contexts.set(credentialId, {
          ...context,
          gateway: pacedGateway(context.gateway),
        });
      } catch (error) {
        console.warn(`[bot/refresh] 키 준비 실패: ${errorKind(error)}`);
      }
    }),
  );
  return contexts;
}

async function runRefresh(
  env: { readonly db: AdminDb; readonly now: Date },
  userId: string,
  request: RefreshRequest,
  reply: { sent: boolean },
): Promise<void> {
  const { db, now } = env;
  const startedAt = Date.now();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - REFRESH_COOLDOWN_MS).toISOString();

  /*
    ★ 건너뛰기 규칙은 **크론의 것을 그대로 부른다**(12칸 · 월간 · 메이린 예외). 여기에 다시
      쓰면 다음 예외가 한쪽에서만 고쳐진다.
  */
  const [selection, values, recent] = await Promise.all([
    selectCandidates(db, now, {
      userId,
      ...(request.characterId === undefined
        ? {}
        : { characterId: request.characterId }),
    }),
    loadRemainingValues(db, userId, request),
    loadRecentlySynced(db, userId, cutoffIso),
  ]);

  const valueOf = (target: Candidate): number =>
    values.get(target.characterName) ?? 0;
  /*
    값 큰 캐릭터부터. 답장에 들어가든 크롤러와 경주하든, 시간 안에 끝나는 쪽이
    카드 맨 위에 그려질 캐릭터여야 끝난 일이 눈에 보인다.
  */
  const targets = selection.candidates
    .filter(
      (target) =>
        values.has(target.characterName) && !recent.has(target.characterId),
    )
    .sort(
      (a, b) =>
        valueOf(b) - valueOf(a) ||
        a.characterName.localeCompare(b.characterName, "ko"),
    );

  let synced = 0;
  let syncedBeforeReply = 0;
  let failed = 0;
  let noContext = 0;
  let deferred = 0;
  let claimedCount = 0;

  if (targets.length > 0) {
    /*
      ★ **키를 먼저 본다.** 왕복이 하나 늘지만, 나란히 올리면 부르지도 못할 캐릭터에
        `last_synced_at` 이 찍혀 크론 줄 뒤로 밀린다.
    */
    const contexts = await prepareContexts(db, userId, targets, now);
    const callable = targets.filter((target) => contexts.has(target.credentialId));
    noContext = targets.length - callable.length;

    const claimed =
      callable.length === 0
        ? new Set<string>()
        : await claim(
            db,
            userId,
            callable.map((target) => target.characterId),
            cutoffIso,
            nowIso,
          );
    claimedCount = claimed.size;

    await runWithConcurrency(
      callable.filter((target) => claimed.has(target.characterId)),
      REFRESH_CONCURRENCY,
      async (target) => {
        const context = contexts.get(target.credentialId);
        if (context === undefined) return;
        /*
          크론과 같은 예산으로 넥슨이 멈춘 날 응답 뒤 작업이 함수 한도까지 늘어지는 것을 막는다.
          초기화 창을 다시 보는 것은 응답 뒤 작업이 자정을 넘길 수 있어서다.
        */
        if (
          Date.now() - startedAt >= START_BUDGET_MS ||
          isInResetWindow(new Date())
        ) {
          deferred += 1;
          return;
        }
        try {
          await syncCharacterScheduler(context, target.characterId);
          synced += 1;
          if (!reply.sent) syncedBeforeReply += 1;
        } catch (error) {
          failed += 1;
          console.warn(
            `[bot/refresh] 동기화 실패 character=${target.characterId}: ${errorKind(error)}`,
          );
        }
      },
    );
  }

  /*
    ★ 이 한 줄이 답장 상한을 다시 볼 근거다. `응답 전` 이 `완료` 보다 적으면
      상한 안에 못 끝난 캐릭터가 있었다는 뜻이다. 올리기 전에 명령 로그의 `duration_ms` 와 12초 사이의
      여유부터 볼 것(위 상수 머리말). 그 값은 POST 시작부터 로그를 쓸 때까지의 서버 시간이라 부팅과
      네트워크가 빠져 있고, `err:bot_timeout` 행에서는 답장 시각이 아니라 핸들러가 끝난 시각이다.
  */
  console.info(
    `[bot/refresh] ${request.tag} 후보 ${String(selection.candidates.length)} · ` +
      `12칸 ${String(selection.skipped)} · 대상 ${String(targets.length)} · ` +
      `자리 ${String(claimedCount)} · 완료 ${String(synced)}(응답 전 ${String(syncedBeforeReply)}) · ` +
      `키없음/예산 ${String(noContext)} · 미룸 ${String(deferred)} · 실패 ${String(failed)} · ` +
      `${String(Date.now() - now.getTime())}ms`,
  );
}

/**
 * 갱신을 시작하고 **상한까지만** 기다린다. 부르는 쪽은 이 뒤에 DB 를 읽어 답장을 만든다.
 *
 * ★ 던지지 않는다 — 갱신의 어떤 실패도 답장을 막지 않는다.
 * ★ 주간·월간 초기화 직후에는 아무것도 하지 않고 바로 돌아간다(머리말).
 */
export async function refreshBeforeReply(
  env: { readonly db: AdminDb; readonly now: Date },
  userId: string,
  request: RefreshRequest,
): Promise<void> {
  if (isInResetWindow(env.now)) {
    console.info(`[bot/refresh] ${request.tag} 초기화 직후라 건너뜀`);
    return;
  }

  const reply = { sent: false };
  const work = runRefresh(env, userId, request, reply).catch((error: unknown) => {
    console.warn(`[bot/refresh] ${request.tag} 갱신 실패: ${errorKind(error)}`);
  });

  /*
    ★ 응답이 끝나도 함수가 살아 있게 한다(`node_modules/next/dist/docs/.../after.md`). 콜백은
      새 일을 시작하지 않고 **이미 시작한 일을 넘겨 줄** 뿐이다 — 답장 전에 시작해야 기다리는
      동안 끝난 것이 답장에 들어간다. 수명 한도는 라우트의 `maxDuration` 이다.
  */
  try {
    after(() => work);
  } catch (error) {
    // 플랫폼이 못 받아 줘도 답장은 나간다. 그때 응답 뒤 작업은 잘릴 수 있다.
    console.warn(`[bot/refresh] after 등록 실패: ${errorKind(error)}`);
  }

  const remainingMs =
    env.now.getTime() + replyDeadlineMs(request.scope) - Date.now();
  if (remainingMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remainingMs);
      void work.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  reply.sent = true;
}
