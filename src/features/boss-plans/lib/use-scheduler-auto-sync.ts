"use client";

import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useToaster } from "@/components/ui/toast-context";
import { maskApiKey } from "@/features/auth/lib/api-key";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import {
  useIsHydrated,
  useStoredApiKeys,
} from "@/features/auth/lib/use-stored-api-key";
import { queryKeys } from "@/lib/query-keys";
import { isInResetWindow } from "@/lib/time/reset-window";

import { BossPlanRequestError, syncCharacterScheduler } from "../data";
import type { CharacterChecklist } from "../types";
import {
  isCredentialScopedFailure,
  resolveSyncKey,
  selectStaleCharacterIds,
  shouldAbortAutoSync,
  splitCharactersByKey,
  type CharactersByKey,
  type MissingKeyCharacter,
  type SyncPlanItem,
} from "./scheduler-freshness";
import {
  forgetSyncFailure,
  isAutoSyncSuppressed,
  readSyncFailureMemo,
  rememberSyncFailure,
} from "./scheduler-sync-memo";
import {
  describeAutoFailureNotice,
  describeCardFailureNotice,
  describeCardSuccessNotice,
  describeMissingKey,
  describeRefreshAllNotice,
  describeSyncFailure,
  describeUnlinkedCharacter,
  formatSyncFailure,
  pickFailureToReport,
  type StatusNotice,
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
 * 6. **재시도 폭주 금지.** 실패해도 즉시 재시도하지 않고, 상류 전체의 문제면 남은 캐릭터까지
 *    **중단**한다(`shouldAbortAutoSync`). 키 하나의 문제면 그 키의 캐릭터만 건너뛴다
 *    (`isCredentialScopedFailure`). "이 캐릭터만 다른 계정"은 중단 사유가 아니다 —
 *    그건 정상이며 건너뛰면 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 비로그인은 시도조차 하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 대시보드 자체가 활성 세션일 때만 렌더되므로 이 훅이 **마운트되지 않는다**
 * (`src/app/page.tsx`). 그리고 서버 경로도 세션 쿠키가 없으면 401 이다 —
 * 키가 DB 에 있다는 것이 "아무나 부를 수 있다"를 뜻하지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 사람이 누르는 **전체 갱신**도 같은 루프를 돈다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-11-02): *"웹사이트에 이번주 ? 탭에 전체갱신이 없어"*.
 *
 * 페이서·문구·중단 판정이 전부 같아야 하므로 루프를 두 벌 만들지 않는다.
 * 자동과 다른 점은 넷이다:
 *   · **서버 캐시를 건너뛴다**(`force: true`). 사람이 "지금 달라"고 누른 것이다(§1.1).
 *   · 시간 기준 없이 **키가 있는 캐릭터를 전부** 부르고, 실패 기억을 보지 않는다.
 *   · **실패를 기억하지 않는다.** 기억은 "자동이 이 캐릭터를 건너뛴다"는 뜻이라, 사람이 누른
 *     한 번의 실패가 자동을 24시간 멈추면 안 된다. 성공이 기억을 지우는 것은 같다.
 *   · **화면을 떠나면 남은 호출을 멈춘다.** 자동 경로는 예전처럼 끝까지 돈다.
 *
 * ★ **웹에는 5분 제한이 없다**(발주 지시 2026-11-02: *"봇에만걸어"*). 사람이 로그인해 자기
 *   키로 누르는 것이고, 한 번 누를 때 호출은 그 사람의 추적 캐릭터 수만큼이라(2026-11-02 실측
 *   으로 가장 많은 사람이 10명이다. 상한은 아니다) 방 안 누구나 칠 수 있는 봇과 다르다.
 *   그래서 호출을 막는 제동은 아래 잠금 하나뿐이다.
 *
 * ★ 겹침 방지는 `SCHEDULER_SYNC_MUTATION_KEY` 하나로 한다. 자동·전체·카드별 새로고침이
 *   같은 키를 들고, 키가 돌고 있으면 어느 쪽도 새로 시작하지 않는다. 뮤테이션 캐시는
 *   컴포넌트보다 오래 살므로, **떠났다 돌아온 화면도 앞선 배치가 아직 도는 것을 본다.**
 * ★ 세 경로 모두 `networkMode: "always"` 다. 기본값이면 오프라인일 때 뮤테이션이 일시정지되어
 *   "갱신 중"만 돌다가, 복귀하는 순간 **낡은 목록으로** 호출이 나간다. 곧바로 실패하고 말한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 결과는 **머리 상태 칸 하나**에 낸다 — 카드를 밀지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자가 가장 싫어하는 것이 버튼 위치가 움직이는 것이다. 결과 문단을 흐름에 끼우면 모든 카드와
 * **방금 누른 버튼까지** 밀린다. 그래서 결과는 자리가 예약된 칸(`notice`)에 짧게 내고, 원인·조치
 * 문장은 화면 위에 뜨는 토스트로 말한다. 마지막 사건이 칸을 차지한다 — 한 칸이라 순서가 곧 규칙이다.
 */

