"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { personScope, queryKeys } from "@/lib/query-keys";
import {
  formatDayMinute,
  kstDayKey,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import type {
  AvailabilityException,
  AvailabilityInterval,
  BossCatalogEntry,
  CreatePartyInput,
  CreateRunInput,
  OverlapWindow,
  Party,
  PartyId,
  PartyMember,
  PersonId,
  RunId,
  SaveRunSignupInput,
  ScheduledRun,
  TimeRange,
  UpdatePartyRosterInput,
  WeekKey,
} from "@/types/domain";

import {
  createParty,
  createPartyRun,
  fetchAvailability,
  fetchAvailabilityExceptions,
  fetchAvailabilityOverlap,
  fetchBossCatalog,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyMembers,
  fetchPartyRuns,
  fetchPeoplePool,
  saveRunSignup,
  updatePartyRoster,
} from "../data";
import { buildDayRows } from "../lib/overlay-layout";
import { AvailabilityPanel } from "./availability-panel";
import { overlapWindowKey } from "./overlay-grid";
import { PartyBar } from "./party-bar";
import { PartyEditorDialog, type PartyEditorMode } from "./party-editor-dialog";
import { RunComposer } from "./run-composer";
import { ScheduledRunList } from "./scheduled-run-list";

/**
 * 핵심 화면 오케스트레이터 (§1.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티가 축이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 보스마다 같이 가는 사람이 다르므로 **파티가 여러 개**이고, 고른 파티가
 * 화면 전체를 결정한다. 파티를 바꾸면 캐시 키가 전부 바뀌므로
 * 겹쳐보기·특이사항·일정 목록·번호가 **동시에** 그 파티 것으로 갈아엎어진다.
 *
 * 겹쳐보기는 언제나 **그 파티의 전원**을 그린다. "매번 누구를 볼지 고르는" 모델이
 * 아니라 "한 번 짜두고 계속 쓰는" 모델이기 때문이다 — 로스터 편집은 별도 다이얼로그다.
 * "6명이 다 안 모여도 4명이면 간다"는 로스터가 아니라 **최소 인원 필터**가 답한다.
 *
 * 서버 컴포넌트가 **첫 파티 기준**의 결과를 미리 계산해 `initial` 로 넘겨 주므로
 * 첫 페인트에 스켈레톤이 번쩍이지 않는다. 파티를 바꾼 뒤부터는 클라이언트가 조회하고,
 * 개발 환경에서는 인위적 지연 덕분에 로딩 상태가 실제로 눈에 보인다.
 */

export interface ScheduleWorkspaceProps {
  /** 서버가 정한 기준 시각. 하이드레이션 불일치를 막으려면 반드시 주입해야 한다. */
  readonly now: Date;
  /** 이번 주(목 00:00 KST → 다음 목 00:00 KST). */
  readonly range: TimeRange;
  readonly weekKey: WeekKey;
  /**
   * 열람자 본인(`app_users.id`). **비로그인은 null** 이고 그때는 캐릭터 조회를 아예
   * 켜지 않는다 — `/api/schedule/characters` 는 세션이 없으면 401 이라, 켜 두면
   * 비로그인 화면에 없어야 할 에러 UI 가 뜬다(공개 시간표는 200 이어야 한다).
   */
  readonly viewerPersonId: PersonId | null;
  readonly initial: {
    readonly parties: readonly Party[];
    readonly partyId: PartyId | null;
    readonly members: readonly PartyMember[];
    readonly personIds: readonly PersonId[];
    readonly minCount: number;
    readonly intervals: readonly AvailabilityInterval[];
    readonly overlap: readonly OverlapWindow[];
    readonly exceptions: readonly AvailabilityException[];
    readonly bosses: readonly BossCatalogEntry[];
    readonly runs: readonly ScheduledRun[];
  };
}

export function ScheduleWorkspace({
  now,
  range,
  weekKey,
  viewerPersonId,
  initial,
}: ScheduleWorkspaceProps) {
  const queryClient = useQueryClient();

  const [selectedPartyId, setSelectedPartyId] = useState<PartyId | null>(
    initial.partyId,
  );
  const [minCountChoice, setMinCountChoice] = useState<number | "all">("all");
  const [selectedWindow, setSelectedWindow] = useState<OverlapWindow | null>(
    null,
  );
  const [editor, setEditor] = useState<{
    readonly open: boolean;
    readonly mode: PartyEditorMode;
    readonly seq: number;
  }>({ open: false, mode: "create", seq: 0 });

  /** 일정 초안(날짜·시각·인원). 왼쪽 패널과 오른쪽 폼이 공유하는 상태다. */
  const [draftDayKey, setDraftDayKey] = useState(() => kstDayKey(range.from));
  const [draftTimeText, setDraftTimeText] = useState("21:00");
  const [draftPartySizeText, setDraftPartySizeText] = useState(() =>
    String(Math.max(initial.personIds.length, 1)),
  );
  /** 사용자가 인원을 직접 고쳤으면 자동 채움이 덮지 않는다 (§1.3 D3). */
  const partySizeTouched = useRef(false);

  /**
   * 등록 폼에서 고른 내 캐릭터.
   *
   * `null` 이면 아직 안 골랐다는 뜻이고, 목록이 도착하면 아래에서 **본캐**로 기본값을
   * 잡는다. effect 로 채우지 않는 이유는 그 방식이 마운트마다 연쇄 렌더를 만들기
   * 때문이다 — 파생값으로 계산하고, 사용자가 고르면 그 값이 이긴다.
   */
  const [draftCharacterId, setDraftCharacterId] = useState<string | null>(null);

  // ── 파티 ────────────────────────────────────────────────────────────────
  const partiesQuery = useQuery({
    queryKey: queryKeys.db.party.list(),
    queryFn: fetchParties,
    initialData: initial.parties,
  });

  const parties = partiesQuery.data;
  const isInitialParty = selectedPartyId === initial.partyId;
  const selectedParty =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;

  const membersQuery = useQuery({
    queryKey: queryKeys.db.party.members(selectedPartyId ?? "none"),
    queryFn: () => fetchPartyMembers(selectedPartyId ?? ""),
    enabled: selectedPartyId !== null,
    initialData: () => (isInitialParty ? initial.members : undefined),
  });

  const peopleQuery = useQuery({
    queryKey: queryKeys.db.people.pool(),
    queryFn: fetchPeoplePool,
    enabled: editor.open,
  });

  /** 겹쳐보기는 언제나 그 파티의 **전원**을 대상으로 한다. */
  const members = useMemo(
    () => [...(membersQuery.data ?? [])].sort((a, b) => a.seatNo - b.seatNo),
    [membersQuery.data],
  );
  const personIds = useMemo(
    () => members.map((member) => member.personId),
    [members],
  );

  const total = personIds.length;
  const effectiveMinCount =
    minCountChoice === "all"
      ? Math.max(total, 1)
      : Math.max(Math.min(minCountChoice, total), 1);

  const initialScope = useMemo(
    () => personScope(initial.personIds),
    [initial.personIds],
  );
  const isInitialRoster = personScope(personIds) === initialScope;

  // ── 가용 시간 ────────────────────────────────────────────────────────────
  const availabilityQuery = useQuery({
    queryKey: queryKeys.db.availability.resolve(personIds, range),
    queryFn: () => fetchAvailability(personIds, range),
    enabled: total > 0,
    initialData: () => (isInitialRoster ? initial.intervals : undefined),
  });

  const overlapQuery = useQuery({
    queryKey: queryKeys.db.availability.overlap(
      personIds,
      range,
      effectiveMinCount,
    ),
    queryFn: () => fetchAvailabilityOverlap(personIds, range, effectiveMinCount),
    enabled: total > 0,
    initialData: () =>
      isInitialRoster && effectiveMinCount === initial.minCount
        ? initial.overlap
        : undefined,
  });

  const exceptionsQuery = useQuery({
    queryKey: queryKeys.db.availability.exceptions(personIds, range),
    queryFn: () => fetchAvailabilityExceptions(personIds, range),
    enabled: total > 0,
    initialData: () => (isInitialRoster ? initial.exceptions : undefined),
  });

  const bossQuery = useQuery({
    queryKey: queryKeys.db.bosses.catalog(),
    queryFn: fetchBossCatalog,
    initialData: initial.bosses,
  });

  // ── 내 캐릭터 (일정에 데려갈 대상) ────────────────────────────────────────
  /**
   * ★ **넥슨을 부르지 않는다.** 우리 DB 의 `characters` 를 읽을 뿐이라 `"db"`
   *   네임스페이스이고 15분 하한의 대상이 아니다 (§2.1.1 — 목록의 진실은 우리 DB).
   */
  const charactersQuery = useQuery({
    queryKey: queryKeys.db.characters.forRuns(),
    queryFn: fetchMyRunCharacters,
    enabled: viewerPersonId !== null,
  });

  const characters = useMemo(
    () => charactersQuery.data ?? [],
    [charactersQuery.data],
  );

  /**
   * 실제로 쓸 캐릭터. 고르지 않았으면 **본캐**(목록 첫 행)가 기본값이다 —
   * `fetchMyRunCharacters` 가 본캐를 맨 앞으로 정렬해 준다.
   * 고른 캐릭터가 목록에서 사라졌으면(추적 해제) 기본값으로 되돌아간다.
   */
  const effectiveCharacterId =
    characters.find((entry) => entry.characterId === draftCharacterId)
      ?.characterId ??
    characters[0]?.characterId ??
    null;

  // ── 일정 (파티에 속한다) ──────────────────────────────────────────────────
  const runsQuery = useQuery({
    queryKey: queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
    queryFn: () => fetchPartyRuns(selectedPartyId ?? "", weekKey),
    enabled: selectedPartyId !== null,
    initialData: () => (isInitialParty ? initial.runs : undefined),
  });

  const createRun = useMutation({
    mutationFn: (input: CreateRunInput) => createPartyRun(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(created.partyId, weekKey),
      });
    },
  });

  /**
   * 참가 신청(캐릭터 지정/변경).
   *
   * 신청 중인 런을 따로 들고 있는 이유: 목록에 버튼이 여러 개라 `isPending` 하나로는
   * 전부가 동시에 로딩으로 보인다. 어느 줄을 눌렀는지가 사용자에게 보여야 한다.
   */
  const [signupRunId, setSignupRunId] = useState<RunId | null>(null);
  const signup = useMutation({
    mutationFn: (input: SaveRunSignupInput) => saveRunSignup(input),
    onSettled: () => {
      setSignupRunId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
      });
    },
  });

  const handleSignup = useCallback(
    (runId: RunId, characterId: string) => {
      setSignupRunId(runId);
      signup.mutate({ runId, characterId, status: "going" });
    },
    [signup],
  );

  const saveParty = useMutation({
    mutationFn: (input: CreatePartyInput) => createParty(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
      setSelectedPartyId(created.partyId);
      setSelectedWindow(null);
      setEditor((state) => ({ ...state, open: false }));
    },
  });

  const saveRoster = useMutation({
    mutationFn: (input: UpdatePartyRosterInput) => updatePartyRoster(input),
    onSuccess: (_members, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.members(variables.partyId),
      });
      setSelectedWindow(null);
      setEditor((state) => ({ ...state, open: false }));
    },
  });

  // ── 핸들러 ───────────────────────────────────────────────────────────────
  const handleSelectParty = useCallback(
    (partyId: PartyId) => {
      setSelectedPartyId(partyId);
      // 파티가 바뀌면 고른 시간대는 더 이상 그 사람들의 교집합이 아니다.
      setSelectedWindow(null);
      setMinCountChoice("all");
      if (!partySizeTouched.current) {
        const next = parties.find((party) => party.partyId === partyId);
        setDraftPartySizeText(String(Math.max(next?.memberCount ?? 1, 1)));
      }
    },
    [parties],
  );

  const handleSelectWindow = useCallback((window: OverlapWindow) => {
    setSelectedWindow(window);
    const windowDayKey = kstDayKey(window.startsAt);
    setDraftDayKey(windowDayKey);
    setDraftTimeText(
      formatDayMinute(minutesFromKstDay(window.startsAt, windowDayKey)),
    );
    if (!partySizeTouched.current) {
      setDraftPartySizeText(String(Math.max(window.availableCount, 1)));
    }
  }, []);

  const handlePartySizeChange = useCallback((value: string) => {
    partySizeTouched.current = true;
    setDraftPartySizeText(value);
  }, []);

  const openEditor = useCallback((mode: PartyEditorMode) => {
    // seq 를 올려 다이얼로그를 다시 마운트한다 — "취소"가 실제로 취소되게 (§ 상태 초기화).
    setEditor((state) => ({ open: true, mode, seq: state.seq + 1 }));
  }, []);

  const retryAvailability = useCallback(() => {
    void availabilityQuery.refetch();
    void overlapQuery.refetch();
    void exceptionsQuery.refetch();
  }, [availabilityQuery, overlapQuery, exceptionsQuery]);

  const dayRows = useMemo(() => buildDayRows(range), [range]);

  const availabilityLoading =
    availabilityQuery.isLoading ||
    overlapQuery.isLoading ||
    exceptionsQuery.isLoading;
  const availabilityError =
    availabilityQuery.isError || overlapQuery.isError || exceptionsQuery.isError;

  return (
    <div className="flex flex-col gap-4">
      <PartyBar
        parties={parties}
        selectedPartyId={selectedPartyId}
        onSelectParty={handleSelectParty}
        onCreateParty={() => openEditor("create")}
        onEditRoster={() => openEditor("edit")}
        members={members}
        isPartiesLoading={partiesQuery.isLoading}
        isPartiesError={partiesQuery.isError}
        onPartiesRetry={() => void partiesQuery.refetch()}
        isMembersLoading={membersQuery.isLoading}
        isMembersError={membersQuery.isError}
        onMembersRetry={() => void membersQuery.refetch()}
      />

      {/* 데스크톱 2단 / 모바일은 위아래로 쌓인다. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem]">
        <AvailabilityPanel
          now={now}
          range={range}
          members={members}
          intervals={availabilityQuery.data ?? []}
          overlapWindows={overlapQuery.data ?? []}
          exceptions={exceptionsQuery.data ?? []}
          memberNameById={
            new Map(members.map((m) => [m.personId, m.displayName]))
          }
          minCountChoice={minCountChoice}
          effectiveMinCount={effectiveMinCount}
          onMinCountChange={setMinCountChoice}
          isLoading={availabilityLoading}
          isError={availabilityError}
          onRetry={retryAvailability}
          selectedWindowKey={
            selectedWindow ? overlapWindowKey(selectedWindow) : null
          }
          onSelectWindow={handleSelectWindow}
          partyName={selectedParty?.name ?? null}
        />

        <div className="flex min-w-0 flex-col gap-4">
          <RunComposer
            partyId={selectedPartyId ?? ""}
            dayRows={dayRows}
            bosses={bossQuery.data ?? []}
            isBossLoading={bossQuery.isLoading}
            isBossError={bossQuery.isError}
            onBossRetry={() => void bossQuery.refetch()}
            characters={characters}
            isCharacterLoading={charactersQuery.isLoading}
            isCharacterError={charactersQuery.isError}
            onCharacterRetry={() => void charactersQuery.refetch()}
            isSignedIn={viewerPersonId !== null}
            characterId={effectiveCharacterId}
            onCharacterIdChange={setDraftCharacterId}
            selectedWindow={selectedWindow}
            selectedPersonIds={personIds}
            dayKey={draftDayKey}
            onDayKeyChange={setDraftDayKey}
            timeText={draftTimeText}
            onTimeTextChange={setDraftTimeText}
            partySizeText={draftPartySizeText}
            onPartySizeTextChange={handlePartySizeChange}
            onSubmit={(input) => createRun.mutate(input)}
            isSubmitting={createRun.isPending}
            submitError={createRun.error}
            disabled={selectedPartyId === null}
          />

          <ScheduledRunList
            runs={runsQuery.data ?? []}
            now={now}
            isLoading={runsQuery.isLoading}
            isError={runsQuery.isError}
            onRetry={() => void runsQuery.refetch()}
            partyName={selectedParty?.name ?? null}
            viewerPersonId={viewerPersonId}
            characters={characters}
            onSignup={handleSignup}
            signupPendingRunId={signup.isPending ? signupRunId : null}
            signupError={signup.error}
          />
        </div>
      </div>

      <PartyEditorDialog
        key={editor.seq}
        open={editor.open}
        onClose={() => setEditor((state) => ({ ...state, open: false }))}
        mode={editor.mode}
        initialName={editor.mode === "edit" ? (selectedParty?.name ?? "") : ""}
        currentMembers={editor.mode === "edit" ? members : []}
        people={peopleQuery.data ?? []}
        isPeopleLoading={peopleQuery.isLoading}
        isPeopleError={peopleQuery.isError}
        onPeopleRetry={() => void peopleQuery.refetch()}
        onSubmit={({ name, memberPersonIds }) => {
          if (editor.mode === "create") {
            saveParty.mutate({ name, memberPersonIds });
          } else if (selectedPartyId !== null) {
            saveRoster.mutate({ partyId: selectedPartyId, memberPersonIds });
          }
        }}
        isSubmitting={saveParty.isPending || saveRoster.isPending}
        submitError={saveParty.error ?? saveRoster.error}
      />
    </div>
  );
}
