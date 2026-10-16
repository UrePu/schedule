"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Trash2,
  TriangleAlert,
  Undo2,
  UserMinus,
} from "lucide-react";
import { useCallback, useId, useState } from "react";

import { BossIcon } from "@/components/domain";
import { BOSS_DIFFICULTY_BORDER_L } from "@/components/domain/boss-difficulty";
import { formatKstFull } from "@/components/domain/kst-format";
import {
  Button,
  Dialog,
  DurationField,
  ErrorState,
  HelperText,
  Input,
  Label,
  StatusChip,
  useToaster,
} from "@/components/ui";
import {
  DEFAULT_RUN_MINUTES,
  formatRunGroupRange,
} from "@/lib/domain/run-grouping";
import { queryKeys } from "@/lib/query-keys";
import { kstDayKey, kstMoment, minutesFromTimeText } from "@/lib/time/kst-wallclock";
import { formatKst, getWeekKey } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type {
  PersonId,
  RunDurationShift,
  RunId,
  WeekKey,
} from "@/types/domain";
import {
  CLEAR_WONT_LINK_FIX,
  CLEAR_WONT_LINK_REASON,
  type TimetableParticipant,
} from "@/features/schedule/types";

import {
  removePartyRun,
  removePartyRuns,
  saveRunSignup,
  updatePartyRun,
} from "../data";
import type { DayRow } from "../lib/overlay-layout";
import type { TimetableBlock, TimetableRunAt } from "../lib/timetable-layout";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 시간표 블록 상세 — **블록이 못 담는 것을 전부 담고, 손댈 수 있게 한다**
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
 * ★ 2026-09-28 — **조치(옮기기 · 빠지기 · 삭제)가 여기로 들어왔다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `일정 계획`(`/schedule`) 화면이 삭제되면서 `ScheduledRunList` 가 갖고 있던 **시각
 * 이동 · 취소/삭제**와, 참가/불참 전환이 **화면 어디에도 없어졌다.** 서버(`PATCH` ·
 * `DELETE /api/schedule/runs/{id}` · `PUT .../signup` · `POST .../remove-many`)는
 * 그대로 살아 있었으므로 없어진 것은 **누를 곳**뿐이었다 — 잘못 잡은 일정이 영원히
 * 남는 상태였다.
 *
 * 왜 하필 이 창인가: 사용자가 "이 일정 잘못됐다"를 **알아차리는 자리**가 여기다.
 * 블록을 눌러 내용을 확인하는 그 동작이 곧 조치의 진입점이고, 다른 화면으로 보내면
 * 다시 그 일정을 찾아내는 일부터 시켜야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 조치는 **세 가지뿐이고, 각각 영향 범위가 다르다**
 * ─────────────────────────────────────────────────────────────────────────────
 * | 조치        | 누구에게 영향 | 되돌리기                                   |
 * |-------------|---------------|--------------------------------------------|
 * | 시각 옮기기 | 파티 전원     | 다시 옮기면 된다                           |
 * | 빠지기      | **나만**      | 결과 화면의 `되돌리기`(§ 아래 주의)        |
 * | 삭제/취소   | 파티 전원     | **없다** → 그래서 확인을 한 번 받는다      |
 *
 * ⚠️ **빠지기는 이 창에서 한 방향뿐이다.** 시간표는 `status = 'going'` 인 런만 그리므로
 *    (`timetable-repo` 의 조회 조건) 불참으로 바꾸는 순간 그 블록이 격자에서 사라지고,
 *    다시 들어올 입구가 화면에 남지 않는다. 그래서 **창을 닫지 않고 결과와 `되돌리기`를
 *    같이 띄운다** — 되돌리기는 사라진 블록이 아니라 방금 바꾼 런 id 를 들고 있어
 *    블록이 없어진 뒤에도 동작한다. 창을 닫으면 그 길도 닫히므로 문구로 먼저 말한다.
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
  /**
   * 이번 주 날짜 칸(목→수). **시각 옮기기의 요일 선택지**이며 부모가 이미 갖고 있다
   * (`buildDayRows(range)`). 여기서 다시 만들면 격자와 다른 주를 그릴 수 있다.
   */
  readonly days: readonly DayRow[];
  /**
   * 열람자 본인(`app_users.id`). `null` 이면 **조치 구획을 아예 그리지 않는다** —
   * 쓰기는 전부 401 이고, 닿을 수 없는 버튼을 띄워 두는 것은 나쁜 동선이다.
   */
  readonly viewerPersonId: PersonId | null;
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

/** 확인을 기다리는 삭제 대상. `null` = 확인 패널이 닫혀 있다. */
type PendingRemoval =
  | { readonly kind: "block" }
  | { readonly kind: "run"; readonly runId: RunId };

/**
 * 방금 빠진 일정 — **블록이 사라진 뒤에도 되돌릴 수 있게** 들고 있는 스냅샷.
 *
 * 런 id 와 캐릭터만 담는다. 블록 객체를 통째로 들면 재조회 때 낡은 명단을 계속
 * 보여 주게 되는데(머리말 `openKey` 와 같은 함정), 되돌리기에 필요한 것은 이 둘뿐이다.
 */
