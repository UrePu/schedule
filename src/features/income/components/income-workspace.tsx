"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Package, Pencil, UserRound } from "lucide-react";
import { useState } from "react";

import { MesoAmount } from "@/components/domain";
import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { queryKeys } from "@/lib/query-keys";
import type { WeekKey } from "@/types/domain";

import {
  fetchWeeklyIncomeDetail,
  setRunClear,
  updateClearCharacter,
  updateClearPartySize,
} from "../data";
import type { WeeklyIncomeDetail } from "../types";
import { CharacterIncomeCard } from "./character-income-card";
import { IncomeEditDialog } from "./income-edit-dialog";
import { RunClearList } from "./run-clear-list";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 수익 상세 (§1.2 2순위)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 대시보드의 수익 카드는 **요약**이고 이 화면이 **원장**이다. 여기서 할 수 있는 것은 둘:
 *   1) 등록한 일정을 **클리어로 체크** → 그 주 수익에 즉시 합산
 *   2) 각 클리어의 **입장 인원을 수정** → 그 건과 주간 합계가 즉시 다시 계산
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면은 숫자를 만들지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 결정석 + 드랍의 합계마저 뷰의 `total_income_meso` 를 쓴다. 화면이 더하기 시작하면
 * 웹과 카톡 봇(`!결정석`)의 답이 언젠가 갈라진다 — 이미 두 번 갈라졌고 두 번 고쳤다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 mutation 응답이 화면 전체인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 인원 한 칸을 고치면 그 클리어의 내 몫, 그 캐릭터의 주간 합계, 사용자 총합, 12개
 * 상한 경고가 **동시에** 움직인다. 부분 갱신을 조립하면 화면이 잠깐 서로 어긋난 숫자를
 * 말하게 되므로, 서버가 다시 만든 전체를 그대로 캐시에 얹는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 근사임을 숨기지 않는다 (§1.3 D1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 수익은 **판매 주차가 아니라 클리어 주차**에 귀속된다. 결정석은 1주일간 유효해서
 * 목요일 리셋을 넘겨 팔 수 있고, 그 경우 인게임 메소와 우리 숫자가 어긋난다.
 * 관측할 방법이 없으므로 근사치임을 화면이 직접 말한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 본문은 **읽기**, 수정은 **모달**
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요구: *"수익 수정도 너무 난잡하게 되어 있음. 모달 형식으로 변경."*
 * 클리어마다 입력칸과 경고 문단이 본문에 깔려 있어서, "이번 주에 얼마 벌었나"를 보려는
 * 사람이 편집 UI 를 계속 스크롤로 넘겨야 했다. 이제 본문에는 입력이 하나도 없고
 * (일정 클리어 체크만 예외 — 그건 **매일 하는 조작**이라 창을 열게 하면 안 된다),
 * 캐릭터·인원 수정은 `IncomeEditDialog` 안에서 한다.
 */

export interface IncomeWorkspaceProps {
  readonly initial: WeeklyIncomeDetail;
  readonly weekKey: WeekKey;
}

export function IncomeWorkspace({ initial, weekKey }: IncomeWorkspaceProps) {
  const queryClient = useQueryClient();
  const [pendingClearId, setPendingClearId] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  /** 모달을 어느 캐릭터 묶음에서 열었는가. 스크롤 위치를 맞추는 데만 쓴다. */
  const [focusCharacterId, setFocusCharacterId] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.db.income.detail(weekKey),
    queryFn: async () => (await fetchWeeklyIncomeDetail(weekKey)).detail,
    initialData: initial,
  });

  /** 응답으로 받은 화면 전체를 캐시에 그대로 얹는다. 우리가 조립하지 않는다. */
  function applyDetail(detail: WeeklyIncomeDetail): void {
    queryClient.setQueryData(queryKeys.db.income.detail(weekKey), detail);
    // 대시보드 요약 카드도 같은 뷰를 읽는다. 서버 컴포넌트라 캐시가 아니라
    // 다음 진입에서 다시 읽히므로, 여기서는 클라이언트 캐시만 정리한다.
    void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
  }

  const partySize = useMutation({
    mutationFn: updateClearPartySize,
    onSettled: () => setPendingClearId(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  /**
   * 클리어의 귀속 캐릭터 변경 (§1 — 클리어와 12개 상한의 단위는 캐릭터).
   *
   * ★ 인원 변경과 **같은 pending 슬롯**을 쓴다. 한 행에서 두 조작이 동시에 나갈 일이
   *   없고(둘 다 그 행을 비활성으로 만든다), 슬롯을 나누면 어느 쪽이 저장 중인지
   *   행이 두 가지 상태를 동시에 말하게 된다.
   */
  const clearCharacter = useMutation({
    mutationFn: updateClearCharacter,
    onSettled: () => setPendingClearId(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  const runClear = useMutation({
    mutationFn: setRunClear,
    onSettled: () => setPendingRunId(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  const detail = detailQuery.data;
  const totals = detail.totals;
  /*
   * 실패 문구는 **조작이 일어난 곳**에 붙는다. 모달 안에서 고치다 실패했는데 문구가
   * 모달 뒤 본문에 뜨면 사용자는 아무 반응 없이 값만 되돌아간 것으로 읽는다.
   */
  const bodyError = runClear.error;
  const editError = partySize.error ?? clearCharacter.error;

  /** 캐릭터 카드의 "수정" 과 섹션 헤더의 버튼이 함께 쓰는 진입점. */
  function openEditor(characterId: string | null): void {
    setFocusCharacterId(characterId);
    // 지난 실패 문구를 새 창까지 끌고 가지 않는다.
    partySize.reset();
    clearCharacter.reset();
    setEditOpen(true);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── 합계 — 결정석 / 드랍 / 총합을 나눠 보여 준다 (§8-8b) ───────────── */}
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Coins aria-hidden size={20} className="mt-0.5 text-secondary" />
            <div className="flex min-w-0 flex-col gap-1">
              <CardOverline>이번 주 합계</CardOverline>
              <CardTitle className="text-body-lg">결정석 · 드랍 수익</CardTitle>
            </div>
          </div>
          {/*
            수정 진입점. 본문은 읽기이고 손대는 일은 전부 이 창 안에서 한다.
            클리어가 하나도 없으면 고칠 것도 없으므로 버튼을 내리지 않고 비활성으로 둔다 —
            버튼이 사라졌다 나타나면 사용자는 그 자리를 다시 찾아야 한다.
          */}
          <Button
            variant="secondary"
            size="sm"
            disabled={detail.characters.length === 0}
            onClick={() => openEditor(null)}
          >
            <Pencil aria-hidden size={14} />
            클리어 수정
          </Button>
        </div>

        {totals === null ? (
          /*
            빈 상태 — "0 메소를 벌었다"가 아니라 "아직 클리어가 없다"이다.
            두 상태를 같은 화면으로 그리면 안 되므로 금액을 0 으로 찍지 않는다.
          */
          <p className="text-body-sm text-ink-muted">
            이번 주에 클리어로 기록된 보스가 아직 없습니다. 아래에서 등록한 일정을
            클리어로 체크하면 결정석 수익이 자동으로 합산됩니다.
          </p>
        ) : (
          <>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-pad-md">
                <dt className="text-body-sm text-ink-muted">결정석</dt>
                <dd>
                  <MesoAmount
                    value={totals.crystalIncomeMeso}
                    compact
                    suffix={false}
                    tone="accent"
                    className="font-headline text-body-lg font-semibold"
                  />
                </dd>
                <dd className="text-caption text-ink-label tabular-nums">
                  주간 {totals.weeklyClearCount}건 · 전체 {totals.clearCount}건
                </dd>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-pad-md">
                <dt className="text-body-sm text-ink-muted">드랍</dt>
                <dd>
                  <MesoAmount
                    value={totals.dropIncomeMeso}
                    compact
                    suffix={false}
                    className="font-headline text-body-lg font-semibold"
                  />
                </dd>
                <dd className="text-caption text-ink-label tabular-nums">
                  {totals.dropCount}건 · 12 상한과 무관
                </dd>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-pad-md">
                <dt className="text-body-sm text-ink-muted">합계</dt>
                <dd>
                  <MesoAmount
                    value={totals.totalIncomeMeso}
                    compact
                    suffix={false}
                    className="font-headline text-body-lg font-semibold"
                  />
                </dd>
                <dd className="text-caption text-ink-label">
                  뷰가 낸 총합입니다
                </dd>
              </div>
            </dl>

            {/*
              ⚠️ 여기부터는 **합계에 들어가지 않은 것들**이다.
                 합계 아래에 두는 이유: 위 숫자가 전부라고 읽히면 안 되기 때문이다.
            */}
            {totals.unknownPriceCount > 0 ? (
              <WarningNote>
                가격 미확인 {totals.unknownPriceCount}건은 합계에서 제외했습니다.
                0 으로 더하지 않습니다.
              </WarningNote>
            ) : null}

            {totals.weeklyOverLimitCount > 0 ? (
              <WarningNote>
                주간 결정석 판매 한도를 넘긴 클리어가{" "}
                {totals.weeklyOverLimitCount}건 있습니다. 한도는 캐릭터당이므로
                아래 캐릭터별 목록에서 어느 캐릭터인지 확인할 수 있습니다.
              </WarningNote>
            ) : null}

            <p className="text-body-sm text-ink-muted">
              클리어 주차 기준 근사치입니다. 결정석은 획득 후 1주일간 유효해서 목요일
              초기화를 넘겨 팔 수 있고, 그 경우 인게임 메소와 어긋납니다.
            </p>
          </>
        )}
      </Card>

      {bodyError !== null ? (
        <ErrorState
          title="변경을 저장하지 못했습니다"
          detail={bodyError.message}
          className="py-6"
        />
      ) : null}

      {/* ── 클리어 체크 (§1.2 2순위) ──────────────────────────────────────── */}
      <RunClearList
        runs={detail.runs}
        pendingRunId={pendingRunId}
        onToggle={(runId, cleared) => {
          setPendingRunId(runId);
          runClear.mutate({ runId, cleared, weekKey });
        }}
      />

      {/* ── 캐릭터별 상세 (12 상한이 적용되는 층) ─────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-headline text-body-lg font-semibold text-ink">
            캐릭터별 클리어
          </h2>
          <span className="text-body-sm text-ink-muted tabular-nums">
            캐릭터 {detail.characters.length}명 · 주간 12개 상한은 캐릭터당입니다
          </span>
        </div>

        {detailQuery.isError ? (
          <ErrorState
            title="수익을 불러오지 못했습니다"
            description="잠시 후 다시 시도해 주세요."
            onRetry={() => void detailQuery.refetch()}
          />
        ) : detailQuery.isLoading ? (
          <SkeletonGroup label="주간 수익을 불러오는 중">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-48" />
            ))}
          </SkeletonGroup>
        ) : detail.characters.length === 0 ? (
          <EmptyState
            icon={<UserRound size={24} />}
            title="이번 주 클리어 기록이 없습니다"
            description="일정을 클리어로 체크하거나 인게임 스케줄러를 동기화하면 캐릭터마다 결정석 수익이 여기에 쌓입니다."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {detail.characters.map((income) => (
              <CharacterIncomeCard
                key={income.characterId ?? income.characterName}
                income={income}
                onEdit={openEditor}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 미판매 드랍 — 금액이 없으니 합계에 못 들어간다 (§8-6) ─────────── */}
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Package aria-hidden size={18} className="text-tertiary" />
            <CardTitle className="text-body-lg">아직 안 판 드랍</CardTitle>
          </div>
          <span className="text-body-sm text-ink-muted tabular-nums">
            {totals?.unsoldDropCount ?? 0}건
          </span>
        </div>

        <p className="text-body-sm text-ink-muted">
          판매 금액이 비어 있는 드랍입니다. 모르는 금액을 0 으로 채우면 &lsquo;0
          메소를 벌었다&rsquo;는 거짓이 되므로 합계에 넣지 않고 건수로만 셉니다.
        </p>

        {detail.unsoldDrops.length === 0 ? (
          <p className="text-body-sm text-ink-label">
            이번 주에 판매를 기다리는 드랍이 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.unsoldDrops.map((drop) => (
              <li
                key={drop.dropId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">
                  {drop.itemName}
                </span>
                <span className="shrink-0 text-body-sm text-ink-muted">
                  {drop.bossDisplayName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── 수정 — 본문의 모든 편집이 이 창 하나로 모였다 ─────────────────── */}
      <IncomeEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        detail={detail}
        focusCharacterId={focusCharacterId}
        pendingClearId={pendingClearId}
        errorMessage={editError?.message ?? null}
        onPartySizeChange={(clearId, next) => {
          setPendingClearId(clearId);
          partySize.mutate({ clearId, partySize: next, weekKey });
        }}
        onCharacterChange={(clearId, characterId) => {
          setPendingClearId(clearId);
          clearCharacter.mutate({ clearId, characterId, weekKey });
        }}
      />
    </div>
  );
}
