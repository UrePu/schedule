"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, Scale, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { MesoAmount, Numeric, SeatNumber } from "@/components/domain";
import {
  Button,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { ScheduledRun } from "@/types/domain";

import { fetchRunShares, resetRunShares, saveRunShares } from "../data";
import {
  RUN_SHARE_WEIGHT_SCALE,
  type RunSharesPayload,
  type RunShareWeightInput,
} from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 분배 배율 편집 — 일정 카드 안에서 펼쳐지는 패널
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-19): *"파티 설정할때 분배 배율 설정하는 칸도 있어야함. 단순히 2인이면
 * 1:1 이 아니라 스펙에 차이나는 사람끼리 1:2 분배 하는경우도있음"*
 *
 * ── 왜 **파티 설정**이 아니라 일정(run) 카드에 붙는가 ────────────────────────
 * 지시는 "파티 설정"이라고 말하지만, 결정석 pot 은 그 보스에 **실제로 같이 들어간
 * 사람들**이 나눈다. 6인 파티에서 4명만 간 런이면 그 4명 사이에서 합이 100% 여야 하므로
 * 파티 단위로는 애초에 표현할 수 없고, 스키마도 그래서 `run_signups.share_bp` 다
 * (마이그레이션 `20260817091000_payout_shares_and_drops.sql` 10-2 주석).
 * 게다가 "이번 카룡만 버스라 1:2" 같은 실제 운영은 런마다 다르다 — 파티에 한 벌만 두면
 * 그 운영이 불가능해진다. 그래서 **수정 / 삭제와 나란한 셋째 패널**로 붙인다.
 *
 * ── 왜 **가중치**로 입력받는가 (퍼센트가 아니라) ────────────────────────────
 * 사용자가 아는 것은 "쟤랑 나랑 1 : 2" 이지 "33.33% : 66.67%" 가 아니다. 퍼센트를 직접
 * 받으면 합 100 을 **사람이 맞춰야** 하고, 3인·6인처럼 나누어떨어지지 않는 비율은 손으로
 * 맞출 수 없다(33+33+34 를 매번 고민하게 된다). 가중치는 합계 제약이 아예 없다.
 *
 * ── 잔돈은 **DB 가 나눈다.** 이 파일에서 반올림하지 않는다 ──────────────────
 * 가중치 → `share_bp`(만분율) 환산도, pot → 개인 수령액도 전부
 * `public.distribute_meso()`(최대잉여법) 한 구현이 한다. 웹·카톡 봇(`!결정석`)·주간 집계
 * 뷰가 **같은 답**을 내야 하기 때문이고, 화면이 1/n 을 다시 적었다가 실제 약정과 다른
 * 금액을 말한 사고가 이 저장소에서 이미 두 번 있었다.
 * → 그래서 **저장하기 전에는 금액을 지어내지 않는다.** 입력을 건드린 순간 금액 칸은
 *   "저장 후 계산"이 되고, 저장 응답이 오면 서버가 낸 값이 그대로 들어온다.
 *   퍼센트도 마찬가지다 — 저장된 상태에서는 서버의 `share_bp` 를 보이고, 편집 중에만
 *   **미리보기**임을 밝힌 채 화면이 계산한 비율을 보인다.
 *
 * ── 번호(`seat_no` = `party_participants.member_no`)로 사람을 가리킨다 ──────
 * §1.4 — 번호는 재부여하지 않으므로 연속이 아닐 수 있고 그게 정상이다. 카톡에서
 * `!분배 1번 33` 이 이미 오가므로 이 화면도 **같은 번호**로 말해야 한다.
 */

/** 화면에서 받을 수 있는 가중치의 상한. 서버 상한(`RUN_SHARE_WEIGHT_MAX`)을 배율로 나눈 값. */
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
 * `auto_equal` 이면 저장된 `share_bp`(3334/3333/3333)를 그대로 보이는 대신 **전부 1** 로
 * 시작한다. 균등은 사용자에게 `1 : 1 : 1` 로 읽히는 것이 맞고, 만분율 잔돈(3334)이
 * 입력칸에 노출되면 "왜 나만 33.34 냐"는 질문이 생긴다. 실제 분배도 이 모드에서는
 * 가중치 1(= 정확한 1/n)로 이뤄진다(뷰 `v_run_share_weights`).
 */
