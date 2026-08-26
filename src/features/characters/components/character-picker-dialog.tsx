"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { ApiRequestError } from "@/features/auth/data/auth-api";
import { useNexonCharacterPortraitQuery } from "@/features/auth/data/auth-queries";
import { useStoredApiKeys } from "@/features/auth/lib/use-stored-api-key";
import { dbQueryOptions } from "@/lib/query-keys";
import type { GameCharacter, TrackedCharacterSelection } from "@/types/domain";

import {
  characterQueryKeys,
  fetchOwnedCharacters,
  toGameCharacter,
  type TrackableCharacter,
} from "../data";
import {
  CHARACTER_PAGE_SIZE,
  clampPage,
  pageCount,
  pageOf,
  sortByLevelDesc,
} from "../lib/top-characters";
import { CharacterCard } from "./character-card";

/**
 * 캐릭터 선택 모달 (§2.1.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 목록은 **우리 DB**, 초상화만 넥슨
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인이 이미 `/character/list` 를 1콜 불러 `public.characters` 에 넣어 두었다.
 * 모달이 열릴 때마다 그걸 다시 부르면 같은 데이터에 쿼터만 태우므로 목록은
 * `GET /api/characters`(넥슨 콜 0)에서 가져온다.
 *
 * 넥슨을 타는 것은 **초상화뿐**이다 — `/character/basic` 이 캐릭터당 1콜이라
 * **지금 보이는 페이지 12명분만**, 그것도 `open` 일 때만 나간다. 저장된
 * `image_url` 이 있으면 그 캐릭터는 호출 자체를 건너뛴다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 페이지네이션 — 59명 → **304명**이 되면서 필수가 됐다
 * ─────────────────────────────────────────────────────────────────────────────
 * 부계정 키를 연결하자 로스터가 304명이 되어 "상위 12명 고정"은 96%를 숨기게 됐다.
 * 이제 **전체를 레벨 내림차순으로 정렬한 뒤 12명씩 페이지로** 넘긴다.
 *
 * 호출량이 이 설계의 전부다:
 * - **한 페이지 = 초상화 12콜.** 304명을 한 번에 그리면 하루 예산(1,000)의 3분의 1이
 *   모달 한 번에 날아간다.
 * - 보이지 않는 페이지의 카드는 **렌더되지 않는다.** 초상화 훅이 카드 안에 있으므로,
 *   렌더되지 않으면 요청도 없다 — "12명분만"이 조건문이 아니라 **구조로** 보장된다.
 * - 이미 본 페이지로 돌아가면 `nexonQueryOptions()`(staleTime 15분 ·
 *   `refetchOnMount: false`)가 캐시를 그대로 쓴다. **왕복이 0건이다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 선택 상태 — **초안(draft) 없으면 서버 상태**, 그리고 **페이지를 넘어 살아남는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 선택의 진실은 서버의 `is_tracked` / `is_main` 이다. 그것을 `useState` 초기값으로
 * 복사하면 (a) 데이터가 나중에 도착하는 순간을 effect 로 쫓아야 하고 (b) 저장 후 서버
 * 값과 갈라진다. 그래서 사용자가 건드리기 전까지는 **서버 값을 그대로 보여 주고**,
 * 첫 조작이 있을 때만 초안을 만든다. 닫으면 초안을 버린다 — "취소는 취소"가 성립한다.
 *
 * ★ 초안은 **전역 id 목록**이지 페이지별 상태가 아니다. 그래서 1페이지에서 체크하고
 *   3페이지를 들렀다 돌아와도 체크가 남아 있고, 하단의 "N명 선택"은 **모든 페이지를
 *   통틀어** 센 값이며, 저장하면 **보이지 않는 페이지에서 고른 것까지** 함께 나간다.
 *   `page` 는 보기 상태일 뿐 선택에 관여하지 않는다 — 그 분리가 이 요구의 답이다.
 * ★ **본캐는 전체에서 하나**다. 페이지와 무관하게 `mainCharacterId` 하나만 존재한다.
 */