/**
 * 이 화면에서 넥슨을 부르는 뮤테이션이 함께 드는 키. 쿼리 키가 아니라 겹침 판정 전용이다.
 */
export const SCHEDULER_SYNC_MUTATION_KEY = [
  "boss-plans",
  "scheduler-sync",
] as const;

/**
 * 위 키 아래의 **여러 캐릭터를 도는 배치.** 잠금 판정은 위 키로 하고, 이 키는 "진행 중"을
 * 보여 줄지만 가른다 — 카드 하나 도는 동안 머리 버튼이 배치처럼 돌면 안 된다. 뮤테이션 캐시를
 * 보므로 떠났다 돌아온 화면에서도 앞선 배치가 보인다.
 */
const SCHEDULER_BATCH_MUTATION_KEY = [
  ...SCHEDULER_SYNC_MUTATION_KEY,
  "batch",
] as const;

/**
 * 깨끗하게 끝난 결과가 칸에 남아 있는 시간.
 *
 * 한 번 읽으면 끝나는 말이라 자리를 `추적 N명` 에 돌려준다. `warning` 은 조치가 필요한 말이라
 * 다음 누름까지 남긴다.
 */
const NOTICE_VISIBLE_MS = 20_000;

/**
 * 재조회를 기다리는 상한 — 15초. 넘으면 잠금을 풀고 데이터는 뒤이어 도착한다.
 *
 * 잠금은 사람이 다시 누르지 못하게 막는 것이라, 재조회 하나가 안 끝난다고 화면의 모든 갱신 버튼을
 * 묶어 둘 이유가 없다. 재조회 자체를 끊지는 않는다.
 */
const REFETCH_WAIT_LIMIT_MS = 15_000;

/**
 * 동기화 뒤 무효화. 자동·전체·카드별이 **같은 목록**을 쓴다(§2.4 Rule 5).
 *
 * 동기화는 스냅샷·계획·클리어를 한꺼번에 바꾼다. `/chores` 는 같은 스냅샷을 읽고, `/` 시간표의
 * 클리어 표시도 같은 동기화가 만들며, 수익 원장과 12칸 분자도 함께 움직인다. 한쪽 경로에만 적어
 * 두면 그 경로로 돈 날에만 숫자가 어긋난다.
 *
 * ★ 다시 읽기를 **기다린다.** `onSuccess` 가 약속을 돌려주면 뮤테이션은 그때까지 진행 중이고,
 *   잠금도 그때까지 풀리지 않는다. 그래서 버튼이 풀리는 순간 금액과 12칸은 이미 새 값이다. 화면이
 *   바뀌기 전에 풀면 사람은 안 된 줄 알고 또 누르고, 그 한 번이 캐릭터 수만큼의 호출이다.
 */
export async function refetchAfterSync(queryClient: QueryClient): Promise<void> {
  const refetched = Promise.all(
    [
      queryKeys.db.bossPlans.root(),
      queryKeys.db.income.root(),
      queryKeys.db.dashboard.root(),
      queryKeys.db.chores.root(),
      queryKeys.db.runs.root(),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REFETCH_WAIT_LIMIT_MS);
  });
  await Promise.race([refetched, limit]);
  clearTimeout(timer);
}

/**
 * 같은 내용의 토스트가 지금 떠 있는가. 토스트는 공용 부품이라 중복을 거기서 막지 않고 여기서
 * 묻는다 — `자세히` 를 거듭 누르면 같은 카드가 쌓여 작은 화면을 덮는다(360×640 에서 83%).
 * 시간이 아니라 화면을 보는 이유: 닫은 뒤에 다시 누르면 다시 떠야 한다.
 */
