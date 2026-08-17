/**
 * 넥슨 오픈 API 접근 경계.
 *
 * ⚠️ **클라이언트 컴포넌트는 이 배럴을 import 하지 말 것.** 대부분의 모듈이
 *    `server-only` 라 번들에 들어가면 빌드가 깨진다. 브라우저에서 필요한 것은
 *    에러 종류/문구(`./errors`)와 타입(`./types`)뿐이며, 그 둘은 개별 경로로 import 한다.
 */

export {
  NEXON_API_BASE,
  NEXON_API_KEY_HEADER,
  NEXON_CACHE_TTL_MS,
  NEXON_DAILY_BUDGET_WARN_RATIO,
  NEXON_DEV_KEY_DAILY_BUDGET,
  NEXON_PATHS,
  NEXON_RATE_LIMIT_COOLDOWN_MS,
  NEXON_REQUEST_TIMEOUT_MS,
  PROXY_API_KEY_HEADER,
  type NexonPath,
} from "./constants";

export {
  classifyNexonFailure,
  isNexonApiError,
  isNexonErrorKind,
  nexonErrorMessage,
  NexonApiError,
  type NexonApiErrorInit,
  type NexonErrorKind,
} from "./errors";

export {
  nexonCycleToBossCycle,
  nexonDifficultyToTier,
  parseNexonFlag,
  parseOptionalNexonFlag,
} from "./flags";

export {
  fetchCharacterBasic,
  fetchCharacterList,
  fetchSchedulerCharacterState,
  nexonRequest,
  type NexonEndpointDeps,
  type NexonRawFetch,
  type NexonRequestOptions,
} from "./client";

export { createNexonGateway, clearNexonCooldowns, type NexonGatewayContext } from "./gateway";
export { hashApiKey, normalizeApiKey } from "./key-hash";
export { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
export {
  nexonQuotaDayKey,
  readQuotaSnapshot,
  recordNexonCall,
  type NexonQuotaSnapshot,
} from "./quota";
export { clearNexonCache } from "./cache";

export type {
  NexonAccountCharacters,
  NexonBossEntry,
  NexonCallOutcome,
  NexonCharacterBasicResult,
  NexonCharacterListResult,
  NexonCharacterSummary,
  NexonChoreEntry,
  NexonSchedulerStateResult,
} from "./types";
