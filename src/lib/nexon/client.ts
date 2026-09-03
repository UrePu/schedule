import "server-only";

/**
 * 넥슨 오픈 API 저수준 클라이언트. **서버 전용이다.**
 *
 * 이 파일이 지키는 불변식은 세 가지뿐이다.
 *
 * 1. **키는 헤더로만 나간다.** URL·쿼리·로그·에러 어디에도 들어가지 않는다.
 * 2. **실패는 도메인 에러다.** 호출부는 `OPENAPI0000X` 를 몰라도 된다.
 * 3. **재시도하지 않는다.** 특히 429 는 즉시 포기한다 — 재시도 폭주는 하루 예산을
 *    수 초 만에 태운다(개발 키 1,000콜/일).
 *
 * 호출량 계수·캐시·서킷브레이커는 한 층 위(`gateway.ts`)의 책임이다.
 * 여기서 섞으면 "호출 1건"의 정의가 흐려진다.
 */

import type { z } from "zod";

import {
  NEXON_API_BASE,
  NEXON_API_KEY_HEADER,
  NEXON_PATHS,
  NEXON_REQUEST_TIMEOUT_MS,
} from "./constants";
import { classifyNexonFailure, NexonApiError } from "./errors";
import {
  nexonCycleToBossCycle,
  nexonDifficultyToTier,
  parseOptionalNexonFlag,
} from "./flags";
import {
  characterBasicResponseSchema,
  characterIdResponseSchema,
  characterListResponseSchema,
  nexonErrorBodySchema,
  schedulerStateResponseSchema,
} from "./schemas";
import type {
  NexonBossEntry,
  NexonCallOutcome,
  NexonCharacterBasicResult,
  NexonCharacterListResult,
  NexonCharacterSummary,
  NexonChoreEntry,
  NexonSchedulerStateResult,
} from "./types";

export interface NexonRequestOptions<T> {
  readonly apiKey: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly schema: z.ZodType<T>;
  readonly timeoutMs?: number;
  /**
   * 호출 결과 보고. **성공/실패와 무관하게 정확히 한 번** 불린다.
   * 상위 계층이 이걸로 `nexon_api_quota_usage` 를 적는다.
   */
  readonly onOutcome?: (outcome: NexonCallOutcome) => void;
}

/** 응답 본문에서 넥슨 에러 코드를 뽑는다. 형태가 다르면 null. */
function extractErrorCode(body: unknown): string | null {
  const parsed = nexonErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error.name : null;
}

function extractErrorMessage(body: unknown): string | null {
  const parsed = nexonErrorBodySchema.safeParse(body);
  return parsed.success ? (parsed.data.error.message ?? null) : null;
}

/**
 * 넥슨 호출 1건.
 *
 * @throws {NexonApiError} 네트워크 실패·상류 에러·스키마 불일치 전부 이 타입이다.
 */
