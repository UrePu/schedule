"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  BossIcon,
  MemberFace,
  PartyOptionGrid,
  SeatNumber,
} from "@/components/domain";
import { formatKstFull } from "@/components/domain/kst-format";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Skeleton,
  useToaster,
} from "@/components/ui";
import { participantLabel } from "@/lib/domain/participant-label";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { formatKst, getWeekKey } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type {
  BossDifficultyId,
  CreateRunBundleInput,
  Party,
  PartyBoss,
  PartyId,
  PartyMember,
  PartyMemberBrief,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import {
  createPartyRunBundle,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyBosses,
  fetchPartyMembers,
} from "../data";
import { DEFAULT_DURATION_MINUTES } from "../lib/run-defaults";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 시간표 빈 칸 → **파티만 고르면 일정이 잡힌다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-28): *"일정표를 항상 띄우고 일정 계획칸을 삭제. 일정표에서 특정
 * 구간을 눌러 파티를 고르는것으로 변경. 기존에 파티를 생성할때 보스 선택하는것을 이용하여"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 없어진 두 단계가 이 창의 정의다
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 등록은 **시간 → 보스 → 참여자** 3단 마법사(`run-wizard-dialog.tsx`)였다. 셋 다
 * 여기서는 물을 필요가 없다:
 *
 *   시간   → **누른 칸이 시작 시각이다.** 창이 뜨기 전에 이미 정해져 있다.
 *   보스   → **그 파티에 등록된 보스 전체**(`party_bosses`). `/parties` 가 이미 소유한
 *            정보를 여기서 또 고르게 하면 같은 사실을 두 곳에서 정하게 된다.
 *   참여자 → **그 파티의 구성원 전원.** 파티는 "같이 보스 가는 사람들"의 정의 그 자체다.
 *
 * 그래서 남는 질문이 **"어느 파티로?"** 하나이고, 그 하나만 묻는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 파티를 누르는 즉시 저장하지 **않는** 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * "고르면 잡힌다"를 글자 그대로 구현하면 클릭 하나에 DB 쓰기가 붙는데, 이 창이 필요한
 * 정보(파티 보스·구성원)는 **파티를 고른 뒤에야** 조회된다. 그 사이에 있을 수 있는 일이
 * 둘이다.
 *
 *   ① **보스가 0개인 파티** — `/parties` 에서 보스를 아직 안 정한 파티가 실제로 있다.
 *      서버는 "등록할 보스를 하나 이상 선택해 주세요" 로 400 을 주므로, 즉시 저장 방식은
 *      누르자마자 오류를 보여 주게 된다. 무엇을 해야 하는지(=`/parties` 로 가서 보스
 *      등록)는 오류 문구가 말해 주지 못한다.
 *   ② **조회 지연** — 응답이 오기 전에는 저장할 값이 없어 창이 아무 반응 없이 멈춘다.
 *
 * 그래서 고른 뒤 **무엇이 잡히는지 한 줄로 보여 주고** 확인을 받는다. 단계가 늘어난 것이
 * 아니다 — 화면은 하나이고 되돌아갈 앞 단계도 없다. 늘어난 것은 "이대로 맞나"를 볼 기회다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티를 **얼굴로** 고른다 (발주 지시 2026-10-04)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"보스일정잡기를 예전 파티 선택처럼 얼굴도 보이는걸로 바꿔줘"*
 *
 * 이 창이 생길 때(2026-09-28) 파티 줄은 **이름 + 파티원 이름 한 줄**짜리 글자 목록이
 * 됐다. 그 전까지 쓰던 `PartyPickerDialog` 는 파티원 초상화를 격자로 띄우고 있었는데,
 * 화면이 통째로 없어지면서 그 표현도 함께 삭제됐다. 글자만 남으니 2026-09-01 에 이미
 * 한 번 고쳤던 문제가 되돌아왔다 — 실측된 파티 이름이 `발벨3인` · `세쌀카2인523`
 * 처럼 **보스 줄임말 + 인원**이라, 이름으로는 서로 구분되지 않고 파티원 이름을 한 줄로
 * 이어 붙여도 뒤쪽이 잘린다.
 *
 * 그래서 삭제된 `party-picker-dialog.tsx` 에서 **두 가지를 되살렸다**(되살린 것은
 * 표현이지 컴포넌트가 아니다 — 저 파일은 복원하지 않았다):
 *   ① **파티원 초상화 타일** — `scale-[5]` 얼굴 크롭. 배율의 근거는 실측이다(아래
 *      `MemberFace` 머리말). 그림이 없으면 실루엣이고 그것이 **정상 상태**다(§2.1.1).
 *   ② **게스트 얼굴 메우기**(`useGuestLookBackfill`) — 게스트는 `characters` 행이
 *      없어 영원히 실루엣이라, 창을 열 때 한 번 이름으로 생김새를 받아 둔다.
 *
 * 여기에 **보스 얼굴**을 더했다. 이 창의 일이 "어느 파티로 가나"이고 파티의 정체는
 * *누구와* + *무엇을* 이므로, 사람만 보이고 보스가 글자로만 있으면 절반만 보인다.
 * 얼굴은 일정표 블록(`week-timetable.tsx` 의 `RunBlock`)과 **같은 `BossIcon`**이다 —
 * 같은 보스가 두 화면에서 다르게 보이지 않아야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 표현은 이제 **이 파일의 것이 아니다** (2026-10-04, 같은 날 두 번째 지시)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"파티를 선택하는부분은 전부다 같은 컴포넌트를 사용해서 좀 보기 편하게 만들어"*
 *
 * 위에서 되살린 얼굴 타일 · 얼굴 줄 · `+N` 칩은 처음에 **이 파일 안의 지역 컴포넌트**로
 * 들어왔다. 그 상태로는 `/boss-plans` 의 등록 창과 `/parties` 의 파티 띠가 같은 표현을
 * 쓸 길이 없고(둘은 각각 `<select>` 와 글자 칩이었다), 베껴 가면 두 벌이 되어 반드시
 * 갈라진다. 그래서 전부 **`@/components/domain/party-option`** 으로 옮기고 여기서는
 * 지웠다 — 세 화면이 같은 컴포넌트를 쓰고, 밀도(`card` / `chip`)만 다르다.
 *
 * ★ **왕복도 같이 지웠다.** 보스 얼굴을 그리려고 이 창은 `useQueries` 로 **파티당 한 건**
 *   보스를 따로 받고 있었다(실측 파티 30개 → 30건). 양을 줄이려고 "앞 8개만 받고
 *   목록을 굴리면 더 받는" 꼼수까지 붙어 있었다. 이제 `GET /api/schedule/parties` 가
 *   `Party.bosses` 로 얼굴용 최소값을 함께 싣는다 — 서버는 `party_bosses` 를 한 번
 *   읽고, 브라우저 왕복은 **30건 → 0건**이다. 꼼수와 그 상수도 함께 사라졌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 2026-10-06 — **보스와 파티원을 여기서 고른다.** 위 "보스는 묻지 않는다"가 뒤집혔다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요청 원문: *"일정잡을때 보스 한개만 선택하고싶은데 무조건 전체 선택후 그 후에
 * 취소해야함 파티원과 보스 선택가능하게 변경"*
 *
 * **뒤집힌 결정을 지우지 않는 이유**는 그 근거가 틀렸던 게 아니기 때문이다. 2026-09-28
 * 의 논리는 *"보스는 `/parties` 가 이미 소유한 정보이므로 같은 사실을 두 곳에서 정하게
 * 하지 말자"* 였고, 그 말은 **소유권**에 관해서는 지금도 맞다 — 이 창은 `party_bosses`
 * 를 고치지 않는다. 틀렸던 것은 거기서 한 걸음 더 간 **"그러니 매번 전부 간다"** 쪽이다.
 * 파티는 *"같이 도는 묶음"* 의 정의이지 *"매번 그 묶음을 통째로 돈다"* 는 약속이 아니다.
 * 실제 쓰임이 그것을 증명했다: 보스 하나만 잡으려면 전부로 등록한 뒤 나머지를 **하나씩
 * 취소**해야 했고, 취소된 런은 행이 남아(`cancelled_at`) 시간표에 쓰레기로 쌓인다.
 * 즉 예전 방식은 "조작이 적다"가 아니라 **조작이 제일 많은 길**이었다.
 *
 * ★ **기본값은 여전히 전부 선택이다.** 예전 경로가 느려지면 안 된다 — 파티를 고르고
 *   바로 [잡기] 를 누르는 동작 수는 **변하지 않았다**(체크를 건드릴 필요가 없다).
 *   고르는 일은 "빼고 싶을 때"만 하는 일이고, 그래서 상태도 선택 집합이 아니라
 *   **제외 집합**(`excluded*`)이다. 제외 집합이면 목록이 늦게 도착해도(보스·구성원은
 *   파티를 고른 뒤에 조회된다) 초기값을 심는 effect 가 필요 없다 — 비어 있는 제외
 *   집합이 곧 "전원·전부"다. 선택 집합으로 두면 도착 시점에 state 를 채우는 동기화가
 *   생기고, 그 동기화가 늦으면 **한 순간 0개가 되어 등록 버튼이 깜빡 꺼진다.**
 * ★ **단계를 늘리지 않았다.** 체크는 이미 있던 확인 화면의 **같은 줄에** 얹혔다.
 *   `/boss-plans` 의 등록 모달이 2026-08-20 에 참여자에 대해 똑같이 한 선택이고
 *   (`boss-plans/components/plan-run-dialog.tsx`), 이제 두 화면의 언어가 같다.
 * ★ **1/n 의 분모가 고른 인원으로 간다** — 아래 `submit` 의 `entryPartySize` 참고.
 *   이걸 파티 전체 인원으로 두면 수익이 조용히 틀린다(§1 · §1.3 D3).
 */

