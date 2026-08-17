import { ApiRequestError } from "@/features/auth/data/auth-api";
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
 * 규약). 넥슨을 타지 않으니 15분 하한의 대상이 아니고 전역 기본값(60초)을 그대로 쓴다.
 *
 * 키 팩토리를 `queryKeys` 본체가 아니라 여기 둔 이유는 이 키를 쓰는 곳이 이 기능
 * 하나뿐이기 때문이다. 규약(루트가 `"db"`)은 그대로 지킨다.
 */
export const characterQueryKeys = {
  root: () => ["db", "characters"] as const,
  /** 세션 사용자의 캐릭터 전체. 사용자당 하나뿐이라 인자가 없다. */
  list: () => ["db", "characters", "list"] as const,
} as const;

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
}

/** `GET /api/characters` */
export interface CharacterListResponse {
  readonly characters: readonly TrackableCharacter[];
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