/**
 * 카드 그리드 — 넓은 화면에서 **6열 × 2행 = 12장**.
 *
 * 6열은 `CHARACTER_PAGE_SIZE`(12)와 맞물려 나온 수다. 12는 레이아웃이 아니라 **초상화
 * 호출 수**(캐릭터당 1콜)가 정한 값이고, 6열이면 그 12장이 정확히 두 줄로 떨어져 모달이
 * 세로로 길어지지 않는다.
 *
 * ⚠️ 6열 진입점이 `lg`(≥1024px)인 것은 **모달 폭이 뷰포트를 따라가지 않기 때문**이다.
 *    패널은 `sm:max-w-5xl` 이라 폭이 `min(뷰포트 − 32, 1024)` 로 **1024px 에서 상한에
 *    닿는다.** 즉 뷰포트가 1024px 을 넘는 순간 모달은 이미 최대 폭이고, 그 위로 아무리
 *    넓어져도 격자가 쓸 수 있는 폭은 더 늘지 않는다. 진입점을 `xl`(≥1280px)에 두면
 *    **1024–1279px 구간에서 모달은 최대 폭인데 열만 모자라** 6×2 가 나오지 않는다 —
 *    실제로 그 구간을 보고 "6열이 안 보인다"는 보고가 올라왔다. 열 수를 정하는 것은
 *    뷰포트가 아니라 **모달 폭**이므로, 모달이 최대가 되는 지점과 6열이 되는 지점은
 *    같아야 한다. **다시 `xl` 로 올리지 말 것.**
 *
 * 그 지점의 실제 치수: 뷰포트 1024px → 패널 992px → 본문 960px(좌우 `p-pad-lg`) →
 * 한 칸 약 **153px**. 뷰포트가 1056px 이상이면 패널이 1024px 로 고정되어 본문 992px,
 * 한 칸 약 **159px** 에서 더는 변하지 않는다.
 *
 * ⚠️ 한때 *"이미지를 키워 달라"* 는 요구를 **열 수를 6 → 4 로 줄여** 카드 전체를 키우는
 *    것으로 처리한 적이 있다. 요구 대상은 격자가 아니라 **초상화**였다. 카드 바깥 크기는
 *    이 격자가 정하고, 초상화는 카드 *안에서* — 패딩과 텍스트 여백을 깎아 초상화가
 *    차지하는 비율을 올리는 방식으로 키운다(`character-card.tsx` 참고).
 *    **열 수를 늘리거나 모달을 넓히는 방향으로 도망가지 말 것.**
 *
 * 좁은 화면에서는 **열 수만** 단계적으로 줄인다(6 → 4 → 3 → 2). 행 수를 고정하면
 * 카드가 뭉개진다. 휴대폰(<640px)의 2열이 하한이다 — 그보다 줄이면 한 장이 화면을 다
 * 먹고, 그 폭에서 한 칸은 이미 데스크톱 한 칸보다 넓다.
 */
const GRID_CLASS =
  "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6";

export interface CharacterPickerDialogProps {
  readonly open: boolean;
  /** 취소·Esc·배경 클릭·닫기 버튼이 전부 이 경로로 온다. 초안은 여기서 버려진다. */
  readonly onClose: () => void;
  readonly onSave: (selection: TrackedCharacterSelection) => void;
  readonly isSaving?: boolean;
  /** 저장 실패 문구. `ApiRequestError.message` 를 그대로 넘긴다. */
  readonly saveErrorMessage?: string | null;
}

