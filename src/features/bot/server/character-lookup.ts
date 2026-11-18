import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 하나를 넥슨에서 읽는 봇 명령의 **공통 부분** — `!%` · `!ㄼ`(2026-11-18)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `!%`(경험치 7일, `./exp-history.ts`)와 `!ㄼ` · `!ㄹㅂ`(레벨업 날짜, `./level-history.ts`)는 **누구를
 * 어느 키로 읽고, 최신값을 언제 새로 받는가**가 같다. 그 부분을 한 벌로 둔다 — 두 벌이면 쿨다운이나
 * 키 사다리가 한쪽에서만 고쳐진다.
 *   · 대상 해석(`resolveLookupTarget`) — 인자 없음 = 보낸 사람의 본캐, 닉네임 = 아무 캐릭터.
 *   · 키 사다리(`pickKey`) — 본캐 키 → 보낸 사람의 서버 보관 키 → 풀. 명령의 콜 수가 크면 그만큼 남은
 *     키를 고른다(`KeyBudget`).
 *   · 닉네임 → ocid(`resolveOcid`) · 낡은 ocid 재확인(`recheckOcid`).
 *   · **최신 1콜**(`fetchLatestWithCooldown`) — 15분 캐시를 건너뛰고 그 시점에 새로 받되, 캐릭터당 5분
 *     쿨다운. **쿨다운 기억은 두 명령이 함께 쓴다** — `!%` 직후 5분 안의 `!ㄼ` 는 최신을 다시 받지 않는다.
 *   · 실패 답장 문구.
 * 근거와 위험(남의 키 쿼터를 쓴다 등)은 `./exp-history.ts` 머리말이 처음 적은 그대로다.
 */