interface LeftSnapshot {
  readonly partyName: string;
  readonly rangeText: string;
  readonly runIds: readonly RunId[];
  readonly characterId: string;
  readonly weekKeys: readonly WeekKey[];
  readonly partyId: string;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 소요 시간을 고친 뒤 **뒤 런이 어떻게 됐는지** 말하는 안내
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **말하지 않으면 사용자는 시간표가 왜 겹쳐 보이는지 모른다.** 보스 1이 20→40 으로
 *    늘면 같은 묶음의 보스 2는 20분 뒤로 밀리는데(서버가 민다), **클리어·드랍이 붙은
 *    런은 밀지 않는다** — 이미 끝난 일이고 수익이 그 시각의 주차에 매여 있다(§1.3 D1).
 *    그래서 밀리지 않은 런만 제자리에 남아 블록이 겹치고, 시간표는 겹친 블록을 자리를
 *    반씩 나눠 쓰도록 그리므로 증상이 조용하지도 않다. 원인을 아는 쪽은 서버뿐이고
 *    (`durationShift.keptRunIds`), 그 사실을 옮기는 자리가 여기다.
 *
 * ★ 토스트가 아니라 **창 안에 남긴다.** 밀린 결과는 바로 위 보스 목록에서 눈으로
 *   확인하는 것이고, 창을 닫을 때까지 근거가 남아 있어야 한다. 토스트는 몇 초 뒤
 *   사라져 "왜 시간이 바뀌었지"가 다시 미궁이 된다.
 */
interface DurationNotice {
  readonly bossName: string;
  readonly minutes: number;
  readonly shift: RunDurationShift | null;
}

/**
 * 안내 문장.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **두 배열을 따로 판단한다.** 하나로 묶으면 안내가 스스로와 모순된다.
 *   ═══════════════════════════════════════════════════════════════════════════
 *   2026-10-11 결함: 첫 줄의 조건이 `shiftedRunIds.length === 0` **하나**였다. 뒤 런이
 *   **전부** 클리어·드랍이면 서버는 `shiftedRunIds: []` + `keptRunIds: [...]` 를 주는데
 *   (도달 가능 확인됨), 그때 화면이 두 줄을 나란히 적었다:
 *     `뒤따르는 일정이 없어 다른 일정은 그대로입니다.`   ← 거짓
 *     `클리어·드랍이 기록된 2건은 밀지 않았습니다 — …`
 *   게다가 그 경우가 **뒤 런이 제자리에 남아 반드시 겹치는 유일한 상황**, 즉 사용자가
 *   가장 조치해야 하는 상황이다. 그래서:
 *     · 밀린 것이 있으면 그 줄을 적고,
 *     · 밀지 않은 것이 있으면 그 줄을 적고 — **하나도 못 밀었으면 "겹칠 수 있다"가
 *       아니라 "겹친다"고 단정한다.** 추측이 아니라 확정된 사실이다.
 *     · 둘 다 없을 때만 "뒤따르는 일정이 없다"고 적는다.
 */
function durationShiftLines(notice: DurationNotice): readonly string[] {
  const lines: string[] = [
    `${notice.bossName} 를 ${String(notice.minutes)}분으로 바꿨습니다.`,
  ];
  const shift = notice.shift;
  const shiftedCount = shift?.shiftedRunIds.length ?? 0;
  const keptCount = shift?.keptRunIds.length ?? 0;

  if (shiftedCount > 0 && shift !== null) {
    const delta = shift.deltaMinutes;
    lines.push(
      `같은 묶음의 뒤 일정 ${String(shiftedCount)}건이 ${String(
        Math.abs(delta),
      )}분 ${delta >= 0 ? "뒤로" : "앞으로"} 밀렸습니다. 파티 전원의 일정이 함께 바뀝니다.`,
    );
  }

  if (keptCount > 0) {
    /*
      ⚠️ 이 줄이 이 안내의 존재 이유다. 빼면 사용자는 겹친 블록만 보고 원인을 모른다.
    */
    lines.push(
      shiftedCount === 0
        ? `뒤 일정 ${String(keptCount)}건이 전부 클리어·드랍 기록이 있어 하나도 밀지 못했습니다 — 수익이 그 시각의 주차에 매여 있습니다. 시간이 겹치니 직접 옮기거나 그대로 두세요.`
        : `그중 클리어·드랍이 기록된 ${String(keptCount)}건은 밀지 않았습니다 — 수익이 그 시각의 주차에 매여 있습니다. 시간이 겹칠 수 있으니 필요하면 직접 옮겨 주세요.`,
    );
  }

  if (shiftedCount === 0 && keptCount === 0) {
    lines.push("뒤따르는 일정이 없어 다른 일정은 그대로입니다.");
  }
  return lines;
}

/** 삭제·취소 결과를 한 문장으로. **서버가 실제로 무엇을 했는지**를 그대로 옮긴다. */
function removalMessage(deleted: number, cancelled: number): string {
  const total = deleted + cancelled;
  if (cancelled === 0) {
    return `일정 ${String(total)}건을 삭제했습니다. 빠진 번호는 그대로 비워 둡니다.`;
  }
  if (deleted === 0) {
    return `${String(total)}건 모두 클리어·드랍 기록이 있어 삭제하지 않고 취소했습니다. 수익 기록은 그대로 남습니다.`;
  }
  return `${String(total)}건 중 ${String(deleted)}건을 삭제하고, ${String(cancelled)}건은 클리어·드랍 기록이 있어 취소했습니다.`;
}

/** 런들이 걸친 주차 전부. 묶음은 목요일 초기화를 넘을 수 있다(수 23:40 ~ 목 00:20). */
function weekKeysOf(runs: readonly TimetableRunAt[]): readonly WeekKey[] {
  return [...new Set(runs.map((run) => getWeekKey(run.scheduledAt)))];
}

export function RunDetailDialog({
  block,
  onClose,
  days,
  viewerPersonId,
}: RunDetailDialogProps) {
  const queryClient = useQueryClient();
  /*
    ★ 결과는 **토스트로** 말한다. 창 안의 한 줄로 두면 수명이 창에 묶이는데, 삭제하면
      블록의 키가 바뀌거나(보스 하나만 삭제) 창이 닫히므로(묶음 삭제) 정작 결과를
      말해야 하는 순간에 문구가 사라진다. 등록 창이 이미 같은 이유로 토스트를 쓴다.
  */
  const toaster = useToaster();
  const dayFieldId = useId();
  const timeFieldId = useId();

  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(
    null,
  );
  /** 시각 옮기기 폼. `null` = 접혀 있다. */
  const [moveForm, setMoveForm] = useState<{
    readonly dayKey: string;
    readonly timeText: string;
  } | null>(null);
  const [left, setLeft] = useState<LeftSnapshot | null>(null);
  /** 소요 시간을 고친 결과. `null` = 아직 고치지 않았다. */
  const [durationNotice, setDurationNotice] = useState<DurationNotice | null>(
    null,
  );

  const blockKey = block?.key ?? null;

  /*
    ── 다른 블록을 열면 직전 창에서 하던 것은 **전부 지난 일**이다 ──────────────
    확인 패널이 열린 채로 남으면 **다른 일정에 대한 확인을 그대로 누르게** 되므로
    특히 위험하다.

    ★ `useEffect` 가 아니라 **렌더 중 조정**이다(React 공식 "Adjusting state when a
      prop changes"). effect 로 하면 잘못된 내용을 한 번 그린 뒤 지우는 셈이라 확인
      패널이 한 프레임 깜빡이고, 린트도 그 이유로 막는다(`set-state-in-effect`).
    ★ `blockKey` 만 본다 — 블록 **객체**는 재조회마다 참조가 갈리므로 그것을 기준으로
      삼으면 60초마다 사용자가 하던 조작이 초기화된다.
  */
  const [seenKey, setSeenKey] = useState<string | null>(blockKey);
  if (blockKey !== null && blockKey !== seenKey) {
    setSeenKey(blockKey);
    setPendingRemoval(null);
    setMoveForm(null);
    setLeft(null);
    /* 다른 블록의 안내가 남으면 **방금 안 고친 일정을 고쳤다고** 말하게 된다. */
    setDurationNotice(null);
  }

  /**
   * ★ **한 번의 일정 변경이 움직이는 것 전부** (§2.4 Rule 5).
   *
   * ⚠️ `runs.timetable(weekKey)` 는 `runs.list(partyId, weekKey)` 의 **형제**다.
   *    접두사가 겹친다고 자동으로 덮이지 않는다 — 2026-08-20 에 정확히 이 함정으로
   *    일정을 만들어도 시간표가 갱신되지 않았다. **지금 보고 있는 화면이 시간표라**
   *    이 줄이 빠지면 조치 결과가 눈앞에서 보이지 않는다.
   * ⚠️ 주차를 **집합으로** 받는다. 시각을 다음 주로 옮기면 이번 주에서 사라지고 다음 주에
   *    나타나므로 두 주차를 모두 날려야 한쪽이 유령 항목을 들고 남지 않는다.
   * ★ `income.root()` 까지 날린다 — 참가 인원과 입장 인원이 바뀌면 분배 몫이 다시
   *   계산된다(`distribute_meso`). 금액을 화면이 다시 적지 않으므로 무효화가 유일한 길이다.
   */
  const invalidateRunChange = useCallback(
    (partyId: string, weekKeys: readonly WeekKey[]) => {
      for (const key of new Set(weekKeys)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.runs.list(partyId, key),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.party.mine(key),
        });
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
    },
    [queryClient],
  );

