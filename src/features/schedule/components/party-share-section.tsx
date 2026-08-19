"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Scale } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { SeatNumber } from "@/components/domain";
import { Button, ErrorState, Input, Skeleton } from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { PartyId } from "@/types/domain";

import { fetchPartyShares, resetPartyShares, savePartyShares } from "../data";
import { RUN_SHARE_WEIGHT_SCALE, type PartySharesPayload } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 분배 배율 — **파티 설정 안에 산다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"분배조율도 파티 설정에 있어야된다고 했잖슴"* · 앞선 지시:
 * *"파티 설정할때 분배 배율 설정하는 칸도 있어야함. 단순히 2인이면 1:1 이 아니라 스펙에
 * 차이나는 사람끼리 1:2 분배 하는경우도있음"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 일정 카드에서 옮겨 왔나
 * ─────────────────────────────────────────────────────────────────────────────
 * 저장 위치는 **원래부터 파티**였다(`parties.share_mode` + `party_participants.share_bp`,
 * 마이그레이션 `20260819200000`). 그런데 편집 입구가 일정 카드의 `분배` 버튼이라, 화면은
 * "이 보스의 분배"처럼 보이는데 실제로는 **파티 전체가 바뀌는** 상태였다. 보이는 것과
 * 저장되는 것이 다른 화면은 언젠가 반드시 사고를 낸다. 그래서 입구를 파티로 옮겼다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면은 나눗셈을 하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 가중치 → 만분율(`1 : 2` → `3333 : 6667`)도, 잔돈 배분도 전부 DB `distribute_meso()`
 * 한 구현이 한다. 화면이 다시 나누면 웹과 카톡 봇의 답이 갈라진다 — 이미 두 번 있었던
 * 사고다. 여기서 하는 일은 **사용자가 친 가중치를 그대로 보내는 것**뿐이다.
 *
 * ⚠️ 번호(`seat_no`)로 사람을 가리킨다(§1.4). 카톡에서 `1번` 이 이미 오가므로 이 화면도
 *    같은 번호로 말해야 하고, 번호는 재부여하지 않으므로 연속이 아닐 수 있다.
 * ⚠️ 저장은 **이번 주 정산부터** 반영된다. 지난 주 원장을 오늘의 합의로 다시 쓰는 것은
 *    소급 변경이고, 스냅샷을 찍는 이유(R3)와 정면으로 어긋난다.
 */

/** 화면에서 받을 수 있는 가중치의 상한. 서버 상한을 배율로 나눈 값이다. */
const WEIGHT_INPUT_MAX = 10_000;

/** 만분율 → 입력칸 문자열. `3333` → `"33.33"`, `5000` → `"50"`. */
function weightTextFromBp(shareBp: number): string {
  return String(shareBp / RUN_SHARE_WEIGHT_SCALE);
}

/**
 * 입력 문자열 → 서버로 보낼 정수 가중치(이미 100 이 곱해진 값).
 *
 * `null` 은 **입력이 유효하지 않다**는 뜻이다. 0 과 다르다 — 0 은 "이 사람 몫이 없다"는
 * 확정된 입력이고, `null` 은 아직 숫자가 아니다.
 */
function parseWeight(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > WEIGHT_INPUT_MAX) {
    return null;
  }
  // `33.33 * 100` 은 부동소수점에서 3332.9999… 다. 반올림해 정수로 못박는다.
  return Math.round(value * RUN_SHARE_WEIGHT_SCALE);
}

/**
 * 서버 상태 → 입력칸 초깃값.
 *
 * `auto_equal` 이면 저장된 만분율(3334/3333/3333)이 아니라 **전부 1** 로 시작한다.
 * 균등은 사람에게 `1 : 1 : 1` 로 읽히는 것이 맞고, 잔돈(3334)이 입력칸에 노출되면
 * "왜 나만 33.34 냐"는 질문이 생긴다.
 */
function baselineWeights(payload: PartySharesPayload): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const participant of payload.participants) {
    seed[participant.participantId] =
      payload.shareMode === "auto_equal"
        ? "1"
        : weightTextFromBp(participant.shareBp ?? 0);
  }
  return seed;
}

/**
 * 오류 한 줄.
 *
 * 색은 배경과 아이콘이 지고 **문장은 잉크**가 진다 — 경고 주황과 같은 규약이다(§4).
 * `text-ink` on `chip-failed-bg` = 라이트 16.20:1 / 다크 14.69:1.
 */
function ShareErrorNotice({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-chip-failed-border bg-chip-failed-bg px-3 py-2 text-body-sm text-ink"
    >
      <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-error" />
      <span>{children}</span>
    </p>
  );
}

export interface PartyShareSectionProps {
  readonly partyId: PartyId;
  readonly className?: string;
}

