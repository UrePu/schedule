"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  BossIcon,
  MemberFaceRow,
  PartyOptionGrid,
} from "@/components/domain";
import { formatKstFull } from "@/components/domain/kst-format";
import {
  Button,
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
import type {
  CreateRunBundleInput,
  Party,
  PartyId,
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

export function TimetableRunDialog({
  startsAt,
  onClose,
  viewerPersonId,
}: TimetableRunDialogProps) {
  const queryClient = useQueryClient();
  const toaster = useToaster();

  /** 고른 파티. `null` = 아직 고르지 않았다(목록만 보이는 상태). */
  const [pickedPartyId, setPickedPartyId] = useState<PartyId | null>(null);

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

  const canSubmit =
    pickedPartyId !== null &&
    partyBosses.length > 0 &&
    members.length > 0 &&
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
    if (partyBosses.length === 0 || members.length === 0) return;
    createRun.mutate({
      partyId: pickedPartyId,
      bossDifficultyIds: partyBosses.map((entry) => entry.bossDifficultyId),
      scheduledAt: startsAt,
      /*
        보스당 20분이 기본이고 **연속 배치 간격이기도 하다**(서버가 `시작 + 20 × i` 에
        놓는다). 상수의 주인은 `lib/run-defaults.ts` 하나다.
      */
      durationMinutes: DEFAULT_DURATION_MINUTES,
      /* 1/n 의 분모(§1.3 D3). 기본값은 등록된 참여자 수이고, 나중에 고칠 수 있다. */
      entryPartySize: members.length,
      participantPersonIds: members.map((member) => member.personId),
      characterId,
      note: null,
      /* 고정팟(여러 주 반복)은 이 창의 질문이 아니다 — 한 번만 잡는다. */
      repeatWeeks: 1,
    });
  };

  const endsAtText =
    partyBosses.length === 0
      ? null
      : formatKst(
          new Date(
            startsAt.getTime() +
              partyBosses.length * DEFAULT_DURATION_MINUTES * 60_000,
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
            <Button variant="ghost" onClick={() => setPickedPartyId(null)}>
              다른 파티
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              <CalendarPlus aria-hidden size={16} />
              {createRun.isPending ? "잡는 중…" : "이 파티로 잡기"}
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
            onPick={(partyId) => setPickedPartyId(partyId)}
          />
        ) : (
          <>
            <section className="flex flex-col gap-1">
              <h3 className="text-overline uppercase text-ink-muted">파티</h3>
              <p className="text-body-lg font-semibold text-ink">
                {pickedParty?.name ?? "고른 파티"}
              </p>
            </section>
            {/*
              ⚠️ **참여자 얼굴은 `pickedParty.members` 에서 온다.** 아래 참여자 칸이 쓰는
                 `PartyMember`(=`fetchPartyMembers`)에는 초상화 필드가 아예 없다 —
                 그 타입은 `participantId` · `seatNo` 를 들고 로스터를 편집하는 쪽이고,
                 초상화는 목록용 `PartyMemberBrief` 에만 실린다. 그래서 **인원수·이름의
                 주인은 여전히 `members`** 이고(등록에 실제로 보내는 값이다) 얼굴만
                 미리보기 쪽에서 가져온다.
            */}

            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                갈 보스 {partyBosses.length === 0 ? "" : partyBosses.length}
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
                  <ol className="flex flex-col gap-1">
                    {partyBosses.map((entry, index) => (
                      <li
                        key={entry.bossDifficultyId}
                        className="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-1.5"
                      >
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
                        <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                          {formatKst(
                            new Date(
                              startsAt.getTime() +
                                index * DEFAULT_DURATION_MINUTES * 60_000,
                            ),
                            "HH:mm",
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <HelperText>
                    보스당 {DEFAULT_DURATION_MINUTES}분씩 연달아 배치됩니다 —{" "}
                    {formatKst(startsAt, "HH:mm")}
                    {endsAtText === null ? null : `~${endsAtText}`}. 시각·인원은
                    잡은 뒤 일정에서 고칠 수 있습니다.
                  </HelperText>
                </>
              )}
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                참여자 {members.length === 0 ? "" : members.length}
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
                  {/*
                    고르기 전과 **같은 언어**다(발주 2026-10-04). 고를 때는 얼굴로
                    알아보고 확인할 때는 글자만 보면, 같은 파티가 두 화면처럼 보인다.
                    여기서는 자리가 넉넉하므로 접지 않고 전원을 그린다 — 확인 단계에서
                    `+2` 는 "누가 빠졌나"를 숨기는 쪽으로만 작동한다.
                  */}
                  {pickedParty !== null && pickedParty.members.length > 0 ? (
                    <MemberFaceRow members={pickedParty.members} max={null} />
                  ) : null}
                  <p className="flex flex-wrap items-center gap-1.5 text-body-sm text-ink">
                    <Users
                      aria-hidden
                      size={14}
                      className="shrink-0 text-ink-muted"
                    />
                    {members
                      .map((member) => participantLabel(member))
                      .join(", ")}
                  </p>
                </>
              )}
              <HelperText>
                파티 구성원 전원이 <strong className="font-semibold">참가</strong>
                로 들어갑니다. 안 가는 사람은 일정에서 빼면 됩니다.
              </HelperText>
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