export async function nexonRequest<T>(
  options: NexonRequestOptions<T>,
): Promise<T> {
  const url = new URL(options.path, NEXON_API_BASE);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        // ★ 키가 나가는 **유일한** 자리.
        [NEXON_API_KEY_HEADER]: options.apiKey,
        accept: "application/json",
      },
      // 넥슨 응답은 우리가 직접 캐시한다. Next 의 fetch 캐시에 맡기면
      // 키별 격리가 보장되지 않는다.
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? NEXON_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    options.onOutcome?.({
      ok: false,
      httpStatus: null,
      errorCode: null,
      rateLimited: false,
    });
    throw new NexonApiError({
      kind: "network",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  const errorCode = extractErrorCode(body);

  if (!response.ok || errorCode !== null) {
    const kind = classifyNexonFailure(response.status, errorCode);
    options.onOutcome?.({
      ok: false,
      httpStatus: response.status,
      errorCode,
      rateLimited: kind === "quota_exceeded",
    });
    throw new NexonApiError({
      kind,
      code: errorCode,
      upstreamStatus: response.status,
      detail: extractErrorMessage(body),
    });
  }

  options.onOutcome?.({
    ok: true,
    httpStatus: response.status,
    errorCode: null,
    rateLimited: false,
  });

  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    // 조용히 넘기지 않는다. 드리프트는 **보여야** 고칠 수 있다.
    throw new NexonApiError({
      kind: "schema_mismatch",
      upstreamStatus: response.status,
      detail: `${options.path}: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join(" / ")}`,
    });
  }

  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔드포인트별 정규화 래퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 요청 실행기. `gateway.ts` 가 이 자리에 캐시·장부·쿨다운을 끼운 구현을 넣는다.
 * 시그니처가 `nexonRequest` 와 같아야 게이트웨이를 통과시키는 것이 **기본값의 교체**가 된다.
 */
export type NexonRawFetch = <T>(
  options: NexonRequestOptions<T>,
) => Promise<T>;

/** 상위 계층이 캐시·계수를 끼워 넣을 수 있도록 호출자를 주입받는다. */
export interface NexonEndpointDeps {
  readonly request?: NexonRawFetch;
}

function resolveRequest(deps?: NexonEndpointDeps): NexonRawFetch {
  return deps?.request ?? nexonRequest;
}

/**
 * 보유 캐릭터 목록. **이 1콜이 키 유효성 검사이자 소유 증명이다** (§2.1.1).
 * `/v1/id` 를 로그인에 쓰지 않는 이유는 그것이 소유를 증명하지 못하기 때문이다.
 */
export async function fetchCharacterList(
  apiKey: string,
  deps?: NexonEndpointDeps,
): Promise<NexonCharacterListResult> {
  const raw = await resolveRequest(deps)({
    apiKey,
    path: NEXON_PATHS.characterList,
    schema: characterListResponseSchema,
  });

  const accounts = (raw.account_list ?? []).map((account) => ({
    accountId: account.account_id ?? null,
    characters: (account.character_list ?? []).map(
      (character): NexonCharacterSummary => ({
        ocid: character.ocid,
        characterName: character.character_name,
        worldName: character.world_name ?? null,
        characterClass: character.character_class ?? null,
        characterLevel: character.character_level ?? null,
      }),
    ),
  }));

  return {
    accounts,
    characters: accounts.flatMap((account) => account.characters),
  };
}

/** 초상화 1건. `imageUrl === null` 은 정상 상태이며 에러가 아니다. */
export async function fetchCharacterBasic(
  apiKey: string,
  ocid: string,
  deps?: NexonEndpointDeps,
): Promise<NexonCharacterBasicResult> {
  const raw = await resolveRequest(deps)({
    apiKey,
    path: NEXON_PATHS.characterBasic,
    query: { ocid },
    schema: characterBasicResponseSchema,
  });

  return {
    ocid,
    characterName: raw.character_name ?? null,
    worldName: raw.world_name ?? null,
    characterClass: raw.character_class ?? null,
    characterLevel: raw.character_level ?? null,
    guildName: raw.character_guild_name ?? null,
    imageUrl: raw.character_image ?? null,
  };
}

/**
 * 넥슨이 "그런 캐릭터 없음"이라고 답할 때의 에러 코드.
 *
 * ⚠️ `OPENAPI00004` 는 상황이 셋이다(§1.0 실측): 없는 캐릭터명 · 조회 범위 밖 날짜 ·
 *    남의 계정 ocid. **`/id` 에서는 셋 중 첫째만 가능하다** — 이 경로가 받는 파라미터는
 *    `character_name` 하나뿐이라 날짜도 ocid 도 낄 자리가 없다. 그래서 여기서만은
 *    이 코드를 "없음"으로 확정해 읽어도 된다.
 */
const NEXON_CODE_UNKNOWN_CHARACTER_NAME = "OPENAPI00004";

/**
 * **캐릭터명 → ocid.** 소유권 검사가 없어 남의 캐릭터도 나온다(2026-09-03 실측).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `null` 은 실패가 아니라 **"그런 캐릭터 없음"**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 없는 이름은 **HTTP 400 `OPENAPI00004`** 로 온다(`{"error":{"name":"OPENAPI00004",
 * "message":"Please input valid parameter"}}`, 실측). 이것을 `NexonApiError` 로 그대로
 * 던져 올리면 호출부가 그것을 실패로 세게 되는데, 우리가 이 경로에 넘기는 이름은
 * **사람이 손으로 적은 게스트 이름**이라 애초에 캐릭터명이 아닐 수 있다. 오타 하나가
 * "넥슨 API 요청이 실패했습니다"로 보이면 안 된다.
 *
 * 그래서 이 한 코드만 `null` 로 접는다. 나머지(무효 키 · 할당량 · 점검 · 네트워크)는
 * **그대로 던진다** — 그것들은 진짜 실패이고, 조용히 "없음"으로 접으면 그 이름이
 * 음성 캐시에 박혀 실제로 존재하는 캐릭터가 영영 안 나온다.
 *
 * ⚠️ **로그인 검증에 쓰지 말 것**(§2.1.1). 이 경로는 소유를 증명하지 못한다.
 */
export async function fetchCharacterOcidByName(
  apiKey: string,
  characterName: string,
  deps?: NexonEndpointDeps,
): Promise<string | null> {
  try {
    const raw = await resolveRequest(deps)({
      apiKey,
      path: NEXON_PATHS.characterId,
      query: { character_name: characterName },
      schema: characterIdResponseSchema,
    });
    return raw.ocid ?? null;
  } catch (error) {
    if (
      error instanceof NexonApiError &&
      error.code === NEXON_CODE_UNKNOWN_CHARACTER_NAME
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * 넥슨이 "그 ocid 는 유효하지 않다"고 답할 때의 에러 코드(`invalid_id`, §1.0 실측).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **`/id` 가 200 을 준 ocid 를 `/character/basic` 이 400 으로 거절할 수 있다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-03 실측(실제 호출):
 *
 *   `GET /id?character_name=구해야됨`      → **200** `{"ocid":"2690b2ff8dc6519753d37f4a…"}`
 *   `GET /character/basic?ocid=2690b2ff8d…` → **400** `{"error":{"name":"OPENAPI00003",…}}`
 *
 * 즉 이름 검색은 살아 있는데 그 ocid 로는 캐릭터를 볼 수 없는 상태가 존재한다(삭제·이관
 * 등으로 죽은 ocid 로 보인다). 이것은 **호출 실패가 아니라 "지금은 이 캐릭터를 볼 수
 * 없다"는 정상 응답**이라, 부르는 쪽은 재시도가 아니라 기록을 해야 한다 — 실패로 세고
 * 아무것도 적지 않으면 그 이름이 매 훑기마다 2콜씩 영원히 다시 나간다.
 */
const NEXON_CODE_INVALID_OCID = "OPENAPI00003";

/**
 * 이 실패가 **죽은 ocid**(`OPENAPI00003`)인가.
 *
 * ★ **이 코드 하나만** 참이다. 무효 키(`OPENAPI00005`) · 할당량(`OPENAPI00007`) · 점검 ·
 *   네트워크는 전부 거짓이어야 한다 — 그것들은 "이 캐릭터를 볼 수 없다"가 아니라 "지금
 *   우리가 부를 수 없다"이고, 음성 캐시에 박으면 멀쩡한 캐릭터가 캐시 주기 내내 실루엣이
 *   된다. `kind` 가 아니라 `code` 로 보는 이유도 같다: `kind` 는 나중에 다른 코드가 같은
 *   종류로 접힐 수 있는 넓은 축이고, 여기서 필요한 것은 정확히 한 코드다.
 */
export function isInvalidOcidError(error: unknown): boolean {
  return (
    error instanceof NexonApiError && error.code === NEXON_CODE_INVALID_OCID
  );
}

function toBossEntry(raw: {
  content_name?: string | null;
  difficulty?: string | null;
  cycle?: string | null;
  list_order_no?: number | null;
  registration_flag?: string | boolean | null;
  complete_flag?: string | boolean | null;
}): NexonBossEntry {
  return {
    contentName: raw.content_name ?? null,
    difficulty: nexonDifficultyToTier(raw.difficulty ?? null),
    rawDifficulty: raw.difficulty ?? null,
    cycle: nexonCycleToBossCycle(raw.cycle ?? null),
    rawCycle: raw.cycle ?? null,
    registered: parseOptionalNexonFlag(raw.registration_flag),
    cleared: parseOptionalNexonFlag(raw.complete_flag),
    listOrderNo: raw.list_order_no ?? null,
  };
}

function toChoreEntry(raw: {
  content_name?: string | null;
  type?: string | null;
  registration_flag?: string | boolean | null;
  now_count?: number | null;
  max_count?: number | null;
  quest_state?: string | number | null;
}): NexonChoreEntry {
  return {
    contentName: raw.content_name ?? null,
    type: raw.type ?? null,
    registered: parseOptionalNexonFlag(raw.registration_flag),
    nowCount: raw.now_count ?? null,
    maxCount: raw.max_count ?? null,
    questState:
      raw.quest_state === null || raw.quest_state === undefined
        ? null
        : String(raw.quest_state),
  };
}

/**
 * 인게임 스케줄러 상태.
 *
 * ★ 빈 응답은 "그날 접속하지 않았다"이며 **에러가 아니다**(§1.1).
 *   그래서 빈 배열을 그대로 돌려주고 던지지 않는다.
 *
 * `date` 는 **최대 7일 전까지** 확인됐다(30일은 `OPENAPI00004` 로 거절). 정확한 경계는 미측정.
 */
export async function fetchSchedulerCharacterState(
  apiKey: string,
  ocid: string,
  options?: { readonly date?: string },
  deps?: NexonEndpointDeps,
): Promise<NexonSchedulerStateResult> {
  const query: Record<string, string> = { ocid };
  if (options?.date !== undefined) query.date = options.date;

  const raw = await resolveRequest(deps)({
    apiKey,
    path: NEXON_PATHS.schedulerCharacterState,
    query,
    schema: schedulerStateResponseSchema,
  });

  return {
    date: raw.date ?? null,
    characterName: raw.character_name ?? null,
    worldName: raw.world_name ?? null,
    characterClass: raw.character_class ?? null,
    characterLevel: raw.character_level ?? null,
    bosses: (raw.boss_contents ?? []).map(toBossEntry),
    dailyContents: (raw.daily_contents ?? []).map(toChoreEntry),
    weeklyContents: (raw.weekly_contents ?? []).map(toChoreEntry),
    weeklyBossClearCount: raw.weekly_boss_clear_count ?? null,
    weeklyBossClearLimitCount: raw.weekly_boss_clear_limit_count ?? null,
  };
}
