"use client";

import { CircleCheck, TriangleAlert, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BossIcon,
  MesoAmount,
} from "@/components/domain";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { BossCycle } from "@/types/domain";

import type { ClearRecord, IncomeCharacterOption } from "../types";
import { CharacterSelect } from "./character-select";
import { DifficultyChip } from "./difficulty-chip";
import { PartySizeField } from "./party-size-field";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 수정 모달의 한 행 — 보스 · 난이도 · 캐릭터 · 인원 · 내 몫이 **한 줄에**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 레퍼런스 계산기에서 가져온 것은 이 **조밀한 매트릭스**다. 보스마다 카드 한 장을
 * 쌓으면 12줄이 화면 세 개가 되고, 그게 발주자가 "난잡하다"고 한 상태였다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 가져오지 **않은** 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 레퍼런스는 *계획 계산기*라 "이 보스들을 이 인원으로 돌면 얼마"를 **추정**한다.
 * 이 화면은 **이미 일어난 클리어의 원장**이다. 두 개념을 섞으면 사용자는 자기가 보는
 * 숫자가 예상인지 실적인지 모르게 된다. 그래서 여기에는 체크박스로 보스를 켜고 끄는
 * 기능이 없다 — 켜고 끄는 것(클리어 체크)은 모달 밖 일정 목록의 일이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 열 순서 = **손대는 빈도** 순
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터(주 조작) → 인원(가끔) → 내 몫(읽기 전용 결과). 캐릭터는 주마다 바뀌지만
 * 인원은 한 번 맞추면 그 판에 대해 끝나고, 금액은 애초에 우리가 정하는 값이 아니다.
 *
 * ⚠️ **이 행은 숫자를 만들지 않는다.** `내 몫` 은 `boss_clears.crystal_share_meso`
 *    스냅샷 그대로다. 인원을 고치면 서버가 트리거를 다시 돌려 새 값을 주고 화면은 받아
 *    적는다. 캐릭터를 바꾸면 금액은 **아예 움직이지 않는다** — 분배는 사람 단위라
 *    내 캐릭터끼리 옮기는 것은 몫을 바꾸지 않고 12개 카운터의 주인만 바꾼다.
 * ⚠️ 난이도는 **좌측 보더 + 칩**이고(§4), 상태(미확인·초과)는 보더를 덮지 않고 배지와
 *    문장이 담당한다. 채널을 섞으면 둘 다 못 읽는다.
 */

const CYCLE_LABEL: Record<BossCycle, string> = {
  weekly: "주간",
  daily: "일간",
  monthly: "월간",
  // 주간마다 초기화되지만 12칸을 안 먹는다 — 라벨을 갈라야 그 차이가 보인다(2026-08-26).
  season: "시즌",
};

/**
 * 헤더와 행이 **같은 격자**를 쓴다. 한 곳에서만 정의해야 열이 어긋나지 않는다.
 * 좁은 화면(< 640px)에서는 한 줄에 다 넣을 수 없어 세로로 쌓는다.
 */
/*
 * 첫 열 `2.5rem`(40px)은 **보스 아이콘 자리**다(`BossIcon` 의 `md`). 2026-08-18 에 아이콘을
 * 32→40px 로 키우면서 함께 넓혔다 — 열이 32px 로 남아 있으면 아이콘이 열 밖으로 삐져나와
 * 보스 이름과 겹친다. 행 높이는 변하지 않는다: 이름(20px)+칩 줄(20px)+간격이 이미 42px 라
 * 40px 아이콘이 그 안에 들어간다.
 */
/*
 * ⚠️ **인원 열이 `4.5rem`(72px) 이어서 깨져 있었다** (발주 지적 2026-09-01: *"ui도
 *    깨져있어"*). 2026-08-28 에 −/+ 버튼을 붙이면서 그 칸의 실제 폭이
 *    32+4+56+4+32+4+17 = **~149px** 이 됐는데 열 폭은 그대로였다. 내용이 열 밖으로 흘러
 *    `명` 이 아래로 밀리고 오른쪽 `내 몫` 금액과 겹쳐 보였다. → **10rem**(160px).
 *    ★ 칸의 내용물을 바꿀 때 그 칸을 감싸는 격자도 함께 봐야 한다. 버튼만 넣고 열 폭을
 *      안 본 것이 원인이다.
 *
 * 마지막 `2.5rem` 은 **해제 버튼** 자리다(2026-09-01).
 */
export const CLEAR_EDIT_GRID =
  "grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-[2.5rem_minmax(0,1fr)_10rem_10rem_auto_2.5rem] sm:items-center";

export interface ClearEditRowProps {
  readonly clear: ClearRecord;
  readonly options: readonly IncomeCharacterOption[];
  readonly isPending: boolean;
  readonly onPartySizeChange: (clearId: string, partySize: number) => void;
  readonly onCharacterChange: (clearId: string, characterId: string) => void;
  /** 이 기록을 원장에서 내린다. 확인은 이 행이 먼저 받고 부른다. */
  readonly onRemove: (clearId: string) => void;
}