function isToastShowing(detail: NonNullable<StatusNotice["detail"]>): boolean {
  const region = document.querySelector('[aria-label="저장 결과 알림"]');
  if (region === null) return false;
  return Array.from(region.children).some(
    (card) =>
      card.textContent?.includes(detail.title) === true &&
      card.textContent.includes(detail.description),
  );
}

/** 동기화 배치 1회의 결과 요약. **던지는 대신 이걸 돌려준다.** */
export interface AutoSyncSummary {
  /** 동기화를 시도한 캐릭터 수. */
  readonly attempted: number;
  /** 실제로 성공한 캐릭터 수. */
  readonly succeeded: number;
  /** 실패한 캐릭터 수. */
  readonly failedCount: number;
  /** 부르려 했지만 앞선 실패로 포기했거나 화면을 떠나 부르지 못한 캐릭터 수. */
  readonly notReachedCount: number;
  /** 이번 진입에서 실제로 나간 넥슨 호출 수. 서버 캐시에 맞으면 0일 수 있다. */
  readonly nexonCallsUsed: number;
  /**
   * 말해야 할 실패의 **원인 + 조치**. 없으면 `null`. 여럿이면 조치가 큰 쪽이다
   * (`pickFailureToReport`).
   *
   * ★ 문구를 이 훅이 만들지 않는다 — `sync-failure-message.ts` 가 만든다. 예전에는
   *   서버 문구를 그대로 흘려 "캐릭터명이나 조회 날짜를 확인해 주세요"라는 **사실이
   *   아닌** 안내가 화면에 떴다.
   */
  readonly failure: SyncFailureNotice | null;
  /** 화면에 그대로 넣을 수 있는 한 문장. `failure` 가 없으면 `null`. */
  readonly failureMessage: string | null;
  /** 세션·상류 문제라 남은 캐릭터를 **전부** 포기했는가. 키 하나의 문제는 그 키만 건너뛴다. */
  readonly aborted: boolean;
}

export interface SchedulerAutoSyncState {
  /**
   * 배치(자동 또는 전체 갱신)가 도는 중인가. **잠금 키 기준**이라 떠나기 전 화면의 배치도 센다.
   * 끝나고 화면이 새 값을 받을 때까지다.
   */
  readonly isBatchRunning: boolean;
  /**
   * 넥슨을 부르는 것이 **무엇이든** 도는 중인가 — 배치, 카드별 새로고침, 떠나기 전 화면의
   * 배치까지. 이 값이 참이면 어떤 버튼으로도 새 호출을 시작하지 않는다.
   */
  readonly isBusy: boolean;
  /** 이 화면이 돌리는 배치의 진행 `done / total`. 앞선 화면의 배치면 `total` 이 0이다. */
  readonly progress: { readonly done: number; readonly total: number };
  /** 지금 전체 갱신을 시작할 수 있는가. 키 판정이 서기 전(하이드레이션)에도 거짓이다. */
  readonly canRefreshAll: boolean;
  /** 전체 갱신 시작. 다른 호출이 도는 중이면 아무것도 하지 않는다. */
  readonly refreshAll: () => void;
  /** 카드별 새로고침. 다른 호출이 도는 중이면 아무것도 하지 않는다. 5분 제한 같은 것은 없다. */
  readonly refreshCharacter: (input: {
    readonly apiKey: string | null;
    readonly characterId: string;
  }) => void;
  /** 지금 카드별 새로고침으로 부르고 있는 캐릭터. */
  readonly refreshingCharacterId: string | null;
  /** 머리 상태 칸에 낼 마지막 결과. 없으면 칸은 평소 말을 한다. */
  readonly notice: StatusNotice | null;
  /** 칸의 결과에 딸린 자세한 사정을 토스트로 다시 연다. */
  readonly showNoticeDetail: () => void;
  /**
   * 키가 없어 부를 수 없는 캐릭터. **호출 없이 아는 정보**라 처음부터 답한다 — 자동 배치가 끝나기를
   * 기다렸다 그리면 몇 초 뒤에 문단이 끼어들어 카드를 민다.
   */
  readonly missingKey: readonly MissingKeyCharacter[];
  /**
   * 하이드레이션 전이라 키 없음 판정이 아직 확실하지 않은가. 서버에는 이 브라우저의 키가 안 보이므로
   * 자격증명이 있는 캐릭터는 아직 모른다. 그동안 문단은 자리만 잡고 글자를 감춘다.
   */
  readonly isMissingKeyTentative: boolean;
}

