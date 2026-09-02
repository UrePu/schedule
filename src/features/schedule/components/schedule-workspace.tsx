"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Settings2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { BossIcon, kstWeekdayKo } from "@/components/domain";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  ErrorState,
  useToaster,
} from "@/components/ui";

import { fetchCharacterPlans } from "@/features/boss-plans/data";
import type { CharacterBossPlan } from "@/features/boss-plans/types";
import { GuestInviteDialog } from "@/features/invites/components";
import { getTrackedBossCatalog } from "@/lib/boss-master";
import { participantLabel } from "@/lib/domain/participant-label";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import {
  addKstDays,
  kstDayKey,
  kstMoment,
} from "@/lib/time/kst-wallclock";
import { formatKst, getWeekKey } from "@/lib/time/week";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityInterval,
  AvailabilityPattern,
  AvailabilityPatternInput,
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
  archiveParty,
  createParty,
  createPartyRunBundle,
  deleteAvailabilityException,
  fetchAvailabilityBoard,
  fetchAvailabilityExceptions,
  fetchMyAvailabilityPatterns,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
  fetchPartyRuns,
  fetchPeoplePool,
  removePartyRun,
  removePartyRuns,
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
import { PartySelectBar } from "./party-select-bar";
import { PartyShareSection } from "./party-share-section";
import { PartyWizardDialog } from "./party-wizard-dialog";
import { RunWizardDialog } from "./run-wizard-dialog";
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
  /**
   * 이 화면이 무엇을 하는 화면인가 — **파티 관리**인가 **일정 관리**인가.
   *
   * 발주 지시(2026-08-25): *"일정짜기를 두가지로 분리하자. 파티 관리 + 일정관리."*
   *
   * ★ 두 화면이 **한 컴포넌트**인 이유: 데이터가 통째로 같다. 파티·구성원·보스·가용시간·
   *   런이 서로를 참조하고, 뮤테이션의 무효화 목록도 서로 겹친다(로스터를 고치면
   *   겹쳐보기와 런 목록이 함께 움직인다). 컴포넌트를 둘로 쪼개면 그 400줄짜리 뮤테이션
   *   배선이 두 벌이 되고, 한쪽만 고쳐지는 순간 두 화면이 다른 말을 하기 시작한다.
   *   **갈리는 것은 무엇을 그리는가뿐**이라 렌더에서만 갈린다.
   */
  readonly mode: "schedule" | "parties";
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
const EMPTY_RUNS: readonly ScheduledRun[] = [];
const EMPTY_COMMITMENTS: readonly RunCommitment[] = [];
const EMPTY_RUN_CHARACTERS: readonly RunCharacterOption[] = [];
const EMPTY_PLANS: readonly CharacterBossPlan[] = [];

