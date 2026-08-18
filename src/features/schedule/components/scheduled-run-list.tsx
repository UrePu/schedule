"use client";

import { CalendarCheck, TriangleAlert, UserRound } from "lucide-react";
import { useMemo, useState } from "react";

import { BossCard, MesoAmount, NumericText, kstWeekdayKo } from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonGroup,
  type StatusTone,
} from "@/components/ui";
import { participantAltCharacterName } from "@/lib/domain/participant-label";
import { formatKst } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type {
  PersonId,
  RunCharacterOption,
  RunId,
  RunParticipant,
  ScheduledRun,
} from "@/types/domain";

/**
 * 등록된 보스 일정 목록 (§1.4 오른쪽).
 *
 * ★ 카드에 붙는 번호는 **등록 번호**이며 재배열하지 않는다. 시드 데이터의 번호가
 *   1, 2, **4** 인 것은 3번 일정이 사라졌기 때문이고, 그게 정상이다 (§1.4).
 *
 * ★ **참가자는 사람이 아니라 캐릭터 단위로 읽힌다.** 주간 결정석 12개 상한이
 *   **캐릭터당**이라(§1) "라이언이 간다"만으로는 어느 카운터에 쌓이는지 알 수 없다.
 *   그래서 각 행이 `이름 · 캐릭터명` 이고, 캐릭터가 비어 있으면 그 사실을 그대로 보인다
 *   (남이 대신 넣어 준 참가 의사에는 캐릭터가 없는 것이 **정상**이다).
 *
 * ★ **이 화면은 분배를 계산하지 않는다.** 금액은 서버가 DB `distribute_meso()` 로 낸
 *   `run.viewerShareMeso` 를 그대로 쓴다. 여기서 `floor(가격 / 인원)` 을 다시 적으면
 *   1/n 규칙의 두 번째 구현이 생겨, `share_mode = 'manual'` 인 런(칼로스 33:67)에서
 *   화면이 실제 약정과 다른 금액을 말한다 — 실제로 그랬다. 웹과 카톡 봇이 같은 답을
 *   내야 하므로 구현은 DB 에 하나만 있어야 한다.
 *
 * ★ 하단 합계는 §1.3 D4 를 그대로 따른다 — 가격 미확인 건은 **합계에 0 으로 더하지 않고**
 *   "N건 제외"로 따로 보고한다.
 *
 * ★ 목록 위의 **도는 차례 띠**는 등록 폼의 미리보기와 **같은 어휘(줄임말)**를 쓴다.
 *   등록 전에 `21:00 익세 · 21:30 하대 · 22:00 하카` 를 보고 눌렀는데 등록 후 목록이
 *   다른 이름으로 말하면 같은 것을 확인하고 있다는 감각이 끊긴다. 파티 제목
 *   (`익세 하대 하카 2인`)과도 같은 어휘다 — 줄임말의 출처가 `boss_difficulties.short_name`
 *   하나이기 때문에 세 화면이 저절로 일치한다.
 *   ⚠️ 카드 제목에는 줄임말을 쓰지 않는다. 카드는 난이도 라벨을 **따로** 그리므로
 *      "하드 / 하카"가 되어 난이도를 두 번 말하게 된다.
 */

const SIGNUP_STATUS_LABEL: Record<RunParticipant["status"], string> = {
  going: "참가",
  maybe: "미정",
  declined: "불참",
};

export interface ScheduledRunListProps {
  readonly runs: readonly ScheduledRun[];
  readonly now: Date;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** 일정은 **파티에 속한다.** 어느 파티 목록인지 밝힌다. */
  readonly partyName: string | null;
  /** 열람자 본인(`app_users.id`). 비로그인은 null. */
  readonly viewerPersonId: PersonId | null;
  /** 참가 신청에 쓸 수 있는 내 추적 캐릭터 (§2.1.1). */
  readonly characters: readonly RunCharacterOption[];
  readonly onSignup: (runId: RunId, characterId: string) => void;
  /** 신청 중인 런. 버튼 하나만 로딩으로 만들기 위해 런 id 로 받는다. */
  readonly signupPendingRunId: RunId | null;
  readonly signupError: Error | null;
}

function toStatusTone(status: ScheduledRun["status"]): StatusTone | undefined {
  if (status === "done") return "done";
  if (status === "cancelled") return "failed";
  return undefined;
}

/**
 * 런 한 건의 참가자 목록 + 본인 참가 신청.
 *
 * 캐릭터 선택 상태를 **런마다** 따로 들고 있어야 한다 — 같은 사람이 런마다 다른
 * 캐릭터로 갈 수 있고(그게 12개 상한을 여러 캐릭터에 나눠 쓰는 정상적인 운영이다),
 * 하나의 전역 선택으로 묶으면 그 사용법이 막힌다.
 */
