"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Package } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { MesoAmount, Numeric } from "@/components/domain";
import {
  Button,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
} from "@/components/ui";
import { computeDropSplit, formatEok, parseEok } from "@/lib/domain/drop-split";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { formatKst } from "@/lib/time/week";
import { cn } from "@/lib/utils";

import { addRunDrop, fetchWeeklyIncomeDetail } from "../data";
import type { ScheduledRunClear, WeeklyIncomeDetail } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 드랍 기록 폼 — 상단 바 버튼과 `기타 › 드랍 기록` 페이지가 **함께 쓴다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-20): *"드랍 기능도 기타로 넣어줘"* — 상단 바 버튼은 그대로 두고
 * 내비게이션의 `기타` 무리에도 자리를 만들었다. 그래서 같은 폼이 두 자리에서 그려진다.
 *
 * ★ **폼을 복사하지 않는다.** 드랍은 금액을 다루고, 두 벌이 되면 한쪽만 고쳐지는 날이
 *   반드시 온다. 다이얼로그는 이 컴포넌트를 감싸기만 한다.
 *
 * 계산은 여기서 하지 않는다. 경매장 수수료를 두 번 내는 구조와 `X = R / (n − f)` 는
 * `@/lib/domain/drop-split` 이 소유하고, 카톡 봇(`handleDropSplit`)이 **같은 함수**를
 * 부른다 — 두 경로가 다른 금액을 말할 수 없다.
 *
 * 원장에 남기는 금액도 봇과 같다: 총 판매액이 아니라 **각자 실제로 손에 쥐는 것의 합**
 * (`eachFinalMeso × 참여 인원`). 총액을 쌓으면 수수료를 두 번 뗀 뒤 실제로는 들어오지
 * 않는 돈을 화면이 벌었다고 말한다.
 *
 * ⚠️ **분배 비율을 화면이 적지 않는다.** 보내는 것은 금액과 방식뿐이고 누가 얼마를
 *    가져가는지는 `distribute_meso()` 와 정산 뷰가 정한다.
 * ⚠️ 인원은 사용자가 적은 값으로 **계산**하지만 원장의 분모는 그 일정의 `going` 인원이다.
 *    둘이 다르면 조용히 한쪽을 고르지 않고 **화면이 그 사실을 말한다**.
 */

/** 경매장 기본 수수료. 매번 적게 만들면 그게 곧 안 쓰는 이유가 된다(봇과 같은 기본값). */
const DEFAULT_FEE_PERCENT = "3";

/** 봇과 같은 상한. 12명을 넘는 파티는 없고, 오타를 여기서 잡는다. */
const MAX_PEOPLE = 12;

export interface DropRecordFormProps {
  readonly weekKey: string;
  /** 기록에 성공했을 때. 다이얼로그는 이걸로 창을 닫고, 페이지는 넘기지 않는다. */
  readonly onRecorded?: () => void;
  /** 있으면 "닫기" 를 함께 그린다. 페이지에는 닫을 것이 없으므로 넘기지 않는다. */
  readonly onCancel?: () => void;
  /**
   * 이번 주 일정 조회를 켤지. 다이얼로그는 **열렸을 때만** 켠다 — 닫힌 창을 위해 왕복할
   * 이유가 없다. 페이지는 열려 있는 것 자체가 목적이라 기본값이 `true` 다.
   */
  readonly enabled?: boolean;
}

