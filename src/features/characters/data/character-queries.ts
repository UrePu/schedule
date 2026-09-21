"use client";

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { ApiRequestError } from "@/features/auth/data/auth-api";
import { queryKeys } from "@/lib/query-keys";
import type {
  ApiErrorBody,
  LoginCharacter,
  SessionUser,
} from "@/features/auth/types";
import type { GameCharacter, TrackedCharacterSelection } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 데이터 접근 경계
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 화면은 이 파일의 함수만 부른다. 여기서 나가는 요청은 전부 **실제 우리 API** 다 —
 * 대체 데이터 경로는 존재하지 않는다.
 *
 * ── 목록은 **우리 DB** 에서 온다 — 쿼터가 설계를 정한다 (§2.1.1) ─────────────
 * 로그인할 때 서버가 이미 `/character/list` 를 **1콜** 불러 `public.characters` 에
 * 전부 upsert 해 둔다(`syncCredentialInventory`). 그러니 캐릭터 선택 모달이 열릴 때마다
 * 같은 엔드포인트를 다시 부르는 것은 **같은 데이터에 쿼터만 태우는 짓**이다.
 * 게다가 `/character/list` 응답에는 우리 PK(`characters.id`)가 없어서, 추적 대상을
 * 저장하려면 어차피 우리 DB 행과 맞춰야 한다.
 *   → 목록: `GET /api/characters` (**넥슨 콜 0**)
 *   → 초상화만: `GET /api/nexon/character/basic` (**캐릭터당 1콜**, 보이는 12명분만)
 *
 * 초상화 호출은 이 파일이 아니라 `useNexonCharacterPortraitQuery`(features/auth)가
 * 맡는다. 그쪽이 `nexonQueryOptions()` 로 `staleTime ≥ 15분` 을 코드로 강제하기 때문이다.
 *
 * ── 쓰기는 반드시 서버를 거친다 ──────────────────────────────────────────────
 * 인증 모델 (c) 에서 `anon` 은 전 테이블 차단이라 브라우저가 `characters` 를 직접 쓸 수
 * 없다. 추적 대상 저장은 `PUT /api/characters/tracked` (service_role) 한 경로뿐이다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 캐시 키
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 캐릭터 목록은 **우리 DB** 에서 오므로 `"db"` 네임스페이스다(`src/lib/query-keys.ts`
 * 규약). 넥슨을 타지 않으니 15분 하한의 대상이 아니고 `db` 티어(60초)를 쓴다.
 *
 * ⚠️ **여기에 키를 정의하지 않는다.** 예전에는 "이 키를 쓰는 곳이 이 기능 하나뿐"이라는
 *    이유로 팩토리를 여기 뒀는데, 실제로는 `auth-queries.ts` 두 곳이 같은 키를 배열
 *    리터럴로 다시 적고 있었다 — 정확히 §2.4 Rule 5 가 말하는 실패다. 본체는
 *    `queryKeys.db.characters` 하나뿐이고 이 이름은 **별칭**이다.
 */
export const characterQueryKeys = queryKeys.db.characters;

// ─────────────────────────────────────────────────────────────────────────────
// 계약
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 캐릭터 선택 모달이 쓰는 한 행.
 *
 * 로그인 응답의 `LoginCharacter` 와 **같은 모양**에 `imageUrl` 만 더한다 —
 * 두 화면이 같은 행을 다른 타입으로 보면 매핑이 두 벌이 된다.
 * `imageUrl` 은 `characters.image_url` 캐시이며 `null` 이 정상이다(§2.1.1).
 */
export interface TrackableCharacter extends LoginCharacter {
  /** 저장된 초상화. `null` 이면 그때만 넥슨 `/character/basic` 을 1콜 태운다. */
  readonly imageUrl: string | null;
  /**
   * 이 캐릭터를 읽을 수 있는 자격증명. **초상화 호출에 쓸 키를 고르는 열쇠**다.
   *
   * 넥슨 키는 자기 계정의 캐릭터만 읽으므로(§1.1), 부계정 캐릭터의 초상화를 본계정 키로
   * 부르면 `OPENAPI00004` 로 거절당하면서 **호출량만 태운다.** 원문 키는 브라우저에만
   * 있으니(§2.1.1) 서버는 이 id 만 실어 주고, 고르는 일은 브라우저가 한다.
   *
   * `null` 이면 그 계정에 쓸 수 있는 키가 없다 — 초상화는 실루엣으로 두고 호출하지 않는다.
   */
  readonly credentialId: string | null;
  /**
   * **넥슨 목록에서 안 보이게 된 시각.** `null` 이 정상(지난 새로고침에 있었다).
   *
   * 값이 있으면 월드 리프·삭제 등으로 그 캐릭터를 더는 조회할 수 없다는 뜻이다.
   * **오류가 아니라 상태**이며, 행은 지우지 않는다 — 클리어·수익 기록이 그 id 에
   * 매달려 있다(마이그레이션 `20260914120000_character_missing_since.sql`).
   */
  readonly missingSince: string | null;
}

