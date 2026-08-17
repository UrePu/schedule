"use client";

import { CalendarPlus, Search, Swords, TriangleAlert, UserRound } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import {
  BOSS_DIFFICULTY_LABEL,
  MesoAmount,
  formatKstShort,
} from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  ListItem,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { kstMoment } from "@/lib/time/kst-wallclock";
import { cn } from "@/lib/utils";
import type {
  BossCatalogEntry,
  CreateRunInput,
  OverlapWindow,
  PartyId,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import { crystalShareMeso } from "../lib/crystal";
import type { DayRow } from "../lib/overlay-layout";

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
 */

/** `party_runs.duration_minutes` 의 기본값. 지금은 고정으로 둔다. */
const DEFAULT_DURATION_MINUTES = 30;

const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

/** 별칭까지 훑는 검색. 봇의 `!등록 카룡 21시` 와 같은 어휘를 화면에서도 쓴다. */
function matchesBoss(boss: BossCatalogEntry, query: string): boolean {
  if (query === "") return true;
  const haystack = [
    boss.koreanName,
    boss.bossKoreanName,
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

export interface RunComposerProps {
  readonly partyId: PartyId;
  readonly dayRows: readonly DayRow[];
  readonly bosses: readonly BossCatalogEntry[];
  readonly isBossLoading: boolean;
  readonly isBossError: boolean;
  readonly onBossRetry: () => void;
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
   * 일정 초안(날짜·시각·인원)은 **부모가 들고 있다.**
   * 왼쪽 패널에서 겹침 막대를 누르는 것도 이 값을 바꾸는 행위이므로,
   * 두 컴포넌트가 공유하는 상태다. 폼 안에 두고 effect 로 동기화하면
   * 부모 이벤트 → 자식 effect → 재렌더의 연쇄가 생긴다.
   */
  readonly dayKey: string;
  readonly onDayKeyChange: (dayKey: string) => void;
  readonly timeText: string;
  readonly onTimeTextChange: (timeText: string) => void;
  readonly partySizeText: string;
  readonly onPartySizeTextChange: (value: string) => void;
  readonly onSubmit: (input: CreateRunInput) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
  /** 파티가 선택되지 않았으면 등록할 대상이 없다. */
  readonly disabled?: boolean;
}

export function RunComposer({
  partyId,
  dayRows,
  bosses,
  isBossLoading,
  isBossError,
  onBossRetry,
  characters,
  isCharacterLoading,
  isCharacterError,
  onCharacterRetry,
  isSignedIn,
  characterId,
  onCharacterIdChange,
  selectedWindow,
  selectedPersonIds,
  dayKey,
  onDayKeyChange,
  timeText,
  onTimeTextChange,
  partySizeText,
  onPartySizeTextChange,
  onSubmit,
  isSubmitting,
  submitError,
  disabled = false,
}: RunComposerProps) {
  const searchId = useId();
  const dayId = useId();
  const timeId = useId();
  const sizeId = useId();
  const characterFieldId = useId();

  const [query, setQuery] = useState("");
  const [bossId, setBossId] = useState<string | null>(null);

  const normalizedQuery = normalizeQuery(query);
  const matches = useMemo(
    () => bosses.filter((boss) => matchesBoss(boss, normalizedQuery)).slice(0, 8),
    [bosses, normalizedQuery],
  );

  const boss = useMemo(
    () => bosses.find((entry) => entry.bossDifficultyId === bossId) ?? null,
    [bosses, bossId],
  );

  const partySize = Number.parseInt(partySizeText, 10);
  const partySizeValid = Number.isInteger(partySize) && partySize >= 1 && partySize <= 24;
  const startMinutes = minutesFromTimeText(timeText);
  const shareMeso = crystalShareMeso(
    boss?.crystalPriceMeso ?? null,
    partySizeValid ? partySize : 1,
  );

  const overMaxParty =
    boss !== null && partySizeValid && partySize > boss.maxParty;

  /** 목록에 실제로 있는 캐릭터인가 — 목록이 갱신되면 예전 선택이 사라질 수 있다. */
  const selectedCharacter =
    characters.find((entry) => entry.characterId === characterId) ?? null;

  const canSubmit =
    !disabled &&
    boss !== null &&
    partySizeValid &&
    startMinutes !== null &&
    // ★ 캐릭터가 없으면 등록하지 않는다. 12개 상한이 캐릭터당이라 캐릭터 없는
    //   일정은 결정석 집계에 들어갈 수 없다 (§1).
    selectedCharacter !== null &&
    !isSubmitting;

  const participantPersonIds =
    selectedWindow?.personIds ?? selectedPersonIds;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <CalendarPlus aria-hidden size={18} className="text-primary" />
        <CardTitle className="text-body-lg">보스 일정 등록</CardTitle>
      </div>

      {selectedWindow ? (
        <p className="rounded-md bg-primary-subtle px-3 py-2 text-body-sm text-primary">
          선택한 시간대 · {formatKstShort(selectedWindow.startsAt)} ~{" "}
          {formatKstShort(selectedWindow.endsAt)} · {selectedWindow.availableCount}
          명 가능
        </p>
      ) : (
        // `neutral-100` 위의 `ink-muted` 는 라이트에서 4.40:1 로 아슬하게 미달이다.
        // 한 단계 진한 `ink-label` 은 라이트 9.50 / 다크 10.83 이다.
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
            boss === null ||
            startMinutes === null ||
            selectedCharacter === null
          ) {
            return;
          }
          onSubmit({
            partyId,
            bossDifficultyId: boss.bossDifficultyId,
            scheduledAt: kstMoment(dayKey, startMinutes),
            durationMinutes: DEFAULT_DURATION_MINUTES,
            entryPartySize: partySize,
            participantPersonIds,
            characterId: selectedCharacter.characterId,
            note: null,
          });
        }}
      >
        {/* 보스 선택 (별칭 검색) */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={searchId} required>
            보스
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
              placeholder="이름 또는 별칭 — 카룡, 하스우, 익세렌"
              className="pl-9"
              autoComplete="off"
            />
          </div>

          {isBossError ? (
            <ErrorState
              title="보스 목록을 불러오지 못했습니다"
              onRetry={onBossRetry}
              className="py-6"
            />
          ) : isBossLoading ? (
            <SkeletonGroup label="보스 목록을 불러오는 중">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-11" />
              ))}
            </SkeletonGroup>
          ) : matches.length === 0 ? (
            <HelperText>
              별칭을 포함해도 일치하는 보스가 없습니다. 다른 이름으로 찾아보세요.
            </HelperText>
          ) : (
            <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
              {matches.map((entry) => (
                <ListItem
                  key={entry.bossDifficultyId}
                  selected={entry.bossDifficultyId === bossId}
                  onClick={() => setBossId(entry.bossDifficultyId)}
                  icon={<Swords aria-hidden size={16} />}
                  trailing={
                    <MesoAmount
                      value={entry.crystalPriceMeso}
                      compact
                      suffix={false}
                      tone="muted"
                      className="text-caption"
                    />
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{entry.koreanName}</span>
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
              시각 (KST)
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

        {/* 파티 인원수 */}
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
          {overMaxParty ? (
            <HelperText className="inline-flex items-center gap-1 text-tertiary">
              <TriangleAlert aria-hidden size={14} />
              {boss?.koreanName} 의 최대 파티는 {boss?.maxParty}인입니다. 막지는
              않지만 확인해 주세요.
            </HelperText>
          ) : (
            <HelperText>
              실제로 입장하는 인원입니다. 이 값으로 결정석이 1/n 로 나뉩니다.
            </HelperText>
          )}
        </div>

        {/* 예상 결정석 수익 */}
        <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-3">
          {/*
            보스를 아직 안 골랐을 때는 "미확인"을 쓰지 않는다.
            "미확인"은 §1.3 D4 의 도메인 주장(가격 출처가 없다)이라 "아직 안 골랐다"와
            같은 말로 쓰면 안 된다.
          */}
          {boss === null ? (
            <p className="text-body-sm text-ink-muted">
              보스를 선택하면 예상 결정석 수령액이 여기에 표시됩니다.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption text-ink-muted">
                  결정석 (솔로 기준가)
                </span>
                <MesoAmount
                  value={boss.crystalPriceMeso}
                  compact
                  tone="muted"
                  className="text-body-sm"
                />
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption text-ink-label">
                  예상 수령액 · {partySizeValid ? partySize : "-"}인 분배
                </span>
                <MesoAmount
                  value={shareMeso}
                  compact
                  tone="accent"
                  className="text-body-sm font-semibold"
                />
              </div>
              {boss.crystalPriceMeso === null ? (
                /*
                  주황이 배경·아이콘을 맡고 문장은 잉크가 맡는다. `text-tertiary` 로
                  문장을 그리면 라이트에서 2.80:1 로 AA 미달이다(다크만 보면 7.82:1 로
                  통과해 지나친다). 의미(§4 임박·주의 = 주황)는 그대로다.
                */
                <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span>
                    가격 미확인 — 0 메소가 아니라 &ldquo;모른다&rdquo;입니다. 수익
                    합계에서 제외됩니다 (§1.3 D4).
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

        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting ? "등록 중…" : "일정 등록"}
        </Button>
        {boss === null ? (
          <HelperText>보스를 먼저 선택해 주세요.</HelperText>
        ) : selectedCharacter === null ? (
          <HelperText>어느 캐릭터로 갈지 먼저 선택해 주세요.</HelperText>
        ) : (
          <HelperText>
            {BOSS_DIFFICULTY_LABEL[boss.difficulty]} {boss.bossKoreanName} ·{" "}
            {DEFAULT_DURATION_MINUTES}분 · {selectedCharacter.name}(으)로 참가 ·{" "}
            {participantPersonIds.length}명 참여 예정으로 등록됩니다.
          </HelperText>
        )}
      </form>
    </Card>
  );
}