  /**
   * 삭제 또는 취소 — **어느 쪽인지는 서버가 판정한다**(`removePartyRun` 머리말).
   *
   * ⚠️ **낙관적으로 처리하지 않는다.** 클라이언트가 "클리어 붙었나요?"를 먼저 묻고 다시
   *    부르는 왕복을 만들면 그 사이에 같이 간 사람이 클리어를 체크하는 순간 판정이
   *    뒤집힌다. 응답의 `outcome` 이 말해 주는 것을 그대로 옮긴다.
   * ★ 낱개와 묶음이 **같은 판정**을 쓴다(서버의 `applyRunRemoval` 하나). 그래서 여기서는
   *   대상 개수만 보고 경로를 고른다.
   */
  const removeRuns = useMutation({
    mutationFn: async (runIds: readonly RunId[]) => {
      const single = runIds.length === 1 ? runIds[0] : null;
      if (single !== undefined && single !== null) {
        const result = await removePartyRun(single);
        return {
          partyId: result.partyId,
          weekKeys: [result.weekKey] as readonly WeekKey[],
          deleted: result.outcome === "deleted" ? 1 : 0,
          cancelled: result.outcome === "cancelled" ? 1 : 0,
        };
      }
      const result = await removePartyRuns(runIds);
      return {
        partyId: result.partyId,
        weekKeys: result.weekKeys,
        deleted: result.deletedCount,
        cancelled: result.cancelledCount,
      };
    },
    onSuccess: (result, runIds) => {
      invalidateRunChange(result.partyId, result.weekKeys);
      setPendingRemoval(null);
      /*
        ★ **서버가 실제로 무엇을 했는지**를 그대로 옮긴다. 취소는 기록이 남고 삭제는
          사라진다 — "처리했습니다" 로 뭉뚱그리면 사용자는 자기 수익 기록이 어떻게
          됐는지 알 수 없다.
      */
      toaster.notify({
        tone: "success",
        title:
          result.cancelled > 0 && result.deleted === 0
            ? "일정을 취소했습니다"
            : "일정을 지웠습니다",
        description: removalMessage(result.deleted, result.cancelled),
      });
      /*
        묶음을 통째로 지웠으면 그릴 것이 남지 않는다 → 창을 닫는다. 보스 하나만 지웠으면
        남은 보스가 그대로 있으므로 **창을 열어 둔다** — 연달아 손보는 흐름이 끊기지 않는다.
      */
      if (block === null || runIds.length >= block.runs.length) onClose();
    },
  });

  /**
   * 내 참가 상태 — **내 서명만 바꾼다.** 남의 신청 행은 건드리지 않는다.
   *
   * ★ 런마다 한 번씩 부른다. `saveRunSignup` 은 `(run_id, participant_id)` 단건 upsert 이고,
   *   묶음 경로를 새로 만들 이유가 없다(한 묶음은 보통 2~5건이다).
   * ★ 캐릭터를 **반드시 실어 보낸다**(§1 — 12칸은 캐릭터당으로 센다). 시간표가 이미
   *   그 런에 내가 데려가는 캐릭터 id 를 들고 있으므로 새로 묻지 않는다.
   */
  const setSignupStatus = useMutation({
    mutationFn: async (input: {
      readonly runIds: readonly RunId[];
      readonly characterId: string;
      readonly status: "going" | "declined";
    }) => {
      for (const runId of input.runIds) {
        await saveRunSignup({
          runId,
          characterId: input.characterId,
          status: input.status,
        });
      }
      return input;
    },
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 보스 한 판의 **소요 시간** 고치기 (발주 지시 2026-10-11)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 원문: *"이 부분은 이미 잡혀있는 일정에서도 볼수있어야되고 수정할수있어야하며"*.
   * 그 전까지 이 창은 `{run.durationMinutes}분` 을 **읽기만** 했다.
   *
   * ★ 서버가 하는 일이 셋이다(§ `UpdateRunInput.durationMinutes`):
   *   ① 그 런의 길이를 바꾸고,
   *   ② **같은 묶음의 뒤따르는 런을 민다**(클리어·드랍이 붙은 런은 빼고),
   *   ③ 고친 값을 **파티에도 저장한다**(`party_bosses.duration_minutes`) —
   *      *"한번 수정되면 저장되어 항상 이용되도록"*.
   *
   * ⚠️ 무효화는 **`durationShift.weekKeys` 까지** 날린다. 묶음이 KST 목요일 00:00 경계를
   *    넘으면 밀린 런이 **다른 주차**로 가므로, 응답의 `weekKey` 하나만 날리면 반대쪽
   *    주차의 시간표가 유령 블록을 들고 남는다(§2.4 Rule 5 — `runs.timetable(weekKey)`
   *    는 `runs.list(...)` 의 형제라 접두사로 따라오지 않는다. `invalidateRunChange` 가
   *    주차마다 그 키를 직접 짚는다).
   * ⚠️ ③ 때문에 **`party.bosses(partyId)` 도 날린다.** 일정 잡기 창이 그 키로 보스별
   *    소요 시간을 읽으므로, 빼먹으면 방금 고친 값이 60초 동안 옛 값으로 보인다.
   * ⚠️ 뒤에 **다른 파티의 런**이 있어 밀 수 없으면 서버가 **409** 로 거절하고 어느 런과
   *    부딪히는지 문구에 적는다. `request()` 가 그 문구를 `Error.message` 로 올리므로
   *    화면은 아래 `ErrorState` 로 **그대로** 보여 준다 — "실패했습니다"로 뭉개지 않는다.
   */
  const changeDuration = useMutation({
    mutationFn: (input: {
      readonly runId: RunId;
      readonly durationMinutes: number;
      readonly bossName: string;
    }) =>
      updatePartyRun({
        runId: input.runId,
        durationMinutes: input.durationMinutes,
      }),
    onSuccess: (result, input) => {
      const weekKeys = new Set<WeekKey>([
        result.weekKey,
        result.previousWeekKey,
        ...(result.durationShift?.weekKeys ?? []),
      ]);
      invalidateRunChange(result.partyId, [...weekKeys]);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.bosses(result.partyId),
      });
      setDurationNotice({
        bossName: input.bossName,
        minutes: input.durationMinutes,
        shift: result.durationShift,
      });
    },
  });

