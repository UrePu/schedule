import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 추적 캐릭터의 **어제 경험치**를 미리 채운다 — 매시 :50 크론의 뒷단
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇 `!%` 는 지난 6일을 `character_exp_daily` 에서 먼저 읽고 없는 날만 넥슨에 묻는다
 * (`features/bot/server/exp-history.ts`). 이 모듈이 추적 캐릭터의 어제 행을 미리 적어 두므로,
 * 처음 치는 `!%` 도 대개 최신 1콜로 끝난다. 호출량은 **추적 캐릭터 수 × 1콜/일**이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 언제 — KST 03:00 ~ 08:59 의 실행에서만, 어제 행이 **없는** 캐릭터만
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨의 전날 데이터는 다음 날 오전 2시께 들어온다(§1.1). 02:50 실행은 아직 `data_not_ready` 일
 * 수 있어 **03:50 실행부터** 연다. 실패한 캐릭터는 행이 없으니 다음 시간에 저절로 다시 시도되고,
 * 09:00 이후 실행은 문을 닫으므로 **그날은 포기한다**(무한 재시도 없음 — 하루 최대 6번).
 * 못 채운 날은 `!%` 가 처음 쳐질 때 넥슨에서 받아 저장한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 격리 — 스케줄러 동기화에 **아무 영향도 주지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 크론 라우트가 동기화 응답을 낸 **뒤에** `after()` 로 이것을 돌린다(`app/api/cron/sync/route.ts`).
 * 그래서 이 단계가 느려지거나 실패해도 동기화 결과·응답 코드는 그대로다. 이 함수 자체도 던지지
 * 않는다(DB · 넥슨 실패는 세어서 로그 한 줄로 남긴다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 · 예산
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 키는 그 캐릭터 계정의 키(`v_character_sync_source` → `buildServerNexonContext`, userId = 키 주인).
 *   · 그 키의 오늘 호출이 개발 키 한도의 80% 를 넘었으면 건너뛴다(`nearDevBudget`) — 남은 몫은
 *     스케줄러 동기화와 웹 몫이다.
 *   · 키당 간격은 봇 명령과 같은 줄(`pacedGateway`)을 쓴다. 15분 캐시 우회 없음.
 */

import { buildServerNexonContext } from "@/features/auth/server/nexon-proxy";
import {
  runWithConcurrency,
} from "@/features/boss-plans/server/nightly-sync";
import { pacedGateway } from "@/features/bot/server/refresh-on-command";
import type { NexonProxyContext } from "@/features/auth/server/nexon-proxy";
import { fetchCharacterBasicWithExp, type NexonRequestOptions } from "@/lib/nexon/client";
import { NEXON_REQUEST_TIMEOUT_MS } from "@/lib/nexon/constants";
import { isNexonApiError } from "@/lib/nexon/errors";
import { readQuotaSnapshot } from "@/lib/nexon/quota";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { addKstDays, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";

import {
  YESTERDAY_SETTLED_HOUR_KST,
  kstHourOf,
  saveExpDays,
  type ExpDayToSave,
} from "./exp-daily-store";

/**
 * 이 시각(KST, 시) **이상**인 실행에서만 채운다. 02:50 실행은 전날 데이터가 아직일 수 있다.
 * 저장소의 "어제 확정" 시각과 **같은 상수**다 — 봇이 3시 전에 받은 어제 값을 저장하지 않는 규칙과
 * 한 값으로 묶인다(`exp-daily-store.ts`).
 */
export const EXP_FILL_FIRST_HOUR_KST = YESTERDAY_SETTLED_HOUR_KST;
/** 이 시각(KST, 시) **미만**인 실행에서만 채운다. 그 뒤로는 그날 포기한다(최대 6번 시도). */
export const EXP_FILL_END_HOUR_KST = 9;

/**
 * 크론 요청이 시작된 뒤 **이 시간까지만 새 호출을 시작한다**(ms).
 *
 * 라우트 `maxDuration = 60` 이 `after()` 까지 포함한 함수 수명이다. 스케줄러 동기화는 40초
 * (`START_BUDGET_MS`)에 새 출발을 멈추고 마지막 캐릭터까지 대개 45초 안에 끝난다. 그 뒤 남은
 * 시간에서 마지막 호출 하나(넥슨 왕복 ~1초)와 저장 한 번을 남기고 50초에 멈춘다. 못 한 캐릭터는
 * 행이 없으므로 다음 시간에 다시 시도된다.
 */
export const EXP_FILL_START_DEADLINE_MS = 50_000;

/**
 * 크론 요청이 시작된 뒤 **넥슨 호출이 이 시각을 넘기지 않게** 각 호출의 타임아웃을 자른다(ms).
 *
 * 마감 직전에 시작한 호출이 기본 타임아웃(10초)을 다 쓰면 함수가 `maxDuration`(60초)에 죽고, 그
 * 갈래가 받은 행이 저장 전에 사라진다. 57초로 자르면 그 갈래의 저장 한 번(DB 1왕복)이 60초 안에 든다.
 */
export const EXP_FILL_CALL_DEADLINE_MS = 57_000;

/** 한 번에 만질 추적 캐릭터 상한 — 질의가 미쳤을 때의 안전핀(`nightly-sync` 의 `MAX_CHARACTERS` 와 같은 값). */
const EXP_FILL_MAX_CHARACTERS = 2000;

/** 동시에 진행하는 키 갈래 수. 키 안에서는 `pacedGateway` 가 250ms 간격으로 세운다. */
const EXP_FILL_PARALLEL_CREDENTIALS = 8;

export interface ExpFillSummary {
  /** 시간대 밖이라 아무것도 안 했다. */
  readonly outsideWindow: boolean;
  /** 어제 행이 없어 채울 대상이었던 캐릭터 수. */
  readonly targets: number;
  /** 이미 어제 행이 있어 건너뛴 캐릭터 수. */
  readonly alreadyStored: number;
  readonly filled: number;
  /** 키가 서버에 없거나 80% 를 넘어 건너뛴 캐릭터 수. */
  readonly skippedKey: number;
  readonly failed: number;
  /** 시간 예산에 걸려 다음 시간으로 미룬 캐릭터 수. */
  readonly deferred: number;
  readonly elapsedMs: number;
}

interface FillTarget {
  readonly characterId: string;
  readonly userId: string;
  readonly ocid: string;
  readonly credentialId: string;
}

function emptySummary(startedAt: number, outsideWindow: boolean): ExpFillSummary {
  return {
    outsideWindow,
    targets: 0,
    alreadyStored: 0,
    filled: 0,
    skippedKey: 0,
    failed: 0,
    deferred: 0,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 호출마다 타임아웃을 **남은 시간**으로 자르는 게이트웨이(`EXP_FILL_CALL_DEADLINE_MS`). 게이트웨이가
 * `timeoutMs` 를 그대로 넥슨 요청에 넘기므로(`lib/nexon/gateway.ts`) 클라이언트를 고치지 않는다.
 */
function capTimeout(
  gateway: NexonProxyContext["gateway"],
  startedAt: number,
): NexonProxyContext["gateway"] {
  return {
    request: <T>(args: NexonRequestOptions<T>): Promise<T> => {
      const remaining = startedAt + EXP_FILL_CALL_DEADLINE_MS - Date.now();
      const timeoutMs = Math.max(1, Math.min(args.timeoutMs ?? NEXON_REQUEST_TIMEOUT_MS, remaining));
      return gateway.request({ ...args, timeoutMs });
    },
  };
}

/** 어제 행을 채울 추적 캐릭터와 그 키. 이미 행이 있는 캐릭터 수도 함께. */
async function loadTargets(
  db: AdminDb,
  yesterday: string,
): Promise<{ readonly targets: readonly FillTarget[]; readonly alreadyStored: number }> {
  // 추적 기준은 매시 동기화(`selectCandidates`)와 같다 — 추적 · 사라지지 않음 · ocid 있음.
  const tracked = await db
    .from("characters")
    .select("id")
    .eq("is_tracked", true)
    .is("missing_since", null)
    .not("ocid", "is", null)
    .limit(EXP_FILL_MAX_CHARACTERS);
  if (tracked.error !== null) throw new Error(`추적 캐릭터 조회: ${tracked.error.message}`);
  const characterIds = (tracked.data ?? []).map((row) => row.id);
  if (characterIds.length === 0) return { targets: [], alreadyStored: 0 };

  const sources = await db
    .from("v_character_sync_source")
    .select("character_id,user_id,ocid,credential_id,allow_server_side_use")
    .in("character_id", characterIds)
    .not("ocid", "is", null)
    .not("credential_id", "is", null);
  if (sources.error !== null) throw new Error(`키 출처 조회: ${sources.error.message}`);

  const candidates: FillTarget[] = [];
  for (const row of sources.data ?? []) {
    if (row.allow_server_side_use === false) continue;
    if (row.character_id === null || row.user_id === null) continue;
    if (row.ocid === null || row.credential_id === null) continue;
    candidates.push({
      characterId: row.character_id,
      userId: row.user_id,
      ocid: row.ocid,
      credentialId: row.credential_id,
    });
  }
  if (candidates.length === 0) return { targets: [], alreadyStored: 0 };

  const stored = await db
    .from("character_exp_daily")
    .select("ocid")
    .eq("day", yesterday)
    .in("ocid", candidates.map((target) => target.ocid));
  if (stored.error !== null) throw new Error(`어제 행 조회: ${stored.error.message}`);
  const storedOcids = new Set((stored.data ?? []).map((row) => row.ocid));

  const targets = candidates.filter((target) => !storedOcids.has(target.ocid));
  return { targets, alreadyStored: candidates.length - targets.length };
}

/**
 * 어제 행이 없는 추적 캐릭터를 채운다. **던지지 않는다.**
 *
 * @param startedAt 크론 요청이 시작된 시각(epoch ms). 시간 예산이 여기서부터 잰다.
 */
export async function runExpDailyFill(
  db: AdminDb,
  now: Date,
  startedAt: number,
): Promise<ExpFillSummary> {
  const hour = kstHourOf(now);
  if (hour < EXP_FILL_FIRST_HOUR_KST || hour >= EXP_FILL_END_HOUR_KST) {
    return emptySummary(startedAt, true);
  }
  const yesterday = kstDayKey(addKstDays(kstMoment(kstDayKey(now), 0), -1));

  let loaded: Awaited<ReturnType<typeof loadTargets>>;
  try {
    loaded = await loadTargets(db, yesterday);
  } catch (error) {
    console.warn(
      `[exp-daily-fill] 대상 조회 실패 — 이번 시간은 건너뛴다: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ...emptySummary(startedAt, false), failed: 1 };
  }

  const byCredential = new Map<string, FillTarget[]>();
  for (const target of loaded.targets) {
    const list = byCredential.get(target.credentialId) ?? [];
    list.push(target);
    byCredential.set(target.credentialId, list);
  }

  let filled = 0;
  let skippedKey = 0;
  let failed = 0;
  let deferred = 0;
  const withinBudget = (): boolean =>
    Date.now() - startedAt < EXP_FILL_START_DEADLINE_MS;

  await runWithConcurrency(
    [...byCredential.entries()],
    EXP_FILL_PARALLEL_CREDENTIALS,
    async ([credentialId, list]) => {
      const first = list[0];
      if (first === undefined) return;
      if (!withinBudget()) {
        deferred += list.length;
        return;
      }
      /*
        ★ **갈래(키)마다 끝나는 대로 저장한다.** 맨 끝에서 한 번에 저장하면 함수가 `maxDuration` 에
          죽는 순간 그 회차에 받은 행이 전부 사라진다. 아래 `finally` 가 조기 종료(마감 · 할당량)에도
          저장을 보장한다.
      */
      const rows: ExpDayToSave[] = [];
      try {
        const [context, usage] = await Promise.all([
          buildServerNexonContext({ db, userId: first.userId, credentialId }),
          readQuotaSnapshot(db, credentialId, now),
        ]);
        if (context === null || usage.nearDevBudget) {
          skippedKey += list.length;
          return;
        }
        const gateway = pacedGateway(
          capTimeout(context.gateway, startedAt),
          context.apiKeyHash,
        );

        for (const [index, target] of list.entries()) {
          if (!withinBudget()) {
            deferred += list.length - index;
            return;
          }
          try {
            const result = await fetchCharacterBasicWithExp(
              context.apiKey,
              target.ocid,
              { date: yesterday },
              gateway,
            );
            if (
              result.characterLevel === null ||
              result.characterExp === null ||
              result.characterExpRate === null
            ) {
              failed += 1;
              continue;
            }
            rows.push({
              ocid: target.ocid,
              day: yesterday,
              characterName: result.characterName,
              worldName: result.worldName,
              level: result.characterLevel,
              exp: result.characterExp,
              rateText: result.characterExpRate,
            });
          } catch (error) {
            failed += 1;
            // 할당량에 걸린 키는 남은 캐릭터를 부르지 않는다(게이트웨이도 60초 쿨다운에 든다).
            if (isNexonApiError(error) && error.kind === "quota_exceeded") {
              skippedKey += list.length - index - 1;
              return;
            }
          }
        }
      } catch (error) {
        // 키 준비 단계의 DB 실패. 이 갈래만 실패로 세고 다른 갈래는 계속 간다.
        failed += list.length;
        console.warn(
          `[exp-daily-fill] 키 준비 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (rows.length > 0) {
          const saved = await saveExpDays(db, rows, now);
          filled += saved;
          // 저장이 실패하면 받은 행은 이번에 못 채운 것이다 — 다음 시간에 다시 시도된다.
          failed += rows.length - saved;
        }
      }
    },
  );

  return {
    outsideWindow: false,
    targets: loaded.targets.length,
    alreadyStored: loaded.alreadyStored,
    filled,
    skippedKey,
    failed,
    deferred,
    elapsedMs: Date.now() - startedAt,
  };
}
