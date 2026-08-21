"use client";

import Link from "next/link";

import { BossIcon } from "@/components/domain";
import { BOSS_DIFFICULTY_BORDER_L } from "@/components/domain/boss-difficulty";
import { formatKstFull } from "@/components/domain/kst-format";
import { Button, Dialog, StatusChip } from "@/components/ui";
import { formatRunGroupRange } from "@/lib/domain/run-grouping";
import { formatKst } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type { TimetableParticipant } from "@/features/schedule/types";

import type { TimetableBlock } from "../lib/timetable-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 시간표 블록 상세 — **블록이 못 담는 것을 전부 담는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"이거 클릭하면 저 보스에 대한 상세 모달을 여는걸로 변경해
 * 파티 이름, 파티원, 내 캐릭터 등등 전부다 보여주는식으로"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 모달이 생기면서 **블록의 일이 줄었다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 폭 120px 짜리 블록에 파티명·캐릭터·명단을 다 넣으려다 전부 `익검…` 으로 잘리던 것이
 * 원래 문제였다. 상세가 여기로 오면 블록은 **"무엇을, 언제"** 만 말하면 되고, 그래서
 * 얼굴을 칸 높이에 맞춰 키울 수 있게 됐다(발주 요구의 나머지 절반).
 * 즉 이 둘은 한 쌍의 결정이다 — 모달 없이 얼굴만 키웠다면 블록이 다시 텅 비었을 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 명단은 **파티 명단이 아니라 그 런의 명단**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자 정정(2026-08-20): *"파티 = 보스파티 가 아니고 5명이 한방에 있어도 그중에 3명만
 * 보스를 갈수가있는거라니까?"*. 그래서 여기 나오는 사람은 그 런에 **신청 행이 있는**
 * 사람뿐이고, 불참을 누른 사람도 함께 보여 준다 — "빠진 사람"과 "안 온다고 한 사람"은
 * 다른 사실이라 화면이 둘을 같게 그리면 안 된다.
 *
 * 묶음 안에서 런마다 명단이 다를 수 있다(1보스는 3명, 2보스는 2명). 같으면 **한 번만**
 * 그리고, 다르면 보스마다 붙인다 — 같은 명단을 세 번 반복하면 정작 다른 경우를 못 알아본다.
 */

export interface RunDetailDialogProps {
  /** `null` 이면 닫힌 상태. 블록을 그대로 넘겨받는다. */
  readonly block: TimetableBlock | null;
  readonly onClose: () => void;
}

/** 명단이 같은가 — 사람과 참가 상태가 모두 같아야 같다. */
function sameRoster(
  a: readonly TimetableParticipant[],
  b: readonly TimetableParticipant[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((person, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      other.participantId === person.participantId &&
      other.status === person.status &&
      other.characterName === person.characterName
    );
  });
}

