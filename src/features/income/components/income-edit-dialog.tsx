"use client";

import { UserRound } from "lucide-react";
import { useEffect, useRef } from "react";

import { MesoAmount } from "@/components/domain";
import { Dialog, EmptyState, ErrorState } from "@/components/ui";

import type { WeeklyIncomeDetail } from "../types";
import { CLEAR_EDIT_GRID, ClearEditRow } from "./clear-edit-row";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 수익 수정 모달 — 고치는 일은 **전부 여기서** 한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구: *"수익 수정도 너무 난잡하게 되어 있음. 모달 형식으로 변경."*
 * 본문(`/income`)은 **읽기**만 남기고, 손대는 조작은 이 창 안으로 모았다. 이전에는
 * 캐릭터 카드마다 입력칸과 경고 문단이 붙어 있어서 "이번 주에 얼마 벌었나"를 보려면
 * 편집 UI 를 계속 스크롤로 넘겨야 했다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 캐릭터가 1층인가 (§1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 주간 결정석 판매 상한 **12개는 캐릭터당**이다. 그래서 소계가 먼저 캐릭터별로 나오고
 * 총합이 그 아래다. 두 층을 합쳐 그리면 상한의 의미가 사라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 창은 숫자를 만들지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터별 소계는 `v_weekly_crystal_income_by_character.income_meso`, 하단 총합은
 * `v_weekly_income.crystal_income_meso` 다. 화면이 소계를 더해 총합을 만들지 않는다 —
 * 그러면 뷰와 웹과 카톡 봇(`!결정석`)이 서로 다른 답을 내기 시작한다.
 * **가격 미확인(`null`)은 합계에서 빠져 있고 건수로만 센다** (§1.3 D4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 저장 버튼이 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 칸을 고치면 그 자리에서 저장되고 서버가 다시 만든 화면 전체가 내려온다. 모아서
 * 저장하는 방식이면 창을 닫는 순간 어디까지 반영됐는지 알 수 없고, 12개 상한 경고처럼
 * **다른 행의 결과에 달린 표시**가 저장 전까지 거짓말을 하게 된다.
 */

export interface IncomeEditDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly detail: WeeklyIncomeDetail;
  /** 열릴 때 이 캐릭터 묶음으로 스크롤한다. 캐릭터 카드의 "수정"에서 넘어온다. */
  readonly focusCharacterId: string | null;
  readonly pendingClearId: string | null;
  readonly errorMessage: string | null;
  readonly onPartySizeChange: (clearId: string, partySize: number) => void;
  readonly onCharacterChange: (clearId: string, characterId: string) => void;
}

export function IncomeEditDialog({
  open,
  onClose,
  detail,
  focusCharacterId,
  pendingClearId,
  errorMessage,
  onPartySizeChange,
  onCharacterChange,
}: IncomeEditDialogProps) {
  const groupRefs = useRef(new Map<string, HTMLElement>());

  /*
   * 캐릭터 카드에서 열었으면 그 묶음이 보이게 한다.
   * 포커스는 옮기지 않는다 — `<dialog>` 가 닫기 버튼에 준 첫 포커스를 빼앗으면
   * 키보드 사용자가 창의 시작점을 잃는다. 스크롤만 맞춘다.
   */
  useEffect(() => {
    if (!open || focusCharacterId === null) return;
    const target = groupRefs.current.get(focusCharacterId);
    target?.scrollIntoView({ block: "start" });
  }, [open, focusCharacterId]);

  const totals = detail.totals;
  const hasClears = detail.characters.some((income) => income.clears.length > 0);
  /*
   * 인원 미확인 건수 — **창 전체에서 한 번만** 말하기 위해 여기서 센다(§1.3 D3).
   * 예전에는 같은 설명 문단이 행마다 붙어 있어서 12건이면 12번 깔렸다. 지금은
   * 이 요약이 "몇 건인지·왜 문제인지"를 말하고, 각 행은 `확인 필요` 배지로
   * **어느 행인지**만 가리킨다.
   *
   * ★ 2026-08-19 이후 이 값은 **평소에 0 이다.** 파티 인원의 기본값이 1인 확정이 되면서
   *   (발주자 지시) 동기화가 만드는 클리어가 전부 확인됨으로 들어오고, 기존 행도
   *   마이그레이션 25 가 올렸다. 0 일 때의 빈 상태 처리는 아래 `> 0` 가드가 이미 한다 —
   *   문단이 통째로 렌더되지 않으므로 "0건입니다" 같은 빈 문장이 남지 않고, 이 창의
   *   `flex flex-col gap-4` 도 빈 자식을 만들지 않아 여백이 뜨지 않는다.
   *   ⚠️ 그 대가는 §1.3 D3 의 과대 계상이 이 화면에서 **아무 경고 없이** 지나간다는 것이다.
   */
  const unconfirmedCount = detail.characters.reduce(
    (sum, income) =>
      sum + income.clears.filter((clear) => clear.partySizeUnconfirmed).length,
    0,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="클리어 수정"
      description="어느 캐릭터로 돌았는지와 실제 입장 인원을 고칩니다. 고친 즉시 저장되고 소계·총합이 다시 계산됩니다."
      footer={
        totals === null ? (
          <p className="text-body-sm text-ink-muted">
            이번 주에 집계된 클리어가 없습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {/*
              ★ **주간과 월간을 섞지 않는다** (2026-08-19 발주자: *"주간 월간은 따로놔야지"*).
                예전에는 `주간 보스 40건 / 전체 41건` 이었는데, 12개 상한은 주간에만
                걸리므로 "전체"는 상한과 비교할 수 없는 숫자다. 두 주기를 따로 적는다.
                (건수의 출처는 상단 요약 카드와 **같은 객체**라 두 표시가 갈라질 수 없다.)
            */}
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body-sm text-ink-muted">
                {/*
                  ⚠️ **여기서는 요약 카드의 `monthly` 를 쓰지 않는다** (2026-08-20).
                     그 값은 이제 **달 전체**를 세지만(인게임 월간 초기화가 달력 1일이다),
                     이 줄은 바로 옆의 `결정석 합계` 금액과 같은 **그 주의 원장**을 설명한다.
                     범위가 다른 두 숫자를 한 문장에 놓으면 합이 맞지 않는다.
                */}
                결정석 합계 · 주간 보스 {totals.weeklyClearCount}건 · 월간 보스{" "}
                {totals.clearCount - totals.weeklyClearCount}건
              </span>
              <MesoAmount
                value={totals.crystalIncomeMeso}
                compact
                suffix={false}
                tone="accent"
                className="font-headline text-body-lg font-semibold"
              />
            </div>
            {totals.unknownPriceCount > 0 ? (
              <p className="text-body-sm text-ink-muted">
                가격 미확인 {totals.unknownPriceCount}건은 이 합계에서 빠져
                있습니다. 0 으로 더하지 않습니다.
              </p>
            ) : null}
            {/* 같은 이유로 숫자를 쓰지 않는다 — 이 문단도 **합계** 층이다. */}
            <p className="text-body-sm text-ink-muted">
              드랍 수익은 이 합계에 들어가지 않습니다. 결정석 판매 상한과 무관해서
              본문에 따로 표시합니다.
            </p>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {errorMessage !== null ? (
          <ErrorState
            title="변경을 저장하지 못했습니다"
            detail={errorMessage}
            className="py-6"
          />
        ) : null}

        {detail.characterOptions.length === 0 ? (
          /*
            추적 캐릭터 0명은 **오류가 아니라 정상 상태**다(옵트인, §2.1.1).
            그래도 이 창의 주 조작(캐릭터 선택)이 불가능하다는 사실은 말해야 한다.
          */
          <WarningNote>
            추적 중인 캐릭터가 없습니다. 홈에서 캐릭터 선택을 열어 추적할 캐릭터를
            고르면 여기서 클리어의 캐릭터를 바꿀 수 있습니다. 입장 인원은 지금도 고칠
            수 있습니다.
          </WarningNote>
        ) : null}

        {/*
          ★ **§1.3 D3 경고가 이 창에서 사는 유일한 자리.** 행마다 반복하던 문단을 여기로
            모았다. 행에는 `확인 필요` 배지와 인원 입력칸이 나란히 있으므로, 이 문장을
            읽은 사람은 배지가 붙은 행의 숫자만 고치면 된다.

          ★ 2026-08-19 이후 **평소에는 이 문단이 뜨지 않는다**(위 `unconfirmedCount` 주석).
            0건일 때 아무것도 그리지 않는 것이 의도한 빈 상태다 — "미확인 0건" 같은 문장은
            사용자가 할 일이 없는 정보라 창만 길어진다. 남겨 둔 이유는 배지와 같다:
            앞으로 다른 경로가 미확인 클리어를 만들면 그때 이 자리가 필요하다.
        */}
        {unconfirmedCount > 0 ? (
          <WarningNote>
            입장 인원이 확인되지 않은 클리어가 {unconfirmedCount}건 있습니다 —
            아래에서 &lsquo;확인 필요&rsquo; 배지가 붙은 행입니다. 넥슨 API 에는 파티
            정보가 없어(§1.1) 인원이 채워지지 않은 채 들어온 기록이라, 실제로 파티였다면
            그 건의 수익이 최대 6배로 잡혀 있습니다. 인원 칸에 실제 입장 인원을 넣으면
            그 자리에서 다시 계산됩니다.
          </WarningNote>
        ) : null}

        {!hasClears ? (
          <EmptyState
            icon={<UserRound size={24} />}
            title="고칠 클리어가 없습니다"
            description="이번 주에 집계된 클리어가 아직 없습니다. 일정을 클리어로 체크하거나 인게임 스케줄러를 동기화하면 여기에 쌓입니다."
            className="py-10"
          />
        ) : (
          detail.characters
            .filter((income) => income.clears.length > 0)
            .map((income) => {
              const key = income.characterId ?? income.characterName;
              const limit = income.weeklySellLimit;
              const overLimit = income.weeklyOverLimitCount > 0;
              // "접근"의 기준은 상한 − 2 다. 12개째에 처음 알려 주면 이미 늦다.
              const nearLimit =
                !overLimit && limit > 0 && income.weeklyClearCount >= limit - 2;

              return (
                <section
                  key={key}
                  ref={(node) => {
                    if (income.characterId === null) return;
                    if (node === null) groupRefs.current.delete(income.characterId);
                    else groupRefs.current.set(income.characterId, node);
                  }}
                  className="flex flex-col gap-2"
                >
                  {/* ── 캐릭터 소계 (12 상한이 적용되는 층) ─────────────── */}
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                      <h3 className="font-headline text-body font-semibold text-ink">
                        {income.characterName}
                      </h3>
                      <span className="text-caption text-ink-muted">
                        {income.worldName ?? "월드 미상"} · 주간 보스{" "}
                        {income.weeklyClearCount}/{limit}
                      </span>
                    </div>
                    <MesoAmount
                      value={income.incomeMeso}
                      compact
                      suffix={false}
                      tone="accent"
                      className="text-body-sm font-semibold"
                    />
                  </div>

                  {overLimit ? (
                    <WarningNote>
                      주간 결정석 판매 한도({limit}개)를 넘긴 클리어가{" "}
                      {income.weeklyOverLimitCount}건 있습니다. 넘긴 만큼은 이
                      캐릭터 소계에서 빠져 있습니다.
                    </WarningNote>
                  ) : nearLimit ? (
                    <WarningNote>
                      주간 결정석 판매 한도({limit}개)까지{" "}
                      {limit - income.weeklyClearCount}개 남았습니다. 13번째 주간
                      보스는 입장 자체가 불가능합니다.
                    </WarningNote>
                  ) : null}

                  {/* 열 이름은 묶음마다 한 번만. 좁은 화면에서는 행이 세로로 쌓이고
                      각 칸이 자기 라벨을 갖는다. */}
                  <div
                    aria-hidden
                    className={`${CLEAR_EDIT_GRID} hidden px-3 text-caption text-ink-muted sm:grid`}
                  >
                    <span />
                    <span>보스</span>
                    <span>캐릭터</span>
                    <span>인원</span>
                    <span className="text-right">내 몫</span>
                  </div>

                  <ul className="flex flex-col gap-1.5">
                    {income.clears.map((clear) => (
                      <ClearEditRow
                        key={clear.clearId}
                        clear={clear}
                        options={detail.characterOptions}
                        isPending={pendingClearId === clear.clearId}
                        onPartySizeChange={onPartySizeChange}
                        onCharacterChange={onCharacterChange}
                      />
                    ))}
                  </ul>
                </section>
              );
            })
        )}
      </div>
    </Dialog>
  );
}
