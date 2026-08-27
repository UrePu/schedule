"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Hourglass,
  KeyRound,
  ListChecks,
  Loader2,
  Pencil,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  BOSS_DIFFICULTY_BORDER_T,
  BossIcon,
  MesoAmount,
  hasBossIcon,
  Numeric,
  NumericText,
  formatKstFull,
} from "@/components/domain";
import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import { crystalShareMeso } from "@/features/schedule/lib/crystal";
import { getBossEntryMap, getBossShortName } from "@/lib/boss-master";
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
import { CredentialDialogButton } from "@/features/auth/components";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import { fetchWeeklyChecklist, syncCharacterScheduler } from "../data";
import { splitChores } from "../lib/essential-chores";
import {
  describePlanConflict,
  divergedSummarySentence,
  resolvePlanConflictState,
} from "../lib/plan-conflict";
import { forgetSyncFailure } from "../lib/scheduler-sync-memo";
import {
  describeSyncFailure,
  formatSyncFailure,
} from "../lib/sync-failure-message";
import {
  missingKeyNotice,
  useSchedulerAutoSync,
} from "../lib/use-scheduler-auto-sync";
import type {
  CharacterBossPlan,
  CharacterChecklist,
  SchedulerChore,
} from "../types";
import { SyncButton } from "./sync-button";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 대시보드 첫 화면 — 주간 체크리스트 (CLAUDE.md §1.1.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구: *"제일 중요한 주간 숙제 리스트가 대시보드에 떠야 함. 보스 0/12 해서
 * 클리어 하지 않은 보스들 주르륵."* 그리고 2026-08-18 의 재요구:
 * *"너무 빈칸이 많아서 자리 차지가 많아. 윗칸 보스 12 = 4 * 3 배치로 변경해
 * 이미지 / 보스이름 세로 카드로 구분. 이미 클리어 한것도 표시하는데 클리어하면
 * 슬래쉬 처리 해줘 색 회색으로 바꿔주고."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면이 지키는 네 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **이번 주 12칸을 통째로 보여 준다.** 주간 보스 상한이 12(§1)라 4열 × 3행이면
 *    "이번 주 전체"가 한 화면에 들어온다. 잡은 보스도 칸을 지키되 **취소선 + 회색**으로
 *    죽여서, 목록은 여전히 *남은 것*이 먼저 눈에 들어오는 할 일 목록으로 읽힌다.
 *    가로 행이었을 때는 보스 하나가 폭 전체를 먹어 3개만 남아도 카드가 세로로 길어졌고,
 *    캐릭터가 여러 명이면 대시보드가 끝없이 늘어졌다.
 * 2. **섹션은 캐릭터마다 하나다.** 12개 상한이 **캐릭터당**이라(§1) 합치면 의미가 사라진다.
 * 3. **12 카운터에는 주간 보스만 들어간다.** 월간(검은 마법사)은 **구획을 따로 둬서**
 *    카운터 밖임을 자리로 말한다 — 칸마다 배지를 다는 방식은 12칸 그리드에서 글자만
 *    빽빽해져서 뺐다(발주자 지시). 판정은 뷰의 `countsTowardWeeklyLimit` 을 그대로 읽고
 *    여기서 cycle 을 다시 판정하지 않는다.
 *    ★ **일간 보스는 앱 범위 밖이다**(2026-08-18, `@/lib/domain/boss-scope`).
 *      서버 쿼리에서 이미 빠지므로 이 화면에 "일간"이라는 말이 나올 자리가 없다.
 * 4. **진행률을 다시 계산하지 않는다.** `보스 10/12` 는 넥슨이 준 값이고,
 *    `weeklyOverLimit` / `weeklySlotsRemaining` 은 뷰가 낸 값이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 갱신 경로가 **둘**이다 (§1.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * - **진입 시 자동 1회** — `useSchedulerAutoSync`. 마지막 호출이 넥슨 지연 창(15분) 안인
 *   캐릭터는 **건너뛴다.** 렌더를 막지 않고, 실패해도 저장된 데이터로 계속 뜬다.
 * - **수동 새로고침 버튼** — 가드를 우회한다. "방금 잡았으니 지금 갱신"이 필요하기
 *   때문이다. 다만 **초당 5콜 한도는 우회하지 못한다** — 두 경로 모두 페이서를 지난다.
 */

/**
 * 그리드 열 수. **6열 고정**이다.
 *
 * 발주 지시(2026-08-27, 레퍼런스 화면과 함께): *"이번주 수익쪽 UI 가시성 고려해서
 * 해달라고 세로는 이런느낌이 좋아보이긴하는데"* — 보여 준 화면은 아이콘만 촘촘히
 * 깔고 잡은 것에 체크를 얹은 격자였다.
 *
 * ★ 12(주간 상한, §1)의 **약수를 유지한다.** 4열이었던 이유가 "12칸 = 이번 주 전부"가
 *   한 덩어리로 읽혀야 한다는 것이었고 그 근거는 지금도 옳다. 8열로 가면 12가 8+4 로
 *   갈려 그 읽기가 깨진다. 6열이면 **2행**으로 떨어져 근거를 지키면서 높이가 줄어든다.
 * ★ 세로 비용: 이름 2줄짜리 세로 카드(86px) × 3행 = 258px → 아이콘 칸(56px) × 2행 =
 *   112px. 캐릭터가 여섯이면 화면 한 장 반이 사라진다.
 * ★ **반응형으로 바꾸지 않는다.** 폭마다 열이 달라지면 같은 12칸이 화면마다 다른 모양이
 *   되고, "이번 주 전부"라는 덩어리 인식이 흔들린다. 넓은 화면에서는 열이 아니라
 *   **카드를 여러 단**으로 놓는다(아래 목록 그리드).
 */
const WEEKLY_GRID_COLUMNS = "grid-cols-6";

/**
 * 칸 공통 뼈대 — **아이콘 한 칸.**
 *
 * 이름 줄을 뺐다(2026-08-27). 이름은 `title` 과 낭독기 전용 텍스트로 **언제나** 남으므로
 * 정보가 사라지는 것이 아니라 **자리를 옮긴** 것이다. 12칸을 이름까지 달아 그리면
 * 카드가 글자밭이 되고, 정작 "무엇이 남았나"를 아이콘 모양으로 훑는 눈이 글자에 걸린다.
 *
 * ⚠️ **아이콘이 없는 보스는 이름을 글자로 그린다**(`BossCell` 참고). 47/80 만 아이콘이
 *    있어서(`boss-icon-manifest`), 이름을 통째로 빼면 나머지는 실루엣 여러 개가 되어
 *    서로 구분되지 않는다. 밀도를 위해 식별을 버리지는 않는다.
 *
 * 크기: 아이콘 40px + 상하 여백 8px ≈ 48px. 360px 폭에서 카드 안쪽 296px, 6열 ·
 * `gap-1` 이면 한 칸 44px 이라 아이콘이 40px 그대로 들어간다.
 */
const CELL_BASE =
  "relative flex aspect-square min-w-0 items-center justify-center rounded-md border p-0.5";

/**
 * 12칸 그리드의 한 칸 — **세로 카드**(위 아이콘 / 아래 이름).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 난이도는 **상단 4px 보더**로 옮겼다 (§4)
 * ─────────────────────────────────────────────────────────────────────────────
 * §4 의 규칙은 "난이도를 보더 색으로 인코딩한다"이지 "왼쪽이어야 한다"가 아니다.
 * 폭이 100px 남짓인 세로 카드에서 좌측 4px 은 아이콘 옆에 눌려 거의 읽히지 않으므로,
 * 같은 램프를 **카드 폭 전체를 쓰는 상단**으로 옮겼다(`BOSS_DIFFICULTY_BORDER_T`).
 * 아이콘 자체의 1px 링(`BossIcon` 이 이미 그린다)이 보조 채널로 함께 남아 5단계가
 * 두 겹으로 구분된다. 그리고 색은 언제나 보조다 — 표시명이 `하드 최초의 대적자` 처럼
 * 난이도를 **글자로** 싣고 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 클리어 표시 — **취소선 + `ink-muted`**
 * ─────────────────────────────────────────────────────────────────────────────
 * 회색은 `ink-placeholder` 가 아니라 `ink-muted` 다. §4 가 "사용자가 읽어야 하는 글자는
 * `ink-muted` 이상"이라고 못박았고, 잡은 보스의 이름도 **무엇을 잡았는지 알아보려고
 * 읽는 글자**다. 실제 렌더되는 조합(`bg-background` 위 12px)의 대비는
 * 라이트 4.63:1 · 다크 9.67:1 로 양쪽 다 AA(4.5:1)를 넘는다.
 * 아이콘은 `grayscale opacity-60` 으로 죽이되 형태는 그대로 남겨 무엇인지 알아볼 수 있다.
 * 취소선은 **색이 아닌 채널**이라 색각 이상에서도 클리어 여부가 전달되고, 화면 낭독기에는
 * `sr-only` 로 한 번 더 말한다(취소선은 낭독되지 않는 경우가 많다).
 *
 * 🖼️ 아이콘은 `BossIcon` 이 그린다. 파일명 규칙과 폴백은 전부 그 컴포넌트 안에 있다 —
 *    아이콘이 없는 보스는 실루엣으로 떨어지며 **오류가 아니다**(§2.1.1 초상화 규약).
 *
 * ✂️ 이름이 길다(`익스트림 검은 마법사`). 2줄까지 허용하고 그 이상은 잘라내되,
 *    `title` 로 전체 이름을 항상 보장한다 — 무슨 보스인지 알 수 없게 되면 안 된다.
 */
/** 아이콘이 없을 때 칸에 그릴 글자. 줄임말이 없으면 표시명 그대로(잘려도 title 이 받쳐 준다). */
function shortNameOf(plan: CharacterBossPlan): string {
  return getBossShortName(plan.bossDifficultyId) ?? plan.bossDisplayName;
}

function BossCell({ plan }: { readonly plan: CharacterBossPlan }) {
  const cleared = plan.isCleared;

  /*
   * ★ `plan.hasConflict` 를 그대로 읽지 않는다 — `/boss-plans` 와 **같은 함수**로
   *   최신성을 가른다(`lib/plan-conflict.ts`). 한 곳만 고치면 화면마다 다른 판정이
   *   보이게 되고, 그게 원래 고치려던 문제다.
   */
  const conflictState = resolvePlanConflictState(plan);
  const conflictNote = describePlanConflict(conflictState, plan.bossDisplayName);

  const titleParts = [plan.bossDisplayName];
  // 인원수는 언제나 있다 — `default_party_size` 가 NOT NULL DEFAULT 1 이다(2026-08-19).
  titleParts.push(`${plan.defaultPartySize}인`);
  if (cleared) titleParts.push("클리어함");
  // `pending`(게임 반영 대기)은 칸에 아무 흔적도 남기지 않는다 — 정상 상태다.
  if (conflictState === "diverged") titleParts.push("인게임 목록과 다름");
  if (!plan.released) titleParts.push("미출시");

  return (
    <li
      title={titleParts.join(" · ")}
      className={cn(
        CELL_BASE,
        "border-t-4 border-border bg-background",
        BOSS_DIFFICULTY_BORDER_T[plan.difficulty],
      )}
    >
      {/*
        아이콘이 있으면 그림만, 없으면 **줄임말 글자**. 47/80 만 아이콘이 있어서
        (`boss-icon-manifest`) 없는 쪽까지 실루엣으로 두면 서로 구분되지 않는다 —
        밀도를 위해 식별을 버리지 않는다(`CELL_BASE` 머리말).
      */}
      {hasBossIcon(plan.bossDifficultyId) ? (
        <BossIcon
          bossDifficultyId={plan.bossDifficultyId}
          difficulty={plan.difficulty}
          size="md"
          className={cleared ? "opacity-40 grayscale" : undefined}
        />
      ) : (
        <span
          className={cn(
            "line-clamp-2 px-0.5 text-center text-overline leading-tight",
            cleared ? "text-ink-placeholder line-through" : "text-ink-label",
          )}
        >
          {shortNameOf(plan)}
        </span>
      )}

      {/*
        ── 클리어 표시 = **체크 오버레이** ─────────────────────────────────
        이름 줄이 사라지면서 취소선을 걸 자리도 함께 사라졌다. 그래서 레퍼런스 화면과
        같은 방식으로 **칸 위에 체크를 얹는다.**
        ★ 색만으로 말하지 않는다(§4) — 아이콘 자체가 `grayscale opacity-40` 으로 죽고,
          체크라는 **형태**가 하나 더 얹히며, 낭독기에는 `클리어함` 이 읽힌다. 세 채널이다.
        ★ 초록은 §4 상 성공 색이라 맞다. 다만 **체크 글리프에만** 쓰고 칸 전체를 칠하지
          않는다 — 12칸 중 절반이 초록이면 남은 것이 오히려 안 보인다.
      */}
      {cleared ? (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center rounded-md bg-surface/45"
        >
          <Check size={20} strokeWidth={3.5} className="text-success" />
        </span>
      ) : null}

      <span className="sr-only">
        {plan.bossDisplayName}
        {cleared ? " 클리어함" : ""}
      </span>

      {/*
        ── 인원수 ───────────────────────────────────────────────────────────
        ⚠️ **1 은 그리지 않는다**(2026-08-27 변경). 2026-08-19 에는 "1 을 숨기면 규칙이
           안 보인다"는 이유로 언제나 그렸는데, 그때는 칸이 100px 짜리 세로 카드라 배지
           하나가 눈에 띄지 않았다. 44px 칸에서는 열두 칸 전부에 `1` 이 박혀 **그림보다
           숫자가 먼저 보인다.** 규칙은 `title` 과 `/boss-plans` 가 여전히 말하고,
           여기서는 **기본값과 다른 것만** 알린다 — 그게 이 칸에서 실제로 쓰이는 정보다.
      */}
      {plan.defaultPartySize > 1 ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 rounded-sm bg-surface px-0.5 text-overline leading-none text-ink-label tabular-nums"
        >
          {plan.defaultPartySize}
        </span>
      ) : null}
      <span className="sr-only">{plan.defaultPartySize}인 기준</span>

      {/*
        상태 표식은 **모서리 한 자리**만 쓴다. 칸이 좁아 배지를 그리면 이름 자리를 먹는다.
        색은 §4 대로 tertiary orange — red 는 실패·취소 전용이다.
      */}
      {conflictState === "diverged" && conflictNote !== null ? (
        <>
          <TriangleAlert
            aria-hidden
            size={12}
            className="absolute right-0 top-0 text-tertiary"
          />
          {/* 낭독기에는 **무엇을 해야 하는지**까지 읽힌다 — `설정 불일치` 는 조치가 없다. */}
          <span className="sr-only">{conflictNote}</span>
        </>
      ) : plan.released ? null : (
        <>
          <Hourglass
            aria-hidden
            size={12}
            className="absolute right-0 top-0 text-ink-muted"
          />
          <span className="sr-only">미출시</span>
        </>
      )}
    </li>
  );
}

/**
 * 아직 채우지 않은 슬롯.
 *
 * **왜 빈 칸을 그리는가**: 12는 상한이자 자원이다. "몇 개 더 넣을 수 있는가"는 이 화면에서
 * 실제로 쓰이는 정보(§1 — 13번째는 입장 자체가 불가능하다)이고, 그리드가 통째로 줄어들면
 * 남은 여유가 화면에서 사라진다. 점선 빈 칸은 그 여유를 자리로 보여 준다.
 *
 * 글자를 넣지 않은 이유: 12칸에 라벨이 반복되면 그리드가 글자밭이 된다. 개수는 바로 위
 * 헤더 문장이 말하고, 칸 자체는 `title` 로만 설명한다.
 */
function EmptySlot() {
  return (
    <li
      aria-hidden
      title="아직 등록하지 않은 슬롯"
      className={cn(CELL_BASE, "border-dashed border-border")}
    />
  );
}

/**
 * 세로 카드 그리드.
 *
 * ⚠️ **13개 이상이어도 잘라내지 않는다.** 게임은 13번째 주간 보스 입장을 막고(§1) 이제
 *    서버도 13번째 **켜기**를 거절한다(발주자 지시, 2026-08-18). 그래도 이미 초과해 있는
 *    계획은 남는다 — 동기화가 넣는 `api_registered` 까지 거부할 수는 없고, 어느 것을 끌지는
 *    사용자가 정하기 때문이다(강제로 잘라내지 않는다). 여기서 잘라내면
 *    사용자는 자기가 켜 둔 계획이 화면에서 사라진 것을 보게 되고, 무엇을 꺼야 하는지도
 *    알 수 없다. 그래서 초과분은 **4번째 행으로 흘려보내고** 초과 경고를 따로 띄운다.
 */
function BossGrid({
  plans,
  emptySlots = 0,
}: {
  readonly plans: readonly CharacterBossPlan[];
  readonly emptySlots?: number;
}) {
  return (
    <ul className={cn("grid gap-1.5", WEEKLY_GRID_COLUMNS)}>
      {plans.map((plan) => (
        <BossCell key={plan.planId} plan={plan} />
      ))}
      {Array.from({ length: emptySlots }, (_, index) => (
        <EmptySlot key={`empty-${index}`} />
      ))}
    </ul>
  );
}

/**
 * 주간 숙제 한 줄. 진행 카운트가 있으면 함께 보인다.
 *
 * ★ **난이도 색을 쓰지 않는다.** 숙제는 보스가 아니므로 난이도라는 축이 존재하지 않고,
 *   같은 색 언어를 빌려 쓰면 "이 숙제가 하드 난이도"라는 없는 뜻이 생긴다. 그래서 보더는
 *   **무채색(`neutral-300`)** 이고, 아이콘도 검·`Swords` 가 아니라 체크리스트다.
 */
function ChoreRow({ chore }: { readonly chore: SchedulerChore }) {
  const hasCount = chore.maxCount !== null && chore.maxCount > 0;
  return (
    <li className="flex items-center gap-2 rounded-md border border-l-4 border-border border-l-neutral-300 bg-surface px-3 py-1.5">
      <ListChecks
        aria-hidden
        size={14}
        className="shrink-0 text-ink-placeholder"
      />
      <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
        {chore.contentName}
      </span>
      {hasCount ? (
        /* `tabular-nums` 는 mono 에서 중복이지만 서체가 또 바뀔 때를 위해 남긴다. */
        <span className="shrink-0 text-caption text-ink-label tabular-nums">
          <Numeric>
            {chore.nowCount ?? 0} / {chore.maxCount}
          </Numeric>
        </span>
      ) : null}
    </li>
  );
}

/**
 * 주간 숙제 묶음 — **필수 항목만 펼치고 나머지는 접는다** (발주자 지정).
 *
 * 기준은 `lib/essential-chores.ts` 한 곳에만 있다. 이 컴포넌트는 이름을 하나도 모른다.
 */
function ChoreSection({ chores }: { readonly chores: readonly SchedulerChore[] }) {
  const [showRest, setShowRest] = useState(false);
  const { essential, rest } = splitChores(chores);

  if (chores.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-caption text-ink-label">
        주간 숙제 · 필수 {essential.length}개
        {rest.length > 0 ? ` (그 외 ${rest.length}개)` : ""}
      </p>

      {essential.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          필수 숙제(에픽 던전 · 지하 수로)로 등록된 것이 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {essential.map((chore) => (
            <ChoreRow key={chore.contentName} chore={chore} />
          ))}
        </ul>
      )}

      {rest.length > 0 ? (
        <>
          {showRest ? (
            <ul className="flex flex-col gap-1.5">
              {rest.map((chore) => (
                <ChoreRow key={chore.contentName} chore={chore} />
              ))}
            </ul>
          ) : null}
          {/*
            접힌 항목의 개수를 버튼에 적는다. "숨겼다"가 아니라 "여기 있다"를 말해야
            사용자가 데이터가 사라졌다고 오해하지 않는다.
          */}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={showRest}
            onClick={() => setShowRest((value) => !value)}
          >
            {showRest ? (
              <ChevronUp aria-hidden size={14} />
            ) : (
              <ChevronDown aria-hidden size={14} />
            )}
            {showRest ? "그 외 숙제 접기" : `그 외 숙제 ${rest.length}개 보기`}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * 캐릭터 한 명의 섹션.
 *
 * 상태가 넷이다 —
 *   (a) 한 번도 동기화 안 함 → 빈 상태 + "지금 불러오기"
 *   (b) 동기화했지만 켜 둔 계획이 없음 → **"0개 했다"가 아니라 "아직 셀 것이 없다"**
 *   (c) 계획이 있음 → 12칸 그리드(잡은 것은 취소선)
 *   (d) 계획을 전부 잡음 → 그리드 위에 완료 칩이 얹힌다
 */
function CharacterSection({
  entry,
  onSync,
  isPending,
}: {
  readonly entry: CharacterChecklist;
  readonly onSync: (input: {
    /** `null` 이면 서버가 DB 에서 그 계정 키를 꺼내 쓴다(§2.1.2). 실패가 아니다. */
    readonly apiKey: string | null;
    readonly characterId: string;
  }) => void;
  readonly isPending: boolean;
}) {
  const { character, progress, snapshot, planned } = entry;

  /*
   * `보스 N/12` — 넥슨이 직접 준 값이다. 실측에서 주간 `complete_flag=true` 개수와
   * 정확히 일치했고(10), 월간(검은 마법사)은 카운터에 들어가지 않았다.
   * 우리가 세지 않는다. 값이 없으면 숫자를 지어내지 말고 없다고 말한다.
   */
  const clearCount = snapshot?.weeklyBossClearCount ?? null;
  const clearLimit = snapshot?.weeklyBossClearLimitCount ?? null;
  const hasCounter = clearCount !== null && clearLimit !== null;

  /* 12 카운터에 들어가는 것만 위 그리드로. 판정은 뷰가 준 플래그 그대로다. */
  const weeklyPlans = planned.filter((plan) => plan.countsTowardWeeklyLimit);
  /*
    12칸 밖은 이제 **두 종류**다(2026-08-26 시즌 주기 분리). 한 덩어리로 묶어 `월간 보스
    N개` 라고 적으면 메이린이 월간으로 둔갑한다 — 초기화 주기가 다른 보스를 같은 이름
    아래 두면 "다음 주에 또 도나"를 틀리게 읽는다.
  */
  const monthlyPlans = planned.filter((plan) => plan.cycle === "monthly");
  const seasonPlans = planned.filter((plan) => plan.cycle === "season");
  const weeklyRemaining = weeklyPlans.filter((plan) => !plan.isCleared).length;
  const remainingTotal = planned.filter((plan) => !plan.isCleared).length;

  /*
   * 빈 슬롯 개수.
   *
   * ★ **12를 코드에 박지 않는다**(§1). 상한은 뷰(`weekly_crystal_sell_limit()`)가 주고,
   *   뷰 행이 없으면 넥슨이 준 `weekly_boss_clear_limit_count` 를 쓴다. 둘 다 없으면
   *   빈 칸을 그리지 않는다 — 모르는 수를 지어내느니 계획 수만큼만 그린다.
   * ★ 값 자체는 뷰의 `weeklySlotsRemaining` 과 같지만, **그리드는 자기가 그린 칸 수와
   *   반드시 맞아야** 하므로 "상한 − 실제로 그린 칸"으로 낸다. 초과 여부의 판정은 여전히
   *   뷰의 `weeklyOverLimit` 하나뿐이다.
   */
  const weeklyLimit =
    progress !== null && progress.weeklyLimit > 0
      ? progress.weeklyLimit
      : clearLimit;
  const emptySlots =
    weeklyLimit === null ? 0 : Math.max(0, weeklyLimit - weeklyPlans.length);

  const chores = snapshot?.weeklyChores ?? [];

  /*
    ── 이 캐릭터에게 **얼마가 남았는가** ─────────────────────────────────────
    발주 지시(2026-08-27): *"각 캐릭터 별로 얼마씩 남았는지"*.

    "몇 개 남았나"는 이미 있었지만, 3개 남은 캐릭터와 3개 남은 다른 캐릭터의 무게가
    같지 않다 — 익검마 하나가 다른 열 개보다 크다. 개수만으로는 **어디부터 돌아야
    하는지**를 알 수 없어서, 사람이 매번 머릿속으로 시세를 곱하고 있었다.

    ★ **새 조회가 없다.** 시세는 게임 패치로만 바뀌는 코드 상수라(§2.4) 계획 행과
      곱하기만 하면 된다. 서버를 한 번 더 왕복할 값이 아니다.
    ★ 금액은 **개인 수령액**(`floor(솔로가 / 인원)`)이다. 솔로가를 그대로 쓰면 3인
      파티에서 3배 부풀고, 그 숫자를 보고 "여기부터 돌자"를 판단하게 된다(§1 · D3).
    ★ 가격 미확인은 **0 으로 더하지 않는다**(§1.3 D4). 합계에서 빠지고 건수로만 남는다.
  */
  const remainingMeso = useMemo(() => {
    const open = planned.filter((plan) => !plan.isCleared);
    const entries = getBossEntryMap(open.map((plan) => plan.bossDifficultyId));
    let known = 0;
    let unknown = 0;
    for (const plan of open) {
      const share = crystalShareMeso(
        entries.get(plan.bossDifficultyId)?.crystalPriceMeso ?? null,
        plan.defaultPartySize,
      );
      if (share === null) unknown += 1;
      else known += share;
    }
    return { known, unknown };
  }, [planned]);

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardOverline>
            {character.worldName ?? "월드 미상"}
            {character.isMain ? " · 본캐" : ""}
          </CardOverline>
          <CardTitle className="text-body-lg">{character.name}</CardTitle>
          {/*
            남은 금액을 **이름 바로 아래**에 둔다. 캐릭터를 고르는 기준이 되는 값이라,
            그리드 안이나 카드 끝에 있으면 열두 칸을 다 읽은 뒤에야 눈에 들어온다.
            다 잡았으면 금액 대신 그 사실을 말한다 — `0 메소 남음`은 읽기 나쁘다.
          */}
          {remainingTotal === 0 ? (
            <p className="text-body-sm text-success">이번 주 다 잡았습니다</p>
          ) : (
            <p className="text-body-sm text-ink-muted">
              남은 <Numeric>{remainingTotal}</Numeric>개 ·{" "}
              <MesoAmount
                value={remainingMeso.known}
                compact
                suffix={false}
                className="font-semibold text-ink"
              />
              {remainingMeso.unknown > 0 ? (
                <span className="text-ink-placeholder">
                  {" "}
                  (가격 미확인 {remainingMeso.unknown})
                </span>
              ) : null}
            </p>
          )}
        </div>

        {/*
          ═══════════════════════════════════════════════════════════════════════
          헤더 오른쪽 = **이 캐릭터에 대한 조작과 그 조작의 신선도**
          ═══════════════════════════════════════════════════════════════════════

          발주자 지시(2026-08-18): *"이 밑에 동떨어진 ui 없애고 위쪽에 새로고침 버튼
          옆에 수정 버튼을 만들어"* — 카드 맨 아래에 구분선 하나를 두고 `가는 보스 목록
          편집 →` 링크와 `기준 <시각>` 이 떠 있었다. 본문(12칸 그리드·숙제)과 아무
          관계가 없는 두 항목이 카드 끝에 붙어 있으니 붕 떠 보였고, 정작 같은 관심사인
          **새로고침 버튼과는 카드 하나만큼 떨어져** 있었다.

          그래서 셋을 한 자리로 모은다 —
            1) `보스 N/12` (읽는 값)
            2) **새로고침 · 보스 목록 수정** (하는 일). `character-income-card` 가 이미
               잡아 둔 규약과 같다: 카드 헤더 오른쪽, `secondary` · `sm`, 아이콘 + 라벨.
            3) `기준 <시각>` (그 값이 언제 것인지)

          ★ **`기준 <시각>` 을 버리지 않는다.** 넥슨 데이터는 ~15분 지연되고 전일분은
            다음날 02:00 에 들어온다(§1.1). "방금 잡았는데 왜 안 보이지"를 사용자가
            판단할 수 있는 단서가 이 값 하나뿐이다. 그리고 **툴팁으로 숨기지 않는다** —
            터치 기기에는 hover 가 없어 그대로 사라진다. 새로고침 버튼 **바로 아래**에
            두는 이유도 같다: 신선도와 새로고침은 하나의 관심사다.
            12px(`text-caption`)은 §4 가 허용한 **수치 주석** 용도이며 문장이 아니다.

          ★ **360px 대응.** 버튼이 하나 늘었으므로 폭이 확정적이지 않다. 바깥 줄이
            `flex-wrap` 이라 좁아지면 이 블록이 통째로 다음 줄로 내려가 카드 안쪽
            폭(≈296px)을 전부 쓰고, 그래도 모자라면 버튼 줄 자체가 한 번 더 접힌다.
            그래서 `shrink-0` 을 **떼고** `min-w-0` 을 준다 — `shrink-0` 이면 줄어들
              여지가 없어 접히는 대신 카드 밖으로 삐져나간다(`layout.tsx` 상단 바가
              같은 이유로 `min-w-0` + `shrink-0` 을 나눠 쓴다).
        */}
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          {hasCounter ? (
            /*
              ★ 이 화면에서 가장 자주 읽는 숫자다. 캐릭터 섹션이 세로로 쌓이므로
                `10/12` 와 `9/12` 의 자릿수가 어긋나면 훑어보기가 무너진다.
                `보스` 는 한글이라 mono 밖에 둔다 — 안에 넣으면 폴백 서체로 떨어진다.
            */
            <p className="font-headline text-body-lg font-semibold text-ink tabular-nums">
              보스{" "}
              <Numeric>
                {clearCount}/{clearLimit}
              </Numeric>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {/*
              ★ 키 선택의 열쇠를 그대로 넘긴다. 버튼이 저장소에서 **이 캐릭터의 계정 키**를
                꺼내고, 없으면 버튼 대신 조치를 안내한다(§2.1 — 사람 한 명에 계정 여럿).
                스냅샷이 없으면 라벨이 `지금 불러오기` 로 갈리는 것도 그대로다 —
                한 번도 안 불러온 캐릭터에게 `새로고침` 은 무엇을 하는지 말해 주지 않는다.
            */}
            <SyncButton
              characterId={character.characterId}
              credentialId={character.credentialId}
              credentialLabel={character.credentialLabel}
              serverKeyAvailable={character.serverKeyAvailable}
              onSync={onSync}
              isPending={isPending}
              label={snapshot === null ? "지금 불러오기" : "새로고침"}
            />

            {/*
              ★ 라벨은 `수정` 이 아니라 **`보스 목록 수정`** 이다. 발주자 표현은 "수정
                버튼"이었지만, 바로 옆이 `새로고침` 이라 `수정` 만 적으면 *무엇을* 고치는
                버튼인지 이 자리에서 알 수 없다(캐릭터명? 인원수? 숙제?). 아이콘만 두고
                `aria-label` 로 때우는 방식도 쓰지 않는다 — 툴팁은 터치 기기에서 사라지고,
                좁은 화면일수록 오히려 라벨이 필요하다. 연필 아이콘은 보조 채널이다.
              ★ `Link` 로 감싼 `Button` 은 `my-parties-card` 의 `겹쳐보기 열기` 와 같은
                형태다. 이동이므로 링크 시맨틱과 prefetch 를 유지한다.
            */}
            <Link
              href={`/boss-plans?characterId=${encodeURIComponent(character.characterId)}`}
              className="shrink-0"
            >
              <Button variant="secondary" size="sm">
                <Pencil aria-hidden size={14} />
                보스 목록 수정
              </Button>
            </Link>
          </div>

          {snapshot === null ? null : (
            <span
              className="text-caption text-ink-muted"
              title={`불러온 시각 ${formatKstFull(new Date(snapshot.fetchedAt))}`}
            >
              기준{" "}
              <NumericText>
                {formatKstFull(new Date(snapshot.snapshotAt))}
              </NumericText>
            </span>
          )}
        </div>
      </div>

      {/*
        12개 초과 경고 (난제 16-3).

        ★ 서버가 13번째 **켜기**는 거절하지만, 이미 초과한 상태와 동기화가 넣은
          `api_registered` 는 그대로 남는다. 그래서 이 경고를 그리지 않으면 사용자는
          입장조차 못 하는 계획을 세워 두고도 모른다. 판정은 뷰가 한 것을 그대로 읽는다.
        ★ 색은 §4 대로 **tertiary orange** 다 — red 는 실패·취소 전용이다. 그리고
          주황은 **배경과 아이콘**이 지고 문장은 잉크가 진다(주황 본문은 라이트에서 AA 미달).
      */}
      {progress?.weeklyOverLimit === true ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            주간 보스 계획이 {progress.plannedWeekly}개로 상한(
            {progress.weeklyLimit}개)을 넘었습니다. 넘긴 만큼은 입장 자체가
            불가능하니{" "}
            {/*
              ★ **위치를 가리키지 않는다.** 예전 문구는 `아래 …편집에서` 였는데 버튼이
                헤더로 올라가면서 곧바로 틀린 말이 됐다. 버튼 라벨만 그대로 부르면
                버튼이 또 옮겨져도 문장이 틀리지 않는다.
            */}
            <strong className="font-semibold">
              &lsquo;보스 목록 수정&rsquo;에서{" "}
              {progress.plannedWeekly - progress.weeklyLimit}개를 꺼 주세요.
            </strong>{" "}
            한 번 끄면 동기화해도 다시 켜지지 않습니다. 월간 보스는 이 개수에
            들어가지 않습니다.
          </span>
        </p>
      ) : null}

      {/*
        인게임 목록과의 **진짜** 차이만 여기서 한 번 말한다.

        ★ 칸마다 배지를 다는 방식으로 돌아가지 않는다 — 12칸 그리드에서 그러면 글자밭이
          되고, 무엇보다 §1.1 대로 우리는 인게임 스케줄러에 쓸 수 없어서 사용자가
          칸에서 할 수 있는 일이 없다. 조치는 문장으로 한 번, 위치는 칸 모서리 아이콘.
        ★ `pending`(우리 설정이 더 최신 = 반영 대기)은 여기에도 그리지 않는다.
          대시보드는 훑어보는 화면이고, 곧 저절로 사라질 상태로 자리를 먹으면 안 된다.
          설명이 필요한 사용자는 &lsquo;보스 목록 수정&rsquo;에서 문장을 본다.
        ★ §4: 주황은 배경·아이콘이 지고 **문장은 잉크**다. red 는 실패·취소 전용.
      */}
      {progress !== null && progress.conflictDivergedCount > 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>{divergedSummarySentence(progress.conflictDivergedCount)}</span>
        </p>
      ) : null}

      {snapshot === null ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="아직 불러오지 않았습니다"
          description="인게임 스케줄러에서 이 캐릭터의 보스 등록·클리어 상태를 가져옵니다. 캐릭터당 넥슨 API 를 1회 호출합니다."
          className="py-6"
        />
      ) : planned.length === 0 ? (
        /* 빈 상태는 "0개 했다"가 아니라 "아직 셀 것이 없다"로 말한다. */
        <p className="text-body-sm text-ink-muted">
          이번 주에 갈 보스로 켜 둔 항목이 없습니다. 인게임 스케줄러에서 보스를
          등록하거나, &lsquo;보스 목록 수정&rsquo;에서 직접 켤 수 있습니다.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {remainingTotal === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-chip-done-border bg-chip-done-bg px-3 py-1.5 text-body-sm text-ink">
              <CheckCircle2
                aria-hidden
                size={16}
                className="shrink-0 text-chip-done-fg"
              />
              <span>등록한 보스를 이번 주에 전부 잡았습니다.</span>
            </div>
          ) : null}

          {weeklyPlans.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-caption text-ink-label">
                주간 보스 {weeklyPlans.length}개 · 남은 {weeklyRemaining}개
                {emptySlots > 0 ? ` · 빈 슬롯 ${emptySlots}개` : ""}
              </p>
              <BossGrid plans={weeklyPlans} emptySlots={emptySlots} />
            </div>
          ) : null}

          {monthlyPlans.length > 0 ? (
            /*
              월간은 **구획을 나누는 것으로** 12 카운터 밖임을 말한다. 예전에는 칸마다
              카운터 관련 배지를 달았는데 발주자 지시로 뺐다 — 검은 마법사가 여기 따로
              있다는 사실만으로 충분하다.
            */
            <div className="flex flex-col gap-1.5">
              <p className="text-caption text-ink-label">
                월간 보스 {monthlyPlans.length}개
              </p>
              <BossGrid plans={monthlyPlans} />
            </div>
          ) : null}

          {/*
            시즌 — **주간마다 초기화되지만 12칸을 안 먹는다**(§1). 그래서 위 12칸
            그리드에도, 월간 구획에도 들어가지 않는다. 라벨에 그 사실을 적는다:
            개수만 적으면 "왜 위 12칸에 없지"가 된다.
          */}
          {seasonPlans.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-caption text-ink-label">
                시즌 보스 {seasonPlans.length}개{" "}
                <span className="text-ink-muted">· 12칸에 안 들어감</span>
              </p>
              <BossGrid plans={seasonPlans} />
            </div>
          ) : null}
        </div>
      )}

      {/*
        ⚠️ 여기에 있던 **카드 하단 구분선 줄은 없앴다** (발주자 지시, 2026-08-18).
           `가는 보스 목록 편집 →` 링크는 헤더의 `보스 목록 수정` 버튼이 되었고,
           `기준 <시각>` 은 새로고침 버튼 바로 아래로 올라갔다. 둘 다 본문(12칸
           그리드 · 숙제)과 무관한 항목이라 본문 끝에 붙어 있을 이유가 없었다.
           다시 아래로 내리지 말 것 — 같은 관심사(갱신·신선도)는 한 자리에 둔다.
      */}
      <ChoreSection chores={chores} />
    </Card>
  );
}

