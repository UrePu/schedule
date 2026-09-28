"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { BossIcon } from "@/components/domain";
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
import { cn } from "@/lib/utils";
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
                <p className="flex flex-wrap items-center gap-1.5 text-body-sm text-ink">
                  <Users
                    aria-hidden
                    size={14}
                    className="shrink-0 text-ink-muted"
                  />
                  {members.map((member) => participantLabel(member)).join(", ")}
                </p>
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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 파티 목록 — 이 창이 묻는 **유일한 질문**이다.
 *
 * 이름만으로는 서로 구분되지 않는다(실측된 이름들이 `발벨3인` · `세쌀카2인523` 처럼
 * 보스 줄임말 + 인원이다). 그래서 **구성원 이름을 함께** 그린다 — 발주 지시
 * 2026-09-01: *"파티 고를때 파티원도 다 보이게 해서 해줘 이름이 비슷해서 하나도 모르겠음"*.
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
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
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

  return (
    <ul className="flex flex-col gap-2">
      {parties.map((party) => (
        <li key={party.partyId}>
          <button
            type="button"
            onClick={() => onPick(party.partyId)}
            className={cn(
              "flex w-full flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-left",
              "transition duration-200 hover:border-primary hover:bg-hover-surface",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-body font-semibold text-ink">
                {party.name}
              </span>
              <span className="text-caption tabular-nums text-ink-muted">
                {party.memberCount}명
              </span>
            </span>
            <span className="truncate text-body-sm text-ink-muted">
              {party.members
                .map((member) => member.characterName ?? member.displayName)
                .join(", ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
