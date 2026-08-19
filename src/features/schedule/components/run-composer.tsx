"use client";

import {
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ListChecks,
  RotateCw,
  Search,
  Swords,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";

import {
  BOSS_DIFFICULTY_LABEL,
  BossIcon,
  MesoAmount,
  NumericText,
  formatKstShort,
} from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
  StatusChip,
} from "@/components/ui";
import type { CharacterBossPlan } from "@/features/boss-plans/types";
import { formatDayMinute, kstMoment } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  BossCatalogEntry,
  BossDifficultyId,
  CreateRunBundleInput,
  OverlapWindow,
  PartyBoss,
  PartyId,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";
import type { DayRow } from "../lib/overlay-layout";
import {
  DEFAULT_DURATION_MINUTES,
  FIXED_PARTY_WEEKS,
} from "../lib/run-defaults";

/**
 * 오른쪽 패널 — 겹치는 시간대를 골라 보스 일정을 등록한다 (§1.4).
 *
 * 규칙:
 * - **파티 인원수**(`entry_party_size`)는 "실제로 몇 명이 입장했는가"이며 기본값은
 *   선택된 참가자 수(겹침 창을 고르면 그 창에서 가능한 인원)이고 **수정 가능**하다 (§1.3 D3).
 * - **`max_party` 초과를 막지 않는다.** 소프트 상한이라 경고만 한다 (§1.3 D5).
 *   경고 색은 tertiary orange 다 — red 는 실패·취소 전용(§4).
 * - **예상 수익 = `floor(솔로가 / 인원)`.** 가격이 `null` 인 보스는 "미확인"이며
 *   **0 으로 표시하지 않는다** (§1.3 D4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 보스는 **여러 개를 체크한다** (발주 요구, 2026-08-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"보통 묶어서 가니 파티안에 보스를 여러개 등록 하고 시간 등록할때 등록된 보스를
 * 체크해서 시간대를 등록하게 만들어."*
 *
 * 그래서 목록의 첫 칸이 **이 파티에 등록된 보스**이고 기본값은 전부 체크다. 체크한
 * 보스들은 **시작 시각 하나로 연달아** 잡힌다 — 익세 21:00 · 하대 21:30 · 하카 22:00.
 * 같은 시각으로 몰아넣으면 겹쳐보기 화면에서 막대가 정확히 포개져 아무것도 못 읽는다.
 *
 * ⚠️ 배치 규칙(`시작 + 소요 × i`)의 **저장 주체는 서버**다. 여기서는 같은 식으로
 *    **미리보기만** 그린다. 시각을 미리 벌려 보내면 규칙이 두 곳에 생긴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스 목록의 차례 — 파티 → 인게임 스케줄러 → 전체 (§1.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 카탈로그 54개를 그대로 늘어놓으면 실제로 고를 것을 찾기 어렵다. 그래서
 *   ① **이 파티가 묶어서 도는 보스**(`party_bosses`) — 대부분 여기서 끝난다. 펼쳐 둔다
 *   ② 그 캐릭터가 **매주 가는 보스**(넥슨 `registration_flag` → `v_character_boss_plan_status`)
 *      — **접어 둔다**
 *   ③ 나머지 전체 — 접어 둔다
 * 순으로 놓는다.
 *
 * ★ ②를 접는 이유(발주자 지시, 2026-08-18): 파티에 보스를 등록하는 기능이 생긴 뒤로
 *   "묶어서 도는 보스"는 ①이 맡는다. ②는 보조 수단이 됐고, 셋이 전부 펼쳐져 있으면
 *   정작 대부분의 경우에 쓰는 ①이 아래로 밀린다. 접힘 기본값의 예외는
 *   `plannedVisible` 주석에 적었다(파티 보스가 없을 때 · 이미 체크된 것이 있을 때).
 *
 * ★ ①·②·③ 어디에 있든 **고를 수 있다.** 즉흥으로 가는 경우가 실제로 있어서다 —
 *   막는 것과 뒤로 미는 것은 다르다.
 * ★ **이번 주 클리어 여부(`isCleared`)를 목록에 붙인다.** 이미 잡은 보스를 또 등록하는
 *   것은 대개 실수이고, 결정석은 캐릭터당 주 1회라 수익이 중복 집계된다.
 * ★ **판정을 TS 에서 다시 만들지 않는다.** `isActive` 와 `isCleared` 는 전부 뷰가 낸 값이다.
 * ★ 등록 순서는 **화면에 보이는 차례 그대로**다. 클릭한 순서가 아니다 — 체크를 풀었다
 *   다시 켰다고 도는 순서가 바뀌면 사용자가 이유를 알 수 없다.
 */

/**
 * 등록 폼의 소요 시간 기본값이자 **연속 배치 간격**의 기본값.
 * 값과 그 근거(DB 기본값 30 과 왜 다른지)는 `lib/run-defaults.ts` 가 소유한다.
 */
export { DEFAULT_DURATION_MINUTES };

const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

/** 별칭·줄임말까지 훑는 검색. 봇의 `!등록 하카 21시` 와 같은 어휘를 화면에서도 쓴다. */
function matchesBoss(boss: BossCatalogEntry, query: string): boolean {
  if (query === "") return true;
  const haystack = [
    boss.koreanName,
    boss.bossKoreanName,
    boss.shortName,
    boss.bossDifficultyId,
    ...boss.aliases,
  ].map(normalizeQuery);
  return haystack.some((value) => value.includes(query));
}

