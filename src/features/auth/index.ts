/**
 * 인증 기능의 공개 표면.
 *
 * ⚠️ 서버 전용 코드(`./server/*`)는 **여기서 내보내지 않는다.** 클라이언트 컴포넌트가
 *    이 배럴을 import 했을 때 `server-only` 모듈이 딸려 들어가면 빌드가 깨진다.
 *    Route Handler 는 `@/features/auth/server/...` 로 직접 import 한다.
 */

export {
  ApiKeyLoginForm,
  AuthPanel,
  CredentialDialogButton,
  CredentialManager,
  HomeAuthSection,
  LogoutButton,
} from "./components";
export type {
  ApiKeyLoginFormProps,
  AuthPanelProps,
  CredentialDialogButtonProps,
  CredentialManagerProps,
  HomeAuthSectionProps,
  LogoutButtonProps,
} from "./components";

export {
  ApiRequestError,
  getCredentials,
  getMe,
  getNexonCharacterBasic,
  getNexonCharacterList,
  getNexonQuota,
  getNexonSchedulerState,
  postCredential,
  postLogin,
  postLogout,
} from "./data/auth-api";

export {
  authQueryKeys,
  useAddCredentialMutation,
  useCredentialsQuery,
  useLoginMutation,
  useLogoutMutation,
  useNexonCharacterListQuery,
  useNexonCharacterPortraitQuery,
  useNexonQuotaQuery,
  useSessionQuery,
  useSessionUser,
  type LoginVariables,
} from "./data/auth-queries";

export {
  API_KEY_MAP_STORAGE_KEY,
  clearStoredApiKeys,
  forgetCredentialKey,
  hasStoredApiKeyFor,
  isApiKeyInputUsable,
  maskApiKey,
  normalizeApiKeyInput,
  readAnyStoredApiKey,
  readCredentialKeyMasks,
  readStoredApiKeyFor,
  readStoredApiKeys,
  rememberCredentialKey,
  subscribeStoredApiKey,
  type CredentialKeyMap,
  type CredentialKeyMasks,
} from "./lib/api-key";

export {
  useAnyStoredApiKey,
  useCredentialKeyMasks,
  useStoredApiKeys,
} from "./lib/use-stored-api-key";

export type {
  AddCredentialRequest,
  AddCredentialResponse,
  ApiErrorBody,
  ApiErrorKind,
  CredentialSummary,
  LoginCharacter,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  QuotaResponse,
  SessionUser,
} from "./types";
