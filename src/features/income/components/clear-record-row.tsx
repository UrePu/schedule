"use client";

import { GitCompareArrows, TriangleAlert } from "lucide-react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BossIcon,
  MesoAmount,
  Numeric,
  NumericText,
  formatKstShort,
} from "@/components/domain";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearRecord, ClearSource, ClearWinner } from "../types";
import { DifficultyChip } from "./difficulty-chip";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 클리어 한 건 — **읽기 전용 · 한 줄**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 아이콘 · 보스명 · 난이도 · 주기 · 입장 인원 · 금액 · 출처/시각이 **한 줄**에 들어간다.
 * 고치는 일은 전부 수정 모달(`IncomeEditDialog`)이 한다 — 이 줄에는 입력이 하나도 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 줄에서 경고 **문단**을 걷어냈나 (2026-08-18 발주자: *"너무 아래로 길어"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 인원 미확인 경고가 **줄마다 통째로** 그려지고 있었다. 클리어 11건이면 같은 문장이
 * 11번, 거기에 카드 상단 요약까지 더해 **12번**. 문장 자체는 옳지만(§1.3 D3) 반복은
 * 정보를 더하지 않고 세로만 먹는다 — 클리어 한 건이 132px, 목록만 1,500px 였다.
 *
 * ★ 그래서 **말은 한 번, 표시는 매 줄**로 나눴다.
 *   - **설명**(왜 부풀려지나 · 어떻게 고치나)은 카드 상단 요약 경고 **한 곳**에만 있다
 *     (2026-08-19 개편 이후에는 `IncomeEditDialog` 와 `crystal-income-summary`). 거기서
 *     건수와 교정 동선을 말한다.
 *   - **이 줄**은 그 상태임을 배지 하나로 알린다 — `1인 입장 · 미확인`. 전체 문장은
 *     `title` 로 붙어 있어 마우스를 올리면 그대로 읽을 수 있다.
 *   D3 경고가 사라진 것이 아니다. **한 번만, 눈에 띄게** 말한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래도 줄에 **남긴** 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **인원 미확인 배지** — 어느 줄이 부풀려진 건지는 줄에서만 알 수 있다. 요약은
 *    "11건"이라고만 말하므로, 줄 표시를 지우면 사용자는 무엇을 고칠지 못 고른다.
 * 2. **가격 미확인** — `MesoAmount` 가 `null` 을 "미확인"으로 그린다. 0 이 아니다(§1.3 D4).
 * 3. **출처 충돌** — 넥슨 관측과 수동 체크가 다르면 어느 쪽이 반영됐는지 말한다(난제 6).
 *    이건 **줄마다 내용이 다르므로**(어느 쪽이 이겼는지) 요약으로 접을 수 없다 —
 *    배지에 결과를, `title` 에 전문을 둔다.
 *
 * ⚠️ **숫자를 만들지 않는다.** `내 몫` 은 `boss_clears.crystal_share_meso` 스냅샷 그대로다.
 * ⚠️ 난이도는 **좌측 보더 + 칩**(§4). 상태는 보더를 덮지 않는다.
 * ⚠️ 배지 글자는 **잉크**다. 주황은 배경·테두리·아이콘만 진다 — 주황 본문은 라이트
 *    모드에서 AA 미달이다(§4).
 * ⚠️ 12px(`text-caption`)로 내려간 것은 **배지와 수치 주석뿐**이다. 문장은 이 줄에 없다(§4).
 */

const SOURCE_LABEL: Record<ClearSource, string> = {
  manual: "수동 체크",
  nexon_api: "넥슨 관측",
  bot: "카톡 봇",
};

/** 전문(`title`)에 쓰는 판정 문구. */
const WINNER_LABEL: Record<ClearWinner, string> = {
  manual: "수동 체크가 반영됨",
  api: "넥슨 관측이 반영됨",
  none: "판정 없음",
};

/** 배지에 쓰는 판정 문구. 한 줄에 들어가야 하므로 짧다. */
const WINNER_SHORT: Record<ClearWinner, string> = {
  manual: "수동 반영",
  api: "관측 반영",
  none: "판정 없음",
};

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
  // 주간마다 초기화되지만 12칸을 안 먹는다 — 라벨을 갈라야 그 차이가 보인다(2026-08-26).
  season: "시즌",
};

/** 배지 공통. 높이가 난이도 칩과 같아야 줄 높이가 칩 하나로 결정된다. */
const BADGE_BASE =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption";

export interface ClearRecordRowProps {
  readonly clear: ClearRecord;
}

