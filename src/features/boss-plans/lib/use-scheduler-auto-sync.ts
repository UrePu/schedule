"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { maskApiKey } from "@/features/auth/lib/api-key";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import {
  useIsHydrated,
  useStoredApiKeys,
} from "@/features/auth/lib/use-stored-api-key";
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
import {
  describeMissingKey,
  describeSyncFailure,
  describeUnlinkedCharacter,
  formatSyncFailure,
  type SyncFailureNotice,
} from "./sync-failure-message";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 진입 시 **자동 동기화 1회** (CLAUDE.md §1.1.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구: *"다시 대시보드에 들어갔을 때 자동으로 갱신해. 버튼 직접 누르는 것도 있게
 * 하고 대시보드 접속할 때 한 번."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 캐릭터마다 **그 계정의 키**로 부른다 (§2.1 · §1.1 · §2.1.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 키는 그 키를 발급한 계정의 캐릭터만 읽는다. 한 사람이 넥슨 계정을 여러 개 쓰므로
 * (실계정 3개) **하나의 키로 전부 도는 것은 애초에 불가능**하다.
 *
 * 이제 키를 고르는 주체는 **서버**다(§2.1.2). 원문 키가 DB 에 암호화돼 보관되므로
 * `characterId` 만 보내면 서버가 그 캐릭터의 계정 키를 꺼내 부른다. 그래서 판정은:
 *
 * ```
 *   character.serverKeyAvailable === true   → 브라우저 키 없이도 부른다   ← 기본 경로
 *   아니면 localStorage 에 그 자격증명 키가 있다 → 그것을 함께 보낸다(백필 겸용)
 *   둘 다 아니면                             → 부르지 않는다. "키 없음" 상태다
 * ```
 *
 * 예전에는 두 번째 줄만 있었고, 그래서 **키가 하나도 없는 새 브라우저는 아무것도
 * 동기화하지 못했다** — 자격증명 3건과 캐릭터 304명이 화면에 다 보이는 채로.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 훅이 지키는 여섯 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **신선하면 아예 시작하지 않는다.** 마지막 호출이 15분(넥슨 지연 창) 안이면 대상에서
 *    빠진다. 판정 근거는 `scheduler-freshness.ts` 참고.
 * 2. **같은 키 구성으로는 딱 한 번.** `attemptedSignatureRef` 가 재실행을 막는다.
 *    리렌더·쿼리 갱신·StrictMode 이중 마운트 전부 여기서 걸린다. **폴링이 아니다.**
 * 3. **렌더를 막지 않는다.** effect 라 첫 페인트 이후에 돈다.
 * 4. **직렬 + 페이서.** 동시에 쏘면 초당 5콜 한도에 걸려 그 키가 60초 쿨다운에 들어간다.
 * 5. **실패해도 화면이 깨지지 않는다.** mutationFn 이 **던지지 않고 요약을 반환**한다.
 * 6. **재시도 폭주 금지.** 실패해도 즉시 재시도하지 않고, 자격증명·상류 문제면 남은
 *    캐릭터까지 **중단**한다(`shouldAbortAutoSync`). 다만 "이 캐릭터만 다른 계정"은
 *    중단 사유가 아니다 — 그건 정상이며 건너뛰면 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 비로그인은 시도조차 하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 대시보드 자체가 활성 세션일 때만 렌더되므로 이 훅이 **마운트되지 않는다**
 * (`src/app/page.tsx`). 그리고 서버 경로도 세션 쿠키가 없으면 401 이다 —
 * 키가 DB 에 있다는 것이 "아무나 부를 수 있다"를 뜻하지 않는다.
 */

/** 키가 없어 부르지 못한 캐릭터 1건. **실패가 아니라 상태다.** */
export interface MissingKeyCharacter {
  readonly characterId: string;
  readonly characterName: string;
  /**
   * 필요한 자격증명. `null` 이면 **어느 계정 소속인지조차 모른다**(옛 행) —
   * 그건 "키를 넣어라"와는 다른 상태이므로 문구도 달라야 한다.
   */
  readonly credentialId: string | null;
  /** 그 자격증명에 붙은 이름. 자격증명이 있어도 이름은 비어 있을 수 있다. */
  readonly credentialLabel: string | null;
}

/** 자동 동기화 1회의 결과 요약. **던지는 대신 이걸 돌려준다.** */
export interface AutoSyncSummary {
  /** 동기화를 시도한 캐릭터 수(= 신선하지 않고 **키도 있는** 캐릭터 수). */
  readonly attempted: number;
  /** 실제로 성공한 캐릭터 수. */
  readonly succeeded: number;
  /** 이번 진입에서 실제로 나간 넥슨 호출 수. 서버 캐시에 맞으면 0일 수 있다. */
  readonly nexonCallsUsed: number;
  /**
   * 첫 실패의 **원인 + 조치**. 없으면 `null`.
   *
   * ★ 문구를 이 훅이 만들지 않는다 — `sync-failure-message.ts` 가 만든다. 예전에는
   *   서버 문구를 그대로 흘려 "캐릭터명이나 조회 날짜를 확인해 주세요"라는 **사실이
   *   아닌** 안내가 화면에 떴다.
   */
  readonly failure: SyncFailureNotice | null;
  /** 화면에 그대로 넣을 수 있는 한 문장. `failure` 가 없으면 `null`. */
  readonly failureMessage: string | null;
  /** 자격증명·상류 문제라 남은 캐릭터를 포기했는가. */
  readonly aborted: boolean;
  /**
   * **키가 이 브라우저에 없어 부르지 못한** 캐릭터들.
   *
   * 이것을 `failure` 와 섞지 않는 것이 이 수정의 요지다 — 원인도 조치도 다르다.
   */
  readonly missingKey: readonly MissingKeyCharacter[];
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

/**
 * 이번 배치에서 캐릭터 하나에 쓸 재료.
 *
 * `apiKey` 가 `null` 이면 **서버가 DB 에서 꺼내 쓴다**(§2.1.2) — 실패가 아니라 기본 경로다.
 * 값이 있으면 하위 호환 겸 백필용으로 함께 보낸다.
 */
interface SyncPlanItem {
  readonly characterId: string;
  readonly credentialId: string;
  readonly apiKey: string | null;
}

export function useSchedulerAutoSync(
  characters: readonly CharacterChecklist[],
): SchedulerAutoSyncState {
  const apiKeys = useStoredApiKeys();
  /** localStorage 판정이 설 때까지 기다린다. 서버 스냅샷으로 판정하면 틀린 결론이 나온다. */
  const hydrated = useIsHydrated();
  const queryClient = useQueryClient();

  /**
   * 이미 시도한 **키 구성**. state 가 아니라 ref 여야 한다 — 리렌더를 유발하면 안 된다.
   *
   * ★ 예전에는 단순 `boolean`(마운트당 1회)이었다. 그러면 사용자가 방금 부계정 키를
   *   입력해도 **새로고침 전까지 아무 일도 일어나지 않는다** — 고친 것이 고쳐 보이지
   *   않는다. 그렇다고 매 렌더 재실행하면 폴링이 된다.
   *
   *   그래서 기준을 "마운트"가 아니라 **"우리가 가진 키의 구성"** 으로 바꾼다.
   *   리렌더·쿼리 무효화·StrictMode 이중 마운트는 구성을 바꾸지 않으므로 여전히 한 번만
   *   돈다. 반대로 키가 새로 들어오면 구성이 달라지고 **그때 딱 한 번 더** 돈다.
   *   그 시점에 이미 신선한 캐릭터는 가드가 걸러 내므로 넥슨 호출은 새 키가 열어 준
   *   캐릭터에만 나간다.
   */
  const attemptedSignatureRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>(
    IDLE_PROGRESS,
  );

  /**
   * 최신 목록을 effect 의 의존성으로 끌어들이지 않기 위한 거울.
   *
   * `characters` 를 deps 에 넣으면 동기화 성공 → 쿼리 무효화 → 새 배열 → effect 재실행이
   * 된다. 서명 가드가 막아 주긴 하지만, **막아 주니까 괜찮다**에 기대는 대신 애초에
   * 재실행 이유를 만들지 않는다.
   */
  const charactersRef = useRef(characters);
  useEffect(() => {
    charactersRef.current = characters;
  }, [characters]);

  const runBatch = useCallback(
    async (input: {
      readonly plan: readonly SyncPlanItem[];
      readonly missingKey: readonly MissingKeyCharacter[];
    }): Promise<AutoSyncSummary> => {
      let succeeded = 0;
      let nexonCallsUsed = 0;
      let failure: SyncFailureNotice | null = null;
      let aborted = false;

      for (const [index, item] of input.plan.entries()) {
        setProgress({ done: index, total: input.plan.length });
        try {
          // ★ 페이서를 반드시 통과한다. 동시 발사 = 429 = 그 키 60초 쿨다운.
          const result = await paceNexonRequest(() =>
            syncCharacterScheduler({
              apiKey: item.apiKey,
              characterId: item.characterId,
            }),
          );
          succeeded += 1;
          nexonCallsUsed += result.nexonCallsUsed;
          // 예전에 실패했더라도 지금 됐으면 기억을 지운다.
          forgetSyncFailure(item.characterId);
        } catch (error) {
          const kind =
            error instanceof BossPlanRequestError ? error.kind : null;
          // 첫 실패의 문구만 남긴다. 여러 개를 나열하면 읽히지 않는다.
          failure ??= describeSyncFailure(error);
          if (shouldAbortAutoSync(kind)) {
            aborted = true;
            break;
          }
          /*
           * 그 캐릭터만의 문제 → 건너뛰고 계속. **재시도하지 않는다.**
           * 기억은 **자격증명 + 키 마스킹**과 함께 남으므로, 사용자가 그 계정의 키를
           * 새로 넣으면 즉시 무효가 되어 다시 시도한다.
           */
          rememberSyncFailure(item.characterId, item.credentialId, item.apiKey);
        }
      }

      setProgress({ done: input.plan.length, total: input.plan.length });
      return {
        attempted: input.plan.length,
        succeeded,
        nexonCallsUsed,
        failure,
        failureMessage: failure === null ? null : formatSyncFailure(failure),
        aborted,
        missingKey: input.missingKey,
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
    /*
     * ★ **하이드레이션이 끝나기 전에는 아무것도 하지 않는다.**
     *
     *   `useStoredApiKeys` 의 서버 스냅샷은 언제나 빈 객체라, 그 상태로 판정하면 로컬
     *   키를 가진 사용자도 "키 없음"으로 한 번 돌게 된다. 예전에는 "맵이 비면 return"
     *   으로 그 순간을 피했는데, 이제 맵이 비어도 **서버 키로 도는 것이 정상 경로**라
     *   그 방법을 쓸 수 없다. 그래서 판정 자체를 하이드레이션 뒤로 미룬다 — 그러면 이
     *   effect 는 최종 키 구성으로 **정확히 한 번** 돈다(같은 캐릭터를 두 번 부르지 않는다).
     */
    if (!hydrated) return;

    const characters = charactersRef.current;

    /*
     * 서명 = **(로컬 키 구성) + (서버가 키를 갖고 있는 자격증명)**.
     *
     * 원문이 아니라 **마스킹**을 넣는다. id 만으로 서명하면 "같은 자격증명의 키를 새
     * 것으로 교체"(재발급 후 다시 입력)를 알아채지 못하고, 원문을 넣으면 키를 다루는
     * 범위가 넓어진다. 마스킹은 값 변화를 그대로 반영하면서 복원이 불가능하다.
     *
     * 서버 쪽 축을 함께 넣는 이유: 사용자가 키를 처음 서버에 올리면 로컬 구성은 그대로인데
     * **부를 수 있는 캐릭터가 늘어난다.** 그 변화를 서명이 못 보면 새로고침 전까지 아무
     * 일도 일어나지 않는다 — 고친 것이 고쳐 보이지 않는 그 문제다.
     */
    const localCredentialIds = Object.keys(apiKeys).sort();
    const serverKeyCredentialIds = [
      ...new Set(
        characters.flatMap((entry) =>
          entry.character.serverKeyAvailable &&
          entry.character.credentialId !== null
            ? [entry.character.credentialId]
            : [],
        ),
      ),
    ].sort();

    const signature = JSON.stringify([
      localCredentialIds.map((id) => [id, maskApiKey(apiKeys[id] ?? "")]),
      serverKeyCredentialIds,
    ]);
    if (attemptedSignatureRef.current === signature) return;

    // 여기서부터는 "이 키 구성에 대한 자동 동기화는 처리됐다"로 못 박는다.
    attemptedSignatureRef.current = signature;

    const now = Date.now();
    const memo = readSyncFailureMemo(now);
    const staleIds = new Set(selectStaleCharacterIds(characters, now));

    const plan: SyncPlanItem[] = [];
    const missingKey: MissingKeyCharacter[] = [];

    for (const entry of characters) {
      const {
        characterId,
        name,
        credentialId,
        credentialLabel,
        serverKeyAvailable,
      } = entry.character;
      if (!staleIds.has(characterId)) continue;

      /*
       * ★ 부를 수 있는 근거가 하나도 없으면 **부르지 않는다.** 다른 계정 키를 대신
       *   보내면 넥슨이 `OPENAPI00004` 로 거절하면서 호출량만 태운다(§1.0 실측).
       *   이 캐릭터는 실패가 아니라 "키 없음"으로 세어 화면이 조치를 안내한다.
       *
       *   근거는 둘이다 — **서버에 그 계정 키가 있거나**(§2.1.2, 기본 경로),
       *   이 브라우저에 원문이 있거나. 후자는 함께 보내 백필까지 겸한다.
       */
      const localKey =
        credentialId === null ? null : (apiKeys[credentialId] ?? null);
      if (credentialId === null || (!serverKeyAvailable && localKey === null)) {
        missingKey.push({
          characterId,
          characterName: name,
          credentialId,
          credentialLabel,
        });
        continue;
      }

      if (isAutoSyncSuppressed(characterId, credentialId, localKey, memo)) {
        continue;
      }
      plan.push({ characterId, credentialId, apiKey: localKey });
    }

    // 부를 것이 하나도 없으면 **넥슨을 한 번도 부르지 않는다.** 이것이 이 기능의 전제다.
    if (plan.length === 0 && missingKey.length === 0) return;

    mutate({ plan, missingKey });
  }, [apiKeys, hydrated, mutate]);

  return {
    isSyncing: autoSync.isPending,
    progress,
    summary: autoSync.data ?? null,
  };
}

/**
 * 키 없음 안내 문장. 화면 두 곳(체크리스트 배너 · 캐릭터 카드)이 같은 문장을 써야 한다.
 *
 * **자격증명이 있는데 키만 없다** = "그 키를 입력하세요".
 * **자격증명 자체가 없다** = "어느 계정인지 모르니 키를 다시 확인하세요". 조치가 다르다.
 */
export function missingKeyNotice(entry: {
  readonly credentialId: string | null;
  readonly credentialLabel: string | null;
}): SyncFailureNotice {
  return entry.credentialId === null
    ? describeUnlinkedCharacter()
    : describeMissingKey(entry.credentialLabel);
}
