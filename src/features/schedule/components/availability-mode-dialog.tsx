"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Repeat } from "lucide-react";

import {
  Button,
  Dialog,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { AvailabilityMode } from "@/types/domain";

import {
  fetchMyAvailabilityMode,
  saveMyAvailabilityMode,
} from "../data/schedule-queries";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 가능 시간 **방식 선택** — 둘 중 하나만 쓴다 (마이그레이션 36)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-09-03): *"요일별 / 교대 * 달력 둘중 하나만 쓰도록 하는거임. 막 겹쳐져서
 * 써지는게 아니고 가능시간 설정시 요일별 반복 or 교대 달력을 선택하는 모달이 먼저 나오고
 * 선택했을때 다른것들은 없어지게 설정."*
 *
 * 왜 필요했나: 두 방식이 **소리 없이 섞여** 계산되고 있었다. 실측(발주자 계정)으로 토요일
 * 요일 패턴 14:00~23:30 이 통째로 지워지고 달력의 15:00~24:00 이 대신 적용됐는데, 어느
 * 쪽이 이겼는지 화면 어디에도 없었다. 사용자가 자기 시간표를 설명할 수 없는 상태였다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 고르는 것은 **지우는 것이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 반대쪽 데이터는 DB 에 그대로 남고 되돌리면 살아난다. 이 사실을 화면이 말하지 않으면
 * 사람이 방식을 **시험해 보지 않는다** — "지워집니다" 로 읽히는 순간 두 방식 중 어느
 * 쪽이 자기에게 맞는지 영원히 확인하지 못한다. 그래서 보존 안내는 경고(주황)가 아니라
 * `ink-muted` 안심 문구다 (§4: 주황은 임박·주의 전용).
 *
 * ★ 이미 그 방식이고 직접 고른 적이 있으면 **PUT 을 보내지 않는다.** 아무것도 바뀌지
 *   않는 쓰기는 왕복과 무효화만 만들고, 그 무효화가 겹쳐보기 격자를 통째로 다시 그린다.
 */

interface ModeChoice {
  readonly id: AvailabilityMode;
  readonly label: string;
  readonly description: string;
  readonly icon: typeof Repeat;
}

const CHOICES: readonly ModeChoice[] = [
  {
    id: "weekly",
    label: "요일별 반복",
    description:
      "매주 같은 요일·같은 시간에 논다. 한 번 칠하면 계속 적용됩니다.",
    icon: Repeat,
  },
  {
    id: "shift",
    label: "교대 · 달력",
    description:
      "근무가 N일 주기로 돌거나, 달마다 근무표가 따로 나온다. 주기 격자와 날짜별 지정을 함께 씁니다.",
    icon: CalendarClock,
  },
];

export interface AvailabilityModeDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * 방식이 확정됐다 — 부모가 이 창을 닫고 **그 방식의 편집기**를 연다.
   * 저장이 끝난 뒤에만 불린다(저장 실패 시에는 창이 그대로 남아 오류를 보여 준다).
   */
  readonly onPick: (mode: AvailabilityMode) => void;
}

