"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { fetchCharacterPlans } from "@/features/boss-plans/data";
import { GuestInviteDialog } from "@/features/invites/components";
import { participantLabel } from "@/lib/domain/participant-label";
import { personScope, queryKeys } from "@/lib/query-keys";
import {
  addKstDays,
  formatDayMinute,
  kstDayKey,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityInterval,
  AvailabilityPattern,
  AvailabilityPatternInput,
  BossCatalogEntry,
  BossDifficultyId,
  CreatePartyInput,
  CreateRunBundleInput,
  OverlapWindow,
  Party,
  PartyBoss,
  PartyId,
  PartyMember,
  PersonId,
  RunId,
  SaveRunSignupInput,
  ScheduledRun,
  SetPartyBossesInput,
  TimeRange,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
  WeekKey,
} from "@/types/domain";

import {
  createAvailabilityException,
  createParty,
  createPartyRunBundle,
  deleteAvailabilityException,
  fetchAvailability,
  fetchAvailabilityExceptions,
  fetchAvailabilityOverlap,
  fetchBossCatalog,
  fetchMyAvailabilityPatterns,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
  fetchPartyRuns,
  fetchPeoplePool,
  saveMyAvailabilityPatterns,
  savePartyBosses,
  saveRunSignup,
  updateMyPartyCharacter,
  updatePartyRoster,
} from "../data";
import { buildDayRows } from "../lib/overlay-layout";
import { AvailabilityEditorDialog } from "./availability-editor-dialog";
import { AvailabilityPanel } from "./availability-panel";
import { overlapWindowKey } from "./overlay-grid";
import { PartyBar } from "./party-bar";
import { PartyEditorDialog, type PartyEditorMode } from "./party-editor-dialog";
import { DEFAULT_DURATION_MINUTES, RunComposer } from "./run-composer";
import { ScheduledRunList } from "./scheduled-run-list";
import type { PatternGridColumn } from "./weekly-pattern-grid";

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
    /** 첫 파티가 묶어서 도는 보스 — 첫 페인트에서 체크박스가 비어 보이지 않게 한다. */
    readonly partyBosses: readonly PartyBoss[];
    readonly runs: readonly ScheduledRun[];
    /**
     * 열람자 본인의 반복 패턴 **원본**. 비로그인은 빈 배열이다.
     *
     * 서버에서 미리 실어 보내는 이유는 첫 페인트에서 "가능 시간 미등록" 안내가
     * **깜빡이지 않게** 하기 위해서다. 클라이언트 조회를 기다리면 이미 등록한
     * 사람에게도 안내가 한 번 번쩍인다.
     */
    readonly myPatterns: readonly AvailabilityPattern[];
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

  /**
   * 초대 링크를 보낼 게스트. `null` 이면 창이 닫혀 있다.
   *
   * `seq` 로 다시 마운트하는 이유는 다른 다이얼로그와 같다 — 창을 열 때마다 **새 토큰을
   * 발급**해야 하고, 이전 발급 결과가 남아 있으면 이미 죽은 링크를 복사하게 된다.
   */
  const [inviteTarget, setInviteTarget] = useState<{
    readonly member: PartyMember;
    readonly seq: number;
  } | null>(null);

  /**
   * 내 가능 시간 편집기. `seq` 로 다시 마운트하는 이유는 로스터 편집기와 같다 —
   * 닫았다 다시 열면 **저장하지 않은 초안이 남아 있으면 안 된다.**
   */
  const [availabilityEditor, setAvailabilityEditor] = useState<{
    readonly open: boolean;
    readonly seq: number;
  }>({ open: false, seq: 0 });

  /** 일정 초안(보스·날짜·시각·인원·소요). 왼쪽 패널과 오른쪽 폼이 공유하는 상태다. */
  const [draftDayKey, setDraftDayKey] = useState(() => kstDayKey(range.from));
  const [draftTimeText, setDraftTimeText] = useState("21:00");
  const [draftPartySizeText, setDraftPartySizeText] = useState(() =>
    String(Math.max(initial.personIds.length, 1)),
  );
  const [draftDurationText, setDraftDurationText] = useState(
    String(DEFAULT_DURATION_MINUTES),
  );
  /** 사용자가 인원을 직접 고쳤으면 자동 채움이 덮지 않는다 (§1.3 D3). */
  const partySizeTouched = useRef(false);

  /**
   * 체크한 보스. `null` = **아직 손대지 않음** → 그 파티에 등록된 보스 전체가 기본값이다.
   *
   * 값이 아니라 `null` 로 가르는 이유: 빈 배열은 "전부 껐다"는 **사용자의 판단**이고,
   * 그것을 "아직 안 정했다"와 합치면 사용자가 전부 끄자마자 다시 전부 켜진다.
   * (계획 인원수의 `null = 미설정` 과 같은 판단 — CLAUDE.md §1.3 D3.)
   *
   * 파티를 바꾸면 `null` 로 되돌아간다. 다른 파티의 보스를 체크한 채로 남아 있으면
   * 그 파티에 없는 보스로 일정이 잡힌다.
   */
  const [draftBossIds, setDraftBossIds] = useState<
    readonly BossDifficultyId[] | null
  >(null);

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

  /**
   * 이 파티가 **묶어서 도는 보스** (`party_bosses`).
   *
   * ★ 파티가 축이므로 키에 partyId 가 들어간다. 파티를 바꾸면 목록이 함께 갈린다.
   * ★ **비로그인도 켠다.** 공개 파티라면 무엇을 도는 묶음인지 보여야 하고, 서버가
   *   200 + 빈 배열로 답한다(볼 수 없는 파티는 애초에 목록에 없다).
   */
  const partyBossesQuery = useQuery({
    queryKey: queryKeys.db.party.bosses(selectedPartyId ?? "none"),
    queryFn: () => fetchPartyBosses(selectedPartyId ?? ""),
    enabled: selectedPartyId !== null,
    initialData: () => (isInitialParty ? initial.partyBosses : undefined),
  });

  const partyBosses = useMemo(
    () => partyBossesQuery.data ?? [],
    [partyBossesQuery.data],
  );

  /**
   * 실제로 체크된 보스. 손대지 않았으면 **그 파티에 등록된 보스 전부**가 기본값이다 —
   * "보통 묶어서 간다"가 발주 요구의 전제이므로 전부 켜진 상태가 기본이어야 한다.
   */
  const effectiveBossIds = useMemo<readonly BossDifficultyId[]>(
    () =>
      draftBossIds ??
      partyBosses.map((entry) => entry.bossDifficultyId),
    [draftBossIds, partyBosses],
  );

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

  /** `personId → 더저` / `더저(메검메)`. 조합 규칙의 주인은 domain 헬퍼 하나다. */
  const memberNameById = useMemo(
    () =>
      new Map(
        members.map((member) => [member.personId, participantLabel(member)]),
      ),
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

  // ── 내 가용 시간 (편집 원본) ─────────────────────────────────────────────
  /**
   * ★ 겹쳐보기용 조회(`resolve`)로는 이걸 대신할 수 없다. 그쪽은 **패턴 − 예외**를
   *   절대 시각 구간으로 펼친 결과라, 편집기가 필요로 하는 "어느 요일 몇 시부터"라는
   *   원본 의도가 이미 사라진 뒤다.
   * ★ 비로그인은 아예 켜지 않는다 — 이 엔드포인트는 세션이 없으면 401 이라
   *   공개 시간표에 없어야 할 에러 UI 가 뜬다.
   */
  const myPatternsQuery = useQuery({
    queryKey: queryKeys.db.availability.myPatterns(),
    queryFn: fetchMyAvailabilityPatterns,
    enabled: viewerPersonId !== null,
    initialData: () =>
      viewerPersonId === null ? undefined : initial.myPatterns,
  });

  const myPersonIds = useMemo<readonly PersonId[]>(
    () => (viewerPersonId === null ? [] : [viewerPersonId]),
    [viewerPersonId],
  );

  /**
   * 특이사항 편집용 조회 구간 — **오늘부터 8주**. 겹쳐보기의 이번 주 구간과 다르다.
   *
   * 휴가·출장은 다음 주 이후에 잡히는 일이 흔한데, 이번 주만 보여 주면 그걸 넣을
   * 자리가 없다. 조회 경로는 그대로 `kind=exceptions` 를 쓴다 — 열람 권한 판정이
   * 이미 그쪽에 있고, "내 것만" 읽는 두 번째 구현을 만들면 규칙이 둘로 갈라진다.
   */
  const exceptionEditorRange = useMemo<TimeRange>(() => {
    const start = kstMoment(kstDayKey(now), 0);
    return { from: start, to: addKstDays(start, 56) };
  }, [now]);

  const myExceptionsQuery = useQuery({
    queryKey: queryKeys.db.availability.exceptions(
      myPersonIds,
      exceptionEditorRange,
    ),
    queryFn: () =>
      fetchAvailabilityExceptions(myPersonIds, exceptionEditorRange),
    // 편집기를 열기 전에는 부르지 않는다. 화면에 쓰이지 않는 요청이다.
    enabled: viewerPersonId !== null && availabilityEditor.open,
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

  /**
   * 그 캐릭터가 **매주 가는 보스** (§1.1.1).
   *
   * 등록 폼의 보스 목록은 카탈로그 78개가 아니라 이 계획이 먼저 온다 — 실제로 고를 것은
   * 인게임 스케줄러가 이미 알고 있기 때문이다. 계산은 전부 뷰
   * `v_character_boss_plan_status` 가 하고 화면은 카탈로그와 합치기만 한다.
   *
   * ★ **캐릭터가 축이다.** 캐릭터를 바꾸면 쿼리 키가 바뀌므로 목록도 함께 갈린다.
   * ★ **넥슨 호출 0건.** `GET /api/boss-plans` 는 우리 DB 만 읽는다 — 동기화(넥슨 1콜)는
   *   `/boss-plans` 화면의 버튼이 담당하고 여기서는 부르지 않는다.
   * ★ 비로그인·캐릭터 미선택이면 아예 켜지 않는다. 이 엔드포인트는 세션이 없으면 401 이라
   *   공개 시간표에 없어야 할 에러 UI 가 뜬다.
   */
  const plansQuery = useQuery({
    queryKey: queryKeys.db.bossPlans.character(effectiveCharacterId ?? "none"),
    queryFn: () => fetchCharacterPlans(effectiveCharacterId ?? ""),
    enabled: viewerPersonId !== null && effectiveCharacterId !== null,
  });

  const plans = useMemo(
    () => plansQuery.data?.plans ?? [],
    [plansQuery.data],
  );

  // ── 일정 (파티에 속한다) ──────────────────────────────────────────────────
  const runsQuery = useQuery({
    queryKey: queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
    queryFn: () => fetchPartyRuns(selectedPartyId ?? "", weekKey),
    enabled: selectedPartyId !== null,
    initialData: () => (isInitialParty ? initial.runs : undefined),
  });

  /**
   * 묶음 등록 — 체크한 보스들이 **연달아** 잡힌다(서버가 `시작 + 소요 × i` 로 배치).
   *
   * 무효화가 런 목록 하나인 이유: 이 mutation 은 `party_runs` 만 만든다. 파티·구성원·
   * 보스 목록은 건드리지 않으므로 함께 날릴 이유가 없다(과잉 무효화는 넥슨 쿼터와 무관한
   * DB 조회라 해도 화면을 불필요하게 깜빡이게 한다).
   */
  const createRun = useMutation({
    mutationFn: (input: CreateRunBundleInput) => createPartyRunBundle(input),
    onSuccess: (created) => {
      const first = created[0];
      if (first === undefined) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(first.partyId, weekKey),
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
      /*
        `party.root()` 하나로 목록·보스 목록을 함께 날린다 — 보스를 함께 등록했으므로
        `party.bosses(...)` 도 새로 받아야 한다(키가 같은 접두사 아래 있는 이유다).
      */
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
      // 닉네임만으로 넣은 게스트가 후보 목록에도 새로 들어온다.
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.people.root() });
      setSelectedPartyId(created.partyId);
      setSelectedWindow(null);
      // 새 파티의 보스가 기본값(전부 체크)이 되도록 초안을 비운다.
      setDraftBossIds(null);
      setEditor((state) => ({ ...state, open: false }));
    },
  });

  /**
   * 편집 저장 — **로스터와 보스 목록을 함께** 저장한다.
   *
   * 두 API 를 순서대로 부르는 이유: 서버에서 로스터가 정원(`default_capacity`)을 바꾸고,
   * 그 정원이 자동 제목의 `N인` 이다. 보스를 **나중에** 저장해야 제목이 새 정원으로
   * 만들어진다. 순서를 뒤집으면 `익세 하대 하카 2인` 파티에 한 명을 더 넣었을 때
   * 제목이 한 박자 늦게 따라온다.
   */
  const saveRoster = useMutation({
    mutationFn: async (
      input: UpdatePartyRosterInput & SetPartyBossesInput,
    ) => {
      const members = await updatePartyRoster({
        partyId: input.partyId,
        memberPersonIds: input.memberPersonIds,
        guestNames: input.guestNames,
      });
      await savePartyBosses({
        partyId: input.partyId,
        bossDifficultyIds: input.bossDifficultyIds,
      });
      return members;
    },
    onSuccess: (_members, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.members(variables.partyId),
      });
      /*
        새로 만든 게스트는 **후보 목록에도 들어온다**(`fetchPeoplePool` 이 같은 파티
        구성원을 후보로 친다). 여기서 날리지 않으면 창을 다시 열었을 때 방금 넣은
        사람이 격자에 없어 체크를 풀 방법이 없다.
      */
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.people.root() });
      /*
        로스터가 바뀌면 겹쳐보기 대상 인원이 바뀐다. 조회 키에 사람 목록이 들어 있어
        대개는 새 키로 알아서 조회되지만, 사람이 **빠진** 경우 예전 키의 답이 캐시에
        남아 다시 그 조합으로 돌아왔을 때 옛 답을 보여 준다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.availability.root(),
      });
      /* 참가자 이름·번호가 런 목록에도 실려 나간다. */
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
      /*
        보스 목록이 바뀌면 등록 폼의 체크 상태 기준이 바뀐다. 초안을 비워 새 목록이
        기본값(전부 체크)이 되게 한다 — 지운 보스가 체크된 채로 남아 있으면 그 보스로
        일정이 잡힌다.
      */
      setDraftBossIds(null);
      setSelectedWindow(null);
      setEditor((state) => ({ ...state, open: false }));
    },
  });

  /**
   * **이 파티에 데려갈 내 캐릭터** (`party_participants.character_id`).
   *
   * 무효화 대상이 파티·구성원·런 셋인 이유: 이 값이 바뀌면 `더저` ↔ `더저(메검메)` 로
   * **표시 이름이 바뀌고**, 그 이름은 구성원 목록·겹쳐보기 좌측·런 참가자 목록에 각각
   * 실려 나간다. 한 곳만 날리면 화면마다 다른 이름이 보인다.
   */
  const saveMyCharacter = useMutation({
    mutationFn: (input: UpdatePartyCharacterInput) =>
      updateMyPartyCharacter(input),
    onSuccess: (_members, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.members(variables.partyId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
    },
  });

  const handleChangeMyCharacter = useCallback(
    (characterId: string | null) => {
      if (selectedPartyId === null) return;
      saveMyCharacter.mutate({ partyId: selectedPartyId, characterId });
    },
    [saveMyCharacter, selectedPartyId],
  );

  const handleInviteGuest = useCallback((member: PartyMember) => {
    setInviteTarget((state) => ({ member, seq: (state?.seq ?? 0) + 1 }));
  }, []);

  // ── 내 가용 시간 쓰기 ────────────────────────────────────────────────────
  /**
   * 무효화 범위가 왜 `availability.root()` 인가.
   *
   * 내 패턴 한 줄이 바뀌면 **겹쳐보기(`resolve`)·겹침 질의(`overlap`)·특이사항 목록**의
   * 답이 전부 달라진다. 셋 중 하나만 날리면 화면 절반이 옛 답을 들고 남는다 — 그리고
   * 그 옛 답은 "가능"이라고 말하는 쪽이라, 못 오는 사람이 예약되는 실패로 이어진다.
   * 하나의 접두사로 묶어 둔 이유가 이것이다(`lib/query-keys.ts`).
   */
  const invalidateAvailability = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.availability.root(),
    });
  }, [queryClient]);

  const savePatterns = useMutation({
    mutationFn: (patterns: readonly AvailabilityPatternInput[]) =>
      saveMyAvailabilityPatterns(patterns),
    onSuccess: () => {
      invalidateAvailability();
      // 저장 결과는 뒤에 있는 겹쳐보기에서 확인하는 것이라 닫는다.
      setAvailabilityEditor((state) => ({ ...state, open: false }));
    },
  });

  const addException = useMutation({
    mutationFn: (input: AvailabilityExceptionInput) =>
      createAvailabilityException(input),
    onSuccess: invalidateAvailability,
  });

  /** 삭제 중인 행을 따로 들고 있는 이유는 참가 신청과 같다 — 어느 줄을 눌렀는지 보여야 한다. */
  const [deletingExceptionId, setDeletingExceptionId] = useState<string | null>(
    null,
  );
  const removeException = useMutation({
    mutationFn: (exceptionId: string) =>
      deleteAvailabilityException(exceptionId),
    onSettled: () => {
      setDeletingExceptionId(null);
      invalidateAvailability();
    },
  });

  const handleDeleteException = useCallback(
    (exceptionId: string) => {
      setDeletingExceptionId(exceptionId);
      removeException.mutate(exceptionId);
    },
    [removeException],
  );

  const openAvailabilityEditor = useCallback(() => {
    setAvailabilityEditor((state) => ({ open: true, seq: state.seq + 1 }));
  }, []);

  // ── 핸들러 ───────────────────────────────────────────────────────────────
  const handleSelectParty = useCallback(
    (partyId: PartyId) => {
      setSelectedPartyId(partyId);
      // 파티가 바뀌면 고른 시간대는 더 이상 그 사람들의 교집합이 아니다.
      setSelectedWindow(null);
      setMinCountChoice("all");
      /*
        체크한 보스도 그 파티의 것이었다. 비워 두면 새 파티의 등록된 보스 전체가
        기본값이 된다 — 남겨 두면 이 파티에 없는 보스로 일정이 잡힌다.
      */
      setDraftBossIds(null);
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

  /**
   * 편집기 격자의 요일 열 — **겹쳐보기와 같은 순서**(주간 초기화 기준 목→수).
   *
   * `dayRows` 에서 뽑는 것이 핵심이다. 요일 라벨과 주말 판정을 여기서 따로 만들면 두
   * 화면이 조금씩 갈라지고, "읽은 자리에 그대로 칠한다"는 전제가 무너진다.
   */
  const patternColumns = useMemo<readonly PatternGridColumn[]>(() => {
    const seen = new Set<number>();
    const columns: PatternGridColumn[] = [];
    for (const row of dayRows) {
      if (seen.has(row.isoWeekday)) continue;
      seen.add(row.isoWeekday);
      columns.push({
        isoWeekday: row.isoWeekday as PatternGridColumn["isoWeekday"],
        label: row.weekdayLabel,
        isWeekend: row.isWeekend,
      });
      if (columns.length === 7) break;
    }
    return columns;
  }, [dayRows]);

  const myPatterns = useMemo(
    () => myPatternsQuery.data ?? [],
    [myPatternsQuery.data],
  );

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
        viewerPersonId={viewerPersonId}
        characters={characters}
        onChangeMyCharacter={handleChangeMyCharacter}
        isSavingMyCharacter={saveMyCharacter.isPending}
        myCharacterError={saveMyCharacter.error}
        onInviteGuest={handleInviteGuest}
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
          /*
            특이사항 목록이 "누구의 제외인지" 말할 때 쓰는 이름. **여기서도 같은 조합
            규칙**을 써야 겹쳐보기 왼쪽 이름과 어긋나지 않는다 — 부캐로 들어간 사람이
            막대에는 `더저(메검메)`, 아래 목록에는 `더저` 로 보이면 다른 사람으로 읽힌다.
          */
          memberNameById={memberNameById}
          minCountChoice={minCountChoice}
          effectiveMinCount={effectiveMinCount}
          onMinCountChange={setMinCountChoice}
          isLoading={availabilityLoading}
          isError={availabilityError}
          onRetry={retryAvailability}
          onEditAvailability={
            viewerPersonId === null ? null : openAvailabilityEditor
          }
          viewerHasPattern={myPatterns.length > 0}
          isViewerPatternLoading={myPatternsQuery.isLoading}
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
            partyBosses={partyBosses}
            isPartyBossLoading={partyBossesQuery.isLoading}
            isPartyBossError={partyBossesQuery.isError}
            onPartyBossRetry={() => void partyBossesQuery.refetch()}
            onEditPartyBosses={() => openEditor("edit")}
            plans={plans}
            isPlanLoading={plansQuery.isLoading}
            isPlanError={plansQuery.isError}
            onPlanRetry={() => void plansQuery.refetch()}
            characters={characters}
            isCharacterLoading={charactersQuery.isLoading}
            isCharacterError={charactersQuery.isError}
            onCharacterRetry={() => void charactersQuery.refetch()}
            isSignedIn={viewerPersonId !== null}
            characterId={effectiveCharacterId}
            onCharacterIdChange={setDraftCharacterId}
            selectedWindow={selectedWindow}
            selectedPersonIds={personIds}
            selectedBossIds={effectiveBossIds}
            onSelectedBossIdsChange={setDraftBossIds}
            dayKey={draftDayKey}
            onDayKeyChange={setDraftDayKey}
            timeText={draftTimeText}
            onTimeTextChange={setDraftTimeText}
            partySizeText={draftPartySizeText}
            onPartySizeTextChange={handlePartySizeChange}
            durationText={draftDurationText}
            onDurationTextChange={setDraftDurationText}
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
        /*
          자동 제목인 파티는 이름 칸을 비워 둔다 — 손대지 않고 저장했다고 "사람이 정한
          이름"으로 굳으면 이후 보스를 바꿔도 제목이 영영 따라오지 않는다.
        */
        initialNameIsCustom={
          editor.mode === "edit" && (selectedParty?.nameIsCustom ?? false)
        }
        currentMembers={editor.mode === "edit" ? members : []}
        viewerPersonId={viewerPersonId}
        initialBossIds={
          editor.mode === "edit"
            ? partyBosses.map((entry) => entry.bossDifficultyId)
            : []
        }
        people={peopleQuery.data ?? []}
        isPeopleLoading={peopleQuery.isLoading}
        isPeopleError={peopleQuery.isError}
        onPeopleRetry={() => void peopleQuery.refetch()}
        bosses={bossQuery.data ?? []}
        isBossLoading={bossQuery.isLoading}
        isBossError={bossQuery.isError}
        onBossRetry={() => void bossQuery.refetch()}
        onSubmit={({ name, memberPersonIds, guestNames, bossDifficultyIds }) => {
          if (editor.mode === "create") {
            saveParty.mutate({
              name,
              memberPersonIds,
              guestNames,
              bossDifficultyIds,
            });
          } else if (selectedPartyId !== null) {
            saveRoster.mutate({
              partyId: selectedPartyId,
              memberPersonIds,
              guestNames,
              bossDifficultyIds,
            });
          }
        }}
        isSubmitting={saveParty.isPending || saveRoster.isPending}
        submitError={saveParty.error ?? saveRoster.error}
      />

      {/*
        초대 링크 창 — **게스트에게만** 열린다(파티 바의 보내기 버튼).
        `seq` 로 다시 마운트해 열 때마다 새 토큰을 발급한다. 이전 발급 결과가 남아 있으면
        이미 죽은 링크를 복사하게 되기 때문이다(재발급은 이전 링크를 무효화한다).
      */}
      {inviteTarget === null ? null : (
        <GuestInviteDialog
          key={inviteTarget.seq}
          open
          onClose={() => setInviteTarget(null)}
          member={inviteTarget.member}
        />
      )}

      {/*
        ★ 비로그인에게는 **아예 마운트하지 않는다.** 쓰기는 전부 401 이라 열어 봐야
          오류만 보게 되고, 안에 든 조회들도 켤 이유가 없다.
      */}
      {viewerPersonId !== null ? (
        <AvailabilityEditorDialog
          key={availabilityEditor.seq}
          open={availabilityEditor.open}
          onClose={() =>
            setAvailabilityEditor((state) => ({ ...state, open: false }))
          }
          now={now}
          columns={patternColumns}
          patterns={myPatterns}
          isPatternsLoading={myPatternsQuery.isLoading}
          isPatternsError={myPatternsQuery.isError}
          onPatternsRetry={() => void myPatternsQuery.refetch()}
          onSavePatterns={(patterns) => savePatterns.mutate(patterns)}
          isSavingPatterns={savePatterns.isPending}
          savePatternsError={savePatterns.error}
          exceptions={myExceptionsQuery.data ?? []}
          isExceptionsLoading={myExceptionsQuery.isLoading}
          isExceptionsError={myExceptionsQuery.isError}
          onExceptionsRetry={() => void myExceptionsQuery.refetch()}
          onAddException={(input) => addException.mutate(input)}
          onDeleteException={handleDeleteException}
          isAddingException={addException.isPending}
          deletingExceptionId={
            removeException.isPending ? deletingExceptionId : null
          }
          exceptionError={addException.error ?? removeException.error}
        />
      ) : null}
    </div>
  );
}
