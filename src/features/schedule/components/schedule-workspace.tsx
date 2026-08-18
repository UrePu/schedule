"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { fetchCharacterPlans } from "@/features/boss-plans/data";
import type { CharacterBossPlan } from "@/features/boss-plans/types";
import { GuestInviteDialog } from "@/features/invites/components";
import { participantLabel } from "@/lib/domain/participant-label";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import {
  bossMasterQueryOptions,
  dbQueryOptions,
  queryKeys,
} from "@/lib/query-keys";
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
  Person,
  PersonId,
  RunCharacterOption,
  RunCommitment,
  RunId,
  SaveRunSignupInput,
  ScheduledRun,
  SetPartyBossesInput,
  TimeRange,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
  UpdateRunInput,
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
  fetchRunCommitments,
  removePartyRun,
  saveMyAvailabilityPatterns,
  savePartyBosses,
  saveRunSignup,
  updateMyPartyCharacter,
  updatePartyRoster,
  updatePartyRun,
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
 * ─────────────────────────────────────────────────────────────────────────────
 * **데이터는 전부 쿼리 캐시 소유다** — `initial` props 는 없앴다 (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 서버 컴포넌트가 첫 파티 기준의 결과를 계산해 `initial` 로 넘기고, 이 파일이
 * 그것을 아홉 개 쿼리의 `initialData` 로 나눠 심었다. 문제가 둘이었다.
 *
 * 1. `initialDataUpdatedAt` 이 없어 그 값들이 캐시에서 **영원히 신선한 것**으로 취급됐다.
 * 2. "지금 보고 있는 조합이 서버가 계산한 그 조합인가"를 판정하려고
 *    `isInitialParty` · `isInitialRoster` 같은 파생 플래그가 필요했고, 그 판정이 틀리는
 *    날 화면은 **다른 파티의 답**을 보여 준다.
 *
 * 지금은 서버(`app/schedule/page.tsx`)가 같은 repo 를 불러 **요청 범위 QueryClient 에
 * 심고** `dehydrate` 하며, 이 컴포넌트는 평범한 `useQuery` 만 쓴다. 하이드레이션은 서버
 * 렌더 시점에 일어나므로 **첫 페인트는 여전히 데이터가 채워진 상태**다 — 스켈레톤이
 * 번쩍이지 않는다는 성질은 그대로 유지하면서 판정 플래그 두 개가 사라졌다.
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
   *
   * ★ 이것은 **데이터가 아니라 열람자 신원**이라 props 로 남는다. 뮤테이션이 바꿀 수 있는
   *   값이 아니고(로그인/로그아웃은 서버 렌더가 갈린다), 여러 쿼리의 `enabled` 를 가른다.
   */
  readonly viewerPersonId: PersonId | null;
}

/**
 * 빈 목록 상수들. 매 렌더 새 배열을 만들면 아래 `useMemo` 들이 전부 무효화되고,
 * 그 memo 를 prop 으로 받는 무거운 격자(`OverlayGrid`)가 매번 다시 그려진다.
 */
const EMPTY_PARTIES: readonly Party[] = [];
const EMPTY_MEMBERS: readonly PartyMember[] = [];
const EMPTY_PARTY_BOSSES: readonly PartyBoss[] = [];
const EMPTY_PEOPLE: readonly Person[] = [];
const EMPTY_INTERVALS: readonly AvailabilityInterval[] = [];
const EMPTY_OVERLAP: readonly OverlapWindow[] = [];
const EMPTY_EXCEPTIONS: readonly AvailabilityException[] = [];
const EMPTY_PATTERNS: readonly AvailabilityPattern[] = [];
const EMPTY_BOSSES: readonly BossCatalogEntry[] = [];
const EMPTY_RUNS: readonly ScheduledRun[] = [];
const EMPTY_COMMITMENTS: readonly RunCommitment[] = [];
const EMPTY_RUN_CHARACTERS: readonly RunCharacterOption[] = [];
const EMPTY_PLANS: readonly CharacterBossPlan[] = [];

