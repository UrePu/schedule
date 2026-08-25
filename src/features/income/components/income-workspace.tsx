"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  ErrorState,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { formatKst, getWeekKey } from "@/lib/time/week";
import type { WeekKey } from "@/types/domain";

import {
  addRunDrop,
  fetchIncomeLedger,
  fetchWeeklyIncomeDetail,
  removeRunDrop,
  updateClearCharacter,
  updateClearPartySize,
  updateRunDrop,
} from "../data";
import {
  LEDGER_MAX_WEEKS,
  LEDGER_PAGE_WEEKS,
  calendarLedgerRange,
  kstMonthKey,
  listLedgerRange,
} from "../lib/week-range";
import type { WeeklyIncomeDetail, WeekLedgerEntry } from "../types";
import { CrystalIncomeSummaryPanel } from "./crystal-income-summary";
import { IncomeCalendar } from "./income-calendar";
import { IncomeEditDialog } from "./income-edit-dialog";
import { LedgerClearDialog } from "./ledger-clear-dialog";
import { RunDropDialog } from "./run-drop-dialog";
import { WeekLedgerList } from "./week-ledger-list";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 수익 화면 (§1.2 2순위)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 대시보드의 수익 카드는 **요약**이고 이 화면이 **원장**이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 개편 — 캐릭터별 목록이 **달력 + 주차별 내역**으로 바뀌었다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자: *"수익 탭은 캐릭터별 클리어 필요없고. 캘린더를 박아놔서 언제 무슨보스를 돌았고
 * 하는 내역들을 볼수있게 해봐 주차별로 32주차엔 얼마 벌었다. 드랍 뭐였다 등등"*
 *
 * **없앤 것**: 캐릭터별 클리어 카드(`CharacterIncomeCard`). 캐릭터 단위로 접힌 목록은
 * "언제 무엇을 돌았나"를 못 보여 준다는 것이 지시의 요지다.
 * **그 기능이 간 곳**:
 *   · 캐릭터별 소계와 12개 상한 경고 → **수정 창**(`IncomeEditDialog`)이 그대로 갖고
 *     있다. 상한이 캐릭터당이라(§1) 그 층은 사라지면 안 되고, 실제로 사라지지 않았다.
 *   · 개별 클리어 수정(발주자 명시 지시 *"개별수정 가능하도록해"*) → **달력의 날짜
 *     상세**와 **주차 내역의 `수정`** 두 곳에서 열린다. 편집기는 기존 `ClearEditRow` 를
 *     그대로 재사용한다 — 수정 로직을 다시 만들지 않았다.
 *   · 클리어 한 줄의 읽기 표시(`ClearRecordRow`) → 주차 내역의 펼침 목록.
 *
 * **넣은 것**: 달력(월 단위, 한 줄 = 한 주) · 주차별 내역(더 보기) · 상단 요약의
 * **주간/월간 분리 + 이론상 최대치**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면은 숫자를 만들지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 결정석 + 드랍의 합계마저 뷰의 `total_income_meso` 를 쓴다. 화면이 더하기 시작하면
 * 웹과 카톡 봇(`!결정석`)의 답이 언젠가 갈라진다 — 이미 두 번 갈라졌고 두 번 고쳤다.
 * 상단 요약은 대시보드와 **같은 컴포넌트·같은 서버 조립**(`crystal-summary.ts`)이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 mutation 응답이 화면 전체인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 인원을 고치면 그 한 줄만이 아니라 캐릭터 합계·사용자 합계·12 상한 경고가 동시에
 * 움직인다. 부분 갱신을 조립하면 화면이 잠깐 서로 어긋난 숫자를 말하므로, 서버가 다시
 * 만든 전체를 그대로 받는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 근사임을 숨기지 않는다 (§1.3 D1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 수익은 **판매 주차가 아니라 클리어 주차**에 귀속된다. 관측할 방법이 없으므로 근사치임을
 * 화면이 직접 말한다(`CrystalIncomeSummaryPanel` 하단).
 */

export interface IncomeWorkspaceProps {
  readonly weekKey: WeekKey;
  /**
   * 기준 시각(ISO). **서버가 주입한다** — 달력의 "이번 달"과 "오늘"을 클라이언트가 스스로
   * 정하면 SSR 과 하이드레이션이 달 경계에서 갈릴 수 있다(`WeekLabel` 과 같은 규약).
   */
  readonly nowIso: string;
}

/** 원장 상세 창이 무엇을 보고 있는가. 하루 또는 한 주. */
type LedgerScope =
  | { readonly kind: "day"; readonly dayKey: string }
  | { readonly kind: "week"; readonly weekKey: WeekKey };

export function IncomeWorkspace({ weekKey, nowIso }: IncomeWorkspaceProps) {
  const queryClient = useQueryClient();
  const [pendingClearId, setPendingClearId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  /** 모달을 어느 캐릭터 묶음에서 열었는가. 스크롤 위치를 맞추는 데만 쓴다. */
  const [focusCharacterId, setFocusCharacterId] = useState<string | null>(null);
  /** 드랍 창을 연 일정. `null` 이면 닫혀 있다. */
  const [dropRunId, setDropRunId] = useState<string | null>(null);
  /** 저장 중인 드랍. 새로 추가하는 중이면 `"new"`. */
  const [pendingDropKey, setPendingDropKey] = useState<string | null>(null);

  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const todayDayKey = kstDayKey(now);

  /** 달력이 보고 있는 달. `2026-08`. */
  const [monthKey, setMonthKey] = useState(() => kstMonthKey(now));
  /** 주차 목록이 몇 주를 거슬러 보고 있는가. "더 보기"가 늘린다. */
  const [listWeeks, setListWeeks] = useState(LEDGER_PAGE_WEEKS);
  /** 원장 상세 창. `null` 이면 닫혀 있다. */
  const [ledgerScope, setLedgerScope] = useState<LedgerScope | null>(null);

  /**
   * ★ **`initial` props 를 받지 않는다** (§2.4 Rule 1). 페이지가 같은 값을 요청 범위
   *   QueryClient 에 심어 `dehydrate` 하고, 하이드레이션이 `dataUpdatedAt` 까지 실어 온다.
   *
   * 티어: db(60초). **넥슨 호출 0건** — 결정석 가격도 수익도 우리 DB 에만 있다(§1.1).
   */
  const detailQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.income.detail(weekKey)),
    queryFn: async () => (await fetchWeeklyIncomeDetail(weekKey)).detail,
  });

  /*
   * ── 원장 조회 두 벌 ─────────────────────────────────────────────────────
   * 달력과 주차 목록은 **같은 엔드포인트·같은 응답 모양**을 쓰지만 보고 싶은 범위가
   * 다르다(이 달 vs 최근 N주). 범위가 겹치면 캐시가 그대로 재사용되고, 겹치지 않으면
   * 각자 가져온다. 티어는 db(60초)이며 역시 **넥슨 호출 0건**이다.
   */
  /*
    ★ 범위는 **페이지의 prefetch 와 같은 함수**로 만든다(`week-range.ts`). 한 칸이라도
      어긋나면 캐시 키가 달라져 서버가 심어 둔 값이 버려지고, 첫 화면이 빈 달력으로
      깜빡인 뒤 같은 데이터를 다시 받아 온다.
  */
  const calendarRange = useMemo(
    () => calendarLedgerRange(monthKey, weekKey),
    [monthKey, weekKey],
  );

  const listRange = useMemo(
    () => listLedgerRange(weekKey, listWeeks),
    [weekKey, listWeeks],
  );

  const calendarQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.income.ledger(calendarRange.from, calendarRange.to),
    ),
    queryFn: () => fetchIncomeLedger(calendarRange.from, calendarRange.to),
  });

  const listQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.income.ledger(listRange.from, listRange.to)),
    queryFn: () => fetchIncomeLedger(listRange.from, listRange.to),
  });

  /**
   * 응답으로 받은 화면 전체를 캐시에 그대로 얹는다. 우리가 조립하지 않는다.
   *
   * ★ **`detail.weekKey` 로 쓴다** — 화면이 보고 있는 주차가 아니라. 달력·주차 목록에서
   *   **지난주 클리어**를 고치면 서버는 그 주차의 원장을 돌려주는데, 이번 주 키에 얹으면
   *   화면이 지난주 금액을 이번 주라고 말하게 된다.
   *
   * 함께 날리는 것들 — 하나라도 빠지면 화면마다 다른 숫자가 보인다:
   * - **원장**(`income.ledgerRoot`): 달력과 주차 목록이 열어 둔 **모든 범위**가 낡는다.
   * - **일정 목록**(`runs`): 클리어 체크가 런의 상태를 바꾼다.
   * - **대시보드**(`dashboard`): 수익 카드와 12칸이 같은 원장에서 나온다.
   * - **체크리스트**(`bossPlans`): 클리어 표시가 캐릭터별 진행 상황을 움직인다.
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
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.bossPlans.root(),
    });
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

  /*
   * ⚠️ **클리어 체크 mutation 은 이 화면에서 사라졌다** (2026-08-19 발주자가 카드를
   *    빼면서 함께). 쓰기 경로 자체는 그대로 살아 있다 —
   *    `POST /api/income/runs/[runId]/clear` 와 `data/setRunClear`, 그리고 카톡 `!클리어`
   *    가 같은 서버 함수(`income-repo.setRunClear`)를 부른다. 여기서는 **부르는 화면이
   *    없어졌을 뿐**이라 라우트를 지우지 않았다. 다시 필요해지면 그 함수만 부르면 된다.
   */

  /**
   * 드랍 추가 · 수정 · 삭제 (발주 요구, 2026-08-18: *"드랍 넣고"*).
   *
   * ⚠️ **낙관적 업데이트를 쓰지 않는다.** 한 건을 넣으면 그 드랍의 내 몫, 주간 드랍 합계,
   *    미판매 건수, 총합이 전부 움직이고 그 값은 하나도 남김없이 DB 가 만든다. 화면이
   *    미리 그려 보려면 1/n 을 여기서 다시 적어야 하고, 그건 두 번 고친 사고 그 자체다.
   */
  const dropAdd = useMutation({
    mutationFn: addRunDrop,
    onSettled: () => setPendingDropKey(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  const dropUpdate = useMutation({
    mutationFn: updateRunDrop,
    onSettled: () => setPendingDropKey(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  const dropRemove = useMutation({
    mutationFn: removeRunDrop,
    onSettled: () => setPendingDropKey(null),
    onSuccess: (response) => applyDetail(response.detail),
  });

  const detail = detailQuery.data;

  /*
   * 상태 셋(§0.3) 중 **로딩·오류는 여기서 끝난다.** 하이드레이션이 정상이면 `detail` 은
   * 첫 렌더부터 채워져 있으므로 이 분기는 캐시가 빈 예외 경로에서만 보인다. 재조회가
   * 실패해도 이전 원장이 남아 있으면 화면을 지우지 않는다 — 금액을 통째로 없애는 것보다
   * 마지막으로 확인된 값을 계속 보여 주는 쪽이 낫다.
   */
  if (detail === undefined) {
    return detailQuery.isError ? (
      <ErrorState
        title="수익을 불러오지 못했습니다"
        detail={detailQuery.error.message}
        onRetry={() => void detailQuery.refetch()}
      />
    ) : (
      <SkeletonGroup label="주간 수익을 불러오는 중">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-40" />
        ))}
      </SkeletonGroup>
    );
  }

  /*
   * 실패 문구는 **조작이 일어난 곳**에 붙는다. 모달 안에서 고치다 실패했는데 문구가
   * 모달 뒤 본문에 뜨면 사용자는 아무 반응 없이 값만 되돌아간 것으로 읽는다.
   */
  const editError = partySize.error ?? clearCharacter.error;
  const dropError =
    dropAdd.error ?? dropUpdate.error ?? dropRemove.error ?? null;
  /** 드랍 창이 보고 있는 일정. 응답이 오면 이 참조가 새 값으로 바뀐다. */
  const dropRun =
    dropRunId === null
      ? null
      : (detail.runs.find((run) => run.runId === dropRunId) ?? null);

  /** 달력과 주차 목록이 받아 온 주차를 하나로 합친다. 상세 창이 여기서 골라 쓴다. */
  const ledgerWeeks = new Map<string, WeekLedgerEntry>();
  for (const week of calendarQuery.data?.weeks ?? []) {
    ledgerWeeks.set(week.weekKey, week);
  }
  for (const week of listQuery.data?.weeks ?? []) {
    ledgerWeeks.set(week.weekKey, week);
  }

  /**
   * 상세 창이 보여 줄 내용. 하루면 그날 클리어만, 한 주면 그 주 전체다.
   *
   * ★ **드랍은 하루로 쪼개지 않는다.** `run_drops` 에는 획득 날짜가 없고 우리가 아는 것은
   *   주차(`week_key`)뿐이다 — 클리어의 `cleared_at` 으로 흉내 내면 그건 우리가 지어낸
   *   날짜다. 그래서 하루 상세에는 그날 클리어만 싣고, 드랍은 주차 상세에서 본다.
   */
  function resolveScope(): {
    readonly title: string;
    readonly description: string;
    readonly weekKey: WeekKey;
    readonly clears: WeekLedgerEntry["clears"];
    readonly drops: WeekLedgerEntry["drops"];
  } | null {
    if (ledgerScope === null) return null;

    if (ledgerScope.kind === "week") {
      const week = ledgerWeeks.get(ledgerScope.weekKey);
      return {
        title: `${ledgerScope.weekKey} 클리어 수정`,
        description:
          "이 주차에 기록된 클리어입니다. 어느 캐릭터로 돌았는지와 실제 입장 인원을 고치면 그 자리에서 저장되고 합계가 다시 계산됩니다.",
        weekKey: ledgerScope.weekKey,
        clears: week?.clears ?? [],
        drops: week?.drops ?? [],
      };
    }

    // 정오(720분) 기준으로 주차를 판정한다 — 00:00 은 경계에서 하루가 밀릴 여지가 남는다.
    const noon = kstMoment(ledgerScope.dayKey, 720);
    const dayWeekKey = getWeekKey(noon);
    const week = ledgerWeeks.get(dayWeekKey);
    const clears = (week?.clears ?? []).filter(
      (clear) =>
        clear.clearedAt !== null &&
        kstDayKey(new Date(clear.clearedAt)) === ledgerScope.dayKey,
    );

    return {
      title: `${formatKst(noon, "M월 d일")} 클리어`,
      description:
        "이 날 기록된 클리어입니다. 어느 캐릭터로 돌았는지와 실제 입장 인원을 고치면 그 자리에서 저장되고 합계가 다시 계산됩니다.",
      weekKey: dayWeekKey,
      clears,
      /* 드랍은 날짜를 모른다(위 주석). 하루 상세에는 싣지 않는다. */
      drops: [],
    };
  }

  const scope = resolveScope();

  /** 캐릭터 카드가 사라졌으므로 진입점은 헤더 버튼 하나다. */
  function openEditor(characterId: string | null): void {
    setFocusCharacterId(characterId);
    // 지난 실패 문구를 새 창까지 끌고 가지 않는다.
    partySize.reset();
    clearCharacter.reset();
    setEditOpen(true);
  }

  function openLedgerScope(next: LedgerScope): void {
    partySize.reset();
    clearCharacter.reset();
    setLedgerScope(next);
  }

  /**
   * 더 거슬러 볼 주차가 남아 있는가. 서버가 준 `earliestWeekKey` 와 지금 요청 범위의
   * 시작을 **문자열로** 비교한다 — 주차 키는 `2025-W52 < 2026-W01` 이 성립한다.
   */
  const earliestWeekKey = listQuery.data?.earliestWeekKey ?? null;
  /*
    ★ **상한에 닿으면 더 늘리지 않는다.** 서버가 `LEDGER_MAX_WEEKS` 를 넘는 범위를 400 으로
      거절하므로, 화면이 그대로 눌러 대면 목록이 통째로 사라진다("더 보기를 눌렀더니
      아무것도 안 보인다"). 그래서 같은 상수를 화면도 본다.
  */
  const atMaxSpan = listWeeks >= LEDGER_MAX_WEEKS;
  const canLoadMore =
    !atMaxSpan && earliestWeekKey !== null && earliestWeekKey < listRange.from;

  return (
    <div className="flex flex-col gap-4">
      {/* ── 상단 요약 — 대시보드 카드와 **같은 값·같은 컴포넌트** ─────────── */}
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
            이번 주 전체를 **캐릭터별로 묶어** 고치는 창. 12개 상한이 캐릭터당이라(§1)
            그 층이 필요한 순간이 있고, 그때는 날짜·주차보다 캐릭터로 묶여 있어야 한다.
            클리어가 하나도 없으면 고칠 것도 없으므로 버튼을 내리지 않고 비활성으로 둔다 —
            버튼이 사라졌다 나타나면 사용자는 그 자리를 다시 찾아야 한다.
          */}
          <Button
            variant="secondary"
            size="sm"
            className="cursor-pointer"
            disabled={detail.characters.length === 0}
            onClick={() => openEditor(null)}
          >
            <Pencil aria-hidden size={14} />
            캐릭터별 수정
          </Button>
        </div>

        <CrystalIncomeSummaryPanel
          summary={detail.crystalSummary}
          emptyDescription="이번 주에 클리어로 기록된 보스가 아직 없습니다. 인게임 스케줄러를 동기화하면 클리어한 보스의 결정석 수익이 자동으로 합산됩니다."
        />
      </Card>

      {/*
        ── '결정석 90개 천장' 카드는 **없앴다** (2026-08-25 발주자: *"이거 필요없고"*) ──
        CLAUDE.md §1.3 D2 는 이 상한을 "추적하고 경고하되 막지는 않는다" 로 규정했는데,
        발주자가 화면에서 빼기로 했다. 근거는 그 카드가 스스로 달고 있던 고지다 — 일간
        보스를 추적하지 않으므로 이 숫자는 **언제나 실제보다 낮다.** 90 에 닿기 전에 뜨지
        않을 수도 있는 경고는 있으나 마나이고, 자리만 차지한다.
        ⚠️ 데이터는 그대로 있다(`detail.accountCrystalUsage`). 다시 필요해지면 카드만
           되살리면 되고, 그때는 일간을 세는 문제부터 풀어야 한다.
      */}


      {/*
        ── '이번 주 등록한 일정' 카드는 **없앴다** (2026-08-19 발주자) ─────────
        *"수익칸에서 이것좀 없애도될듯 필요없어"* · *"드랍은 그냥 네비게이션쪽에 !드랍 과
        비슷한 동작을 하는 버튼을 만들고 빼버리셈"*

        그 카드가 들고 있던 두 가지가 각자 더 나은 자리로 갔다:
          · **클리어 체크** — 인게임 스케줄러 동기화가 자동으로 넣는다. 인원도 등록해 둔
            일정이나 계획값에서 오므로(`sync-scheduler`) 사람이 매주 체크할 일이 아니다.
            동기화(~15분 지연) 전에 즉시 반영하려면 카톡 `!클리어`.
          · **드랍 기록** — 상단 바의 `QuickDropButton`. 드랍은 보스를 돌고 나온 직후에
            적는 일이라 수익 화면을 찾아 들어가는 동선 자체가 잘못이었다.
        판매액을 나중에 채우거나 지우는 것은 **주차별 내역의 드랍 줄**에서 연다.
      */}

      {/* ── 달력 — 언제 무슨 보스를 돌았나 ───────────────────────────────── */}
      <IncomeCalendar
        monthKey={monthKey}
        onMonthChange={setMonthKey}
        weeks={calendarQuery.data?.weeks ?? []}
        isLoading={calendarQuery.isPending}
        isError={calendarQuery.isError}
        onRetry={() => void calendarQuery.refetch()}
        onSelectDay={(dayKey) => openLedgerScope({ kind: "day", dayKey })}
        onSelectWeek={(key) => openLedgerScope({ kind: "week", weekKey: key })}
        todayDayKey={todayDayKey}
      />

      {/* ── 주차별 내역 ──────────────────────────────────────────────────── */}
      <WeekLedgerList
        weeks={listQuery.data?.weeks ?? []}
        isLoading={listQuery.isPending}
        isError={listQuery.isError}
        onRetry={() => void listQuery.refetch()}
        canLoadMore={canLoadMore}
        atMaxSpan={atMaxSpan}
        isLoadingMore={listQuery.isFetching}
        onLoadMore={() =>
          setListWeeks((current) =>
            Math.min(current + LEDGER_PAGE_WEEKS, LEDGER_MAX_WEEKS),
          )
        }
        onEditWeek={(key) => openLedgerScope({ kind: "week", weekKey: key })}
        currentWeekKey={weekKey}
        /*
          드랍 수정 입구. '아직 안 판 드랍' 카드가 사라지면서 이 자리가 **금액을
          나중에 채우거나 오타를 지우는 유일한 길**이 됐다.
        */
        onEditDrop={(runId) => {
          // 지난 실패 문구를 새 창까지 끌고 가지 않는다.
          dropAdd.reset();
          dropUpdate.reset();
          dropRemove.reset();
          setDropRunId(runId);
        }}
      />

      {/*
        ── '아직 안 판 드랍' 카드도 **없앴다** (2026-08-25 발주자: *"맨밑에 안판드랍
           이것도 필요없어"*) ──────────────────────────────────────────────
        ★ 다만 **판매액을 나중에 채우는 길은 남겨야 한다.** 그 카드가 드랍 수정 창의
          유일한 입구였어서, 그대로 지우면 금액이 빈 드랍을 영영 고칠 수 없게 된다.
          그래서 입구를 **주차별 내역의 드랍 줄**로 옮겼다(`onEditDrop`).
      */}

      {/* ── 이번 주 전체를 캐릭터별로 묶어 고치는 창 ──────────────────────── */}
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

      {/*
        ── 달력의 하루 / 주차 한 줄에서 여는 수정 창 ─────────────────────────
        발주자 명시 지시(*"개별수정 가능하도록해"*). 편집기는 `ClearEditRow` 재사용이며
        저장 경로도 위와 **같은 mutation 두 개**다 — 주차만 그 클리어의 것으로 보낸다.
      */}
      <LedgerClearDialog
        open={scope !== null}
        onClose={() => setLedgerScope(null)}
        title={scope?.title ?? "클리어"}
        description={scope?.description ?? ""}
        clears={scope?.clears ?? []}
        drops={scope?.drops ?? []}
        options={detail.characterOptions}
        pendingClearId={pendingClearId}
        errorMessage={editError?.message ?? null}
        onPartySizeChange={(clearId, next) => {
          if (scope === null) return;
          setPendingClearId(clearId);
          partySize.mutate({
            clearId,
            partySize: next,
            weekKey: scope.weekKey,
          });
        }}
        onCharacterChange={(clearId, characterId) => {
          if (scope === null) return;
          setPendingClearId(clearId);
          clearCharacter.mutate({
            clearId,
            characterId,
            weekKey: scope.weekKey,
          });
        }}
      />

      {/*
        ── 드랍 기록 (발주 요구, 2026-08-18) ───────────────────────────────
        입력 자리를 **일정 목록 옆**으로 정한 근거는 `run-drop-dialog.tsx` 머리말.
      */}
      <RunDropDialog
        open={dropRun !== null}
        onClose={() => setDropRunId(null)}
        run={dropRun}
        pendingKey={pendingDropKey}
        errorMessage={dropError?.message ?? null}
        onAdd={(input) => {
          if (dropRun === null) return;
          setPendingDropKey("new");
          dropAdd.mutate({ runId: dropRun.runId, weekKey, ...input });
        }}
        onUpdate={(dropId, input) => {
          setPendingDropKey(dropId);
          dropUpdate.mutate({
            dropId,
            weekKey,
            itemName: input.itemName,
            saleAmountMeso: input.saleAmountMeso,
            /*
              `custom` 비율이 걸린 건은 방식을 보내지 않는다(서버가 거절한다).
              `undefined` 는 "안 보냄"이고 `null` 과 다르다 — `JSON.stringify` 가
              키 자체를 빼 준다.
            */
            ...(input.shareMode === undefined
              ? {}
              : {
                  shareMode: input.shareMode,
                  soloParticipantId: input.soloParticipantId,
                }),
            note: input.note,
          });
        }}
        onRemove={(dropId) => {
          setPendingDropKey(dropId);
          dropRemove.mutate({ dropId, weekKey });
        }}
      />
    </div>
  );
}
