"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import { syncCharacterScheduler } from "@/features/boss-plans/data";
import { queryKeys } from "@/lib/query-keys";
import type { TimetableRun } from "@/features/schedule/types";
import { cn } from "@/lib/utils";

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
 */

export interface TimetableRefreshButtonProps {
  readonly runs: readonly TimetableRun[];
  readonly className?: string;
}

export function TimetableRefreshButton({
  runs,
  className,
}: TimetableRefreshButtonProps) {
  const queryClient = useQueryClient();

  /** 아직 안 잡은 런의 캐릭터. 중복은 접는다 — 한 캐릭터를 두 번 부를 이유가 없다. */
  const targets = [
    ...new Set(
      runs.flatMap((run) =>
        run.clearedAt === null && run.characterId !== null
          ? [run.characterId]
          : [],
      ),
    ),
  ];

  const refresh = useMutation({
    mutationFn: async () => {
      let ok = 0;
      for (const characterId of targets) {
        // 직렬 + 페이서. 동시에 쏘면 초당 5콜 한도에 걸려 그 키가 쿨다운에 들어간다.
        await paceNexonRequest(() =>
          syncCharacterScheduler({ characterId, force: true }),
        );
        ok += 1;
      }
      return ok;
    },
    onSuccess: () => {
      // §2.4 Rule 5 — 동기화는 클리어를 만든다. 세 화면이 함께 움직인다.
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.income.root() });
    },
  });

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
        <span className="text-caption text-error">
          {refresh.error.message}
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
