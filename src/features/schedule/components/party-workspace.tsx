"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { BossIcon } from "@/components/domain";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
  useToaster,
} from "@/components/ui";

import { GuestInviteDialog } from "@/features/invites/components";
import { getTrackedBossCatalog } from "@/lib/boss-master";
import { cachePatch, useOptimisticMutation } from "@/lib/query/optimistic";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import type {
  CreatePartyInput,
  Party,
  PartyBoss,
  PartyId,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
  SetPartyBossesInput,
  UpdatePartyCharacterInput,
  UpdatePartyRosterInput,
} from "@/types/domain";

import {
  archiveParty,
  copyParty,
  createParty,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
  fetchPeoplePool,
  savePartyBosses,
  updateMyPartyCharacter,
  updatePartyRoster,
} from "../data";
import { PartyBar } from "./party-bar";
import { PartyEditorDialog, type PartyEditorMode } from "./party-editor-dialog";
import { PartyShareSection } from "./party-share-section";
import { PartyWizardDialog } from "./party-wizard-dialog";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 관리 (`/parties`) — **"누구와 무엇을"** 만 답한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `ScheduleWorkspace` 가 아니라 `PartyWorkspace` 인가 (2026-09-28)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 컴포넌트는 `mode: "schedule" | "parties"` 로 **두 화면을 겸하고** 있었다. 근거는
 * "데이터와 뮤테이션 배선이 같으니 쪼개면 두 벌이 된다" 였고, 그 근거는 두 화면이
 * 실제로 같은 것(파티·구성원·보스·가용시간·런)을 읽던 동안에만 성립했다.
 *
 * 발주 지시(2026-09-28)로 **`일정 계획` 화면이 없어지고 가용시간이 통째로 빠졌다.**
 * 남은 `parties` 갈래가 읽는 것은 파티 · 구성원 · 파티 보스 · 후보 · 내 캐릭터 다섯뿐이고,
 * 런·가용시간·보스 계획·겹침은 한 줄도 쓰지 않는다. 즉 **겸할 상대가 사라졌다** —
 * `mode` prop 은 언제나 `"parties"` 이고, 죽은 갈래를 들고 있는 편이 오히려 비싸다.
 *
 * 그래서 이름도 바꿨다. `ScheduleWorkspace` 라는 이름이 남아 있으면 "여기서 일정을
 * 잡는다"로 읽히는데, 일정을 잡는 곳은 이제 **주간 일정표(`/`)의 빈 칸**이다
 * (`week-timetable.tsx` · `timetable-run-dialog.tsx`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터는 전부 쿼리 캐시 소유다 (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버(`app/parties/page.tsx`)가 같은 repo 를 불러 **요청 범위 QueryClient 에 심고**
 * `dehydrate` 하며, 이 컴포넌트는 평범한 `useQuery` 만 쓴다. 하이드레이션이 서버 렌더
 * 시점에 일어나므로 첫 페인트는 이미 채워진 상태다.
 */

export interface PartyWorkspaceProps {
  /**
   * 열람자 본인(`app_users.id`). **비로그인은 null** 이고 그때는 캐릭터 조회를 아예
   * 켜지 않는다 — `/api/schedule/characters` 는 세션이 없으면 401 이라, 켜 두면
   * 비로그인 화면에 없어야 할 에러 UI 가 뜬다(공개 파티 열람은 200 이어야 한다).
   *
   * ★ 이것은 **데이터가 아니라 열람자 신원**이라 props 로 남는다. 뮤테이션이 바꿀 수 있는
   *   값이 아니고(로그인/로그아웃은 서버 렌더가 갈린다), 여러 쿼리의 `enabled` 를 가른다.
   */
  readonly viewerPersonId: PersonId | null;
}

/**
 * 빈 목록 상수들. 매 렌더 새 배열을 만들면 아래 `useMemo` 들이 전부 무효화된다.
 */
const EMPTY_PARTIES: readonly Party[] = [];
const EMPTY_MEMBERS: readonly PartyMember[] = [];
const EMPTY_PARTY_BOSSES: readonly PartyBoss[] = [];
const EMPTY_PEOPLE: readonly Person[] = [];
const EMPTY_RUN_CHARACTERS: readonly RunCharacterOption[] = [];

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 2단 저장의 **둘째 단계**는 실패해도 전체를 실패로 만들지 않는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발견(2026-10-11 교차 검증, 라이브 100% 재현): `saveParty` 와 `saveRoster` 는 둘 다
 * 서버 호출을 **두 번** 한다. 첫째가 커밋된 뒤 둘째가 던지면 `onSuccess` 가 아예 돌지
 * 않아 **무효화가 하나도** 일어나지 않았고, 창은 *"파티를 만들지 못했습니다"* 를 띄웠다.
 * 그런데 파티는 만들어져 있었다 — 목록 캐시에도 없어 화면에 안 보이니 사용자는 다시
 * 누르고, **같은 이름 파티가 둘** 생겼다.
 * (가정이 아니다: 마이그레이션 미적용 상태에서 `durationMinutes` 를 실으면 서버가
 *  **항상** 400 을 던지므로, 소요 시간을 넣어 만드는 모든 시도가 이 경로였다.)
 *
 * ★ 그래서 둘째 단계를 `try/catch` 로 감싸 **경고로 격하**한다. 뮤테이션은 성공으로
 *   끝나고 → 무효화가 돌고(만들어진 파티가 **보인다**) → 창은 다음 단계로 넘어가
 *   **다시 누를 길이 닫힌다.** 사용자에게는 **무엇이 저장되고 무엇이 안 됐는지**를
 *   따로 말한다. "반쯤 저장된 일을 실패로 보고하지 않는다"가 규칙이다.
 * ★ **첫째 단계가 던지면 그대로 던진다.** 그때는 아무것도 저장되지 않았으므로 "실패"가
 *   정확한 보고이고, 다시 누르는 것이 맞는 행동이다.
 */
function warningOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "알 수 없는 이유로 저장하지 못했습니다.";
}

export function PartyWorkspace({ viewerPersonId }: PartyWorkspaceProps) {
  const queryClient = useQueryClient();
  /*
    저장 결과를 말하는 자리. 모달은 저장에 성공하면 **닫히므로**, 성공 문구를 창 안에
    그리면 아무도 못 본다(§ `toast.tsx` 머리말이 같은 이유로 이 컴포넌트를 만들었다).
  */
  const toaster = useToaster();

  /*
   * ── 파티 ──────────────────────────────────────────────────────────────────
   * 다른 어떤 상태보다 먼저 선언한다. 아래 `useState` 초기값이 **첫 파티**를 보고
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

  const [editor, setEditor] = useState<{
    readonly open: boolean;
    readonly mode: PartyEditorMode;
    readonly seq: number;
  }>({ open: false, mode: "create", seq: 0 });

  /**
   * 파티 **만들기 마법사**. 편집(`editor`)과 분리해 둔다 — 만들기는 순서를 강제하는
   * 4단계 흐름이고, 편집은 이미 있는 파티의 한 부분만 고치는 일이라 순서가 없다.
   * `createdPartyId` 는 저장이 끝났다는 신호이자 4단계(분배)가 조회할 대상이다.
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
   * 티어: db. **prefetch 대상이 아니다** — 창을 열어야만 켜지므로 페이지 진입 때
   * 미리 읽으면 화면에 쓰이지 않는 DB 조회가 된다.
   *
   * ⚠️ **두 창이 이 결과를 함께 쓴다** — 파티 편집기(`editor`)와 만들기 마법사
   *    (`wizard`). 게이트가 `editor.open` 하나였던 동안 마법사만 열면 조회가 아예
   *    뜨지 않았고, 화면이 로딩도 에러도 아닌 **"후보 목록이 비어 있습니다"** 로
   *    곧장 떨어졌다(발주 지적 2026-08-28: *"후보에 친구 아무도 안뜸"*).
   *    **소비자를 추가할 때는 게이트도 함께 넓혀야 한다.**
   */
  const peopleQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.people.pool()),
    queryFn: fetchPeoplePool,
    enabled: editor.open || wizard.open,
  });

  const members = useMemo(
    () =>
      [...(membersQuery.data ?? EMPTY_MEMBERS)].sort(
        (a, b) => a.seatNo - b.seatNo,
      ),
    [membersQuery.data],
  );

  // ── 내 캐릭터 (파티에 데려갈 대상) ────────────────────────────────────────
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

  /*
    보스 카탈로그는 **쿼리가 아니다.** 게임 패치 때만 바뀌는 값이라 코드 상수로
    내려왔다(`@/lib/boss-master`, 발주자 지시 2026-08-18).
  */
  const bosses = getTrackedBossCatalog();

  /**
   * 새 파티 — **보스별 소요 시간은 두 번째 호출**이다.
   *
   * ⚠️ `createParty`(= `POST /api/schedule/parties`)에는 소요 시간을 실을 자리가 없다.
   *    `CreatePartyInput` 이 보스 **목록만** 받고, 그 계약을 넓히는 일은 이 작업의 범위가
   *    아니다(서버·타입은 이미 끝난 다른 작업의 산출물이다). 그래서 만들기 경로는
   *    `set_party_boss_durations` 를 소유한 `savePartyBosses` 를 **이어서** 부른다.
   *
   * ★ **아무것도 정하지 않았으면 부르지 않는다.** 전부 `null` 인 배열을 저장하는 것은
   *   방금 만들어진 상태와 똑같아서 왕복만 늘어난다.
   * ★ 보스 목록·순서는 **같은 값을 그대로** 다시 보낸다. `savePartyBosses` 는 전체 교체라
   *   목록을 빼놓으면 보스가 지워지고, 순서가 제목(`익세 하대 하카 2인`)을 만든다.
   * ⚠️ 두 번째 호출이 실패하면 **파티는 남고 시간만 안 저장된다.** 그래도 성공 토스트를
   *    띄우지 않도록 `await` 로 묶어 둔다 — 실패를 성공으로 보고하지 않는 쪽이 낫고,
   *    사용자는 파티 편집에서 시간을 다시 넣을 수 있다.
   */
  const saveParty = useMutation({
    mutationFn: async (
      input: CreatePartyInput & {
        readonly bossDurationMinutes?: readonly (number | null)[];
      },
    ) => {
      const { bossDurationMinutes, ...createInput } = input;
      const created = await createParty(createInput);
      const hasDuration =
        bossDurationMinutes !== undefined &&
        bossDurationMinutes.some((minutes) => minutes !== null);
      if (!hasDuration) return { party: created, durationWarning: null };

      /*
        ⚠️ **파티는 이미 만들어졌다.** 여기서 던지면 반쯤 저장된 일을 "실패"로 보고하게
           되고, 사용자가 다시 눌러 같은 이름 파티가 둘 생긴다(위 머리말).
      */
      try {
        await savePartyBosses({
          partyId: created.partyId,
          bossDifficultyIds: createInput.bossDifficultyIds ?? [],
          durationMinutes: bossDurationMinutes,
        });
        return { party: created, durationWarning: null };
      } catch (error) {
        return { party: created, durationWarning: warningOf(error) };
      }
    },
    onSuccess: ({ party: created, durationWarning }) => {
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
      // `/etc` 의 "내 파티" 카드에도 새 파티가 한 줄 늘어난다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      setSelectedPartyId(created.partyId);
      setEditor((state) => ({ ...state, open: false }));
      /*
        ★ 마법사는 **닫지 않는다.** 만들기가 끝나면 4단계(분배)가 남아 있고, 그 단계는
          방금 만들어진 파티의 참가자 행이 있어야 열 수 있다. id 를 넘겨 주면 창이
          스스로 마지막 단계로 넘어간다.
        ★ 그래도 만들어졌다는 사실은 여기서 말한다 — 4단계는 **선택 조정**이라 파티는
          이미 완성이고, 창 안의 단계 이동만으로 전달하면 "아직 저장 안 된 건가" 로 읽힌다.
      */
      setWizard((state) => ({ ...state, createdPartyId: created.partyId }));
      /*
        ★ **무엇이 저장되고 무엇이 안 됐는지**를 가려 말한다. 파티는 만들어졌다는 사실이
          먼저이고(다시 누르면 중복이 생긴다), 소요 시간만 빠졌다는 것이 그다음이다.
          톤은 주의(`warning`)다 — 실패가 아니고, 파티 관리에서 이어서 넣을 수 있다.
      */
      if (durationWarning === null) {
        toaster.notify({
          tone: "success",
          title: "파티를 만들었습니다",
          description: `${created.name} · 분배는 그대로 둬도 균등입니다.`,
        });
      } else {
        toaster.notify({
          tone: "warning",
          title: "파티는 만들었지만 보스 소요 시간은 저장되지 않았습니다",
          description: `${created.name} 은(는) 만들어졌습니다. 다시 만들지 마세요 — 소요 시간만 파티 편집에서 다시 넣어 주세요. (${durationWarning})`,
        });
      }
    },
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 파티 복사 → **바로 편집 창**
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 발주 지시(2026-10-16): *"기존 파티의 구성원·분배·보스·정원을 복사한 새 파티를 만들고,
   * 바로 편집 창을 열어 보스와 캐릭터만 고치게 한다."*
   *
   * ★ **창을 여는 것이 이 흐름의 절반이다.** 복사만 하고 끝나면 사용자는 목록에서
   *   `… (복사)` 를 다시 찾아 누르고 `파티 편집` 을 또 눌러야 한다 — 복사가 줄여 준
   *   수고를 그 두 번이 그대로 되돌린다.
   * ★ 순서가 중요하다: **선택을 먼저 옮긴 뒤** 창을 연다. 편집 창은
   *   `selectedPartyId` · `members` · `partyBosses` 를 부모에서 받으므로, 선택을 옮기지
   *   않고 열면 **원본 파티를 편집하는 창**이 뜬다. 그 상태로 저장하면 복사한 의미가
   *   사라지는 것을 넘어 원본이 망가진다.
   * ★ 보스 목록·구성원이 아직 안 온 채로 창이 열릴 수 있다(무효화 직후). 그건 정상이다 —
   *   편집 창은 `isPeopleLoading` · 빈 배열을 이미 다루고, 재조회가 도착하면 채워진다.
   *   ⚠️ 다만 `key` 가 `editor.seq` 라 **도착 시점에 다시 마운트되지 않는다.** 그래서
   *      `openEditor` 를 무효화 **직후** 부르지 않고, 선택을 옮긴 뒤 같은 틱에 부른다.
   *      초기값은 마운트 때 한 번 읽히므로, 보스 목록이 비어 보이면 사용자가 창을 닫고
   *      다시 열면 된다 — 저장이 그 빈 목록을 쓰지는 않는다(사용자가 고른 값만 간다).
   *
   * ⚠️ **무효화 목록 — `party.root()` 하나로 충분한지 직접 셌다**(§2.4 Rule 5).
   *    · `db.party.root()` = `["db","party"]` 는 `list()` · `mine(weekKey)` · `detail` ·
   *      `members` · `bosses` · `shares` 를 **전부** 접두사로 덮는다(키 팩토리 확인).
   *      복사가 바꾸는 것은 그 여섯 중 목록 하나지만, 새 파티의 `members`/`bosses` 가
   *      아직 캐시에 없으므로 더 날려도 비용이 없다.
   *    · `db.runs.*` 는 **날리지 않는다.** 복사는 런을 하나도 만들지 않으므로
   *      `runs.timetable(weekKey)` 가 가리키는 답이 바뀌지 않는다. 그 키가 `runs.list`
   *      의 형제라 접두사로 안 따라온다는 함정은 **런을 만드는 뮤테이션**의 것이고
   *      (`timetable-run-dialog`), 여기서는 날릴 이유 자체가 없다.
   *      ⚠️ 이 판단은 "런을 복사하지 않는다"에 **달려 있다.** 다음 단계에서 복사가
   *         일정까지 가져오게 되면 `runs.timetable(weekKey)` 와 `runs.list(partyId,
   *         weekKey)` 를 **여기에 반드시 더해야 한다.**
   *    · `db.people.root()` 도 **날리지 않는다.** 게스트를 새로 만들지 않고 원본의
   *      `guest_id` 를 그대로 가리키므로(`copyParty`), 후보 목록(`fetchPeoplePool`)의
   *      답이 바뀌지 않는다. 만들기(`saveParty`)가 이 키를 날리는 것은 **그쪽이 닉네임
   *      으로 새 게스트를 만들기 때문**이고, 복사에는 그 입력이 없다.
   *    · `db.dashboard.root()` 는 **날린다.** `/etc` 의 "내 파티" 카드가 한 줄 늘어난다.
   */
  const copyPartyMutation = useMutation({
    mutationFn: (partyId: PartyId) => copyParty(partyId),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      setSelectedPartyId(created.partyId);
      openEditor("edit");
      toaster.notify({
        tone: "success",
        title: "파티를 복사했습니다",
        description: `${created.name} — 구성원·분배·보스·정원이 그대로 왔습니다. 일정·클리어·수익은 오지 않습니다. 이제 보스와 내 캐릭터만 고치세요.`,
      });
    },
  });

  /**
   * 파티 해체(터트리기). **만든 사람만** — 판정은 서버가 한다.
   *
   * ★ 서버는 행을 지우지 않고 `archived_at` 을 채운다. 그래도 화면에서는 삭제와 같다 —
   *   파티를 읽는 모든 조회가 `archived_at is null` 을 걸기 때문이다. 이유는
   *   `schedule-repo.archiveParty()` 머리말(드랍 수익이 cascade 로 함께 죽는다).
   * ★ **선택을 먼저 비운다.** 해체한 파티가 선택된 채로 남으면 구성원·보스 조회가
   *   방금 사라진 파티의 키로 계속 돈다. 목록이 새로 도착하면 첫 파티가 잡힌다.
   */
  const disbandParty = useMutation({
    mutationFn: (partyId: PartyId) => archiveParty(partyId),
    onSuccess: () => {
      setSelectedPartyId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      // `/etc` 의 "내 파티" 카드에서도 한 줄 사라진다.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      /*
        해체된 파티의 일정은 더 이상 아무 화면에도 나오지 않는다. 주간 일정표가
        `runs.*` 아래 캐시를 들고 있으므로 함께 날린다 — 빼먹으면 사라진 파티의
        블록이 60초 동안 시간표에 남는다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.root(),
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
      /*
        ⚠️ `SetPartyBossesInput.durationMinutes` 는 **선택 필드**다. 창이 보스 시간을
           건드리지 않았으면 `undefined` 로 들어오고, 그때 `savePartyBosses` 가 키를
           싣지 않아 DB 함수가 기존 값을 보존한다 — 구성원 한 명을 고칠 때마다 파티의
           보스 시간이 전부 날아가는 것을 막는 유일한 길이다.
      */
      const saved = await updatePartyRoster({
        partyId: input.partyId,
        memberPersonIds: input.memberPersonIds,
        guestNames: input.guestNames,
        /*
          ★ **이름도 함께 넘긴다.** 이 함수가 필드를 하나씩 골라 다시 조립하는 탓에,
            호출부에서 `name` 을 넘겨도 여기서 조용히 떨어졌다 — 파티명 수정이 안 되던
            마지막 원인이다(발주 지적 3회).
        */
        name: input.name,
      });
      /*
        ⚠️ **로스터는 이미 커밋됐다.** 보스 목록 저장이 던진다고 전체를 실패로 보고하면
           구성원 변경은 이미 저장된 채 무효화가 돌지 않아, 화면이 **옛 명단**을 들고
           남는다(위 머리말과 같은 사건).
      */
      try {
        await savePartyBosses({
          partyId: input.partyId,
          bossDifficultyIds: input.bossDifficultyIds,
          ...(input.durationMinutes !== undefined
            ? { durationMinutes: input.durationMinutes }
            : {}),
        });
        return { members: saved, bossWarning: null };
      } catch (error) {
        return { members: saved, bossWarning: warningOf(error) };
      }
    },
    onSuccess: ({ bossWarning }, variables) => {
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
      /* 참가자 이름·번호가 일정(런) 목록에도 실려 나간다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.root(),
      });
      /* 구성원 수가 바뀌면 `/etc` 파티 카드의 `N명` 도 바뀐다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      setEditor((state) => ({ ...state, open: false }));
      /*
        ★ 조용히 넘기지 않는다. 구성원은 저장됐고 보스 목록은 안 됐다는 **두 사실**을
          함께 말해야, 사용자가 창을 다시 열어 보스만 손볼 수 있다.
      */
      if (bossWarning !== null) {
        toaster.notify({
          tone: "warning",
          title: "구성원은 저장했지만 보스 목록은 저장되지 않았습니다",
          description: `구성원 변경은 그대로 남습니다. 보스 목록과 소요 시간만 다시 저장해 주세요. (${bossWarning})`,
        });
      }
    },
  });

  /**
   * **이 파티에 데려갈 내 캐릭터** (`party_participants.character_id`).
   *
   * ★ **낙관적**이다. 서버가 만드는 값이 하나도 없다 — 참가자 행도 캐릭터 행도 이미
   *   있고, `updateMyPartyCharacter()` 는 `party_participants.character_id` 한 컬럼만
   *   UPDATE 한다. 표시 이름(`더저(메검메)`)은 저장된 문자열이 아니라
   *   `participantLabel()` 이 읽을 때 조합하는 값이므로, 구성원 캐시의 세 칸을 고치면
   *   구성원 목록이 같은 이름으로 함께 따라온다.
   *
   *   일정(런) 목록은 낙관적으로 건드리지 않는다 — 런의 캐릭터는
   *   `run_signups.character_id` 라는 **다른 컬럼**이고 이 저장이 손대지 않는다.
   *   무효화만 예전대로 남긴다.
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
      saveMyCharacter.mutate({ partyId: selectedPartyId, characterId });
    },
    [saveMyCharacter, selectedPartyId],
  );

  const handleInviteGuest = useCallback((member: PartyMember) => {
    setInviteTarget((state) => ({ member, seq: (state?.seq ?? 0) + 1 }));
  }, []);

  const handleSelectParty = useCallback((partyId: PartyId) => {
    setSelectedPartyId(partyId);
  }, []);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️ 편집 창은 **초기값이 도착한 뒤에** 떠야 한다 — 안 그러면 저장이 파괴적이다
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `PartyEditorDialog` 는 `key={party-editor-${seq}}` 로 **마운트 때 한 번** 초기값을
   * 읽는다(`useState(initial…)`). 그래서 구성원·보스가 아직 안 온 상태로 열리면 창이
   * 들고 있는 값이 **구성원 = 나 혼자 · 보스 = 없음**이 되고, 그 상태에서 `저장` 을
   * 누르면 `updatePartyRoster` + `savePartyBosses` 가 그 값을 그대로 써서 **방금 복사한
   * 명단과 보스를 지운다.** 나중에 응답이 도착해도 창은 다시 마운트되지 않으므로
   * 스스로 회복되지도 않는다.
   *
   * 복사 흐름이 이 함정을 **반드시** 지나간다 — 새 파티의 `members` · `bosses` 는 캐시에
   * 아예 없는 새 키라 언제나 로딩부터 시작한다. 그래서 창의 **존재 자체**를 준비 여부로
   * 가둔다: 준비되기 전에는 같은 자리에 스켈레톤 창을, 조회가 실패하면 오류 창을 띄운다.
   * (칩을 바꾼 직후 `파티 편집` 을 누르는 경로에도 같은 함정이 있었고, 같이 막힌다.)
   *
   * ★ 만들기 모드는 읽을 초기값이 없으므로 **언제나 준비됨**이다.
   */
  const editorNeedsData = editor.open && editor.mode === "edit";
  const editorDataReady =
    editor.mode === "create" ||
    (selectedPartyId !== null &&
      membersQuery.isSuccess &&
      partyBossesQuery.isSuccess);
  const editorDataError =
    editorNeedsData && (membersQuery.isError || partyBossesQuery.isError);

  const openEditor = useCallback((mode: PartyEditorMode) => {
    // seq 를 올려 다이얼로그를 다시 마운트한다 — "취소"가 실제로 취소되게 (§ 상태 초기화).
    setEditor((state) => ({ open: true, mode, seq: state.seq + 1 }));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <PartyBar
        parties={parties}
        selectedPartyId={selectedPartyId}
        onSelectParty={handleSelectParty}
        onCreateParty={() =>
          setWizard((state) => ({
            open: true,
            seq: state.seq + 1,
            createdPartyId: null,
          }))
        }
        onEditRoster={() => openEditor("edit")}
        onCopyParty={() => {
          if (selectedPartyId !== null)
            copyPartyMutation.mutate(selectedPartyId);
        }}
        isCopying={copyPartyMutation.isPending}
        copyErrorMessage={
          copyPartyMutation.error === null
            ? null
            : (copyPartyMutation.error.message ??
              "파티를 복사하지 못했습니다. 잠시 후 다시 시도해 주세요.")
        }
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

      {/*
        **파티를 고르지 않았으면 아무것도 그리지 않는다** — 빈 카드 두 개를 띄우는
        것보다 위 파티 바의 빈 상태 안내가 할 말을 다 한다.
      */}
      {selectedPartyId !== null ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <CardTitle>묶어서 도는 보스</CardTitle>
                <CardDescription>
                  주간 일정표에서 이 파티를 고르면 여기 등록된 보스로 일정이
                  잡힙니다.
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
                description="여기 등록해 두면 주간 일정표에서 이 파티를 고르는 것만으로 일정이 잡힙니다. 비어 있으면 일정을 잡을 수 없습니다."
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
          셋인데 카운터가 전부 0 에서 시작하므로, 이름 없이 숫자만 쓰면 형제끼리 key 가
          `0` 으로 겹친다. 그러면 React 가 엉뚱한 쪽을 재사용해 다이얼로그 상태가 서로
          섞인다 — 단순 경고가 아니다.
          **다이얼로그를 하나 더 추가할 때도 반드시 고유한 접두사를 붙일 것.**
      */}
      {wizard.open ? (
        <PartyWizardDialog
          key={`party-wizard-${String(wizard.seq)}`}
          open
          onClose={() =>
            setWizard((state) => ({
              ...state,
              open: false,
              createdPartyId: null,
            }))
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

      {/*
        준비되기 전/실패했을 때 **같은 자리에 같은 제목으로** 다른 창을 띄운다. 창이
        아예 안 뜨면 복사 직후 "아무 일도 일어나지 않은" 것과 구별되지 않는다.
      */}
      {editorNeedsData && !editorDataReady ? (
        <Dialog
          open
          onClose={() => setEditor((state) => ({ ...state, open: false }))}
          title="파티 편집"
          description={
            editorDataError
              ? "구성원과 보스 목록을 불러오지 못했습니다."
              : "구성원과 보스 목록을 불러오는 중입니다."
          }
        >
          {editorDataError ? (
            <ErrorState
              title="불러오지 못해 편집을 열 수 없습니다"
              description="이 상태로 저장하면 구성원과 보스가 지워질 수 있어 창을 열지 않았습니다. 다시 시도해 주세요."
              onRetry={() => {
                void membersQuery.refetch();
                void partyBossesQuery.refetch();
              }}
            />
          ) : (
            <SkeletonGroup label="파티 정보를 불러오는 중">
              <div className="flex flex-col gap-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-24" />
                <Skeleton className="h-10" />
              </div>
            </SkeletonGroup>
          )}
        </Dialog>
      ) : null}

      {/*
        ⚠️ **여는 조건이 `open` 프롭이 아니라 마운트 자슴이다.**
           초기값은 **마운트 때 한 번** 읽힌다(`useState(initial…)`). 리마운트를
           일으키는 것은 `key` 의 `seq` 인데, 그 `seq` 는 **여는 시점에** 올라가므로
           `open` 만 가듬 두면 조회가 도착하기 전의 빈 초기값이 그대로 고정된다 —
           바로 그게 위 `editorDataReady` 가 말하는 튜턴한 사고다. 조건부 마운트로
           두어야 조회가 도착한 **그제서야** 처음 마운트해 제대로 읽는다.
      */}
      {editor.open && editorDataReady ? (
        <PartyEditorDialog
          key={`party-editor-${String(editor.seq)}`}
          open
          onClose={() => setEditor((state) => ({ ...state, open: false }))}
          mode={editor.mode}
          /* 분배 배율 섹션이 이 값으로 조회한다. 만들기 모드에는 아직 파티가 없다. */
          partyId={editor.mode === "edit" ? selectedPartyId : null}
          initialName={
            editor.mode === "edit" ? (selectedParty?.name ?? "") : ""
          }
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
          /*
          ★ **자리끼리 짝이다.** 위 `initialBossIds` 와 **같은 배열을 같은 순서로** 돌려
            만든다 — 두 map 을 따로 두는 것이 아니라 같은 `partyBosses` 를 두 번 돌리는
            것이라 자리가 어긋날 여지가 없다. `null` 은 "이 파티는 안 정했다"이고
            화면이 기본값 placeholder 로 그린다.
        */
          initialBossDurations={
            editor.mode === "edit"
              ? partyBosses.map((entry) => entry.durationMinutes)
              : []
          }
          /*
          ── 내가 데려갈 캐릭터 (2026-10-16) ─────────────────────────────────
          ★ **파티 띠와 같은 뮤테이션을 공유한다**(`handleChangeMyCharacter`). 입구가
            둘이 되는 것은 의도이고(복사 직후 손질은 창 안에서 끝나야 한다), 값·저장·
            롤백은 하나다 — 두 입구가 두 규칙을 갖지 않는다.
          ★ **편집 모드에서만** 넘긴다. 만들기 모드에는 참가자 행이 아직 없어 고칠
            대상이 없다(분배 배율 섹션이 같은 이유로 같은 조건을 쓴다).
          ★ 값의 출처는 `members`(= `fetchPartyMembers`)의 내 행이라 **확정값**이다 —
            목록 payload 의 추론(`resolveMyPartyOption`)이 아니다.
        */
          characters={editor.mode === "edit" ? characters : []}
          myCharacterId={
            editor.mode === "edit"
              ? (members.find((member) => member.personId === viewerPersonId)
                  ?.characterId ?? null)
              : null
          }
          onChangeMyCharacter={
            editor.mode === "edit" && selectedPartyId !== null
              ? handleChangeMyCharacter
              : null
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
            bossDurationMinutes,
          }) => {
            if (editor.mode === "create") {
              saveParty.mutate({
                name,
                memberPersonIds,
                guestNames,
                bossDifficultyIds,
                bossDurationMinutes,
              });
            } else if (selectedPartyId !== null) {
              saveRoster.mutate({
                partyId: selectedPartyId,
                memberPersonIds,
                guestNames,
                bossDifficultyIds,
                /*
                ★ **`undefined` 면 키 자체를 싣지 않는다**(위 `saveRoster` 주석).
                  창이 소요 시간을 건드렸을 때만 값이 온다.
              */
                durationMinutes: bossDurationMinutes,
                /*
                ★ 빈 문자열은 **자동 제목으로 되돌리기**이지 "안 바꿈"이 아니다.
                  다이얼로그가 자동 제목인 파티의 칸을 비워 두므로(그 자체가 설계다),
                  비운 채 저장하면 자동 제목이 유지되는 것이 맞다.
              */
                name,
              });
            }
          }}
          isSubmitting={saveParty.isPending || saveRoster.isPending}
          submitError={saveParty.error ?? saveRoster.error}
        />
      ) : null}

      {/*
        초대 링크 창 — **게스트에게만** 열린다(파티 바의 보내기 버튼).
        `seq` 로 다시 마운트해 열 때마다 새 토큰을 발급한다. 이전 발급 결과가 남아 있으면
        이미 죽은 링크를 복사하게 되기 때문이다(재발급은 이전 링크를 무효화한다).
      */}
      {inviteTarget === null ? null : (
        <GuestInviteDialog
          key={`guest-invite-${String(inviteTarget.seq)}`}
          open
          onClose={() => setInviteTarget(null)}
          member={inviteTarget.member}
        />
      )}
    </div>
  );
}