export interface TimetableRunDialogProps {
  /** 시작 시각 — **누른 칸**이 정한다. `null` 이면 창이 닫혀 있다. */
  readonly startsAt: Date | null;
  readonly onClose: () => void;
  /**
   * 열람자 본인(`app_users.id`). 비로그인은 쓰기가 전부 401 이라 부모가 애초에 열지
   * 않지만, 여기서도 조회를 켜지 않는다 — `/api/schedule/characters` 는 세션이 없으면
   * 401 이고, 공개 시간표에 없어야 할 에러 UI 가 뜬다.
   *
   * 값 자체는 **"파티 안에서 어느 줄이 나인가"** 를 찾는 데 쓴다(`PartyMember` 에는
   * `isMe` 가 없다 — 판정의 주인은 화면이 아니라 세션이다).
   */
  readonly viewerPersonId: PersonId | null;
}

const EMPTY_PARTIES: readonly Party[] = [];
const EMPTY_CHARACTERS: readonly RunCharacterOption[] = [];

/**
 * 제외 집합의 초기값 — **빈 집합이 곧 "전부 선택"**이다(머리말 2026-10-06).
 *
 * 모듈 상수 하나를 공유한다. `useState(new Set())` 처럼 호출부에서 만들면 리셋할 때마다
 * 새 참조가 생겨 "비어 있음"끼리도 같지 않게 되고, 파티를 되돌릴 때 불필요한 리렌더가
 * 붙는다. 비어 있는 상태는 하나이므로 객체도 하나다.
 */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