export function ClearEditRow({
  clear,
  options,
  isPending,
  onPartySizeChange,
  onCharacterChange,
  onRemove,
}: ClearEditRowProps) {
  const baseId = useId();

  /*
    ── 해제는 **물어보고 한다** ────────────────────────────────────────────
    수익 한 줄을 지우는 일이고, 이 창에는 한 화면에 열 줄 넘게 서 있어 오사용이 쉽다.
    다만 확인창(모달)을 띄우지는 않는다 — 모달 위에 모달을 쌓으면 포커스가 어디로
    가는지 알 수 없고, **어느 줄에 대한 물음인지도 흐려진다.** 그 행 안에서 전체 폭으로
    펼치면 지우려는 기록이 바로 위에 보인다(`party-bar` 의 해체 확인과 같은 규칙 —
    "정말?"만 묻지 않고 무엇이 사라지고 무엇이 남는지 말한다).
  */
  const [isConfirming, setIsConfirming] = useState(false);
  const characterId = `${baseId}-character`;
  const partySizeId = `${baseId}-party-size`;
  const noteId = `${baseId}-note`;

  /*
   * ★ 여기 남는 것은 **이 행에만 해당하는** 문장뿐이다.
   *
   *   빠진 둘은 지운 것이 아니라 **옮긴** 것이다 — 둘 다 모든 행에서 글자 한 자 다르지
   *   않게 같아서, 12건이면 같은 문단이 12번 깔렸다(발주자: *"너무 아래로 길어"*).
   *   - 인원 미확인(§1.3 D3) → 모달 상단 요약 한 곳 + 이 행의 `확인 필요` 배지.
   *   - 가격 미확인(§1.3 D4) → 모달 하단 `가격 미확인 N건` + 이 행 금액의 `미확인` 표기
   *     (`MesoAmount` 가 `title` 로 "0 메소가 아니다"까지 말한다).
   *
   *   `overMaxParty` 만 남는다. 보스마다 상한이 달라(§1.3 D5) **행마다 내용이 다르고**,
   *   요약으로 접으면 어느 보스가 몇 명 상한인지가 사라진다.
   */
  const notes: string[] = [];
  if (clear.overMaxParty && clear.maxParty !== null) {
    notes.push(
      `이 보스에 확인된 최대 인원은 ${clear.maxParty}명입니다. 값은 그대로 저장되지만 수익이 실제보다 작게 잡힐 수 있으니 한 번 확인해 주세요.`,
    );
  }

  return (
    <li
      className={cn(
        CLEAR_EDIT_GRID,
        "rounded-md border border-l-4 border-border bg-surface px-3 py-2.5",
        BOSS_DIFFICULTY_BORDER_L[clear.difficulty],
        isPending && "opacity-60",
      )}
    >
      {/* ① 보스 아이콘. 파일이 없는 보스는 실루엣 폴백이다 — 오류가 아니다. */}
      <div className="hidden sm:block">
        <BossIcon
          bossDifficultyId={clear.bossDifficultyId}
          difficulty={clear.difficulty}
        />
      </div>

      {/* ② 보스 이름 + 난이도 칩 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="sm:hidden">
          <BossIcon
            bossDifficultyId={clear.bossDifficultyId}
            difficulty={clear.difficulty}
          />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* `boss_difficulties.korean_name` 은 이미 `하드 스우` 형태다(난이도 포함). */}
          <span className="truncate text-body-sm font-semibold text-ink">
            {clear.bossDisplayName}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <DifficultyChip difficulty={clear.difficulty} />
            {/*
              주기만 적는다. 카운터 제외 문구는 발주자 지시로 뺐다(2026-08-18 —
              주간 체크리스트·보스 계획에서 먼저 빠진 것과 같은 결정). `월간` 이라는
              말 자체가 이미 카운터 밖임을 전달하고, 좁은 줄에서 글자만 늘어난다.
            */}
            <span className="text-caption text-ink-muted">
              {clear.cycle === null ? "주기 미상" : CYCLE_LABEL[clear.cycle]}
            </span>
          </span>
        </div>
      </div>

      {/* ③ 캐릭터 — 행의 주 조작 */}
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={characterId}
          className="text-caption text-ink-muted sm:sr-only"
        >
          캐릭터
        </label>
        <CharacterSelect
          id={characterId}
          characterId={clear.characterId}
          characterName={clear.characterName}
          options={options}
          disabled={isPending}
          onChange={(next) => onCharacterChange(clear.clearId, next)}
        />
      </div>

      {/* ④ 입장 인원 — 보조 입력. 미확인이면 아래 배지가 눈에 띈다. */}
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={partySizeId}
          className="text-caption text-ink-muted sm:sr-only"
        >
          입장 인원
        </label>
        <PartySizeField
          /* 저장이 끝나 새 값이 내려오면 입력칸도 그 값으로 다시 시작한다. */
          key={`${clear.clearId}-${clear.partySize}`}
          id={partySizeId}
          partySize={clear.partySize}
          disabled={isPending}
          aria-describedby={notes.length > 0 ? noteId : undefined}
          onSubmit={(next) => onPartySizeChange(clear.clearId, next)}
        />
        {/*
          확인 상태를 **행에서 바로** 보여 준다. 인원을 고치면 `set_clear_party_size()` 가
          `party_size_confirmed` 를 올리므로, 저장 직후 이 배지가 "확인 필요"에서
          "확인됨"으로 바뀐다 — 사용자가 자기 조작의 결과를 화면에서 확인할 수 있다.

          ★ 2026-08-19 이후 "확인 필요"는 **평소에 뜨지 않는다.** 파티 인원의 기본값이
            1인 확정이 되면서(발주자 지시) 동기화가 만드는 클리어는 전부
            `party_size_confirmed = true` 로 들어오고, 기존 행도 마이그레이션 25 가 올렸다.
            배지를 지우지 않고 남겨 둔 이유: 트리거의 보수적 기본값이 살아 있어 앞으로 다른
            경로가 미확인 클리어를 만들면 그때 신호가 필요하다. 지금은 사실상 안전망이다.
        */}
        {clear.partySizeUnconfirmed ? (
          <span
            className="inline-flex items-center gap-1 text-caption text-ink"
            title="이 기록의 입장 인원은 아무도 확인한 적이 없습니다. 넥슨 API 에는 파티 정보가 없어(§1.1) 관측만으로 만들어진 기록이거나, 인원이 채워지지 않은 경로로 들어온 기록입니다. 실제로 파티였다면 결정석 수익이 최대 6배로 잡혀 있으니 인원 칸에 실제 입장 인원을 넣어 주세요."
          >
            <TriangleAlert aria-hidden size={12} className="shrink-0 text-tertiary" />
            확인 필요
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
            <CircleCheck aria-hidden size={12} className="shrink-0 text-success" />
            확인됨
          </span>
        )}
      </div>

      {/* ⑤ 내 몫 — 읽기 전용. DB 스냅샷을 그대로 옮긴다. */}
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span className="text-caption text-ink-muted sm:sr-only">내 몫</span>
        <MesoAmount
          value={clear.shareMeso}
          compact
          suffix={false}
          tone="accent"
          className="text-body-sm font-semibold"
        />
      </div>

      {/*
        ⑥ 해제 — **틀린 기록을 그 자리에서 되돌린다** (발주 지적 2026-09-01).
        인원·캐릭터는 "맞는데 값이 틀리다"를 고치는 길이고, 여기는 "애초에 안 잡았다"다.
        아이콘만 두는 이유: 열 폭이 40px 이고, 이 동작은 이 창에서 **가끔** 쓰인다.
        `title` 과 `aria-label` 이 어느 기록인지까지 말한다.
      */}
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          /* 아이콘 하나뿐이라 좌우 여백을 줄여 40px 열에 들어가게 한다. */
          className="w-control-sm px-0"
          disabled={isPending}
          aria-expanded={isConfirming}
          aria-label={`${clear.bossDisplayName} 클리어 해제`}
          title={`${clear.bossDisplayName} — 이 기록을 원장에서 내립니다`}
          onClick={() => setIsConfirming((previous) => !previous)}
        >
          <Trash2 aria-hidden size={16} />
        </Button>
      </div>

      {/*
        ── 해제 확인 — **무엇이 사라지고 무엇이 남는지 먼저 말한다** ─────────
        `party-bar` 의 파티 해체가 세운 규칙이다. "정말 하시겠습니까?" 만 묻는 창은
        사용자에게 판단 근거를 주지 않아 안전하지 않다.
        격자 밖 전체 폭에 둔다 — 위 경고 문단과 같은 이유로 열 폭이 문장에 끌려다니면
        안 된다.
      */}
      {isConfirming ? (
        <div className="flex flex-col gap-2 rounded-md border border-error bg-background px-2.5 py-2 sm:col-span-6">
          <p className="text-body-sm text-ink">
            <strong className="font-semibold">{clear.bossDisplayName}</strong>{" "}
            기록을 이번 주 수익에서 내립니다. 다시 잡은 것으로 되돌리려면{" "}
            <strong className="font-semibold">이번 주 현황</strong>에서 그 보스 칸을
            누르면 됩니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => {
                setIsConfirming(false);
                onRemove(clear.clearId);
              }}
            >
              {isPending ? "해제하는 중…" : "해제합니다"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsConfirming(false)}
            >
              취소
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        경고는 격자 밖 전체 폭에 둔다. 열 안에 넣으면 열 폭이 문장에 끌려다니고,
        문장 하한이 14px 이라(§4) 좁은 칸에서 두세 줄로 접힌다.
        색은 **tertiary orange** 다 — red 는 실패·취소 전용(§4).
      */}
      {notes.length > 0 ? (
        <ul id={noteId} className="flex flex-col gap-1.5 sm:col-span-6">
          {notes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2.5 py-1.5 text-body-sm text-ink"
            >
              <TriangleAlert
                aria-hidden
                size={14}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
