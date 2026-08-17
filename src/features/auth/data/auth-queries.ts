"use client";

/**
 * 인증/넥슨 프록시의 TanStack Query 훅.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐시 키 규약 (src/lib/query-keys.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * 모든 키는 `"db"` 또는 `"nexon"` 으로 시작한다. 세션 조회는 **우리 DB** 에서 오므로
 * `["db", "auth", ...]` 이다. `/api/auth/me` 가 넥슨을 부르지 않는다는 사실이
 * 여기 그대로 드러난다 — 그래서 15분 규칙의 대상이 아니다.
 *
 * 반대로 넥슨을 타는 훅은 **반드시** `nexonQueryOptions()` 를 스프레드한다.
 * 그 헬퍼가 `staleTime ≥ 15분` 을 코드로 강제한다(§1.1 — 데이터가 15분 지연되므로
 * 더 자주 물어도 새 값 없이 쿼터만 탄다).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { nexonQueryOptions, queryKeys } from "@/lib/query-keys";
import type {
  NexonCharacterBasicResult,
  NexonCharacterListResult,
} from "@/lib/nexon/types";

import { clearSyncFailureMemo } from "@/features/boss-plans/lib/scheduler-sync-memo";

import { clearStoredApiKeys, rememberCredentialKey } from "../lib/api-key";
import { paceNexonRequest } from "../lib/nexon-pacer";
import type {
  AddCredentialResponse,
  CredentialSummary,
  LoginResponse,
  MeResponse,
  QuotaResponse,
  SessionUser,
} from "../types";
import {
  ApiRequestError,
  getCredentials,
  getMe,
  getNexonCharacterBasic,
  getNexonCharacterList,
  getNexonQuota,
  postCredential,
  postLogin,
  postLogout,
} from "./auth-api";

/** 세션·장부는 우리 DB 에서 온다 → `"db"` 네임스페이스. */
export const authQueryKeys = {
  root: () => ["db", "auth"] as const,
  session: () => ["db", "auth", "session"] as const,
  quota: () => ["db", "auth", "quota"] as const,
  credentials: () => ["db", "auth", "credentials"] as const,
} as const;

/**
 * 재시도해서는 **안 되는** 실패.
 *
 * 키가 틀렸거나 한도를 넘겼는데 다시 부르면, 고쳐지는 것 없이 예산만 더 탄다.
 * 특히 `quota_exceeded` 재시도는 **재시도 폭주 금지** 원칙의 정면 위반이다(§1.1).
 */
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiRequestError) {
    if (
      error.kind === "invalid_key" ||
      error.kind === "quota_exceeded" ||
      error.kind === "unauthenticated" ||
      error.kind === "key_owned_by_other_account" ||
      error.kind === "account_unavailable" ||
      error.kind === "bad_request"
    ) {
      return false;
    }
  }
  return failureCount < 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 세션
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "지금 누가 보고 있는가".
 *
 * ★ **비로그인은 에러가 아니다.** 서버가 200 `{ user: null }` 로 답하므로 이 훅은
 *   비로그인 상태에서도 `isError === false` 다. 홈과 공개 시간표가 세션 없이 열려야
 *   한다는 요구(DoD)가 이 한 줄에 걸려 있다.
 */
export function useSessionQuery(): UseQueryResult<MeResponse, Error> {
  return useQuery({
    queryKey: authQueryKeys.session(),
    queryFn: getMe,
    retry: shouldRetry,
  });
}