function baselineWeights(payload: RunSharesPayload): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const participant of payload.participants) {
    if (participant.status !== "going") continue;
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
 * ⚠️ `HelperText tone="error"` 를 쓰지 않는다. 예전에는 그 컴포넌트의 `text-error` 가
 *    **라이트에서 3.61:1**(`#ef4444` on `#fafafa`)로 AA(4.5:1) 미달이었기 때문이다.
 *    2026-08-19 대비 감사에서 라이트 `error` 를 `#d72a30` 으로 내려 **4.72:1** 이 됐으므로
 *    이제 대비 때문에 피할 이유는 없다. 그래도 여기는 틴트 블록을 유지한다 —
 *    이 오류는 입력칸 밑 한 줄이 아니라 **패널 전체의 상태**를 말하고, 같은 정보를
 *    다른 화면(`ErrorState`·토스트)도 틴트 블록으로 그리기 때문이다.
 *    → 경고 주황과 **같은 규약**을 적용한다: 색은 배경과 아이콘이 지고 **문장은 잉크**가
 *      진다. `text-ink` on `chip-failed-bg` = 라이트 16.20:1 / 다크 14.69:1.
 *    공유 컴포넌트(`ui/input.tsx`) 수정은 이 작업의 소유 범위 밖이라 여기서 감싼다.
 */
function ShareErrorNotice({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-chip-failed-border bg-chip-failed-bg px-3 py-2 text-body-sm text-ink"
    >
      <CircleAlert
        aria-hidden
        size={16}
        className="mt-0.5 shrink-0 text-error"
      />
      <span>{children}</span>
    </p>
  );
}

export interface RunShareEditorProps {
  /** 편집 대상 일정. 카드가 이미 들고 있는 값이라 추가 왕복이 없다. */
  readonly run: ScheduledRun;
  readonly onClose: () => void;
}

export function RunShareEditor({ run, onClose }: RunShareEditorProps) {
  const queryClient = useQueryClient();
  const headingId = useId();

  const sharesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.runs.detail(run.runId)),
    queryFn: () => fetchRunShares(run.runId),
  });

  /**
   * 입력 초안. `null` = **아직 손대지 않았다** → 서버 값에서 파생한다.
   *
   * effect 로 서버 값을 초안에 복사하지 않는 이유: 저장 응답이 도착할 때마다 사용자가
   * 방금 친 값을 덮어써 커서가 튄다. 초안을 `null` 로 되돌리기만 하면 파생이 다시 서버
   * 값을 따라가므로 동기화 코드가 필요 없다.
   */
  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  const data = sharesQuery.data ?? null;
  const baseline = useMemo(
    () => (data === null ? {} : baselineWeights(data)),
    [data],
  );
  const weights = draft ?? baseline;

  const goingParticipants = useMemo(
    () => (data?.participants ?? []).filter((p) => p.status === "going"),
    [data],
  );

  /** 화면이 계산한 것은 **비율뿐**이다. 금액은 한 줄도 계산하지 않는다. */
  const parsed = useMemo(() => {
    const byParticipant = new Map<string, number | null>();
    let sum = 0;
    let hasInvalid = false;
    for (const participant of goingParticipants) {
      const value = parseWeight(weights[participant.participantId] ?? "");
      byParticipant.set(participant.participantId, value);
      if (value === null) hasInvalid = true;
      else sum += value;
    }
    return { byParticipant, sum, hasInvalid };
  }, [goingParticipants, weights]);

  /**
   * 편집 중인가. 초안이 서버 기준선과 한 글자라도 다르면 **금액을 말하지 않는다** —
   * 저장 전 금액은 DB 가 아직 나눠 주지 않은 값이라, 화면이 채우면 그게 곧 두 번째 구현이다.
   */
  const isDirty =
    draft !== null &&
    goingParticipants.some(
      (participant) =>
        (draft[participant.participantId] ?? "") !==
        (baseline[participant.participantId] ?? ""),
    );

  // ───────────────────────────────────────────────────────────────────────────
  // 뮤테이션 — 낙관적 반영 (발주자 요구: "먼저 믿고 선반영 후")
  //
  // ⚠️ 낙관적으로 반영하는 것은 **모드와 "계산 중" 상태뿐**이다. `shareBp` · `amountMeso`
  //    는 `null` 로 비운다 — 금액은 DB(`distribute_meso`)가 내는 값이고, 화면이 예측값을
  //    채우면 웹과 카톡 봇의 답이 갈라진다(`@/lib/query/optimistic` 금지 목록 4번).
  //    그래서 타입이 `isEstimating` 을 들고 있다: "아직 서버 값이 아니다"를 화면이 알 수
  //    있어야 "계산 중"과 "0 메소"를 구분해 그린다.
  //
  // ★ 무효화 키 (§2.4 Rule 5) — 한 번의 비율 변경이 움직이는 것 전부:
  //    · `db.runs.detail(runId)`            이 패널 자신
  //    · `db.runs.list(partyId, weekKey)`   일정 목록의 "내 예상 몫"
  //    · `db.income.root()`                 수익 화면 (recompute_run_crystal_shares)
  //    · `db.dashboard.root()`              대시보드 결정석 수익 요약
  //   (`db.runs.participation` 은 참가 여부만 담고 비율과 무관해 넣지 않는다.)
  // ───────────────────────────────────────────────────────────────────────────
  const invalidateKeys = () => [
    queryKeys.db.runs.detail(run.runId),
    queryKeys.db.runs.list(run.partyId, run.weekKey),
    queryKeys.db.income.root(),
    queryKeys.db.dashboard.root(),
  ];

  function estimatingPatch(shareMode: RunSharesPayload["shareMode"]) {
    return cachePatch<RunSharesPayload>(
      queryKeys.db.runs.detail(run.runId),
      (current) => ({
        ...current,
        shareMode,
        isEstimating: true,
        participants: current.participants.map((participant) =>
          participant.status === "going"
            ? { ...participant, shareBp: null, amountMeso: null }
            : participant,
        ),
      }),
    );
  }

  const save = useOptimisticMutation({
    mutationFn: (input: readonly RunShareWeightInput[]) =>
      saveRunShares(run.runId, input),
    optimistic: () => [estimatingPatch("manual")],
    invalidate: invalidateKeys,
    rollbackTitle: "분배 배율을 저장하지 못했습니다",
    rollbackDescription: () =>
      `${run.runNo}번 · ${run.bossKoreanName} 의 분배 배율을 되돌렸습니다.`,
    onSuccess: (payload) => {
      // 서버가 돌려준 확정 상태를 그대로 캐시에 넣는다. 조립하지 않는다.
      queryClient.setQueryData(queryKeys.db.runs.detail(run.runId), payload);
      setDraft(null);
    },
  });

  const resetToEqual = useOptimisticMutation({
    mutationFn: () => resetRunShares(run.runId),
    optimistic: () => [estimatingPatch("auto_equal")],
    invalidate: invalidateKeys,
    rollbackTitle: "균등으로 되돌리지 못했습니다",
    rollbackDescription: () =>
      `${run.runNo}번 · ${run.bossKoreanName} 의 분배 배율을 그대로 두었습니다.`,
    onSuccess: (payload) => {
      queryClient.setQueryData(queryKeys.db.runs.detail(run.runId), payload);
      setDraft(null);
    },
  });

  const isPending = save.isPending || resetToEqual.isPending;
  const mutationError = save.error ?? resetToEqual.error;
  /** 낙관적으로 비워 둔 값이 아직 서버 값으로 안 돌아온 상태. */
  const isEstimating = data?.isEstimating === true;

  const canSubmit =
    data !== null &&
    goingParticipants.length > 0 &&
    !parsed.hasInvalid &&
    parsed.sum > 0 &&
    !isPending;

  function handleSubmit() {
    if (!canSubmit) return;
    const payload: RunShareWeightInput[] = [];
    for (const participant of goingParticipants) {
      const value = parsed.byParticipant.get(participant.participantId);
      if (value === null || value === undefined) return;
      payload.push({ participantId: participant.participantId, weight: value });
    }
    save.mutate(payload);
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border bg-background p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          id={headingId}
          className="flex items-center gap-2 text-body-sm font-semibold text-ink"
        >
          <Scale aria-hidden size={16} className="shrink-0 text-primary" />
          {run.runNo}번 · {run.bossKoreanName} 분배 배율
        </p>
        {data === null ? null : (
          <span className="text-caption text-ink-label">
            {data.shareMode === "manual" ? "사용자 지정" : "균등 (1/n)"}
          </span>
        )}
      </div>

      {sharesQuery.isError ? (
        <ErrorState
          title="분배 배율을 불러오지 못했습니다"
          detail={sharesQuery.error.message}
          onRetry={() => void sharesQuery.refetch()}
          className="py-6"
        />
      ) : sharesQuery.isPending ? (
        <SkeletonGroup label="분배 배율을 불러오는 중">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10" />
          ))}
        </SkeletonGroup>
      ) : data === null ? null : goingParticipants.length === 0 ? (
        <EmptyState
          title="참가 확정한 사람이 없습니다"
          description="분배는 실제로 같이 들어간 사람들 사이에서 나눕니다. 먼저 참가 신청을 받아 주세요."
        />
      ) : (
        <>
          {/* 열 제목 — 좁은 화면에서는 각 입력칸의 라벨이 대신한다(아래 sr-only). */}
          <div className="hidden items-center gap-3 px-2 sm:flex">
            <span className="min-w-0 flex-1 text-caption text-ink-label">
              참가자
            </span>
            <span className="w-20 text-right text-caption text-ink-label">
              가중치
            </span>
            <span className="w-16 text-right text-caption text-ink-label">
              비율
            </span>
            <span className="w-28 text-right text-caption text-ink-label">
              수령 메소
            </span>
          </div>

          <ul className="flex flex-col gap-2">
            {data.participants.map((participant) => {
              const going = participant.status === "going";
              const weightText = weights[participant.participantId] ?? "";
              /*
                `going` 이 아닌 사람은 `parsed` 에 아예 없다(입력 대상이 아니다).
                `undefined`(대상 아님)와 `null`(유효하지 않은 입력)을 여기서 합친다 —
                아래 표시 분기는 `going` 을 이미 검사하므로 둘의 차이가 남지 않는다.
              */
              const weightValue =
                parsed.byParticipant.get(participant.participantId) ?? null;
              const invalid = going && weightValue === null;

              /*
                비율 표시 — **저장된 상태에서는 서버의 `share_bp` 를 그대로** 보인다.
                편집 중에는 화면이 계산한 미리보기이며(합이 99.99% 로 보일 수 있다),
                실제 잔돈은 저장 시 DB 의 최대잉여법이 배분한다.
              */
              const previewPercent =
                going && weightValue !== null && parsed.sum > 0
                  ? (weightValue / parsed.sum) * 100
                  : null;
              const settledPercent =
                going && participant.shareBp !== null
                  ? participant.shareBp / 100
                  : null;
              const showPreview = isDirty || isEstimating;
              const percent = showPreview ? previewPercent : settledPercent;

              return (
                <li
                  key={participant.signupId}
                  className={cn(
                    "flex flex-col gap-2 rounded-md border border-border bg-surface p-2",
                    "sm:flex-row sm:items-center sm:gap-3",
                    !going && "opacity-80",
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {/*
                      §1.4 — 저장된 번호 그대로. 빠진 번호는 빈 채로 둔다.
                      ⚠️ 불참자에게도 `tone="muted"` 를 쓰지 않는다. 예전에는 그 톤이
                         `ink-muted` on `neutral-100` = **라이트 4.40:1** 로 AA 미달이었다.
                         2026-08-19 재산정으로 5.37:1 이 되어 대비 문제는 사라졌지만,
                         불참이라는 사실은 옆 배지가 **문장으로** 말하므로 색을 흐릴 이유가
                         여전히 없다.
                    */}
                    <SeatNumber seatNo={participant.seatNo} size="sm" />
                    <span className="truncate text-body-sm text-ink">
                      {participant.displayName}
                    </span>
                    {participant.characterName === null ? null : (
                      <span className="truncate text-caption text-ink-muted">
                        {participant.characterName}
                      </span>
                    )}
                    {going ? null : (
                      /*
                        `going` 이 아닌 사람도 **지운 자리 없이 그대로 보인다.** 입력칸만
                        잠근다 — DB CHECK `run_signups_non_going_has_no_share` 가
                        `share_bp = 0` 을 강제하므로 값을 받아 봐야 저장될 수 없다.
                        목록에서 아예 빼지 않는 이유: 번호가 연속이 아닌 이유(§1.4)와
                        "저 사람 몫은 왜 없냐"를 화면이 스스로 설명해야 하기 때문이다.
                      */
                      <span className="shrink-0 rounded-md border border-border bg-neutral-100 px-1.5 py-0.5 text-caption text-ink-label">
                        {participant.status === "declined" ? "불참" : "미정"} ·
                        분배 대상 아님
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
                    <label
                      className="sr-only"
                      htmlFor={`share-w-${participant.signupId}`}
                    >
                      {participant.displayName} 분배 가중치
                    </label>
                    <Input
                      id={`share-w-${participant.signupId}`}
                      className="h-control-sm w-20 text-right"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={WEIGHT_INPUT_MAX}
                      step={0.01}
                      value={going ? weightText : "0"}
                      disabled={!going || isPending}
                      invalid={invalid}
                      onChange={(event) =>
                        setDraft({
                          ...weights,
                          [participant.participantId]: event.target.value,
                        })
                      }
                    />
                    <span
                      className={cn(
                        "w-16 text-right text-body-sm",
                        showPreview ? "text-ink-muted" : "text-ink",
                      )}
                    >
                      {percent === null ? (
                        "—"
                      ) : (
                        <Numeric>{`${percent.toFixed(2)}%`}</Numeric>
                      )}
                    </span>
                    <span className="w-28 text-right">
                      {!going ? (
                        <span className="text-body-sm text-ink-muted">—</span>
                      ) : showPreview ? (
                        /*
                          ★ 여기서 금액을 지어내지 않는다. 저장 응답이 오면 서버가 나눈
                            값이 그대로 들어온다.
                        */
                        <span className="text-body-sm text-ink-muted">
                          저장 후 계산
                        </span>
                      ) : (
                        <MesoAmount
                          value={participant.amountMeso}
                          compact
                          suffix={false}
                          className="text-body-sm font-semibold"
                        />
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2">
            <span className="text-caption text-ink-label">
              파티 총 수령액 (게임이 정한 pot)
            </span>
            {/*
              ⚠️ 다른 화면의 메소 강조는 `tone="accent"`(= `text-secondary`)지만 여기서는
                 쓰지 않는다. 예전 `#06b6d4` on `#fafafa` 는 **라이트 2.33:1** 로 AA 한참
                 미달이었고, 2026-08-19 대비 감사에서 라이트 `secondary` 를 `#106b7d` 로
                 내려 **5.88:1** 로 고쳤다(§4 를 어긴 것은 톤이 아니라 색값이었다).
                 그래도 여기서는 계속 쓰지 않는다 — 같은 패널 안의 개인 수령액이 이미
                 `ink` 라 굵기만으로 충분히 구분되고, 강조가 둘이면 위계가 무너진다.
                 ★ 이 실패는 `MesoAmount` 의 `accent` 톤 자체에 있으므로 저장소 전역
                   (13곳)에 그대로 있다 — 공유 컴포넌트 수정은 이 작업 소유 범위 밖이라
                   보고로 올린다.
            */}
            <MesoAmount
              value={data.potMeso}
              compact
              className="text-body-sm font-semibold"
            />
          </div>

          {data.potMeso === null ? (
            /* §1.3 D4 — 가격 미확인은 **0 이 아니다.** 비율은 그래도 저장할 수 있다. */
            <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>
                이 보스는 결정석 가격이 확인되지 않아 수령 메소를 계산할 수
                없습니다 (0 메소가 아닙니다 · §1.3 D4). 비율은 그대로 저장됩니다.
              </span>
            </p>
          ) : null}

          {data.entryPartySize !== goingParticipants.length ? (
            /*
              §1.3 D3 — 1/n 의 분모(`entry_party_size`)와 실제 참가 확정 인원이 다르면
              **화면이 그 사실을 말한다.** 둘 중 하나를 조용히 고르면 사용자는 왜 자기
              몫이 예상과 다른지 알 수 없다. 어느 쪽이 맞는지는 사람만 안다.
            */
            <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>
                입장 인원은{" "}
                <Numeric>{data.entryPartySize}</Numeric>명으로 잡혀 있는데 참가
                확정은 <Numeric>{goingParticipants.length}</Numeric>명입니다. pot
                은 입장 인원으로 정해지고 분배는 참가 확정자끼리 하므로, 다르면
                「수정」에서 인원수를 맞춰 주세요 (§1.3 D3).
              </span>
            </p>
          ) : null}

          {parsed.hasInvalid ? (
            <ShareErrorNotice>
              가중치는 0 이상 {WEIGHT_INPUT_MAX.toLocaleString("ko-KR")} 이하의
              숫자여야 합니다. 비어 있는 칸이 없어야 합니다.
            </ShareErrorNotice>
          ) : parsed.sum === 0 ? (
            <ShareErrorNotice>
              가중치 합이 0 입니다. 최소 한 명은 0보다 큰 값을 가져야 합니다.
            </ShareErrorNotice>
          ) : (
            <HelperText>
              가중치로 입력합니다 — 스펙 차이가 나면 <Numeric>1 : 2</Numeric> 처럼
              적으면 됩니다. 합계를 <Numeric>100</Numeric> 으로 맞출 필요는
              없습니다. 만분율 환산과 <strong className="font-semibold">잔돈
              배분은 저장 시 DB 가</strong> 합니다 — 웹과 카카오톡 봇이 같은 답을
              내야 하기 때문입니다.
            </HelperText>
          )}

          {mutationError === null ? null : (
            /* 한국어 문구는 **서버가 준다**. 여기서 다시 지어내면 규칙이 두 벌이 된다. */
            <ShareErrorNotice>{mutationError.message}</ShareErrorNotice>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
              {save.isPending ? (
                <>
                  <Loader2 aria-hidden size={14} className="animate-spin" />
                  저장하는 중…
                </>
              ) : (
                "배율 저장"
              )}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isPending}
              onClick={() => {
                /*
                  초안을 **먼저** 버린다. 그래야 낙관적으로 `auto_equal` 이 된 캐시에서
                  입력칸이 곧바로 `1 : 1 : …` 로 다시 파생된다 — 초안을 들고 있으면
                  응답이 올 때까지 사용자가 방금 되돌린 값이 화면에 그대로 남는다.
                */
                setDraft(null);
                resetToEqual.mutate(undefined);
              }}
            >
              {resetToEqual.isPending ? (
                <>
                  <Loader2 aria-hidden size={14} className="animate-spin" />
                  되돌리는 중…
                </>
              ) : (
                "균등으로 되돌리기"
              )}
            </Button>
            {isDirty ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => setDraft(null)}
              >
                입력 취소
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={isPending}
            >
              닫기
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