export function ScheduleWorkspace({
  now,
  range,
  weekKey,
  viewerPersonId,
}: ScheduleWorkspaceProps) {
  const queryClient = useQueryClient();

  /*
   * ── 파티 ──────────────────────────────────────────────────────────────────
   * 다른 어떤 상태보다 먼저 선언한다. 아래 `useState` 초기값들이 **첫 파티**를 보고
   * 정해지기 때문이다. 하이드레이션 덕분에 이 값은 첫 렌더부터 채워져 있다.
   *
   * 티어: db(60초) — 파티는 우리 DB 이고 신선도는 뮤테이션 후 무효화가 진다.
   */
  const partiesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.list()),
    queryFn: fetchParties,
  });

  const parties = partiesQuery.data ?? EMPTY_PARTIES;

  const [selectedPartyId, setSelectedPartyId] = useState<PartyId | null>(
    () => parties[0]?.partyId ?? null,
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
  /*
   * 기본 인원수는 **첫 파티의 구성원 수**다. 구성원 목록 조회를 기다리지 않는 이유는,
   * 파티 행이 이미 `memberCount` 를 싣고 있어 같은 값을 한 왕복 없이 알 수 있기 때문이다.
   */
  const [draftPartySizeText, setDraftPartySizeText] = useState(() =>
    String(Math.max(parties[0]?.memberCount ?? 1, 1)),
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
   * 등록 폼에서 **사용자가 직접 고른** 내 캐릭터. `null` = 아직 손대지 않음.
   *
   * `null` 일 때 무엇이 기본값인지는 아래 `effectiveCharacterId` 가 정한다. effect 로
   * 채우지 않는 이유는 그 방식이 마운트마다 연쇄 렌더를 만들기 때문이다 — 파생값으로
   * 계산하고, 사용자가 고르면 그 값이 이긴다.
   *
   * ★ **파티를 바꾸면 `null` 로 되돌린다**(`handleSelectParty`). 체크한 보스와 같은
   *   판단이다 — 앞 파티에서 고른 캐릭터가 남아 있으면 새 파티의 참여 캐릭터를 덮는다.
   */
  const [draftCharacterId, setDraftCharacterId] = useState<string | null>(null);

  /**
   * 지금 **수정 패널이 열려 있는 런**. 목록 안이 아니라 여기 있는 이유는 이 값이
   * 겹쳐보기까지 바꾸기 때문이다 — 열려 있는 동안 그 런은 **점유 계산에서 빠져야**
   * 시각을 옮길 후보 시간대가 보인다. 자기 자신이 자기 자리를 막으면 한 칸도 움직일 수
   * 없다(마이그레이션 23 의 `p_exclude_run_id` 가 존재하는 이유).
   */
  const [editingRunId, setEditingRunId] = useState<RunId | null>(null);
  /** 방금 취소/삭제된 결과 문구. `null` 이면 알릴 것이 없다. */
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);

  const selectedParty =
    parties.find((party) => party.partyId === selectedPartyId) ?? null;

  const membersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.members(selectedPartyId ?? "none")),
    queryFn: () => fetchPartyMembers(selectedPartyId ?? ""),
    enabled: selectedPartyId !== null,
  });

  /**
   * 이 파티가 **묶어서 도는 보스** (`party_bosses`).
   *
   * ★ 파티가 축이므로 키에 partyId 가 들어간다. 파티를 바꾸면 목록이 함께 갈린다.
   * ★ **비로그인도 켠다.** 공개 파티라면 무엇을 도는 묶음인지 보여야 하고, 서버가
   *   200 + 빈 배열로 답한다(볼 수 없는 파티는 애초에 목록에 없다).
   */
  const partyBossesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.bosses(selectedPartyId ?? "none")),
    queryFn: () => fetchPartyBosses(selectedPartyId ?? ""),
    enabled: selectedPartyId !== null,
  });

  const partyBosses = partyBossesQuery.data ?? EMPTY_PARTY_BOSSES;

  /*
    ★ 기본 체크에서 **이번 주 이미 잡은 보스는 뺀다** — 아래 `effectiveBossIds` 참고.
      판정은 `plans` 가 오는 곳(`plansQuery`)이 아래에 선언돼 있어 그쪽에서 만든다.
  */

  /*
   * 티어: db. **prefetch 대상이 아니다** — 편집기를 열어야만 켜지므로 페이지 진입 때
   * 미리 읽으면 화면에 쓰이지 않는 DB 조회가 된다.
   */
  const peopleQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.people.pool()),
    queryFn: fetchPeoplePool,
    enabled: editor.open,
  });

  /** 겹쳐보기는 언제나 그 파티의 **전원**을 대상으로 한다. */
  const members = useMemo(
    () =>
      [...(membersQuery.data ?? EMPTY_MEMBERS)].sort(
        (a, b) => a.seatNo - b.seatNo,
      ),
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

  /**
   * **이 파티에 내가 데려가는 캐릭터** (`party_participants.character_id`).
   *
   * 등록 폼의 `내 캐릭터` 기본값이 여기서 온다 (발주자 지적, 2026-08-18: *"파티1에
   * 무르겨르로 선택을 완료했는데 보스 일정등록쪽에는 내 캐릭터가 아니라 본캐가 나오네?"*).
   * 값은 이미 화면까지 올라와 있었다 — 파티 목록이 `더저 (무르겨르)` 로 그리고 있는
   * 바로 그 값이라 새 조회가 필요 없다.
   *
   * `null` 은 **정상 상태**다 — 아직 안 골랐거나, 게스트라 캐릭터 개념이 없다. 그때는
   * 예전대로 본캐(목록 첫 행)로 물러난다.
   */
  const myPartyCharacterId = useMemo<string | null>(
    () =>
      viewerPersonId === null
        ? null
        : (members.find((member) => member.personId === viewerPersonId)
            ?.characterId ?? null),
    [members, viewerPersonId],
  );

  const total = personIds.length;
  const effectiveMinCount =
    minCountChoice === "all"
      ? Math.max(total, 1)
      : Math.max(Math.min(minCountChoice, total), 1);

  /*
   * ── 가용 시간 ─────────────────────────────────────────────────────────────
   * ★ 여기 있던 `isInitialRoster` / `initialScope` 판정은 **사라졌다.** 서버가 계산한
   *   조합인지 아닌지를 화면이 다시 맞춰 볼 필요가 없다 — 서버는 그 조합의 답을 **그
   *   조합의 키로** 캐시에 심었고, 키가 다르면 애초에 맞지 않는다. 판정이 틀릴 자리가
   *   구조적으로 없어진 것이 이 리팩터링의 핵심 이득이다.
   *
   * 세 쿼리 모두 db 티어. 무효화는 `availability.root()` 하나로 셋을 함께 날린다.
   */
  const availabilityQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.availability.resolve(personIds, range)),
    queryFn: () => fetchAvailability(personIds, range),
    enabled: total > 0,
  });

  /**
   * 겹침. **이미 등록된 런이 잡아먹은 시간은 DB 가 이미 뺀 답**을 준다(2026-08-18).
   * 한 사람이 같은 시각에 보스 둘을 도는 일정은 성립하지 않는다는 발주 요구다.
   *
   * ★ `editingRunId` 를 함께 넘긴다 = **수정 중인 런 하나는 점유에서 뺀다.** 그래야
   *   "지금 21시인 이 일정을 22시로 옮기고 싶다" 가 가능해진다.
   */
  const overlapQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.availability.overlap(
        personIds,
        range,
        effectiveMinCount,
        editingRunId,
      ),
    ),
    queryFn: () =>
      fetchAvailabilityOverlap(personIds, range, effectiveMinCount, editingRunId),
    enabled: total > 0,
  });

  /**
   * **무엇이 그 시간을 쓰고 있는가.** 겹침에서 빠진 구간을 화면이 "이미 일정 있음" 으로
   * 구분해 보여 주기 위한 조회다 — 가능 시간이 조용히 줄기만 하면 사용자에게는
   * "왜 안 되지?" 만 남는다 (§1.4).
   *
   * ⚠️ 마이그레이션 미적용이면 서버가 **빈 배열**을 준다(오류가 아니다). 그때 화면은
   *    블록만 안 보이는 예전 그대로의 겹쳐보기다.
   */
  const commitmentsQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.availability.commitments(personIds, range, editingRunId),
    ),
    queryFn: () => fetchRunCommitments(personIds, range, editingRunId),
    enabled: total > 0,
  });

  const exceptionsQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.availability.exceptions(personIds, range)),
    queryFn: () => fetchAvailabilityExceptions(personIds, range),
    enabled: total > 0,
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
    ...dbQueryOptions(queryKeys.db.availability.myPatterns()),
    queryFn: fetchMyAvailabilityPatterns,
    enabled: viewerPersonId !== null,
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
    ...dbQueryOptions(
      queryKeys.db.availability.exceptions(myPersonIds, exceptionEditorRange),
    ),
    queryFn: () =>
      fetchAvailabilityExceptions(myPersonIds, exceptionEditorRange),
    // 편집기를 열기 전에는 부르지 않는다. 화면에 쓰이지 않는 요청이다.
    enabled: viewerPersonId !== null && availabilityEditor.open,
  });

  const bossQuery = useQuery({
    // 티어: bossMaster(6시간) — 카탈로그는 게임 패치 때만 바뀐다 (§2.4 Rule 4).
    ...bossMasterQueryOptions(queryKeys.db.bosses.catalog()),
    queryFn: fetchBossCatalog,
  });

  // ── 내 캐릭터 (일정에 데려갈 대상) ────────────────────────────────────────
  /**
   * ★ **넥슨을 부르지 않는다.** 우리 DB 의 `characters` 를 읽을 뿐이라 `"db"`
   *   네임스페이스이고 15분 하한의 대상이 아니다 (§2.1.1 — 목록의 진실은 우리 DB).
   */
  const charactersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.characters.forRuns()),
    queryFn: fetchMyRunCharacters,
    enabled: viewerPersonId !== null,
  });

  const characters = charactersQuery.data ?? EMPTY_RUN_CHARACTERS;

  /**
   * 실제로 쓸 캐릭터. **우선순위가 셋**이고 순서에 이유가 있다.
   *
   *   ① 사용자가 등록 폼에서 **직접 고른** 값 (`draftCharacterId`)
   *   ② **그 파티에서 내가 지정한 참여 캐릭터** (`party_participants.character_id`)
   *   ③ 본캐 = 목록 첫 행 (`fetchMyRunCharacters` 가 본캐를 맨 앞으로 정렬한다)
   *
   * ★ ②가 없던 것이 발주자가 지적한 결함이다. 예전에는 ① 다음이 곧바로 ③이라,
   *   파티에 무르겨르로 들어가 있어도 등록 폼은 언제나 본캐를 집었다.
   * ★ ①이 ②보다 앞인 것과 "파티 참여 캐릭터를 따라간다"는 요구는 **충돌하지 않는다.**
   *   파티를 바꾸면 ①이 `null` 로 초기화되므로(§`handleSelectParty`) 새 파티에서는
   *   ②가 곧 기본값이다. 즉 **기본값만** 파티를 따라가고, 그 위에서 고르는 자유는
   *   그대로 남는다 — `run_signups.character_id` 가 `party_participants.character_id`
   *   와 별개로 존재하는 이유가 그것이고(§1 — 런은 사람이 아니라 캐릭터 단위),
   *   특정 런만 다른 캐릭으로 나가는 경우가 실제로 있다.
   * ★ 세 단계 모두 `characters` 안에서 다시 찾는다. 추적을 끊었거나 지워진 캐릭터가
   *   `party_participants` 에 남아 있을 수 있고(`on delete set null` 이전 상태), 목록에
   *   없는 id 를 그대로 쓰면 폼이 "선택 없음"으로 굳어 등록 버튼이 영영 안 열린다.
   */
  const effectiveCharacterId =
    characters.find((entry) => entry.characterId === draftCharacterId)
      ?.characterId ??
    characters.find((entry) => entry.characterId === myPartyCharacterId)
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
    ...dbQueryOptions(
      queryKeys.db.bossPlans.character(effectiveCharacterId ?? "none"),
    ),
    queryFn: () => fetchCharacterPlans(effectiveCharacterId ?? ""),
    enabled: viewerPersonId !== null && effectiveCharacterId !== null,
  });

  const plans = plansQuery.data?.plans ?? EMPTY_PLANS;

  /**
   * 이 캐릭터가 **이번 주에 이미 잡은 보스**. 판정은 뷰 `v_character_boss_plan_status`
   * 의 `is_cleared` 가 이미 했다 — TS 에서 다시 만들지 않는다.
   */
  const clearedBossIds = useMemo(
    () =>
      new Set(
        plans.flatMap((plan) => (plan.isCleared ? [plan.bossDifficultyId] : [])),
      ),
    [plans],
  );

  /**
   * 실제로 체크된 보스. 손대지 않았으면 **그 파티에 등록된 보스**가 기본값이다 —
   * "보통 묶어서 간다"가 발주 요구의 전제라 켜진 상태로 시작한다.
   *
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   다만 **이번 주에 이미 잡은 보스는 체크하지 않는다** (발주자 지시, 2026-08-18:
   *   *"이미 보스를 돌았는데 일정을 잡을 이유는없잖아"*).
   *   ═══════════════════════════════════════════════════════════════════════
   *   결정석은 캐릭터당 주 1회라 그대로 등록하면 수익이 두 번 잡힌다. 그래도
   *   **목록에서 숨기지는 않는다** — 재도전·대리로 한 번 더 가는 경우가 실제로 있고,
   *   막는 것과 뒤로 미는 것은 다르다. 체크만 풀고 `이번 주 완료` 배지는 그대로 둔다.
   *
   * ★ `draftBossIds` 가 `null` 일 때만 적용된다. 사용자가 한 번이라도 손대면 그 판단이
   *   이긴다 — 완료된 보스를 일부러 켠 것을 계획 조회가 도착할 때마다 되돌리면
   *   체크가 저절로 꺼지는 것처럼 보인다.
   * ★ 계획이 아직 안 왔으면 `clearedBossIds` 가 비어 있어 예전과 같은 기본값이다.
   *   도착하면 기본값이 한 번 좁아진다 — 잘못 켜진 채로 등록되는 것보다 낫다.
   */
  const effectiveBossIds = useMemo<readonly BossDifficultyId[]>(
    () =>
      draftBossIds ??
      partyBosses
        .filter((entry) => !clearedBossIds.has(entry.bossDifficultyId))
        .map((entry) => entry.bossDifficultyId),
    [draftBossIds, partyBosses, clearedBossIds],
  );

  // ── 일정 (파티에 속한다) ──────────────────────────────────────────────────
  const runsQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
    ),
    queryFn: () => fetchPartyRuns(selectedPartyId ?? "", weekKey),
    enabled: selectedPartyId !== null,
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
      /*
       * ★ **파티 목록의 "이번 주 일정 N건" 도 함께.** 대시보드와 `/boss-plans` 가 같은
       *   집계를 읽으므로, 여기서 날리지 않으면 방금 잡은 일정이 다른 화면에서는
       *   없는 것처럼 보인다 (§2.4 Rule 1). 파티 자체는 안 바뀌었으므로
       *   `party.root()` 를 통째로 날리지 않고 `party.mine` 만 짚는다 — 과잉 무효화는
       *   구성원·보스 목록까지 불필요하게 다시 받게 한다.
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.mine(weekKey),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      /*
        ★ **가용시간도 함께 날린다** (2026-08-18). 등록된 런은 이제 그 시간을 점유하므로
          (마이그레이션 23) 겹침 결과와 "이미 일정 있음" 블록이 **둘 다** 달라진다.
          이걸 빠뜨리면 방금 잡은 시간이 60초 동안 여전히 "가능"으로 보이고, 그 사이에
          같은 시간대로 하나 더 잡히는 — 정확히 이 기능이 막으려던 — 사고가 난다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.availability.root(),
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
  /**
   * 마지막 참가 신청이 **낙관적으로 처리됐는가.** 실패 문구를 어디에 그릴지 가른다 —
   * 낙관적이었으면 롤백 알림이 말하고, 아니었으면 그 줄 아래에 문구가 붙는다.
   * `signupRunId` 로 대신할 수 없다: 그 값은 `onSettled` 에서 비워지므로 실패 직후
   * 문구가 함께 사라진다.
   */
  const [signupWasOptimistic, setSignupWasOptimistic] = useState(false);
  /**
   * ★ **조건부 낙관**(2026-08-18). 두 경우를 갈라야 한다:
   *
   * - **이미 `going` 인 사람이 캐릭터만 바꾸는 경우** → 낙관적. 참여 인원 수가 그대로라
   *   `viewerShareMeso`(← DB `distribute_meso`)가 움직이지 않는다. 바뀌는 것은
   *   그 줄의 캐릭터 이름 하나뿐이고, 그 이름은 `participantLabel()` 이 조합한다.
   * - **새로 참여하는 경우** → 낙관적으로 하지 않는다. `going` 수가 늘면 그 런의
   *   **분배 몫이 전부 다시 계산된다.** 그 계산의 구현은 `distribute_meso()` 하나뿐이어야
   *   하고(웹과 카톡 봇이 같은 답을 내야 한다), 화면이 1/n 을 다시 적으면 `share_mode`
   *   가 균등이 아닌 런에서 실제 약정과 다른 금액을 말한다 — 실제로 그랬던 결함이다.
   *   금액을 옆에 두고 이름만 먼저 바꾸면 **서로 어긋난 숫자**가 되므로 응답을 기다린다.
   */
  const signup = useOptimisticMutation({
    mutationFn: (input: SaveRunSignupInput) => saveRunSignup(input),
    optimistic: (input) => {
      if (viewerPersonId === null || selectedPartyId === null) return [];
      if (input.status !== "going") return [];
      const key = queryKeys.db.runs.list(selectedPartyId, weekKey);
      const runs = queryClient.getQueryData<readonly ScheduledRun[]>(key);
      const run = runs?.find((entry) => entry.runId === input.runId);
      const mine = run?.participants.find(
        (entry) => entry.personId === viewerPersonId,
      );
      // 이미 `going` 이 아니면 참여 인원 수가 바뀐다 → 분배 몫이 움직인다.
      if (mine === undefined || mine.status !== "going") return [];
      const picked =
        characters.find((entry) => entry.characterId === input.characterId) ??
        null;
      if (picked === null) return [];
      return [
        cachePatch<readonly ScheduledRun[]>(key, (current) =>
          current.map((entry) =>
            entry.runId === input.runId
              ? {
                  ...entry,
                  participants: entry.participants.map((participant) =>
                    participant.personId === viewerPersonId
                      ? {
                          ...participant,
                          characterId: picked.characterId,
                          characterName: picked.name,
                          isMainCharacter: picked.isMain,
                        }
                      : participant,
                  ),
                }
              : entry,
          ),
        ),
      ];
    },
    /*
      ★ **가용시간까지 무효화한다** (2026-08-18). 점유 판정은 `going` 신청만 세므로
        (마이그레이션 23) 참가/불참이 바뀌면 그 사람의 점유 시간이 생기거나 사라진다.
        캐릭터만 바꾸는 경우에는 `going` 수가 그대로라 답이 안 바뀌지만, 두 경우를
        가르는 조건을 여기 한 번 더 적으면 판정이 두 벌이 된다 — 60초짜리 DB 조회
        하나를 더 하는 편이 싸다.
    */
    invalidate: () => [
      queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
      queryKeys.db.availability.root(),
    ],
    rollbackTitle: "참가 신청을 저장하지 못했습니다",
    rollbackDescription: (input) =>
      `${characters.find((entry) => entry.characterId === input.characterId)?.name ?? "선택한 캐릭터"} 로 참가하려던 것을 되돌렸습니다.`,
    onSettled: () => {
      setSignupRunId(null);
    },
  });

  /**
   * ★ **낙관적으로 처리된 신청에는 로딩 표시를 붙이지 않는다.**
   *   이미 `going` 인 사람이 캐릭터만 바꾸는 경우 값은 즉시 바뀌므로, 그 줄을 "저장 중"
   *   으로 잠그면 "먼저 반영"의 이점이 그대로 사라진다. 새로 참여하는 경우에만
   *   `signupRunId` 를 세워 그 줄이 응답을 기다린다는 사실을 보여 준다
   *   (그쪽은 분배 몫이 다시 계산돼야 해서 낙관적으로 할 수 없다 — 위 `signup` 주석).
   *
   *   판정 조건은 `signup.optimistic` 과 **같은 한 줄**이다(내 참가가 이미 `going` 인가).
   */
  const handleSignup = useCallback(
    (runId: RunId, characterId: string) => {
      const runs = queryClient.getQueryData<readonly ScheduledRun[]>(
        queryKeys.db.runs.list(selectedPartyId ?? "none", weekKey),
      );
      const mine = runs
        ?.find((entry) => entry.runId === runId)
        ?.participants.find((entry) => entry.personId === viewerPersonId);
      const isCharacterSwap = mine?.status === "going";
      setSignupWasOptimistic(isCharacterSwap);
      setSignupRunId(isCharacterSwap ? null : runId);
      signup.mutate({ runId, characterId, status: "going" });
    },
    [queryClient, selectedPartyId, signup, viewerPersonId, weekKey],
  );

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * 일정 수정 · 취소/삭제
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ **낙관적으로 처리하지 않는다** (`@/lib/query/optimistic` 의 금지 목록 1·4번).
   *    - 취소인지 삭제인지를 **서버가 판정**한다. 화면이 미리 정하면 그 판정이 뒤집히는
   *      순간(같이 간 사람이 방금 클리어를 체크) 거짓을 먼저 보여 주게 된다.
   *    - 수정은 서버가 거절하는 경우가 둘 있다(취소된 런 수정 · 클리어가 붙은 런의 주차
   *      이동, 둘 다 409). 낙관적으로 반영했다가 롤백하면 화면이 깜빡이고 사용자는
   *      무엇이 잘못됐는지 모른다.
   *    - `entry_party_size` 를 고치면 **분배 몫이 다시 계산된다**(`distribute_meso`).
   *      금액을 화면이 다시 적으면 웹과 카톡 봇의 답이 갈라진다.
   *
   * ★ 무효화 범위 — 한 번의 수정이 움직이는 것 전부:
   *    · `runs.list(partyId, weekKey)` + **주차가 바뀌었으면 이전 주차도**
   *    · `party.mine(weekKey)` (파티 카드의 "이번 주 일정 N건")
   *    · `dashboard.root()` · `income.root()` (분배 몫·수익 합계)
   *    · `availability.root()` (점유가 생기고 사라진다 — 마이그레이션 23)
   */
  const invalidateRunChange = useCallback(
    (partyId: PartyId, weekKeys: readonly WeekKey[]) => {
      for (const key of new Set(weekKeys)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.runs.list(partyId, key),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.party.mine(key),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.income.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.availability.root(),
      });
    },
    [queryClient],
  );

  const editRun = useMutation({
    mutationFn: (input: UpdateRunInput) => updatePartyRun(input),
    onSuccess: (result) => {
      /*
        ★ **두 주차를 모두 날린다.** 시각을 다음 주로 옮기면 이번 주 목록에서는 사라지고
          다음 주 목록에 나타난다 — 한쪽만 날리면 나머지가 유령 항목을 들고 남는다.
          어느 주차였는지는 서버가 `previousWeekKey` 로 알려 준다.
      */
      invalidateRunChange(result.partyId, [
        result.weekKey,
        result.previousWeekKey,
      ]);
      setEditingRunId(null);
      setRemovalNotice(null);
    },
  });

  const removeRun = useMutation({
    mutationFn: (runId: RunId) => removePartyRun(runId),
    onSuccess: (result) => {
      invalidateRunChange(result.partyId, [result.weekKey]);
      setEditingRunId(null);
      /*
        ★ **서버가 실제로 무엇을 했는지**를 그대로 옮긴다. 취소는 기록이 남고 삭제는
          사라진다 — "처리했습니다" 로 뭉뚱그리면 사용자는 자기 수익 기록이 어떻게 됐는지
          알 수 없다.
      */
      setRemovalNotice(
        result.outcome === "cancelled"
          ? "클리어 기록이 있어 삭제하지 않고 취소했습니다. 목록에는 취소로 남고 수익 기록은 그대로입니다. 수정에서 되돌릴 수 있습니다."
          : "일정을 삭제했습니다. 빠진 번호는 그대로 비워 둡니다 — 남은 일정의 번호는 바뀌지 않습니다.",
      );
    },
  });

  /** 수정 패널을 여닫을 때는 직전 결과 문구를 치운다 — 이미 지난 사건이다. */
  const handleEditingRunIdChange = useCallback((runId: RunId | null) => {
    setEditingRunId(runId);
    setRemovalNotice(null);
    editRun.reset();
  }, [editRun]);

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
      // 대시보드의 "내 파티" 카드에도 새 파티가 한 줄 늘어난다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
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
      /* 구성원 수가 바뀌면 대시보드 파티 카드의 `N명` 도 바뀐다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
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
  /**
   * ★ **낙관적**(2026-08-18). 서버가 만드는 값이 하나도 없다 — 참가자 행도 캐릭터 행도
   *   이미 있고, `updateMyPartyCharacter()` 는 `party_participants.character_id` 한
   *   컬럼만 UPDATE 한다(`server/schedule-repo.ts`). 표시 이름(`더저(메검메)`)은 저장된
   *   문자열이 아니라 `participantLabel()` 이 읽을 때 조합하는 값이므로, 구성원 캐시의
   *   `characterId` / `characterName` / `isMainCharacter` 세 칸을 고치면 **구성원 목록도
   *   겹쳐보기 좌측도 같은 이름으로 함께 따라온다.**
   *
   *   런 목록은 낙관적으로 건드리지 않는다 — 런의 캐릭터는 `run_signups.character_id`
   *   라는 **다른 컬럼**이고 이 저장이 손대지 않는다(같은 파일의 서버 주석). 무효화만
   *   예전대로 남긴다.
   */
  const saveMyCharacter = useOptimisticMutation({
    mutationFn: (input: UpdatePartyCharacterInput) =>
      updateMyPartyCharacter(input),
    optimistic: (input) => {
      if (viewerPersonId === null) return [];
      const picked =
        input.characterId === null
          ? null
          : (characters.find(
              (entry) => entry.characterId === input.characterId,
            ) ?? null);
      // 목록에 없는 캐릭터를 골랐다면 이름을 지어낼 수 없다 — 서버 응답을 기다린다.
      if (input.characterId !== null && picked === null) return [];
      return [
        cachePatch<readonly PartyMember[]>(
          queryKeys.db.party.members(input.partyId),
          (current) =>
            current.map((member) =>
              member.personId === viewerPersonId
                ? {
                    ...member,
                    characterId: picked?.characterId ?? null,
                    characterName: picked?.name ?? null,
                    isMainCharacter: picked?.isMain ?? false,
                  }
                : member,
            ),
        ),
      ];
    },
    invalidate: (input) => [
      queryKeys.db.party.members(input.partyId),
      queryKeys.db.runs.root(),
    ],
    rollbackTitle: "파티 참여 캐릭터를 저장하지 못했습니다",
    rollbackDescription: (input) =>
      input.characterId === null
        ? "캐릭터 지정 해제를 되돌렸습니다."
        : `${characters.find((entry) => entry.characterId === input.characterId)?.name ?? "선택한 캐릭터"} 로 바꾸려던 것을 되돌렸습니다.`,
  });

  const handleChangeMyCharacter = useCallback(
    (characterId: string | null) => {
      if (selectedPartyId === null) return;
      /*
        등록 폼의 초안을 비운다 — **파티 참여 캐릭터를 바꾸는 것은 의도적인 행동**이고,
        그 뒤에도 폼이 예전 선택을 들고 있으면 "바꿨는데 등록 폼은 그대로"라는 같은
        불만이 다시 나온다. 비우면 `effectiveCharacterId` ②가 새 값을 집는다.
      */
      setDraftCharacterId(null);
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
      /*
        고른 캐릭터도 그 파티의 것이었다. 비워 두면 **새 파티의 참여 캐릭터**가
        기본값이 된다(`effectiveCharacterId` ②). 남겨 두면 파티를 옮겨도 앞 파티에서
        고른 캐릭터가 그대로 붙어 있어, 발주자가 지적한 "본캐가 나온다"와 같은 결의
        어긋남이 파티마다 반복된다.
      */
      setDraftCharacterId(null);
      /*
        수정 중이던 런은 앞 파티의 것이다. 열어 둔 채 파티를 바꾸면 목록에 없는 런의
        패널이 남고, 겹쳐보기는 그 런을 계속 점유에서 빼는 키로 조회한다.
      */
      setEditingRunId(null);
      setRemovalNotice(null);
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

  const myPatterns = myPatternsQuery.data ?? EMPTY_PATTERNS;

  const retryAvailabilityAll = useCallback(() => {
    retryAvailability();
    void commitmentsQuery.refetch();
  }, [retryAvailability, commitmentsQuery]);

  /*
    ★ 점유 조회(`commitmentsQuery`)는 **로딩·에러 판정에 넣지 않는다.**
      마이그레이션 미적용이면 이 조회만 비고 나머지는 멀쩡한데, 그것 때문에 겹쳐보기
      전체를 에러 화면으로 덮으면 기능 하나가 빠진 상태가 화면 전체의 고장이 된다.
      실패하면 "이미 일정 있음" 블록만 안 보인다 — 겹침 계산은 서버가 이미 뺀 답이라
      **틀린 값을 보여 주는 것이 아니라 설명이 빠지는 것**이다.
  */
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
        onInviteGuest={handleInviteGuest}
      />

      {/*
        ★ ═══════════════════════════════════════════════════════════════════
          위는 2단(**높이를 맞춘다**), 등록된 일정은 그 아래 **전체 폭 행**이다.
          ═══════════════════════════════════════════════════════════════════
          발주자 지시(2026-08-18): *"가능시간 겹쳐보기, 보스 일정 등록만 Y축 맞춘다음
          그 아래엔 x축까지 꽉차게 등록된 일정 보여주게 변경해"*.

          예전에는 `ScheduledRunList` 가 오른쪽 칸 **안에** 세로로 쌓여 있어 등록된
          일정이 24~28rem 폭에 갇혔고, 참가자·금액·캐릭터 선택이 세로로 길게 늘어졌다.

          높이 맞춤은 그리드의 기본 `items-stretch` + 두 카드의 `h-full` 이 한다.
          **최대 높이를 걸지 않는다** — 걸면 내용이 잘리고, 안에 있는 목록들은 이미
          각자 `max-h` + 스크롤을 갖고 있다. 모바일(1열)에서는 DOM 순서 그대로
          겹쳐보기 → 등록 → 등록된 일정이 된다.
      */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem]">
        <AvailabilityPanel
          now={now}
          range={range}
          members={members}
          intervals={availabilityQuery.data ?? EMPTY_INTERVALS}
          overlapWindows={overlapQuery.data ?? EMPTY_OVERLAP}
          exceptions={exceptionsQuery.data ?? EMPTY_EXCEPTIONS}
          commitments={commitmentsQuery.data ?? EMPTY_COMMITMENTS}
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
          onRetry={retryAvailabilityAll}
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

        {/*
          ★ 래퍼 `<div>` 를 남긴다. 그리드 칸이 늘어난 높이를 카드에 그대로 물려주려면
            (`h-full`) 중간에 `min-h-0` 를 가진 flex 컨테이너가 하나 필요하다.
            예전에는 이 안에 등록 폼과 등록된 일정이 **함께** 들어 있었다.
        */}
        <div className="flex min-w-0 flex-col">
          <RunComposer
            partyId={selectedPartyId ?? ""}
            dayRows={dayRows}
            bosses={bossQuery.data ?? EMPTY_BOSSES}
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
        </div>
      </div>

      {/*
        등록된 일정 — **전체 폭 행.** 위 두 카드와 같은 세로 흐름 안에 있지만 그리드
        밖이라 x 축을 통째로 쓴다. 그 폭에 맞춰 카드도 안팎이 다시 배치된다
        (목록은 2~3열 그리드, 카드 안 참가자 줄은 가로로 편다 — `scheduled-run-list`).
      */}
      <ScheduledRunList
        runs={runsQuery.data ?? EMPTY_RUNS}
        now={now}
        isLoading={runsQuery.isLoading}
        isError={runsQuery.isError}
        onRetry={() => void runsQuery.refetch()}
        partyName={selectedParty?.name ?? null}
        viewerPersonId={viewerPersonId}
        characters={characters}
        /* 참가 신청 기본값도 파티 참여 캐릭터를 본다 — 등록 폼과 같은 규칙(§0.2-1). */
        partyCharacterId={myPartyCharacterId}
        onSignup={handleSignup}
        signupPendingRunId={signup.isPending ? signupRunId : null}
        /*
          낙관적으로 처리된 신청(캐릭터만 교체)의 실패는 롤백 알림이 말하므로
          여기 문구는 **응답을 기다린 신청**(새 참여)에만 붙인다.
        */
        signupError={signupWasOptimistic ? null : signup.error}
        editingRunId={editingRunId}
        onEditingRunIdChange={handleEditingRunIdChange}
        onSubmitEdit={(input) => editRun.mutate(input)}
        isEditPending={editRun.isPending}
        editError={editRun.error}
        onRemove={(runId) => removeRun.mutate(runId)}
        removingRunId={removeRun.isPending ? removeRun.variables : null}
        removeError={removeRun.error}
        removalNotice={removalNotice}
        onDismissRemovalNotice={() => setRemovalNotice(null)}
      />

      {/*
        ★ key 에 **이름공간**을 붙인다. 이 부모 아래 `seq` 로 다시 마운트하는 다이얼로그가
          셋인데(로스터 편집기 · 초대 링크 · 가능 시간), 카운터가 전부 0 에서 시작하므로
          이름 없이 숫자만 쓰면 형제끼리 key 가 `0` 으로 겹친다. 그러면 React 가 엉뚱한
          쪽을 재사용해 다이얼로그 상태가 서로 섞인다 — 단순 경고가 아니다.
          **다이얼로그를 하나 더 추가할 때도 반드시 고유한 접두사를 붙일 것.**
      */}
      <PartyEditorDialog
        key={`party-editor-${editor.seq}`}
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
        people={peopleQuery.data ?? EMPTY_PEOPLE}
        isPeopleLoading={peopleQuery.isLoading}
        isPeopleError={peopleQuery.isError}
        onPeopleRetry={() => void peopleQuery.refetch()}
        bosses={bossQuery.data ?? EMPTY_BOSSES}
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
          key={`guest-invite-${inviteTarget.seq}`}
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
          key={`availability-editor-${availabilityEditor.seq}`}
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
          exceptions={myExceptionsQuery.data ?? EMPTY_EXCEPTIONS}
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