/** 편의 훅 — 사용자만 필요할 때. */
export function useSessionUser(): SessionUser | null {
  return useSessionQuery().data?.user ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 로그인 / 로그아웃 / 키 추가
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginVariables {
  readonly apiKey: string;
  readonly label?: string;
}

/**
 * 키로 로그인. 성공하면 **그 키를 자기 `credentialId` 아래** 저장해 다시 입력하지 않게
 * 한다(§2.1.1).
 *
 * 저장을 `onSuccess` 에 둔 이유: 실패한 키를 저장하면 다음 방문에 그 키로 자동 로그인을
 * 시도하다 또 실패한다. **서버가 유효하다고 말한 키만** 남긴다.
 *
 * ★ 저장 단위가 자격증명이므로 **다른 계정 키를 덮어쓰지 않는다.** 예전에는 칸이 하나뿐
 *   이라 부계정 키로 로그인하면 본계정 키가 사라졌고, 그 계정 캐릭터가 통째로 동기화
 *   불가가 됐다.
 */
export function useLoginMutation(): UseMutationResult<
  LoginResponse,
  Error,
  LoginVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: LoginVariables) => postLogin(variables),
    onSuccess: (data, variables) => {
      // 원문은 이 자격증명 아래에만 들어간다. 화면에 나가는 것은 파생된 마스킹뿐이다.
      rememberCredentialKey(data.credentialId, variables.apiKey);
      // 방금 받은 사용자로 캐시를 채워 재조회 왕복을 없앤다.
      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: data.user,
      });
      queryClient.setQueryData<readonly CredentialSummary[]>(
        authQueryKeys.credentials(),
        data.user.credentials,
      );
    },
  });
}

/**
 * 로그아웃. 세션 쿠키는 서버가 지우고, **저장된 키는 여기서 전부 지운다** —
 * localStorage 는 서버가 볼 수 없기 때문이다. 계정 3개를 등록했다면 키 3개가 모두
 * 사라져야 하며, 한 칸만 지우던 예전 구현은 나머지를 그대로 남겼다.
 */
export function useLogoutMutation(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await postLogout();
    },
    onSuccess: () => {
      // 원문·마스킹·예전 형식의 잔재까지 전부. 남겨 두면 "이 기기를 누가 쓰는가"의 단서가 된다.
      clearStoredApiKeys();
      /*
       * 동기화 실패 기억도 함께 지운다. 캐릭터 UUID 와 키 마스킹이 남아 있으면 그것도
       * "이 기기를 누가 쓰는가"의 단서이고, 다음 사용자가 남의 기억 때문에 건너뛰어지는
       * 일도 막는다.
       */
      clearSyncFailureMemo();
      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: null,
      });
      queryClient.removeQueries({ queryKey: authQueryKeys.credentials() });
      // 넥슨 응답은 사람에 묶인 데이터다. 로그아웃하면 통째로 버린다.
      queryClient.removeQueries({ queryKey: queryKeys.nexon.root() });
    },
  });
}

/**
 * 등록된 키 목록.
 *
 * 세션 응답(`/api/auth/me`)에도 같은 배열이 들어 있지만 **별도 훅으로 둔다.**
 * 키 관리 화면은 세션과 다른 주기로 갱신되고(키 추가 직후 즉시), 비로그인 상태에서는
 * 아예 부르지 않아야 하기 때문이다. 서버는 세션이 없으면 401 이므로 `enabled` 로 막는다.
 */
export function useCredentialsQuery(input?: {
  readonly enabled?: boolean;
}): UseQueryResult<readonly CredentialSummary[], Error> {
  return useQuery({
    queryKey: authQueryKeys.credentials(),
    queryFn: async () => (await getCredentials()).credentials,
    enabled: input?.enabled ?? true,
    retry: shouldRetry,
  });
}

