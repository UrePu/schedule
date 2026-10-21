"use client";

import { ChevronDown, ChevronUp, Plus, Search, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { BossIcon, MesoAmount } from "@/components/domain";
import { DurationField } from "@/components/ui/duration-field";
import {
  EmptyState,
  HelperText,
  Input,
  Label,
  ListItem,
  useComboboxList,
} from "@/components/ui";
import { resolveBossDuration } from "@/lib/domain/boss-duration-estimate";
import { DEFAULT_RUN_MINUTES } from "@/lib/domain/run-grouping";
import { cn } from "@/lib/utils";
import type { BossCatalogEntry, BossDifficultyId } from "@/types/domain";

/**
 * 파티가 **묶어서 도는 보스**를 고르는 목록 (발주 요구, 2026-08-18).
 *
 * 원문: *"파티 정보 자체에 보스가 등록된다. 같은 파티에 보스가 여러개 있을수도있고
 * 추가될수도있고 삭제될수도있다."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 순서가 있다 — 그리고 그 순서가 제목이 된다
 * ─────────────────────────────────────────────────────────────────────────────
 * 고른 보스는 **고른 차례대로** 위쪽 목록에 쌓이고, 그 순서가 그대로
 *   ① 파티 제목(`익세 하대 하카 2인`)
 *   ② 시간 등록 시 **연달아 배치되는 차례**
 * 가 된다. 그래서 ▲▼ 로 순서를 바꿀 수 있어야 하고, 바꾸면 제목이 따라 바뀐다는 사실을
 * 화면이 말해 줘야 한다(`PARTY_TITLE_HINT`).
 *
 * ⚠️ 이것은 `member_no` 같은 **관리 번호가 아니다** (CLAUDE.md §1.4). 관리 번호는 대화에서
 *    사람을 가리키는 이름이라 재배열이 금지되지만, 보스 순서는 "도는 차례"라 바꿔도 된다.
 *
 * 🖼️ 아이콘은 `BossIcon` 이 그린다. 파일이 없는 보스는 실루엣으로 떨어지지만 자리 크기는
 *    같아서 목록의 세로 리듬이 흔들리지 않는다 — **없는 것도 정상 상태다**(§2.1.1).
 */

/**
 * 주간 결정석 상한은 **캐릭터당 12개**다(§1). 넘겨도 **막지 않는다** — 파티 목록은
 * 여러 주에 걸칠 수 있고 상한은 캐릭터 단위라, 파티 단위로 막으면 실제 사용을 거절한다.
 */
const WEEKLY_SOFT_LIMIT = 12;

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

/** 별칭까지 훑는 검색. 봇의 `!등록 하카 21시` 와 같은 어휘를 화면에서도 쓴다. */
function matchesBoss(boss: BossCatalogEntry, query: string): boolean {
  if (query === "") return true;
  return [
    boss.koreanName,
    boss.bossKoreanName,
    boss.shortName,
    boss.bossDifficultyId,
    ...boss.aliases,
  ]
    .map(normalizeQuery)
    .some((value) => value.includes(query));
}

export interface PartyBossPickerProps {
  /** 고를 수 있는 보스 전부 — `getTrackedBossCatalog()` 가 준 그대로(일간은 이미 빠졌다). */
  readonly bosses: readonly BossCatalogEntry[];
  /** 고른 보스 — **순서 있는 배열**이다. Set 이 아닌 이유가 이 컴포넌트의 전부다. */
  readonly selectedIds: readonly BossDifficultyId[];
  /**
   * **구조 변경** — 추가 · 빼기 · ▲▼. 자리를 맞춘 소요 시간 배열을 **함께** 준다.
   *
   * ⚠️ 두 배열은 **언제나 함께 움직인다.** 한쪽만 고치면 그 뒤로 "하카 20분"처럼
   *    **한 칸씩 어긋난 값이 그럴듯하게** 그려지고 아무도 알아채지 못한다.
   */
  readonly onChange: (
    next: readonly BossDifficultyId[],
    nextDurations: readonly (number | null)[],
  ) => void;
  /**
   * 보스별 소요 시간(분) — `selectedIds` 와 **같은 길이**이며 같은 자리끼리 짝이다.
   * 원소 `null` = "정하지 않음"(기본값으로 접힌다. `0` 도 `20` 도 아니다).
   *
   * ★ 생략하면 소요 시간 칸을 **그리지 않는다**(`onDurationEdit` 도 함께 생략해야
   *   한다). 읽기 전용으로 쓰는 자리를 위해 남긴 길이다.
   */
  readonly durations?: readonly (number | null)[];
  /**
   * **값 수정** — 사용자가 그 보스의 분을 실제로 고쳤다. 구조 변경과 **갈라져 있다.**
   *
   * ★ ═══════════════════════════════════════════════════════════════════════════
   *   **순서만 바꿨는데 저장이 전체 덮어쓰기로 바뀌면 안 된다** (2026-10-11 결함)
   *   ═══════════════════════════════════════════════════════════════════════════
   *   예전에는 구조 변경과 값 수정이 **콜백 하나**를 공유했다. 그래서 ▲▼ 를 한 번 누른
   *   것만으로 부모의 `touched` 가 켜지고, 저장이 `durationMinutes` 배열을 실어
   *   **보스 전부를 덮어쓰는** 요청으로 바뀌었다. 보존은 DB 가 `boss_difficulty_id` 로
   *   키를 잡아 하므로 **순서·추가·삭제에는 분 배열이 아예 필요 없다** — 보내는 쪽이
   *   전적으로 손해다. 실제 피해: 60초 stale 캐시에 `null` 이 있는데 다른 파티원이
   *   40분을 넣어 뒀으면, **순서만 바꿔도 그 40분이 지워졌다.**
   * ★ 그래서 부모는 이 콜백이 불릴 때만 "값을 건드렸다"로 센다.
   */
  readonly onDurationEdit?: (
    bossDifficultyId: BossDifficultyId,
    minutes: number | null,
  ) => void;
  /**
   * 칸을 **비웠을 때 실제로 깔릴 분** — placeholder 가 적는 값(2026-10-21).
   *
   * ★ 생략하면 **본캐 기준 솔로 추정**(배율 반비례 — `boss-duration-estimate` 머리말 2절)이다.
   *   일정을 잡을 참여자를 아는 부모(묶음 편집)는 그 참여자들의 배율 합산을 접은 함수를
   *   넘긴다(`resolveBossDuration` — 서버가 묶음이 비었을 때 바로 그 값을 깐다).
   */
  readonly fallbackMinutesOf?: (bossDifficultyId: BossDifficultyId) => number;
  /**
   * placeholder 의 근거 한 줄(`3인 합산 추정 · 1명 미보정`). 칸마다 적으면 좁은 줄이 넘치므로
   * 목록 아래에 **한 번** 적는다. 생략하면 적지 않는다.
   */
  readonly fallbackNote?: string | null;
  readonly disabled?: boolean;
}

/** 묶음도 참여자 정보도 없을 때의 분(본캐 기준 솔로 추정) — 서버와 같은 함수로 접는다. */
function globalDefaultMinutes(bossDifficultyId: BossDifficultyId): number {
  return resolveBossDuration({
    bossDifficultyId,
    bundleMinutes: null,
    participants: [],
    fallbackMinutes: DEFAULT_RUN_MINUTES,
  }).minutes;
}

export function PartyBossPicker({
  bosses,
  selectedIds,
  onChange,
  durations,
  onDurationEdit,
  fallbackMinutesOf = globalDefaultMinutes,
  fallbackNote = null,
  disabled = false,
}: PartyBossPickerProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  /** 고른 뒤 검색어를 비우고 **포커스를 돌려놓기 위한** 참조. 아래 `add` 참고. */
  const searchRef = useRef<HTMLInputElement>(null);

  const normalizedQuery = normalizeQuery(query);

  /*
    ★ 2026-10-21 저녁 — 여기 있던 **"하나를 고치면 나머지도" 자동 추정이 없어졌다**(기본
      켜짐이었다). 발주: *"대신 돌먹을 하는 경우도 있으니 이걸 직접 수정 하는거는 다른 보스
      시간에 영향을 주면 안되"*. 묶음의 분은 그 파티의 시간이고, 돌먹 파티의 한 보스로 다른
      보스를 비례 추정할 근거가 없다(`boss-duration-estimate` 머리말 5절). 고친 칸 하나만
      바뀐다. 비례 맞추기는 `/boss-plans` 의 캐릭터 계획 값에만 남았다.
  */
  const editDuration = (
    bossDifficultyId: BossDifficultyId,
    minutes: number | null,
  ) => {
    onDurationEdit?.(bossDifficultyId, minutes);
  };

  const bossById = useMemo(
    () => new Map(bosses.map((entry) => [entry.bossDifficultyId, entry])),
    [bosses],
  );

  /**
   * 고른 보스를 **고른 순서대로**. 카탈로그에 없는 id 는 버리지 않고 자리를 지킨다.
   *
   * 소요 시간은 **자리로** 짝짓는다(`durations[index]`). 길이가 짧게 들어와도
   * `undefined` → `null` 로 떨어져 "정하지 않음"이 되므로 줄이 사라지지 않는다.
   */
  const selected = useMemo(
    () =>
      selectedIds.map((id, index) => ({
        id,
        boss: bossById.get(id) ?? null,
        durationMinutes: durations?.[index] ?? null,
      })),
    [selectedIds, bossById, durations],
  );

  /**
   * 소요 시간 배열을 `selectedIds` 와 **같은 길이로** 맞춘 사본. 모자라면 `null` 로
   * 메운다 — 부모가 길이를 어긋나게 넘겨도 아래 재배열이 자리를 잃지 않는다.
   */
  const alignedDurations = (): (number | null)[] =>
    selectedIds.map((_, index) => durations?.[index] ?? null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  /**
   * 고를 수 있는 후보 **전부**. 검색어가 있으면 그 일치 항목 전부.
   *
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **자르지 않는다.** 예전에는 `.slice(0, CANDIDATE_PAGE_SIZE)`(=8)가 걸려 있었다.
   *   ═══════════════════════════════════════════════════════════════════════
   *   카탈로그는 54건인데 8건만 렌더되니 `노멀 림보`(역정렬 17번째)는 **스크롤로도
   *   닿을 수 없었다** — 아래 `<ul>` 은 스크롤이 되는데 배열에 애초에 없었다.
   *   발주자 지적(2026-08-18): *"아니 스크롤해서 보이게 해야된다고"*.
   *   높이가 아니라 **조용한 잘라내기**가 결함이었다. 수십 건은 가상 스크롤 없이도
   *   아무 문제 없으니 과하게 최적화하지 말 것.
   */
  const candidates = useMemo(
    () =>
      bosses.filter(
        (entry) =>
          !selectedSet.has(entry.bossDifficultyId) &&
          matchesBoss(entry, normalizedQuery),
      ),
    [bosses, selectedSet, normalizedQuery],
  );

  const add = (id: BossDifficultyId) => {
    if (selectedSet.has(id)) return;
    /* 새 보스는 **"정하지 않음"** 으로 들어간다 — 20 을 심으면 거짓 확정이 된다. */
    onChange([...selectedIds, id], [...alignedDurations(), null]);
    /*
      고른 **직후에만** 검색어를 비운다. 파티 보스는 여러 개를 연달아 고르는 것이
      정상이라, 지운 검색어가 남아 있으면 다음 보스를 찾기 전에 매번 손으로 지워야 한다.
      뺄 때(`remove`)는 비우지 않는다 — 잘못 눌러 취소하는 상황에서 검색어까지 사라지면
      방금 친 이름을 다시 타이핑해야 해서 더 나쁘다.
      포커스는 입력으로 돌려놓는다. 마우스로 목록을 눌렀으면 포커스가 그 행에 가 있고,
      그 행은 곧 후보에서 빠져 사라지므로 그냥 두면 포커스가 문서로 떨어진다.
    */
    setQuery("");
    searchRef.current?.focus();
  };

  const remove = (id: BossDifficultyId) => {
    const index = selectedIds.indexOf(id);
    if (index === -1) return;
    /* 같은 자리를 함께 뺀다. 아니면 그 뒤 보스들이 **앞 보스의 분**을 물려받는다. */
    const nextDurations = alignedDurations();
    nextDurations.splice(index, 1);
    onChange(
      selectedIds.filter((entry) => entry !== id),
      nextDurations,
    );
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    /* 분도 **같은 자리로** 따라간다(머리말 ⚠️ — 한쪽만 옮기면 한 칸씩 어긋난다). */
    const nextDurations = alignedDurations();
    const [movedDuration] = nextDurations.splice(index, 1);
    nextDurations.splice(target, 0, movedDuration ?? null);
    onChange(next, nextDurations);
  };

  /**
   * 검색창 + 후보 목록을 **콤보박스**로 묶는다 (발주 요청 2026-10-06:
   * *"이거 검색후 키보드로 바로 조작가능하게좀 해줘 불편"*).
   *
   * `onPick` 이 **줄의 버튼과 똑같은 `add`** 를 가리키는 것이 요점이다 — 키보드 전용
   * 분기를 따로 만들면 "마우스로는 담기는데 Enter 로는 안 담긴다" 가 다음 결함이 된다.
   *
   * ⚠️ 후보 목록은 이미 고른 보스를 **애초에 빼고** 만든다(위 `candidates`). 그래서
   *    "이미 담긴 보스에 Enter" 라는 상태는 이 화면에 존재하지 않고, 토글이 필요하지도
   *    않다. 빼기는 위쪽 고른 목록의 `X` 가 맡는다. `add` 자체도 중복 id 를 그냥 되돌린다.
   */
  const combobox = useComboboxList({
    items: candidates,
    baseId: searchId,
    getItemKey: (entry) => entry.bossDifficultyId,
    onPick: (entry) => add(entry.bossDifficultyId),
    onClearQuery: () => setQuery(""),
    query,
    listboxLabel: "보스 후보",
    disabled,
  });

  return (
    <div className="flex flex-col gap-2">
      {/* ── 고른 보스 (순서 = 제목 순서 = 도는 차례) ─────────────────────── */}
      {selected.length === 0 ? (
        <p className="rounded-md border border-border bg-neutral-100 px-3 py-2 text-body-sm text-ink-label">
          아직 고른 보스가 없습니다. 아래에서 이 파티가 매주 묶어서 도는 보스를
          골라 주세요.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {selected.map((entry, index) => (
            /*
              📱 폭 400px: 고정분이 순번 16 + 얼굴 24 + 숫자줄 ~124 + ▲▼✕ 84 ≈ 248px 이라
                 이름이 100px 밖에 남지 않는다. 그래서 **`flex-wrap`** 으로 숫자줄 + 버튼
                 묶음을 아래로 떨어뜨린다 — 겹치거나 가로 스크롤이 생기는 것보다 낫다.
            */
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-border bg-surface px-2 py-1.5"
            >
              {/*
                순서 숫자. 등폭 숫자(`Numeric`)를 쓰지 않는 이유는 한 자리 숫자라
                정렬이 흔들릴 여지가 없고, 여기서는 "몇 번째로 도는가"라는 서수라서다.
              */}
              <span className="w-4 shrink-0 text-center text-caption text-ink-muted">
                {index + 1}
              </span>
              {entry.boss === null ? (
                <span className="size-6 shrink-0 rounded-sm bg-neutral-100" />
              ) : (
                <BossIcon
                  bossDifficultyId={entry.boss.bossDifficultyId}
                  difficulty={entry.boss.difficulty}
                  size="sm"
                />
              )}
              <span className="flex min-w-0 flex-1 basis-32 flex-col">
                <span className="truncate text-body-sm text-ink">
                  {entry.boss?.koreanName ?? entry.id}
                </span>
                {entry.boss === null ? null : (
                  <span className="truncate text-caption text-ink-label">
                    제목에는{" "}
                    <strong className="font-semibold">
                      {entry.boss.shortName}
                    </strong>
                    (으)로 들어갑니다
                  </span>
                )}
              </span>
              {/*
                ── 소요 시간 (발주 지시 2026-10-11) ───────────────────────────
                ★ 여기가 **이 값의 집**이다. 일정 잡는 창과 일정 상세 창에서도 고칠 수
                  있지만 저 둘은 "그 일정을 잡는 김에" 고치는 자리이고, 파티의 성질로서
                  정해 두는 곳은 여기다 — 분배 배율이 파티에 사는 것과 같은 근거
                  (2026-08-19 발주자: 분배는 파티의 성질이다).
                ★ 비워 두면 `null`("정하지 않음")이고 placeholder 가 기본값을 적는다.
                  `0` 이나 `20` 을 저장하지 않는다 — 기본값을 바꿀 때 **정하지 않은
                  파티만** 따라와야 한다(§1.3 D4 와 같은 기조).
              */}
              {onDurationEdit === undefined ? null : (
                <span className="shrink-0">
                  <DurationField
                    id={`party-boss-duration-${entry.id}`}
                    value={entry.durationMinutes}
                    fallbackMinutes={fallbackMinutesOf(entry.id)}
                    allowUnset
                    disabled={disabled}
                    aria-label={`${entry.boss?.koreanName ?? entry.id} 소요 시간(분)`}
                    onChange={(minutes) => editDuration(entry.id, minutes)}
                  />
                </span>
              )}
              <span className="flex shrink-0 items-center">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`${entry.boss?.koreanName ?? entry.id} 순서 올리기`}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-md text-ink-muted",
                    "transition duration-200 hover:bg-hover-strong hover:text-ink",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                >
                  <ChevronUp aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  disabled={disabled || index === selected.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`${entry.boss?.koreanName ?? entry.id} 순서 내리기`}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-md text-ink-muted",
                    "transition duration-200 hover:bg-hover-strong hover:text-ink",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                >
                  <ChevronDown aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(entry.id)}
                  aria-label={`${entry.boss?.koreanName ?? entry.id} 빼기`}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-md text-ink-muted",
                    "transition duration-200 hover:bg-hover-strong hover:text-ink",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                >
                  <X aria-hidden size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* placeholder 의 근거 — 칸을 비우면 무엇이 깔리는지(묶음 값이 언제나 이긴다). */}
      {onDurationEdit !== undefined &&
      fallbackNote !== null &&
      selected.length > 0 ? (
        <HelperText>
          빈 칸의 흐린 숫자는 {fallbackNote} 값입니다. 칸에 넣은 분은 이 묶음의 그
          보스에만 쓰이고 다른 보스에는 영향을 주지 않습니다.
        </HelperText>
      ) : null}

      {/*
        12개 초과는 **경고만** 한다 (§1.3 D5 와 같은 판단 — 소프트 상한을 막으면 진짜
        사용을 거절한다). 주황이 배경·아이콘을 맡고 문장은 잉크가 맡는다 (§4).
      */}
      {selected.length > WEEKLY_SOFT_LIMIT ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <span>
            주간 결정석은 캐릭터당 {WEEKLY_SOFT_LIMIT}개까지 팔 수 있습니다. 지금{" "}
            {selected.length}개를 골랐으니 한 캐릭터로 전부 돌 수는 없습니다.
            막지는 않습니다.
          </span>
        </p>
      ) : null}

      {/* ── 후보 고르기 ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        {/*
          개수를 함께 말한다. "이게 전부인가"를 화면이 답해야 조용히 잘린 목록과
          구분된다 — 잘려 있던 시절 이 화면은 8건을 전부인 양 보여 줬다.
        */}
        <Label htmlFor={searchId}>
          보스 찾기
          {candidates.length > 0 ? (
            <span className="ml-1 font-normal text-ink-muted">
              · {candidates.length}개
            </span>
          ) : null}
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
            disabled={disabled}
            {...combobox.inputProps}
          />
        </div>
        {/*
          키 안내는 **후보가 떠 있을 때만** 말한다. 닫혀 있을 때는 `↓` `Enter` 가 아무것도
          하지 않으므로 그때 떠 있는 안내는 거짓말이다. 문장이라 14px 하한을 지킨다(§4).
        */}
        {combobox.activeIndex === -1 ? null : (
          <HelperText>
            <kbd className="font-mono">↓</kbd> <kbd className="font-mono">↑</kbd>{" "}
            로 고르고 <kbd className="font-mono">Enter</kbd> 로 담습니다.{" "}
            <kbd className="font-mono">Esc</kbd> 는 검색어를 지웁니다.
          </HelperText>
        )}

        {/*
          ★ 로딩·오류 분기는 없앴다. 보스 목록은 이제 **코드 상수**라
            (`@/lib/boss-master`) 네트워크가 개입하지 않는다 — 늦게 오지도, 실패하지도
            않는다. 도달할 수 없는 분기를 남겨 두면 다음 사람이 그것을 사실로 읽는다.
            빈 상태(아래)는 그대로다 — 검색 결과가 없는 일은 여전히 일어난다.
        */}
        {candidates.length === 0 ? (
          normalizedQuery === "" ? (
            <EmptyState
              title="더 고를 보스가 없습니다"
              description="이 파티가 도는 보스를 전부 골랐습니다."
              className="py-6"
            />
          ) : (
            <HelperText>
              별칭을 포함해도 일치하는 보스가 없습니다. 다른 이름으로 찾아보세요.
            </HelperText>
          )
        ) : (
          /*
            높이는 뷰포트에 맞춰 완만하게만 키운다(224px → 최대 352px). 목록이 화면을
            다 잡아먹으면 안 되고, 나머지 도달은 스크롤이 맡는다.
          */
          <ul
            {...combobox.listboxProps}
            className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border"
          >
            {candidates.map((entry, index) => (
              <ListItem
                key={entry.bossDifficultyId}
                containerRole="presentation"
                {...combobox.getOptionProps(index)}
                /*
                  하이라이트. `ListItem` 의 `selected` 는 배경만이 아니라 **좌측 2px
                  보더**까지 바꾼다 — 색만으로 말하지 않아야 한다는 §4 요구가 그래서
                  충족된다(색각 이상에서도 왼쪽 띠가 보인다). `aria-selected` 가 같은
                  사실을 스크린리더에 전한다.
                  `aria-current` 는 끈다 — 이 줄은 "현재 위치" 가 아니라 콤보박스의
                  키보드 커서라서, 두 속성이 같은 줄에서 다른 말을 하면 안 된다.
                */
                selected={index === combobox.activeIndex}
                aria-current={undefined}
                disabled={disabled}
                onClick={() => add(entry.bossDifficultyId)}
                icon={
                  <BossIcon
                    bossDifficultyId={entry.bossDifficultyId}
                    difficulty={entry.difficulty}
                    size="sm"
                  />
                }
                trailing={
                  <span className="flex items-center gap-2">
                    <MesoAmount
                      value={entry.crystalPriceMeso}
                      compact
                      suffix={false}
                      tone="muted"
                      className="text-caption"
                    />
                    <Plus aria-hidden size={14} className="text-ink-muted" />
                  </span>
                }
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{entry.koreanName}</span>
                  <span className="shrink-0 rounded-full border border-border bg-neutral-100 px-1.5 text-overline text-ink-label">
                    {entry.shortName}
                  </span>
                  {entry.released ? null : (
                    <span className="shrink-0 text-overline text-tertiary-ink">
                      미출시
                    </span>
                  )}
                </span>
              </ListItem>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
