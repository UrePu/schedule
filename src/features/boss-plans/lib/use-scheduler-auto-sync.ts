"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import { useStoredApiKey } from "@/features/auth/lib/use-stored-api-key";
import { queryKeys } from "@/lib/query-keys";

import { BossPlanRequestError, syncCharacterScheduler } from "../data";
import type { CharacterChecklist } from "../types";
import { selectStaleCharacterIds, shouldAbortAutoSync } from "./scheduler-freshness";
import {
  forgetSyncFailure,
  isAutoSyncSuppressed,
  readSyncFailureMemo,
  rememberSyncFailure,
} from "./scheduler-sync-memo";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 진입 시 **자동 동기화 1회** (CLAUDE.md §1.1.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구: *"다시 대시보드에 들어갔을 때 자동으로 갱신해. 버튼 직접 누르는 것도 있게
 * 하고 대시보드 접속할 때 한 번."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 훅이 지키는 여섯 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **신선하면 아예 시작하지 않는다.** 마지막 호출이 15분(넥슨 지연 창) 안이면 대상에서
 *    빠진다. 추적 14명 × 진입 1회 = 14콜이고 개발 키는 하루 1,000콜이라, 가드가 없으면
 *    새로고침 몇 번에 예산이 사라진다. 판정 근거는 `scheduler-freshness.ts` 참고.
 * 2. **마운트당 딱 한 번.** `attemptedRef` 가 재실행을 막는다. 리렌더·쿼리 갱신·
 *    StrictMode 이중 마운트 전부 여기서 걸린다. **폴링이 아니다.**
 * 3. **렌더를 막지 않는다.** effect 라 첫 페인트 이후에 돈다. 화면은 SSR 로 받은 저장
 *    데이터를 즉시 보여 주고, 동기화 결과는 끝난 뒤 쿼리 무효화로 반영된다.
 * 4. **직렬 + 페이서.** 14건을 동시에 쏘면 초당 5콜 한도에 걸려 그 키가 60초 쿨다운에
 *    들어간다 — 초상화 12장 동시 발사로 이미 겪은 사고다(`nexon-pacer.ts`).
 * 5. **실패해도 화면이 깨지지 않는다.** mutationFn 이 **던지지 않고 요약을 반환**한다.
 *    그래서 `isError` 가 서지 않고, 대시보드는 저장된 데이터로 계속 뜬다.
 * 6. **재시도 폭주 금지.** 실패하면 즉시 재시도하지 않는다. 게다가 자격증명·상류 문제면
 *    남은 캐릭터까지 **중단**한다(`shouldAbortAutoSync`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 비로그인은 시도조차 하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 겹으로 막힌다. (a) 대시보드 자체가 활성 세션일 때만 렌더되므로 이 훅이 **마운트되지
 * 않는다**(`src/app/page.tsx`). (b) 마운트되더라도 원문 키는 브라우저 localStorage 에만
 * 있으므로(§2.1.1) 키가 없으면 아래에서 즉시 반환한다. 서버는 원문 키가 없으면 넥슨을
 * 부를 수단 자체가 없다.
 */

/** 자동 동기화 1회의 결과 요약. **던지는 대신 이걸 돌려준다.** */
export interface AutoSyncSummary {
  /** 동기화를 시도한 캐릭터 수(= 신선하지 않아 대상이 된 수). */
  readonly attempted: number;
  /** 실제로 성공한 캐릭터 수. */
  readonly succeeded: number;
  /** 이번 진입에서 실제로 나간 넥슨 호출 수. 서버 캐시에 맞으면 0일 수 있다. */
  readonly nexonCallsUsed: number;
  /** 첫 실패의 한국어 문구. 없으면 `null`. */
  readonly failureMessage: string | null;
  /** 자격증명·상류 문제라 남은 캐릭터를 포기했는가. */
  readonly aborted: boolean;
}

export interface SchedulerAutoSyncState {
  /** 갱신 중인가. 작은 인디케이터를 그리는 데 쓴다. */
  readonly isSyncing: boolean;
  /** 진행 상황 `done / total`. `total` 이 0이면 이번 진입은 대상이 없었다. */
  readonly progress: { readonly done: number; readonly total: number };
  /** 끝난 뒤의 요약. 아직 안 돌았거나 대상이 없으면 `null`. */
  readonly summary: AutoSyncSummary | null;
}

const IDLE_PROGRESS = { done: 0, total: 0 } as const;

export function useSchedulerAutoSync(
  characters: readonly CharacterChecklist[],
): SchedulerAutoSyncState {
  const apiKey = useStoredApiKey();
  const queryClient = useQueryClient();

  /** 마운트당 1회 보장. state 가 아니라 ref 여야 한다 — 리렌더를 유발하면 안 된다. */
  const attemptedRef = useRef(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>(
    IDLE_PROGRESS,
  );

  /**
   * 최신 목록을 effect 의 의존성으로 끌어들이지 않기 위한 거울.
   *
   * `characters` 를 deps 에 넣으면 동기화 성공 → 쿼리 무효화 → 새 배열 → effect 재실행이
   * 된다. `attemptedRef` 가 막아 주긴 하지만, **막아 주니까 괜찮다**에 기대는 대신
   * 애초에 재실행 이유를 만들지 않는다.
   */
  const charactersRef = useRef(characters);
  useEffect(() => {
    charactersRef.current = characters;
  }, [characters]);

  const runBatch = useCallback(
    async (input: {
      readonly apiKey: string;
      readonly characterIds: readonly string[];
    }): Promise<AutoSyncSummary> => {
      let succeeded = 0;
      let nexonCallsUsed = 0;
      let failureMessage: string | null = null;
      let aborted = false;

      for (const [index, characterId] of input.characterIds.entries()) {
        setProgress({ done: index, total: input.characterIds.length });
        try {
          // ★ 페이서를 반드시 통과한다. 동시 발사 = 429 = 그 키 60초 쿨다운.
          const result = await paceNexonRequest(() =>
            syncCharacterScheduler({ apiKey: input.apiKey, characterId }),
          );
          succeeded += 1;
          nexonCallsUsed += result.nexonCallsUsed;
          // 예전에 실패했더라도 지금 됐으면 기억을 지운다.
          forgetSyncFailure(characterId);
        } catch (error) {
          const kind =
            error instanceof BossPlanRequestError ? error.kind : null;
          // 첫 실패의 문구만 남긴다. 14개를 나열하면 읽히지 않는다.
          failureMessage ??=
            error instanceof Error
              ? error.message
              : "인게임 스케줄러를 불러오지 못했습니다.";
          if (shouldAbortAutoSync(kind)) {
            aborted = true;
            break;
          }
          /*
           * 그 캐릭터만의 문제 → 건너뛰고 계속. **재시도하지 않는다.**
           * 게다가 이 실패는 대개 **지금 키로는 못 읽는 캐릭터**(다른 넥슨 계정 소속)라
           * 다음 진입에서도 똑같이 실패한다. 기억해 두지 않으면 진입할 때마다 같은
           * 호출을 태운다 — `scheduler-sync-memo.ts` 참고.
           */
          rememberSyncFailure(characterId, input.apiKey);
        }
      }

      setProgress({
        done: input.characterIds.length,
        total: input.characterIds.length,
      });
      return {
        attempted: input.characterIds.length,
        succeeded,
        nexonCallsUsed,
        failureMessage,
        aborted,
      };
    },
    [],
  );

  const autoSync = useMutation({
    mutationFn: runBatch,
    onSuccess: (summary) => {
      // 한 명이라도 반영됐으면 계획·클리어·스냅샷이 바뀌었다. 계획 화면 캐시까지 함께.
      if (summary.succeeded > 0) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.bossPlans.root(),
        });
      }
    },
  });

  const { mutate } = autoSync;

  useEffect(() => {
    if (attemptedRef.current) return;
    /*
     * 키는 하이드레이션 이후에야 들어온다(`useStoredApiKey` 의 서버 스냅샷은 항상 null).
     * 그래서 키가 없는 동안에는 **시도했다고 표시하지 않고** 그냥 기다린다.
     * 끝까지 키가 없으면(다른 기기에서 로그인) 아무 일도 일어나지 않는 것이 정답이다.
     */
    if (apiKey === null) return;

    // 여기서부터는 "이번 마운트의 자동 동기화는 처리됐다"로 못 박는다.
    attemptedRef.current = true;

    const now = Date.now();
    const memo = readSyncFailureMemo(now);
    const characterIds = selectStaleCharacterIds(
      charactersRef.current,
      now,
    ).filter((characterId) => !isAutoSyncSuppressed(characterId, apiKey, memo));

    // 전부 신선하면 **넥슨을 한 번도 부르지 않는다.** 이것이 이 기능의 전제다.
    if (characterIds.length === 0) return;

    mutate({ apiKey, characterIds });
  }, [apiKey, mutate]);

  return {
    isSyncing: autoSync.isPending,
    progress,
    summary: autoSync.data ?? null,
  };
}