export function PartyShareSection({
  partyId,
  className,
}: PartyShareSectionProps) {
  const queryClient = useQueryClient();
  const headingId = useId();

  const sharesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.shares(partyId)),
    queryFn: () => fetchPartyShares(partyId),
  });

  /** 편집 중인 값. `null` 이면 아직 손대지 않았다는 뜻이라 서버 값이 그대로 보인다. */
  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  const payload = sharesQuery.data;
  const baseline = payload === undefined ? {} : baselineWeights(payload);
  const weights = draft ?? baseline;

  /*
    ★ 무효화 키 (§2.4 Rule 5) — 한 번의 비율 변경이 움직이는 것 전부:
      · `db.party.shares(partyId)`  이 패널 자신
      · `db.runs.root()`            일정 목록의 "내 예상 몫"
      · `db.income.root()`          수익 화면 (이번 주 정산이 다시 계산된다)
      · `db.dashboard.root()`       대시보드 결정석 요약
  */
  const invalidateKeys = [
    queryKeys.db.party.shares(partyId),
    queryKeys.db.runs.root(),
    queryKeys.db.income.root(),
    queryKeys.db.dashboard.root(),
  ];

  function applyPayload(next: PartySharesPayload): void {
    // 서버가 돌려준 확정 상태를 그대로 캐시에 넣는다. 조립하지 않는다.
    queryClient.setQueryData(queryKeys.db.party.shares(partyId), next);
    for (const key of invalidateKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
    setDraft(null);
  }

  /*
    ⚠️ **낙관적 업데이트를 쓰지 않는다.** 비율을 바꾸면 이번 주 모든 일정의 수령액이 다시
       계산되는데(`recompute_run_crystal_shares`) 그 금액은 DB 가 낸다. 화면이 미리
       그려 보려면 1/n 을 여기서 다시 적어야 하고, 그게 두 번 고친 사고 그 자체다.
  */
  const save = useMutation({
    mutationFn: (input: readonly { participantId: string; weight: number }[]) =>
      savePartyShares(partyId, input),
    onSuccess: applyPayload,
  });

  const resetToEqual = useMutation({
    mutationFn: () => resetPartyShares(partyId),
    onSuccess: applyPayload,
  });

  const isPending = save.isPending || resetToEqual.isPending;
  const mutationError = save.error ?? resetToEqual.error;

  const parsed =
    payload === undefined
      ? []
      : payload.participants.map((participant) => ({
          participantId: participant.participantId,
          weight: parseWeight(weights[participant.participantId] ?? ""),
        }));
  const hasInvalid = parsed.some((entry) => entry.weight === null);
  const total = parsed.reduce((sum, entry) => sum + (entry.weight ?? 0), 0);
  const isDirty =
    payload !== undefined &&
    payload.participants.some(
      (participant) =>
        (weights[participant.participantId] ?? "") !==
        (baseline[participant.participantId] ?? ""),
    );

  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-2", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={headingId}
          className="flex items-center gap-1.5 text-body-sm font-semibold text-ink"
        >
          <Scale aria-hidden size={16} className="text-primary" />
          분배 배율
        </h3>
        {payload === undefined ? null : (
          <span className="text-caption text-ink-muted">
            {payload.shareMode === "manual" ? "사용자 지정" : "균등 (1/n)"}
          </span>
        )}
      </div>

      <p className="text-body-sm text-ink-muted">
        스펙 차이가 나는 사람끼리 <strong className="font-semibold text-ink">1 : 2</strong>{" "}
        처럼 나눌 때 씁니다. 비율은 이 파티의{" "}
        <strong className="font-semibold text-ink">결정석과 드랍 정산 양쪽</strong>에 함께
        적용되고, <strong className="font-semibold text-ink">이번 주 정산부터</strong>{" "}
        반영됩니다 — 지난 주 기록은 그대로 둡니다.
      </p>

      {sharesQuery.isError ? (
        <ErrorState
          title="분배 배율을 불러오지 못했습니다"
          detail={sharesQuery.error.message}
          onRetry={() => void sharesQuery.refetch()}
          className="py-4"
        />
      ) : payload === undefined ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-control-md" />
          ))}
        </div>
      ) : payload.participants.length === 0 ? (
        <p className="text-body-sm text-ink-label">
          구성원이 없습니다. 위에서 사람을 추가하면 비율을 정할 수 있습니다.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {payload.participants.map((participant) => {
              const text = weights[participant.participantId] ?? "";
              const invalid = parseWeight(text) === null;
              return (
                <li
                  key={participant.participantId}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  {/* §1.4 — 저장된 번호 그대로. 빠진 번호는 빈 채로 둔다. */}
                  <SeatNumber seatNo={participant.seatNo} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                    {participant.displayName}
                  </span>
                  <label
                    className="sr-only"
                    htmlFor={`party-share-${participant.participantId}`}
                  >
                    {participant.displayName} 분배 가중치
                  </label>
                  <Input
                    id={`party-share-${participant.participantId}`}
                    className="h-control-sm w-20 text-right"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={WEIGHT_INPUT_MAX}
                    step={0.01}
                    value={text}
                    disabled={isPending}
                    invalid={invalid}
                    onChange={(event) =>
                      setDraft({
                        ...weights,
                        [participant.participantId]: event.target.value,
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>

          {hasInvalid ? (
            <ShareErrorNotice>
              숫자로 된 가중치를 넣어 주세요. 0 이상 {WEIGHT_INPUT_MAX} 이하까지
              됩니다.
            </ShareErrorNotice>
          ) : total <= 0 ? (
            <ShareErrorNotice>
              합이 0 입니다. 최소 한 명은 0보다 큰 값을 가져야 합니다.
            </ShareErrorNotice>
          ) : null}

          {mutationError === null ? null : (
            <ShareErrorNotice>{mutationError.message}</ShareErrorNotice>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending || payload.shareMode === "auto_equal"}
              onClick={() => resetToEqual.mutate()}
            >
              균등으로
            </Button>
            <Button
              size="sm"
              disabled={isPending || hasInvalid || total <= 0 || !isDirty}
              onClick={() =>
                save.mutate(
                  parsed.map((entry) => ({
                    participantId: entry.participantId,
                    weight: entry.weight ?? 0,
                  })),
                )
              }
            >
              {save.isPending ? "저장 중…" : "배율 저장"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
