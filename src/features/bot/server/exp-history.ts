import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `!%` — 경험치 히스토리 7일 (2026-11-18)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `!%` 는 **보낸 사람의 본캐**, `!% <닉네임>` 은 그 캐릭터를 본다. 답장 모양과 계산은 전부
 * `lib/domain/exp-history.ts` 가 갖고, 이 파일은 **누구를 어느 키로 몇 번 부를지**만 정한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출 — **보통 최신 1콜**, 표에 없는 지난날만 더한다(+ 닉네임이면 `/id` 1콜)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주(2026-11-18): *"저장하는게 낫지 / 오래걸리잖아"* — 7콜을 키당 250ms 간격으로 내면 1.5초가 든다.
 *   · 오늘은 `/character/basic` 을 `date` 없이(최신) 부른다. 이 경로는 계정에 묶여 있지 않아
 *     **어느 키로든 남의 캐릭터도 읽힌다**(CLAUDE.md §1.1).
 *   · 지난 6일(D-6 … D-1)은 **`character_exp_daily` 표에서 먼저 읽고, 없는 날만** `date` 로 부른다.
 *     지난날은 확정값이라 한 번 받으면 다시 받을 이유가 없다. 새로 받은 날은 답장 뒤에 저장한다
 *     (행 단위로 실패한 날은 저장하지 않고, KST 3시 전에 받은 **어제** 값도 아직 확정 전이라 답장에만
 *     쓴다 — 규칙은 `saveExpDays` 한 곳에 있다). 매시 :50 크론이 추적 캐릭터의 어제 행을 미리 채우므로
 *     (`characters/server/exp-daily-fill.ts`) 추적 캐릭터는 대개 1콜이다. 표를 못 읽으면 예전처럼 7콜.
 *   · 낡은 ocid 재조회(아래)는 `/id` 1콜 + 새 ocid 로 한 번 더(그 ocid 의 표부터 본다).
 *   · **오늘(최신) 1콜은 15분 캐시를 건너뛰고 그 시점에 새로 받는다**(발주 2026-11-18: *"!% 하면 이거
 *     그 시점에 갱신 한번 하는거 알지?"* — 명시적 새로고침, CLAUDE.md §1.1). 대신 방 안 누구나 칠 수
 *     있으므로 `!숙제` 와 같은 **봇 전용 5분 쿨다운**(`REFRESH_COOLDOWN_MS`)을 캐릭터(ocid) 단위로
 *     건다 — 5분 안에 새로 받은 최신값이 있으면 넥슨을 부르지 않는다(`latestByOcid`). 닉네임 → ocid
 *     도 15분 기억해 다른 사람이 같은 캐릭터를 쳐도 `/id` 를 아낀다(`ocidByName`). 둘 다 인스턴스 메모리다.
 *   · 지난날 `date` 호출은 값이 안 바뀌므로 15분 캐시를 그대로 쓴다. 캐시는 **서버 인스턴스별
 *     메모리**이고 실패한 응답은 캐시되지 않는다.
 *   · 키당 4콜/초(`pacedGateway`). 최신용 · 지난날용 게이트웨이가 같은 키 줄을 나눠 쓰고, 같은
 *     인스턴스에서는 다른 봇 명령과도 그 간격을 나눈다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 — **미연결자도 닉네임으로 볼 수 있다**(발주 2026-11-18: *"넥슨 연결 안해도 조회될테네"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 계정에 묶이지 않은 경로라 누구의 키든 된다. 그래서 갈래별로 후보를 늘어놓고, 복호화되고 오늘 호출이
 * 개발 키 한도의 80% 미만(`nearDevBudget` — 남은 몫은 크론과 웹 몫)인 첫 키를 쓴다:
 *   · 연결자 · 본캐:     본캐 계정 키 → 내 다른 서버 보관 키 → 풀
 *   · 연결자 · 닉네임:   내 서버 보관 키 → 풀
 *   · 미연결 · 닉네임:   풀
 * 풀은 서버 보관 키 전체다(`listServerUsableCredentials` — 게스트 초상화와 같은 정렬). 호출 장부는
 * **그 키의 주인** 앞으로 적힌다. 후보는 `KEY_CANDIDATE_MAX` 개까지만 열어 본다.
 *
 * ⚠️ **알려진 위험.** 봇이 있는 방의 누구나 `!% 닉네임` 한 번으로 **남의 키 쿼터를 7~8콜** 쓴다.
 *    80% 줄이 크론 몫은 지키지만, 누가 도배하면 그날은 풀의 키들이 차례로 80% 에 닿아 `!%` 가 먼저
 *    막힌다. 봇은 믿는 사람만 있는 방에 둔다는 전제(CLAUDE.md §2.3) 위에서만 괜찮은 설계다.
 * ⚠️ 풀은 정렬이 결정론적이라 미연결 `!% 남의닉` 이 **같은 풀 키 하나로 몰린다**(80% 에 닿아야 다음
 *    키로 넘어간다). 그 키의 줄을 같은 인스턴스의 `!숙제` 갱신 등과 나눠 쓰므로 서로 기다릴 수 있다.
 *    감수한다 — 키당 초당 한도(4콜/초)가 우선이다(2026-11-18 지휘 결정). 줄 길이는 경우마다 다르다:
 *    추적 캐릭터 · 5분 지난 재조회는 1콜(지난날은 표에)이지만, **추적 밖 남의 캐릭터의 첫 조회는
 *    8콜**(`/id` + 최신 + 6일, 크론이 채우지 않는다)이라 그동안 같은 키의 다른 명령이 약 2초 기다린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 실패 — 넥슨 오류는 던지지 않고 답장으로 바꾼다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 지난 날짜 한 건이 "그날 기록 없음"(`invalid_parameter` 범위 밖·생성 전 · `data_not_ready`
 *     00:00~02:00 의 전날 · `invalid_id`)이면 **그 행만 빼고** 계속한다. 빠진 날은 그 구간의 일수로
 *     표시·평균에 들어간다(`summarizeExpHistory`).
 *   · 최신 조회가 "찾을 수 없음"이고 ocid 가 **우리 DB 에서 온 것**이면, 넥슨이 ocid 를 바꿨을 수
 *     있다(ocid 는 가변값 — CLAUDE.md §1.1). 이름으로 `/id` 를 **한 번** 다시 물어 새 ocid 로 한 번만
 *     다시 시도한다. 그래도 안 되면 "찾을 수 없다". DB 의 ocid 는 고치지 않는다(읽기 명령이다).
 *   · 그 밖(무효 키 · 할당량 · 점검 · 네트워크)은 **나머지 호출을 멈추고** 한 줄로 답한다
 *     (`stopOnFailure`). 다만 첫 실패 응답이 오기 전에 자리 시각(250ms 간격)이 온 호출은 이미
 *     나갔다 — 응답이 늦을수록 그만큼 더 나간다.
 *   · 내부 코드명(`OPENAPI…`)은 로그에만 남고 답장에 나가지 않는다. DB 오류는 던진다 — 라우트가
 *     오류 답장으로 바꾼다.
 */

import { after } from "next/server";

import {
  listServerUsableCredentials,
  type ServerUsableCredentialRef,
} from "@/features/auth/server/credential-keys";
import {
  loadExpDays,
  saveExpDays,
  type ExpDayToSave,
  type StoredExpDay,
} from "@/features/characters/server/exp-daily-store";
import {
  buildServerNexonContext,
  type NexonProxyContext,
} from "@/features/auth/server/nexon-proxy";
import {
  EXP_HISTORY_DAYS,
  EXP_HISTORY_EMPTY_TEXT,
  formatExpHistory,
  type ExpSample,
} from "@/lib/domain/exp-history";
import {
  fetchCharacterBasicWithExp,
  fetchCharacterOcidByName,
  type NexonRequestOptions,
} from "@/lib/nexon/client";
import { NEXON_CACHE_TTL_MS } from "@/lib/nexon/constants";
import { isNexonApiError, type NexonErrorKind } from "@/lib/nexon/errors";
import { createNexonGateway } from "@/lib/nexon/gateway";
import { readQuotaSnapshot } from "@/lib/nexon/quota";
import type { NexonCharacterBasicWithExp } from "@/lib/nexon/types";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";

import { shiftDayKey, type ParsedCommand } from "../lib/command-parse";
import { MAPLE_NICKNAME } from "../lib/nickname";
import { lines } from "../lib/plaintext";
import {
  findMyCharacterOcid,
  loadMainCharacterSource,
  type BotAccount,
} from "./bot-repo";
import type { CommandContext, CommandOutcome } from "./commands";
import { REFRESH_COOLDOWN_MS, pacedGateway } from "./refresh-on-command";

const TAG = "경험치";

/**
 * 키 후보를 **몇 개까지** 열어 보나. 후보 하나에 DB 왕복이 둘(키 복호화용 조회 · 오늘 호출량)이라,
 * 막힌 키가 길게 늘어선 날에도 이 명령의 DB 왕복이 끝없이 늘지 않게 묶는다.
 */
const KEY_CANDIDATE_MAX = 5;

/** 지난 날짜 한 건이 이 종류로 실패하면 **그 행만** 뺀다. 근거는 머리말. */
const ROW_SKIP_KINDS: ReadonlySet<NexonErrorKind> = new Set<NexonErrorKind>([
  "invalid_parameter",
  "data_not_ready",
  "invalid_id",
]);

/**
 * 최신 조회가 이 종류로 실패하면 "캐릭터를 찾을 수 없다"다. `/character/basic` 이 받는 값은
 * ocid 하나뿐이라, 날짜 없는 호출의 `invalid_parameter` 도 같은 뜻으로 읽는다.
 */
const NOT_FOUND_KINDS: ReadonlySet<NexonErrorKind> = new Set<NexonErrorKind>([
  "invalid_id",
  "invalid_parameter",
]);

const NEXON_FAILURE_REPLY = "넥슨 조회가 지금 안 돼요. 잠시 후 다시 쳐 주세요.";
const NOT_FOUND_REPLY =
  "캐릭터를 찾을 수 없어요. 닉네임이 바뀌었다면 새 닉네임으로 쳐 주세요.";
const BUDGET_REPLY = "오늘은 넥슨 조회량이 많아 더 볼 수 없어요. 내일 다시 쳐 주세요.";

/** 키 후보를 늘어놓는 한 단계. 앞 단계가 다 막혀야 다음 단계를 연다(쓸데없는 조회를 줄인다). */
type KeyStage = () => Promise<readonly ServerUsableCredentialRef[]>;

/** 조회할 캐릭터와 그 조회에 쓸 키 후보. */
interface ExpTarget {
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
 * ★ "그 행만 빼는" 실패(`ROW_SKIP_KINDS`)는 지난 날짜에서만 그렇다. 최신 조회(`date` 없음)가 그
 *   종류로 실패하면 대상 자체를 못 읽는 것이라 나머지도 멈춘다.
 * ★ 막힌 호출은 **처음 실패와 같은 오류**로 끝난다 — 부르는 쪽이 원인 하나로 답한다.
 */
function stopOnFailure(
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
 *
 * ★ 게이트웨이 캐시(`lib/nexon/cache.ts`)의 `storedAt` 으로 판정하지 않는 이유: 그 캐시는
 *   **키(`apiKeyHash`)별**이다. `!%` 는 사람마다 다른 키(본캐 키 · 내 키 · 풀)를 쓰므로 같은 캐릭터를
 *   다른 사람이 치면 캐시 키가 달라 쿨다운이 샌다. 그래서 **ocid 단위**로 따로 기억한다.
 * ⚠️ 인스턴스 메모리다. 다른 서버 인스턴스로 간 명령은 이 기억을 못 보고 한 번 더 부른다(`!숙제`
 *    쿨다운도 DB 로 판정하지만 이 값은 DB 에 둘 만큼 비싸지 않다 — 최악이 인스턴스당 5분에 1콜).
 */
const latestByOcid = new Map<string, Memo<NexonCharacterBasicWithExp>>();

/**
 * 정규화한 닉네임 → ocid. 다른 사람이 같은 캐릭터를 `!% 닉네임` 으로 치면 `/id` 1콜도 아낀다.
 *
 * ★ 수명은 넥슨 응답 캐시와 같은 15분이다 — `/id` 응답도 원래 게이트웨이가 15분 들고 있으니 새로
 *   생기는 낡음은 없다(다만 그 캐시와 달리 키를 가리지 않는다). 닉네임이 그 사이 바뀌어 기억한
 *   ocid 가 "찾을 수 없음"이 되면, 이름으로 `/id` 를 다시 묻는 재조회(A3)가 그대로 받아 준다.
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

/** 넥슨 오류를 로그 한 조각으로. 키 · ocid · 닉네임은 싣지 않는다. */
function describeFailure(error: unknown): string {
  if (isNexonApiError(error)) return `${error.kind}${error.code === null ? "" : ` ${error.code}`}`;
  return error instanceof Error ? error.name : "unknown";
}

function nexonFailure(error: unknown, userId: string | null): CommandOutcome {
  console.warn(`[bot/exp] 넥슨 조회 실패: ${describeFailure(error)}`);
  return { reply: lines(NEXON_FAILURE_REPLY), tag: `${TAG}:넥슨오류`, userId };
}

function toSample(
  result: NexonCharacterBasicWithExp,
  dayKey: string,
): ExpSample | null {
  if (
    result.characterLevel === null ||
    result.characterExp === null ||
    result.characterExpRate === null
  ) {
    return null;
  }
  return {
    dayKey,
    level: result.characterLevel,
    exp: result.characterExp,
    rateText: result.characterExpRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 키 고르기
// ─────────────────────────────────────────────────────────────────────────────

type KeyPick =
  | { readonly kind: "ok"; readonly context: NexonProxyContext }
  /** 열린 키는 있었지만 전부 오늘 80% 를 넘었다. */
  | { readonly kind: "budget" }
  /** 열 수 있는 키가 하나도 없었다. */
  | { readonly kind: "none" };

/**
 * 단계 순서대로 후보를 열어 보고 **처음 쓸 수 있는 키**를 돌려준다.
 *
 * ★ 복호화는 `buildServerNexonContext` 에 **그 키 주인의 `userId`** 를 넘긴다 — 컨텍스트의 주인이
 *   곧 호출 장부(`nexon_api_quota_usage`, 자격증명 단위)의 주인이다.
 */
async function pickKey(
  db: AdminDb,
  now: Date,
  stages: readonly KeyStage[],
): Promise<KeyPick> {
  const seen = new Set<string>();
  let budgetBlocked = false;

  for (const stage of stages) {
    if (seen.size >= KEY_CANDIDATE_MAX) break;
    for (const candidate of await stage()) {
      if (seen.size >= KEY_CANDIDATE_MAX) break;
      if (seen.has(candidate.credentialId)) continue;
      seen.add(candidate.credentialId);

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
      return { kind: "ok", context: nexon };
    }
  }
  return budgetBlocked ? { kind: "budget" } : { kind: "none" };
}

/** 키를 못 고른 이유별 답. 미연결자에게 "웹에서 키를 넣으라"는 맞지 않는다. */
function keyMissReply(
  kind: "budget" | "none",
  linked: boolean,
  userId: string | null,
): CommandOutcome {
  if (kind === "budget") {
    return { reply: lines(BUDGET_REPLY), tag: `${TAG}:예산`, userId };
  }
  return {
    reply: linked
      ? lines(
          "넥슨 키가 서버에 저장돼 있지 않아 조회할 수 없어요.",
          "웹의 [기타] → 계정 · 키 관리에서 키를 한 번 입력해 주세요.",
        )
      : lines("지금은 조회할 수 있는 넥슨 키가 없어요."),
    tag: `${TAG}:키없음`,
    userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 대상 정하기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 누구를 볼지 정한다. 답할 말이 정해졌으면(미연결 안내 · 형식 · 본캐 없음) 그 답을 돌려준다.
 */
async function resolveTarget(
  context: CommandContext,
  account: BotAccount | null,
  nickname: string,
): Promise<ExpTarget | CommandOutcome> {
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
          "!% 닉네임 처럼 쳐 주세요.",
          "!연결 <코드> 로 계정을 연결하면 !% 만 쳐도 본캐가 나와요.",
        ),
        tag: `${TAG}:미연결`,
        userId: null,
      };
    }
    const main = await loadMainCharacterSource(db, account.userId);
    if (main === null || main.ocid === null) {
      return {
        reply: lines("본캐가 등록돼 있지 않아요. !% 닉네임 처럼 쳐 주세요."),
        tag: `${TAG}:본캐없음`,
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
      tag: `${TAG}:형식`,
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

function isOutcome(value: ExpTarget | CommandOutcome): value is CommandOutcome {
  return "tag" in value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7일 조회
// ─────────────────────────────────────────────────────────────────────────────

type HistoryFetch =
  | {
      readonly kind: "ok";
      readonly latest: NexonCharacterBasicWithExp;
      readonly samples: readonly ExpSample[];
      /** 이번에 넥슨에서 **새로 받은 지난날**. 저장 대상이다(행 단위 실패한 날은 없다). */
      readonly fresh: readonly ExpDayToSave[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: unknown };

function storedToSample(row: StoredExpDay): ExpSample {
  return { dayKey: row.day, level: row.level, exp: row.exp, rateText: row.rateText };
}

/**
 * 한 ocid 의 7일. 지난 6일은 **표에 있는 날은 표에서**, 없는 날만 넥슨에서 받는다.
 *
 * ★ **최신을 맨 앞에 보낸다** — 죽은 ocid 면 첫 응답에서 알고, 그 뒤 자리를 기다리던 호출은
 *   `stopOnFailure` 가 막는다(그 응답보다 먼저 자리가 온 호출은 이미 나갔다).
 * ★ 최신 호출을 먼저 출발시키고 그동안 표를 읽는다. 표 읽기(DB 1왕복)가 최신 호출을 늦추지 않고,
 *   빠진 날의 호출은 어차피 최신 뒤 250ms 자리부터라 표 읽기를 기다려도 손해가 없다.
 * ★ 표 읽기가 실패하면 `loadExpDays` 가 빈 배열을 준다 — 그때는 예전처럼 7콜이다.
 */
async function fetchExpSamples(
  db: AdminDb,
  nexon: NexonProxyContext,
  ocid: string,
  todayKey: string,
  nowMs: number,
): Promise<HistoryFetch> {
  const stop = { stopped: null as unknown };
  /*
    멈춘 뒤의 호출은 키 줄에 서지도 않고, 줄에서 기다리다 멈춤을 알게 되면 자리를 쓰지 않고 빠진다
    (`pacedGateway` 의 `abortReason`). 같은 키 줄 뒤의 `/id` 재조회 · 다른 명령이 기다리지 않게.
  */
  const paced = { abortReason: (): unknown => stop.stopped };
  // 지난날은 값이 안 바뀌므로 15분 캐시를 그대로 쓴다.
  const datedGateway = pacedGateway(
    stopOnFailure(nexon.gateway, stop),
    nexon.apiKeyHash,
    paced,
  );
  /*
    ★ 오늘(최신)은 **그 시점에 새로 받는다**(발주 2026-11-18: *"!% 하면 이거 그 시점에 갱신 한번
      하는거 알지?"*) — 사람이 친 명령은 명시적 새로고침이라 15분 캐시를 건너뛴다(CLAUDE.md §1.1).
      같은 키 · 같은 장부로 캐시 읽기만 끈 게이트웨이다. 받은 값은 캐시에도 쓴다(게이트웨이 규칙).
    ★ 간격은 위와 **같은 키 줄**(`pacedGateway`)을 탄다 — 게이트웨이가 둘이어도 키당 4콜/초다.
    ★ 주간·월간 초기화 직후 20분 무호출 규칙(`lib/time/reset-window.ts`)은 **적용하지 않는다.** 그
      규칙은 초기화 전 `complete_flag` 가 새 주에 가짜 클리어를 만드는 스케줄러 문제이고, 경험치는
      아무것도 기록하지 않고 보여 주기만 한다.
  */
  const latestGateway = pacedGateway(
    stopOnFailure(
      createNexonGateway({
        apiKey: nexon.apiKey,
        apiKeyHash: nexon.apiKeyHash,
        credentialId: nexon.credentialId,
        db: nexon.db,
        bypassCache: true,
      }),
      stop,
    ),
    nexon.apiKeyHash,
    paced,
  );
  const pastKeys = Array.from({ length: EXP_HISTORY_DAYS - 1 }, (_, index) =>
    shiftDayKey(todayKey, index - (EXP_HISTORY_DAYS - 1)),
  );

  /*
    ★ **봇 쿨다운 5분**(`REFRESH_COOLDOWN_MS` — `!숙제` 와 같은 값). 방 안 누구나 칠 수 있으므로
      같은 캐릭터의 최신값을 5분 안에 새로 받았으면 그 값을 쓰고 넥슨을 부르지 않는다(`latestByOcid`).
  */
  /*
    ★ 기억 열쇠에 **오늘(KST)** 을 넣는다. 23:58 에 받은 값을 00:01 에 꺼내면 어제 값이 `오늘` 줄로
      찍힌다 — 날이 바뀌면 같은 캐릭터라도 새로 받는다.
  */
  const latestMemoKey = `${todayKey}|${ocid}`;
  const recent = recall(latestByOcid, latestMemoKey, REFRESH_COOLDOWN_MS, nowMs);
  const latestPromise: Promise<NexonCharacterBasicWithExp> =
    recent !== null
      ? Promise.resolve(recent)
      : fetchCharacterBasicWithExp(nexon.apiKey, ocid, {}, latestGateway).then((value) => {
          remember(latestByOcid, latestMemoKey, value, REFRESH_COOLDOWN_MS, nowMs);
          /*
            다음 사람이 같은 캐릭터를 닉네임으로 치면 `/id` 없이 이 ocid 를 쓴다(`ocidByName`).
            ★ **넥슨이 방금 답했을 때만** 적는다. 기억에서 꺼낸 값으로 다시 적으면 근거 없이 수명만
              늘어난다.
          */
          if (value.characterName !== null) {
            remember(ocidByName, nameKey(value.characterName), ocid, NEXON_CACHE_TTL_MS, nowMs);
          }
          return value;
        });
  // 표를 읽는 동안 최신 호출이 먼저 실패해도 "처리 안 된 거부"로 떨어지지 않게 한다(아래 allSettled 가 받는다).
  latestPromise.catch(() => undefined);

  const firstDay = pastKeys[0];
  const lastDay = pastKeys[pastKeys.length - 1];
  const stored =
    firstDay === undefined || lastDay === undefined
      ? []
      : await loadExpDays(db, ocid, firstDay, lastDay);
  const storedByDay = new Map(stored.map((row) => [row.day, row]));
  // 표를 읽는 사이 최신이 이미 실패했으면 빠진 날 호출은 만들지도 않는다 — 답은 어차피 그 실패다.
  const missingKeys =
    stop.stopped !== null ? [] : pastKeys.filter((day) => !storedByDay.has(day));

  const [latestSettled, ...missingSettled] = await Promise.allSettled([
    latestPromise,
    ...missingKeys.map((date) =>
      fetchCharacterBasicWithExp(nexon.apiKey, ocid, { date }, datedGateway),
    ),
  ]);

  if (latestSettled === undefined) return { kind: "failed", error: null };
  if (latestSettled.status === "rejected") {
    const error: unknown = latestSettled.reason;
    return isNexonApiError(error) && NOT_FOUND_KINDS.has(error.kind)
      ? { kind: "not-found" }
      : { kind: "failed", error };
  }

  const fetchedByDay = new Map<string, NexonCharacterBasicWithExp>();
  for (const [index, settled] of missingSettled.entries()) {
    const dayKey = missingKeys[index];
    if (dayKey === undefined) continue;
    if (settled.status === "rejected") {
      const error: unknown = settled.reason;
      if (isNexonApiError(error) && ROW_SKIP_KINDS.has(error.kind)) continue;
      return { kind: "failed", error };
    }
    fetchedByDay.set(dayKey, settled.value);
  }

  const samples: ExpSample[] = [];
  const fresh: ExpDayToSave[] = [];
  for (const dayKey of pastKeys) {
    const row = storedByDay.get(dayKey);
    if (row !== undefined) {
      samples.push(storedToSample(row));
      continue;
    }
    const fetched = fetchedByDay.get(dayKey);
    if (fetched === undefined) continue;
    const sample = toSample(fetched, dayKey);
    if (sample === null) continue;
    samples.push(sample);
    fresh.push({
      ocid,
      day: dayKey,
      characterName: fetched.characterName,
      worldName: fetched.worldName,
      level: sample.level,
      exp: sample.exp,
      rateText: sample.rateText,
    });
  }
  const latest = latestSettled.value;
  const todaySample = toSample(latest, todayKey);
  if (todaySample !== null) samples.push(todaySample);
  return { kind: "ok", latest, samples, fresh };
}

/**
 * 새로 받은 지난날을 저장한다. **답장을 늦추지 않는다** — 저장을 지금 시작하고, 응답 뒤에도 함수가
 * 살아 있도록 `after()` 에 넘긴다(`refresh-on-command.refreshBeforeReply` 와 같은 방식). 저장은
 * 던지지 않고(`saveExpDays`), 플랫폼이 `after` 를 못 받아도 이미 시작한 저장은 그대로 간다.
 */
function saveInBackground(db: AdminDb, rows: readonly ExpDayToSave[], now: Date): void {
  if (rows.length === 0) return;
  const work = saveExpDays(db, rows, now);
  try {
    after(() => work);
  } catch (error) {
    console.warn(
      `[bot/exp] after 등록 실패 — 저장이 잘릴 수 있다: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

export async function handleExpHistory(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  // 메이플 닉네임에는 공백이 없다 — `!% 암 뻐` 는 오타로 보고 받아 준다(`!환산` 과 같다).
  const nickname = parsed.rest.replace(/\s+/gu, "");
  const userId = account?.userId ?? null;

  const target = await resolveTarget(context, account, nickname);
  if (isOutcome(target)) return target;

  const pick = await pickKey(context.db, context.now, target.keyStages);
  if (pick.kind !== "ok") return keyMissReply(pick.kind, account !== null, userId);
  const nexon = pick.context;
  // `/id` 도 같은 키의 간격을 탄다(`pacedGateway` 는 키별 자리 시계를 모듈이 들고 있다).
  const idGateway = pacedGateway(nexon.gateway, nexon.apiKeyHash);

  const nowMs = context.now.getTime();
  /*
    ocid 를 어디서 얻었나. 우리 DB(내 캐릭터 · 본캐) → 최근 기억(`ocidByName`) → 넥슨 `/id` 순이다.
    앞의 둘은 **이번에 넥슨에 물어본 값이 아니라서** 낡았을 수 있다 — 그때만 재조회한다(아래 ★).
  */
  let ocid =
    target.ocid ??
    (nickname === ""
      ? null
      : recall(ocidByName, nameKey(nickname), NEXON_CACHE_TTL_MS, nowMs));
  const ocidNeedsRecheck = ocid !== null;
  if (ocid === null) {
    try {
      ocid = await fetchCharacterOcidByName(nexon.apiKey, nickname, idGateway);
    } catch (error) {
      return nexonFailure(error, userId);
    }
    if (ocid === null) {
      return {
        reply: lines(`'${nickname}' — 그런 캐릭터가 없어요.`),
        tag: `${TAG}:없음`,
        userId,
      };
    }
    remember(ocidByName, nameKey(nickname), ocid, NEXON_CACHE_TTL_MS, nowMs);
  }

  const todayKey = kstDayKey(context.now);
  let history = await fetchExpSamples(context.db, nexon, ocid, todayKey, nowMs);

  /*
    ★ **낡은 ocid 를 한 번만 다시 찾는다**(머리말). 이번에 `/id` 로 받은 ocid 가 **아닐 때만**이다 —
      방금 받은 ocid 가 안 되면 다시 물어도 같은 답이다. 재시도는 한 번뿐이라 호출은 최대 `/id` 1 + 7.
  */
  if (history.kind === "not-found" && ocidNeedsRecheck && target.lookupName !== null) {
    let fresh: string | null;
    try {
      fresh = await fetchCharacterOcidByName(nexon.apiKey, target.lookupName, idGateway);
    } catch (error) {
      return nexonFailure(error, userId);
    }
    if (fresh !== null && fresh !== ocid) {
      console.info("[bot/exp] 저장된 ocid 로 찾지 못해 이름으로 다시 찾았습니다.");
      // 표도 새 ocid 기준으로 읽고 쓴다(`fetchExpSamples` 가 받은 ocid 를 그대로 쓴다).
      remember(ocidByName, nameKey(target.lookupName), fresh, NEXON_CACHE_TTL_MS, nowMs);
      history = await fetchExpSamples(context.db, nexon, fresh, todayKey, nowMs);
    }
  }

  if (history.kind === "failed") return nexonFailure(history.error, userId);
  if (history.kind === "not-found") {
    return { reply: lines(NOT_FOUND_REPLY), tag: `${TAG}:없음`, userId };
  }
  saveInBackground(context.db, history.fresh, context.now);
  if (history.samples.length === 0) {
    return { reply: lines(EXP_HISTORY_EMPTY_TEXT), tag: `${TAG}:빈`, userId };
  }

  // 길이 상한은 `formatExpHistory` 주석(최악 실측)이 지킨다.
  return {
    reply: lines(
      ...formatExpHistory({
        characterName: history.latest.characterName ?? target.fallbackName,
        worldName: history.latest.worldName,
        samples: history.samples,
        todayKey,
      }),
    ),
    tag: TAG,
    userId,
  };
}