export function ScheduleWorkspace({
  mode,
  now,
  range: baseRange,
  weekKey: baseWeekKey,
  viewerPersonId,
}: ScheduleWorkspaceProps) {
  const queryClient = useQueryClient();
  /*
    저장 결과를 말하는 자리. 모달은 저장에 성공하면 **닫히므로**, 성공 문구를 창 안에
    그리면 아무도 못 본다(§ `toast.tsx` 머리말이 같은 이유로 이 컴포넌트를 만들었다).
  */
  const toaster = useToaster();

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * 보고 있는 주차 — **이번 주에 갇히지 않는다** (2026-08-19 발주자)
   * ═══════════════════════════════════════════════════════════════════════════
   * *"가능시간 겹쳐보기 탭에서도 이번주만 가능한게 불편해."*
   *
   * 서버가 준 `weekKey` · `range` 는 이제 **기준(이번 주)** 일 뿐이고, 실제로 그리는 주는
   * 이 상태가 정한다. 다음 주 보스 일정을 미리 잡는 일이 흔한데 이번 주에 갇혀 있으면
   * 그걸 할 자리가 아예 없었다.
   *
   * ★ 아래 코드는 예전 그대로 `weekKey` · `range` 라는 이름을 쓴다 — 그 두 값이 파생으로
   *   바뀌었을 뿐이라 조회 키·무효화·등록 폼이 **자동으로 보고 있는 주를 따라간다.**
   *   여기서 이름을 갈라 놓으면 어느 한 곳이 옛 주차를 계속 보게 되고, 그건 "다음 주를
   *   보고 있는데 이번 주 일정이 등록되는" 버그가 된다.
   * ★ 오프셋 0 은 서버가 이미 캐시에 심어 둔 값이라 왕복이 없다. 다른 주는 그때 받아 온다
   *   (§2.4 — 캐시가 화면을 소유한다).
   */
  const [weekOffset, setWeekOffset] = useState(0);

  const weekStart = useMemo(
    () => addKstDays(baseRange.from, 7 * weekOffset),
    [baseRange.from, weekOffset],
  );
  const weekKey = useMemo(
    () => (weekOffset === 0 ? baseWeekKey : getWeekKey(weekStart)),
    [baseWeekKey, weekOffset, weekStart],
  );
  const range = useMemo<TimeRange>(
    () =>
      weekOffset === 0
        ? baseRange
        : { from: weekStart, to: addKstDays(weekStart, 7) },
    [baseRange, weekOffset, weekStart],
  );

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
  /** 드래그로 고른 시작 시각. `null` 이면 겹침의 시작 시각을 쓴다. */
  const [selectedStartsAt, setSelectedStartsAt] = useState<Date | null>(null);
  const [editor, setEditor] = useState<{
    readonly open: boolean;
    readonly mode: PartyEditorMode;
    readonly seq: number;
  }>({ open: false, mode: "create", seq: 0 });

  /**
   * 파티 **만들기 마법사**. 편집(`editor`)과 분리해 둔다 — 만들기는 순서를 강제하는
   * 4단계 흐름이고, 편집은 이미 있는 파티의 한 부분만 고치는 일이라 순서가 없다.
   * `createdPartyId` 는 저장이 끝났다는 신호이자 4단계(분배)가 조회할 대상이다.
   *
   * ⚠️ **선언 위치가 `editor` 바로 아래인 것에 이유가 있다.** 사람 후보 조회
   *    (`peopleQuery`)가 두 창의 열림 상태를 **함께** 봐야 하는데, 이 선언이 파일
   *    아래쪽(1200줄대)에 있던 동안 그 조회는 `editor.open` 만 볼 수 있었다.
   *    그래서 마법사에서는 후보가 영원히 비어 있었다(2026-08-28).
   */
  const [wizard, setWizard] = useState<{
    readonly open: boolean;
    readonly seq: number;
    readonly createdPartyId: PartyId | null;
  }>({ open: false, seq: 0, createdPartyId: null });


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

  /**
   * 일정 초안(보스·날짜·시각·소요). 왼쪽 패널과 오른쪽 폼이 공유하는 상태다.
   *
   * ★ **인원수는 더 이상 여기 없다**(2026-08-20). 발주 지시로 폼이 참여자를 체크박스로
   *   고르게 되면서 인원수는 그 체크 수에서 파생된다 — 초안이 들고 있을 값이 아니다.
   *   함께 사라진 것들: 파티를 바꾸거나 겹침을 고를 때 인원수를 미리 채워 주던 두 자리,
   *   그리고 그 자동 채움이 사용자의 입력을 덮지 않게 지키던 `partySizeTouched` 플래그.
   *   **참여자는 겹침이 이미 말해 주므로 추측해서 채울 값 자체가 없어졌다.**
   */
  /*
    ★ 날짜·시각·소요는 **더 이상 여기 없다**(2026-08-25). 등록이 모달로 옮겨가면서
      그 값들의 수명이 모달과 같아졌다 — 창을 닫으면 사라져야 하는 값을 부모가 들고
      있으면 "취소"가 취소가 아니게 된다. 겹침 막대 선택(`selectedWindow`)만 남고,
      모달이 그것을 초기값으로 읽는다.
  */

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
   * 티어: db. **prefetch 대상이 아니다** — 창을 열어야만 켜지므로 페이지 진입 때
   * 미리 읽으면 화면에 쓰이지 않는 DB 조회가 된다.
   *
   * ⚠️ **두 창이 이 결과를 함께 쓴다** — 파티 편집기(`editor`)와 만들기 마법사
   *    (`wizard`). 게이트가 `editor.open` 하나였던 동안, 마법사만 열면 조회가
   *    **아예 뜨지 않았다.** 그러면 `data` 는 `undefined`, `isLoading` 은 **false**
   *    (비활성 쿼리는 fetch 중이 아니다)라, 화면이 로딩도 에러도 아닌 **"후보 목록이
   *    비어 있습니다"** 로 곧장 떨어진다. 친구가 5명 있어도 한 명도 안 보였다
   *    (발주 지적 2026-08-28: *"후보에 친구 아무도 안뜸"*).
   *
   *    마법사는 파티/일정 화면이 갈라지면서(2026-08-25) 나중에 생긴 창인데, 이
   *    게이트만 그대로 남아 있었다. **소비자를 추가할 때는 게이트도 함께 넓혀야 한다.**
   */
  const peopleQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.people.pool()),
    queryFn: fetchPeoplePool,
    enabled: editor.open || wizard.open,
  });
  /*
    ★ 소비자에게 넘기는 로딩 신호는 `isLoading` 이 아니라 **`isPending`** 이다.
      `isLoading = isPending && isFetching` 이라 **비활성 쿼리에서는 false** 가 되고,
      그 조합(데이터 없음 + 로딩 아님)이 위의 "후보가 비었다"는 **거짓 단정**을 만들었다.
      `isPending` 은 값이 아직 없다는 사실만 말하므로, 게이트가 또 어긋나더라도 화면은
      스켈레톤에서 멈출 뿐 **없는 사실을 지어내지 않는다**(§0.3).
  */

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
   * ★ **네 조회가 하나가 됐다** (2026-08-18 성능 작업, 마이그레이션 24).
   *   개인 구간 · 겹침 창 · 예외 자국 · "이미 일정 있음" 블록은 같은 사람 집합 ·
   *   같은 구간의 **한 시점 스냅샷**이다. 따로 받으면 화면이 잠깐 서로 어긋난 시간표를
   *   그리고, 원격 왕복 1회 ≈ 78ms 가 그대로 네 번 쌓인다. 계산은 옮겨오지 않았다 —
   *   DB 함수 넷을 묶어 부르는 `public.availability_board()` 가 답을 그대로 싣는다
   *   (§1.4 — 겹쳐보기 로직은 정확히 한 곳).
   *
   * ★ `editingRunId` 를 함께 넘긴다 = **수정 중인 런 하나는 점유에서 뺀다.** 그래야
   *   "지금 21시인 이 일정을 22시로 옮기고 싶다" 가 가능해진다.
   *
   * db 티어. 무효화는 `availability.root()` 하나로 이 쿼리와 패턴·예외를 함께 날린다.
   */
  const boardQuery = useQuery({
    ...dbQueryOptions(
      queryKeys.db.availability.board(
        personIds,
        range,
        effectiveMinCount,
        editingRunId,
      ),
    ),
    queryFn: () =>
      fetchAvailabilityBoard(personIds, range, effectiveMinCount, editingRunId),
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

  /*
    보스 카탈로그는 **쿼리가 아니다.** 게임 패치 때만 바뀌는 값이라 코드 상수로
    내려왔다(`@/lib/boss-master`, 발주자 지시 2026-08-18). 왕복이 사라졌으므로
    로딩·오류 상태도 함께 사라진다. 목록 순서(최신 우선)와 일간 제외의 소유자는
    여전히 하나이며, 그 자리가 `getTrackedBossCatalog()` 로 옮겨졌을 뿐이다.
  */
  const bosses = getTrackedBossCatalog();

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
        plans.flatMap((plan) =>
          plan.isCleared ? [plan.bossDifficultyId] : [],
        ),
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
        ★ **이번 주 시간표도 함께**(2026-08-20). 방금 만든 런에 나도 참가로 들어가므로
          현황 › 이번주 일정에 나타나야 한다. `runs.list` 는 파티별 키라 시간표
          (`runs.timetable`)를 덮지 못한다 — 접두사가 겹치지 않아 자동으로 따라오지
          않는다는 사실을 놓치면 "일정을 잡았는데 시간표가 그대로"가 된다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.timetable(weekKey),
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

      /*
        ═══════════════════════════════════════════════════════════════════════
        ⚠️ **창을 닫고 결과를 말한다** (2026-08-28)
        ═══════════════════════════════════════════════════════════════════════
        발주 지적: *"등록을 눌러도 반응이없음. 생성된건지 확인안됨"*.

        여기는 조회 무효화만 하고 **창을 그대로 뒀다.** 그래서 등록은 실제로 됐는데
        (실측: 발벨3인 2건이 13:05:56/57 에 들어와 있었고 중복도 없었다) 화면은 등록
        직전과 똑같았다. 사용자가 볼 수 있는 것이 하나도 안 바뀌면 **성공과 아무 일도
        일어나지 않음이 구별되지 않고**, 그 상태에서 할 수 있는 일은 다시 누르는 것뿐이라
        중복 등록으로 이어진다.

        ★ 닫는 것만으로는 부족하다. 창이 사라지는 것은 "취소됐다"로도 읽힌다.
          **몇 건이 언제로 잡혔는지**까지 말해야 확인이 끝난다.
      */
      setRunWizard((state) => ({ ...state, open: false }));

      const partyName =
        parties.find((party) => party.partyId === first.partyId)?.name ?? "파티";
      /* 묶음은 시작 시각 하나로 연달아 잡히므로 **첫 건의 시각**이 곧 약속 시각이다. */
      const startsAt = created[0]?.scheduledAt ?? null;
      toaster.notify({
        tone: "success",
        title: `일정 ${String(created.length)}건 등록했습니다`,
        description:
          startsAt === null
            ? `${partyName} · 시각 미정 (겹쳐보기로 조율)`
            : `${partyName} · ${formatKst(startsAt, "M/d")} ${kstWeekdayKo(startsAt)} ${formatKst(startsAt, "HH:mm")} 시작`,
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
      /*
        ★ 시간표는 **내가 `going` 인 런만** 그린다. 참가/불참 전환은 그 목록에
          들어가고 나가는 일 자체라, 여기서 날리지 않으면 불참으로 바꿔도 시간표에
          그대로 남는다.
      */
      queryKeys.db.runs.timetable(weekKey),
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
   *    · `runs.list(partyId, weekKey)` + `runs.timetable(weekKey)`
   *      + **주차가 바뀌었으면 이전 주차도**
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
        // 시각이 옮겨지면 시간표의 블록 위치가 바뀐다. 주차 이동이면 두 주차 모두.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.runs.timetable(key),
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

  /**
   * 묶음 삭제 — 연속한 일정 전체 (2026-08-20 발주자: *"이거 한번에 삭제하는것좀"*).
   *
   * ★ 결과를 **뭉뚱그리지 않는다.** 서버가 삭제와 취소를 따로 세어 주므로 그대로 옮긴다.
   *   낱개 삭제가 이미 그 규칙을 지키고 있고, 묶음이라고 달라질 이유가 없다.
   * ★ 주차를 걸친 묶음(수 23:40 ~ 목 00:20)이 있을 수 있어 **건드린 주차를 전부**
   *   무효화한다. 서버가 그 목록을 준다.
   */
  const removeRunGroup = useMutation({
    mutationFn: (runIds: readonly RunId[]) => removePartyRuns(runIds),
    onSuccess: (result) => {
      invalidateRunChange(result.partyId, result.weekKeys);
      setEditingRunId(null);

      const { deletedCount, cancelledCount } = result;
      const total = deletedCount + cancelledCount;
      setRemovalNotice(
        cancelledCount === 0
          ? `일정 ${String(total)}건을 삭제했습니다. 빠진 번호는 그대로 비워 둡니다.`
          : deletedCount === 0
            ? `${String(total)}건 모두 클리어 기록이 있어 삭제하지 않고 취소했습니다. 수익 기록은 그대로입니다.`
            : `${String(total)}건 중 ${String(deletedCount)}건을 삭제하고, ${String(cancelledCount)}건은 클리어 기록이 있어 취소했습니다. 취소된 일정의 수익 기록은 그대로입니다.`,
      );
    },
  });

  /** 수정 패널을 여닫을 때는 직전 결과 문구를 치운다 — 이미 지난 사건이다. */
  const handleEditingRunIdChange = useCallback(
    (runId: RunId | null) => {
      setEditingRunId(runId);
      setRemovalNotice(null);
      editRun.reset();
    },
    [editRun],
  );

  const saveParty = useMutation({
    mutationFn: (input: CreatePartyInput) => createParty(input),
    onSuccess: (created) => {
      /*
        `party.root()` 하나로 목록·보스 목록을 함께 날린다 — 보스를 함께 등록했으므로
        `party.bosses(...)` 도 새로 받아야 한다(키가 같은 접두사 아래 있는 이유다).
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      // 닉네임만으로 넣은 게스트가 후보 목록에도 새로 들어온다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.people.root(),
      });
      // 대시보드의 "내 파티" 카드에도 새 파티가 한 줄 늘어난다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      setSelectedPartyId(created.partyId);
      setSelectedWindow(null);
      // 새 파티의 보스가 기본값(전부 체크)이 되도록 초안을 비운다.
      setDraftBossIds(null);
      setEditor((state) => ({ ...state, open: false }));
      /*
        ★ 마법사는 **닫지 않는다.** 만들기가 끝나면 4단계(분배)가 남아 있고, 그 단계는
          방금 만들어진 파티의 참가자 행이 있어야 열 수 있다. id 를 넘겨 주면 창이
          스스로 마지막 단계로 넘어간다.
      */
      setWizard((state) => ({ ...state, createdPartyId: created.partyId }));

      /*
        ★ 마법사는 **여전히 안 닫는다**(위 주석). 대신 만들어졌다는 사실은 여기서
          말한다 — 4단계(분배)는 **선택 조정**이라 파티는 이미 완성이고, 그 사실을
          창 안의 단계 이동만으로 전달하면 "아직 저장 안 된 건가" 로 읽힌다.
          편집기 쪽 만들기 경로는 창이 닫히므로 이 알림이 유일한 확인 수단이다.
      */
      toaster.notify({
        tone: "success",
        title: "파티를 만들었습니다",
        description: `${created.name} · 분배는 그대로 둬도 균등입니다.`,
      });
    },
  });

  /**
   * 파티 해체(터트리기). **만든 사람만** — 판정은 서버가 한다.
   *
   * ★ 서버는 행을 지우지 않고 `archived_at` 을 채운다. 그래도 화면에서는 삭제와 같다 —
   *   파티를 읽는 모든 조회가 `archived_at is null` 을 걸기 때문이다. 이유는
   *   `schedule-repo.archiveParty()` 머리말(드랍 수익이 cascade 로 함께 죽는다).
   * ★ **선택을 먼저 비운다.** 해체한 파티가 선택된 채로 남으면 겹쳐보기·일정 목록이
   *   방금 사라진 파티의 키로 계속 조회한다. 목록이 새로 도착하면 첫 파티가 잡힌다.
   */
  const disbandParty = useMutation({
    mutationFn: (partyId: PartyId) => archiveParty(partyId),
    onSuccess: () => {
      setSelectedPartyId(null);
      setSelectedWindow(null);
      setDraftBossIds(null);
      setEditingRunId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      // 대시보드의 "내 파티" 카드에서도 한 줄 사라진다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
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
    mutationFn: async (input: UpdatePartyRosterInput & SetPartyBossesInput) => {
      const members = await updatePartyRoster({
        partyId: input.partyId,
        memberPersonIds: input.memberPersonIds,
        guestNames: input.guestNames,
        /*
          ★ **이름도 함께 넘긴다.** 이 함수가 필드를 하나씩 골라 다시 조립하는 탓에,
            호출부에서 `name` 을 넘겨도 여기서 조용히 떨어졌다 — 파티명 수정이 안 되던
            마지막 원인이다(발주 지적 3회).
          ⚠️ 이런 "필드를 골라 옮기는" 조립은 필드가 늘 때마다 같은 사고를 낸다.
             `input` 이 이미 `UpdatePartyRosterInput` 를 만족하므로 골라 담을 이유가 없다.
        */
        name: input.name,
      });
      await savePartyBosses({
        partyId: input.partyId,
        bossDifficultyIds: input.bossDifficultyIds,
      });
      return members;
    },
    onSuccess: (_members, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.members(variables.partyId),
      });
      /*
        새로 만든 게스트는 **후보 목록에도 들어온다**(`fetchPeoplePool` 이 같은 파티
        구성원을 후보로 친다). 여기서 날리지 않으면 창을 다시 열었을 때 방금 넣은
        사람이 격자에 없어 체크를 풀 방법이 없다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.people.root(),
      });
      /*
        로스터가 바뀌면 겹쳐보기 대상 인원이 바뀐다. 조회 키에 사람 목록이 들어 있어
        대개는 새 키로 알아서 조회되지만, 사람이 **빠진** 경우 예전 키의 답이 캐시에
        남아 다시 그 조합으로 돌아왔을 때 옛 답을 보여 준다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.availability.root(),
      });
      /* 참가자 이름·번호가 런 목록에도 실려 나간다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.root(),
      });
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
    },
    // `parties` 를 보던 유일한 자리(인원수 자동 채움)가 사라져 의존성도 함께 빠진다.
    [],
  );

  /**
   * 겹침을 골랐다.
   *
   * ★ `startsAt` 은 **드래그로 고른 시각**이다(격자에서 막대를 좌우로 끌면 온다).
   *   없으면 예전 그대로 겹침의 시작 시각이다 — 클릭 동작은 바뀌지 않았다.
   */
  const handleSelectWindow = useCallback(
    (window: OverlapWindow, startsAt?: Date) => {
      setSelectedWindow(window);
      /*
        ⚠️ **이 값을 버리면 드래그가 죽는다.** 격자에서 막대를 좌우로 끌면 겹침 구간
           안의 특정 시각이 오는데, 그걸 흘리면 모달은 언제나 겹침의 **시작**으로만
           열린다 — 22시~02시 겹침에서 23시를 골라도 22시가 채워진다.
           등록 폼이 모달로 옮겨가면서 이 값을 한 번 잃을 뻔했다(2026-08-25).
      */
      setSelectedStartsAt(startsAt ?? null);
    },
    [],
  );

  /** 일정 등록 모달. `seq` 로 다시 마운트해 초안이 실제로 초기화되게 한다. */
  const [runWizard, setRunWizard] = useState<{
    readonly open: boolean;
    readonly seq: number;
  }>({ open: false, seq: 0 });

  const openEditor = useCallback((mode: PartyEditorMode) => {
    // seq 를 올려 다이얼로그를 다시 마운트한다 — "취소"가 실제로 취소되게 (§ 상태 초기화).
    setEditor((state) => ({ open: true, mode, seq: state.seq + 1 }));
  }, []);

  const retryAvailability = useCallback(() => {
    void boardQuery.refetch();
  }, [boardQuery]);

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
        value: row.isoWeekday,
        label: row.weekdayLabel,
        isWeekend: row.isWeekend,
      });
      if (columns.length === 7) break;
    }
    return columns;
  }, [dayRows]);

  const myPatterns = myPatternsQuery.data ?? EMPTY_PATTERNS;

  /*
    ★ 재시도가 **한 번**이다. 예전에는 네 쿼리를 각각 `refetch()` 해야 했고, 그중 하나만
      빠뜨리면 화면 일부가 낡은 채 남았다 — 이제 그 자리가 구조적으로 없다.
  */
  const retryAvailabilityAll = retryAvailability;

  /*
    ★ **점유(`commitments`)가 로딩·에러 판정을 따로 갖지 않는 이유가 바뀌었다.**
      예전에는 조회가 따로 있어서 "그것만 실패"가 가능했고, 그 하나로 겹쳐보기 전체를
      에러로 덮지 않으려고 판정에서 뺐다. 지금은 한 응답에 함께 오며, 마이그레이션
      미적용은 서버가 **빈 배열**로 답하므로(오류가 아니다) 같은 성질이 유지된다 —
      기능 하나가 빠져도 화면은 예전 그대로의 겹쳐보기다.
  */
  const availabilityLoading = boardQuery.isLoading;
  const availabilityError = boardQuery.isError;

  const board = boardQuery.data;

  /**
   * 겹침 분모에서 빠진 사람의 표시 이름 — **서버가 누구를 뺐는지 알려 준다**
   * (`AvailabilityBoard.unscheduledPersonIds`, 2026-08-19 발주자).
   *
   * 판정을 화면에서 다시 하지 않는 이유: 뺄지 말지를 정하는 것은 겹침을 계산한 쪽이고,
   * 여기서 또 판정하면 "화면은 뺐다고 하는데 겹침은 넣고 센" 상태가 생길 수 있다.
   */
  const unscheduledNames = useMemo(() => {
    const excluded = new Set(board?.unscheduledPersonIds ?? []);
    if (excluded.size === 0) return [];
    return members
      .filter((member) => excluded.has(member.personId))
      .map((member) => participantLabel(member));
  }, [board, members]);

  return (
    <div className="flex flex-col gap-4">
      {/*
        ── 파티 줄 — **화면마다 모양이 다르다** ─────────────────────────────
        발주 지시(2026-08-25): *"일정짜기에 드롭다운으로 선택하도록? 그 드롭다운
        오른쪽에 파티원 설명해주면 되고. 저 설명은 필요없을거같은데."*

        일정 화면에서 파티에 대해 하는 일은 **고르는 것 하나**뿐이라 한 줄이면 된다.
        예전에는 여기 `PartyBar` 가 통째로 있어서 칩 줄 · 구성원 줄 · 캐릭터 선택 ·
        안내 두 문단 · 해체 버튼이 화면 위쪽 절반을 먹었다.
        파티 관리 화면은 그 전부가 본업이므로 `PartyBar` 를 그대로 쓴다.
      */}
      {mode === "schedule" ? (
        <PartySelectBar
          parties={parties}
          selectedPartyId={selectedPartyId}
          onSelectParty={handleSelectParty}
          isPartiesLoading={partiesQuery.isLoading}
          isPartiesError={partiesQuery.isError}
          onPartiesRetry={() => void partiesQuery.refetch()}
        />
      ) : (
        <PartyBar
          parties={parties}
          selectedPartyId={selectedPartyId}
          onSelectParty={handleSelectParty}
          /*
            이 가지는 파티 관리 화면에서만 그려지므로 두 버튼은 언제나 있다.
            (props 가 `null` 을 받을 수 있는 것은 다른 호출부를 위한 여지다.)
          */
          onCreateParty={() =>
            setWizard((state) => ({
              open: true,
              seq: state.seq + 1,
              createdPartyId: null,
            }))
          }
          onEditRoster={() => openEditor("edit")}
          onDisbandParty={() => {
            if (selectedPartyId !== null) disbandParty.mutate(selectedPartyId);
          }}
          isDisbanding={disbandParty.isPending}
          disbandErrorMessage={
            disbandParty.error === null
              ? null
              : (disbandParty.error.message ??
                "파티를 해체하지 못했습니다. 잠시 후 다시 시도해 주세요.")
          }
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
      )}

      {/*
        ── 여기부터는 **일정 관리 화면의 몸통**이다 ──────────────────────────
        파티 관리 화면에서는 그리지 않는다. 겹쳐보기·등록·등록된 일정은 전부
        "언제 갈지"에 대한 것이고, 파티 관리가 답하는 질문은 "누구와 무엇을"이다.
        한 화면에 둘 다 있던 것이 발주자가 지적한 헷갈림의 원인이다(2026-08-25).
      */}
      {mode === "schedule" ? (
        <>
        {/*
          ★ ═══════════════════════════════════════════════════════════════════
            겹쳐보기가 **페이지 하나를 통째로** 쓴다
            ═══════════════════════════════════════════════════════════════════
            발주 지시(2026-08-25): *"페이지 하나 전체를 저 일정짜기로 변경하고 보스
            일정등록은 모달로 띄우도록 해."*

            예전에는 왼쪽 겹쳐보기 / 오른쪽 등록 폼의 2단이었다. 등록 폼이 24~28rem 을
            가져가는 바람에 정작 이 화면의 존재 이유인 **겹침 격자**가 좁아졌고, 등록 폼도
            그 폭에 눌려 보스 목록·참가자·캐릭터가 세로로 길게 늘어졌다. 둘 다 손해였다.

            이제 격자가 전체 폭을 쓰고, 등록은 **모달**이 맡는다. 모달은 폭 제약이 없어
            단계별로 필요한 것만 크게 보여 줄 수 있다(`RunWizardDialog`).
        */}
        <AvailabilityPanel
          range={range}
          unscheduledNames={unscheduledNames}
          weekOffset={weekOffset}
          onWeekOffsetChange={setWeekOffset}
          members={members}
          intervals={board?.intervals ?? EMPTY_INTERVALS}
          overlapWindows={board?.overlap ?? EMPTY_OVERLAP}
          exceptions={board?.exceptions ?? EMPTY_EXCEPTIONS}
          commitments={board?.commitments ?? EMPTY_COMMITMENTS}
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
          selectedStartsAt={selectedStartsAt ?? selectedWindow?.startsAt ?? null}
          /*
            겹침을 클릭하면 **바로 등록 모달**이 열린다(발주 지시 2026-08-25).
            `handleSelectWindow` 와 갈라 둔 이유는 그쪽이 드래그 중에도 계속 불리기
            때문이다 — 거기서 열면 막대를 끄는 내내 창이 떴다 닫힌다.
          */
          onOpenComposer={() =>
            setRunWizard((state) => ({ open: true, seq: state.seq + 1 }))
          }
          partyName={selectedParty?.name ?? null}
        />

        {/*
          등록 버튼 — 격자와 등록된 일정 **사이**에 둔다. 겹침을 보고 시간을 정한 직후가
          누르는 순간이고, 누르고 나면 그 결과가 바로 아래 목록에 나타난다.
          ★ 겹침 막대를 골랐으면 그 시각이 모달에 미리 채워진다. 안 골라도 열린다 —
            "먼저 막대를 고르세요"는 이미 시간을 아는 사람에게는 방해다.
        */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={selectedPartyId === null}
            onClick={() =>
              setRunWizard((state) => ({ open: true, seq: state.seq + 1 }))
            }
          >
            <CalendarPlus aria-hidden size={16} />
            보스 일정 등록
          </Button>
          <p className="text-body-sm text-ink-muted">
            {selectedPartyId === null
              ? "먼저 파티를 골라 주세요."
              : selectedWindow === null
                ? "위에서 겹치는 시간대를 누르면 시각이 미리 채워집니다."
                : "고른 시간대가 미리 채워집니다."}
          </p>
        </div>

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
          onRemoveGroup={(runIds) => removeRunGroup.mutate(runIds)}
          removingGroupIds={
            removeRunGroup.isPending ? (removeRunGroup.variables ?? null) : null
          }
          removeGroupError={removeRunGroup.error}
          removingRunId={removeRun.isPending ? removeRun.variables : null}
          removeError={removeRun.error}
          removalNotice={removalNotice}
          onDismissRemovalNotice={() => setRemovalNotice(null)}
        />
        </>
      ) : null}

      {/*
        ── 파티 관리 화면의 몸통 ────────────────────────────────────────────
        "누구와 무엇을" 만 답한다. **파티를 고르지 않았으면 아무것도 그리지 않는다** —
        빈 카드 두 개를 띄우는 것보다 파티 바의 빈 상태 안내가 할 말을 다 한다.
      */}
      {mode === "parties" && selectedPartyId !== null ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <CardTitle>묶어서 도는 보스</CardTitle>
                <CardDescription>
                  일정을 잡을 때 여기 등록된 보스가 먼저 나옵니다.
                </CardDescription>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openEditor("edit")}
              >
                <Settings2 aria-hidden size={16} />
                바꾸기
              </Button>
            </div>
            {partyBossesQuery.isError ? (
              <ErrorState
                title="보스 목록을 불러오지 못했습니다"
                onRetry={() => void partyBossesQuery.refetch()}
                className="py-6"
              />
            ) : partyBosses.length === 0 ? (
              <EmptyState
                title="등록된 보스가 없습니다"
                description="여기 등록해 두면 일정을 잡을 때 체크만 하면 됩니다. 지금 안 정해도 그때그때 고를 수 있습니다."
              />
            ) : (
              <ol className="flex flex-col gap-1">
                {partyBosses.map((entry, index) => (
                  <li
                    key={entry.bossDifficultyId}
                    className="flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2"
                  >
                    {/* 차례를 숫자로 — 등록 시 이 순서대로 연달아 배치된다(§1.4). */}
                    <span className="w-5 shrink-0 text-caption tabular-nums text-ink-muted">
                      {index + 1}
                    </span>
                    <BossIcon
                      bossDifficultyId={entry.bossDifficultyId}
                      difficulty={entry.difficulty}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                      {entry.koreanName}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {/*
            분배 배율 — 만들기 마법사의 4단계와 **같은 컴포넌트**다. 규칙을 두 벌로
            만들지 않으려는 것이고, 그래서 마법사에서 건너뛴 사람도 여기서 이어서 할 수 있다.
          */}
          <Card>
            <PartyShareSection partyId={selectedPartyId} />
          </Card>
        </div>
      ) : null}

      {/*
        ★ key 에 **이름공간**을 붙인다. 이 부모 아래 `seq` 로 다시 마운트하는 다이얼로그가
          셋인데(로스터 편집기 · 초대 링크 · 가능 시간), 카운터가 전부 0 에서 시작하므로
          이름 없이 숫자만 쓰면 형제끼리 key 가 `0` 으로 겹친다. 그러면 React 가 엉뚱한
          쪽을 재사용해 다이얼로그 상태가 서로 섞인다 — 단순 경고가 아니다.
          **다이얼로그를 하나 더 추가할 때도 반드시 고유한 접두사를 붙일 것.**
      */}
      {/*
        ── 보스 일정 등록 모달 ──────────────────────────────────────────────
        `key` 에 이름공간을 붙인다(아래 ★ 규칙). `seq` 가 오르면 다시 마운트되어
        초안(시각·보스·참여자)이 실제로 초기화된다 — 닫았다 열었을 때 지난 선택이
        남아 있으면 "취소"가 취소가 아니게 된다.
      */}
      {runWizard.open && mode === "schedule" ? (
        <RunWizardDialog
          key={`run-wizard-${runWizard.seq}`}
          open
          onClose={() => setRunWizard((state) => ({ ...state, open: false }))}
          partyId={selectedPartyId}
          partyName={selectedParty?.name ?? null}
          dayRows={dayRows}
          selectedWindow={selectedWindow}
          selectedStartsAt={selectedStartsAt}
          bosses={bosses}
          partyBosses={partyBosses}
          initialBossIds={effectiveBossIds}
          plans={plans}
          members={members}
          characters={characters}
          characterId={effectiveCharacterId}
          onCharacterIdChange={setDraftCharacterId}
          onSubmit={(input) => createRun.mutate(input)}
          isSubmitting={createRun.isPending}
          submitError={createRun.error}
        />
      ) : null}

      {/*
        ── 파티 만들기 마법사 ───────────────────────────────────────────────
        편집(`PartyEditorDialog`)과 **다른 창**이다. 만들기는 순서를 강제하는 4단계이고
        편집은 한 부분만 고치는 일이라, 한 창에 넣으면 이름 한 글자 고치려고 네 단계를
        지나야 한다.
      */}
      {wizard.open ? (
        <PartyWizardDialog
          key={`party-wizard-${wizard.seq}`}
          open
          onClose={() =>
            setWizard((state) => ({ ...state, open: false, createdPartyId: null }))
          }
          viewerPersonId={viewerPersonId}
          people={peopleQuery.data ?? EMPTY_PEOPLE}
          isPeopleLoading={peopleQuery.isPending}
          isPeopleError={peopleQuery.isError}
          onPeopleRetry={() => void peopleQuery.refetch()}
          bosses={bosses}
          onSubmit={(input) => saveParty.mutate(input)}
          isSubmitting={saveParty.isPending}
          submitError={saveParty.error}
          createdPartyId={wizard.createdPartyId}
        />
      ) : null}

      <PartyEditorDialog
        key={`party-editor-${editor.seq}`}
        open={editor.open}
        onClose={() => setEditor((state) => ({ ...state, open: false }))}
        mode={editor.mode}
        /* 분배 배율 섹션이 이 값으로 조회한다. 만들기 모드에는 아직 파티가 없다. */
        partyId={editor.mode === "edit" ? selectedPartyId : null}
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
        isPeopleLoading={peopleQuery.isPending}
        isPeopleError={peopleQuery.isError}
        onPeopleRetry={() => void peopleQuery.refetch()}
        bosses={bosses}
        onSubmit={({
          name,
          memberPersonIds,
          guestNames,
          bossDifficultyIds,
        }) => {
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
              /*
                ★ **이름을 함께 보낸다**(2026-08-20). 이 줄이 없어서 편집 화면이 이름
                  칸을 보여 주고 값을 받아 놓고도 저장이 안 됐다 — 만들 때는 되고 고칠
                  때는 안 되는 상태였다(발주 지적: *"파티명 수정이 안돼"*).
                ★ 빈 문자열은 **자동 제목으로 되돌리기**이지 "안 바꿈"이 아니다. 다이얼로그가
                  자동 제목인 파티의 칸을 비워 두므로(그 자체가 설계다), 비운 채 저장하면
                  자동 제목이 유지되는 것이 맞다.
              */
              name,
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