export function AvailabilityModeDialog({
  open,
  onClose,
  onPick,
}: AvailabilityModeDialogProps) {
  const queryClient = useQueryClient();

  const modeQuery = useQuery({
    queryKey: queryKeys.db.availability.myMode(),
    queryFn: fetchMyAvailabilityMode,
    staleTime: 60_000,
    enabled: open,
  });

  const pickMode = useMutation({
    mutationFn: (mode: AvailabilityMode) => saveMyAvailabilityMode(mode),
    onSuccess: async (state) => {
      /*
        무효화는 `availability.root()` 하나다. 방식이 바뀌면 겹쳐보기(`resolve`)·겹침
        질의(`overlap`)·방식 자체가 **동시에** 다른 답을 내므로, 하나만 날리면 화면
        절반이 옛 답을 들고 남는다 (§2.4 규칙 5 · 확인된 접두사).
      */
      await queryClient.invalidateQueries({
        queryKey: queryKeys.db.availability.root(),
      });
      onPick(state.mode);
    },
  });

  const state = modeQuery.data ?? null;
  const pending = pickMode.isPending;
  /** 실패한 저장을 다시 보낼 대상. 성공/실패와 무관하게 마지막 `mutate` 인자가 남는다. */
  const retryTarget = pickMode.variables;

  const handlePick = (mode: AvailabilityMode) => {
    if (state !== null && state.chosen && state.mode === mode) {
      // 바뀌는 것이 없다 — 쓰지 않고 바로 편집기로 보낸다.
      onPick(mode);
      return;
    }
    pickMode.mutate(mode);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="가능 시간을 어떻게 적을까요?"
      description="둘 중 하나만 쓰입니다. 고르지 않은 쪽은 계산에 들어가지 않습니다."
      footer={
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={pending}
          >
            닫기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {modeQuery.isError ? (
          <ErrorState
            title="지금 쓰는 방식을 불러오지 못했습니다"
            description="어느 쪽이 적용 중인지 모르는 채로 고르면 반대쪽을 덮어쓸 수 있어 선택을 막았습니다."
            onRetry={() => void modeQuery.refetch()}
            className="py-6"
          />
        ) : modeQuery.isLoading ? (
          <SkeletonGroup label="지금 쓰는 방식을 불러오는 중">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </SkeletonGroup>
        ) : (
          <>
            {state !== null && !state.chosen ? (
              /*
                `chosen === false` 는 "행이 없다"는 뜻이고, 해석기는 그때 weekly 로 본다.
                동작은 weekly 지만 **고른 적은 없다** — 그 구분을 지우면 사용자는 자기가
                이미 골랐다고 착각하고 다른 쪽을 시험해 보지 않는다.
              */
              <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink-muted">
                아직 고르지 않아{" "}
                <strong className="font-semibold text-ink">요일별 반복</strong>
                으로 동작 중입니다.
              </p>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              {CHOICES.map((choice) => {
                const active = state !== null && state.mode === choice.id;
                const Icon = choice.icon;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handlePick(choice.id)}
                    disabled={pending}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left transition duration-200",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      /*
                        지금 쓰는 방식은 primary 테두리 + 체크로 **두 번** 말한다. 테두리
                        하나만으로는 색각 이상이나 저대비 화면에서 구분되지 않는다.
                      */
                      active
                        ? "border-primary bg-primary-subtle"
                        : "border-border bg-surface hover:bg-hover-surface",
                      pending && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon
                        aria-hidden
                        size={18}
                        className={active ? "text-primary" : "text-ink-muted"}
                      />
                      <span className="text-body-sm font-semibold text-ink">
                        {choice.label}
                      </span>
                      {pending && pickMode.variables === choice.id ? (
                        <span className="ml-auto text-body-sm font-semibold text-primary">
                          바꾸는 중…
                        </span>
                      ) : active ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-body-sm font-semibold text-primary">
                          <Check aria-hidden size={14} />
                          사용 중
                        </span>
                      ) : null}
                    </span>
                    <span className="text-body-sm text-ink-muted">
                      {choice.description}
                    </span>
                  </button>
                );
              })}
            </div>

            {/*
              ★ 안심 문구다. 경고가 아니므로 주황(`chip-soon`)을 쓰지 않는다 —
                주황을 쓰면 "바꾸면 뭔가 잃는다" 로 읽혀 목적과 정반대가 된다.
            */}
            <p className="text-body-sm text-ink-muted">
              방식을 바꿔도 반대쪽에 등록한 시간은 지워지지 않습니다. 되돌리면
              그대로 다시 쓰입니다.
            </p>

            <p aria-live="polite" className="sr-only">
              {pending ? "방식을 바꾸는 중입니다." : ""}
            </p>

            {pickMode.isError ? (
              /*
                ★ 재시도가 **있어야** 한다. 위 `modeQuery` 쪽 오류에는 재시도가 있는데
                  여기만 없으면, 저장이 한 번 실패한 사람은 같은 카드를 다시 정확히
                  찾아 누르는 수밖에 없다 — 실패한 동작을 되풀이하는 길은 화면이
                  제공해야 한다. 다시 보낼 대상은 **마지막에 고르려던 그 방식**이며,
                  `variables` 가 그 값을 실패 후에도 그대로 들고 있다(TanStack v5).
              */
              <ErrorState
                title="방식을 바꾸지 못했습니다"
                description="등록해 둔 시간은 그대로입니다. 다시 시도해 주세요."
                detail={pickMode.error.message}
                onRetry={
                  retryTarget === undefined
                    ? undefined
                    : () => pickMode.mutate(retryTarget)
                }
                className="py-6"
              />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
