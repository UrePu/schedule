"use client";

import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";

import { useToaster } from "@/components/ui/toast-context";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 낙관적 업데이트 — **먼저 반영하고, 실패하면 되돌리고, 되돌린 사실을 말한다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 원문(2026-08-18): *"먼저 믿고 선반영 후 … 지금 저거 수정하면 db 입력한다고
 * 계속 멈추는데 굉장히 불쾌함."*
 *
 * 뮤테이션이 서버 왕복(200~800ms)을 끝낼 때까지 버튼이 잠기고 값이 안 움직이던 것을,
 * TanStack Query v5 표준 골격으로 바꾼다.
 *
 * ```
 * onMutate   ① cancelQueries  ② 스냅샷  ③ setQueryData(낙관적 값)
 * onError    스냅샷으로 롤백 + **사용자에게 알림**
 * onSettled  invalidateQueries (성공이든 실패든 서버 진실로 수렴)
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 헬퍼로 뽑았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 뮤테이션마다 손으로 적으면 **반드시 어딘가 롤백이 빠진다.** 그러면 그 화면만 실패
 * 후에도 낙관적 값을 들고 남아, 사용자는 저장된 줄 알고 다음 조작을 한다. 세 콜백이
 * 한 함수 안에서 같이 만들어지므로 여기서는 그 조합이 깨질 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 이 헬퍼를 **쓰면 안 되는** 뮤테이션 (§2.4 · CLAUDE.md §1.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **서버가 값을 만드는 것** — 파티 생성·일정 등록. `run_no` / `member_no` 는 관리
 *    번호라 재배열도 재사용도 금지다(§1.4). 클라이언트가 지어내면 실제 번호와 어긋난
 *    번호가 잠깐이라도 화면에 뜨고, 그 사이 카톡에 "3번" 이라고 적히면 끝이다.
 * 2. **오래 걸리고 결과를 예측할 수 없는 것** — 넥슨 동기화(캐릭터당 1콜, 실제로 수 초).
 * 3. **계정 상태를 바꾸는 것** — 로그인·로그아웃·키 삭제. 화면 전체가 갈린다.
 * 4. **금액을 DB 가 계산하는 것** — 결정석 분배(`distribute_meso` ·
 *    `resolve_crystal_payout`)와 주간 합계(`v_weekly_income`). 화면이 1/n 을 다시 적으면
 *    웹과 카톡 봇의 답이 갈라진다(이미 두 번 갈라졌고 두 번 고쳤다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 낙관적 패치는 **지금 화면이 읽는 캐시를 전부** 덮어야 한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 조작이 여러 숫자를 움직이는데 한 캐시만 고치면, 화면 안에서 숫자가 서로 어긋난
 * 말을 한다 — **그건 느린 것보다 나쁘다.** 그래서 `optimistic` 이 패치 **목록**을
 * 돌려주게 되어 있고, 호출부는 그 화면에 동시에 떠 있는 캐시를 전부 나열한다.
 *
 * 반대로 **지금 화면에 없는 캐시**(예: 계획 화면에서 조작할 때의 대시보드 요약)는
 * 낙관적으로 고칠 필요가 없다. 보이지 않는 것은 어긋나 보일 수 없고, `onSettled` 의
 * 무효화가 다음 진입 전에 이미 정답으로 바꿔 놓는다. 낙관적 범위를 화면 단위로
 * 좁히는 것이 "어긋남 없음"을 증명 가능하게 만드는 유일한 방법이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버가 거절할 것은 **미리 막는다** (호출부의 책임)
 * ─────────────────────────────────────────────────────────────────────────────
 * 13번째 주간 보스처럼 서버가 400 으로 거절하는 조작은, 낙관적으로 켰다가 롤백하면
 * 화면이 깜빡이고 사용자는 무엇을 잘못했는지 모른다. 그런 경우 호출부가 **누르기 전에**
 * 판정해 조작 자체를 하지 않고 안내한다. 이 헬퍼는 그 판정을 대신해 주지 않는다 —
 * 규칙(12개 상한)이 두 벌이 되는 것을 막기 위해 판정식은 서버가, 예고는 화면이 진다.
 */

/**
 * 캐시 한 칸을 낙관적으로 바꾸는 패치.
 *
 * `apply` 는 **캐시에 값이 있을 때만** 불린다. 값이 없으면(그 화면이 안 떠 있으면)
 * 아무것도 하지 않는다 — 없던 캐시에 낙관적 값을 심으면 `dataUpdatedAt` 이 지금으로
 * 찍혀 60초 동안 서버를 안 물어보는 유령 항목이 생긴다.
 */
export interface CachePatch {
  readonly queryKey: QueryKey;
  readonly apply: (current: unknown) => unknown;
}

/** 타입을 지키면서 패치를 만든다. 캐시 값의 타입은 호출부가 안다. */
export function cachePatch<TCache>(
  queryKey: QueryKey,
  apply: (current: TCache) => TCache,
): CachePatch {
  return {
    queryKey,
    apply: (current: unknown) => apply(current as TCache),
  };
}

/** 롤백에 쓰는 스냅샷. `onMutate` 가 만들고 `onError` 가 되감는다. */
export interface OptimisticContext {
  readonly snapshots: readonly (readonly [QueryKey, unknown])[];
}

export interface OptimisticMutationOptions<TData, TVariables> {
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * 낙관적으로 덮을 캐시 목록. **빈 배열을 돌려주면 낙관적 적용을 건너뛴다** —
   * "이 입력만은 결과를 예측할 수 없다"를 표현하는 자리다(조건부 낙관).
   */
  readonly optimistic: (variables: TVariables) => readonly CachePatch[];
  /**
   * `onSettled` 에서 무효화할 키. 성공·실패 모두에서 돈다 — 실패해도 서버 진실로
   * 수렴시켜야 낙관적 값의 잔재가 남지 않는다.
   */
  readonly invalidate?: (variables: TVariables) => readonly QueryKey[];
  /**
   * 롤백 알림의 제목. **무엇이 실패했는가.**
   * 예: `"보스 계획을 저장하지 못했습니다"`
   */
  readonly rollbackTitle: string;
  /**
   * 롤백 알림의 본문. **무엇이 되돌아갔는가.** 변수를 받으므로 대상 이름을 넣을 수 있다.
   * 예: `"하드 스우 를 끄려던 것을 되돌렸습니다."`
   */
  readonly rollbackDescription: (variables: TVariables) => string;
  readonly onSuccess?: (data: TData, variables: TVariables) => void;
  readonly onError?: (error: Error, variables: TVariables) => void;
  readonly onSettled?: (variables: TVariables) => void;
  /** 파괴적 호출은 `0` 으로 못박는다. 기본값은 전역(재시도 없음)을 따른다. */
  readonly retry?: number;
}

export function useOptimisticMutation<TData, TVariables>(
  options: OptimisticMutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables, OptimisticContext> {
  const queryClient = useQueryClient();
  const { notify } = useToaster();

  const {
    mutationFn,
    optimistic,
    invalidate,
    rollbackTitle,
    rollbackDescription,
    onSuccess,
    onError,
    onSettled,
    retry,
  } = options;

  /*
   * `useCallback` 으로 감싸지 않는다. 호출부가 넘기는 `optimistic` 은 대개 인라인
   * 화살표라 매 렌더 새 참조이고, 그러면 memo 가 한 번도 적중하지 않는다.
   * `useMutation` 은 렌더마다 최신 옵션을 읽으므로 감싸도 얻는 것이 없다.
   */
  async function handleMutate(
    variables: TVariables,
  ): Promise<OptimisticContext> {
    const patches = optimistic(variables);
    if (patches.length === 0) return { snapshots: [] };

    const snapshots: (readonly [QueryKey, unknown])[] = [];
    for (const patch of patches) {
      /*
       * ① 진행 중인 재조회를 멈춘다. 멈추지 않으면 먼저 출발한 조회의 **낡은 응답**이
       *   방금 심은 낙관적 값을 덮어써, 눌렀는데 되돌아간 것처럼 보인다.
       *   `exact` 다 — 접두사로 취소하면 관계없는 화면의 조회까지 끊는다.
       */
      await queryClient.cancelQueries({
        queryKey: patch.queryKey,
        exact: true,
      });

      // ② 스냅샷. 값이 없으면 그 화면이 안 떠 있다는 뜻이므로 손대지 않는다.
      const previous = queryClient.getQueryData(patch.queryKey);
      if (previous === undefined) continue;

      snapshots.push([patch.queryKey, previous]);
      // ③ 낙관적 값.
      queryClient.setQueryData(patch.queryKey, patch.apply(previous));
    }
    return { snapshots };
  }

  return useMutation<TData, Error, TVariables, OptimisticContext>({
    mutationFn,
    retry,
    onMutate: handleMutate,
    onSuccess: (data, variables) => {
      onSuccess?.(data, variables);
    },
    onError: (error, variables, context) => {
      /*
       * 롤백. **심은 순서의 역순이 아니어도 된다** — 키마다 독립이고 스냅샷은 그 키의
       * 전체 값이라, 되돌리기가 서로 간섭하지 않는다.
       */
      for (const [queryKey, previous] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, previous);
      }
      /*
       * ★ **되돌린 사실을 말한다.** 조용히 되돌리면 사용자는 저장된 줄 안다 —
       *   화면은 잠깐 바뀌었다 원래대로 돌아왔을 뿐이고 그 깜빡임은 아무 정보가 아니다.
       *   §4: 실패는 red 가 허용되는 몇 안 되는 자리다.
       */
      if ((context?.snapshots.length ?? 0) > 0) {
        notify({
          title: rollbackTitle,
          description: rollbackDescription(variables),
          detail: error.message,
        });
      }
      onError?.(error, variables);
    },
    onSettled: (_data, _error, variables) => {
      for (const queryKey of invalidate?.(variables) ?? []) {
        void queryClient.invalidateQueries({ queryKey });
      }
      onSettled?.(variables);
    },
  });
}