/** `GET /api/characters` */
export interface CharacterListResponse {
  readonly characters: readonly TrackableCharacter[];
}

/**
 * `POST /api/characters/refresh` — 넥슨에서 **캐릭터 목록을 다시 받는다**.
 *
 * 목록(`characters`)을 함께 돌려주는 이유는 `saveTrackedCharacters` 와 같다: 새로고침의
 * 결과가 곧 새 목록이라 여기서 주지 않으면 화면이 `GET /api/characters` 를 한 번 더
 * 불러야 한다(넥슨 호출은 아니지만 왕복은 왕복이다).
 */
export interface RefreshCharactersResponse {
  readonly summary: CharacterRefreshSummary;
  readonly characters: readonly TrackableCharacter[];
}

/** 새로고침 1회의 결과. 서버 `CharacterRefreshSummary` 와 **같은 모양**이다. */
export interface CharacterRefreshSummary {
  /** 새 행이 생긴 수. **월드 리프는 여기 안 들어온다**(2026-09-21 — 같은 행을 이어 쓴다). */
  readonly added: number;
  readonly renamed: number;
  /** 같은 행의 월드가 바뀐 수. ocid 까지 바뀐 **월드 리프도 여기로** 잡힌다. */
  readonly worldChanged: number;
  /** 처음 안 보이게 된 캐릭터 수. 이어진 리프는 빠지므로 삭제 · 월드 폐쇄에 가깝다. */
  readonly missing: number;
  readonly returned: number;
  /** 방금 사라진 캐릭터. 월드를 함께 싣는 이유는 서버 타입 주석 참고(대량 실종). */
  readonly missingCharacters: readonly {
    readonly name: string;
    readonly worldName: string | null;
  }[];
  readonly credentialsRefreshed: number;
  readonly credentialsSkipped: number;
  readonly credentialsFailed: number;
  /** 캐릭터를 0명 돌려준 넥슨 계정 수. 그 계정은 사라짐 판정에서 통째로 빠진다. */
  readonly emptyAccounts: number;
  readonly nexonCalls: number;
}

/**
 * `PUT /api/characters/tracked`
 *
 * `user` 를 함께 돌려주는 이유: 본캐가 바뀌면 표시 정체성(`main_character_name`)이
 * 트리거로 함께 바뀐다. 여기서 주지 않으면 화면이 `/api/auth/me` 를 한 번 더 불러야 한다.
 */
export interface SaveTrackedCharactersResponse {
  readonly characters: readonly TrackableCharacter[];
  readonly user: SessionUser;
}

// ─────────────────────────────────────────────────────────────────────────────
// 요청 래퍼
// ─────────────────────────────────────────────────────────────────────────────

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== "object" || candidate === null) return false;
  const error = candidate as { kind?: unknown; message?: unknown };
  return typeof error.kind === "string" && typeof error.message === "string";
}

/**
 * 실패를 **`ApiRequestError` 하나로** 접는다. `features/auth/data/auth-api.ts` 의
 * 비공개 `request` 와 같은 규약이며, 화면이 잡는 타입도 같은 `ApiRequestError` 다 —
 * 그래야 어떤 기능에서 온 실패든 화면이 `kind` 하나로만 분기한다.
 */
