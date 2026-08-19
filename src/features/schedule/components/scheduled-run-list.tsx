"use client";

import {
  CalendarCheck,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";

import { BossCard, MesoAmount, NumericText, kstWeekdayKo } from "@/components/domain";
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
  type StatusTone,
} from "@/components/ui";
import { participantAltCharacterName } from "@/lib/domain/participant-label";
import {
  formatRunGroupRange,
  groupConsecutiveRuns,
} from "@/lib/domain/run-grouping";
import {
  formatDayMinute,
  kstDayKey,
  kstMoment,
  minutesFromKstDay,
} from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type {
  PersonId,
  RunCharacterOption,
  RunId,
  RunParticipant,
  ScheduledRun,
  UpdateRunInput,
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
  /**
   * **이 파티에 내가 데려가는 캐릭터** (`party_participants.character_id`).
   *
   * 참가 신청 셀렉트의 기본값이 여기서 온다. 예전에는 아직 캐릭터를 정하지 않은 런에서
   * 곧바로 `characters[0]`(본캐)으로 떨어져, 파티에는 부캐로 들어가 있어도 신청 버튼은
   * 본캐를 집었다 — 등록 폼에 있던 결함과 **같은 결함**이다(§0.2-1).
   *
   * `null` 은 정상 상태다(파티 미선택 · 아직 안 고름 · 게스트). 그때만 본캐로 물러난다.
   */
  readonly partyCharacterId: string | null;
  readonly onSignup: (runId: RunId, characterId: string) => void;
  /** 신청 중인 런. 버튼 하나만 로딩으로 만들기 위해 런 id 로 받는다. */
  readonly signupPendingRunId: RunId | null;
  readonly signupError: Error | null;

  // ── 수정 / 취소·삭제 ─────────────────────────────────────────────────────
  /**
   * 지금 **수정 패널이 열려 있는 런**. `null` 이면 닫혀 있다.
   *
   * ★ 이 상태를 부모가 들고 있는 이유는 화면 밖에 영향이 있기 때문이다 — 겹쳐보기가
   *   이 런을 **점유 계산에서 빼야** 시각을 옮길 후보 시간대가 보인다(§ 마이그레이션 23).
   *   목록 안에 감춰 두면 그 연결이 불가능하다.
   */
  readonly editingRunId: RunId | null;
  readonly onEditingRunIdChange: (runId: RunId | null) => void;
  readonly onSubmitEdit: (input: UpdateRunInput) => void;
  readonly isEditPending: boolean;
  readonly editError: Error | null;
  /**
   * 취소 **또는** 삭제. **어느 쪽인지는 서버가 판정한다** — 클라이언트가 먼저 묻지 않는다
   * (그 사이에 같이 간 사람이 클리어를 체크하면 판정이 뒤집힌다).
   */
  readonly onRemove: (runId: RunId) => void;
  readonly removingRunId: RunId | null;
  readonly removeError: Error | null;
  /**
   * 방금 무엇이 일어났는지. 서버 응답의 `outcome` 을 사람 말로 옮긴 문장이다.
   * `null` 이면 알릴 것이 없다. **취소와 삭제는 결과가 다르므로 반드시 구분해 말한다.**
   */
  readonly removalNotice: string | null;
  readonly onDismissRemovalNotice: () => void;
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
  partyCharacterId,
  onSignup,
  isPending,
}: {
  readonly run: ScheduledRun;
  readonly viewerPersonId: PersonId | null;
  readonly characters: readonly RunCharacterOption[];
  readonly partyCharacterId: string | null;
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
  /**
   * 기본값 우선순위 — 좁은 것부터 넓은 것 순이다.
   *
   *   ① 이 줄에서 **직접 고른** 값 (`draftCharacterId`)
   *   ② 이 런에 **이미 신청한** 캐릭터 (`run_signups.character_id`)
   *   ③ **이 파티에 데려가는** 캐릭터 (`party_participants.character_id`)  ← 새로 추가
   *   ④ 본캐 = 목록 첫 행
   *
   * ③이 없어서 파티에 부캐로 들어가 있어도 신청 셀렉트는 본캐를 집었다. ②가 ③보다
   * 앞인 이유: 런 단위 캐릭터는 이미 **그 런에 대해 내려진 결정**이라 파티 기본값이
   * 덮으면 안 된다(§1 — 런은 사람이 아니라 캐릭터 단위, 특정 런만 다른 캐릭으로
   * 나가는 경우가 실제로 있다).
   */
  const effectiveCharacterId =
    draftCharacterId !== ""
      ? draftCharacterId
      : /*
           ★ 후보는 전부 `characters` 안에서 다시 찾는다. 추적을 끊은 캐릭터가
             `run_signups` · `party_participants` 에 남아 있을 수 있는데, `<select>` 에
             없는 값을 `value` 로 주면 브라우저는 첫 항목을 그리고 상태는 다른 값을
             들고 있어 **보이는 것과 보내는 것이 갈린다.**
        */
        ([mine?.characterId, partyCharacterId].find(
          (candidate) =>
            candidate != null &&
            characters.some((entry) => entry.characterId === candidate),
        ) ??
        characters[0]?.characterId ??
        "");

  const canSignup =
    viewerPersonId !== null && characters.length > 0 && !isPending;

  /*
    ★ **넓은 폭에서는 가로로 편다** (발주자 지시, 2026-08-18 — 등록된 일정이 전체 폭으로
      내려오면서 좁은 칸 기준의 세로 배치가 그대로 늘어졌다). 참가자 목록과 참가 신청
      줄이 `sm` 이상에서 좌우로 나뉘고, **360px 에서는 다시 세로로 접힌다.**
  */
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
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
        /*
          한 줄에 한 명이던 목록을 **wrap 되는 가로 목록**으로 바꾼다. 좁은 폭에서는
          한 명씩 줄바꿈되어 예전과 같은 모양이고, 넓어지면 옆으로 채워진다.
        */
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
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

      </div>

      {viewerPersonId === null ? null : characters.length === 0 ? (
        <p className="text-body-sm text-ink-muted sm:w-64 sm:shrink-0">
          추적 중인 캐릭터가 없어 참가 신청을 할 수 없습니다.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 sm:w-64 sm:shrink-0">
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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 수정 패널 — 카드 안에서 펼쳐진다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 별도 모달이 아니라 **행 안에 펼쳐지는 패널**인 이유는 키 삭제 확인
 * (`credential-manager.tsx`)과 같다 — 어느 일정을 고치는 중인지가 대상 바로 아래에
 * 붙어 있고, 이 화면에 이미 있는 `<dialog>` 들과 Esc·포커스가 다투지 않는다.
 *
 * ── 시각은 **KST 벽시계로** 다룬다 ─────────────────────────────────────────
 * `<input type="date">` + `<input type="time">` 로 받은 값을 `kstMoment(dayKey, 분)` 로
 * 절대 시각으로 바꾼다. 브라우저 로컬 시간대로 `new Date(...)` 를 만들면 해외에서 접속한
 * 사람의 일정이 몇 시간씩 밀린다 — 이 앱의 모든 주차·시각 계산이 KST 못박기다 (§2).
 *
 * ── `run_no` 를 바꾸는 자리는 **없다** (§1.4) ────────────────────────────────
 * 번호는 관리 식별자라 재부여하지 않는다. 폼에 칸이 없으므로 바꿀 수도 없다.
 *
 * ── 보스를 바꾸는 칸도 **없다** ─────────────────────────────────────────────
 * 서버가 `bossDifficultyId` 를 받지 않는다(`UpdateRunInput` 주석). 이미 붙은 클리어가
 * 다른 보스의 수익을 가리키게 되기 때문이고, 보스를 잘못 고른 런은 아직 클리어가 없어
 * **삭제되는** 상태라 지우고 다시 등록하는 편이 싸다.
 */
function RunEditPanel({
  run,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  readonly run: ScheduledRun;
  readonly onSubmit: (input: UpdateRunInput) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean;
  readonly error: Error | null;
}) {
  const dateId = useId();
  const timeId = useId();
  const sizeId = useId();
  const durationId = useId();
  const noteId = useId();
  const undecidedId = useId();

  const initialDayKey =
    run.scheduledAt === null ? "" : kstDayKey(run.scheduledAt);
  const [dayKey, setDayKey] = useState(initialDayKey);
  const [timeText, setTimeText] = useState(() =>
    run.scheduledAt === null
      ? "21:00"
      : formatDayMinute(minutesFromKstDay(run.scheduledAt, initialDayKey)),
  );
  /**
   * "시각 미정" 은 `scheduledAt: null` 이며 **정상 상태**다(겹쳐보기로 조율 중).
   * 날짜 칸을 비우는 것과 구분해 체크박스로 명시한다 — 빈 칸은 "아직 안 골랐다"이지
   * "미정으로 되돌린다"가 아니고, 둘을 합치면 실수로 시각이 지워진다.
   */
  const [undecided, setUndecided] = useState(run.scheduledAt === null);
  const [sizeText, setSizeText] = useState(String(run.entryPartySize));
  const [durationText, setDurationText] = useState(String(run.durationMinutes));
  const [note, setNote] = useState(run.note ?? "");

  /**
   * `HH:mm` → 자정으로부터의 분. 등록 폼(`run-composer`)의 `minutesFromTimeText` 와
   * **같은 규칙**이다 — 두 폼이 같은 값을 다르게 받아들이면 안 된다.
   */
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeText);
  const hours = timeMatch === null ? null : Number.parseInt(timeMatch[1], 10);
  const mins = timeMatch === null ? null : Number.parseInt(timeMatch[2], 10);
  const timeValid =
    hours !== null && mins !== null && hours <= 23 && mins <= 59;
  const startMinutes = timeValid ? hours * 60 + mins : null;

  const size = Number.parseInt(sizeText, 10);
  const sizeValid = Number.isInteger(size) && size >= 1 && size <= 24;
  const duration = Number.parseInt(durationText, 10);
  const durationValid =
    Number.isInteger(duration) && duration >= 5 && duration <= 600;

  const scheduleValid = undecided || (dayKey !== "" && timeValid);
  const canSubmit = scheduleValid && sizeValid && durationValid && !isPending;

  const isCancelled = run.status === "cancelled";

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          runId: run.runId,
          scheduledAt:
            undecided || startMinutes === null
              ? null
              : kstMoment(dayKey, startMinutes),
          entryPartySize: size,
          durationMinutes: duration,
          note: note.trim() === "" ? null : note.trim(),
          /*
            취소된 런은 **먼저 복구해야 고칠 수 있다**(서버가 409 로 거절한다). 사용자에게
            "복구부터 하고 다시 저장"을 시키지 않고 한 요청에 함께 보낸다 — 왕복이 둘로
            늘면 그 사이에 상태가 또 바뀔 수 있다.
          */
          ...(isCancelled ? { cancelled: false as const } : {}),
        });
      }}
    >
      <p className="text-body-sm font-semibold text-ink">
        {run.runNo}번 · {run.bossKoreanName} 수정
      </p>

      {isCancelled ? (
        <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
          <RotateCcw aria-hidden size={16} className="mt-0.5 shrink-0 text-tertiary" />
          <span>
            취소된 일정입니다. 저장하면 <strong className="font-semibold">취소가
            함께 되돌려집니다.</strong>
          </span>
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={dateId}>날짜 (KST)</Label>
          <Input
            id={dateId}
            type="date"
            value={dayKey}
            disabled={undecided}
            invalid={!undecided && dayKey === ""}
            onChange={(event) => setDayKey(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={timeId}>시작 시각 (KST)</Label>
          <Input
            id={timeId}
            type="time"
            step={1800}
            value={timeText}
            disabled={undecided}
            invalid={!undecided && !timeValid}
            onChange={(event) => setTimeText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={sizeId}>파티 인원수</Label>
          <Input
            id={sizeId}
            type="number"
            min={1}
            max={24}
            value={sizeText}
            invalid={!sizeValid}
            onChange={(event) => setSizeText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={durationId}>소요 (분)</Label>
          <Input
            id={durationId}
            type="number"
            min={5}
            max={600}
            step={5}
            value={durationText}
            invalid={!durationValid}
            onChange={(event) => setDurationText(event.target.value)}
          />
        </div>
      </div>

      {/* 디자인 시스템 체크박스를 쓴다 — 날것의 `<input type="checkbox">` 는 이 화면에서
          유일하게 다른 모양이 되고, 라벨 클릭 영역도 여기서 다시 만들어야 한다. */}
      <Checkbox
        id={undecidedId}
        checked={undecided}
        onChange={(event) => setUndecided(event.target.checked)}
        label="시각 미정으로 두기 (겹쳐보기로 조율 중)"
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>메모</Label>
        <Input
          id={noteId}
          value={note}
          maxLength={500}
          placeholder="비워 두면 메모가 지워집니다"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {/*
        인원수는 1/n 의 분모이고 §1.3 D3 이 **사용자가 고칠 수 있어야 한다**고 못박은 값이다.
        `max_party` 초과는 여기서도 막지 않는다(소프트 상한 — §1.3 D5).
      */}
      <HelperText>
        인원수는 실제로 입장한 사람 수이며 결정석이 이 값으로 나뉩니다. 번호(
        {run.runNo}번)와 보스는 바뀌지 않습니다.
      </HelperText>

      {error ? (
        /*
          서버가 409 로 거절하는 두 경우(취소된 런 수정 · 클리어가 붙은 런의 주차 이동)의
          **한국어 문구를 서버가 준다.** 여기서 다시 지어내면 규칙이 두 벌이 된다.
        */
        <HelperText tone="error" role="alert">
          {error.message}
        </HelperText>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isPending ? (
            <>
              <Loader2 aria-hidden size={14} className="animate-spin" />
              저장하는 중…
            </>
          ) : (
            "저장"
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          닫기
        </Button>
      </div>
    </form>
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 취소/삭제 확인 — **무엇이 일어날지 먼저 말하고** 묻는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `credential-manager.tsx` 의 키 삭제 확인과 **같은 규약**이다(§0.2-1):
 * - **진입 버튼은 빨강이 아니다.** 카드마다 빨간 버튼이 늘어서면 진짜 위험과 일상 동작의
 *   구분이 사라진다.
 * - **최종 확인 버튼만 `destructive`.**
 * - 안내 상자는 §4 대로 **주황이 배경·아이콘을 지고 문장은 잉크**가 진다.
 *
 * ★ **어느 쪽이 될지는 서버가 판정한다.** 그래서 확인 문구가 두 갈래를 **둘 다** 밝힌다 —
 *   클리어(또는 드랍)가 붙어 있으면 **취소**되어 기록이 남고, 아니면 **삭제**된다.
 *   클라이언트가 먼저 "클리어 있나요?" 를 물어 한쪽만 말하면, 그 사이에 같이 간 사람이
 *   체크하는 순간 화면이 거짓을 말한 것이 된다.
 */
function RunRemoveConfirmPanel({
  run,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly run: ScheduledRun;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert
          aria-hidden
          size={16}
          className="mt-0.5 shrink-0 text-tertiary"
        />
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-ink">
          {run.runNo}번 · {run.bossKoreanName} 일정을 정리합니다
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-body-sm text-ink">
        {/*
          ★ **문구가 두 원장을 모두 말한다** (§0.2-1, 2026-08-18). 판정 함수
            `runHasIncomeRecords` 는 처음부터 `boss_clears` 와 `run_drops` 를 함께
            봤지만, 드랍을 넣을 방법이 없어 실제로는 항상 클리어만 걸렸다. 드랍 기록
            경로가 생긴 지금 "클리어 기록이 붙어 있으면"만 말하면, 드랍만 있는 일정이
            삭제될 거라 믿은 사용자가 취소된 결과를 보게 된다.
        */}
        <li>
          이 일정에 <strong className="font-semibold">클리어 기록이나 드랍 기록이
          붙어 있으면 취소</strong>됩니다 — 목록에서는 취소로 표시되고 수익 기록은
          그대로 남습니다. 나중에 수정에서 되돌릴 수 있습니다.
        </li>
        <li>
          둘 다 없으면 <strong className="font-semibold">완전히 삭제</strong>됩니다.
          이건 되돌릴 수 없습니다.
        </li>
        <li>
          어느 쪽인지는 <strong className="font-semibold">서버가 판정</strong>하며,
          결과를 바로 알려 드립니다. 빠진 번호는 그대로 비워 둡니다 — 남은 일정의 번호는
          바뀌지 않습니다.
        </li>
      </ul>

      {error ? (
        <HelperText tone="error" role="alert">
          {error.message}
        </HelperText>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? (
            <>
              <Loader2 aria-hidden size={14} className="animate-spin" />
              처리하는 중…
            </>
          ) : (
            <>
              <Trash2 aria-hidden size={14} />
              취소 또는 삭제
            </>
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          그대로 두기
        </Button>
      </div>
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
  partyCharacterId,
  onSignup,
  signupPendingRunId,
  signupError,
  editingRunId,
  onEditingRunIdChange,
  onSubmitEdit,
  isEditPending,
  editError,
  onRemove,
  removingRunId,
  removeError,
  removalNotice,
  onDismissRemovalNotice,
}: ScheduledRunListProps) {
  /**
   * 지금 삭제 확인이 열려 있는 런. **수정 패널과 달리 목록 안에 둔다** — 이 상태는
   * 겹쳐보기에 아무 영향이 없어서(점유 계산과 무관하다) 밖으로 올릴 이유가 없다.
   */
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<RunId | null>(
    null,
  );
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
   * 연속한 런 묶음. 규칙은 `lib/domain/run-grouping.ts` 하나가 갖는다 — 봇 `!일정` 이
   * 같은 함수를 쓰므로 웹과 방이 같은 자리에서 끊긴다.
   *
   * ⚠️ 입력이 **시각 오름차순**이어야 한다. 서버 조회가 이미 그 순서로 준다.
   */
  const runGroups = useMemo(() => groupConsecutiveRuns(runs), [runs]);

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

      {/*
        ★ **서버가 실제로 무엇을 했는지**를 말한다. 취소와 삭제는 결과가 다르므로(하나는
          기록이 남고 하나는 사라진다) "처리했습니다" 로 뭉뚱그리면 사용자는 자기 수익
          기록이 어떻게 됐는지 알 수 없다.
      */}
      {removalNotice === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-chip-done-border bg-chip-done-bg px-3 py-2">
          <p className="min-w-0 flex-1 text-body-sm text-ink">{removalNotice}</p>
          <Button variant="ghost" size="sm" onClick={onDismissRemovalNotice}>
            닫기
          </Button>
        </div>
      )}

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
          description="위 겹쳐보기에서 겹치는 시간대를 고르고 「보스 일정 등록」으로 등록하면 여기에 번호와 함께 쌓입니다."
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

          {/*
            ★ **카드가 전체 폭 행으로 내려오면서 그리드가 됐다** (발주자 지시, 2026-08-18:
              *"그 아래엔 x축까지 꽉차게 등록된 일정 보여주게 변경해"*). 예전에는 24~28rem
              칸 안에서 세로로만 쌓였다.
              1열(모바일) → 2열(`xl`) → 3열(`3xl` 대신 `2xl`)로 늘린다. 더 잘게 쪼개지
              않는 이유는 카드 안에 참가자 줄과 수정 패널이 들어가기 때문이다 — 폭이
              320px 밑으로 떨어지면 그 안이 다시 세로로 길어져 원래 문제로 돌아간다.
            ★ **수정·삭제 패널이 열린 카드는 한 칸을 통째로 쓴다**(`col-span-full`).
              폼이 좁은 칸에 갇히면 날짜·시각·인원·소요 네 칸이 세로로 늘어선다.
          */}
          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
            {runGroups.map((group) => (
            <Fragment key={group[0]?.runId ?? "ungrouped"}>
              {/*
                ★ **연속한 런은 시각 띠 하나로 묶인다** (발주 지시 2026-08-19:
                  *"4개 보스를 선택하면 4개를 묶어서 하나의 보스 일정으로 바꿔줘
                  21:00 ~ 22:00"*). 카드 자체는 건드리지 않는다 — 수정·삭제·분배 패널이
                  전부 카드 안에 살아 있고, 묶음은 그 **위에 띠를 얹는 일**이기 때문이다.
                ★ 끊는 규칙은 `lib/domain/run-grouping.ts` 가 소유한다. 카톡/텔레그램 봇의
                  `!일정` 이 같은 함수를 쓰므로 웹과 봇이 같은 자리에서 끊긴다.
                ★ `col-span-full` — 띠는 그리드 몇 열이든 한 줄을 통째로 쓴다.
              */}
              <li className="col-span-full flex items-center gap-2 pt-1 first:pt-0">
                <span className="text-body-sm font-semibold text-ink">
                  {/*
                    `null` = **날짜를 항상 붙인다.** 이 목록은 한 주치라 오늘 것만 날짜가
                    사라지면 어느 줄이 오늘인지 알 수 없다 — 아래 `sequence` 주석이 이미
                    같은 이유로 요일을 함께 적고 있었다.
                  */}
                  {formatRunGroupRange(group, null)}
                </span>
                {group.length > 1 ? (
                  <span className="text-caption text-ink-muted">
                    보스 {group.length}개 연속
                  </span>
                ) : null}
                <span aria-hidden className="h-px flex-1 bg-border" />
              </li>
              {group.map((run) => {
              const isEditing = editingRunId === run.runId;
              /*
                ★ 결과 문구(`removalNotice`)가 뜨면 확인 패널은 **닫힌 것으로 친다.**
                  effect 없이 파생으로 닫는 방법이다 — 취소(삭제가 아닌)의 경우 그 런이
                  목록에 그대로 남으므로, 이 판정이 없으면 이미 처리된 일정 위에 확인
                  패널이 계속 떠 있게 된다. 다시 열 때는 아래 버튼이 문구를 먼저 지운다.
              */
              const isConfirming =
                confirmingRemoveId === run.runId && removalNotice === null;
              const isBusy = removingRunId === run.runId;

              return (
              <li
                key={run.runId}
                className={cn(
                  (isEditing || isConfirming) &&
                    "xl:col-span-full",
                )}
              >
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
                  /*
                    ★ 카드 **오른쪽 위**의 두 버튼 (발주자 지시: *"저 카드 오른쪽 위 빈
                      부분에 두 버튼 생성해줘"*). 헤더 버튼 규약대로 `secondary` · `sm` ·
                      14px 아이콘 + 한글 라벨이고, **삭제 진입 버튼은 빨강이 아니다**(§4).
                    ★ 비로그인에게는 아예 그리지 않는다 — 쓰기는 전부 401 이라 눌렀을 때
                      막는 것보다 항목을 감추는 편이 맞다(다른 화면과 같은 기조).
                  */
                  actions={
                    viewerPersonId === null ? undefined : (
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          aria-expanded={isEditing}
                          onClick={() => {
                            setConfirmingRemoveId(null);
                            onEditingRunIdChange(isEditing ? null : run.runId);
                          }}
                        >
                          <Pencil aria-hidden size={14} />
                          {isEditing ? "수정 닫기" : "수정"}
                        </Button>
                        {/*
                          ⚠️ 여기 있던 `분배` 버튼은 **파티 편집으로 옮겼다**
                            (2026-08-19 발주자: *"분배조율도 파티 설정에 있어야된다고
                            했잖슴"*). 저장 위치는 원래부터 파티였는데(마이그레이션
                            `20260819200000`) 입구만 일정 카드에 있어서, 이 버튼은
                            "이 보스의 분배"처럼 보이면서 실제로는 파티 전체를 바꾸고
                            있었다. 보이는 것과 저장되는 것이 다른 화면은 반드시 사고가
                            난다 → 위 파티 바의 `파티 편집`.
                        */}
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          aria-expanded={isConfirming}
                          onClick={() => {
                            onEditingRunIdChange(null);
                            // 지난 결과 문구를 먼저 지운다 — 안 그러면 위 파생 판정
                            // 때문에 패널이 열리자마자 닫힌 것으로 계산된다.
                            onDismissRemovalNotice();
                            setConfirmingRemoveId(
                              isConfirming ? null : run.runId,
                            );
                          }}
                        >
                          <Trash2 aria-hidden size={14} />
                          삭제
                        </Button>
                      </div>
                    )
                  }
                  footer={
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                      <RunParticipants
                        run={run}
                        viewerPersonId={viewerPersonId}
                        characters={characters}
                        partyCharacterId={partyCharacterId}
                        onSignup={onSignup}
                        isPending={signupPendingRunId === run.runId}
                      />
                      {run.note ? (
                        // 사용자가 직접 쓴 본문이다. 14px 하한을 지킨다.
                        <p className="text-body-sm text-ink-muted">{run.note}</p>
                      ) : null}

                      {isEditing ? (
                        <RunEditPanel
                          /*
                            `key` 에 런 id 를 넣어 **다른 일정을 열면 새로 마운트**한다.
                            안 그러면 앞 일정의 초안이 그대로 남아 엉뚱한 값이 저장된다
                            (다이얼로그들을 `seq` 로 다시 마운트하는 것과 같은 판단).
                          */
                          key={`run-edit-${run.runId}`}
                          run={run}
                          onSubmit={onSubmitEdit}
                          onCancel={() => onEditingRunIdChange(null)}
                          isPending={isEditPending}
                          error={editError}
                        />
                      ) : null}

                      {isConfirming ? (
                        <RunRemoveConfirmPanel
                          run={run}
                          isPending={isBusy}
                          error={removeError}
                          onCancel={() => setConfirmingRemoveId(null)}
                          onConfirm={() => onRemove(run.runId)}
                        />
                      ) : null}
                    </div>
                  }
                />
              </li>
              );
            })}
            </Fragment>
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
                `text-tertiary` 로 문장을 그리면 라이트에서 2.80:1 로 AA 미달이었다
                (2026-08-19 재산정 후에도 3.93:1 로 미달)
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
