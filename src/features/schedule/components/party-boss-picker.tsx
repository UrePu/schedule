"use client";

import { ChevronDown, ChevronUp, Plus, Search, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { BossIcon, MesoAmount } from "@/components/domain";
import {
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  ListItem,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
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
  /** 고를 수 있는 보스 전부 — `GET /api/schedule/bosses` 가 준 그대로(일간은 서버가 이미 뺐다). */
  readonly bosses: readonly BossCatalogEntry[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** 고른 보스 — **순서 있는 배열**이다. Set 이 아닌 이유가 이 컴포넌트의 전부다. */
  readonly selectedIds: readonly BossDifficultyId[];
  readonly onChange: (next: readonly BossDifficultyId[]) => void;
  readonly disabled?: boolean;
}

export function PartyBossPicker({
  bosses,
  isLoading,
  isError,
  onRetry,
  selectedIds,
  onChange,
  disabled = false,
}: PartyBossPickerProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");

  const normalizedQuery = normalizeQuery(query);

  const bossById = useMemo(
    () => new Map(bosses.map((entry) => [entry.bossDifficultyId, entry])),
    [bosses],
  );

  /** 고른 보스를 **고른 순서대로**. 카탈로그에 없는 id 는 버리지 않고 자리를 지킨다. */
  const selected = useMemo(
    () =>
      selectedIds.map((id) => ({ id, boss: bossById.get(id) ?? null })),
    [selectedIds, bossById],
  );

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
    onChange([...selectedIds, id]);
  };

  const remove = (id: BossDifficultyId) => {
    onChange(selectedIds.filter((entry) => entry !== id));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

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
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5"
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
              <span className="flex min-w-0 flex-1 flex-col">
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
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="이름 또는 별칭 — 하카, 하스우, 익세"
            className="pl-9"
            autoComplete="off"
            disabled={disabled}
          />
        </div>

        {isError ? (
          <ErrorState
            title="보스 목록을 불러오지 못했습니다"
            onRetry={onRetry}
            className="py-6"
          />
        ) : isLoading ? (
          <SkeletonGroup label="보스 목록을 불러오는 중">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-11" />
            ))}
          </SkeletonGroup>
        ) : candidates.length === 0 ? (
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
          <ul className="max-h-[min(50vh,22rem)] overflow-y-auto rounded-md border border-border">
            {candidates.map((entry) => (
              <ListItem
                key={entry.bossDifficultyId}
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
                    <span className="shrink-0 text-overline text-tertiary">
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