async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
    // 세션 쿠키가 실려야 한다. 기본값이지만 명시해 의도를 남긴다.
    credentials: "same-origin",
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiRequestError(
        body.error.kind,
        body.error.message,
        response.status,
        body.error.code ?? null,
      );
    }
    throw new ApiRequestError(
      "internal",
      "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      response.status,
      null,
    );
  }

  return body as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회 / 저장
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 세션 사용자의 캐릭터 전체.
 * → `GET /api/characters` — **우리 DB 를 읽는다. 넥슨 호출 0건.**
 *
 * ⚠️ 시그니처가 바뀌었다(예전: `fetchOwnedCharacters(credentialId)`).
 *   목록이 자격증명 단위가 아니라 **사용자 단위**가 됐기 때문이다. 한 사람이 여러 키를
 *   등록하면 캐릭터도 합쳐서 보여야 하고(§2.1), 추적 대상 저장도 사용자 단위다.
 */
export function fetchOwnedCharacters(): Promise<readonly TrackableCharacter[]> {
  return requestJson<CharacterListResponse>("/api/characters", {
    method: "GET",
  }).then((body) => body.characters);
}

/**
 * 추적 대상 + 본캐 저장.
 * → `PUT /api/characters/tracked` (Route Handler + service_role)
 *
 * 본캐가 추적 대상에 없으면 **서버가 400** 으로 막는다 — 표시 정체성이 본캐 닉네임이라
 * 추적하지 않는 본캐는 성립하지 않는다(§2.1). 여기서 미리 던지지 않는 이유는 판정이
 * 두 곳에 있으면 반드시 갈라지기 때문이다. 서버 하나만 진실이다.
 */
export function saveTrackedCharacters(
  input: TrackedCharacterSelection,
): Promise<SaveTrackedCharactersResponse> {
  return requestJson<SaveTrackedCharactersResponse>(
    "/api/characters/tracked",
    {
      method: "PUT",
      body: JSON.stringify({
        characterIds: input.characterIds,
        mainCharacterId: input.mainCharacterId,
      }),
    },
  );
}

/**
 * 넥슨에서 캐릭터 목록을 다시 받는다.
 * → `POST /api/characters/refresh` (**자격증명 1개당 1콜**, 최대 3콜)
 *
 * ⚠️ `fetchOwnedCharacters()` 와 **의도적으로 다른 경로**다. 그쪽은 우리 DB 만 읽고
 *    넥슨을 한 번도 부르지 않으며, 그 설계는 그대로 둔다(§2.1.1). 이쪽은 사용자가
 *    버튼을 눌렀을 때만 도는 문이다 — 화면 진입·폴링으로 부르지 말 것.
 */
export function refreshOwnedCharacters(): Promise<RefreshCharactersResponse> {
  return requestJson<RefreshCharactersResponse>("/api/characters/refresh", {
    method: "POST",
  });
}

