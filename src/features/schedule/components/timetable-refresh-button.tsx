"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import {
  BossPlanRequestError,
  syncCharacterScheduler,
} from "@/features/boss-plans/data";
import {
  isCredentialScopedFailure,
  shouldAbortAutoSync,
} from "@/features/boss-plans/lib/scheduler-freshness";
import {
  describeSyncFailure,
  formatSyncFailure,
} from "@/features/boss-plans/lib/sync-failure-message";
import { queryKeys } from "@/lib/query-keys";
import type { TimetableRun } from "@/features/schedule/types";
import { cn } from "@/lib/utils";

import { isRunDone } from "../lib/timetable-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "방금 잡았는데 안 뜬다" 를 위한 버튼
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-24): *"10분정도로 하고 새로고침 버튼을 두는게 나을듯"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자동 동기화가 10분으로 당겨진 것과 **한 쌍의 결정**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 데이터는 늘 15분 늦는 것이 아니다 — 캐릭터가 **로그아웃하거나 캐시샵에 들어가면
 * 즉시 갱신된다**(발주자 확인, 2026-08-24). 보스를 다 돌면 대개 그중 하나를 하므로
 * 자동 동기화를 15분 → 10분으로 당겼다. 대신 로그아웃하지 않은 경우에는 그 10분짜리
 * 호출이 빈손으로 돌아온다. **그때 쓰라고 두는 문**이 이 버튼이다.
 *
 * ★ **서버 캐시를 건너뛴다**(`force: true`). 이게 없으면 버튼이 거짓말을 한다 — 게이트웨이가
 *   응답을 15분 캐시하고 그 읽기는 TTL 을 다시 보지 않으므로, 방금 자동 동기화가 돈 직후에
 *   누르면 **넥슨을 부르지도 않고 같은 옛 값**을 돌려준다. 우회는 사람이 누른 이 경로에만
 *   붙인다 — 자동 경로까지 우회하면 캐시가 존재할 이유가 없어지고 쿼터만 탄다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 대상은 **아직 안 잡은 런의 캐릭터**뿐이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 추적 캐릭터 전원을 도는 버튼이 아니다(그건 `/boss-status` 의 일이다 · §1.1.1). 이 화면이
 * 답하는 질문은 "내가 이번 주에 갈 곳"이고, 그중 **아직 클리어가 안 붙은 런**의 캐릭터만
 * 다시 묻는다. 다 잡았으면 부를 대상이 없어 버튼이 아예 그려지지 않는다.
 * 이번 주기에 그 보스를 먼저 깬 캐릭터도 뺀다(`isRunDone`) — 다시 불러도 이 일정에 붙을 것이 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **한 건의 실패가 나머지를 막지 않는다** (2026-11-02)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 첫 실패에서 루프가 끊겨, 키가 없는 부캐 하나가 맨 앞이면 나머지 캐릭터를 아예 안 불렀다.
 * 멈추는 기준은 자동 동기화와 **같은 함수**다(`shouldAbortAutoSync`): 점검 · 상류 장애처럼 다 같이
 * 실패할 원인이면 멈춘다. 그 관례의 "그 키만 건너뛴다" 는 이 화면에 키 정보가 없어 이렇게 옮겼다 —
 * 무효 키 · 접근 거부는 다음 캐릭터가 다른 계정일 수 있으니 계속하고, **한도 초과는 멈춘다.** 계속
 * 쏘면 쿨다운만 연장된다(§1.1).
 */

export interface TimetableRefreshButtonProps {
  readonly runs: readonly TimetableRun[];
  /**
   * 보고 있는 주가 **이번 주**인가. 아니면 그리지 않는다(아래 ★).
   *
   * 기본값을 두지 않는다 — 기본 `true` 로 두면 주 이동이 붙은 다음 새 호출부가 이 값을
   * 빼먹는 순간 가드가 조용히 사라진다. 빼먹으면 타입 오류가 나는 쪽이 맞다.
   */
  readonly isCurrentWeek: boolean;
  readonly className?: string;
}