function RunParticipants({
  run,
  viewerPersonId,
  characters,
  onSignup,
  isPending,
}: {
  readonly run: ScheduledRun;
  readonly viewerPersonId: PersonId | null;
  readonly characters: readonly RunCharacterOption[];
  readonly onSignup: (runId: RunId, characterId: string) => void;
  readonly isPending: boolean;
}) {
  const mine =
    viewerPersonId === null
      ? null
      : (run.participants.find(
          (participant) => participant.personId === viewerPersonId,
        ) ?? null);

  const [draftCharacterId, setDraftCharacterId] = useState<string>("");
  const effectiveCharacterId =
    draftCharacterId !== ""
      ? draftCharacterId
      : (mine?.characterId ?? characters[0]?.characterId ?? "");

  const canSignup =
    viewerPersonId !== null && characters.length > 0 && !isPending;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-ink-label">
        {viewerPersonId === null
          ? "참가자"
          : `참가자 ${run.participants.length}명`}
      </p>

      {viewerPersonId === null ? (
        /*
          ★ 비로그인에게는 서버가 참가자를 **아예 주지 않는다**(공개면을 넓히지 않는다).
            그런데 여기서 "아직 참가 의사를 밝힌 사람이 없습니다"를 그리면 **사실이 아닌
            문장**이 된다 — 사람이 있는데 우리가 안 보여 주는 것뿐이다. 빈 상태와
            비공개 상태는 다른 말이어야 한다.
        */
        <p className="text-body-sm text-ink-muted">
          참가자와 캐릭터는 로그인 후 볼 수 있습니다.
        </p>
      ) : run.participants.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          아직 참가 의사를 밝힌 사람이 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {run.participants.map((participant) => {
            /*
              `더저(메검메)` — 본캐로 가면 이름 하나, 부캐로 가면 괄호가 붙는다.
              조합 규칙은 `lib/domain/participant-label.ts` 가 소유한다. 여기 쓰는 캐릭터는
              **런 단위**(`run_signups.character_id`)다 — 파티엔 부캐로 있어도 이 런만
              본캐로 나갈 수 있고, 그때 이 줄은 `더저` 로 보여야 맞다.
            */
            const altCharacterName = participantAltCharacterName(participant);
            return (
            <li
              key={participant.signupId}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body-sm text-ink"
            >
              <span className="text-caption text-ink-muted tabular-nums">
                #{participant.seatNo}
              </span>
              <span className="font-medium">
                {participant.displayName}
                {altCharacterName === null ? null : (
                  <span className="font-normal text-ink-muted">
                    ({altCharacterName})
                  </span>
                )}
              </span>
              {participant.characterName === null ? (
                /*
                  캐릭터 미지정은 **에러가 아니다** — 남이 대신 넣어 준 참가 의사에는
                  그 사람이 어느 캐릭터로 갈지 알 방법이 없다. 다만 12개 상한이
                  캐릭터당이라 이 상태로는 수익이 귀속되지 않으므로 눈에는 띄어야 한다.
                  주황(§4 임박·주의)의 의미는 배경과 아이콘이 지고 문장은 잉크가 진다.
                */
                <span className="inline-flex items-center gap-1 rounded-md border border-chip-soon-border bg-chip-soon-bg px-1.5 py-0.5 text-caption text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={12}
                    className="shrink-0 text-tertiary"
                  />
                  캐릭터 미지정
                </span>
              ) : participant.worldName === null ? null : (
                /*
                  캐릭터 이름은 위 `본캐(부캐)` 가 이미 말했다. 여기서 또 적으면
                  본캐로 갈 때 `더저 더저` 가 된다 — 남는 정보는 월드뿐이다.
                */
                <span className="text-body-sm text-ink-muted">
                  {participant.worldName}
                </span>
              )}
              {participant.status === "going" ? null : (
                <span className="text-caption text-ink-muted">
                  ({SIGNUP_STATUS_LABEL[participant.status]})
                </span>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {viewerPersonId === null ? null : characters.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          추적 중인 캐릭터가 없어 참가 신청을 할 수 없습니다.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`signup-${run.runId}`}>
            {run.bossKoreanName} 참가 캐릭터
          </label>
          <select
            id={`signup-${run.runId}`}
            value={effectiveCharacterId}
            onChange={(event) => setDraftCharacterId(event.target.value)}
            className={cn(
              "h-control-sm min-w-0 flex-1 rounded-md border border-border bg-surface px-2",
              "text-body-sm text-ink transition duration-200 outline-none",
              "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
            )}
          >
            {characters.map((entry) => (
              <option key={entry.characterId} value={entry.characterId}>
                {entry.name}
                {entry.worldName === null ? "" : ` · ${entry.worldName}`}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canSignup || effectiveCharacterId === ""}
            onClick={() => {
              if (effectiveCharacterId === "") return;
              onSignup(run.runId, effectiveCharacterId);
            }}
          >
            <UserRound aria-hidden size={14} />
            {isPending
              ? "저장 중…"
              : mine === null
                ? "이 캐릭터로 참가"
                : "캐릭터 변경"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function ScheduledRunList({
  runs,
  now,
  isLoading,
  isError,
  onRetry,
  partyName,
  viewerPersonId,
  characters,
  onSignup,
  signupPendingRunId,
  signupError,
}: ScheduledRunListProps) {
  // 더하기만 한다. 나누는 일은 전부 DB(`distribute_meso`)가 이미 끝냈다.
  const summary = useMemo(() => {
    let knownTotal = 0;
    let unknownCount = 0;
    for (const run of runs) {
      if (run.viewerShareMeso === null) {
        unknownCount += 1;
      } else {
        knownTotal += run.viewerShareMeso;
      }
    }
    return { knownTotal, unknownCount };
  }, [runs]);

  /**
   * 도는 차례 — 시각 + 줄임말. 시각 미정(`scheduledAt === null`)은 조율 중이라 뺀다.
   * 요일을 함께 적는 이유: 한 주 목록이라 `21:00` 만으로는 어느 날인지 알 수 없다.
   */
  const sequence = useMemo(
    () =>
      runs.flatMap((run) =>
        run.scheduledAt === null
          ? []
          : [
              {
                runId: run.runId,
                shortName: run.shortName,
                label: `${kstWeekdayKo(run.scheduledAt)} ${formatKst(run.scheduledAt, "HH:mm")}`,
              },
            ],
      ),
    [runs],
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarCheck aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">등록된 일정</CardTitle>
          {partyName ? (
            <span
              className="max-w-40 truncate text-body-sm text-ink-muted"
              title={partyName}
            >
              · {partyName}
            </span>
          ) : null}
        </div>
        <span className="text-body-sm text-ink-muted tabular-nums">
          {runs.length}건
        </span>
      </div>

      {isError ? (
        <ErrorState
          title="일정을 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
        />
      ) : isLoading ? (
        <SkeletonGroup label="일정을 불러오는 중">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </SkeletonGroup>
      ) : runs.length === 0 ? (
        <EmptyState
          title="등록된 일정이 없습니다"
          description="왼쪽에서 겹치는 시간대를 고르고 위 폼으로 등록하면 여기에 번호와 함께 쌓입니다."
        />
      ) : (
        <>
          {signupError ? (
            <ErrorState
              title="참가 신청을 저장하지 못했습니다"
              detail={signupError.message}
              className="py-6"
            />
          ) : null}

          {/* 도는 차례 — 2건 이상일 때만. 1건이면 아래 카드가 이미 그 정보다. */}
          {sequence.length > 1 ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3">
              <span className="text-caption text-ink-label">
                도는 차례 · {sequence.length}건
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {sequence.map((entry) => (
                  <li
                    key={entry.runId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pr-2.5 pl-2"
                  >
                    <NumericText className="text-caption text-ink-label">
                      {entry.label}
                    </NumericText>
                    <span className="text-body-sm text-ink">
                      {entry.shortName}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <ul className="flex flex-col gap-3">
            {runs.map((run) => (
              <li key={run.runId}>
                <BossCard
                  bossName={run.bossKoreanName}
                  bossDifficultyId={run.bossDifficultyId}
                  difficulty={run.difficulty}
                  seatNo={run.runNo}
                  scheduledAt={run.scheduledAt ?? undefined}
                  now={now}
                  crystalPrice={run.crystalPriceMeso}
                  partySize={run.entryPartySize}
                  status={toStatusTone(run.status)}
                  footer={
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                      <RunParticipants
                        run={run}
                        viewerPersonId={viewerPersonId}
                        characters={characters}
                        onSignup={onSignup}
                        isPending={signupPendingRunId === run.runId}
                      />
                      {run.note ? (
                        // 사용자가 직접 쓴 본문이다. 14px 하한을 지킨다.
                        <p className="text-body-sm text-ink-muted">{run.note}</p>
                      ) : null}
                    </div>
                  }
                />
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-caption text-ink-label">
                예상 결정석 수익 합계
              </span>
              <MesoAmount
                value={summary.knownTotal}
                compact
                tone="accent"
                className="text-body-sm font-semibold"
              />
            </div>
            {summary.unknownCount > 0 ? (
              /*
                경고의 의미(주황, §4)는 **틴트 배경과 아이콘**이 지고 문장은 잉크가 진다.
                `text-tertiary` 로 문장을 그리면 라이트에서 2.80:1 로 AA 미달이다
                (다크는 7.82:1 이라 다크만 확인하면 놓친다). 대시보드의 같은 문구와
                동일한 처리다 — 같은 사실을 두 화면이 다르게 그리면 안 된다.
              */
              <p className="mt-1 flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                <TriangleAlert
                  aria-hidden
                  size={16}
                  className="mt-0.5 shrink-0 text-tertiary"
                />
                <span>
                  가격 미확인 {summary.unknownCount}건은 합계에서 제외했습니다
                  (0 으로 더하지 않습니다 · §1.3 D4).
                </span>
              </p>
            ) : null}
            <p className="text-body-sm text-ink-muted">
              클리어 주차 기준 근사치입니다. 판매를 미루면 인게임 메소와 어긋날
              수 있습니다 (§1.3 D1).
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