import {
  listServerUsableCredentials,
  type ServerUsableCredentialRef,
} from "@/features/auth/server/credential-keys";
import {
  buildServerNexonContext,
  type NexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import {
  fetchCharacterBasicWithExp,
  fetchCharacterOcidByName,
  type NexonRequestOptions,
} from "@/lib/nexon/client";
import {
  NEXON_CACHE_TTL_MS,
  NEXON_DAILY_BUDGET_WARN_RATIO,
  NEXON_DEV_KEY_DAILY_BUDGET,
} from "@/lib/nexon/constants";
import { isNexonApiError, type NexonErrorKind } from "@/lib/nexon/errors";
import { createNexonGateway } from "@/lib/nexon/gateway";
import { readQuotaSnapshot } from "@/lib/nexon/quota";
import type { NexonCharacterBasicWithExp } from "@/lib/nexon/types";
import type { AdminDb } from "@/lib/supabase/admin-db";

import { MAPLE_NICKNAME } from "../lib/nickname";
import { lines } from "../lib/plaintext";
import {
  findMyCharacterOcid,
  loadMainCharacterSource,
  type BotAccount,
} from "./bot-repo";
import type { CommandContext, CommandOutcome } from "./commands";
import { REFRESH_COOLDOWN_MS } from "./refresh-on-command";

/** 이 모듈을 쓰는 명령 하나. 답장 · 로그에서 갈리는 것은 이 셋뿐이다. */
export interface LookupCommand {
  /** 답장에 되읽어 주는 명령(`!%` · 사람이 친 `!ㄼ`/`!ㄹㅂ`). */
  readonly label: string;
  /** 감사 로그 `result` 의 머리(`경험치` · `레벨`). */
  readonly tag: string;
  /** 플랫폼 로그 머리(`bot/exp` · `bot/level`). 키 · ocid · 닉네임은 로그에 싣지 않는다. */
  readonly logTag: string;
}

/**
 * 키 후보를 **몇 개까지** 열어 보나. 후보 하나에 DB 왕복이 둘(키 복호화용 조회 · 오늘 호출량)이라,
 * 막힌 키가 길게 늘어선 날에도 이 명령의 DB 왕복이 끝없이 늘지 않게 묶는다.
 */
const KEY_CANDIDATE_MAX = 5;

/**
 * 키 하나가 하루에 쓸 수 있다고 보는 선 — 개발 키 한도의 80%(`nearDevBudget` 과 같은 선). 남은 몫은
 * 크론과 웹 몫이다(`refresh-on-command.prepareContexts` 주석).
 */
const DEV_BUDGET_STOP_LINE = NEXON_DEV_KEY_DAILY_BUDGET * NEXON_DAILY_BUDGET_WARN_RATIO;

/** 지난 날짜 한 건이 이 종류로 실패하면 **그 날만** 빼거나 "데이터 없음"으로 본다. */
export const ROW_SKIP_KINDS: ReadonlySet<NexonErrorKind> = new Set<NexonErrorKind>([
  "invalid_parameter",
  "data_not_ready",
  "invalid_id",
]);

/**
 * 최신 조회가 이 종류로 실패하면 "캐릭터를 찾을 수 없다"다. `/character/basic` 이 받는 값은
 * ocid 하나뿐이라, 날짜 없는 호출의 `invalid_parameter` 도 같은 뜻으로 읽는다.
 */
export const NOT_FOUND_KINDS: ReadonlySet<NexonErrorKind> = new Set<NexonErrorKind>([
  "invalid_id",
  "invalid_parameter",
]);

const NEXON_FAILURE_REPLY = "넥슨 조회가 지금 안 돼요. 잠시 후 다시 쳐 주세요.";
const NOT_FOUND_REPLY =
  "캐릭터를 찾을 수 없어요. 닉네임이 바뀌었다면 새 닉네임으로 쳐 주세요.";
const BUDGET_REPLY = "오늘은 넥슨 조회량이 많아 더 볼 수 없어요. 내일 다시 쳐 주세요.";
/** 다른 `!ㄼ` 의 예약에 막혔을 때(`busy`). 그 조회가 끝나면 몫이 돌아온다. */
const BUSY_REPLY = "다른 레벨 조회가 진행 중이에요. 잠시 후 다시 쳐 주세요.";

/** 키 후보를 늘어놓는 한 단계. 앞 단계가 다 막혀야 다음 단계를 연다(쓸데없는 조회를 줄인다). */
export type KeyStage = () => Promise<readonly ServerUsableCredentialRef[]>;

/** 조회할 캐릭터와 그 조회에 쓸 키 후보. */
export interface LookupTarget {
  readonly keyStages: readonly KeyStage[];
  /** 우리 DB 가 아는 ocid. 없으면 키를 연 뒤 `/id` 로 찾는다. */
  readonly ocid: string | null;
  /** `ocid` 가 낡았을 때 `/id` 로 다시 물을 이름. 물을 수 없으면 `null`. */
  readonly lookupName: string | null;
  /** 헤더에 쓸 이름의 마지막 대안(넥슨 응답에 이름이 없을 때). */
  readonly fallbackName: string;
}

/**
 * 실패한 호출 뒤로 **아직 나가지 않은** 호출을 막는 게이트웨이. 시도 한 번마다 새로 만든다.
 *
 * ★ "그 날만 빼는" 실패(`ROW_SKIP_KINDS`)는 지난 날짜에서만 그렇다. 최신 조회(`date` 없음)가 그
 *   종류로 실패하면 대상 자체를 못 읽는 것이라 나머지도 멈춘다.
 * ★ 막힌 호출은 **처음 실패와 같은 오류**로 끝난다 — 부르는 쪽이 원인 하나로 답한다.
 */
export function stopOnFailure(
  gateway: NexonProxyContext["gateway"],
  /** 같은 시도 안의 게이트웨이들(최신용 · 지난날용)이 **함께** 보는 정지 상태. */
  state: { stopped: unknown },
): NexonProxyContext["gateway"] {
  return {
    request: async <T>(args: NexonRequestOptions<T>): Promise<T> => {
      if (state.stopped !== null) throw state.stopped;
      try {
        return await gateway.request(args);
      } catch (error) {
        const latest = args.query?.date === undefined;
        const rowOnly =
          !latest && isNexonApiError(error) && ROW_SKIP_KINDS.has(error.kind);
        if (!rowOnly && state.stopped === null) state.stopped = error;
        throw error;
      }
    },
  };
}

/**
 * 최신 조회용 게이트웨이 — **15분 캐시를 읽지 않는다.** 사람이 친 명령은 명시적 새로고침이다
 * (CLAUDE.md §1.1). 같은 키 · 같은 장부이고, 받은 값은 캐시에도 쓴다(게이트웨이 규칙). 키당 간격은
 * 부르는 쪽이 `pacedGateway` 로 씌운다.
 */
export function createLatestGateway(nexon: NexonProxyContext): NexonProxyContext["gateway"] {
  return createNexonGateway({
    apiKey: nexon.apiKey,
    apiKeyHash: nexon.apiKeyHash,
    credentialId: nexon.credentialId,
    db: nexon.db,
    bypassCache: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 최신 조회의 봇 쿨다운 · 이름 → ocid 기억 (서버 인스턴스 메모리)
// ─────────────────────────────────────────────────────────────────────────────

/** 기억해 둔 값 하나와 그 값을 얻은 시각(epoch ms). */
interface Memo<V> {
  readonly at: number;
  readonly value: V;
}

/**
 * ocid → 마지막으로 **넥슨에서 새로 받은** 최신값. 봇 쿨다운(`REFRESH_COOLDOWN_MS`, 5분)의 근거다.
 * **`!%` 와 `!ㄼ` 가 같은 맵을 본다.**
 *
 * ★ 게이트웨이 캐시(`lib/nexon/cache.ts`)의 `storedAt` 으로 판정하지 않는 이유: 그 캐시는
 *   **키(`apiKeyHash`)별**이다. 이 명령들은 사람마다 다른 키(본캐 키 · 내 키 · 풀)를 쓰므로 같은
 *   캐릭터를 다른 사람이 치면 캐시 키가 달라 쿨다운이 샌다. 그래서 **ocid 단위**로 따로 기억한다.
 * ⚠️ 인스턴스 메모리다. 다른 서버 인스턴스로 간 명령은 이 기억을 못 보고 한 번 더 부른다(`!숙제`
 *    쿨다운도 DB 로 판정하지만 이 값은 DB 에 둘 만큼 비싸지 않다 — 최악이 인스턴스당 5분에 1콜).
 */
const latestByOcid = new Map<string, Memo<NexonCharacterBasicWithExp>>();

/**
 * 정규화한 닉네임 → ocid. 다른 사람이 같은 캐릭터를 닉네임으로 치면 `/id` 1콜도 아낀다.
 *
 * ★ 수명은 넥슨 응답 캐시와 같은 15분이다 — `/id` 응답도 원래 게이트웨이가 15분 들고 있으니 새로
 *   생기는 낡음은 없다(다만 그 캐시와 달리 키를 가리지 않는다). 닉네임이 그 사이 바뀌어 기억한
 *   ocid 가 "찾을 수 없음"이 되면, 이름으로 `/id` 를 다시 묻는 재조회(`recheckOcid`)가 그대로 받아 준다.
 */
const ocidByName = new Map<string, Memo<string>>();

/** 두 기억의 크기 상한. 넘으면 수명이 지난 것부터, 그래도 넘으면 오래된 것부터 지운다. */
const MEMO_LIMIT = 512;

function nameKey(name: string): string {
  return name.replace(/\s+/gu, "").toLowerCase();
}

function recall<V>(map: Map<string, Memo<V>>, key: string, ttlMs: number, now: number): V | null {
  const memo = map.get(key);
  if (memo === undefined) return null;
  if (now - memo.at >= ttlMs) return null;
  return memo.value;
}

function remember<V>(
  map: Map<string, Memo<V>>,
  key: string,
  value: V,
  ttlMs: number,
  now: number,
): void {
  map.delete(key);
  map.set(key, { at: now, value });
  if (map.size <= MEMO_LIMIT) return;
  for (const [stale, memo] of map) {
    if (now - memo.at >= ttlMs) map.delete(stale);
  }
  while (map.size > MEMO_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * 오늘(최신) 1콜. **5분 안에 같은 캐릭터를 새로 받았으면 넥슨을 부르지 않는다**(봇 쿨다운 — `!숙제` 와
 * 같은 `REFRESH_COOLDOWN_MS`). 방 안 누구나 칠 수 있기 때문이다.
 *
 * ★ 기억 열쇠에 **오늘(KST)** 을 넣는다. 23:58 에 받은 값을 00:01 에 꺼내면 어제 값이 오늘 값으로
 *   찍힌다 — 날이 바뀌면 같은 캐릭터라도 새로 받는다.
 * ★ 넥슨이 **방금 답했을 때만** 이름 → ocid 를 적는다. 기억에서 꺼낸 값으로 다시 적으면 근거 없이
 *   수명만 늘어난다.
 * ★ 호출은 이 함수를 부르는 순간 출발한다(거부도 그대로 돌려준다). 부르는 쪽이 그동안 DB 를 읽어도 된다.
 *
 * @param gateway 최신용 게이트웨이(`createLatestGateway` 를 부르는 쪽이 감싼 것).
 */
export function fetchLatestWithCooldown(
  nexon: NexonProxyContext,
  ocid: string,
  todayKey: string,
  nowMs: number,
  gateway: NexonProxyContext["gateway"],
): Promise<NexonCharacterBasicWithExp> {
  const memoKey = `${todayKey}|${ocid}`;
  const recent = recall(latestByOcid, memoKey, REFRESH_COOLDOWN_MS, nowMs);
  if (recent !== null) return Promise.resolve(recent);
  return fetchCharacterBasicWithExp(nexon.apiKey, ocid, {}, gateway).then((value) => {
    remember(latestByOcid, memoKey, value, REFRESH_COOLDOWN_MS, nowMs);
    if (value.characterName !== null) {
      remember(ocidByName, nameKey(value.characterName), ocid, NEXON_CACHE_TTL_MS, nowMs);
    }
    return value;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 실패 답장
// ─────────────────────────────────────────────────────────────────────────────

/** 넥슨 오류를 로그 한 조각으로. 키 · ocid · 닉네임은 싣지 않는다. */
export function describeFailure(error: unknown): string {
  if (isNexonApiError(error)) return `${error.kind}${error.code === null ? "" : ` ${error.code}`}`;
  return error instanceof Error ? error.name : "unknown";
}

/** 넥슨이 안 될 때의 답. 내부 코드명(`OPENAPI…`)은 로그에만 남는다. */
export function nexonFailure(
  error: unknown,
  userId: string | null,
  command: LookupCommand,
): CommandOutcome {
  console.warn(`[${command.logTag}] 넥슨 조회 실패: ${describeFailure(error)}`);
  return { reply: lines(NEXON_FAILURE_REPLY), tag: `${command.tag}:넥슨오류`, userId };
}

/** ocid 로 캐릭터를 못 읽었다(재확인 뒤에도). */
export function notFoundOutcome(userId: string | null, command: LookupCommand): CommandOutcome {
  return { reply: lines(NOT_FOUND_REPLY), tag: `${command.tag}:없음`, userId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 키 고르기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이 명령이 한 번에 쓸 넥슨 콜 수(`calls`)와, 그보다 적게 남은 키를 그래도 먼저 쓸 최소 몫(`minCalls`).
 *
 * ★ `!ㄼ` 는 첫 조회에 수십 콜이 들고 그 비용이 남의 키에 청구될 수 있다. 80% 바로 밑의 키를 골라
 *   60콜을 쓰면 그 키는 크론 몫까지 먹는다. 그래서 상한을 **80% 선까지 남은 몫**으로 줄여 쓴다
 *   (`allowance`). 고르는 규칙은 `pickKey` 주석.
 */
export interface KeyBudget {
  readonly calls: number;
  readonly minCalls: number;
  /**
   * 탐침 없이도 이 명령이 쓸 수 있는 **고정 콜의 최대치**(`/id` · 최신 · 낡은 ocid 재확인 `/id` · 다시 최신).
   * 남은 몫이 이보다 적은 키는 쓰지 않는다 — 몫 1~2 인 키를 고르면 고정 콜만으로 80% 선을 넘는다(R2-3).
   */
  readonly fixedCalls: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 키별 예약 — 겹친 `!ㄼ` 가 같은 장부 값을 보고 각자 60콜을 쓰지 않게 (지휘 결정 2026-11-18, D1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 키(자격증명) 하나의 **이 인스턴스 안** 예약 상태.
 *
 * 장부(`nexon_api_quota_usage`)에는 응답이 끝난 콜만 적힌다 — 게이트웨이가 `finally` 에서
 * `recordNexonCall` 을 **기다린 뒤** 요청을 끝내므로, "응답이 끝났다" = "장부에 적혔다"다
 * (`lib/nexon/gateway.ts`). 그래서 진행 중인 명령의 몫은 둘로 나뉜다:
 *   · 아직 안 보낸 콜 + 날아가는 중인 콜 → 장부에 없다 → `reserved` 가 센다.
 *   · 응답이 끝난 콜 → 장부에 있다 → `reserved` 에서 빠진다(이중 차감 금지).
 */
interface KeyLedger {
  /** 진행 중인 예약들이 아직 장부에 올리지 않은 콜의 합. */
  reserved: number;
  /**
   * 예약한 명령이 보낸 콜 중 **응답이 끝난** 누적 수(줄지 않는다). 장부를 읽는 동안 끝난 콜은 그 읽기에
   * 들었는지 알 수 없으므로, `pickKey` 는 읽기 전후의 차이만큼을 장부에 더해 센다(많게 세는 쪽).
   */
  settled: number;
}

const ledgerByCredential = new Map<string, KeyLedger>();

/** 예약 상태 맵의 크기 상한. 넘으면 예약이 없는 키부터 지운다(자격증명 수만큼이라 보통 닿지 않는다). */
const KEY_LEDGER_LIMIT = 256;

function ledgerFor(credentialId: string): KeyLedger {
  const existing = ledgerByCredential.get(credentialId);
  if (existing !== undefined) return existing;
  if (ledgerByCredential.size >= KEY_LEDGER_LIMIT) {
    for (const [id, ledger] of ledgerByCredential) {
      if (ledger.reserved <= 0) ledgerByCredential.delete(id);
    }
  }
  const created: KeyLedger = { reserved: 0, settled: 0 };
  ledgerByCredential.set(credentialId, created);
  return created;
}

/** 한 명령이 잡은 몫. `settleReservedCall` · `releaseReservation` 으로만 줄인다. */
export interface CallReservation {
  readonly credentialId: string;
  /** 잡은 몫 = 이 명령의 콜 상한. */
  readonly allowance: number;
  /** 아직 장부에 오르지 않은 몫(안 보낸 콜 + 날아가는 콜). */
  unsettled: number;
  released: boolean;
}

function reserveCalls(credentialId: string, amount: number): CallReservation {
  ledgerFor(credentialId).reserved += amount;
  return { credentialId, allowance: amount, unsettled: amount, released: false };
}

/**
 * 예약한 명령의 콜 하나가 **응답까지 끝났다**(그래서 장부에 적혔다). 부르는 쪽은 보낸 콜마다 정확히
 * 한 번, 그 요청이 끝날 때 부른다. 캐시 적중(장부에 안 오른다)도 부른다 — 몫이 그만큼 일찍 풀릴 뿐이다.
 */
export function settleReservedCall(reservation: CallReservation): void {
  const ledger = ledgerFor(reservation.credentialId);
  ledger.settled += 1;
  if (reservation.released || reservation.unsettled <= 0) return;
  reservation.unsettled -= 1;
  ledger.reserved -= 1;
}

/** 남은 몫을 푼다. 명령이(탐색까지) 끝나면 예외 경로를 포함해 **반드시** 부른다. 두 번 불러도 된다. */
export function releaseReservation(reservation: CallReservation): void {
  if (reservation.released) return;
  reservation.released = true;
  ledgerFor(reservation.credentialId).reserved -= reservation.unsettled;
  reservation.unsettled = 0;
}

export type KeyPick =
  | {
      readonly kind: "ok";
      readonly context: NexonProxyContext;
      /** 이 명령이 이 키로 쓸 수 있는 콜 수. 예산을 안 줬으면 무한대(80% 선만 본다). */
      readonly allowance: number;
      /**
       * 예산을 줬을 때 잡아 둔 몫(`allowance` 와 같은 양). 부르는 쪽이 콜마다 `settleReservedCall`,
       * 끝날 때 `releaseReservation` 을 부른다. 예산이 없으면 `null`.
       */
      readonly reservation: CallReservation | null;
    }
  /** 열린 키는 있었지만 전부 오늘 80%(예산을 줬으면 고정 콜 몫도 안 남았다)에 닿았다. */
  | { readonly kind: "budget" }
  /**
   * 장부만 보면 몫이 있는 키가 있었는데 **이 인스턴스의 다른 `!ㄼ` 예약** 때문에 모자랐다(R2-1). 그 조회가
   * 끝나면 몫이 돌아오므로 "내일"이 아니라 "잠시 후"다.
   */
  | { readonly kind: "busy" }
  /** 열 수 있는 키가 하나도 없었다. */
  | { readonly kind: "none" };

/**
 * 단계 순서대로 후보를 열어 보고 **처음 쓸 수 있는 키**를 돌려준다.
 *
 * ★ 복호화는 `buildServerNexonContext` 에 **그 키 주인의 `userId`** 를 넘긴다 — 컨텍스트의 주인이
 *   곧 호출 장부(`nexon_api_quota_usage`, 자격증명 단위)의 주인이다.
 * ★ `budget` 을 안 주면 예전 `!%` 그대로다 — 80% 미만인 첫 키. 예약을 보지도 잡지도 않는다.
 * ★ `budget` 을 주면(`!ㄼ`) 남은 몫 = 80% 선 − 장부 − 이 인스턴스의 예약(D1). 사다리 순서대로 남은 몫이
 *   `minCalls` 이상인 **첫** 키를 `min(calls, 남은 몫)` 으로 쓴다 — 내 키가 부분 몫이어도 남의 풀 키보다
 *   먼저다(D6). 그런 키가 없으면 남은 몫이 `fixedCalls`(고정 콜 최대치) 이상인 첫 키를 그 몫만큼 쓴다(저장
 *   표본 + 쿨다운이면 0~1콜로 답할 수 있다 — R2-3). 고르는 순간 몫을 **같은 틱에서** 예약하므로, 이
 *   인스턴스에서 겹친 명령은 서로의 예약을 본다. 장부로는 몫이 있었는데 예약 때문에 못 고른 키가 있으면
 *   `busy`(R2-1).
 * ⚠️ **인스턴스가 다르면 막지 못한다.** 예약은 메모리에 있고, 다른 인스턴스의 진행 중 콜은 응답이 끝나
 *    장부에 오르기 전까지 보이지 않는다. 두 인스턴스에서 같은 키로 동시에 첫 `!ㄼ` 가 돌면 80% 선을
 *    한 명령 몫(최대 60콜)까지 넘을 수 있다. `!%` · `!숙제` 갱신 · 크론처럼 예약하지 않는 경로의 날아가는
 *    콜(한 줌)도 여기 안 보인다. 그 밖의 여유는 80% 선 위의 200콜이 받는다.
 */
export async function pickKey(
  db: AdminDb,
  now: Date,
  stages: readonly KeyStage[],
  budget?: KeyBudget,
): Promise<KeyPick> {
  const seen = new Set<string>();
  let budgetBlocked = false;
  /** 장부만 보면 고정 콜 몫이 있는데 예약 때문에 모자란 키가 있었다. */
  let reservationBlocked = false;
  /** 남은 몫이 `minCalls` 미만이지만 `fixedCalls` 이상인 첫 키. 다시 셀 때 쓸 장부 값을 함께 든다. */
  let fallback: {
    readonly context: NexonProxyContext;
    readonly credentialId: string;
    readonly callCount: number;
    readonly settledBefore: number;
  } | null = null;

  /** 예약이 없었다면의 남은 몫(장부만). */
  const ledgerRoomOf = (callCount: number): number =>
    Math.floor(DEV_BUDGET_STOP_LINE - callCount);
  /** 지금의 예약 상태로 다시 센 남은 몫. 장부를 읽는 사이 끝난 예약 콜은 빠졌다고 보고 더한다. */
  const roomOf = (credentialId: string, callCount: number, settledBefore: number): number => {
    const ledger = ledgerByCredential.get(credentialId);
    const settledDuringRead = Math.max(0, (ledger?.settled ?? 0) - settledBefore);
    return Math.floor(
      DEV_BUDGET_STOP_LINE - callCount - settledDuringRead - (ledger?.reserved ?? 0),
    );
  };

  for (const stage of stages) {
    if (seen.size >= KEY_CANDIDATE_MAX) break;
    for (const candidate of await stage()) {
      if (seen.size >= KEY_CANDIDATE_MAX) break;
      if (seen.has(candidate.credentialId)) continue;
      seen.add(candidate.credentialId);

      const settledBefore = ledgerByCredential.get(candidate.credentialId)?.settled ?? 0;
      const [nexon, usage] = await Promise.all([
        buildServerNexonContext({
          db,
          userId: candidate.userId,
          credentialId: candidate.credentialId,
        }),
        readQuotaSnapshot(db, candidate.credentialId, now),
      ]);
      if (nexon === null) continue;
      if (usage.nearDevBudget) {
        budgetBlocked = true;
        continue;
      }
      if (budget === undefined) {
        return {
          kind: "ok",
          context: nexon,
          allowance: Number.POSITIVE_INFINITY,
          reservation: null,
        };
      }
      // ★ 셈과 예약 사이에 `await` 가 없다 — 겹친 명령이 같은 몫을 두 번 잡지 못한다.
      const room = roomOf(candidate.credentialId, usage.callCount, settledBefore);
      if (room >= budget.minCalls) {
        const allowance = Math.min(budget.calls, room);
        return {
          kind: "ok",
          context: nexon,
          allowance,
          reservation: reserveCalls(candidate.credentialId, allowance),
        };
      }
      if (room >= budget.fixedCalls) {
        fallback ??= {
          context: nexon,
          credentialId: candidate.credentialId,
          callCount: usage.callCount,
          settledBefore,
        };
      } else if (ledgerRoomOf(usage.callCount) >= budget.fixedCalls) {
        reservationBlocked = true;
      } else {
        budgetBlocked = true;
      }
    }
  }
  if (fallback !== null && budget !== undefined) {
    // 그사이 다른 명령이 예약했을 수 있다 — 지금 상태로 다시 센다.
    const room = roomOf(fallback.credentialId, fallback.callCount, fallback.settledBefore);
    if (room >= budget.fixedCalls) {
      return {
        kind: "ok",
        context: fallback.context,
        allowance: room,
        reservation: reserveCalls(fallback.credentialId, room),
      };
    }
    reservationBlocked = true;
  }
  if (reservationBlocked) return { kind: "busy" };
  return budgetBlocked ? { kind: "budget" } : { kind: "none" };
}

/** 키를 못 고른 이유별 답. 미연결자에게 "웹에서 키를 넣으라"는 맞지 않는다. */
export function keyMissReply(
  kind: "budget" | "none" | "busy",
  linked: boolean,
  userId: string | null,
  command: LookupCommand,
): CommandOutcome {
  if (kind === "budget") {
    return { reply: lines(BUDGET_REPLY), tag: `${command.tag}:예산`, userId };
  }
  if (kind === "busy") {
    return { reply: lines(BUSY_REPLY), tag: `${command.tag}:진행중`, userId };
  }
  return {
    reply: linked
      ? lines(
          "넥슨 키가 서버에 저장돼 있지 않아 조회할 수 없어요.",
          "웹의 [기타] → 계정 · 키 관리에서 키를 한 번 입력해 주세요.",
        )
      : lines("지금은 조회할 수 있는 넥슨 키가 없어요."),
    tag: `${command.tag}:키없음`,
    userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 대상 정하기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 누구를 볼지 정한다. 답할 말이 정해졌으면(미연결 안내 · 형식 · 본캐 없음) 그 답을 돌려준다.
 *
 * 키 사다리(계정에 묶이지 않은 경로라 누구의 키든 된다):
 *   · 연결자 · 본캐:     본캐 계정 키 → 내 다른 서버 보관 키 → 풀
 *   · 연결자 · 닉네임:   내 서버 보관 키 → 풀
 *   · 미연결 · 닉네임:   풀
 * 풀은 서버 보관 키 전체다(`listServerUsableCredentials` — 게스트 초상화와 같은 정렬).
 */
export async function resolveLookupTarget(
  context: CommandContext,
  account: BotAccount | null,
  nickname: string,
  command: LookupCommand,
): Promise<LookupTarget | CommandOutcome> {
  const db = context.db;
  const userId = account?.userId ?? null;
  const pool: KeyStage = () =>
    listServerUsableCredentials(db, { limit: KEY_CANDIDATE_MAX * 2 });

  if (nickname === "") {
    /*
      ★ 미연결이면 "본캐"가 누구인지 모른다. 닉네임을 붙이면 지금도 된다는 것과, 연결하면 인자 없이
        된다는 것을 함께 말한다 — `!환산` 미연결 안내와 같은 결이다.
    */
    if (account === null) {
      return {
        reply: lines(
          `${command.label} 닉네임 처럼 쳐 주세요.`,
          `!연결 <코드> 로 계정을 연결하면 ${command.label} 만 쳐도 본캐가 나와요.`,
        ),
        tag: `${command.tag}:미연결`,
        userId: null,
      };
    }
    const main = await loadMainCharacterSource(db, account.userId);
    if (main === null || main.ocid === null) {
      return {
        reply: lines(`본캐가 등록돼 있지 않아요. ${command.label} 닉네임 처럼 쳐 주세요.`),
        tag: `${command.tag}:본캐없음`,
        userId,
      };
    }
    const mainCredentialId = main.credentialId;
    const ownerId = account.userId;
    return {
      keyStages: [
        async () =>
          mainCredentialId === null
            ? []
            : [{ credentialId: mainCredentialId, userId: ownerId }],
        () => listServerUsableCredentials(db, { userId: ownerId, limit: KEY_CANDIDATE_MAX }),
        pool,
      ],
      ocid: main.ocid,
      lookupName:
        main.characterName !== null && MAPLE_NICKNAME.test(main.characterName)
          ? main.characterName
          : null,
      // `label` 은 본캐가 없으면 계정 표시명으로 떨어지므로 캐릭터 이름 자리에 쓰지 않는다.
      fallbackName: main.characterName ?? account.mainCharacterName ?? "본캐",
    };
  }

  if (!MAPLE_NICKNAME.test(nickname)) {
    return {
      reply: lines("닉네임만 적어 주세요. (한글·영문·숫자 2~12자)"),
      tag: `${command.tag}:형식`,
      userId,
    };
  }

  // 미연결자는 "내 캐릭터"가 없으므로 DB 지름길을 건너뛰고 바로 `/id` 로 간다.
  if (account === null) {
    return { keyStages: [pool], ocid: null, lookupName: nickname, fallbackName: nickname };
  }
  const ownerId = account.userId;
  return {
    keyStages: [
      () => listServerUsableCredentials(db, { userId: ownerId, limit: KEY_CANDIDATE_MAX }),
      pool,
    ],
    ocid: await findMyCharacterOcid(db, ownerId, nickname),
    lookupName: nickname,
    fallbackName: nickname,
  };
}

export function isOutcome(value: LookupTarget | CommandOutcome): value is CommandOutcome {
  return "tag" in value;
}

// ─────────────────────────────────────────────────────────────────────────────
// ocid 정하기 · 낡은 ocid 재확인
// ─────────────────────────────────────────────────────────────────────────────

export type OcidResolution =
  | {
      readonly kind: "ok";
      readonly ocid: string;
      /**
       * 우리 DB · 최근 기억에서 온 ocid 다 — **이번에 넥슨에 물어본 값이 아니라서** 낡았을 수 있다.
       * 최신 조회가 "찾을 수 없음"이면 그때만 `recheckOcid` 로 다시 묻는다.
       */
      readonly needsRecheck: boolean;
    }
  | { readonly kind: "reply"; readonly outcome: CommandOutcome };

/**
 * ocid 를 정한다. 우리 DB(내 캐릭터 · 본캐) → 최근 기억(`ocidByName`) → 넥슨 `/id` 순이다.
 * `/id` 는 그 키의 간격을 타는 `idGateway` 로 부른다.
 */
export async function resolveOcid(args: {
  readonly nexon: NexonProxyContext;
  readonly target: LookupTarget;
  readonly nickname: string;
  readonly idGateway: NexonProxyContext["gateway"];
  readonly nowMs: number;
  readonly userId: string | null;
  readonly command: LookupCommand;
}): Promise<OcidResolution> {
  const { nexon, target, nickname, idGateway, nowMs, userId, command } = args;
  let ocid =
    target.ocid ??
    (nickname === ""
      ? null
      : recall(ocidByName, nameKey(nickname), NEXON_CACHE_TTL_MS, nowMs));
  if (ocid !== null) return { kind: "ok", ocid, needsRecheck: true };

  try {
    ocid = await fetchCharacterOcidByName(nexon.apiKey, nickname, idGateway);
  } catch (error) {
    return { kind: "reply", outcome: nexonFailure(error, userId, command) };
  }
  if (ocid === null) {
    return {
      kind: "reply",
      outcome: {
        reply: lines(`'${nickname}' — 그런 캐릭터가 없어요.`),
        tag: `${command.tag}:없음`,
        userId,
      },
    };
  }
  remember(ocidByName, nameKey(nickname), ocid, NEXON_CACHE_TTL_MS, nowMs);
  return { kind: "ok", ocid, needsRecheck: false };
}

export type RecheckResult =
  /** 이름으로 다시 물었더니 다른 ocid 가 나왔다 — 그 ocid 로 **한 번만** 다시 시도한다. */
  | { readonly kind: "fresh"; readonly ocid: string }
  /** 같은 ocid 거나 그런 이름이 없다 — "찾을 수 없음"으로 답한다. */
  | { readonly kind: "same" }
  | { readonly kind: "reply"; readonly outcome: CommandOutcome };

/**
 * **낡은 ocid 를 한 번만 다시 찾는다.** ocid 는 넥슨이 가변값이라고 적어 둔 값이다(CLAUDE.md §1.1).
 * 이번에 `/id` 로 받은 ocid 가 **아닐 때만** 부른다 — 방금 받은 ocid 가 안 되면 다시 물어도 같은 답이다.
 * DB 의 ocid 는 고치지 않는다(읽기 명령이다).
 */
export async function recheckOcid(args: {
  readonly nexon: NexonProxyContext;
  readonly lookupName: string;
  readonly staleOcid: string;
  readonly idGateway: NexonProxyContext["gateway"];
  readonly nowMs: number;
  readonly userId: string | null;
  readonly command: LookupCommand;
}): Promise<RecheckResult> {
  const { nexon, lookupName, staleOcid, idGateway, nowMs, userId, command } = args;
  let fresh: string | null;
  try {
    fresh = await fetchCharacterOcidByName(nexon.apiKey, lookupName, idGateway);
  } catch (error) {
    return { kind: "reply", outcome: nexonFailure(error, userId, command) };
  }
  if (fresh === null || fresh === staleOcid) return { kind: "same" };
  console.info(`[${command.logTag}] 저장된 ocid 로 찾지 못해 이름으로 다시 찾았습니다.`);
  remember(ocidByName, nameKey(lookupName), fresh, NEXON_CACHE_TTL_MS, nowMs);
  return { kind: "fresh", ocid: fresh };
}