export function TimetableRefreshButton({
  runs,
  isCurrentWeek,
  className,
}: TimetableRefreshButtonProps) {
  const queryClient = useQueryClient();

  /** 아직 안 잡은 런의 캐릭터. 중복은 접는다 — 한 캐릭터를 두 번 부를 이유가 없다. */
  const targets = [
    ...new Set(
      runs.flatMap((run) =>
        !isRunDone(run) && run.characterId !== null ? [run.characterId] : [],
      ),
    ),
  ];

  const refresh = useMutation({
    mutationFn: async () => {
      let ok = 0;
      let failed = 0;
      let firstFailure: unknown = null;
      for (const characterId of targets) {
        try {
          // 직렬 + 페이서. 동시에 쏘면 초당 5콜 한도에 걸려 그 키가 쿨다운에 들어간다.
          await paceNexonRequest(() =>
            syncCharacterScheduler({ characterId, force: true }),
          );
          ok += 1;
        } catch (error) {
          failed += 1;
          firstFailure ??= error;
          const kind = error instanceof BossPlanRequestError ? error.kind : null;
          if (
            shouldAbortAutoSync(kind) &&
            (!isCredentialScopedFailure(kind) || kind === "quota_exceeded")
          ) {
            break;
          }
        }
      }
      return {
        ok,
        failed,
        notReached: targets.length - ok - failed,
        // 첫 실패의 문구만 남긴다. 여러 개를 나열하면 읽히지 않는다(자동 동기화와 같다).
        failureMessage:
          firstFailure === null
            ? null
            : formatSyncFailure(describeSyncFailure(firstFailure)),
      };
    },
    onSuccess: () => {
      // §2.4 Rule 5 — 동기화는 클리어를 만든다. 세 화면이 함께 움직인다.
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.income.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.chores.root() });
    },
  });

  /*
    ★ **이번 주가 아니면 그리지 않는다** (2026-10-12, 주 이동이 붙으면서).

    이 버튼은 `force: true` 로 **서버 캐시까지 건너뛴다.** 지난 주를 보고 있을 때 그려
    두면 그 주의 "아직 클리어 안 붙은 런" 전부가 대상이 되어, 한 번 누르면
    **그 주에 등장하는 구별되는 캐릭터 수만큼** 넥슨 호출이 나간다(개발 키 1,000/일).
    그런데 그렇게 받아 오는 응답에는 **그 주의 클리어가 들어 있지 않다** — 넥슨
    스케줄러는 현재 상태만 주고 과거 주차 기록은 아예 없다(§1.1). 즉 비용만 있고 효과가
    0인 버튼이다. 다음 주도 마찬가지다(아직 돌지 않은 보스의 클리어는 존재하지 않는다).

    `disabled` + 설명 한 줄 대신 **숨기는** 쪽을 골랐다: 이 버튼은 원래도 부를 대상이
    없으면 사라지는 버튼이라(바로 아래 줄) "있다가 없어지는" 동작이 이미 이 화면의
    규칙이고, 설명을 남기면 다른 주를 볼 때마다 할 수 없는 일에 대한 안내가 격자 위
    한 줄을 계속 차지한다.
  */
  if (!isCurrentWeek) return null;

  // 부를 대상이 없으면 그리지 않는다. 눌러도 아무 일이 없는 버튼은 없느니만 못하다.
  if (targets.length === 0) return null;

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <Button
        size="sm"
        variant="secondary"
        disabled={refresh.isPending}
        onClick={() => {
          refresh.mutate();
        }}
      >
        <RefreshCw
          aria-hidden
          size={14}
          className={refresh.isPending ? "animate-spin" : undefined}
        />
        {refresh.isPending ? "확인 중" : "클리어 확인"}
      </Button>

      {/*
        결과를 한 줄로 말한다. 눌렀는데 아무 반응이 없으면 사람은 다시 누르고, 그게 곧
        쿼터다. 성공해도 **클리어가 늘었다는 뜻은 아니라서** 문구를 그렇게 적지 않는다 —
        아직 게임 쪽이 안 넘어왔을 수 있고, 그건 실패가 아니다.
      */}
      {refresh.isError ? (
        <span className="text-body-sm text-error">{refresh.error.message}</span>
      ) : refresh.data !== undefined && refresh.data.failureMessage !== null ? (
        /*
          ★ 몇 명이 됐고 몇 명이 안 됐는지를 먼저 말한다. 원인 문장만 두면 전부 실패한 줄 안다.
        */
        <span className="max-w-md text-right text-body-sm text-error">
          {`${String(refresh.data.ok)}명 확인 · ${String(refresh.data.failed)}명 실패${
            refresh.data.notReached > 0
              ? ` · ${String(refresh.data.notReached)}명은 부르지 않음`
              : ""
          } — ${refresh.data.failureMessage}`}
        </span>
      ) : refresh.isSuccess ? (
        <span className="flex items-center gap-1 text-caption text-ink-muted">
          <Check aria-hidden size={12} />
          최신 상태를 다시 받았습니다
        </span>
      ) : (
        <span className="text-caption text-ink-muted">
          캐릭터 {targets.length}명 다시 확인
        </span>
      )}
    </div>
  );
}