export function CharacterPickerDialog({
  open,
  onClose,
  onSave,
  isSaving = false,
  saveErrorMessage = null,
}: CharacterPickerDialogProps) {
  /**
   * `credentialId → 원문 키`. **초상화도 캐릭터마다 다른 키가 필요하다** —
   * 넥슨 키는 자기 계정의 캐릭터만 읽으므로(§1.1), 부계정 캐릭터를 본계정 키로 부르면
   * `OPENAPI00004` 로 거절당하면서 호출량만 태운다. 로스터가 304명인 계정에서 이건
   * 실루엣 몇 장이 아니라 예산 문제다.
   */
  const storedApiKeys = useStoredApiKeys();

  /**
   * 목록은 **우리 DB** 라 `"db"` 네임스페이스이고 `db` 티어(60초)를 쓴다.
   * `enabled: open` 인 이유는 쿼터가 아니라(넥슨을 타지 않는다) 닫힌 모달 때문에
   * 페이지 로드마다 세션 왕복을 하나 더 만들 이유가 없어서다 — 같은 이유로
   * **prefetch 대상도 아니다**.
   */
  const listQuery = useQuery({
    ...dbQueryOptions(characterQueryKeys.list()),
    queryFn: fetchOwnedCharacters,
    enabled: open,
  });

  const rows: readonly TrackableCharacter[] = useMemo(
    () => listQuery.data ?? [],
    [listQuery.data],
  );

  const characters: readonly GameCharacter[] = useMemo(
    () => rows.map(toGameCharacter),
    [rows],
  );

  /** 저장된 초상화. 있으면 그 캐릭터는 넥슨 호출을 건너뛴다. */
  const storedImageById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const row of rows) map.set(row.id, row.imageUrl);
    return map;
  }, [rows]);

  /**
   * 캐릭터 → 그 캐릭터를 읽을 수 있는 자격증명. 서버가 `GET /api/characters` 에 실어 준다.
   * `null` 이면 그 계정에 쓸 수 있는 키가 없다는 뜻이고, 초상화는 실루엣으로 둔다.
   */
  const credentialIdByCharacter = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const row of rows) map.set(row.id, row.credentialId);
    return map;
  }, [rows]);

  /** 서버가 말하는 현재 상태. 사용자가 아무것도 건드리지 않았으면 이게 곧 선택이다. */
  const baseline: TrackedCharacterSelection = useMemo(
    () => ({
      characterIds: rows.filter((row) => row.isTracked).map((row) => row.id),
      mainCharacterId: rows.find((row) => row.isMain)?.id ?? null,
    }),
    [rows],
  );

  const [draft, setDraft] = useState<TrackedCharacterSelection | null>(null);
  const selection = draft ?? baseline;

  /**
   * 보기 상태(페이지)와 선택 상태(초안)는 **완전히 분리돼 있다.**
   * 페이지를 넘겨도 `draft` 는 그대로이므로 선택이 살아남는다.
   */
  const [page, setPage] = useState(0);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * 검색 — **레벨 낮은 계정은 페이지 끝에 파묻힌다**
   * ═════════════════════════════════════════════════════════════════════════
   *
   * 발주 지적(2026-08-26): *"바이보라 < 추적 캐릭터쪽에 Tanya 계정이 안뜬대"*.
   *
   * 조사해 보니 **없는 것이 아니라 보이지 않는 것**이었다. 그 계정의 캐릭터 7명은
   * 레벨 70~154 인데 같은 사용자의 다른 계정에 레벨 200+ 가 85명 있어, 레벨 내림차순
   * 92명 × 12/쪽 = 8쪽 중 **7~8쪽**으로 밀렸다. 목록에는 있지만 여덟 쪽을 넘겨야 나온다.
   *
   * 정렬을 바꾸는 것은 답이 아니다 — 레벨 내림차순은 "주로 쓰는 캐릭터가 먼저"라는
   * 규칙이고 그건 옳다. 대신 **찾을 방법**을 준다. 이름·월드·직업 어느 쪽으로도 걸린다:
   * 계정을 통째로 찾는 사람은 월드로, 한 캐릭터를 찾는 사람은 이름으로 친다.
   *
   * ★ 검색은 **정렬·페이지보다 앞**에 놓는다. 걸러진 결과 위에서 다시 쪽을 나눠야
   *   "3쪽인데 검색 결과는 2명" 같은 상태가 생기지 않는다.
   * ★ 선택(`draft`)은 검색과 **무관하다.** 검색어를 지워도 체크는 그대로다 — 페이지를
   *   넘겨도 살아남는 것과 같은 이유이고, 그래서 여러 번 검색해 가며 고를 수 있다.
   */
  const [query, setQuery] = useState("");

  /** 전체를 레벨 내림차순으로 한 번만 정렬한다. 동점은 이름 → ocid 로 결정론적으로 갈린다. */
  const all = useMemo(() => sortByLevelDesc(characters), [characters]);

  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/\s+/g, "");
    if (needle === "") return all;
    return all.filter((character) =>
      [character.name, character.worldName, character.className].some((value) =>
        value.toLowerCase().replace(/\s+/g, "").includes(needle),
      ),
    );
  }, [all, query]);

  const totalPages = pageCount(sorted.length, CHARACTER_PAGE_SIZE);
  /** 목록이 줄어(추적 해제·키 삭제) 페이지가 비어도 빈 화면에 갇히지 않는다. */
  const safePage = clampPage(page, sorted.length, CHARACTER_PAGE_SIZE);

  /** 지금 그리는 12명. **초상화 호출은 정확히 이 배열의 크기만큼** 나간다. */
  const visible = useMemo(
    () => pageOf(sorted, safePage, CHARACTER_PAGE_SIZE),
    [sorted, safePage],
  );

  const selectedSet = useMemo(
    () => new Set(selection.characterIds),
    [selection.characterIds],
  );
  const visibleSelectedCount = visible.filter((character) =>
    selectedSet.has(character.characterId),
  ).length;
  const allVisibleSelected =
    visible.length > 0 && visibleSelectedCount === visible.length;

  function updateSelection(
    next: (current: TrackedCharacterSelection) => TrackedCharacterSelection,
  ): void {
    setDraft((current) => next(current ?? baseline));
  }

  function handleToggle(characterId: string): void {
    updateSelection((current) => {
      const included = current.characterIds.includes(characterId);
      return {
        characterIds: included
          ? current.characterIds.filter((id) => id !== characterId)
          : [...current.characterIds, characterId],
        // 본캐를 추적에서 빼면 본캐 지정도 함께 풀린다 —
        // 표시 정체성이 본캐 닉네임이므로 추적하지 않는 본캐는 성립하지 않는다(§2.1).
        mainCharacterId:
          included && current.mainCharacterId === characterId
            ? null
            : current.mainCharacterId,
      };
    });
  }

  /** 본캐 지정은 곧 추적 대상 포함이다. 하나만 지정되며 다시 누르면 해제된다. */
  function handleSetMain(characterId: string): void {
    updateSelection((current) => ({
      characterIds: current.characterIds.includes(characterId)
        ? current.characterIds
        : [...current.characterIds, characterId],
      mainCharacterId:
        current.mainCharacterId === characterId ? null : characterId,
    }));
  }

  /**
   * 전체 선택 / 해제의 범위는 **이 페이지뿐**이다.
   *
   * 304명을 한 번에 추적 대상으로 넣으면 스케줄러 동기화가 **캐릭터당 1콜**이라
   * 하루 예산(1,000콜)의 3분의 1이 한 번의 클릭으로 예약된다. 그래서 범위를 페이지로
   * 좁혔고, **버튼 라벨에 그 범위를 적어** 사용자가 오해할 여지를 없앴다.
   */
  function handleSelectAllVisible(): void {
    updateSelection((current) => {
      const next = new Set(current.characterIds);
      for (const character of visible) next.add(character.characterId);
      return { ...current, characterIds: [...next] };
    });
  }

  function handleClearVisible(): void {
    const visibleIds = new Set(visible.map((c) => c.characterId));
    updateSelection((current) => ({
      characterIds: current.characterIds.filter((id) => !visibleIds.has(id)),
      mainCharacterId:
        current.mainCharacterId !== null &&
        visibleIds.has(current.mainCharacterId)
          ? null
          : current.mainCharacterId,
    }));
  }

  /**
   * 닫기는 곧 초안 폐기다. 다시 열면 서버 상태에서 다시 시작한다.
   * 페이지도 1페이지로 되돌린다 — 다음에 열었을 때 26페이지가 떠 있으면 사용자는
   * 자기 캐릭터가 사라졌다고 생각한다.
   */
  function handleClose(): void {
    setDraft(null);
    setPage(0);
    onClose();
  }

  const mainCharacterName =
    characters.find(
      (character) => character.characterId === selection.mainCharacterId,
    )?.name ?? null;

  const listError = listQuery.error;
  const needsLogin =
    listError instanceof ApiRequestError && listError.kind === "unauthenticated";

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="추적할 캐릭터 선택"
      description={`레벨 높은 순으로 한 페이지에 ${CHARACTER_PAGE_SIZE}명씩 보여 줍니다. 고른 캐릭터만 동기화하므로 넥슨 API 호출을 아낍니다.`}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            {/* ★ 이 수는 **모든 페이지를 통틀어** 센 값이다(현재 페이지가 아니다). */}
            <p className="text-body-sm text-ink">
              <strong className="font-semibold tabular-nums">
                {selection.characterIds.length}
              </strong>
              명 선택 (전체 페이지 합계)
              {mainCharacterName !== null ? (
                <>
                  {" · 본캐 "}
                  <strong className="font-semibold">{mainCharacterName}</strong>
                </>
              ) : (
                <span className="text-ink-muted"> · 본캐 미지정</span>
              )}
            </p>
            {saveErrorMessage !== null ? (
              <p role="alert" className="text-caption text-error">
                {saveErrorMessage}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              라벨에 **범위(이 페이지)** 를 적는다. "전체 선택"이라고만 쓰면 304명 전부로
              읽히고, 그 오해는 캐릭터당 1콜짜리 동기화 비용으로 곧장 이어진다.
            */}
            <Button
              variant="ghost"
              size="sm"
              onClick={
                allVisibleSelected ? handleClearVisible : handleSelectAllVisible
              }
              disabled={visible.length === 0}
            >
              {allVisibleSelected
                ? `이 페이지 ${visible.length}명 해제`
                : `이 페이지 ${visible.length}명 선택`}
            </Button>
            <Button variant="secondary" size="sm" onClick={handleClose}>
              취소
            </Button>
            <Button
              size="sm"
              disabled={isSaving || listQuery.isError}
              onClick={() => onSave(selection)}
            >
              {isSaving ? "저장 중…" : "저장"}
            </Button>
          </div>
        </div>
      }
    >
      {/*
        검색 칸. **목록이 있을 때만** 그린다 — 비로그인·오류·로딩 화면 위에 검색창이
        떠 있으면 칠 수 있을 것처럼 보이지만 걸릴 대상이 없다.
      */}
      {!needsLogin && !listQuery.isError && !listQuery.isPending && all.length > 0 ? (
        <div className="relative mb-3">
          <Search
            aria-hidden
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
          />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // 검색어가 바뀌면 결과가 통째로 달라진다. 3쪽에 머문 채로 두면 빈 쪽을 본다.
              setPage(0);
            }}
            placeholder={`이름 · 월드 · 직업으로 찾기 (${String(all.length)}명)`}
            className="pl-9"
            autoComplete="off"
          />
        </div>
      ) : null}

      {needsLogin ? (
        // 비로그인은 **에러가 아니라 상태**다(§2.1). 목록은 세션이 있어야 읽는다.
        <EmptyState
          title="로그인이 필요합니다"
          description="넥슨 API 키로 로그인하면 보유 캐릭터를 불러옵니다."
        />
      ) : listQuery.isError ? (
        <ErrorState
          title="캐릭터 목록을 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          detail={listError instanceof Error ? listError.message : null}
          onRetry={() => void listQuery.refetch()}
        />
      ) : listQuery.isPending ? (
        <SkeletonGroup label="캐릭터 목록을 불러오는 중">
          <ul className={GRID_CLASS}>
            {Array.from({ length: CHARACTER_PAGE_SIZE }, (_, index) => (
              <li key={index}>
                {/*
                  실제 카드 높이(6열 기준 초상화 ≈145px + 텍스트 블록 + 패딩 ≈ 220px)에
                  맞춘다. 스켈레톤이 더 크면 로딩이 끝나는 순간 격자가 튄다.
                */}
                <Skeleton className="h-56" />
              </li>
            ))}
          </ul>
        </SkeletonGroup>
      ) : visible.length === 0 ? (
        /*
          걸러서 0명인 것과 애초에 0명인 것은 **다른 상태**다. 같은 문구를 쓰면
          "키를 더 추가하라"는 엉뚱한 안내를 검색 결과가 없을 때도 하게 된다.
        */
        query.trim() === "" ? (
          <EmptyState
            title="캐릭터가 없습니다"
            description="등록된 API 키가 읽을 수 있는 계정에 캐릭터가 없습니다. 다른 키를 추가해 보세요."
          />
        ) : (
          <EmptyState
            title={`'${query.trim()}' 에 맞는 캐릭터가 없습니다`}
            description="이름 · 월드 · 직업으로 찾습니다. 검색어를 지우면 전체가 다시 보입니다."
            action={
              <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                검색어 지우기
              </Button>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          <ul className={GRID_CLASS}>
            {visible.map((character) => {
              /*
                ★ **이 캐릭터의 계정 키**를 고른다. 없으면 `null` 이고, 카드는 호출 없이
                  실루엣을 그린다 — 다른 계정 키로 대신 부르면 거절과 함께 예산만 나간다.
              */
              const credentialId =
                credentialIdByCharacter.get(character.characterId) ?? null;
              return (
              <PickerCharacterCard
                key={character.characterId}
                character={character}
                storedImageUrl={
                  storedImageById.get(character.characterId) ?? null
                }
                apiKey={
                  credentialId === null
                    ? null
                    : (storedApiKeys[credentialId] ?? null)
                }
                enabled={open}
                selected={selectedSet.has(character.characterId)}
                isMain={selection.mainCharacterId === character.characterId}
                onToggle={handleToggle}
                onSetMain={handleSetMain}
              />
              );
            })}
          </ul>

          {/* 페이지 이동. 목록이 한 페이지에 다 들어가면 그릴 이유가 없다. */}
          {totalPages > 1 ? (
            <nav
              aria-label="캐릭터 페이지"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={safePage === 0}
                aria-label="이전 페이지"
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft aria-hidden size={16} />
                이전
              </Button>

              {/*
                `aria-live` 로 페이지가 바뀐 사실을 스크린리더에 알린다 —
                버튼만 있으면 시각 없이는 무엇이 바뀌었는지 알 수 없다.
              */}
              <p
                aria-live="polite"
                className="text-body-sm text-ink-label tabular-nums"
              >
                <strong className="font-semibold text-ink">
                  {safePage + 1}
                </strong>{" "}
                / {totalPages} 페이지
              </p>

              <Button
                variant="secondary"
                size="sm"
                disabled={safePage >= totalPages - 1}
                aria-label="다음 페이지"
                onClick={() => setPage(safePage + 1)}
              >
                다음
                <ChevronRight aria-hidden size={16} />
              </Button>
            </nav>
          ) : null}

          <p className="text-body-sm text-ink-muted">
            전체 {characters.length}명 · 레벨 높은 순 · 이 페이지 {visible.length}
            명. 초상화는{" "}
            <strong className="font-semibold text-ink-label">
              보이는 페이지분만
            </strong>{" "}
            불러옵니다 — 캐릭터당 1콜이라 전부 받으면 하루 예산의 상당 부분을 한 번에
            씁니다. 선택은 페이지를 넘겨도 그대로 유지되고, 저장하면 다른 페이지에서
            고른 것까지 함께 반영됩니다.
          </p>
        </div>
      )}
    </Dialog>
  );
}

