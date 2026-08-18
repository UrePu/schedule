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

import {
  dbQueryOptions,
  nexonQueryOptions,
  queryKeys,
  sessionQueryOptions,
} from "@/lib/query-keys";
import type {
  NexonCharacterBasicResult,
  NexonCharacterListResult,
} from "@/lib/nexon/types";

import { clearSyncFailureMemo } from "@/features/boss-plans/lib/scheduler-sync-memo";

import {
  clearStoredApiKeys,
  forgetCredentialKey,
  rememberCredentialKey,
} from "../lib/api-key";
import { paceNexonRequest } from "../lib/nexon-pacer";
import type {
  AddCredentialResponse,
  CredentialSummary,
  DeleteCredentialResponse,
  LoginResponse,
  MeResponse,
  QuotaResponse,
  SessionUser,
} from "../types";
import {
  ApiRequestError,
  deleteCredential,
  getCredentials,
  getMe,
  getNexonCharacterBasic,
  getNexonCharacterList,
  getNexonQuota,
  postCredential,
  postLogin,
  postLogout,
} from "./auth-api";

/**
 * 세션·장부는 우리 DB 에서 온다 → `"db"` 네임스페이스.
 *
 * ⚠️ **여기에 키를 정의하지 않는다.** 팩토리 본체는 `src/lib/query-keys.ts` 하나뿐이며
 *    (§2.4 Rule 5), 이 이름은 기존 호출부를 위한 **별칭**이다. 예전에는 이 파일이 같은
 *    배열을 다시 적고 있었고, 아래 두 mutation 은 아예 리터럴 `["db","characters"]` 를
 *    썼다 — 팩토리 모양이 바뀌는 날 조용히 매칭이 끊기는 구조였다.
 */
