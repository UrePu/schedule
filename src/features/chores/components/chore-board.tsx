"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import Link from "next/link";

import {
  Card,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
  StatusChip,
} from "@/components/ui";
import type { CharacterChores } from "@/features/bot/server/bot-repo";
import { fetchChoreBoard, toggleChore } from "@/features/chores/data";
import type { ChoreStatus } from "@/lib/domain/chore-status";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { formatKstFull } from "@/components/domain/kst-format";
import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 기타 숙제 — 카톡 `!숙제` 의 **웹 판**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20)로 만들어진 화면이다. 지금까지 숙제는 **카톡에만** 있었고
 * 웹에는 아예 없었다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 봇과 **같은 조립기**를 본다 — 판정을 여기서 다시 만들지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 완료 판정은 간단해 보이지만 실제로는 세 겹이다: 넥슨 스냅샷(15분 지연) · 사람이 직접
 * 체크한 값(넥슨보다 우선) · 인게임에 등록조차 안 한 항목(줄에서 빠짐). 이걸 화면에서
 * 다시 짜면 "웹은 했다는데 봇은 안 했다고 한다"가 반드시 생긴다.
 * → `fetchChoreBoard()` 가 낸 결과를 **그대로 그린다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 카톡과 다른 점: **다 한 항목도 보여 준다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `!숙제` 는 남은 것만 적는다 — 카톡 한 줄에 들어갈 폭이 없고, `X` 가 안 한 칸마다
 * 붙는 상수라 정보가 0이면서 폭만 먹기 때문이다(`commands.ts` 의 같은 주석).
 *
 * 여기는 사정이 다르다. **체크박스를 눌러야 하는 화면**이라 대상이 화면에 있어야 하고,
 * 다 한 항목을 지우면 "방금 잘못 체크했다"를 되돌릴 자리가 사라진다. 대신 §1.1.1 의
 * *"할 일 목록이지 트로피 진열장이 아니다"* 는 **정렬과 강조**로 지킨다:
 *   · 남은 게 많은 캐릭터가 위
 *   · 다 한 항목은 취소선 없이 **흐리게**(`ink-muted`) — 읽히되 먼저 읽히지 않는다
 *   · 다 한 캐릭터는 카드 머리에 완료 칩 하나로 접힌다
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 일간 항목에 체크박스가 없는 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 수동 체크는 `chore_completions` 의 **주간(scope='weekly')** 행만 읽고 쓴다
 * (`fetchChoreBoard` 의 `.eq("chore_definitions.scope", "weekly")`). 일퀘·몬파에는
 * 켤 자리가 애초에 없으므로 **없는 것을 있는 척 그리지 않는다.** 그 둘은 넥슨 판정만
 * 있고, 그래서 `ChoreStatus.slug` 도 실려 오지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **데이터는 캐시가 소유한다** (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 체크는 판 **전체**를 응답으로 받아 그대로 캐시에 얹는다(`setQueryData`). 한 줄만
 * 갈아 끼우면 그 합치는 규칙이 서버 조립기와 두 벌이 된다.
 * 티어: db(60초). **넥슨 호출 0건** — 마지막 동기화 결과를 읽을 뿐이다.
 */

/** 남은 항목 수. 정렬과 머리 칩이 같은 값을 본다. */
function remainingCount(character: CharacterChores): number {
  return [...character.daily, ...character.weekly].filter(
    (chore) => chore.state === "todo",
  ).length;
}

export function ChoreBoard() {
  const queryClient = useQueryClient();

  const boardQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.chores.board()),
    queryFn: fetchChoreBoard,
  });

  const toggle = useMutation({
    mutationFn: toggleChore,
    onSuccess: (characters) => {
      /*
        ★ 응답이 판 전체라 **그대로 얹는다.** 다시 조회하면 왕복이 한 번 더 늘고,
          그 사이 체크가 잠깐 되돌아 보인다.
        ★ 무효화는 하지 않는다 — 이 화면 말고 이 키를 읽는 곳이 없다(§2.4 Rule 5).
      */
      queryClient.setQueryData(queryKeys.db.chores.board(), characters);
    },
  });

  const board = boardQuery.data;

  if (board === undefined) {
    return boardQuery.isError ? (
      <ErrorState
        title="숙제를 불러오지 못했습니다"
        detail={boardQuery.error.message}
        onRetry={() => void boardQuery.refetch()}
      />
    ) : (
      <SkeletonGroup label="숙제를 불러오는 중">
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </SkeletonGroup>
    );
  }

  if (board.length === 0) {
    return (
      <EmptyState
        title="추적 중인 캐릭터가 없습니다"
        description="숙제는 추적 중인 캐릭터에 대해서만 집계합니다. 관리 › 기타에서 추적할 캐릭터를 먼저 골라 주세요."
        action={
          <Link
            href="/etc"
            className="text-body-sm text-primary underline-offset-2 hover:underline"
          >
            추적 캐릭터 고르러 가기 →
          </Link>
        }
      />
    );
  }

  /*
    남은 게 많은 순. 같으면 본캐 먼저, 그다음 이름순 — **정렬이 흔들리지 않아야**
    체크할 때마다 카드가 눈앞에서 자리를 바꾸지 않는다(같은 값이면 항상 같은 순서).
  */
  const ordered = [...board].sort((a, b) => {
    const diff = remainingCount(b) - remainingCount(a);
    if (diff !== 0) return diff;
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.characterName.localeCompare(b.characterName, "ko-KR");
  });

  return (
    <div className="flex flex-col gap-3">
      {toggle.isError ? (
        <ErrorState
          title="체크를 저장하지 못했습니다"
          detail={toggle.error.message}
          onRetry={() => {
            toggle.reset();
          }}
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ordered.map((character) => (
          <CharacterCard
            key={character.characterId}
            character={character}
            isSaving={toggle.isPending}
            onToggle={(slug, done) => {
              toggle.mutate({
                characterId: character.characterId,
                slug,
                done,
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function CharacterCard({
  character,
  isSaving,
  onToggle,
}: {
  readonly character: CharacterChores;
  readonly isSaving: boolean;
  readonly onToggle: (slug: string, done: boolean) => void;
}) {
  const remaining = remainingCount(character);
  const hasAny = character.daily.length + character.weekly.length > 0;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-body-lg">
          {/* 본캐 표시. 이모지는 **보조 채널**이라 보조기기용 글자를 함께 싣는다. */}
          {character.isMain ? (
            <>
              <span aria-hidden>⭐</span>
              <span className="sr-only">본캐 </span>
            </>
          ) : null}
          <span className="truncate">{character.characterName}</span>
        </CardTitle>

        {remaining === 0 ? (
          <StatusChip status="done" icon={<Check aria-hidden size={12} />}>
            {hasAny ? "전부 완료" : "등록된 숙제 없음"}
          </StatusChip>
        ) : (
          /*
            남은 숙제는 `soon`(주황)이다. `failed`(red)는 실패·취소 전용이라(§4)
            여기 쓰면 "실패한 숙제"로 읽힌다.
          */
          <StatusChip status="soon">{remaining}개 남음</StatusChip>
        )}
      </div>

      {hasAny ? (
        <ul className="flex flex-col gap-1.5">
          {character.daily.map((chore) => (
            <li key={`daily-${chore.label}`}>
              <ReadOnlyChore chore={chore} scope="일간" />
            </li>
          ))}
          {character.weekly.map((chore) => (
            <li key={`weekly-${chore.label}`}>
              {chore.slug === undefined ? (
                <ReadOnlyChore chore={chore} scope="주간" />
              ) : (
                <CheckableChore
                  chore={chore}
                  slug={chore.slug}
                  disabled={isSaving}
                  onToggle={onToggle}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        /*
          인게임 스케줄러에 등록하지 않은 항목은 조립기가 줄에서 뺀다 — 안 한 것이
          아니라 **할 일이 아니다.** 그 사실을 말하지 않으면 빈 카드가 고장으로 읽힌다.
        */
        <p className="text-body-sm text-ink-muted">
          인게임 스케줄러에 등록된 숙제가 없습니다. 게임에서 등록하면 다음 동기화에
          나타납니다.
        </p>
      )}

      <p className="text-caption text-ink-muted">
        {character.syncedAt === null
          ? "동기화한 적 없음"
          : `마지막 동기화 ${formatKstFull(new Date(character.syncedAt))}`}
      </p>
    </Card>
  );
}

/** 항목 이름 + 진행 표시. 두 렌더가 같은 줄 모양을 갖도록 여기 한 곳에서 만든다. */
function ChoreLabel({
  chore,
  scope,
}: {
  readonly chore: ChoreStatus;
  readonly scope: string;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate text-body-sm">{chore.label}</span>
      <span className="sr-only">{scope} </span>
      {/*
        `몬파` 만 갖는 `3/7`. 남은 횟수가 곧 할 일의 양이라 O/X 로 접으면 정보가
        사라진다(발주 정정 2026-08-19).
      */}
      {chore.detail === undefined ? null : (
        <span className="text-caption tabular-nums text-ink-muted">
          {chore.detail}
        </span>
      )}
    </span>
  );
}

/** 체크할 수 없는 항목(일간 전부, 슬러그가 없는 주간). 넥슨 판정만 있다. */
function ReadOnlyChore({
  chore,
  scope,
}: {
  readonly chore: ChoreStatus;
  readonly scope: string;
}) {
  const done = chore.state === "done";

  return (
    <span
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
        done ? "text-ink-muted" : "text-ink",
      )}
    >
      <ChoreLabel chore={chore} scope={scope} />
      {/*
        상태는 **글자로도** 말한다 — 색·아이콘 단독은 §4 가 금지한다.
        `완료`/`남음` 두 낱말이라 폭도 문제되지 않는다.
      */}
      <span
        className={cn(
          "shrink-0 text-caption",
          done ? "text-ink-muted" : "font-semibold text-tertiary-ink",
        )}
      >
        {done ? "완료" : "남음"}
      </span>
    </span>
  );
}

/**
 * 사람이 직접 체크하는 주간 항목.
 *
 * ★ 체크는 **넥슨 판정을 이긴다.** 넥슨 데이터는 15분 늦으므로(§1.1) 방금 깬 것을
 *   반영할 길이 이것뿐이다. 해제도 같은 무게로 저장된다 — "체크했다가 지웠다"는
 *   "체크한 적 없다"와 다르고, 지운 상태가 넥슨 판정을 되살리면 안 된다.
 */
function CheckableChore({
  chore,
  slug,
  disabled,
  onToggle,
}: {
  readonly chore: ChoreStatus;
  readonly slug: string;
  readonly disabled: boolean;
  readonly onToggle: (slug: string, done: boolean) => void;
}) {
  const done = chore.state === "done";

  return (
    <span
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
        "transition duration-200 hover:bg-hover-surface",
      )}
    >
      <Checkbox
        checked={done}
        disabled={disabled}
        onChange={(event) => {
          onToggle(slug, event.currentTarget.checked);
        }}
        label={<ChoreLabel chore={chore} scope="주간" />}
        className={done ? "text-ink-muted" : "text-ink"}
      />
      {disabled ? (
        <RefreshCw
          aria-hidden
          size={12}
          className="shrink-0 animate-spin text-ink-muted"
        />
      ) : null}
    </span>
  );
}