function minutesFromTimeText(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * 연속 배치 미리보기의 시각 표기. 자정을 넘기면 `익일 00:30` 으로 풀어 쓴다 —
 * `24:30` 은 존재하지 않는 시각이고, 다음 날이라는 사실이 일정에서는 중요하다.
 */
function formatRunStart(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const clock = formatDayMinute(minutes - days * 1440);
  if (days === 0) return clock;
  if (days === 1) return `익일 ${clock}`;
  return `+${days}일 ${clock}`;
}

/**
 * `PartyBoss` → `BossCatalogEntry`. 파티에 등록된 보스가 카탈로그에 없을 때만 쓴다
 * (일간 보스가 등록돼 있는 경우 — 서버가 카탈로그에서 일간을 빼기 때문에 실제로 생긴다).
 * **버리지 않는 것이 핵심이다** — 조용히 사라지면 체크할 항목이 없어져 등록이 막힌다.
 */
function partyBossAsEntry(boss: PartyBoss): BossCatalogEntry {
  return {
    bossDifficultyId: boss.bossDifficultyId,
    bossId: boss.bossDifficultyId,
    koreanName: boss.koreanName,
    bossKoreanName: boss.bossKoreanName,
    shortName: boss.shortName,
    difficulty: boss.difficulty,
    cycle: boss.cycle,
    maxParty: boss.maxParty,
    crystalPriceMeso: boss.crystalPriceMeso,
    released: true,
    aliases: [],
  };
}

export interface RunComposerProps {
  readonly partyId: PartyId;
  readonly dayRows: readonly DayRow[];
  /**
   * 고를 수 있는 보스 전부 — `getTrackedBossCatalog()` (코드 상수) 가 준 그대로.
   *
   * ★ **여기서 다시 거르지 않는다.** 일간 보스는 `@/lib/boss-master` 가 이미 뺐고
   *   (`@/lib/domain/boss-scope`), 화면이 같은 판정을 한 번 더 적으면 규칙이 두 벌이 된다.
   */
  readonly bosses: readonly BossCatalogEntry[];
  /**
   * **이 파티가 묶어서 도는 보스** (`party_bosses`) — 순서 그대로.
   * 비어 있으면 파티 편집 창에서 등록하라고 안내하고 아래 목록으로 물러난다.
   */
  readonly partyBosses: readonly PartyBoss[];
  readonly isPartyBossLoading: boolean;
  readonly isPartyBossError: boolean;
  readonly onPartyBossRetry: () => void;
  /** 파티 편집 창 열기 — 보스가 하나도 없을 때의 유일한 행동 유도다. */
  readonly onEditPartyBosses: () => void;
  /**
   * 선택된 캐릭터가 **매주 가는 보스** — 뷰 `v_character_boss_plan_status` 의 행 그대로.
   *
   * 캐릭터를 바꾸면 이 배열이 그 캐릭터 것으로 통째로 갈리므로 목록도 따라 바뀐다.
   * 비어 있는 것은 **정상**이다(동기화 전 / 계획 없음).
   */
  readonly plans: readonly CharacterBossPlan[];
  readonly isPlanLoading: boolean;
  readonly isPlanError: boolean;
  readonly onPlanRetry: () => void;
  /**
   * 일정에 데려갈 수 있는 내 추적 캐릭터 (§2.1.1).
   * 비어 있으면 등록 자체가 불가능하다 — 캐릭터 없는 일정은 결정석 집계에 못 들어간다.
   */
  readonly characters: readonly RunCharacterOption[];
  readonly isCharacterLoading: boolean;
  readonly isCharacterError: boolean;
  readonly onCharacterRetry: () => void;
  /** 비로그인이면 캐릭터를 고를 수 없다 — 등록 자체가 세션을 요구한다. */
  readonly isSignedIn: boolean;
  /** 선택된 캐릭터. 부모가 들고 있어 목록이 도착하면 기본값(본캐)을 채운다. */
  readonly characterId: string | null;
  readonly onCharacterIdChange: (characterId: string) => void;
  /** 왼쪽 패널에서 고른 겹침 창. 없으면 사용자가 직접 시각을 넣는다. */
  readonly selectedWindow: OverlapWindow | null;
  /** 선택된 파티원 전체. 겹침 창이 없을 때의 기본 참가자다. */
  readonly selectedPersonIds: readonly PersonId[];
  /**
   * 일정 초안(체크한 보스·날짜·시각·인원·소요)은 **부모가 들고 있다.**
   * 왼쪽 패널에서 겹침 막대를 누르는 것도 이 값을 바꾸는 행위이고, 파티를 바꾸면
   * 초안 전체가 그 파티 것으로 리셋돼야 한다. 폼 안에 두고 effect 로 동기화하면
   * 부모 이벤트 → 자식 effect → 재렌더의 연쇄가 생긴다.
   */
  readonly selectedBossIds: readonly BossDifficultyId[];
  readonly onSelectedBossIdsChange: (
    next: readonly BossDifficultyId[],
  ) => void;
  readonly dayKey: string;
  readonly onDayKeyChange: (dayKey: string) => void;
  readonly timeText: string;
  readonly onTimeTextChange: (timeText: string) => void;
  readonly partySizeText: string;
  readonly onPartySizeTextChange: (value: string) => void;
  /** 보스 하나당 소요 시간(분). **연달아 배치되는 간격**이기도 하다. */
  readonly durationText: string;
  readonly onDurationTextChange: (value: string) => void;
  readonly onSubmit: (input: CreateRunBundleInput) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
  /** 파티가 선택되지 않았으면 등록할 대상이 없다. */
  readonly disabled?: boolean;
}

interface BossRow {
  readonly boss: BossCatalogEntry;
  /** 이 캐릭터가 **이번 주에** 이미 잡았는가. ← 뷰 `v_character_boss_plan_status.is_cleared` */
  readonly cleared: boolean;
}

interface BossCheckRowProps {
  readonly row: BossRow;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

/**
 * 목록 한 줄. 세 칸(파티 · 매주 가는 보스 · 전체)이 **같은 모양**이어야 눈이 헷갈리지 않는다.
 *
 * 🖼️ 아이콘은 `BossIcon` 이 그린다. 파일이 없는 보스는 실루엣으로 떨어지지만 자리 크기는
 *    같아서 목록의 세로 리듬이 흔들리지 않는다 — **없는 것도 정상 상태다**(§2.1.1).
 *
 * `<label>` 로 감싸 줄 전체가 체크 영역이다. 360px 에서 16px 체크박스만 눌러야 하면
 * 실수로 다른 줄을 켜게 된다.
 */
function BossCheckRow({ row, checked, disabled, onToggle }: BossCheckRowProps) {
  const { boss } = row;
  return (
    <li className="border-b border-neutral-100 last:border-b-0">
      <label
        className={cn(
          /*
           * `cursor-pointer` 는 `globals.css` base 규칙
           * (`label:has(input[type="checkbox"]:not(:disabled))`)이 잡는다.
           * 비활성 커서만 유틸리티로 남긴다 — 유틸리티는 base 를 항상 이긴다.
           */
          "group flex w-full items-center gap-2.5 px-3 py-2.5",
          "transition duration-200",
          /*
           * ⚠️ hover 면이 `background` 였다. 카드 표면 대비 **1.04:1** 로 사실상 무변화라
           *    "이 줄을 누를 수 있다"가 전혀 보이지 않았다. `hover-strong` 은 1.245:1.
           *    체크된 줄은 hover 가 아예 없었다 → `primary-subtle-hover` 를 준다.
           */
          checked
            ? "bg-primary-subtle hover:bg-primary-subtle-hover"
            : "hover:bg-hover-strong",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="shrink-0"
        />
        <BossIcon
          bossDifficultyId={boss.bossDifficultyId}
          difficulty={boss.difficulty}
          size="sm"
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-body-sm",
              checked ? "text-primary" : "text-ink",
            )}
          >
            {boss.koreanName}
          </span>
          <span className="shrink-0 rounded-full border border-border bg-neutral-100 px-1.5 text-overline text-ink-label">
            {boss.shortName}
          </span>
          {boss.released ? null : (
            <span className="shrink-0 text-overline text-tertiary-ink">
              미출시
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {row.cleared ? (
            <StatusChip
              status="done"
              icon={<CheckCircle2 aria-hidden size={13} />}
            >
              이번 주 완료
            </StatusChip>
          ) : null}
          {/* hover 면 위에서 `ink-muted` 는 3.88:1 이라 `ink-label` 로 같이 올린다. */}
          <MesoAmount
            value={boss.crystalPriceMeso}
            compact
            suffix={false}
            tone="muted"
            className="text-caption group-hover:text-ink-label"
          />
        </span>
      </label>
    </li>
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 묶음 하나를 접었다 펴는 토글 — **접히는 영역 둘이 같은 모양을 쓴다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 패널에는 접히는 목록이 둘이다(② 이 캐릭터가 매주 가는 보스 · ③ 그 밖의 보스).
 * 열림/닫힘 표시나 클릭 동작이 조금이라도 다르면 하나는 "접혔다", 하나는 "사라졌다"로
 * 읽힌다. 그래서 규칙을 여기 한 곳에 둔다 (§0.2-1 — 같은 결의 문제는 같이 고친다).
 *
 *   꺾쇠가 **맨 앞**(열림 ▲ / 닫힘 ▼) → 묶음 아이콘 → 이름 → `· N개`
 *   그리고 그 안에 체크된 보스가 있으면 `· 선택 N개`
 *
 * `선택 N개` 를 붙이는 이유: 접힌 안에 체크된 보스가 숨으면 사용자는 자기가 무엇을
 * 등록하는지 모른 채 버튼을 누르게 된다. 접어도 **그 사실만은 표면에 남긴다**
 * (등록될 보스의 전체 이름은 폼 맨 아래 요약이 언제나 늘어놓는다).
 */
function BossGroupToggle({
  open,
  onToggle,
  icon: Icon,
  label,
  count,
  selectedCount,
  controls,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  readonly selectedCount: number;
  readonly controls: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="self-start"
    >
      {open ? (
        <ChevronUp aria-hidden size={14} />
      ) : (
        <ChevronDown aria-hidden size={14} />
      )}
      <Icon aria-hidden size={14} className="text-primary" />
      {label} · {count}개
      {selectedCount > 0 ? ` · 선택 ${selectedCount}개` : ""}
    </Button>
  );
}

export function RunComposer({
  partyId,
  dayRows,
  bosses,
  partyBosses,
  isPartyBossLoading,
  isPartyBossError,
  onPartyBossRetry,
  onEditPartyBosses,
  plans,
  isPlanLoading,
  isPlanError,
  onPlanRetry,
  characters,
  isCharacterLoading,
  isCharacterError,
  onCharacterRetry,
  isSignedIn,
  characterId,
  onCharacterIdChange,
  selectedWindow,
  selectedPersonIds,
  selectedBossIds,
  onSelectedBossIdsChange,
  dayKey,
  onDayKeyChange,
  timeText,
  onTimeTextChange,
  partySizeText,
  onPartySizeTextChange,
  durationText,
  onDurationTextChange,
  onSubmit,
  isSubmitting,
  submitError,
  disabled = false,
}: RunComposerProps) {
  const searchId = useId();
  const dayId = useId();
  const timeId = useId();
  const sizeId = useId();
  const durationId = useId();
  const characterFieldId = useId();
  /** 접히는 두 목록의 id — 토글이 `aria-controls` 로 짚는다. */
  const plannedListId = useId();
  const catalogListId = useId();

  const fixedPartyHintId = useId();

  /**
   * 고정팟 — **매주 같은 시간에 가는 파티** (2026-08-19 발주자: *"보스 일정 등록할때
   * 고정팟 체크가 있었으면 함. 매주 같은시간에 가는 파티도 있어"*).
   *
   * 켜면 이번 주를 포함해 `FIXED_PARTY_WEEKS` 주치가 **한 번에 등록된다.** 규칙을 저장해
   * 두고 나중에 만들어 내는 방식이 아니다 — 일정은 파티원이 각자 참가/불참을 눌러 고치는
   * 대상이라, 규칙에서 매번 생성되는 화면에는 "이번 주는 못 간다"를 적을 자리가 없다.
   */
  const [isFixedParty, setIsFixedParty] = useState(false);

  const [query, setQuery] = useState("");
  /** 고른 뒤 검색어를 비우고 **포커스를 돌려놓기 위한** 참조. 아래 `toggleBoss` 참고. */
  const searchRef = useRef<HTMLInputElement>(null);
  /** 계획 밖 보스를 펼쳤는가. 검색 중에는 이 값과 무관하게 항상 펼친다. */
  const [catalogOpen, setCatalogOpen] = useState(false);
  /**
   * ② "이 캐릭터가 매주 가는 보스"를 펼쳤는가. **`null` = 아직 손대지 않음**이며,
   * 그때는 아래 `plannedVisible` 이 상황을 보고 기본값을 정한다.
   *
   * `false` 가 아니라 `null` 로 가르는 이유는 체크한 보스(`draftBossIds`)와 같다 —
   * "사용자가 접었다"와 "아직 아무 판단이 없다"는 다른 사건이고, 둘을 합치면 상황이
   * 바뀌어도(파티 보스가 사라져도) 목록이 접힌 채로 남는다.
   */
  const [plannedOpen, setPlannedOpen] = useState<boolean | null>(null);

  const normalizedQuery = normalizeQuery(query);

  const bossById = useMemo(
    () => new Map(bosses.map((entry) => [entry.bossDifficultyId, entry])),
    [bosses],
  );

  /** 이번 주에 이미 잡은 보스. 판정은 뷰가 했고 여기서는 조회만 한다. */
  const clearedIds = useMemo(
    () =>
      new Set(
        plans.flatMap((plan) => (plan.isCleared ? [plan.bossDifficultyId] : [])),
      ),
    [plans],
  );

  // ── ① 이 파티가 묶어서 도는 보스 ────────────────────────────────────────
  const partyRows = useMemo<readonly BossRow[]>(
    () =>
      partyBosses.map((entry) => ({
        boss:
          bossById.get(entry.bossDifficultyId) ?? partyBossAsEntry(entry),
        cleared: clearedIds.has(entry.bossDifficultyId),
      })),
    [partyBosses, bossById, clearedIds],
  );

  const partyIds = useMemo(
    () => new Set(partyRows.map((row) => row.boss.bossDifficultyId)),
    [partyRows],
  );

  // ── ② 그 캐릭터가 매주 가는 보스 (인게임 스케줄러) ──────────────────────
  const plannedRows = useMemo<readonly BossRow[]>(
    () =>
      plans.flatMap((plan) => {
        // 꺼 둔 계획은 "매주 가는 보스"가 아니다. 판정은 뷰의 `is_active` 가 이미 했다.
        if (!plan.isActive) return [];
        if (partyIds.has(plan.bossDifficultyId)) return [];
        const entry = bossById.get(plan.bossDifficultyId);
        return entry === undefined
          ? []
          : [{ boss: entry, cleared: plan.isCleared }];
      }),
    [plans, partyIds, bossById],
  );

  const plannedIds = useMemo(
    () => new Set(plannedRows.map((row) => row.boss.bossDifficultyId)),
    [plannedRows],
  );

  // ── ③ 나머지 전체 ───────────────────────────────────────────────────────
  const catalogRows = useMemo<readonly BossRow[]>(
    () =>
      bosses.flatMap((entry) =>
        partyIds.has(entry.bossDifficultyId) ||
        plannedIds.has(entry.bossDifficultyId)
          ? []
          : [{ boss: entry, cleared: clearedIds.has(entry.bossDifficultyId) }],
      ),
    [bosses, partyIds, plannedIds, clearedIds],
  );

  const hasPartyBosses = partyRows.length > 0;
  const hasPlans = plannedRows.length > 0;

  /**
   * **이 파티의 보스를 이번 주에 전부 잡았는가.**
   *
   * 발주자 지시(2026-08-18)로 기본 체크에서 완료된 보스가 빠지면서 생긴 상태다:
   * *"이미 보스를 돌았는데 일정을 잡을 이유는없잖아"*. 전부 완료면 **아무것도 체크되지
   * 않은 채로** 폼이 열리는데, 그 화면은 설명 없이 보면 **고장으로 읽힌다** — 파티에
   * 보스가 있는데 등록 버튼이 열리지 않기 때문이다. 그래서 그 상태를 말로 설명한다.
   */
  const allPartyBossesCleared =
    hasPartyBosses && partyRows.every((row) => row.cleared);

  const partyMatches = useMemo(
    () => partyRows.filter((row) => matchesBoss(row.boss, normalizedQuery)),
    [partyRows, normalizedQuery],
  );
  const plannedMatches = useMemo(
    () => plannedRows.filter((row) => matchesBoss(row.boss, normalizedQuery)),
    [plannedRows, normalizedQuery],
  );
  /**
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **자르지 않는다.** 예전에는 `.slice(0, CATALOG_PAGE_SIZE)`(=8)가 걸려 있었다.
   *   ═══════════════════════════════════════════════════════════════════════
   *   카탈로그는 54건인데 8건만 배열에 담기니, 아래 `<ul>` 이 스크롤되는데도
   *   `노멀 림보`(역정렬 17번째)에는 **스크롤로도 닿을 수 없었다.** 발주자 지적
   *   (2026-08-18): *"아니 스크롤해서 보이게 해야된다고"*. 결함은 목록 높이가
   *   아니라 **조용한 잘라내기**였다. 수십 건은 가상 스크롤 없이도 아무 문제 없으니
   *   과하게 최적화하지 말 것. 검색 중에도 일치 항목을 자르지 않는다 — 찾으라고
   *   친 이름이 잘려 나가면 "없다"로 읽힌다.
   *   (같은 결함이 `party-boss-picker.tsx` · `boss-plan-workspace.tsx` 에도 있었다.)
   */
  const catalogMatches = useMemo(
    () => catalogRows.filter((row) => matchesBoss(row.boss, normalizedQuery)),
    [catalogRows, normalizedQuery],
  );

  /** 계획·파티 목록이 비었거나, 사용자가 펼쳤거나, 검색 중이면 전체 목록도 보인다. */
  const catalogVisible =
    (!hasPartyBosses && !hasPlans) || catalogOpen || normalizedQuery !== "";

  const selectedSet = useMemo(
    () => new Set(selectedBossIds),
    [selectedBossIds],
  );

  const plannedSelectedCount = useMemo(
    () =>
      plannedRows.filter((row) => selectedSet.has(row.boss.bossDifficultyId))
        .length,
    [plannedRows, selectedSet],
  );
  const catalogSelectedCount = useMemo(
    () =>
      catalogRows.filter((row) => selectedSet.has(row.boss.bossDifficultyId))
        .length,
    [catalogRows, selectedSet],
  );

  /**
   * ② "이 캐릭터가 매주 가는 보스"를 펼칠 것인가.
   *
   * **기본은 접힘**이다 (발주자 지시, 2026-08-18): 파티에 보스를 등록하는 기능이 생긴
   * 뒤로 "묶어서 도는 보스"는 ① 파티 보스 목록이 맡고, 이 캐릭터 계획 목록은 보조
   * 수단이 됐다. 세 목록이 전부 펼쳐져 있으면 정작 대부분의 경우에 쓰는 ①이 밀린다.
   *
   * 다만 **접으면 안 되는 경우가 둘** 있고, 그때는 손대기 전까지 펼쳐 둔다.
   *   ⓐ **파티에 등록된 보스가 없을 때** — 그러면 이 목록이 사실상 유일한 수단이라,
   *      접어 두면 빈 화면에 접힌 버튼 하나만 남는 막다른 길이 된다.
   *   ⓑ **이 목록 안에 이미 체크된 보스가 있을 때** — 등록될 것이 접힌 안에 숨으면
   *      사용자가 무엇을 등록하는지 못 본다. 기본 체크는 언제나 ① 파티 보스뿐이므로
   *      (`plannedRows` 는 파티 보스를 애초에 제외한다) 이 조건이 참이 되는 것은
   *      사용자가 직접 체크한 뒤뿐이다 — 그 선택을 접어 감추지 않는다는 뜻이다.
   * 검색 중에는 ③과 같은 규약으로 **항상 펼친다** — 찾으라고 친 이름이 접힌 목록
   * 안에 있으면 "없다"로 읽힌다.
   */
  const plannedVisible =
    normalizedQuery !== "" ||
    (plannedOpen ?? (!hasPartyBosses || plannedSelectedCount > 0));

  /**
   * 등록될 보스 — **화면에 보이는 차례 그대로**다.
   *
   * 클릭 순서를 쓰지 않는 이유: 체크를 껐다 다시 켰다고 도는 순서가 바뀌면 사용자가
   * 이유를 알 수 없고, 파티 제목(`익세 하대 하카`)과도 어긋난다.
   */
  const orderedSelection = useMemo<readonly BossRow[]>(
    () =>
      [...partyRows, ...plannedRows, ...catalogRows].filter((row) =>
        selectedSet.has(row.boss.bossDifficultyId),
      ),
    [partyRows, plannedRows, catalogRows, selectedSet],
  );

  const toggleBoss = (bossDifficultyId: BossDifficultyId) => {
    const isAdding = !selectedSet.has(bossDifficultyId);
    onSelectedBossIdsChange(
      isAdding
        ? [...selectedBossIds, bossDifficultyId]
        : selectedBossIds.filter((id) => id !== bossDifficultyId),
    );
    if (!isAdding) {
      /*
        체크를 **끌 때는 검색어를 비우지 않는다.** 잘못 눌러 취소하는 상황이라
        방금 친 이름까지 사라지면 다시 타이핑해야 해서 더 나쁘다.
      */
      return;
    }
    /*
      검색해서 고른 뒤에는 검색어를 비운다 — 한 번에 여러 보스를 체크하는 것이 정상
      사용이라, 지운 검색어가 남아 있으면 다음 보스를 찾기 전에 매번 손으로 지워야 한다.
      포커스는 입력으로 돌려놓는다(마우스로 체크했어도). 그러지 않으면 검색은 비었는데
      커서는 목록에 남아 바로 이어 칠 수 없다.
    */
    setQuery("");
    searchRef.current?.focus();
    /*
      방금 체크한 보스가 ③ 전체 목록 소속이면 그 목록을 펼쳐 둔다. 검색어가 비면
      `catalogVisible` 이 다시 접히므로, 그냥 두면 **등록될 보스가 접힌 안으로 숨는다** —
      아래 `plannedVisible` 이 이미 같은 이유로 선택이 있는 목록을 펼쳐 두고 있다.
    */
    if (
      !partyIds.has(bossDifficultyId) &&
      !plannedIds.has(bossDifficultyId)
    ) {
      setCatalogOpen(true);
    } else if (plannedIds.has(bossDifficultyId)) {
      setPlannedOpen(true);
    }
  };

  /** 동기화 유도 안내를 띄울 조건. 캐릭터가 정해져 있고, 계획이 정말 비었을 때만. */
  const showSyncHint =
    isSignedIn &&
    characterId !== null &&
    !isPlanLoading &&
    !isPlanError &&
    !hasPlans;

  const partySize = Number.parseInt(partySizeText, 10);
  const partySizeValid =
    Number.isInteger(partySize) && partySize >= 1 && partySize <= 24;
  const durationMinutes = Number.parseInt(durationText, 10);
  const durationValid =
    Number.isInteger(durationMinutes) &&
    durationMinutes >= 5 &&
    durationMinutes <= 600;
  const startMinutes = minutesFromTimeText(timeText);

  /** 예상 수익 — 고른 보스 전부의 합. 가격 미확인은 **더하지 않고 따로 센다** (§1.3 D4). */
  const income = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const row of orderedSelection) {
      const share = crystalShareMeso(
        row.boss.crystalPriceMeso,
        partySizeValid ? partySize : 1,
      );
      if (share === null) unknown += 1;
      else known += share;
    }
    return { known, unknown };
  }, [orderedSelection, partySize, partySizeValid]);

  /** `max_party` 초과. **막지 않고 경고만** 한다 (§1.3 D5). */
  const overMaxParty = useMemo(
    () =>
      partySizeValid
        ? orderedSelection.filter((row) => partySize > row.boss.maxParty)
        : [],
    [orderedSelection, partySize, partySizeValid],
  );

  /** 이미 잡은 보스를 또 등록하는 것은 대개 실수다. 역시 **막지 않는다**. */
  const clearedSelection = useMemo(
    () => orderedSelection.filter((row) => row.cleared),
    [orderedSelection],
  );

  /** 목록에 실제로 있는 캐릭터인가 — 목록이 갱신되면 예전 선택이 사라질 수 있다. */
  const selectedCharacter =
    characters.find((entry) => entry.characterId === characterId) ?? null;

  const canSubmit =
    !disabled &&
    orderedSelection.length > 0 &&
    partySizeValid &&
    durationValid &&
    startMinutes !== null &&
    // ★ 캐릭터가 없으면 등록하지 않는다. 12개 상한이 캐릭터당이라 캐릭터 없는
    //   일정은 결정석 집계에 들어갈 수 없다 (§1).
    selectedCharacter !== null &&
    !isSubmitting;

  const participantPersonIds = selectedWindow?.personIds ?? selectedPersonIds;

  /**
   * 연속 배치 미리보기. **서버와 같은 식**(`시작 + 소요 × i`)이며 저장하지 않는다.
   * 규칙의 주인은 서버(`createPartyRuns`)이고 여기는 보여 주기만 한다.
   */
  const placement = useMemo(() => {
    if (startMinutes === null || !durationValid) return [];
    return orderedSelection.map((row, index) => ({
      id: row.boss.bossDifficultyId,
      shortName: row.boss.shortName,
      label: formatRunStart(startMinutes + index * durationMinutes),
    }));
  }, [orderedSelection, startMinutes, durationMinutes, durationValid]);

  /* `h-full` — 옆의 「일정 짜기」 카드와 높이를 맞춘다(같은 이유, §availability-panel). */
  return (
    <Card className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-2">
        <CalendarPlus aria-hidden size={18} className="text-primary" />
        <CardTitle className="text-body-lg">보스 일정 등록</CardTitle>
      </div>

      {selectedWindow ? (
        <p className="rounded-md bg-primary-subtle px-3 py-2 text-body-sm text-primary">
          {/*
            등록하려는 런의 시작·종료 시각. 숫자 구간만 등폭이고 요일 한 글자와
            `명 가능` 은 본문 서체다(`Claude/FONT-NOTES.md` §9).
          */}
          선택한 시간대 ·{" "}
          <NumericText>{formatKstShort(selectedWindow.startsAt)}</NumericText> ~{" "}
          <NumericText>{formatKstShort(selectedWindow.endsAt)}</NumericText> ·{" "}
          {selectedWindow.availableCount}명 가능
        </p>
      ) : (
        // `neutral-100` 위의 `ink-muted` 는 라이트에서 4.40:1 로 아슬하게 미달이었다.
        // 2026-08-19 대비 감사에서 라이트 `ink-muted` 를 `#62616a` 로 내려 5.37:1 이 됐지만,
        // 이 문단은 두 줄짜리 안내 **문장**이라 한 단계 진한 `ink-label` 을 유지한다
        // (라이트 9.50 / 다크 10.83). 색을 되돌릴 이유가 생긴 것은 아니다.
        <p className="rounded-md bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
          왼쪽 겹침 막대를 선택하면 시간이 자동으로 채워집니다. 직접 입력해도
          됩니다.
        </p>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !canSubmit ||
            startMinutes === null ||
            selectedCharacter === null
          ) {
            return;
          }
          onSubmit({
            partyId,
            // 화면에 보이는 차례 그대로. 서버가 이 순서로 연달아 배치한다.
            bossDifficultyIds: orderedSelection.map(
              (row) => row.boss.bossDifficultyId,
            ),
            scheduledAt: kstMoment(dayKey, startMinutes),
            durationMinutes,
            entryPartySize: partySize,
            participantPersonIds,
            characterId: selectedCharacter.characterId,
            note: null,
          });
        }}
      >
        {/* 보스 선택 (여러 개 체크) */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={searchId} required>
            보스 <span className="text-ink-muted">(여러 개 선택 가능)</span>
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
            />
            <Input
              id={searchId}
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="이름 또는 별칭 — 하카, 하스우, 익세"
              className="pl-9"
              autoComplete="off"
            />
          </div>

          {/*
            ★ 로딩·오류 분기는 없앴다. 보스 목록은 **코드 상수**라
              (`@/lib/boss-master`) 늦게 오지도 실패하지도 않는다. 아래 파티 보스
              (`isPartyBossError`)는 여전히 DB 조회라 그쪽 분기는 그대로 있다.
          */}
          {(
            <div className="flex flex-col gap-2">
              {/*
                파티 보스 조회 실패는 **등록을 막지 않는다.** 아래 목록에서 고를 수 있다.
              */}
              {isPartyBossError ? (
                <div className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span className="min-w-0 flex-1">
                    이 파티에 등록된 보스를 불러오지 못했습니다. 아래 목록에서
                    고를 수 있습니다.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onPartyBossRetry}
                    className="shrink-0"
                  >
                    <RotateCw aria-hidden size={14} />
                    다시 시도
                  </Button>
                </div>
              ) : null}

              {/* ── ① 이 파티가 묶어서 도는 보스 ─────────────────────────── */}
              {isPartyBossLoading ? (
                <SkeletonGroup label="이 파티의 보스를 불러오는 중">
                  {[0, 1].map((index) => (
                    <Skeleton key={index} className="h-11" />
                  ))}
                </SkeletonGroup>
              ) : hasPartyBosses ? (
                <div className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-1.5 text-caption text-ink-label">
                    <Swords aria-hidden size={14} className="text-primary" />이
                    파티가 묶어서 도는 보스 · {partyRows.length}개
                  </p>
                  {partyMatches.length === 0 ? (
                    <HelperText>
                      이 파티의 보스 중에는 일치하는 이름이 없습니다.
                    </HelperText>
                  ) : (
                    <ul className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border">
                      {partyMatches.map((row) => (
                        <BossCheckRow
                          key={row.boss.bossDifficultyId}
                          row={row}
                          checked={selectedSet.has(row.boss.bossDifficultyId)}
                          disabled={disabled}
                          onToggle={() =>
                            toggleBoss(row.boss.bossDifficultyId)
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              ) : disabled ? null : (
                /*
                  등록된 보스가 없는 것은 **정상 상태**다(아직 안 정했거나 예전에 만든
                  파티). 에러로 그리지 않고 어디서 정하는지만 알려 준다.
                */
                <div className="flex flex-col items-start gap-2 rounded-md border border-border bg-neutral-100 px-3 py-2">
                  <p className="text-body-sm text-ink-label">
                    이 파티에 등록된 보스가 없습니다. 매주 묶어서 도는 보스를
                    등록해 두면 여기서 체크만 하면 됩니다.
                  </p>
                  <Button variant="secondary" size="sm" onClick={onEditPartyBosses}>
                    <Swords aria-hidden size={14} />
                    파티 보스 등록하기
                  </Button>
                </div>
              )}

              {/*
                ★ 파티 보스를 **이번 주에 전부 잡은** 상태. 기본 체크가 하나도 없는 것이
                  정상이며, 그 사실과 그래도 잡고 싶을 때의 방법을 함께 말한다.
                  체크가 하나라도 있으면(사용자가 일부러 켰으면) 이 안내는 사라지고
                  아래 "이미 잡았습니다" 경고가 그 사실을 이어받는다.
                  주황이 배경·아이콘을 맡고 문장은 잉크가 맡는다(§4).
              */}
              {allPartyBossesCleared && selectedSet.size === 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <CheckCircle2
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span>
                    {selectedCharacter?.name ?? "이 캐릭터"}(은)는 이 파티의 보스{" "}
                    {partyRows.length}개를 이번 주에 모두 잡았습니다. 그래서
                    체크된 보스가 없습니다. 다시 잡을 일정이라면 위 목록에서 직접
                    체크하고, 다른 캐릭터로 가는 것이라면 아래에서 캐릭터를 바꿔
                    주세요.
                  </span>
                </p>
              ) : null}

              {/* ── ② 이 캐릭터가 매주 가는 보스 (인게임 스케줄러) ───────── */}
              {isPlanError ? (
                <div className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span className="min-w-0 flex-1">
                    이 캐릭터가 매주 가는 보스를 불러오지 못했습니다. 아래 전체
                    목록에서 고를 수 있습니다.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onPlanRetry}
                    className="shrink-0"
                  >
                    <RotateCw aria-hidden size={14} />
                    다시 시도
                  </Button>
                </div>
              ) : null}

              {isPlanLoading ? (
                <SkeletonGroup label="이 캐릭터가 매주 가는 보스를 불러오는 중">
                  {[0, 1].map((index) => (
                    <Skeleton key={index} className="h-11" />
                  ))}
                </SkeletonGroup>
              ) : hasPlans ? (
                <div className="flex flex-col gap-1.5">
                  {normalizedQuery === "" ? (
                    <BossGroupToggle
                      open={plannedVisible}
                      onToggle={() => setPlannedOpen(!plannedVisible)}
                      icon={ListChecks}
                      label="이 캐릭터가 매주 가는 보스"
                      count={plannedRows.length}
                      selectedCount={plannedSelectedCount}
                      controls={plannedListId}
                    />
                  ) : (
                    /*
                      검색 중에는 ③과 같은 규약이다 — 목록은 강제로 펼쳐지므로 접기
                      버튼을 남겨 두면 눌러도 반응이 없는 버튼이 된다. 제목만 남긴다.
                    */
                    <p className="flex items-center gap-1.5 text-caption text-ink-label">
                      <ListChecks
                        aria-hidden
                        size={14}
                        className="text-primary"
                      />
                      이 캐릭터가 매주 가는 보스 · {plannedRows.length}개
                    </p>
                  )}
                  {plannedVisible ? (
                    plannedMatches.length === 0 ? (
                      <HelperText>
                        매주 가는 보스 중에는 일치하는 이름이 없습니다. 아래 전체
                        목록을 확인해 주세요.
                      </HelperText>
                    ) : (
                      <ul
                        id={plannedListId}
                        className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border"
                      >
                        {plannedMatches.map((row) => (
                          <BossCheckRow
                            key={row.boss.bossDifficultyId}
                            row={row}
                            checked={selectedSet.has(row.boss.bossDifficultyId)}
                            disabled={disabled}
                            onToggle={() =>
                              toggleBoss(row.boss.bossDifficultyId)
                            }
                          />
                        ))}
                      </ul>
                    )
                  ) : null}
                </div>
              ) : null}

              {/*
                동기화 전은 **정상 상태**다(§1.1). 에러로 그리지 않고, 무엇을 하면
                목록이 좋아지는지만 알려 준 뒤 전체 목록으로 물러난다.
              */}
              {showSyncHint ? (
                <p className="rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
                  이 캐릭터의 인게임 스케줄러를 아직 불러오지 않았습니다. 한 번
                  동기화하면 매주 가는 보스가 여기에 먼저 나옵니다. 그때까지는
                  아래 전체 목록에서 고르세요.{" "}
                  <Link
                    href="/boss-plans"
                    className="font-semibold text-primary underline underline-offset-2"
                  >
                    보스 계획 열기
                  </Link>
                </p>
              ) : null}

              {/* ── ③ 나머지 전체 — 막지 않고 접어 둔다 ──────────────────── */}
              {(hasPartyBosses || hasPlans) && normalizedQuery === "" ? (
                <BossGroupToggle
                  open={catalogOpen}
                  onToggle={() => setCatalogOpen((open) => !open)}
                  icon={Search}
                  label="다른 보스도 고르기"
                  count={catalogRows.length}
                  selectedCount={catalogSelectedCount}
                  controls={catalogListId}
                />
              ) : null}

              {catalogVisible ? (
                catalogMatches.length === 0 ? (
                  <HelperText>
                    별칭을 포함해도 일치하는 보스가 없습니다. 다른 이름으로
                    찾아보세요.
                  </HelperText>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {hasPartyBosses || hasPlans ? (
                      <p className="text-caption text-ink-label">그 밖의 보스</p>
                    ) : null}
                    <ul
                      id={catalogListId}
                      className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border"
                    >
                      {catalogMatches.map((row) => (
                        <BossCheckRow
                          key={row.boss.bossDifficultyId}
                          row={row}
                          checked={selectedSet.has(row.boss.bossDifficultyId)}
                          disabled={disabled}
                          onToggle={() =>
                            toggleBoss(row.boss.bossDifficultyId)
                          }
                        />
                      ))}
                    </ul>
                  </div>
                )
              ) : null}
            </div>
          )}

          {/*
            이미 잡은 보스를 또 등록하는 것은 대개 실수다. 결정석은 캐릭터당 주 1회라
            수익이 두 번 잡힌다. **막지는 않는다** — 다른 사람을 도우러 한 번 더 가는
            경우가 실제로 있고, 그때도 일정 자체는 유효하다.
            주황이 배경·아이콘을 맡고 문장은 잉크가 맡는다(§4).
          */}
          {clearedSelection.length > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>
                {selectedCharacter?.name ?? "이 캐릭터"}(은)는 이번 주에{" "}
                {clearedSelection
                  .map((row) => row.boss.shortName)
                  .join(" · ")}
                (을)를 이미 잡았습니다. 그대로 등록하면 결정석 수익이 두 번
                잡힙니다. 다른 캐릭터로 가는 것이라면 아래에서 캐릭터를 바꿔
                주세요.
              </span>
            </p>
          ) : null}
        </div>

        {/*
          내 캐릭터.

          ★ 이 항목이 **필수**인 이유는 §1 이다 — 주간 결정석 12개 상한이 캐릭터당으로
            세어지므로, 어느 캐릭터가 가는지 모르면 수익을 귀속시킬 곳이 없다.
          ★ 후보는 **추적 캐릭터뿐**이다(§2.1.1). 추적하지 않는 캐릭터는 인게임 스케줄러와
            동기화되지 않아 클리어가 관측되지 않는다.
        */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={characterFieldId} required>
            내 캐릭터
          </Label>

          {!isSignedIn ? (
            <p className="rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
              일정 등록은 로그인이 필요합니다. 홈에서 넥슨 API 키로 로그인해
              주세요.
            </p>
          ) : isCharacterError ? (
            <ErrorState
              title="캐릭터 목록을 불러오지 못했습니다"
              onRetry={onCharacterRetry}
              className="py-6"
            />
          ) : isCharacterLoading ? (
            <Skeleton className="h-control-md" />
          ) : characters.length === 0 ? (
            <EmptyState
              icon={<UserRound size={24} />}
              title="추적 중인 캐릭터가 없습니다"
              description="일정에 데려갈 캐릭터를 먼저 골라 주세요. 고른 캐릭터만 인게임 스케줄러와 동기화되고, 결정석 12개 상한도 캐릭터별로 세어집니다."
              action={
                <Link href="/">
                  <Button variant="secondary" size="sm">
                    <UserRound aria-hidden size={16} />
                    캐릭터 선택하러 가기
                  </Button>
                </Link>
              }
              className="py-8"
            />
          ) : (
            <>
              <select
                id={characterFieldId}
                value={selectedCharacter?.characterId ?? ""}
                onChange={(event) => onCharacterIdChange(event.target.value)}
                className={cn(
                  "h-control-md w-full rounded-md border border-border bg-surface px-3",
                  "text-body-sm text-ink transition duration-200 outline-none",
                  "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                )}
              >
                {selectedCharacter === null ? (
                  <option value="">캐릭터를 선택해 주세요</option>
                ) : null}
                {characters.map((entry) => (
                  <option key={entry.characterId} value={entry.characterId}>
                    {entry.name}
                    {entry.worldName === null ? "" : ` · ${entry.worldName}`}
                    {entry.level === null ? "" : ` · Lv.${entry.level}`}
                    {entry.isMain ? " · 본캐" : ""}
                  </option>
                ))}
              </select>
              <HelperText>
                이 캐릭터로 입장한 것으로 기록됩니다. 결정석 주간 12개 상한은
                캐릭터마다 따로 셉니다.
              </HelperText>
            </>
          )}
        </div>

        {/* 시각 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={dayId} required>
              날짜 (KST)
            </Label>
            <select
              id={dayId}
              value={dayKey}
              onChange={(event) => onDayKeyChange(event.target.value)}
              className={cn(
                "h-control-md w-full rounded-md border border-border bg-surface px-3",
                "text-body-sm text-ink transition duration-200 outline-none",
                "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
              )}
            >
              {dayRows.map((row) => (
                <option key={row.dayKey} value={row.dayKey}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={timeId} required>
              시작 시각 (KST)
            </Label>
            <Input
              id={timeId}
              type="time"
              step={1800}
              value={timeText}
              invalid={startMinutes === null}
              onChange={(event) => onTimeTextChange(event.target.value)}
            />
          </div>
        </div>

        {/* 파티 인원수 · 보스당 소요 시간 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={sizeId} required>
              파티 인원수
            </Label>
            <Input
              id={sizeId}
              type="number"
              min={1}
              max={24}
              value={partySizeText}
              invalid={!partySizeValid}
              onChange={(event) => onPartySizeTextChange(event.target.value)}
            />
            {partySizeValid ? null : (
              <HelperText tone="error">1 ~ 24 사이의 숫자여야 합니다.</HelperText>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={durationId} required>
              보스당 소요 (분)
            </Label>
            <Input
              id={durationId}
              type="number"
              min={5}
              max={600}
              step={5}
              value={durationText}
              invalid={!durationValid}
              onChange={(event) => onDurationTextChange(event.target.value)}
            />
            {durationValid ? null : (
              <HelperText tone="error">
                5 ~ 600 사이의 숫자여야 합니다.
              </HelperText>
            )}
          </div>
        </div>

        <HelperText>
          인원수는 실제로 입장하는 사람 수이며 이 값으로 결정석이 1/n 로
          나뉩니다. 소요 시간은 보스를 <strong className="font-semibold">연달아</strong>{" "}
          배치하는 간격이기도 합니다.
        </HelperText>

        {/*
          `max_party` 초과는 **막지 않는다** (§1.3 D5 — 대부분 세대 규칙에서 유도한
          추정치라 막으면 진짜 파티를 거절한다). 주황은 배경·아이콘, 문장은 잉크.
        */}
        {overMaxParty.length > 0 ? (
          <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
            <TriangleAlert
              aria-hidden
              size={16}
              className="mt-0.5 shrink-0 text-tertiary"
            />
            <span>
              {overMaxParty
                .map((row) => `${row.boss.koreanName} ${row.boss.maxParty}인`)
                .join(" · ")}
              보다 많은 인원입니다. 막지는 않지만 확인해 주세요.
            </span>
          </p>
        ) : null}

        {/* 연달아 도는 차례 미리보기 */}
        {placement.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3">
            <span className="text-caption text-ink-label">
              등록될 일정 {placement.length}건 · 연달아 배치
            </span>
            <ul className="flex flex-wrap gap-1.5">
              {placement.map((entry) => (
                <li
                  key={entry.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pr-2.5 pl-2"
                >
                  <NumericText className="text-caption text-ink-label">
                    {entry.label}
                  </NumericText>
                  <span className="text-body-sm text-ink">
                    {entry.shortName}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 예상 결정석 수익 */}
        <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-3">
          {/*
            보스를 아직 안 골랐을 때는 "미확인"을 쓰지 않는다.
            "미확인"은 §1.3 D4 의 도메인 주장(가격 출처가 없다)이라 "아직 안 골랐다"와
            같은 말로 쓰면 안 된다.
          */}
          {orderedSelection.length === 0 ? (
            <p className="text-body-sm text-ink-muted">
              보스를 선택하면 예상 결정석 수령액이 여기에 표시됩니다.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption text-ink-label">
                  예상 수령액 합계 · {partySizeValid ? partySize : "-"}인 분배 ·
                  보스 {orderedSelection.length}개
                </span>
                <MesoAmount
                  value={income.known}
                  compact
                  tone="accent"
                  className="text-body-sm font-semibold"
                />
              </div>
              {income.unknown > 0 ? (
                /*
                  주황이 배경·아이콘을 맡고 문장은 잉크가 맡는다. `text-tertiary` 로
                  문장을 그리면 라이트에서 2.80:1 로 AA 미달이었다(다크만 보면 7.82:1 로
                  통과해 지나친다). 의미(§4 임박·주의 = 주황)는 그대로다.
                */
                <p className="mt-1 flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span>
                    가격 미확인 {income.unknown}건은 합계에서 제외했습니다 — 0
                    메소가 아니라 &ldquo;모른다&rdquo;입니다 (§1.3 D4).
                  </span>
                </p>
              ) : null}
            </>
          )}
        </div>

        {submitError ? (
          <ErrorState
            title="일정을 등록하지 못했습니다"
            detail={submitError.message}
            className="py-6"
          />
        ) : null}

        {/*
          ── 고정팟 ────────────────────────────────────────────────────────────
          체크하면 **같은 요일·같은 시각**으로 몇 주치가 한 번에 잡힌다. 몇 주치인지
          숫자로 말해 주는 것이 중요하다 — "매주"라고만 적으면 영원히 잡히는 것으로
          읽히는데, 실제로는 그 기간이 지나면 다시 등록해야 한다.
        */}
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <Checkbox
            checked={isFixedParty}
            disabled={disabled}
            onChange={(event) => setIsFixedParty(event.target.checked)}
            aria-describedby={fixedPartyHintId}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body-sm font-semibold text-ink">
              고정팟 — 매주 같은 시간
            </span>
            <span id={fixedPartyHintId} className="text-body-sm text-ink-muted">
              이번 주를 포함해{" "}
              <strong className="font-semibold text-ink">
                <NumericText>{`${String(FIXED_PARTY_WEEKS)}주치`}</NumericText>
              </strong>
              가 한 번에 등록됩니다. 못 가는 주는 그 주 일정에서 참가를 빼거나 지우면
              됩니다.
            </span>
          </span>
        </label>

        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting
            ? "등록 중…"
            : isFixedParty
              ? `고정팟 ${String(FIXED_PARTY_WEEKS)}주치 등록`
              : orderedSelection.length > 1
                ? `일정 ${orderedSelection.length}건 등록`
                : "일정 등록"}
        </Button>
        {orderedSelection.length === 0 ? (
          <HelperText>보스를 하나 이상 체크해 주세요.</HelperText>
        ) : selectedCharacter === null ? (
          <HelperText>어느 캐릭터로 갈지 먼저 선택해 주세요.</HelperText>
        ) : (
          <HelperText>
            {orderedSelection
              .map(
                (row) =>
                  `${BOSS_DIFFICULTY_LABEL[row.boss.difficulty]} ${row.boss.bossKoreanName}`,
              )
              .join(" → ")}{" "}
            · 보스당 {durationValid ? durationMinutes : DEFAULT_DURATION_MINUTES}
            분 · {selectedCharacter.name}(으)로 참가 ·{" "}
            {participantPersonIds.length}명 참여 예정으로 등록됩니다.
          </HelperText>
        )}
      </form>
    </Card>
  );
}