export const authQueryKeys = queryKeys.db.auth;

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
      // 키가 하나뿐이라는 사실은 다시 물어도 달라지지 않는다.
      error.kind === "last_credential" ||
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
    // 티어: session — 계정 상태가 화면 전체를 가른다 (§2.4 Rule 4).
    ...sessionQueryOptions(queryKeys.db.auth.session()),
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
      /*
       * ★ **로그인 전에 캐시된 답은 전부 다른 사람의 답이다.** 비로그인 상태의 공개 파티
       *   목록·빈 가용시간이 그대로 남아 있으면, 로그인 직후 화면이 잠깐 "파티 없음"을
       *   말한다. `db` 네임스페이스만 날린다 — 넥슨 응답은 쿼터가 걸린 값이라 건드리지
       *   않는다(그쪽은 애초에 `credentialId` 로 갈려 있어 섞이지 않는다).
       */
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.root() });
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
      /*
       * ★ **캐시를 통째로 버린다.** 예전에는 세션과 키 목록, 넥슨 응답만 지웠고 파티·
       *   수익·계획은 메모리에 그대로 남았다. 화면이 서버 렌더 props 를 쓰던 때는 그게
       *   눈에 띄지 않았지만, 이제 캐시가 화면을 소유하므로 **다음 사람이 앞사람의
       *   숫자를 볼 수 있다.** 로그아웃은 "이 브라우저에서 그 사람을 지운다"이므로
       *   `db` 도 `nexon` 도 남길 이유가 없다.
       *
       *   순서가 중요하다 — 먼저 지우고, 그 다음에 "비로그인"을 심는다. 반대로 하면
       *   방금 심은 세션까지 함께 지워져 화면이 로딩 상태로 되돌아간다.
       */
      queryClient.removeQueries({ queryKey: queryKeys.db.root() });
      // 넥슨 응답은 사람에 묶인 데이터다. 로그아웃하면 통째로 버린다.
      queryClient.removeQueries({ queryKey: queryKeys.nexon.root() });
      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: null,
      });
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
    // 티어: session — 키 목록은 계정 상태의 일부다.
    ...sessionQueryOptions(queryKeys.db.auth.credentials()),
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
       *
       * ⚠️ 예전에는 여기가 리터럴 `["db","characters"]` 였고 이유로 "순환 import 회피"가
       *    적혀 있었다. 키가 `@/lib/query-keys` 로 모인 지금은 그 순환이 없다 —
       *    이 파일은 features 를 거치지 않고 팩토리를 직접 부른다 (§2.4 Rule 5).
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.characters.root(),
      });
      /*
       * 체크리스트도 함께. 새 키가 붙으면 캐릭터의 `credentialId` 가 채워질 수 있고
       * (그 계정에 유효한 키가 처음 생긴 경우), 그 값이 곧 "어느 키로 동기화하는가"다.
       * 낡은 값을 들고 있으면 방금 넣은 키가 있는데도 "키 없음"으로 보인다.
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      // 새 계정의 캐릭터가 합쳐지면 대시보드의 12칸 분모와 수익 합계가 함께 움직인다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
    },
  });
}

/**
 * 등록된 키 1개 삭제. **되돌릴 수 없다** — 확인 단계는 화면(`CredentialManager`)이 진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 서버에서 지웠으면 **브라우저에서도 지운다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버 행은 사라졌는데 localStorage 에 원문이 남으면 "없는 자격증명의 키"가 떠돈다.
 * 그 키는 어떤 화면에서도 쓸 수 없고, XSS 표면으로만 남는다. 그래서
 * `forgetCredentialKey()` 가 성공 직후 그 자격증명의 원문·예전 형식 잔재를 함께 지운다
 * (로그아웃 경로의 `clearStoredApiKeys()` 와 **같은 세 칸**을 본다 — `lib/api-key.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇이 다시 조회돼야 하는가 — 하나라도 빠지면 지운 키가 화면에 계속 남는다
 * ─────────────────────────────────────────────────────────────────────────────
 * - **세션 / 키 목록**: 서버가 돌려준 "바뀐 뒤의 사용자"를 그대로 캐시에 넣는다.
 *   재조회보다 정확하다(그 응답이 곧 삭제 직후의 진실이고, 왕복도 없다).
 *   주 키 승격 결과도 이 한 번에 함께 반영된다.
 * - **캐릭터 목록 / 체크리스트**: 캐릭터 행은 남지만 `sync_state` 가 `no_valid_key` 로
 *   바뀌고, 캐릭터별 `credentialId` 도 다시 계산된다(다른 키가 남아 있으면 그쪽으로
 *   넘어간다). 낡은 값을 들고 있으면 지운 키로 계속 부르려 든다.
 * - **그 키의 넥슨 응답 캐시**: `nexon.characterList(credentialId)` 는 지운 키에
 *   매달린 캐시라 다시 쓰일 일이 없다. 남겨 두면 같은 키를 재등록했을 때(새 id 가
 *   발급된다) 죽은 항목만 메모리에 쌓인다.
 * - **대시보드**: 예전에는 서버 컴포넌트라 캐시 밖이었지만 이제 쿼리가 소유한다
 *   (§2.4 Rule 1). 12칸 분모·수익 합계가 같이 움직이므로 함께 무효화한다.
 *   호출부의 `router.refresh()` 는 **계정 상태**가 서버 렌더를 가르기 때문에 남는다.
 */