export function RunDetailDialog({ block, onClose }: RunDetailDialogProps) {
  if (block === null) return null;

  const runs = block.runs;
  const first = runs[0];
  const rosterIsShared = runs.every((run) =>
    sameRoster(run.participants, first?.participants ?? []),
  );

  const characterText =
    block.characterNames.length === 0
      ? "지정하지 않음"
      : block.characterNames.join(", ");

  return (
    <Dialog
      open
      onClose={onClose}
      title={block.partyName}
      /*
        시각 범위는 목록 화면·카톡 `!일정` 과 **같은 함수**가 만든다. 끝 시각이 마지막
        런의 시작이 아니라 **끝**이라는 규칙이 그 안에 있고(2026-08-20 정정),
        여기서 다시 적으면 그 교훈이 한 곳에만 남는다.
      */
      description={formatRunGroupRange(runs, null)}
      headerAside={
        block.partyNo === null ? null : (
          <span className="shrink-0 rounded-full bg-primary-subtle px-2 py-0.5 text-caption font-bold tabular-nums text-primary">
            {block.partyNo}파티
          </span>
        )
      }
      footer={
        <Link href={`/schedule?partyId=${encodeURIComponent(block.partyId)}`}>
          <Button variant="ghost">일정 수정하러 가기 →</Button>
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="내 캐릭터">
          {/*
            발주 요구에 명시된 값이라 **맨 위**다. 미지정은 빈칸이 아니라 그렇게 적는다 —
            "지정하지 않음"과 "이름을 못 읽었다"는 다른 사실이고, 전자는 사용자가 고칠 수 있다.
          */}
          <span
            className={cn(
              "text-body-sm",
              block.characterNames.length === 0
                ? "text-ink-muted"
                : "font-semibold text-ink",
            )}
          >
            {characterText}
          </span>
        </Field>

        <Field label={`보스 ${String(runs.length)}`}>
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.runId} className="flex flex-col gap-2">
                <div
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border border-l-4 border-border bg-background px-2.5 py-2",
                    BOSS_DIFFICULTY_BORDER_L[run.difficulty],
                  )}
                >
                  <BossIcon
                    bossDifficultyId={run.bossDifficultyId}
                    difficulty={run.difficulty}
                    size="md"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    {/* 여기서는 줄임말이 아니라 **정식 이름**이다. 폭이 있으니 줄일 이유가 없다. */}
                    <span className="truncate text-body-sm font-semibold text-ink">
                      {run.bossKoreanName}
                    </span>
                    <span className="text-caption tabular-nums text-ink-muted">
                      {formatKst(run.scheduledAt, "HH:mm")} ·{" "}
                      {run.durationMinutes}분
                    </span>
                  </span>
                  {/*
                    클리어 여부. 넥슨 동기화가 `boss_clears.run_id` 로 붙여 준 값을 그대로
                    읽는다 — 여기서 다시 판정하지 않는다(수익 화면과 갈라지면 안 된다).
                    **잡은 시각까지 적는다**: 예정 시각과 다를 수 있고, 그 차이가
                    "밀렸다/일찍 갔다"를 말해 준다.
                  */}
                  {run.clearedAt === null ? (
                    <span className="shrink-0 text-caption text-ink-muted">
                      아직
                    </span>
                  ) : (
                    <StatusChip status="done">
                      {/* `clearedAt` 은 배선 타입이라 ISO 문자열이다(`TimetableRun`). */}
                      {formatKst(new Date(run.clearedAt), "HH:mm")} 클리어
                    </StatusChip>
                  )}
                </div>

                {/* 명단이 런마다 다를 때만 보스 밑에 붙인다(머리말). */}
                {rosterIsShared ? null : (
                  <Roster participants={run.participants} className="pl-2.5" />
                )}
              </li>
            ))}
          </ul>
        </Field>

        {rosterIsShared ? (
          <Field label={`파티원 ${String(first?.participants.length ?? 0)}`}>
            <Roster participants={first?.participants ?? []} />
          </Field>
        ) : null}

        <p className="text-caption text-ink-muted">
          {formatKstFull(block.startsAt)} 시작 · 파티 전체 명단이 아니라{" "}
          <strong className="font-semibold">이 일정에 등록된 사람</strong>입니다.
        </p>
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-overline uppercase text-ink-muted">{label}</h3>
      {children}
    </section>
  );
}

/**
 * 명단.
 *
 * ★ 상태를 **글자로도** 말한다(§4 — 색 단독 금지). 불참은 `failed`(red) 칩을 쓰지 않는다 —
 *   red 는 실패·취소 전용이고, "안 간다고 답했다"는 실패가 아니라 정상적인 답이다.
 *   흐린 글자 + 취소선 없는 표기로 충분히 구분된다.
 */
function Roster({
  participants,
  className,
}: {
  readonly participants: readonly TimetableParticipant[];
  readonly className?: string;
}) {
  if (participants.length === 0) {
    return (
      <p className={cn("text-body-sm text-ink-muted", className)}>
        등록된 사람이 없습니다.
      </p>
    );
  }

  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {participants.map((person) => (
        <li
          key={person.participantId}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5",
            // 나를 먼저 찾을 수 있게 — 색과 굵기 두 채널로 말한다.
            person.isMe ? "bg-primary-subtle" : null,
          )}
        >
          {/*
            관리 번호(§1.4). 재부여하지 않으므로 연속이 아닐 수 있고, 카톡에서 `1번` 으로
            부르는 그 번호와 **같은 값**이다.
          */}
          <span className="w-5 shrink-0 text-caption tabular-nums text-ink-muted">
            {person.memberNo}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "truncate text-body-sm",
                person.isMe ? "font-bold text-primary" : "text-ink",
              )}
            >
              {person.displayName}
              {person.isMe ? <span className="sr-only"> (나)</span> : null}
            </span>
            <span className="truncate text-caption text-ink-muted">
              {person.characterName ?? "캐릭터 미지정"}
            </span>
          </span>
          {person.status === "going" ? (
            <StatusChip status="done">참가</StatusChip>
          ) : person.status === "maybe" ? (
            <StatusChip status="soon">미정</StatusChip>
          ) : (
            <span className="shrink-0 text-caption text-ink-muted">불참</span>
          )}
        </li>
      ))}
    </ul>
  );
}