export function DropRecordForm({
  weekKey,
  onRecorded,
  onCancel,
  enabled = true,
}: DropRecordFormProps) {
  const queryClient = useQueryClient();
  /*
    ★ id 를 **인스턴스마다** 만든다. 예전에는 `quick-drop-run` 처럼 박혀 있었는데, 이제
      같은 폼이 다이얼로그와 페이지 두 곳에서 쓰이므로 한 문서에 두 벌이 존재할 수 있다.
      그러면 라벨이 어느 입력을 가리키는지 브라우저가 정하지 못한다.
  */
  const fieldId = useId();

  /** 판매액(억 단위 문자열). `950` · `955.5` 둘 다 받는다 — 봇의 `parseEok` 과 같은 규칙. */
  const [grossText, setGrossText] = useState("");
  const [peopleText, setPeopleText] = useState("");
  const [feeText, setFeeText] = useState(DEFAULT_FEE_PERCENT);
  const [runId, setRunId] = useState<string | null>(null);

  /**
   * 이번 주 일정. **수익 화면과 같은 쿼리 키**라 그 화면을 거쳐 왔다면 이미 캐시에 있다
   * (§2.4 Rule 5 — 키는 팩토리가 소유한다). 창을 열기 전에는 요청하지 않는다.
   */
  const detailQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.income.detail(weekKey)),
    queryFn: async () => (await fetchWeeklyIncomeDetail(weekKey)).detail,
    enabled,
  });

  /** 이른 시각부터. 방금 돈 판이 대개 마지막이라 **역순**으로 둔다. */
  const runs = useMemo(() => {
    const list = [...(detailQuery.data?.runs ?? [])];
    list.sort((a, b) => {
      if (a.scheduledAt === null || b.scheduledAt === null) {
        if (a.scheduledAt === b.scheduledAt) return a.runNo - b.runNo;
        return a.scheduledAt === null ? 1 : -1;
      }
      if (a.scheduledAt !== b.scheduledAt) {
        return a.scheduledAt < b.scheduledAt ? 1 : -1;
      }
      return b.runNo - a.runNo;
    });
    return list;
  }, [detailQuery.data]);

  /** 고른 일정. 아직 안 골랐으면 **가장 최근 판**이 기본이다(봇이 고르는 것과 같은 판). */
  const run: ScheduledRunClear | null =
    runs.find((entry) => entry.runId === runId) ?? runs[0] ?? null;

  /**
   * 인원 기본값은 그 일정의 참여 인원이다. 사용자가 손대면 그 값이 이긴다 —
   * 실제로 들어간 인원이 등록과 다를 수 있고, 그때 고칠 수 있어야 한다(§1.3 D3).
   */
  const peopleFallback = run === null ? 0 : run.goingCount || run.entryPartySize;
  const people =
    peopleText === "" ? peopleFallback : Number.parseInt(peopleText, 10);

  const grossMeso = parseEok(grossText === "" ? undefined : grossText);
  const feePercent = Number.parseFloat(feeText);
  const feeRate = Number.isFinite(feePercent) ? feePercent / 100 : Number.NaN;

  const inputsValid =
    run !== null &&
    grossMeso !== null &&
    grossMeso > 0 &&
    Number.isInteger(people) &&
    people >= 1 &&
    people <= MAX_PEOPLE &&
    Number.isFinite(feeRate) &&
    feeRate >= 0 &&
    feeRate < 1;

  const split = inputsValid
    ? computeDropSplit({ grossMeso, people, feeRate })
    : null;

  /** 원장의 분모. 봇과 같다 — 등록된 참여 인원이 있으면 그쪽이다. */
  const recipients =
    run === null ? 0 : run.goingCount > 0 ? run.goingCount : people;
  const potMeso = split === null ? null : split.eachFinalMeso * recipients;

  const mutation = useMutation({
    mutationFn: addRunDrop,
    onSuccess: (response) => {
      applyDetail(response.detail);
      setGrossText("");
      setPeopleText("");
      onRecorded?.();
    },
  });

  /**
   * 응답으로 받은 화면 전체를 캐시에 얹고, 이 기록이 움직이는 화면들을 낡게 만든다.
   * `income-workspace` 의 `applyDetail` 과 **같은 목록**이다 — 한쪽만 고치면 화면마다
   * 다른 숫자가 보인다.
   */
  function applyDetail(detail: WeeklyIncomeDetail): void {
    queryClient.setQueryData(queryKeys.db.income.detail(detail.weekKey), detail);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.income.ledgerRoot(),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.dashboard.root(),
    });
  }

  function submit(): void {
    if (run === null || split === null || potMeso === null) return;
    mutation.mutate({
      runId: run.runId,
      // 판의 보스 이름이 그대로 기록 이름이 된다 — 원장을 봐도 어느 판인지 읽힌다(봇과 같다).
      itemName: `${run.bossDisplayName} 드랍`,
      saleAmountMeso: potMeso,
      shareMode: "party_default",
      soloParticipantId: null,
      note: `판매 ${formatEok(grossMeso ?? 0)} · ${String(people)}인 · 수수료 ${feeText}%`,
      weekKey,
    });
  }

  return (
    <div className="flex flex-col gap-3">
        {mutation.error === null ? null : (
          <ErrorState
            title="드랍을 기록하지 못했습니다"
            detail={mutation.error.message}
            className="py-4"
          />
        )}

        {detailQuery.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-control-md" />
            <Skeleton className="h-24" />
          </div>
        ) : detailQuery.isError ? (
          <ErrorState
            title="이번 주 일정을 불러오지 못했습니다"
            detail={detailQuery.error.message}
            onRetry={() => void detailQuery.refetch()}
            className="py-6"
          />
        ) : runs.length === 0 ? (
          /* 빈 상태 — 오류가 아니다(§0.3). 무엇을 해야 드랍을 적을 수 있는지 말한다. */
          <EmptyState
            icon={<Package size={24} />}
            title="이번 주에 참여로 등록한 일정이 없습니다"
            description="드랍은 어느 판에서 나왔는지에 매답니다. 일정 화면에서 보스 일정을 등록하고 참여로 표시하면 여기에 나옵니다."
            className="py-8"
          />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-run`}>어느 판</Label>
              <div className="relative flex min-w-0 items-center">
                <select
                  id={`${fieldId}-run`}
                  value={run?.runId ?? ""}
                  onChange={(event) => {
                    setRunId(event.target.value);
                    // 판이 바뀌면 인원 기본값도 바뀌어야 한다. 손댄 값은 비워서 되돌린다.
                    setPeopleText("");
                  }}
                  className={cn(
                    "h-control-md w-full min-w-0 appearance-none rounded-md border border-border bg-surface",
                    "py-1 pr-7 pl-2.5",
                    "text-body-sm text-ink",
                    "transition duration-200 outline-none",
                    "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                  )}
                >
                  {runs.map((entry) => (
                    <option key={entry.runId} value={entry.runId}>
                      {entry.scheduledAt === null
                        ? "시간미정"
                        : formatKst(new Date(entry.scheduledAt), "M/d HH:mm")}
                      {" · "}
                      {entry.bossDisplayName}
                      {" · "}
                      {entry.partyName}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden
                  size={14}
                  className="pointer-events-none absolute right-2 text-ink-muted"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-gross`}>판매액 (억)</Label>
                <Input
                  id={`${fieldId}-gross`}
                  inputMode="decimal"
                  placeholder="950"
                  value={grossText}
                  onChange={(event) => setGrossText(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-people`}>인원</Label>
                <Input
                  id={`${fieldId}-people`}
                  inputMode="numeric"
                  placeholder={
                    peopleFallback === 0 ? "3" : String(peopleFallback)
                  }
                  value={peopleText}
                  onChange={(event) => setPeopleText(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-fee`}>수수료 (%)</Label>
                <Input
                  id={`${fieldId}-fee`}
                  inputMode="decimal"
                  value={feeText}
                  onChange={(event) => setFeeText(event.target.value)}
                />
              </div>
            </div>

            <HelperText>
              금액은 억 단위이고 소수도 됩니다 — <Numeric>955.5</Numeric> 는 955억
              5,000만입니다. 인원을 비워 두면 그 일정의 참여 인원(
              <Numeric>{String(peopleFallback)}</Numeric>명)으로 계산합니다.
            </HelperText>

            {split === null ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-body-sm text-ink-muted">
                판매액과 인원을 넣으면 각자 올릴 금액이 여기에 나옵니다.
              </p>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-body-sm text-ink-muted">
                    판매자 실수령
                  </span>
                  <MesoAmount
                    value={split.leaderReceivesMeso}
                    compact
                    className="text-body-sm font-semibold"
                  />
                </div>

                <div className="flex flex-col gap-1 border-t border-border pt-2">
                  <span className="text-body-sm text-ink">
                    파티원 각자 경매장에 올릴 금액
                  </span>
                  <MesoAmount
                    value={split.listPriceMeso}
                    compact
                    tone="accent"
                    className="text-body-lg font-semibold"
                  />
                  {/*
                    ★ 원값은 쉼표도 괄호도 없이 한 줄로 둔다(발주 지시 2026-08-19, 봇과 동일).
                      읽으라고 있는 것이 아니라 **게임에 그대로 붙여 넣으라고** 있다.
                  */}
                  <code className="rounded-md bg-hover-surface px-2 py-1 font-mono text-code text-ink select-all">
                    {String(split.listPriceMeso)}
                  </code>
                </div>

                <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2">
                  <span className="text-body-sm text-ink-muted">
                    → <Numeric>{String(people)}</Numeric>명 모두
                  </span>
                  <MesoAmount
                    value={split.eachFinalMeso}
                    compact
                    className="text-body-sm font-semibold"
                  />
                </div>

                {/*
                  적은 인원과 일정의 참여 인원이 다르면 **조용히 한쪽을 고르지 않는다.**
                  기록되는 금액은 참여 인원 기준이므로 그 사실을 여기서 말한다(봇과 같은 규칙).
                */}
                {run !== null && recipients !== people ? (
                  <p className="border-t border-border pt-2 text-body-sm text-ink-muted">
                    적어 주신 <Numeric>{String(people)}</Numeric>인과 이 일정의 참여{" "}
                    <Numeric>{String(recipients)}</Numeric>명이 다릅니다. 기록은 참여
                    인원 기준으로 남습니다.
                  </p>
                ) : null}

                {potMeso === null ? null : (
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2">
                    <span className="text-body-sm text-ink-muted">
                      원장에 남길 이 판의 수익
                    </span>
                    <MesoAmount
                      value={potMeso}
                      compact
                      tone="accent"
                      className="text-body-sm font-semibold"
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

      {/*
        ★ 액션이 **폼 안**에 있다. 예전에는 다이얼로그 푸터에 있었는데, 같은 폼을 페이지가
          쓰면서 그 자리가 사라졌다. 버튼을 폼이 들고 있으면 두 자리에서 똑같이 동작한다.
      */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} className="cursor-pointer">
            닫기
          </Button>
        ) : null}
        <Button
          onClick={submit}
          disabled={!inputsValid || mutation.isPending}
          className="cursor-pointer"
        >
          {mutation.isPending ? "기록 중…" : "기록"}
        </Button>
      </div>
    </div>
  );
}