export function useDeleteCredentialMutation(): UseMutationResult<
  DeleteCredentialResponse,
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (credentialId: string) => deleteCredential(credentialId),
    /*
     * ★ **재시도하지 않는다.** 지금은 전역 기본값에 mutations 항목이 없어 이미 0이지만,
     *   나중에 누가 `defaultOptions.mutations.retry` 를 켜면 이 삭제도 함께 따라간다.
     *   응답을 못 받은 채 서버에서는 성공한 경우 두 번째 호출이 404 를 돌려주고, 화면은
     *   실제로 지워진 키를 "삭제 실패"라고 말하게 된다. 파괴적 호출에는 명시적으로 못박는다.
     */
    retry: 0,
    onSuccess: (data) => {
      // 서버에서 사라진 키의 원문을 이 기기에서도 없앤다.
      forgetCredentialKey(data.deletedCredentialId);

      queryClient.setQueryData<MeResponse>(authQueryKeys.session(), {
        user: data.user,
      });
      queryClient.setQueryData<readonly CredentialSummary[]>(
        authQueryKeys.credentials(),
        data.user.credentials,
      );

      queryClient.removeQueries({
        queryKey: queryKeys.nexon.characterList(data.deletedCredentialId),
      });

      // 키 추가 경로와 같은 대상들.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.characters.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      /*
       * ★ 대시보드도 함께. 키가 사라지면 그 계정 캐릭터의 동기화 상태 요약과 주간 보스
       *   칸 분모가 달라진다. 예전에는 대시보드가 **서버 컴포넌트**라 캐시 밖이었고
       *   `router.refresh()` 가 그 자리를 메웠다 — 이제 대시보드도 캐시가 소유하므로
       *   무효화가 정공법이다 (§2.4 Rule 1). `router.refresh()` 는 **계정 상태**가
       *   서버 렌더를 가르기 때문에 그대로 남는다 (Rule 3).
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
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
 *
 * ★ **`apiKey` 는 선택이다**(§2.1.2). 서버가 `credentialId` 로 그 자격증명의 키를 DB 에서
 *   복호화해 부르므로, 이 브라우저에 원문이 없어도 목록을 받을 수 있다. 갖고 있으면
 *   같이 보내 하위 호환·백필 경로를 살린다.
 */
export function useNexonCharacterListQuery(input: {
  readonly apiKey: string | null;
  readonly credentialId: string | null;
}): UseQueryResult<NexonCharacterListResult, Error> {
  const { apiKey, credentialId } = input;

  return useQuery({
    ...nexonQueryOptions(queryKeys.nexon.characterList(credentialId ?? "")),
    queryFn: () => getNexonCharacterList(apiKey, credentialId),
    enabled: credentialId !== null,
    retry: shouldRetry,
  });
}

/**
 * 초상화 1건. **캐릭터 단위 키**인 것이 핵심이다 —
 * 목록 단위로 캐싱하면 "보이는 12명분만 부른다"는 절약이 통째로 무너진다(§2.1.1).
 *
 * `imageUrl: null` 은 정상 상태이므로 이 훅은 그때도 성공이다.
 *
 * ★ **`apiKey` 는 선택이다**(§2.1.2). 서버가 `ocid` 로 그 캐릭터가 속한 계정의 키를 DB 에서
 *   꺼내 쓴다. 예전에는 이 브라우저에 키가 없으면 초상화가 영원히 실루엣이었고, 그건
 *   "부계정 캐릭터는 남의 것처럼 보인다"는 인상을 줬다.
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
      if (ocid === null) {
        throw new Error("[auth] ocid 없이 초상화를 조회했습니다.");
      }
      // ★ **간격 제한을 반드시 통과시킨다.** 캐릭터 선택 모달은 이 훅을 카드마다
      //   하나씩 걸어 두므로 모달을 여는 순간 12건이 동시에 나가는데, 개발 키는
      //   초당 5콜이라 실측에서 **7건이 429** 였다. 그리고 429 한 건이면 게이트웨이가
      //   그 키를 60초 쿨다운에 넣어 **로그인까지 함께 막힌다**(features/auth/lib/nexon-pacer.ts).
      return paceNexonRequest(() => getNexonCharacterBasic(apiKey, ocid));
    },
    enabled: enabled && ocid !== null,
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
    // 티어: db — 넥슨이 아니라 **우리 장부**를 읽는다(넥슨엔 잔여량 헤더가 없다).
    ...dbQueryOptions(queryKeys.db.auth.quota()),
    queryFn: getNexonQuota,
    enabled: input?.enabled ?? true,
    retry: shouldRetry,
  });
}