  /**
   * 시각 옮기기 — **묶음 전체를 같은 간격만큼 민다.**
   *
   * ★ 상대 간격을 보존한다. 22:00·22:20·22:40 을 23:00 으로 옮기면 23:00·23:20·23:40 이다.
   *   맨 앞만 옮기면 묶음이 흩어져 "이어 도는 한 덩어리"라는 블록의 전제가 깨진다.
   * ⚠️ 런마다 `PATCH` 가 한 번씩 나가므로 **중간에 서버가 거절하면 앞의 것만 옮겨진
   *    상태**가 될 수 있다(클리어·드랍이 붙은 런의 주차 이동은 409). 그래서 실패해도
   *    무효화를 돌려 **화면이 진실을 보여 주게** 한다 — 성공한 척도, 실패한 척도 하지 않는다.
   */
  const moveRuns = useMutation({
    mutationFn: async (input: {
      readonly moves: readonly { readonly runId: RunId; readonly at: Date }[];
    }) => {
      const weekKeys = new Set<WeekKey>();
      let partyId: string | null = null;
      for (const move of input.moves) {
        const result = await updatePartyRun({
          runId: move.runId,
          scheduledAt: move.at,
        });
        weekKeys.add(result.weekKey);
        weekKeys.add(result.previousWeekKey);
        partyId = result.partyId;
      }
      return { partyId, weekKeys: [...weekKeys] };
    },
    onSuccess: (result, input) => {
      if (result.partyId !== null) {
        invalidateRunChange(result.partyId, result.weekKeys);
      }
      setMoveForm(null);
      /*
        ⚠️ **창을 닫고 결과를 말한다.** 격자에서 블록이 움직이는 것이 곧 증거지만, 옮긴
           곳이 화면 밖(접힌 `늦은 시간` 줄)일 수 있어 아무 일도 안 일어난 것처럼 보인다.
           조용한 성공은 조용한 실패와 화면에서 구별되지 않는다(등록 창의 같은 교훈).
      */
      onClose();
      const first = input.moves[0];
      toaster.notify({
        tone: "success",
        title: `일정 ${String(input.moves.length)}건을 옮겼습니다`,
        description:
          first === undefined
            ? "시각이 바뀌었습니다."
            : `${formatKstFull(first.at)} 시작 · 파티 전원의 일정이 함께 바뀝니다.`,
      });
    },
    onError: () => {
      // 앞의 몇 건은 이미 옮겨졌을 수 있다. 화면을 서버 진실로 수렴시킨다.
      if (block !== null) {
        invalidateRunChange(block.partyId, weekKeysOf(block.runs));
      }
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 빠진 뒤의 결과 화면 — 블록이 격자에서 사라져도 **되돌릴 길을 남긴다**(머리말 ⚠️)
  // ───────────────────────────────────────────────────────────────────────────
  if (block === null) {
    if (left === null) return null;
    return (
      <Dialog
        open
        onClose={() => {
          setLeft(null);
          onClose();
        }}
        title={left.partyName}
        description={left.rangeText}
      >
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-ink">
            이 일정에서 <strong className="font-semibold">빠졌습니다.</strong>{" "}
            일정 자체는 남아 있고, 내 시간표에서만 사라집니다.
          </p>
          <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
            창을 닫으면 이 일정은 시간표에 나오지 않으므로{" "}
            <strong className="font-semibold">여기서 되돌려야 합니다.</strong>{" "}
            다시 가려면 아래 버튼을 눌러 주세요.
          </p>
          {setSignupStatus.error === null ? null : (
            <ErrorState
              title="참가 상태를 바꾸지 못했습니다"
              detail={setSignupStatus.error.message}
              className="py-4"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={setSignupStatus.isPending}
              onClick={() => {
                setSignupStatus.mutate(
                  {
                    runIds: left.runIds,
                    characterId: left.characterId,
                    status: "going",
                  },
                  {
                    onSuccess: () => {
                      invalidateRunChange(left.partyId, left.weekKeys);
                      setLeft(null);
                      onClose();
                    },
                  },
                );
              }}
            >
              <Undo2 aria-hidden size={16} />
              {setSignupStatus.isPending ? "되돌리는 중…" : "다시 참가하기"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={setSignupStatus.isPending}
              onClick={() => {
                setLeft(null);
                onClose();
              }}
            >
              닫기
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const runs = block.runs;
  const first = runs[0];
  const rosterIsShared = runs.every((run) =>
    sameRoster(run.participants, first?.participants ?? []),
  );

  const characterText =
    block.characterNames.length === 0
      ? "지정하지 않음"
      : block.characterNames.join(", ");

  /*
    빠지기는 캐릭터 id 가 있어야 한다(§1 — 서버가 요구한다). 시간표가 런마다 그 값을
    들고 오므로(런 지정 → 파티 기본값 순) 새로 묻지 않는다. 전부 비어 있으면 그 조치만
    막고 이유를 말한다 — 조용히 실패시키지 않는다.
  */
  const myCharacterId =
    runs.find((run) => run.characterId !== null)?.characterId ?? null;

  const canAct = viewerPersonId !== null;
  const isBusy =
    removeRuns.isPending ||
    setSignupStatus.isPending ||
    moveRuns.isPending ||
    changeDuration.isPending;

  // ── 시각 옮기기 계산 ───────────────────────────────────────────────────────
  const moveMinutes =
    moveForm === null ? null : minutesFromTimeText(moveForm.timeText);
  const moveTarget =
    moveForm === null || moveMinutes === null
      ? null
      : kstMoment(moveForm.dayKey, moveMinutes);
  const moveDeltaMs =
    moveTarget === null ? 0 : moveTarget.getTime() - block.startsAt.getTime();
  const shiftedRuns: readonly TimetableRunAt[] = runs.map((run) => ({
    ...run,
    scheduledAt: new Date(run.scheduledAt.getTime() + moveDeltaMs),
  }));
  /*
    ★ **옮기기 전에 막는다.** 클리어가 붙은 런은 다른 주차로 갈 수 없다(§1.3 D1 —
      수익이 클리어 주차에 매여 있다). 서버도 409 로 거절하지만, 그때는 앞의 몇 건이
      이미 옮겨진 뒤다. 알 수 있는 것은 미리 알린다.
    ⚠️ 드랍만 기록된 런은 시간표 payload 에 단서가 없어 여기서 못 막는다 — 그건 서버
       문구가 받는다.
  */
  const moveCrossesWeek =
    moveTarget !== null &&
    getWeekKey(moveTarget) !== getWeekKey(block.startsAt);
  const moveBlockedByClear =
    moveCrossesWeek && runs.some((run) => run.clearedAt !== null);
  const canMove =
    moveTarget !== null && moveDeltaMs !== 0 && !moveBlockedByClear && !isBusy;

  const removalTarget =
    pendingRemoval === null
      ? null
      : pendingRemoval.kind === "block"
        ? runs
        : runs.filter((run) => run.runId === pendingRemoval.runId);

  /**
   * 이 묶음의 이름. 블록의 런들은 **같은 묶음**이므로(`sameBundle` 로 끊었다) 아무
   * 줄에서 집어도 같다 — 첫 줄에서 읽는다.
   */
  const bundleName = block.runs[0]?.bundleName ?? null;

  const leaveRuns = (runIds: readonly RunId[]) => {
    if (myCharacterId === null) return;
    setSignupStatus.mutate(
      { runIds, characterId: myCharacterId, status: "declined" },
      {
        onSuccess: () => {
          invalidateRunChange(block.partyId, weekKeysOf(block.runs));
          /*
            묶음 전체에서 빠졌으면 블록이 격자에서 사라진다 → 결과 화면으로 넘어가
            `되돌리기` 를 띄운다. 보스 하나만 빠졌으면 나머지가 남아 창이 그대로 선다.
          */
          if (runIds.length >= runs.length) {
            setLeft({
              partyName: block.partyName,
              rangeText: formatRunGroupRange(runs, null),
              runIds,
              characterId: myCharacterId,
              weekKeys: weekKeysOf(block.runs),
              partyId: block.partyId,
            });
            return;
          }
          /*
            보스 하나만 빠진 경우. 블록은 남지만 **그 보스만 조용히 사라지므로**
            무엇이 일어났는지 말해 준다 — 되돌리기는 파티 관리의 내 캐릭터 설정이
            아니라 이 일정 자체를 다시 잡는 길뿐이라, 최소한 사실은 남겨야 한다.
          */
          toaster.notify({
            tone: "success",
            title: "이 보스에서 빠졌습니다",
            description:
              "나만 빠집니다. 일정 자체는 남아 있고, 내 시간표에서만 사라집니다.",
          });
        },
      },
    );
  };

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
      /*
        ★ **묶음 이름을 함께 적는다**(2026-10-16, 2단계). 한 파티가 조합을 여럿 들 수
          있게 되면서 제목(파티 이름)만으로는 "어느 조합" 인지 답되지 않는다 — 같은
          파티의 익스+흉성과 카칼+노벨이 제목이 똑같다. 보스 얼굴이 아래에 있지만,
          이 창은 "이 일정이 무엇인가" 를 머리에서 한 줄로 말해야 한다.
        ★ 시각 범위는 목록 화면·카톡 `!일정` 과 **같은 함수**가 만든다. 끝 시각이 마지막
          런의 시작이 아니라 **끝**이라는 규칙이 그 안에 있고(2026-08-20 정정), 여기서
          다시 적으면 그 교훈이 한 곳에만 남는다.
        ★ 묶음이 없는 과거 런(`bundleId is null`)은 **아무 말도 덧붙이지 않는다** —
          "묶음 없음" 은 사용자가 할 수 있는 일이 없는 사실이다.
      */
      description={
        bundleName === null
          ? formatRunGroupRange(runs, null)
          : `${bundleName} · ${formatRunGroupRange(runs, null)}`
      }
      headerAside={
        block.partyNo === null ? null : (
          <span className="shrink-0 rounded-full bg-primary-subtle px-2 py-0.5 text-caption font-bold tabular-nums text-primary">
            {block.partyNo}파티
          </span>
        )
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

        {/*
          ── 클리어가 이 일정에 붙지 않는다 (발주 신고 2026-10-16) ──────────────
          ★ **원인과 결과를 둘 다** 말한다(`CLEAR_WONT_LINK_REASON` 머리말). 이 상태의
            증상은 "게임에서 깼는데 일정은 안 깨진 채로 남는 것"이고, 지금까지는 그
            사실이 화면 어디에도 없어서 사용자가 원인을 추측할 길이 없었다.
          ★ 주황 + **문장은 ink** (§4 — 주황 본문은 AA 미달이라 면·보더만 주황이다).
            `durationNotice` 가 같은 모양을 쓰고 있으므로 같은 토큰을 그대로 쓴다.
          ★ 바로 위 `내 캐릭터` 가 **이름을 보여 주고 있는데** 이 경고가 뜨는 것이
            모순처럼 보이지만 사실이다 — 그 값은 파티 기본값으로 떨어진 표시용이고,
            클리어를 붙이는 쪽은 참가 기록의 컬럼만 본다. 그래서 경고가 그 바로 아래에
            붙는다(두 줄을 떼어 놓으면 사용자가 둘을 연결하지 못한다).
          ⚠️ 판정은 **내 참가 행**만 본다. 이름만 적어 넣은 참가자는 캐릭터가 없는 것이
             정상이고(실측 138건), 그쪽까지 번지면 화면이 거짓 경고로 덮인다 —
             `TimetableParticipant.clearWontLink` 가 그 구분을 소유한다.
        */}
        {block.clearWontLink ? (
          <div className="flex flex-col gap-1 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
            <p className="flex items-start gap-2 text-body-sm font-semibold text-ink">
              <TriangleAlert
                aria-hidden
                size={16}
                className="mt-0.5 shrink-0 text-tertiary"
              />
              <span>{CLEAR_WONT_LINK_REASON}</span>
            </p>
            <p className="pl-6 text-body-sm text-ink">{CLEAR_WONT_LINK_FIX}</p>
          </div>
        ) : null}

        <Field label={`보스 ${String(runs.length)}`}>
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.runId} className="flex flex-col gap-2">
                <div
                  className={cn(
                    /*
                      📱 `flex-wrap` — 소요 시간 칸(≈124px)이 들어오면서 폭 400px 에서
                         칸·클리어 칩·버튼 둘이 한 줄에 다 들어가지 않는다. 좁아지면
                         오른쪽 묶음이 **아래로 떨어진다**(겹치거나 가로 스크롤이 생기는
                         것보다 낫다 — §4 가로 스크롤 금지).
                    */
                    "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-l-4 border-border bg-background px-2.5 py-2",
                    BOSS_DIFFICULTY_BORDER_L[run.difficulty],
                  )}
                >
                  <BossIcon
                    bossDifficultyId={run.bossDifficultyId}
                    difficulty={run.difficulty}
                    size="md"
                  />
                  {/*
                    📱 `basis-48`(192px) — 소요 시간 칸(≈152px)이 눌리지 않게 기준 폭을
                       넉넉히 준다. 폭이 모자라면 **칩과 버튼이 아래로 떨어지고** 이 칸은
                       그대로 남는다(§4 가로 스크롤 금지).

                    ⚠️ **`w-fit` 이 축소를 막아 주는 것이 아니다** (근거 정정 2026-10-11).
                       `width: fit-content` 는 flex 축소(`flex-shrink`)를 막지 않는다.
                       실제로 막는 것은 ① 안쪽 `<input>` 의 **자동 최소 크기**(flex 항목은
                       기본적으로 min-content 아래로 줄지 않는다)와 ② `shrink-0` 래퍼다.
                       그리고 **이 줄의 칸에는 `shrink-0` 이 없다** — 여기서는 안쪽
                       `flex-wrap` 이 그 일을 받는다(좁아지면 시각 글자와 칸이 두 줄로
                       쌓인다). 틀린 근거를 믿고 다음 사람이 `flex-wrap` 이나 `basis` 를
                       떼면 넘친다.
                  */}
                  <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
                    {/* 여기서는 줄임말이 아니라 **정식 이름**이다. 폭이 있으니 줄일 이유가 없다. */}
                    <span className="truncate text-body-sm font-semibold text-ink">
                      {run.bossKoreanName}
                    </span>
                    {canAct ? (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                          {formatKst(run.scheduledAt, "HH:mm")} 시작
                        </span>
                        {/*
                          ★ 저장이 **왕복을 돈다**(PATCH + 뒤 런 밀기). 그래서 이 칸만
                            `commitOnBlur` 다 — 한 글자마다 던지면 `120` 을 치는 사이에
                            12분으로 한 번 밀었다 당기는 일이 일어난다.
                          ★ `allowUnset` 이 **아니다.** `party_runs.duration_minutes` 는
                            not null 이라 "정하지 않음"이 존재하지 않는다 — 빈 칸은 오류다
                            (파티 쪽 칸과 다른 점이고, 그래서 둘이 같은 컴포넌트의 다른
                            플래그로 갈린다).
                        */}
                        <DurationField
                          /*
                            ⚠️ **거절되면 저장된 값으로 되돌린다.** 이 칸이 이제 그 런의
                               길이를 보여 주는 **유일한 자리**라, 409(뒤에 밀 수 없는
                               런이 있다) 뒤에도 입력한 40 이 남아 있으면 화면이 저장되지
                               않은 값을 저장된 것처럼 말한다. `key` 가 바뀌면 칸이 다시
                               마운트돼 `run.durationMinutes` 에서 출발한다.
                               (뮤테이션은 줄마다 공유하므로 한 줄이 실패하면 전부
                                되돌아간다 — 전부 저장된 값이니 맞는 동작이다.)
                          */
                          key={`run-duration-${run.runId}-${String(
                            changeDuration.isError,
                          )}`}
                          id={`run-duration-${run.runId}`}
                          value={run.durationMinutes}
                          fallbackMinutes={DEFAULT_RUN_MINUTES}
                          commitOnBlur
                          disabled={isBusy}
                          aria-label={`${run.bossKoreanName} 소요 시간(분)`}
                          onChange={(minutes) => {
                            if (minutes === null) return;
                            changeDuration.mutate({
                              runId: run.runId,
                              durationMinutes: minutes,
                              bossName: run.bossKoreanName,
                            });
                          }}
                        />
                      </span>
                    ) : (
                      <span className="text-caption tabular-nums text-ink-muted">
                        {formatKst(run.scheduledAt, "HH:mm")} ·{" "}
                        {run.durationMinutes}분
                      </span>
                    )}
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

                  {/*
                    ── 보스 하나만 손보기 ─────────────────────────────────────
                    묶음이 하나뿐이면 아래 묶음 조치와 **같은 일**이라 그리지 않는다 —
                    같은 동작에 버튼을 두 개 두면 어느 쪽이 무엇인지 되레 흐려진다.
                  */}
                  {canAct && runs.length > 1 ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${run.bossKoreanName} 에서 빠지기`}
                        title="나만 빠집니다"
                        disabled={isBusy || myCharacterId === null}
                        onClick={() => leaveRuns([run.runId])}
                      >
                        <UserMinus aria-hidden size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${run.bossKoreanName} 일정 삭제`}
                        title="이 보스 일정을 지웁니다"
                        className="text-error hover:text-error"
                        disabled={isBusy}
                        onClick={() =>
                          setPendingRemoval(
                            pendingRemoval !== null &&
                              pendingRemoval.kind === "run" &&
                              pendingRemoval.runId === run.runId
                              ? null
                              : { kind: "run", runId: run.runId },
                          )
                        }
                      >
                        <Trash2 aria-hidden size={16} />
                      </Button>
                    </span>
                  ) : null}
                </div>

                {/* 명단이 런마다 다를 때만 보스 밑에 붙인다(머리말). */}
                {rosterIsShared ? null : (
                  <Roster participants={run.participants} className="pl-2.5" />
                )}
              </li>
            ))}
          </ul>
        </Field>

        {/*
          ── 소요 시간을 고친 결과 ───────────────────────────────────────────
          주황이다 (§4 — 빨강은 실패·취소 전용). 요청은 성공했고, 사용자가 **알아야 할
          부수 효과**를 말하는 자리다. 문장은 잉크가 맡는다(주황 본문은 AA 미달).
        */}
        {durationNotice === null ? null : (
          <div className="flex flex-col gap-1 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
            {durationShiftLines(durationNotice).map((line) => (
              <p key={line} className="text-body-sm text-ink">
                {line}
              </p>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setDurationNotice(null)}
            >
              알겠습니다
            </Button>
          </div>
        )}

        {changeDuration.error === null ? null : (
          /*
            ⚠️ **서버 문구를 그대로** 올린다. 409 는 "뒤에 다른 파티의 런이 있어 밀 수
               없다"이고 어느 런과 부딪히는지가 그 문구에 적혀 있다 — 뭉개면 사용자가
               할 수 있는 일이 없어진다.
          */
          <ErrorState
            title="소요 시간을 바꾸지 못했습니다"
            detail={changeDuration.error.message}
            className="py-4"
          />
        )}

        {rosterIsShared ? (
          <Field label={`파티원 ${String(first?.participants.length ?? 0)}`}>
            <Roster participants={first?.participants ?? []} />
          </Field>
        ) : null}

        <p className="text-caption text-ink-muted">
          {formatKstFull(block.startsAt)} 시작 · 파티 전체 명단이 아니라{" "}
          <strong className="font-semibold">이 일정에 등록된 사람</strong>입니다.
        </p>

        {/* ── 조치 ───────────────────────────────────────────────────────── */}
        {canAct ? (
          <Field label="조치">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy}
                  onClick={() =>
                    setMoveForm(
                      moveForm === null
                        ? {
                            /*
                              기본값은 **지금 그대로**다. 여는 순간 값이 달라져 있으면
                              사용자는 자기가 뭘 바꿨는지 모르는 채로 저장하게 된다.
                              ★ 날짜는 격자 칸(`dayKey`)이 아니라 **실제 KST 날짜**로 잡는다.
                                자정을 넘긴 런은 수요일 칸에 그려지면서 목요일에 시작한다.
                            */
                            dayKey: days.some(
                              (day) => day.dayKey === kstDayKey(block.startsAt),
                            )
                              ? kstDayKey(block.startsAt)
                              : block.dayKey,
                            timeText: formatKst(block.startsAt, "HH:mm"),
                          }
                        : null,
                    )
                  }
                >
                  <CalendarClock aria-hidden size={16} />
                  {moveForm === null ? "시각 옮기기" : "옮기기 접기"}
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isBusy || myCharacterId === null}
                  onClick={() => leaveRuns(runs.map((run) => run.runId))}
                >
                  <UserMinus aria-hidden size={16} />
                  {setSignupStatus.isPending
                    ? "바꾸는 중…"
                    : "이 일정에서 빠지기"}
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  className="text-error hover:text-error"
                  disabled={isBusy}
                  onClick={() =>
                    setPendingRemoval(
                      pendingRemoval !== null && pendingRemoval.kind === "block"
                        ? null
                        : { kind: "block" },
                    )
                  }
                >
                  <Trash2 aria-hidden size={16} />
                  {pendingRemoval !== null && pendingRemoval.kind === "block"
                    ? "삭제 취소"
                    : "일정 삭제"}
                </Button>
              </div>

              {myCharacterId === null ? (
                <HelperText>
                  이 일정에 데려갈 캐릭터가 지정돼 있지 않아 참가 상태를 바꿀 수
                  없습니다. 파티 관리에서 내 캐릭터를 먼저 정해 주세요.
                </HelperText>
              ) : (
                <HelperText>
                  <strong className="font-semibold">빠지기</strong>는 나만
                  빠집니다(일정은 남습니다).{" "}
                  <strong className="font-semibold">삭제</strong>는 파티 전원의
                  일정을 지웁니다.
                </HelperText>
              )}

              {setSignupStatus.error === null ? null : (
                <ErrorState
                  title="참가 상태를 바꾸지 못했습니다"
                  detail={setSignupStatus.error.message}
                  className="py-4"
                />
              )}

              {/* ── 시각 옮기기 폼 ──────────────────────────────────────── */}
              {moveForm === null ? null : (
                <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-pad-md">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={dayFieldId} required>
                        요일
                      </Label>
                      <select
                        id={dayFieldId}
                        value={moveForm.dayKey}
                        onChange={(event) =>
                          setMoveForm({
                            ...moveForm,
                            dayKey: event.target.value,
                          })
                        }
                        className={cn(
                          "h-control-md w-full rounded-md border border-border bg-surface px-3",
                          "text-body-sm text-ink transition duration-200 outline-none",
                          "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                        )}
                      >
                        {days.map((day) => (
                          <option key={day.dayKey} value={day.dayKey}>
                            {day.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={timeFieldId} required>
                        시작 시각
                      </Label>
                      <Input
                        id={timeFieldId}
                        type="time"
                        value={moveForm.timeText}
                        onChange={(event) =>
                          setMoveForm({
                            ...moveForm,
                            timeText: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  {moveTarget === null ? (
                    <HelperText tone="error" role="alert">
                      24시간 형식으로 입력해 주세요 (예: 21:00).
                    </HelperText>
                  ) : moveBlockedByClear ? (
                    /*
                      경고는 **주황**이다 (§4 — 빨강은 실패·취소 전용). 요청이 잘못된 것이
                      아니라 지금은 할 수 없는 일이고, 클리어를 풀면 같은 요청이 통한다.
                    */
                    <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      클리어가 기록된 일정이라{" "}
                      <strong className="font-semibold">
                        다른 주차로는 옮길 수 없습니다.
                      </strong>{" "}
                      수익이 클리어한 주차에 매여 있습니다. 같은 주 안에서는
                      옮길 수 있습니다.
                    </p>
                  ) : (
                    <HelperText>
                      {moveDeltaMs === 0 ? (
                        "지금과 같은 시각입니다."
                      ) : (
                        <>
                          보스 {runs.length}개가 간격을 유지한 채{" "}
                          <strong className="font-semibold">
                            {formatRunGroupRange(shiftedRuns, null)}
                          </strong>{" "}
                          로 옮겨집니다. 파티 전원의 일정이 함께 바뀝니다.
                        </>
                      )}
                    </HelperText>
                  )}

                  {moveRuns.error === null ? null : (
                    <ErrorState
                      title="시각을 옮기지 못했습니다"
                      detail={moveRuns.error.message}
                      className="py-4"
                    />
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={!canMove}
                      onClick={() => {
                        if (moveTarget === null || moveDeltaMs === 0) return;
                        moveRuns.mutate({
                          moves: runs.map((run) => ({
                            runId: run.runId,
                            at: new Date(
                              run.scheduledAt.getTime() + moveDeltaMs,
                            ),
                          })),
                        });
                      }}
                    >
                      {moveRuns.isPending ? "옮기는 중…" : "이 시각으로 옮기기"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={moveRuns.isPending}
                      onClick={() => setMoveForm(null)}
                    >
                      취소
                    </Button>
                  </div>
                </div>
              )}

              {/* ── 삭제 확인 ──────────────────────────────────────────── */}
              {removalTarget === null ||
              removalTarget.length === 0 ? null : (
                <RemovalConfirm
                  target={removalTarget}
                  startsAt={block.startsAt}
                  isPending={removeRuns.isPending}
                  errorMessage={removeRuns.error?.message ?? null}
                  onCancel={() => setPendingRemoval(null)}
                  onConfirm={() =>
                    removeRuns.mutate(removalTarget.map((run) => run.runId))
                  }
                />
              )}

            </div>
          </Field>
        ) : null}
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
 * 삭제 확인 — **"정말 하시겠습니까?" 만 묻지 않는다.**
 *
 * `party-bar` 의 파티 해체 확인이 세운 규칙이다: 사용자가 판단할 근거가 없으면 누르는 것
 * 말고 할 수 있는 게 없고, 되돌릴 수 없는 동작에서 그건 곧 사고다. 그래서 **무엇이
 * 사라지고 무엇이 남는지**를 먼저 말한다 — 보스 몇 개 · 참여자 몇 명 · 언제.
 *
 * ★ 수익 기록이 붙은 일정은 **삭제가 아니라 취소**된다는 사실도 미리 말한다. 겁을 주는
 *   확인창은 안전한 것이 아니라 그냥 나쁜 것이고, 그 오해 때문에 잘못 잡은 일정을 계속
 *   안고 가게 된다.
 */
function RemovalConfirm({
  target,
  startsAt,
  isPending,
  errorMessage,
  onCancel,
  onConfirm,
}: {
  readonly target: readonly TimetableRunAt[];
  readonly startsAt: Date;
  readonly isPending: boolean;
  readonly errorMessage: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  /* 참여자 수는 **그 런들의 명단 합집합**이다. 런마다 명단이 다를 수 있다(머리말). */
  const peopleCount = new Set(
    target.flatMap((run) =>
      run.participants.map((person) => person.participantId),
    ),
  ).size;
  const bossNames = target
    .map((run) => run.shortName ?? run.bossKoreanName)
    .join(" · ");

  /*
    ★ 역할(role)을 따로 주지 않는다. 이미 `Dialog` 안이라 `alertdialog` 를 겹쳐 두면
      포커스 관리가 두 겹이 되고, 브라우저가 보장해 주던 것과 어긋난다. 확인 패널은
      창 안의 한 구획이지 또 하나의 창이 아니다(`party-bar` 의 해체 확인과 같은 모양).
  */
  return (
    <div className="flex flex-col gap-2 rounded-md border border-error bg-background p-pad-md">
      <p className="text-body-sm font-semibold text-ink">
        {formatRunGroupRange(target, null)} 일정을 지웁니다.
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink-muted">
        <li>
          보스 <strong className="text-ink">{target.length}개</strong>({bossNames})
          · 참여자 <strong className="text-ink">{peopleCount}명</strong> ·{" "}
          {formatKstFull(startsAt)} 시작
        </li>
        <li>
          <strong className="text-ink">파티 전원</strong>의 일정에서 사라집니다.
          나만 빠지는 것이 아닙니다.
        </li>
        <li>
          클리어나 드랍이 기록된 일정은 삭제 대신{" "}
          <strong className="text-ink">취소</strong>로 남고 수익 기록은
          그대로입니다.
        </li>
        <li>되돌리는 화면은 없습니다. 다시 잡으려면 빈 칸을 눌러 주세요.</li>
      </ul>
      {errorMessage === null ? null : (
        <HelperText tone="error" role="alert">
          {errorMessage}
        </HelperText>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? "지우는 중…" : "지웁니다"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          그대로 둡니다
        </Button>
      </div>
    </div>
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
            {/*
              ★ 캐릭터 줄에 **주황 삼각형**을 붙이는 경우는 하나다 — 그 사람의 클리어가
                이 일정에 붙지 않을 때(`clearWontLink`). 이름만 적어 넣은 참가자와
                불참·미정은 그 값이 언제나 `false` 라 여기서 다시 가르지 않는다.
              ⚠️ 이름이 **보이면서** 삼각형이 붙는 상태가 정상이다 — 보이는 이름은 파티
                 기본값으로 떨어진 표시용이고, 비어 있는 것은 참가 기록의 컬럼이다.
              ⚠️ 색 단독으로 말하지 않는다(§4) — `title` 이 문장을 싣는다.
            */}
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-caption text-ink-muted">
                {person.characterName ?? "캐릭터 미지정"}
              </span>
              {person.clearWontLink ? (
                <span
                  className="flex shrink-0 items-center"
                  title={CLEAR_WONT_LINK_REASON}
                >
                  <TriangleAlert
                    aria-hidden
                    size={12}
                    className="text-tertiary"
                  />
                  {/* 색·아이콘 단독 금지(§4) — 낭독기에는 문장이 간다. */}
                  <span className="sr-only">{CLEAR_WONT_LINK_REASON}</span>
                </span>
              ) : null}
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
