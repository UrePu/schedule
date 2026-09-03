/**
 * 넥슨 오픈 API 상수.
 *
 * 값의 근거는 전부 **실측**이다 (`Claude/NEXON-API-OBSERVED.md`, CLAUDE.md §1.0).
 * 추정으로 채운 값은 이 파일에 없다.
 */

/** 넥슨 오픈 API 오리진. */
export const NEXON_API_BASE = "https://open.api.nexon.com";

/**
 * API 키는 **오직 이 헤더로만** 나간다.
 *
 * ★ 절대 URL 이나 쿼리스트링에 넣지 않는다. URL 은 액세스 로그·에러 리포트·
 *   브라우저 히스토리에 그대로 남기 때문이다.
 */
export const NEXON_API_KEY_HEADER = "x-nxopen-api-key";

/** 우리 프록시가 브라우저에서 사용자 키를 받을 때 쓰는 헤더 이름. */
export const PROXY_API_KEY_HEADER = "x-nexon-api-key";

/** 우리가 실제로 부르는 경로. 이 목록 밖의 경로는 프록시가 거부한다. */
export const NEXON_PATHS = {
  /** 키 유효성 + 보유 캐릭터를 **1콜**로 준다 (§2.1.1). 로그인 검증의 유일한 경로. */
  characterList: "/maplestory/v1/character/list",
  /** 초상화(`character_image`) — **캐릭터당 1콜**이라 화면에 보이는 만큼만 부른다. */
  characterBasic: "/maplestory/v1/character/basic",
  /**
   * 캐릭터명 → ocid. **소유권 검사가 없다**(2026-09-03 실측) — 우리 키 하나로 남의
   * 캐릭터 ocid 가 나오고, 월드를 묻지 않아도 전 월드를 훑는다.
   *
   * ⚠️ **로그인에는 쓰지 않는다**(§2.1.1). 소유를 증명하지 못하기 때문이다. 이 경로의
   *    유일한 용도는 `characters` 행도 ocid 도 없는 사람(파티 게스트)의 생김새를 찾는
   *    것이고, 결과는 `character_looks` 에 캐시된다.
   */
  characterId: "/maplestory/v1/id",
  /** 인게임 스케줄러 상태(보스 등록/완료 플래그). */
  schedulerCharacterState: "/maplestory/v1/scheduler/character-state",
  /** 다른 플레이어를 찾는 유일한 공개 경로. */
  guildBasic: "/maplestory/v1/guild/basic",
} as const;

export type NexonPath = (typeof NEXON_PATHS)[keyof typeof NEXON_PATHS];

/**
 * 개발 단계 키의 하루 호출 한도. (서비스 키는 20,000,000/일)
 *
 * **잔여 호출량 헤더가 존재하지 않는다**(실측 `NEXON-API#12`). 그래서 우리가 직접 센다
 * — `nexon_api_quota_usage` 테이블이 그 장부다.
 */
export const NEXON_DEV_KEY_DAILY_BUDGET = 1000;

/**
 * 하루 예산의 몇 %를 넘으면 경고할지. 차단이 아니라 경고다.
 * 실측 계정이 캐릭터 59명이라 전체 스케줄러 동기화 1회가 예산의 약 6%를 태운다.
 */
export const NEXON_DAILY_BUDGET_WARN_RATIO = 0.8;

/**
 * 서버 캐시 기본 TTL — **15분**.
 *
 * 넥슨 데이터는 약 15분 지연되므로(CLAUDE.md §1.1) 그보다 자주 물어도
 * **새 값은 없고 쿼터만 탄다.** 클라이언트의 `nexonQueryOptions()` 하한과 같은 값이다.
 */
export const NEXON_CACHE_TTL_MS = 15 * 60 * 1000;

/** 넥슨 호출 타임아웃. 봇 응답 예산(3초)과 화면 체감 지연 사이의 절충. */
export const NEXON_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 429 / `OPENAPI00007` 을 받은 뒤 그 자격증명의 호출을 멈춰 두는 시간.
 *
 * **재시도 폭주 금지**(CLAUDE.md §1.1). 한 번 막히면 즉시 중단하고, 이 시간 동안은
 * 넥슨을 아예 부르지 않은 채 같은 도메인 에러를 돌려준다.
 */
export const NEXON_RATE_LIMIT_COOLDOWN_MS = 60_000;