interface PickerCharacterCardProps {
  readonly character: GameCharacter;
  /** `characters.image_url` 캐시. 있으면 넥슨 호출을 아예 하지 않는다. */
  readonly storedImageUrl: string | null;
  readonly apiKey: string | null;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly isMain: boolean;
  readonly onToggle: (characterId: string) => void;
  readonly onSetMain: (characterId: string) => void;
}

/**
 * 카드 한 장 + **그 카드만의 초상화 조회**.
 *
 * 초상화 훅을 카드마다 두는 것이 핵심이다. 목록 단위로 한 번에 받으면 "보이는 12명분만"
 * 이라는 절약이 무너지고, 캐시도 캐릭터 단위로 재사용되지 않는다(§2.1.1).
 * `useNexonCharacterPortraitQuery` 는 `nexonQueryOptions()` 를 스프레드하므로
 * `staleTime ≥ 15분` · `refetchOnMount: false` 가 코드로 보장된다 — 모달을 다시 열어도
 * 재요청이 나가지 않는다.
 *
 * `imageUrl === null` 은 **정상 상태**다. 카드가 실루엣을 그리며 에러 UI 는 없다.
 */
function PickerCharacterCard({
  character,
  storedImageUrl,
  apiKey,
  enabled,
  selected,
  isMain,
  onToggle,
  onSetMain,
}: PickerCharacterCardProps) {
  const portrait = useNexonCharacterPortraitQuery({
    apiKey,
    // ocid 가 비어 있으면(옛 행) 부를 수단이 없다 → 실루엣.
    ocid: character.ocid === "" ? null : character.ocid,
    // 이미 저장된 초상화가 있으면 호출하지 않는다. 모달이 닫혀 있어도 마찬가지다.
    enabled: enabled && storedImageUrl === null,
  });

  return (
    <CharacterCard
      character={character}
      imageUrl={storedImageUrl ?? portrait.data?.imageUrl ?? null}
      selected={selected}
      isMain={isMain}
      onToggle={onToggle}
      onSetMain={onSetMain}
    />
  );
}