/** 집합에서 하나를 켜고/끄는 순수 함수. 원본을 고치지 않는다(state 불변식). */
function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function TimetableRunDialog({
  startsAt,
  onClose,
  viewerPersonId,
}: TimetableRunDialogProps) {
  const queryClient = useQueryClient();
  const toaster = useToaster();

  /** 고른 파티. `null` = 아직 고르지 않았다(목록만 보이는 상태). */
  const [pickedPartyId, setPickedPartyId] = useState<PartyId | null>(null);

  /*
    ★ **빼기만 담는다**(머리말 2026-10-06). 비어 있는 집합이 곧 "보스 전부 · 파티원
      전원"이라, 조회가 늦게 도착해도 초기값을 심을 필요가 없다.
    ★ 파티를 바꾸면 **반드시 비운다.** id 는 파티별로 다르니 남은 제외가 새 파티에
      걸릴 일은 없지만, 비우지 않으면 같은 파티로 되돌아왔을 때 아까 뺀 것이 조용히
      살아 있다 — 창이 "전부 선택"이라고 말하면서 그렇지 않은 상태다.
  */
  const [excludedBossIds, setExcludedBossIds] =
    useState<ReadonlySet<string>>(NO_EXCLUSIONS);
  const [excludedPersonIds, setExcludedPersonIds] =
    useState<ReadonlySet<string>>(NO_EXCLUSIONS);

  const pickParty = (partyId: PartyId | null) => {
    setPickedPartyId(partyId);
    setExcludedBossIds(NO_EXCLUSIONS);
    setExcludedPersonIds(NO_EXCLUSIONS);
  };

  const open = startsAt !== null;

  const partiesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.list()),
    queryFn: fetchParties,
    enabled: open,
  });

  const parties = partiesQuery.data ?? EMPTY_PARTIES;
  /** 남의 공개 파티에는 일정을 잡을 수 없다 — 서버가 구성원만 허용한다. */
  const myParties = parties.filter((party) => party.members.length > 0);

  /*
    게스트 얼굴을 조용히 메운다. 화면 모양에는 아무 영향이 없고, 메울 것이 없으면
    요청도 나가지 않는다(훅 머리말). 창이 닫혀 있으면 아무 일도 하지 않는다.
  */
  useGuestLookBackfill(open, myParties);

  const bossesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.bosses(pickedPartyId ?? "none")),
    queryFn: () => fetchPartyBosses(pickedPartyId ?? ""),
    enabled: open && pickedPartyId !== null,
  });

  const membersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.members(pickedPartyId ?? "none")),
    queryFn: () => fetchPartyMembers(pickedPartyId ?? ""),
    enabled: open && pickedPartyId !== null,
  });

  /**
   * 내가 데려갈 캐릭터. **서버가 요구하는 값**이라 비울 수 없다.
   *
   * 고르게 하지 않는 이유: 파티마다 데려갈 캐릭터는 `/parties` 에서 이미 정해 뒀고
   * (`party_participants.character_id`), 정하지 않았으면 본캐(목록 첫 행)가 맞다.
   * 특정 일정만 다른 캐릭으로 나가는 경우는 드물고, 그 조정은 이 창의 질문이 아니다.
   */
  const charactersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.characters.forRuns()),
    queryFn: fetchMyRunCharacters,
    enabled: open && viewerPersonId !== null,
  });

  const characters = charactersQuery.data ?? EMPTY_CHARACTERS;
  const partyBosses = bossesQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const pickedParty =
    myParties.find((party) => party.partyId === pickedPartyId) ?? null;

  /*
    ── **실제로 등록될 것** ────────────────────────────────────────────────────
    아래 두 값이 등록에 들어가는 전부다. `partyBosses` · `members` 는 **목록을 그리는
    데만** 쓰고(체크 안 된 줄도 보여야 한다), 서버로 가는 것은 언제나 이쪽이다.
    규칙 하나로 고정해 두는 이유는 §6 — *"요약이 고른 것만 말해야 한다"* — 를 지키려면
    화면이 읽는 값과 전송되는 값이 **같은 변수**여야 하기 때문이다. 두 벌이 되면
    "전부라고 말하면서 일부만 잡히는" 거짓말이 다시 생길 자리가 열린다.
  */
  const goingBosses = partyBosses.filter(
    (entry) => !excludedBossIds.has(entry.bossDifficultyId),
  );
  const goingMembers = members.filter(
    (member) => !excludedPersonIds.has(member.personId),
  );

  /**
   * ★ 우선순위는 **① 파티 참여 캐릭터 → ② 본캐**다. 파티에 무르겨르로 들어가 있으면
   *   그 캐릭터로 가는 것이 맞고, 안 정했으면 본캐가 기본이다(`fetchMyRunCharacters`
   *   가 본캐를 맨 앞으로 정렬한다).
   * ★ 두 단계 모두 `characters` 안에서 다시 찾는다 — 추적을 끊은 캐릭터가
   *   `party_participants` 에 남아 있을 수 있고, 목록에 없는 id 를 그대로 보내면
   *   서버가 거절한다.
   */
  const myPartyCharacterId =
    viewerPersonId === null
      ? null
      : (members.find((member) => member.personId === viewerPersonId)
          ?.characterId ?? null);
  const characterId =
    characters.find((entry) => entry.characterId === myPartyCharacterId)
      ?.characterId ??
    characters[0]?.characterId ??
    null;

  const createRun = useMutation({
    mutationFn: (input: CreateRunBundleInput) => createPartyRunBundle(input),
    onSuccess: (created) => {
      const first = created[0];
      if (first === undefined || startsAt === null) return;
      /*
        ⚠️ `scheduledAt` 은 **널러블**이다(시각 미정 런이 있을 수 있다). 여기서 만든
           런은 언제나 시각이 있지만, 타입이 그 사실을 모르므로 우리가 보낸 값으로
           주차를 계산한다 — 서버 응답을 다시 파싱하는 것보다 확실하다.
      */
      const weekKey = getWeekKey(startsAt);
      /*
        ★ 무효화 목록은 예전 등록 뮤테이션(`schedule-workspace`)과 **같다.** 새로 만든
          것이 아니라 옮겨 온 것이므로, 어느 화면이 움직여야 하는지의 판단은 이미 검증된
          그대로다 (§2.4 Rule 5).
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(first.partyId, weekKey),
      });
      /*
        ★ **이번 주 시간표.** `runs.list` 는 파티별 키라 시간표(`runs.timetable`)를
          덮지 못한다 — 접두사가 겹치지 않아 자동으로 따라오지 않는다. 이걸 빼먹으면
          방금 잡은 일정이 **바로 지금 보고 있는 화면**에 안 나타난다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.timetable(weekKey),
      });
      /* 파티 카드의 "이번 주 일정 N건". 파티 자체는 안 바뀌었으므로 `mine` 만 짚는다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.mine(weekKey),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });

      /*
        ⚠️ **창을 닫고 결과를 말한다**(2026-08-28 발주 지적: *"등록을 눌러도 반응이없음.
           생성된건지 확인안됨"*). 사용자가 볼 수 있는 것이 하나도 안 바뀌면 성공과
           "아무 일도 일어나지 않음"이 구별되지 않고, 그 상태에서 할 수 있는 일은 다시
           누르는 것뿐이라 중복 등록으로 이어진다.
      */
      onClose();
      toaster.notify({
        tone: "success",
        title: `일정 ${String(created.length)}건을 잡았습니다`,
        description: `${pickedParty?.name ?? "파티"} · ${formatKstFull(startsAt)} 시작`,
      });
    },
  });

  if (!open) return null;

  /*
    ★ **고른 것이 0 이면 못 누른다**(발주 2026-10-06 §3). 보스 0개는 서버도 400 으로
      막지만(`createPartyRuns` — "등록할 보스를 하나 이상 선택해 주세요"), 버튼을 눌러
      왕복을 돌고 나서야 듣는 말과 누르기 전에 화면이 하는 말은 같은 문장이 아니다.
      파티원 0명은 **서버가 막지 않는다** — `participantPersonIds` 가 비어도 런은
      만들어지고 참가자만 없는 상태가 된다. 그래서 여기가 유일한 관문이다.
      (그 상태를 허용해 두는 것 자체는 옳다: 2026-08-20 결정대로 등록자가 안 가는
       일정도 정상이므로, 서버가 "한 명 이상"을 강제하면 그 쓰임이 막힌다.)
  */
  const canSubmit =
    pickedPartyId !== null &&
    goingBosses.length > 0 &&
    goingMembers.length > 0 &&
    characterId !== null &&
    !createRun.isPending;

  /*
    ★ **겹침은 여기서 막지 않는다** (2026-09-28). 같은 파티에 이미 겹치는 런이 있으면
      서버(`schedule-repo.createPartyRuns`)가 409 로 거절하고, 그 문구가 아래
      `createRun.error` 의 `ErrorState` 에 그대로 실린다("… 9/28 19:20 흑련 — 다른
      시각으로 잡거나 …").

      창에서 미리 거르지 않는 이유는 **방(`!보스`)과 같은 규칙이어야 하기 때문**이다.
      판정을 창에도 한 벌 두면 판정이 둘이 되고, 그 둘은 반드시 갈라진다. 게다가 창이
      들고 있는 시간표 payload 에는 **내가 `going` 인 런만** 실려 있어(§1.1.1 — `/` 는
      그것만 그린다) 남이 잡아 둔 같은 파티의 런이 보이지 않는다. 즉 여기서는 애초에
      올바르게 판정할 수 없다. 경계는 언제나 서버다.
  */
  const submit = () => {
    if (pickedPartyId === null || characterId === null) return;
    if (goingBosses.length === 0 || goingMembers.length === 0) return;
    createRun.mutate({
      partyId: pickedPartyId,
      /*
        ★ **체크한 것만, 체크한 순서대로.** `filter` 는 원래 순서를 유지하고
          `CreateRunBundleInput.bossDifficultyIds` 는 *"배열 순서가 곧 등록 순서"* 이므로
          (서버가 i 번째를 `시작 + 20분 × i` 에 놓는다) 가운데를 빼면 뒤가 **당겨진다** —
          구멍이 남지 않는다. 아래 미리보기가 같은 규칙으로 시각을 계산한다.
      */
      bossDifficultyIds: goingBosses.map((entry) => entry.bossDifficultyId),
      scheduledAt: startsAt,
      /*
        보스당 20분이 기본이고 **연속 배치 간격이기도 하다**(서버가 `시작 + 20 × i` 에
        놓는다). 상수의 주인은 `lib/run-defaults.ts` 하나다.
      */
      durationMinutes: DEFAULT_DURATION_MINUTES,
      /*
        ★ ═════════════════════════════════════════════════════════════════════
          **1/n 의 분모는 `goingMembers.length` 다 — 파티 전체 인원이 아니다.**
          ═════════════════════════════════════════════════════════════════════
          결정석은 **들어간 인원**으로 나뉜다(§1: 실수령 = `floor(시세/파티원수)`).
          4인 파티에서 2명만 가면 각자 받는 돈은 1/2 이고, 여기에 4 를 보내면 pot 이
          `4 × floor(base/4)` 로 잡힌 뒤 `going` 2명이 나눠 갖는다 — 1인당 `base/2` 가
          되어 금액은 우연히 비슷해지지만, **저장된 `entry_party_size` 가 거짓**이 된다.
          그 값은 §1.3 D3 가 *"몇 명이 실제로 입장했는가"* 로 정의한 컬럼이고,
          수익 화면(`/income` 의 `인원` 열)과 "등록 6명 vs 입장 3명" 경고가 그것을
          그대로 읽는다. 여기서 틀리면 수익이 조용히 틀리는 게 아니라 **조용히 틀렸다고
          주장하지도 않는다.**
          (실제 분배는 `resolve_crystal_payout` 이 런의 `going` 참가자 수로 나누므로,
           같은 수를 두 자리에 보내는 아래 두 줄이 **짝이 맞아야** 한다.)
      */
      entryPartySize: goingMembers.length,
      participantPersonIds: goingMembers.map((member) => member.personId),
      characterId,
      note: null,
      /* 고정팟(여러 주 반복)은 이 창의 질문이 아니다 — 한 번만 잡는다. */
      repeatWeeks: 1,
    });
  };

  const endsAtText =
    goingBosses.length === 0
      ? null
      : formatKst(
          new Date(
            startsAt.getTime() +
              goingBosses.length * DEFAULT_DURATION_MINUTES * 60_000,
          ),
          "HH:mm",
        );

  return (
    <Dialog
      open
      onClose={onClose}
      title="보스 일정 잡기"
      description={`${formatKstFull(startsAt)} 시작`}
      footer={
        pickedPartyId === null ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => pickParty(null)}>
              다른 파티
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              <CalendarPlus aria-hidden size={16} />
              {/*
                ★ 버튼이 **몇 건이 잡히는지** 말한다. 보스 하나 = 런 하나라 이 수는
                  성공 토스트("일정 N건을 잡았습니다")와 같은 수이고, 체크를 끄면
                  버튼의 숫자가 바로 줄어 **고른 것만 잡힌다는 사실이 눌리기 전에**
                  보인다. 0 건일 때는 숫자를 말하지 않는다 — 그 상태의 설명은 아래
                  보스 칸의 문장이 하고, 버튼은 어차피 비활성이다.
              */}
              {createRun.isPending
                ? "잡는 중…"
                : goingBosses.length === 0
                  ? "이 파티로 잡기"
                  : `일정 ${String(goingBosses.length)}건 잡기`}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {pickedPartyId === null ? (
          <PartyList
            parties={myParties}
            isLoading={partiesQuery.isPending}
            isError={partiesQuery.isError}
            onRetry={() => void partiesQuery.refetch()}
            onPick={(partyId) => pickParty(partyId)}
          />
        ) : (
          <>
            <section className="flex flex-col gap-1">
              <h3 className="text-overline uppercase text-ink-muted">파티</h3>
              <p className="text-body-lg font-semibold text-ink">
                {pickedParty?.name ?? "고른 파티"}
              </p>
            </section>
            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                갈 보스{" "}
                {partyBosses.length === 0
                  ? ""
                  : `${String(goingBosses.length)}/${String(partyBosses.length)}`}
              </h3>
              {bossesQuery.isPending ? (
                <Skeleton className="h-16" />
              ) : bossesQuery.isError ? (
                <ErrorState
                  title="보스 목록을 불러오지 못했습니다"
                  onRetry={() => void bossesQuery.refetch()}
                  className="py-4"
                />
              ) : partyBosses.length === 0 ? (
                /*
                  ⚠️ 이 파티로는 일정을 잡을 수 없다. 서버도 거절하지만, **무엇을 해야
                     하는지**는 여기서만 말할 수 있다 — 보스는 `/parties` 가 소유한다.
                */
                <EmptyState
                  title="이 파티에 등록된 보스가 없습니다"
                  description="일정은 파티에 등록된 보스로 잡힙니다. 먼저 파티 관리에서 갈 보스를 정해 주세요."
                  action={
                    <Link href="/parties">
                      <Button variant="secondary" size="sm">
                        파티 관리로 →
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <>
                  <BossCheckList
                    bosses={partyBosses}
                    excludedIds={excludedBossIds}
                    startsAt={startsAt}
                    onToggle={(bossDifficultyId) => {
                      setExcludedBossIds((prev) =>
                        toggled(prev, bossDifficultyId),
                      );
                    }}
                  />
                  {goingBosses.length === 0 ? (
                    /*
                      ⚠️ **등록을 막는 상태**다. `tone="error"` 를 쓰는 근거는 §4 가
                         아니라 `/boss-plans` 등록 모달의 같은 문장과 **짝을 맞추는**
                         것이다 — 두 화면이 같은 사건을 다른 색으로 말하면 안 된다.
                         (주황은 §4 대로 임박·주의용이고, 이건 "지금 누를 수 없다"다.)
                    */
                    <HelperText tone="error">
                      갈 보스를 하나 이상 체크해 주세요. 하나도 없으면 잡을 일정이
                      없습니다.
                    </HelperText>
                  ) : (
                    <HelperText>
                      체크한 {goingBosses.length}개가 보스당{" "}
                      {DEFAULT_DURATION_MINUTES}분씩 연달아 배치됩니다 —{" "}
                      {formatKst(startsAt, "HH:mm")}
                      {endsAtText === null ? null : `~${endsAtText}`}.
                      시각·인원은 잡은 뒤 일정에서 고칠 수 있습니다.
                    </HelperText>
                  )}
                </>
              )}
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                참여자{" "}
                {members.length === 0
                  ? ""
                  : `${String(goingMembers.length)}/${String(members.length)}`}
              </h3>
              {membersQuery.isPending ? (
                <Skeleton className="h-10" />
              ) : membersQuery.isError ? (
                <ErrorState
                  title="구성원을 불러오지 못했습니다"
                  onRetry={() => void membersQuery.refetch()}
                  className="py-4"
                />
              ) : members.length === 0 ? (
                <p className="text-body-sm text-ink-muted">
                  구성원이 없습니다. 파티 관리에서 파티원을 먼저 넣어 주세요.
                </p>
              ) : (
                <>
                  <MemberCheckList
                    members={members}
                    looks={pickedParty?.members ?? []}
                    excludedIds={excludedPersonIds}
                    onToggle={(personId) => {
                      setExcludedPersonIds((prev) => toggled(prev, personId));
                    }}
                  />
                  {goingMembers.length === 0 ? (
                    <HelperText tone="error">
                      갈 파티원을 한 명 이상 체크해 주세요. 아무도 안 가면 결정석을
                      나눌 사람이 없습니다.
                    </HelperText>
                  ) : (
                    <HelperText>
                      체크한 {goingMembers.length}명이{" "}
                      <strong className="font-semibold">참가</strong>로
                      들어가고, 결정석이 그 {goingMembers.length}명으로 1/n
                      나뉩니다. 각자 어느 캐릭터로 갈지는 본인이 고릅니다.
                    </HelperText>
                  )}
                </>
              )}
            </section>

            {/*
              내가 데려갈 캐릭터는 고르지 않고 **말해 준다**(머리말). 추적 캐릭터가 아예
              없으면 등록이 불가능하므로 그때만 경고한다 — 빨강이 아니라 주황이다
              (§4: 빨강은 실패·취소 전용).
            */}
            {viewerPersonId !== null &&
            !charactersQuery.isPending &&
            characterId === null ? (
              <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                추적 중인 캐릭터가 없어 일정을 잡을 수 없습니다. 설정에서
                캐릭터를 먼저 골라 주세요.
              </p>
            ) : null}

            {createRun.error === null ? null : (
              <ErrorState
                title="일정을 잡지 못했습니다"
                detail={createRun.error.message}
                className="py-4"
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// 고르는 줄 — 보스 · 파티원 (2026-10-06)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 체크 줄 한 개의 바탕. **두 채널로 말한다** — 테두리와 면.
 *
 * 색 하나로만 말하면 색각 이상에서 구분이 사라진다. 세 번째 채널은 `Checkbox` 자신의
 * 채움(primary)이고, 보조 기술 쪽은 `<input type="checkbox">` 의 네이티브 상태가 진다.
 *
 * ⚠️ 측정해 둔 쌍(`globals.css` 머리말): `ink-muted` / `primary-subtle` 은 라이트 5.46 ·
 *    다크 6.13 으로 둘 다 AA 를 넘는다. 즉 **고른 줄에서도** 12px 시각 주석이 읽힌다 —
 *    새 면을 만들지 않고 이미 감사된 면을 쓰는 이유가 그것이다(§4: 대비는 토큰 표가
 *    아니라 실제로 겹친 쌍에서 판정한다).
 */
const CHECK_ROW = (going: boolean): string =>
  cn(
    "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5",
    "transition duration-200",
    going
      ? "border-primary bg-primary-subtle hover:bg-primary-subtle-hover"
      : "border-border bg-background hover:border-border-strong hover:bg-hover-strong",
  );

/**
 * 갈 보스를 고르는 목록.
 *
 * ★ **시각은 체크된 것들만으로 다시 계산된다.** 가운데를 빼면 뒤 보스의 시각이
 *   당겨져야 하고(서버가 `시작 + 20분 × i` 로 놓으므로 실제로 그렇게 저장된다),
 *   목록이 원래 자리의 시각을 그대로 들고 있으면 **미리보기가 거짓말**이 된다.
 *   그래서 배치 규칙을 여기서 한 번 더 쓰지 않고, `submit` 이 보내는 것과 **같은
 *   필터·같은 순서**로 미리 돌려 시각을 표에 적어 둔다.
 * ★ 체크가 꺼진 줄은 시각 자리가 `—` 다. 비워 두면 "아직 안 정해졌나"로 읽히고,
 *   글자를 적으면(`제외`) 줄마다 읽을 것이 하나 더 늘어난다.
 * ★ `<ol>` 이 아니라 `<ul>` 이다 — 순서 번호를 그리지 않기 때문이다. 순서는 시각이
 *   말하고, 등록된 뒤의 번호(`run_no`)는 **서버가 부여하는 다른 값**이다(§1.4).
 */
function BossCheckList({
  bosses,
  excludedIds,
  startsAt,
  onToggle,
}: {
  readonly bosses: readonly PartyBoss[];
  readonly excludedIds: ReadonlySet<string>;
  readonly startsAt: Date;
  readonly onToggle: (bossDifficultyId: BossDifficultyId) => void;
}) {
  const timeByBossId = new Map<string, Date>();
  let order = 0;
  for (const entry of bosses) {
    if (excludedIds.has(entry.bossDifficultyId)) continue;
    timeByBossId.set(
      entry.bossDifficultyId,
      new Date(startsAt.getTime() + order * DEFAULT_DURATION_MINUTES * 60_000),
    );
    order += 1;
  }

  return (
    <ul className="flex flex-col gap-1">
      {bosses.map((entry) => {
        const at = timeByBossId.get(entry.bossDifficultyId) ?? null;
        return (
          <li className="min-w-0" key={entry.bossDifficultyId}>
            {/*
              ★ `Checkbox` 를 **라벨 없이** 쓰고 줄 전체를 내 `<label>` 로 감싼다.
                `Checkbox` 의 `label` 프롭을 쓰면 그쪽이 `<label>` 을 만들어 클릭
                영역이 글자만큼으로 좁아지고, 그 위에 또 `<label>` 을 두르면 라벨이
                중첩돼 HTML 이 깨진다. 이렇게 두면 **줄 어디를 눌러도** 켜진다.
                (커서는 `globals.css` 의 `label:has(input[type=checkbox])` 가 준다.)
            */}
            <label className={CHECK_ROW(at !== null)}>
              <Checkbox
                checked={at !== null}
                onChange={() => onToggle(entry.bossDifficultyId)}
              />
              <BossIcon
                bossDifficultyId={entry.bossDifficultyId}
                difficulty={entry.difficulty}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                {entry.koreanName}
              </span>
              <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                {at === null ? "—" : formatKst(at, "HH:mm")}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 갈 파티원을 고르는 목록.
 *
 * ⚠️ **얼굴과 id 가 서로 다른 응답에서 온다.** 등록에 실제로 보내는 값(`personId`)은
 *    `fetchPartyMembers`(=`PartyMember`)가 소유하는데 그 타입에는 초상화 필드가 아예
 *    없다 — 저쪽은 `participantId` · `seatNo` 를 들고 로스터를 편집하는 무거운 타입이고,
 *    초상화는 목록용 `PartyMemberBrief`(파티 목록 payload)에만 실린다. 그래서 **줄의
 *    주인은 `members`** 이고 `looks` 는 **그림만** 빌려 준다.
 * ★ 둘을 잇는 열쇠는 `displayName` 이다. 양쪽 다 `party_participants.display_name`
 *   에서 나오므로 같은 사람이면 같은 글자다. **id 를 잇는 것이 아니라서 안전하다** —
 *   한 파티에 같은 표시명이 둘 있어 잘못 집어도 틀리는 것은 *초상화 한 칸*이고,
 *   서버로 가는 `personId` 는 언제나 `members` 쪽에서 그대로 나간다.
 * ★ 못 찾으면 `members` 의 값으로 **최소 brief 를 만든다.** 그림이 없으면 실루엣이고
 *   그것이 정상 상태다(§2.1.1) — 줄을 빼거나 오류를 그리지 않는다.
 * ★ 번호(`seatNo`)를 함께 그린다. 카톡에서 "1번"으로 부르는 그 번호이고(§1.4), 실측된
 *   파티는 이름이 서로 비슷해 번호가 실제 식별에 쓰인다. 접지 않고 **전원을 그린다** —
 *   여기서 `+2` 로 접으면 "누가 빠졌나"를 숨기는 쪽으로만 작동한다.
 */
function MemberCheckList({
  members,
  looks,
  excludedIds,
  onToggle,
}: {
  readonly members: readonly PartyMember[];
  readonly looks: readonly PartyMemberBrief[];
  readonly excludedIds: ReadonlySet<string>;
  readonly onToggle: (personId: PersonId) => void;
}) {
  const lookByName = new Map(
    looks.map((look) => [look.displayName, look] as const),
  );

  return (
    <ul className="flex flex-col gap-1">
      {members.map((member) => {
        const going = !excludedIds.has(member.personId);
        const look: PartyMemberBrief = lookByName.get(member.displayName) ?? {
          displayName: member.displayName,
          characterName: member.characterName,
          characterLevel: null,
          characterClass: null,
          characterImageUrl: null,
          isGuest: member.isGuest,
        };

        return (
          <li className="min-w-0" key={member.personId}>
            <label className={CHECK_ROW(going)}>
              <Checkbox
                checked={going}
                onChange={() => onToggle(member.personId)}
              />
              <MemberFace member={look} />
              <SeatNumber
                seatNo={member.seatNo}
                size="sm"
                tone={going ? "primary" : "muted"}
              />
              {/*
                이름은 `participantLabel` 이 소유한다 — `더저(메검메)` 조합 규칙을
                여기서 다시 만들면 파티 바와 글자가 갈린다.
              */}
              <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                {participantLabel(member)}
              </span>
              {member.isGuest ? (
                <span className="shrink-0 text-caption text-ink-muted">
                  게스트
                </span>
              ) : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/*
 * ★ 여기 있던 `MAX_FACES` · `BOSS_REVEAL_STEP` · `MemberFace` · `MemberFaceRow` ·
 *   `BossFaceRow` · `MoreChip` 은 **전부 `@/components/domain/party-option` 으로
 *   옮겼다** (2026-10-04 발주 지시 — 머리말 참고). 근거 주석(크롭 배율 실측 · 실루엣
 *   색 선택 · `isPending` 함정 · `min-w-0` 가드)도 함께 갔으니 **여기서 다시 쓰지 말고
 *   그 파일을 읽을 것.** 두 벌이 되는 순간 갈라진다.
 *   `BOSS_REVEAL_STEP` 은 옮긴 것이 아니라 **없어졌다** — 보스가 파티 목록 payload 에
 *   함께 실려 와(`Party.bosses`) 나눠 받을 이유가 사라졌다.
 */

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 실루엣 메우기 — **창을 열 때 한 번, 조용히** (삭제된 picker 에서 되살림)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-09-03): *"내 api 로 파티원들의 이미지를 가져오는식으로"*.
 *
 * 게스트는 우리 DB 에 `characters` 행도 ocid 도 없어서 얼굴 자리가 **영원히** 비어
 * 있다. `POST /api/characters/looks` 가 **이름만으로** 넥슨에서 생김새를 받아
 * `character_looks` 에 적고, 다음 파티 조회가 그 캐시를 읽어 그림을 채운다
 * (`schedule-repo.withCachedLooks` — 파티 목록 경로에 그대로 살아 있다).
 *
 * ★ **서버 렌더가 아니라 여기서 부른다.** 이름 하나에 넥슨 2콜 + 250ms 간격이라 렌더
 *   경로에 넣으면 창을 여는 데 초 단위가 걸린다. 읽기는 DB 조회뿐이다.
 * ★ **메울 것이 없으면 요청이 나가지 않는다.** 얼굴이 이미 있는 사람은 건너뛰고,
 *   한 번 물어본 이름은 다시 묻지 않는다 — 넥슨에 없는 이름이면 응답 후에도 초상화가
 *   계속 `null` 이라, 시도 기록이 없으면 창을 열 때마다 같은 2콜이 영원히 나간다.
 * ★ 끝나면 **파티 목록 쿼리를 무효화**한다. 화면 데이터의 주인은 쿼리 캐시이므로
 *   (§2.4 규칙 1) `router.refresh()` 를 부르지 않는다(규칙 3). 키는
 *   `queryKeys.db.party.list()` — 이 창의 `partiesQuery` 가 쓰는 **바로 그 키**다
 *   (접두사가 비슷하다고 덮인다고 가정하지 않는다 — §2.4 경고).
 * ★ **실패해도 아무 일도 일어나지 않는다.** 실루엣은 오류가 아니라 정상 상태이고
 *   (§2.1.1) 일정을 잡는 일과 무관하다 — 토스트도 로딩 표시도 띄우지 않는다.
 */
/** 한 번에 물어보는 최대 이름 수. 라우트의 상한과 같은 값이다. */
const LOOKUP_BATCH_LIMIT = 20;

/** `character_looks.character_name` 의 CHECK(1~40자)와 같은 값. */
const LOOKUP_NAME_MAX_LENGTH = 40;

function useGuestLookBackfill(
  open: boolean,
  parties: readonly Party[],
): void {
  const queryClient = useQueryClient();
  /*
    시도한 이름. 창을 닫았다 열어도 살아 있어야 하므로 ref 다 — state 로 두면 값이
    바뀔 때마다 다시 그려지는데, 이 값은 화면에 한 글자도 나오지 않는다.
  */
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;

    const names: string[] = [];
    for (const party of parties) {
      for (const member of party.members) {
        // 이미 얼굴이 있는 사람은 물을 이유가 없다.
        if (member.characterImageUrl !== null) continue;
        const name = (member.characterName ?? member.displayName).trim();
        if (name === "" || name.length > LOOKUP_NAME_MAX_LENGTH) continue;
        if (attempted.current.has(name)) continue;
        attempted.current.add(name);
        names.push(name);
        if (names.length >= LOOKUP_BATCH_LIMIT) break;
      }
      if (names.length >= LOOKUP_BATCH_LIMIT) break;
    }
    if (names.length === 0) return;

    /*
      무효화가 `parties` 를 새 배열로 갈아 끼워 이 effect 가 다시 돈다. 그때 남은
      이름은 전부 `attempted` 에 있으므로 위 반복이 빈 배열을 만들고 여기서 끝난다 —
      되먹임 고리가 생기지 않는다.
    */
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/characters/looks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ names }),
        });
        if (cancelled || !response.ok) return;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.db.party.list(),
        });
      } catch {
        // 조용히 넘어간다. 실루엣은 정상 상태다(§2.1.1).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, parties, queryClient]);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 파티 목록 — 이 창이 묻는 **유일한 질문**이다.
 *
 * 이름만으로는 서로 구분되지 않는다(실측된 이름들이 `발벨3인` · `세쌀카2인523` 처럼
 * 보스 줄임말 + 인원이다). 그래서 **구성원과 보스를 얼굴로 함께** 그린다 — 발주 지시
 * 2026-09-01: *"파티 고를때 파티원도 다 보이게 해서 해줘 이름이 비슷해서 하나도 모르겠음"*.
 *
 * ★ **줄의 모양과 배치는 전부 `PartyOptionGrid` 가 소유한다**(2026-10-04). 두 열 · 좁은
 *   화면 한 열 · `min-w-0` 가로 스크롤 가드 · 얼굴 순서 · `+N` 접기까지 거기 있고,
 *   `/boss-plans` 의 등록 창이 **같은 컴포넌트**를 쓴다. 여기 남은 것은 이 창에만
 *   있는 세 가지 상태(오류 · 로딩 · 빈 목록)뿐이다 — 그 셋은 쿼리에 달린 값이라
 *   공용 컴포넌트가 가질 수 없다(§2.4 Rule 1: 조회는 화면이 소유한다).
 * ★ **보스 얼굴을 위한 조회가 없다.** `Party.bosses` 가 파티 목록 payload 에 함께 실려
 *   온다. 예전에는 `useQueries` 로 파티당 한 건을 받았고(실측 30개 파티 → 30건),
 *   그 양을 가리려고 "앞 8개만 받고 목록을 굴리면 더 받는" 꼼수가 있었다. 둘 다 없다.
 */
function PartyList({
  parties,
  isLoading,
  isError,
  onRetry,
  onPick,
}: {
  readonly parties: readonly Party[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly onPick: (partyId: PartyId) => void;
}) {
  if (isError) {
    return (
      <ErrorState
        title="파티 목록을 불러오지 못했습니다"
        onRetry={onRetry}
        className="py-6"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (parties.length === 0) {
    return (
      <EmptyState
        icon={<Users aria-hidden size={22} className="text-primary" />}
        title="아직 파티가 없습니다"
        description="일정은 파티 단위로 잡힙니다. 같이 갈 사람과 갈 보스를 먼저 파티로 묶어 주세요."
        action={
          <Link href="/parties">
            <Button>파티 만들러 가기 →</Button>
          </Link>
        }
      />
    );
  }

  /*
    고른 파티를 표시하지 않는다(`selectedPartyId` 를 넘기지 않는다) — 이 창은 고르는
    순간 **확인 단계로 넘어가** 목록 자체가 사라지므로, 강조할 줄이 존재하는 순간이
    없다. 넘겨 두면 "아무것도 안 골랐는데 왜 하나가 켜져 있나"가 된다.
  */
  return <PartyOptionGrid parties={parties} onSelect={onPick} />;
}