/**
 * 빈 목록 상수. 매 렌더 새 배열을 만들면 `useSchedulerAutoSync` 의 의존성이 매번 바뀐다.
 */
const EMPTY_CHECKLIST: readonly CharacterChecklist[] = [];

export interface WeeklyChecklistProps {
  readonly className?: string;
}

export function WeeklyChecklist({ className }: WeeklyChecklistProps) {
  const queryClient = useQueryClient();

  /**
   * ★ **`initial` props 를 받지 않는다** (§2.4 Rule 1). 예전에는 서버 컴포넌트가 읽은
   *   배열을 `initialData` 로 받았는데, `initialDataUpdatedAt` 이 없어 그 값은 캐시에서
   *   **영원히 신선한 것**으로 취급됐다 — 동기화 뒤 무효화해도 다시 그 값으로 돌아갈 수
   *   있는 구조였다. 지금은 페이지가 같은 데이터를 요청 범위 QueryClient 에 심어
   *   `dehydrate` 하고, 하이드레이션이 `dataUpdatedAt` 까지 함께 실어 온다.
   *
   * 티어: db(60초). 이 조회는 **넥슨 호출 0건**이다 — 우리 DB 의 마지막 동기화 결과다.
   */
  const checklistQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.bossPlans.checklist()),
    queryFn: async () => (await fetchWeeklyChecklist()).characters,
  });

  /**
   * 수동 새로고침. **신선도 가드를 우회한다** — 사용자가 명시적으로 눌렀기 때문이다
   * ("방금 잡았으니 지금 갱신"). 다만 `paceNexonRequest` 는 우회하지 못한다:
   * 우회해도 되는 것은 *우리* 규칙이지 넥슨의 초당 5콜 한도가 아니다.
   */
  const sync = useMutation({
    mutationFn: (input: {
      readonly apiKey: string | null;
      readonly characterId: string;
    }) =>
      /*
        ★ `force: true` — **서버 캐시를 건너뛴다** (2026-08-24, §0.2-1 동일 적용).
          이 버튼은 사람이 "지금 갱신하라"고 누른 것인데, 게이트웨이가 응답을 15분 캐시하고
          그 읽기는 TTL 을 다시 보지 않으므로 **누르고도 넥슨을 부르지 않고 같은 옛 값**을
          돌려주고 있었다. 머리말에 *"수동 새로고침 버튼 — 가드를 우회한다"* 고 적혀 있었지만
          우회되던 것은 클라이언트 신선도 가드뿐이었다.
          자동 경로(진입 시 동기화 · 밤 크론 · 런 종료 후)는 켜지 않는다 — 그쪽까지
          우회하면 캐시가 존재할 이유가 없어지고 쿼터만 탄다.
      */
      paceNexonRequest(() => syncCharacterScheduler({ ...input, force: true })),
    onSuccess: (result) => {
      /*
       * 자동 경로가 "이 캐릭터는 지금 키로 못 읽는다"고 기억해 뒀더라도, 수동으로
       * 성공했으면 그 기억은 틀린 것이다. 지워야 다음 진입에서 자동으로도 돈다.
       */
      forgetSyncFailure(result.characterId);
      /*
       * 계획·클리어·스냅샷이 한꺼번에 바뀐다. 계획 화면 캐시까지 함께 무효화한다.
       *
       * ★ **수익과 대시보드도 함께.** 동기화는 인게임 `complete_flag` 를 읽어 클리어를
       *   기록하므로(`clearRecordedCount`) 결정석 합계와 12칸 분자가 같이 움직인다.
       *   예전에는 이 둘이 빠져 있어서, 동기화 직후 체크리스트만 갱신되고 바로 위
       *   수익 카드는 옛 금액을 말했다.
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.bossPlans.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.income.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
    },
  });

  const characters = checklistQuery.data ?? EMPTY_CHECKLIST;

  /**
   * 진입 시 자동 갱신 1회. 훅 안에서 신선도 가드 · 직렬화 · 실패 격리를 전부 처리하므로
   * 이 컴포넌트는 **표시만** 한다.
   */
  const autoSync = useSchedulerAutoSync(characters);

  /*
   * **키 없음은 실패가 아니다.** 넥슨을 부르지도 않았으므로 "갱신을 마치지 못했다"가
   * 아니라 "그 계정 키가 이 브라우저에 없다"이며, 조치도 다르다(키 입력 vs 기다리기).
   * 그래서 별도 문단으로 뽑는다.
   */
  const missingKeyEntries = autoSync.summary?.missingKey ?? [];
  const missingKeyNames = missingKeyEntries
    .map((entry) => entry.characterName)
    .join(", ");
  /*
   * 문장은 **첫 항목 기준 하나만** 쓴다. 캐릭터마다 한 줄씩 늘어놓으면 읽히지 않고,
   * 어차피 조치는 "계정 · 키 관리에서 그 키를 입력하라"로 같다. 캐릭터별로 더 정확한
   * 안내가 필요하면 각 카드의 `SyncButton` 자리에 이미 들어 있다.
   */
  const firstMissingKey = missingKeyEntries[0] ?? null;
  const missingKeySentence =
    firstMissingKey === null
      ? ""
      : formatSyncFailure(missingKeyNotice(firstMissingKey));

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ListChecks aria-hidden size={18} className="text-primary" />
          <h2 className="font-headline text-body-lg font-semibold text-ink">
            이번 주 체크리스트
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            갱신 중 인디케이터.

            ★ 조용히 값이 바뀌면 사용자는 무슨 일이 일어났는지 모른다. 그렇다고 로딩
              화면으로 덮으면 진입할 때마다 화면이 사라진다 — 저장된 데이터는 이미 떠
              있으므로 **자리를 차지하지 않는 작은 표시**만 둔다.
          */}
          {autoSync.isSyncing ? (
            <span
              className="flex items-center gap-1.5 text-caption text-ink-muted tabular-nums"
              role="status"
            >
              <Loader2 aria-hidden size={14} className="animate-spin" />
              인게임 스케줄러 갱신 중 {autoSync.progress.done}/
              {autoSync.progress.total}
            </span>
          ) : null}
          <span className="text-body-sm text-ink-muted tabular-nums">
            추적 {characters.length}명
          </span>
        </div>
      </div>

      {/*
        ═══════════════════════════════════════════════════════════════════════
        자동 갱신 결과 알림 — **원인이 다르면 문단도 다르다**
        ═══════════════════════════════════════════════════════════════════════

        예전에는 모든 실패가 한 문장으로 뭉개져 "넥슨 API 가 요청을 거절했습니다.
        캐릭터명이나 조회 날짜를 확인해 주세요"가 떴다. **캐릭터명도 날짜도 멀쩡했고**,
        진짜 원인은 그 캐릭터가 속한 계정의 키가 이 브라우저에 없다는 것이었다.
        원인이 다르면 조치도 다르므로 두 문단으로 나눈다.

        ★ `ErrorState` 로 대체하지 않는다. 어느 쪽이든 **저장된 데이터는 멀쩡하고 화면은
          계속 쓸 수 있다.** 여기서 에러 화면을 띄우면 넥슨이 흔들릴 때마다 대시보드가
          통째로 사라진다.
        ★ 색은 §4 대로 tertiary orange(배경·아이콘) — red 는 실패·취소 전용이다.
          문장은 잉크가 진다(주황 본문은 라이트에서 AA 미달). 14px 이상.
      */}
      {!autoSync.isSyncing && missingKeyEntries.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
          <KeyRound
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <p className="min-w-0 flex-1 text-body-sm text-ink">
            {missingKeyNames} — {missingKeySentence} 아래 내용은 마지막으로 저장된
            값입니다.
          </p>
          {/*
            ★ **동선.** 원인만 말하고 끝내면 사용자는 어디로 가야 할지 모른다.
              같은 문단 안에서 키를 넣을 수 있어야 한다.
          */}
          <CredentialDialogButton label="키 입력하기" />
        </div>
      ) : null}

      {!autoSync.isSyncing && autoSync.summary?.failure != null ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            자동 갱신을 마치지 못했습니다 — {autoSync.summary.failureMessage} 아래
            내용은 마지막으로 저장된 값입니다.
            {autoSync.summary.succeeded > 0
              ? ` (${autoSync.summary.succeeded}/${autoSync.summary.attempted}명은 갱신됨)`
              : ""}
          </span>
        </p>
      ) : null}

      {/*
        수동 새로고침 실패도 같은 표를 쓴다. 자동과 수동이 다른 문장을 내면 사용자는
        같은 사건을 두 번 다르게 배운다.
      */}
      {sync.isError ? (
        <ErrorState
          title="인게임 스케줄러를 불러오지 못했습니다"
          description={formatSyncFailure(describeSyncFailure(sync.error))}
          className="py-6"
        />
      ) : null}

      {sync.isSuccess && !sync.isPending ? (
        <p className="rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
          {sync.data.characterName} 동기화 완료 — 보스 {sync.data.bossEntryCount}
          건 확인 · 계획 {sync.data.planUpdatedCount}건 · 클리어{" "}
          {sync.data.clearRecordedCount}건 반영
          {sync.data.unmappedCount > 0
            ? ` · 미확인 보스 ${sync.data.unmappedCount}건은 건너뛰었습니다`
            : ""}
          {` · 넥슨 호출 ${sync.data.nexonCallsUsed}회`}
        </p>
      ) : null}

      {checklistQuery.isError ? (
        <ErrorState
          title="체크리스트를 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={() => void checklistQuery.refetch()}
        />
      ) : checklistQuery.isLoading ? (
        <SkeletonGroup label="체크리스트를 불러오는 중">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-48" />
          ))}
        </SkeletonGroup>
      ) : characters.length === 0 ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="추적 중인 캐릭터가 없습니다"
          description="보스를 도는 캐릭터를 고르면 그 캐릭터의 주간 보스와 숙제가 여기에 정리됩니다. 고른 캐릭터만 인게임 스케줄러와 동기화됩니다."
          action={<CharacterPickerTrigger label="캐릭터 선택하기" />}
        />
      ) : (
        /*
          ── 가로에서는 **열이 아니라 카드를 늘린다** ─────────────────────────
          발주 질문(2026-08-27): *"세로는 이런느낌이 좋아보이긴하는데 가로는 뭐가
          좋을지 모르겠어"*.

          답: **12칸 격자는 6열 그대로 두고, 캐릭터 카드를 다단으로 놓는다.**
          이유는 격자 쪽 근거와 한 짝이다 — 폭이 넓다고 12칸을 12열로 펴면 "12칸 =
          이번 주 전부"라는 덩어리가 한 줄로 늘어져 오히려 세기 어려워지고, 같은 화면이
          기기마다 다른 모양이 된다. 카드는 반대다: 카드가 하나의 완결된 단위(캐릭터
          하나)라 옆으로 여러 개를 놓아도 각각은 그대로 읽힌다.

          그리고 카드가 조밀해진 덕분에 다단이 실제로 가능해졌다 — 예전 카드는 12칸이
          3행이라 세로로 길어서, 2단으로 놓으면 좌우 높이가 크게 어긋났다.
          2xl 에서 3단까지 가는 것은 캐릭터가 6~7명인 실제 계정 기준으로 두 줄에
          들어오기 때문이다.
        */
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {characters.map((entry) => (
            <CharacterSection
              key={entry.character.characterId}
              entry={entry}
              onSync={(input) => sync.mutate(input)}
              isPending={
                sync.isPending &&
                sync.variables?.characterId === entry.character.characterId
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