export function ClearRecordRow({ clear }: ClearRecordRowProps) {
  const clearedLabel =
    clear.clearedAt === null ? null : formatKstShort(new Date(clear.clearedAt));

  return (
    <li
      className={cn(
        /*
         * `py-1`(4px). 2026-08-18 에 보스 아이콘을 24→32px 로 키우면서 함께 줄였다 —
         * 이 줄의 높이를 정하는 것이 아이콘이라(배지 20px · 글자 20px) 패딩을 그대로 두면
         * 36px → 44px 로 22% 길어진다. **1줄 압축**은 최근 작업의 성과라 되돌리지 않는다.
         * 4px 로 줄이면 40px 이 되어 +4px 에 그치고, 배지는 여전히 세로 중앙에 앉는다.
         */
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-l-4 border-border bg-surface px-2.5 py-1",
        BOSS_DIFFICULTY_BORDER_L[clear.difficulty],
      )}
    >
      {/* 🖼️ 파일이 없는 보스는 실루엣 폴백. 오류가 아니다(§2.1.1). */}
      <BossIcon
        bossDifficultyId={clear.bossDifficultyId}
        difficulty={clear.difficulty}
        size="sm"
      />

      {/*
        `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태다(난이도 포함).
        이름만 늘어나고 나머지는 `shrink-0` 이라, 긴 이름이 배지를 밀어내지 않는다.
      */}
      <span
        className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink"
        title={clear.bossDisplayName}
      >
        {clear.bossDisplayName}
      </span>

      <DifficultyChip difficulty={clear.difficulty} />

      {/*
        주기만 적는다. 카운터 제외 문구는 발주자 지시로 뺐다(2026-08-18 — 주간
        체크리스트·보스 계획에서 먼저 빠진 것과 같은 결정). `월간` 이라는 말이 이미
        카운터 밖임을 전달한다.
      */}
      <span className="shrink-0 whitespace-nowrap text-caption text-ink-muted">
        {clear.cycle === null ? "주기 미상" : CYCLE_LABEL[clear.cycle]}
      </span>

      {/*
        입장 인원. 미확인이면 **같은 자리가 경고 배지로 바뀐다** — 줄이 한 줄로 유지된다.
        전문은 `title` 이고, 왜 그런지와 어떻게 고치는지는 카드 상단 요약이 말한다(§1.3 D3).
      */}
      {clear.partySizeUnconfirmed ? (
        <span
          className={cn(
            BADGE_BASE,
            "border-chip-soon-border bg-chip-soon-bg text-ink",
          )}
          title={`입장 인원이 확인되지 않았습니다. 지금 값은 ${String(clear.partySize)}명이라, 실제로 파티였다면 이 금액이 최대 6배로 부풀려져 있습니다. 이 주차의 '수정' 버튼이나 달력의 날짜 상세에서 고칠 수 있습니다.`}
        >
          <TriangleAlert
            aria-hidden
            size={12}
            className="shrink-0 text-tertiary"
          />
          {/*
            ★ 이 한 겹을 지우지 말 것. 배지가 `inline-flex gap-1` 이라 `Numeric` 을 벗겨
              두면 숫자와 한글이 각각 flex 아이템이 되어 `1 인 입장` 으로 벌어진다
              (`meso-amount.tsx` 가 같은 이유로 감싸고 있다).
          */}
          <span>
            <Numeric>{clear.partySize}</Numeric>인 입장 · 미확인
          </span>
        </span>
      ) : (
        <span className="shrink-0 text-caption text-ink-muted">
          <Numeric>{clear.partySize}</Numeric>인 입장
        </span>
      )}

      {/*
        출처 충돌(난제 6). 줄마다 **다른 내용**이라(어느 쪽이 이겼는지) 요약으로 접지 않고
        배지에 결과를, `title` 에 전문을 둔다. 색은 중립이다 — 실패가 아니므로 빨강이 아니고,
        조치가 필요한 상태도 아니므로 주황도 아니다(§4).
      */}
      {clear.hasConflict ? (
        <span
          className={cn(BADGE_BASE, "border-border bg-neutral-100 text-ink")}
          title={`인게임 관측(${clear.apiCleared === true ? "클리어" : "미클리어"})과 수동 체크(${clear.manualCleared === true ? "클리어" : "미클리어"})가 다릅니다. 더 최신 관측인 ${WINNER_LABEL[clear.winner]}. 진 쪽 값은 지우지 않고 그대로 두었습니다.`}
        >
          <GitCompareArrows
            aria-hidden
            size={12}
            className="shrink-0 text-ink-muted"
          />
          불일치 · {WINNER_SHORT[clear.winner]}
        </span>
      ) : null}

      <span className="flex shrink-0 items-center gap-2">
        {/*
          보스명이 `flex-1` 이라 이 묶음은 늘 줄 오른쪽 끝에 붙는다. 그 안에서 금액을
          `min-w-20 justify-end` 로 오른쪽에 세워, 앞의 배지 폭이 줄마다 달라도
          금액 자릿수는 세로로 줄이 선다(`Claude/FONT-NOTES.md` §9 — 등폭의 목적).
        */}
        <MesoAmount
          value={clear.shareMeso}
          compact
          suffix={false}
          tone="accent"
          className="min-w-20 justify-end text-body-sm font-semibold"
        />
        {/*
          클리어 시각. 행이 세로로 쌓이고 우측 정렬이라 등폭이 필요하다.
          출처 라벨(`넥슨 관측`)은 한글이므로 mono 밖에 둔다.
        */}
        <span className="whitespace-nowrap text-caption text-ink-muted">
          {SOURCE_LABEL[clear.source]}
          {clearedLabel === null ? null : (
            <>
              {" · "}
              <NumericText>{clearedLabel}</NumericText>
            </>
          )}
        </span>
      </span>
    </li>
  );
}