const IDLE_PROGRESS = { done: 0, total: 0 } as const;

interface SyncBatchInput {
  /** `manual` 이면 사람이 누른 것이다 — 서버 캐시를 건너뛰고, 화면을 떠나면 멈춘다. */
  readonly mode: "auto" | "manual";
  readonly plan: readonly SyncPlanItem[];
}

export function useSchedulerAutoSync(
  characters: readonly CharacterChecklist[],
): SchedulerAutoSyncState {
  const apiKeys = useStoredApiKeys();
  /** localStorage 판정이 설 때까지 기다린다. 서버 스냅샷으로 판정하면 틀린 결론이 나온다. */
  const hydrated = useIsHydrated();
  const queryClient = useQueryClient();
  const { notify } = useToaster();

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
  /**
   * 자동 판정을 마친 저장소 스냅샷. 저장소는 내용이 같으면 참조가 그대로다.
   *
   * `isBusy` 는 "미뤄 둔 판정을 다시 하라"는 신호로만 effect 를 깨운다. 이 값이 없으면 배치가 끝날
   * 때마다 판정을 다시 해서, **백필로 서버 키가 생긴 것을 키 구성이 바뀐 것으로 읽고** 같은 진입에서
   * 자동이 또 돈다.
   */
  const settledKeysRef = useRef<typeof apiKeys | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>(
    IDLE_PROGRESS,
  );
  const [notice, setNotice] = useState<StatusNotice | null>(null);

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

  /** 화면을 떠났는가. StrictMode 이중 마운트가 있으므로 마운트 때 되돌려야 한다. */
  const leftPageRef = useRef(false);
  useEffect(() => {
    leftPageRef.current = false;
    return () => {
      leftPageRef.current = true;
    };
  }, []);

  /**
   * 결과를 칸에 올리고, 자세한 사정이 있으면 토스트로 말한다.
   *
   * 뮤테이션의 `onSuccess` 는 화면을 떠난 뒤에도 돈다. 다른 화면에 이 화면의 토스트를 띄우지 않는다.
   */
  const publish = useCallback(
    (next: StatusNotice | null) => {
      setNotice(next);
      if (next?.detail != null && !leftPageRef.current && !isToastShowing(next.detail)) {
        notify(next.detail);
      }
    },
    [notify],
  );

  const runBatch = useCallback(
    async (input: SyncBatchInput): Promise<AutoSyncSummary> => {
      const isManual = input.mode === "manual";
      let succeeded = 0;
      let failedCount = 0;
      let notReachedCount = 0;
      let nexonCallsUsed = 0;
      let failure: SyncFailureNotice | null = null;
      let aborted = false;
      /** 키 자체가 막힌 자격증명. 같은 키의 남은 캐릭터는 불러 봐야 같은 실패다. */
      const blockedCredentialIds = new Set<string>();

      for (const [index, item] of input.plan.entries()) {
        // 이미 보낸 호출은 그대로 끝난다. 아직 안 보낸 것만 멈춘다.
        if (isManual && leftPageRef.current) {
          notReachedCount += input.plan.length - index;
          break;
        }
        setProgress({ done: index, total: input.plan.length });
        if (blockedCredentialIds.has(item.credentialId)) {
          notReachedCount += 1;
          continue;
        }
        try {
          // ★ 페이서를 반드시 통과한다. 동시 발사 = 429 = 그 키 60초 쿨다운.
          const result = await paceNexonRequest(() =>
            syncCharacterScheduler({
              apiKey: item.apiKey,
              characterId: item.characterId,
              force: isManual,
            }),
          );
          succeeded += 1;
          nexonCallsUsed += result.nexonCallsUsed;
          // 예전에 실패했더라도 지금 됐으면 기억을 지운다.
          forgetSyncFailure(item.characterId);
        } catch (error) {
          const kind =
            error instanceof BossPlanRequestError ? error.kind : null;
          failedCount += 1;
          // 하나만 말한다. 여러 개를 나열하면 읽히지 않는다. 무엇을 말할지는 크기로 고른다.
          failure = pickFailureToReport(
            failure,
            describeSyncFailure(error, {
              credentialLabel: item.credentialLabel,
            }),
          );
          if (shouldAbortAutoSync(kind)) {
            if (isCredentialScopedFailure(kind)) {
              blockedCredentialIds.add(item.credentialId);
              continue;
            }
            aborted = true;
            notReachedCount += input.plan.length - index - 1;
            break;
          }
          /*
           * 그 캐릭터만의 문제 → 건너뛰고 계속. **재시도하지 않는다.**
           * 기억은 **자격증명 + 키 마스킹**과 함께 남으므로, 사용자가 그 계정의 키를
           * 새로 넣으면 즉시 무효가 되어 다시 시도한다. 사람이 누른 실패는 적지 않는다.
           */
          if (!isManual) {
            rememberSyncFailure(
              item.characterId,
              item.credentialId,
              item.apiKey,
            );
          }
        }
      }

      setProgress({ done: input.plan.length, total: input.plan.length });
      return {
        attempted: input.plan.length,
        succeeded,
        failedCount,
        notReachedCount,
        nexonCallsUsed,
        failure,
        failureMessage: failure === null ? null : formatSyncFailure(failure),
        aborted,
      };
    },
    [],
  );

  const autoSync = useMutation({
    mutationKey: SCHEDULER_BATCH_MUTATION_KEY,
    networkMode: "always",
    mutationFn: (plan: readonly SyncPlanItem[]) =>
      runBatch({ mode: "auto", plan }),
    onSuccess: async (summary) => {
      if (summary.succeeded > 0) await refetchAfterSync(queryClient);
      publish(
        summary.failureMessage === null
          ? null
          : describeAutoFailureNotice({
              failed: summary.failedCount,
              notReached: summary.notReachedCount,
              failureMessage: summary.failureMessage,
            }),
      );
    },
  });

  const refreshAllMutation = useMutation({
    mutationKey: SCHEDULER_BATCH_MUTATION_KEY,
    networkMode: "always",
    mutationFn: (split: CharactersByKey) =>
      runBatch({ mode: "manual", plan: split.targets }),
    onSuccess: async (summary, split) => {
      if (summary.succeeded > 0) await refetchAfterSync(queryClient);
      publish(
        describeRefreshAllNotice({
          succeeded: summary.succeeded,
          failed: summary.failedCount,
          notReached: summary.notReachedCount,
          missingKey: split.missingKey.length,
          failureMessage: summary.failureMessage,
          inResetWindow: isInResetWindow(new Date()),
        }),
      );
    },
  });

  /**
   * 카드별 새로고침. **신선도 가드를 우회한다** — 사용자가 명시적으로 눌렀기 때문이다
   * ("방금 잡았으니 지금 갱신"). 다만 `paceNexonRequest` 는 우회하지 못한다:
   * 우회해도 되는 것은 *우리* 규칙이지 넥슨의 초당 5콜 한도가 아니다.
   */
  const cardSync = useMutation({
    mutationKey: SCHEDULER_SYNC_MUTATION_KEY,
    networkMode: "always",
    mutationFn: (input: {
      readonly apiKey: string | null;
      readonly characterId: string;
    }) =>
      /*
        ★ `force: true` — **서버 캐시를 건너뛴다** (2026-08-24, §0.2-1 동일 적용).
          이 버튼은 사람이 "지금 갱신하라"고 누른 것인데, 게이트웨이가 응답을 15분 캐시하고
          그 읽기는 TTL 을 다시 보지 않으므로 **누르고도 넥슨을 부르지 않고 같은 옛 값**을
          돌려주고 있었다. 자동 경로(진입 시 동기화 · 밤 크론 · 런 종료 후)는 켜지 않는다.
      */
      paceNexonRequest(() => syncCharacterScheduler({ ...input, force: true })),
    onSuccess: async (result) => {
      /*
       * 자동 경로가 "이 캐릭터는 지금 키로 못 읽는다"고 기억해 뒀더라도, 수동으로
       * 성공했으면 그 기억은 틀린 것이다. 지워야 다음 진입에서 자동으로도 돈다.
       */
      forgetSyncFailure(result.characterId);
      await refetchAfterSync(queryClient);
      publish(
        describeCardSuccessNotice({
          characterName: result.characterName,
          clearRecordedCount: result.clearRecordedCount,
          unmappedCount: result.unmappedCount,
          inResetWindow: isInResetWindow(new Date()),
        }),
      );
    },
    onError: (error, input) => {
      const character = charactersRef.current.find(
        (entry) => entry.character.characterId === input.characterId,
      )?.character;
      publish(
        describeCardFailureNotice(
          character?.name ?? "이 캐릭터",
          describeSyncFailure(error, {
            credentialLabel: character?.credentialLabel ?? null,
          }),
        ),
      );
    },
  });

  const { mutate: mutateAutoSync } = autoSync;
  const { mutate: mutateRefreshAll } = refreshAllMutation;
  const { mutate: mutateCardSync } = cardSync;

  /** 자동·전체·카드별 새로고침, 그리고 떠나기 전 화면의 배치까지 전부 센다. */
  const isBusy =
    useIsMutating({ mutationKey: SCHEDULER_SYNC_MUTATION_KEY }) > 0;
  const isBatchRunning =
    useIsMutating({ mutationKey: SCHEDULER_BATCH_MUTATION_KEY }) > 0;

  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  /**
   * 렌더 값(`isBusy`)이 아니라 **지금** 캐시를 묻는다. 빠른 연타는 다음 렌더보다 먼저 들어오고,
   * 그걸 놓치면 같은 캐릭터를 두 번씩 부른다.
   */
  const isLockedNow = useCallback(
    () =>
      queryClient.isMutating({ mutationKey: SCHEDULER_SYNC_MUTATION_KEY }) > 0,
    [queryClient],
  );

  const refreshAll = useCallback(() => {
    if (!hydrated || isLockedNow()) return;
    setNotice(null);
    setProgress(IDLE_PROGRESS);
    mutateRefreshAll(splitCharactersByKey(charactersRef.current, apiKeys));
  }, [apiKeys, hydrated, isLockedNow, mutateRefreshAll]);

  const refreshCharacter = useCallback<
    SchedulerAutoSyncState["refreshCharacter"]
  >(
    (input) => {
      if (isLockedNow()) return;
      setNotice(null);
      mutateCardSync(input);
    },
    [isLockedNow, mutateCardSync],
  );

  const showNoticeDetail = useCallback(() => {
    if (notice?.detail != null && !isToastShowing(notice.detail)) notify(notice.detail);
  }, [notice, notify]);

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
    if (settledKeysRef.current === apiKeys) return;
    /*
     * 다른 호출이 도는 중이면 **아무것도 적지 않고** 미룬다. 끝나면 `isBusy` 가 바뀌어 여기로
     * 다시 들어오므로, 전체 갱신 중에 키를 넣어도 그 키의 자동 동기화를 놓치지 않는다.
     * 렌더 값과 함께 캐시도 직접 묻는다 — 같은 틱의 클릭은 아직 렌더에 없다.
     */
    if (isBusy || isLockedNow()) return;
    settledKeysRef.current = apiKeys;

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

    for (const entry of characters) {
      if (!staleIds.has(entry.character.characterId)) continue;

      const resolved = resolveSyncKey(entry.character, apiKeys);
      if (resolved.kind === "missing") continue;

      const { characterId, credentialId, apiKey } = resolved.item;
      if (isAutoSyncSuppressed(characterId, credentialId, apiKey, memo)) {
        continue;
      }
      plan.push(resolved.item);
    }

    // 부를 것이 하나도 없으면 **넥슨을 한 번도 부르지 않는다.** 이것이 이 기능의 전제다.
    if (plan.length === 0) return;

    mutateAutoSync(plan);
  }, [apiKeys, hydrated, isBusy, isLockedNow, mutateAutoSync]);

  const missingKey = useMemo(
    () => splitCharactersByKey(characters, apiKeys).missingKey,
    [apiKeys, characters],
  );

  return {
    isBatchRunning,
    isBusy,
    progress,
    canRefreshAll: hydrated && !isBusy,
    refreshAll,
    refreshCharacter,
    refreshingCharacterId: cardSync.isPending
      ? (cardSync.variables?.characterId ?? null)
      : null,
    notice,
    showNoticeDetail,
    missingKey,
    isMissingKeyTentative:
      !hydrated && missingKey.some((entry) => entry.credentialId !== null),
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