/**
 * 캐릭터 목록 새로고침 뮤테이션.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 낙관적이지 않은가
 * ─────────────────────────────────────────────────────────────────────────────
 * 결과를 **예측할 수 없다.** 추적 저장(`saveTrackedCharacters`)은 사용자가 방금 고른
 * 것이 곧 결과라 지어낼 것이 없지만, 새로고침의 결과는 넥슨만 안다. 미리 그려 두면
 * "3명 추가"가 잠깐 떴다가 "변경 없음"으로 뒤집히는 화면이 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 무효화 대상을 **읽어서 골랐다** (§2.4 Rule 5 — 접두어가 같다고 자동으로 덮이지 않는다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 새로고침이 실제로 바꾸는 것은 세 가지다: **캐릭터가 늘고 · 이름/월드가 바뀌고 ·
 * 사라진 표시가 붙거나 풀린다.** 그래서 "캐릭터 이름 또는 명단을 그리는 쿼리"가 전부
 * 대상이다.
 *
 * | 키                              | 왜 포함했나 |
 * |---------------------------------|-------------|
 * | `db.characters.list()`          | 모달 자신의 목록. **응답으로 직접 덮는다**(아래 `onSuccess`) — 방금 받은 값이 있는데 다시 받을 이유가 없다. |
 * | `db.characters.forRuns()`       | 일정 등록의 "데려갈 캐릭터" 후보. `characters.list()` 의 **형제**라 `list()` 만 건드리면 갱신되지 않는다 — Rule 5 의 경고가 정확히 이 모양이다. |
 * | `db.auth.session()`             | `/api/auth/me` 가 `characterCount` · `trackedCharacterCount` · 키별 캐릭터 수를 싣는다. 캐릭터가 늘면 버튼 옆 "추적 N명"과 키 목록의 숫자가 함께 틀려진다. |
 * | `db.bossPlans.root()`           | 캐릭별 계획·주간 체크리스트가 `characters` 를 조인해 **이름을 그린다.** 개명이 여기까지 와야 한다. |
 * | `db.dashboard.root()`           | 이번 주 현황의 12칸 분모는 `추적 캐릭터 수 × 12` 다(§1.1.1). |
 * | `db.chores.root()`              | 기타 숙제 판도 추적 캐릭터별로 이름을 그린다(봇 `!숙제` 와 같은 조립기). |
 * | `db.party.root()`               | ★ 파티 조회가 `characters(character_name, is_main, character_level, character_class, image_url)` 를 **임베드한다** (`schedule-repo.ts` 의 `MY_PARTY_SELECT`, 구성원 조회). 개명하면 `/parties` 가 옛 이름을 그린다. |
 * | `db.runs.root()`                | ★ 주간 시간표도 `characters(character_name)` 을 임베드한다(`timetable-repo.ts`). `runs.timetable()` 이 이 접두사 **아래**라 한 번으로 덮인다. |
 *
 * ⚠️ 마지막 둘은 처음에 빠져 있었다. staleTime 60초라 곧 자체 치유되지만, 개명 직후
 *    `/parties` · `/schedule` · `/`(주간표)가 옛 이름을 그리는 창이 생긴다. 이 표는
 *    **조인을 읽고 쓴 것**이지 키 이름의 모양으로 짐작한 것이 아니다(§2.4 Rule 5 —
 *    접두어가 같다고 자동으로 덮이지 않는다).
 *
 * 넣지 **않은** 것과 이유: `db.income.*` 은 클리어 원장에서 나오고 캐릭터 이름 변경으로
 * 금액이 달라지지 않는다. `db.people.pool()` 은 친구·게스트 후보라 `characters` 를
 * 임베드하지 않는다. `nexon.*` 은 전부 쿼터를 먹는 캐시라 여기서 날리면 초상화 12장을
 * 이유 없이 다시 받는다 — 위 여덟은 **전부 `"db"` 네임스페이스**이며 무효화 비용이
 * 우리 DB 왕복뿐인 것이 이 목록의 조건이었다.
 */
export function useRefreshCharactersMutation(): UseMutationResult<
  RefreshCharactersResponse,
  Error,
  void
> {
  const queryClient = useQueryClient();

  return useMutation<RefreshCharactersResponse, Error, void>({
    mutationFn: () => refreshOwnedCharacters(),
    onSuccess: (data) => {
      // 서버가 갱신된 목록을 함께 줬다 → 재조회 왕복이 없다.
      queryClient.setQueryData<readonly TrackableCharacter[]>(
        queryKeys.db.characters.list(),
        data.characters,
      );
    },
    /*
     * ★ **성공·실패 양쪽에서 돈다.** 실패라도 일부 자격증명은 이미 동기화됐을 수 있다
     *   (한 키가 만료돼도 나머지 키는 돌린다 — 서버 `refreshUserCharacterInventory`).
     *   성공 경로에만 두면 그 절반의 갱신이 화면에 닿지 않는다.
     */
    onSettled: () => {
      for (const key of [
        queryKeys.db.characters.forRuns(),
        queryKeys.db.auth.session(),
        queryKeys.db.bossPlans.root(),
        queryKeys.db.dashboard.root(),
        queryKeys.db.chores.root(),
        // 파티·시간표가 캐릭터 이름을 임베드한다(위 표 참고).
        queryKeys.db.party.root(),
        queryKeys.db.runs.root(),
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 타입 변환
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DB 행 → 카드가 그리는 모양.
 *
 * 널 처리: `character_level` / `character_class` / `world_name` 은 스키마상 널이지만
 * 실제 넥슨 응답에는 항상 들어 있다. 그래도 널이면 **정렬이 무너지지 않게** 레벨 0으로
 * 내려 목록 맨 뒤로 보내고, 표시는 `-` 로 둔다. 널을 에러로 취급하지 않는다.
 */
export function toGameCharacter(row: TrackableCharacter): GameCharacter {
  return {
    characterId: row.id,
    ocid: row.ocid,
    name: row.characterName,
    worldName: row.worldName ?? "-",
    className: row.characterClass ?? "-",
    level: row.characterLevel ?? 0,
  };
}