/** 부계정 키 추가. 세션이 있어야 하며, 남의 계정에 묶인 키는 서버가 409 로 거부한다. */
export function useAddCredentialMutation(): UseMutationResult<
  AddCredentialResponse,
  Error,
  LoginVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: LoginVariables) => postCredential(variables),
    onSuccess: (data, variables) => {
      /*
       * ★ **부계정 키의 원문도 보관한다.** 그러지 않으면 이 키로만 읽을 수 있는 캐릭터가
       *   등록만 되고 동기화는 영원히 실패한다 — 정확히 그 버그를 고치는 줄이다.
       */
      rememberCredentialKey(data.credentialId, variables.apiKey);
      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: data.user,
      });
      // 새 키의 캐릭터가 합쳐졌으므로 목록·세션이 함께 바뀐다.
      queryClient.setQueryData<readonly CredentialSummary[]>(
        authQueryKeys.credentials(),
        data.user.credentials,
      );
      /*
       * 캐릭터 목록만 무효화한다. `queryKeys.db.root()` 를 통째로 날리면 방금 채워 넣은
       * 세션·키 목록까지 다시 받아 오게 되고, 넥슨과 무관한 왕복이 늘어난다.
       * 키를 리터럴로 적은 이유는 순환 import 회피다 —
       * `features/characters/data` 는 이미 `features/auth` 를 import 한다.
       * (그쪽 `characterQueryKeys.root()` 와 같은 값이며, 규약상 루트는 항상 `"db"` 다.)
       */
      void queryClient.invalidateQueries({ queryKey: ["db", "characters"] });
      /*
       * 체크리스트도 함께. 새 키가 붙으면 캐릭터의 `credentialId` 가 채워질 수 있고
       * (그 계정에 유효한 키가 처음 생긴 경우), 그 값이 곧 "어느 키로 동기화하는가"다.
       * 낡은 값을 들고 있으면 방금 넣은 키가 있는데도 "키 없음"으로 보인다.
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 넥슨 프록시 — staleTime 하한 15분이 강제된다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 보유 캐릭터 목록.
 *
 * `credentialId` 가 캐시 키인 이유: 한 사람이 **여러 넥슨 계정 키**를 가질 수 있고
 * (§2.1) 키마다 보이는 캐릭터가 다르다. 사용자 단위로 캐싱하면 부계정 목록이
 * 본계정 목록을 덮어쓴다.
 */
export function useNexonCharacterListQuery(input: {
  readonly apiKey: string | null;
  readonly credentialId: string | null;
}): UseQueryResult<NexonCharacterListResult, Error> {
  const { apiKey, credentialId } = input;

  return useQuery({
    ...nexonQueryOptions(queryKeys.nexon.characterList(credentialId ?? "")),
    queryFn: () => {
      if (apiKey === null) {
        throw new Error("[auth] API 키 없이 넥슨 캐릭터 목록을 조회했습니다.");
      }
      return getNexonCharacterList(apiKey);
    },
    enabled: apiKey !== null && credentialId !== null,
    retry: shouldRetry,
  });
}

/**
 * 초상화 1건. **캐릭터 단위 키**인 것이 핵심이다 —
 * 목록 단위로 캐싱하면 "보이는 12명분만 부른다"는 절약이 통째로 무너진다(§2.1.1).
 *
 * `imageUrl: null` 은 정상 상태이므로 이 훅은 그때도 성공이다.
 */
export function useNexonCharacterPortraitQuery(input: {
  readonly apiKey: string | null;
  readonly ocid: string | null;
  readonly enabled?: boolean;
}): UseQueryResult<NexonCharacterBasicResult, Error> {
  const { apiKey, ocid, enabled = true } = input;

  return useQuery({
    ...nexonQueryOptions(queryKeys.nexon.characterPortrait(ocid ?? "")),
    queryFn: () => {
      if (apiKey === null || ocid === null) {
        throw new Error("[auth] API 키 또는 ocid 없이 초상화를 조회했습니다.");
      }
      // ★ **간격 제한을 반드시 통과시킨다.** 캐릭터 선택 모달은 이 훅을 카드마다
      //   하나씩 걸어 두므로 모달을 여는 순간 12건이 동시에 나가는데, 개발 키는
      //   초당 5콜이라 실측에서 **7건이 429** 였다. 그리고 429 한 건이면 게이트웨이가
      //   그 키를 60초 쿨다운에 넣어 **로그인까지 함께 막힌다**(features/auth/lib/nexon-pacer.ts).
      return paceNexonRequest(() => getNexonCharacterBasic(apiKey, ocid));
    },
    enabled: enabled && apiKey !== null && ocid !== null,
    retry: shouldRetry,
  });
}

/**
 * 오늘 쓴 호출량. **넥슨을 부르지 않으므로** 15분 규칙 대상이 아니다
 * (우리 DB 장부를 읽는다 — 넥슨에는 잔여량 헤더 자체가 없다).
 */
export function useNexonQuotaQuery(input?: {
  readonly enabled?: boolean;
}): UseQueryResult<QuotaResponse, Error> {
  return useQuery({
    queryKey: authQueryKeys.quota(),
    queryFn: getNexonQuota,
    enabled: input?.enabled ?? true,
    retry: shouldRetry,
  });
}
