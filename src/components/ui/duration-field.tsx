"use client";

import { useState } from "react";

import {
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
} from "@/lib/domain/run-grouping";
import { cn } from "@/lib/utils";

import { Input } from "./input";
import { NO_NATIVE_SPINNER, StepButton } from "./step-button";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 한 판의 **소요 시간(분)** 입력 — 네 화면이 같은 칸을 쓴다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-11): *"파티 보스 시간에대한 수정이 필요함. 일정 잡힐때도 한번
 * 확인할수 있고 수정할수있어야 하고 한번 수정되면 저장되어 항상 이용되도록. 그리고 이
 * 부분은 이미 잡혀있는 일정에서도 볼수있어야되고 수정할수있어야하며 파티관리에서도 확인
 * 및 수정이 가능해야함"*
 *
 * 그 지시가 **세 화면**을 가리킨다(일정 잡기 창 · 일정 상세 창 · 파티 관리). 같은 숫자를
 * 세 곳에서 고치게 되므로 칸을 세 번 만들면 범위 검사·오류 문구·−/+ 간격이 반드시
 * 갈라진다. `PartySizeField`(입장 인원)가 지역 문자열로 시작해 **두 자리에는 −/+ 버튼이
 * 아예 없었던** 전례가 있어(§ `step-button.tsx` 머리말) 처음부터 한 파일로 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `null` 은 **"정하지 않음"이고 20이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `party_bundle_bosses.duration_minutes` 의 `null` 이 "이 파티는 이 보스의 시간을 정하지 않았다"
 * 이고, 접는 자리는 `DEFAULT_RUN_MINUTES` 하나다(`@/lib/domain/run-grouping`). 둘을
 * 구분해 두는 이유는 기본값을 25분으로 바꿀 때 **정하지 않은 파티만** 따라와야 하기
 * 때문이다. 그래서 이 칸은:
 *   - `allowUnset` 이면 **빈 칸이 정상 입력**이고 `null` 을 올려 보낸다. placeholder 에
 *     기본값을 적어 두어 "비우면 몇 분이 되는지"를 화면이 말한다.
 *   - 그렇지 않으면(이미 잡힌 런의 길이는 `not null` 이다) 빈 칸은 오류다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 커밋 시점이 `PartySizeField` 와 **다르다** — 여기는 타이핑 중에도 올려 보낸다
 * ─────────────────────────────────────────────────────────────────────────────
 * 저쪽은 blur/Enter 를 기다린다(한 글자마다 저장하면 `1`→`12` 사이에 "1명"이 저장돼
 * 금액이 잠깐 6배로 튄다). 여기는 **부모가 미리보기 시각을 그리고 있어** 기다리면
 * 안 된다 — 발주 지시의 요점이 *"고치면 미리보기 시각이 즉시 따라간다"* 다.
 *
 * 대신 **유효한 값만** 올린다. `30` 을 치는 중간 상태 `3` 은 유효하므로(하한 1분,
 * 2026-10-21) 한 번 올라가고, 다음 글자 `30` 은 상한 밖이라 올리지 않고 오류만 띄운다.
 * 지나가는 `3` 은 사용자가 보고 있는 숫자와 어긋나지 않으므로 거짓말이 아니다.
 * ⚠️ 저장이 **왕복을 도는** 화면(일정 상세)은 이 칸을 `commitOnBlur` 로 쓴다. 한 글자마다
 *    PATCH 를 던지면 뒤 런을 밀었다 당기는 일이 세 번 일어난다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 범위는 1~20 — **서버·DB CHECK 와 같은 경계**다
 * ─────────────────────────────────────────────────────────────────────────────
 * 넘기면 서버가 400 으로 거절하므로 화면이 먼저 막는다. 막을 때는 **무엇이 잘못됐는지**
 * 적는다 — "잘못된 값"은 사용자가 할 수 있는 일을 알려 주지 않는다.
 *
 * ⚠️ **상한은 2026-10-11 에 600 → 20 으로, 하한은 2026-10-21 에 5 → 1 로 내려왔다**
 *    (발주: *"보스 하나당 최대시간이 20분"* · *"하드 진힐라는 거의 1~2분 걸림"*). 이 칸이 재는 것은 **한 판**이고, 묶어 도는 한 덩이의 길이는 보스별 값의
 *    **합**이라 60분 묶음은 그대로 표현된다. 숫자의 주인은 이제
 *    `@/lib/domain/run-grouping` 한 곳이다(아래 재수출).
 */

/**
 * `party_bundle_bosses.duration_minutes` · `party_runs.duration_minutes` 의 CHECK 와 같은 값.
 *
 * ★ **여기가 집이 아니다** — `@/lib/domain/run-grouping` 이 소유하고 이 파일은 재수출만
 *   한다. 이 파일은 `"use client"` 라 서버 라우트가 가져다 쓸 수 없고, 반대로 서버 repo 는
 *   `server-only` 라 화면이 못 쓴다. 환경 중립인 쪽에 두어야 **라우트·repo·화면·봇이 같은
 *   숫자**를 본다(그러지 않아 숫자가 다섯 벌이 됐던 경위는 그 파일 주석).
 * ★ 재수출을 유지하는 이유: `components/ui/index.ts` 가 이 이름을 공개면에 올려 두었고,
 *   호출부가 UI 칸의 경계를 묻는 자리에서 도메인 모듈을 import 하게 만들 이유가 없다.
 */
export { RUN_DURATION_MAX, RUN_DURATION_MIN };

/**
 * −/+ 한 걸음 — **10분 이하는 1분, 10분 위는 2분** (2026-10-21, 하한이 1분이 되면서).
 *
 * 2026-10-11 의 5분 걸음은 범위가 5~20 일 때 맞는 답이었다(5·10·15·20 네 칸). 하한이
 * 1분이 되자 맞지 않는다: 하드 진힐라처럼 **1~2분에 끝나는 보스**는 5분 걸음으로는 1 → 6
 * 으로 건너뛰어 버튼으로 닿을 수가 없다. 그렇다고 전 구간 1분 걸음이면 기본값 20 에서
 * 10 으로 내리는 데 **열 번**을 누른다. 그래서 구간을 가른다:
 *   - **10분 이하 → 1분.** 1~2분짜리 보스에서 1분은 값의 절반이다. 이 구간에서는 1분이
 *     실제로 구분되는 단위다.
 *   - **10분 위 → 2분**, 짝수 칸(10·12·…·20)에 맞춘다. 긴 보스에서 1분은 값의 5~10% 라
 *     어림의 오차 안이고, 20 → 10 이 다섯 번이면 손에 맞다. (첫 판은 이 2분을 "1극 단위
 *     = 기본값 계단 한 칸"이라 설명했지만, 2026-10-21 저녁 기본값이 배율 반비례로 바뀌어
 *     계단이 없어졌다 — `boss-duration-estimate.ts` 머리말 0절. 걸음은 손맛으로 남았다.)
 *   - 13 처럼 홀수에 서 있으면 첫 걸음이 짝수 칸으로 맞춘다(13 → 14 / 13 → 12).
 * 격자에 없는 값(11·13)은 **타이핑이 경로다** — 그래서 칸을 읽기 전용으로 만들지 않았다
 * (`min`/`max`/`step` 은 네이티브 검증에만 쓰이고 타이핑을 막지 않는다).
 */
const FINE_STEP_CEILING = 10;
const FINE_STEP_MINUTES = 1;
const COARSE_STEP_MINUTES = 2;

/** `current` 에서 + 한 번 누른 값. 상한에서 멈춘다. */
function durationStepUp(current: number): number {
  const next =
    current < FINE_STEP_CEILING
      ? current + FINE_STEP_MINUTES
      : (Math.floor(current / COARSE_STEP_MINUTES) + 1) * COARSE_STEP_MINUTES;
  return Math.min(RUN_DURATION_MAX, Math.max(RUN_DURATION_MIN, next));
}

/** `current` 에서 − 한 번 누른 값. 하한에서 멈춘다. */
function durationStepDown(current: number): number {
  const next =
    current <= FINE_STEP_CEILING
      ? current - FINE_STEP_MINUTES
      : Math.max(
          FINE_STEP_CEILING,
          (Math.ceil(current / COARSE_STEP_MINUTES) - 1) * COARSE_STEP_MINUTES,
        );
  return Math.min(RUN_DURATION_MAX, Math.max(RUN_DURATION_MIN, next));
}

export interface DurationFieldProps {
  /** `<Label htmlFor>` 과 잇는다. 라벨이 없는 자리는 `aria-label` 을 쓴다. */
  readonly id: string;
  /** 현재 값(분). `null` = 정하지 않음. */
  readonly value: number | null;
  /**
   * 비었을 때 실제로 쓰이는 분. placeholder 로 적는다 — 값을 지어내지 않고,
   * "비우면 몇 분이 되는지"만 말한다.
   */
  readonly fallbackMinutes: number;
  /** `null`(빈 칸)을 정상 입력으로 받을 것인가. 런 길이는 `not null` 이라 `false` 다. */
  readonly allowUnset?: boolean;
  /**
   * `true` 면 Enter·포커스 이탈에서만 올려 보낸다. 저장이 왕복을 도는 자리에서 쓴다
   * (머리말 ⚠️). 기본은 즉시 올려 보내기 — 미리보기가 따라와야 하는 자리가 다수다.
   */
  readonly commitOnBlur?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: number | null) => void;
  /** 라벨이 없는 자리(목록 한 줄)에서 **무엇의 시간인지** 적는다. */
  readonly "aria-label"?: string;
  readonly "aria-describedby"?: string;
}

/** 칸에 적을 글자. `null` 은 **빈 칸**이다(placeholder 가 기본값을 말한다). */
function formatDraft(value: number | null): string {
  return value === null ? "" : String(value);
}

export function DurationField({
  id,
  value,
  fallbackMinutes,
  allowUnset = false,
  commitOnBlur = false,
  disabled = false,
  onChange,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: DurationFieldProps) {
  const [draft, setDraft] = useState(() => formatDraft(value));
  /*
    ── 프롭이 바뀌면 칸을 다시 맞춘다 ─────────────────────────────────────────
    부모가 값을 갈아 끼웠을 때(파티 변경·서버가 낸 새 값) 칸이 낡은 글자를 들고 있으면
    화면이 거짓을 말한다. `useEffect` 가 아니라 **렌더 중 조정**이다(React 공식
    "Adjusting state when a prop changes") — effect 로 하면 틀린 값을 한 프레임 그린 뒤
    지운다.

    ⚠️ ═══════════════════════════════════════════════════════════════════════════
      **비교 대상은 "마지막으로 맞춰 온 프롭"이고, 올려 보낸 값이 아니다.**
      ═══════════════════════════════════════════════════════════════════════════
      2026-10-11 결함: `push()` 가 이 기준값을 **올려 보낸 값(40)** 으로 바꿔 두었다.
      그러면 저장이 왕복을 도는 동안(`isPending` 때문에 리렌더가 반드시 일어난다)
      프롭은 아직 20 이라 `20 !== 40` 이 되어 **칸이 20 으로 되돌아갔다.** 옆에서는
      *"40분으로 바꿨습니다"* 가 떠 있으니 성공이 거절처럼 읽혔다.
      그래서 `push()` 는 이 값을 **건드리지 않는다.** 프롭이 실제로 달라질 때만 맞춘다.
    ⚠️ 거절된 뒤 되돌리는 일은 이 조정이 하지 않는다 — 프롭이 안 바뀌기 때문이다.
       그건 호출부가 `key` 를 바꿔 **다시 마운트**시켜 한다(`run-detail-dialog`).
       두 장치가 겹쳐 보이지만 맡은 사건이 다르다: 여기는 *프롭 변화*, 저기는 *거절*.
  */
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(formatDraft(value));
  }

  const trimmed = draft.trim();
  const isEmpty = trimmed === "";
  const parsed = Number.parseInt(trimmed, 10);
  const inRange =
    Number.isInteger(parsed) &&
    parsed >= RUN_DURATION_MIN &&
    parsed <= RUN_DURATION_MAX;
  const isValid = isEmpty ? allowUnset : inRange;

  /** −/+ 가 밟고 설 현재 값. 빈 칸이면 실제로 쓰이는 분에서 출발한다. */
  const current = inRange ? parsed : (value ?? fallbackMinutes);

  /** 값을 확정해 올려 보낸다. **동기화 기준값은 건드리지 않는다**(위 ⚠️). */
  function push(next: number | null): void {
    setDraft(formatDraft(next));
    if (!disabled) onChange(next);
  }

  /** −/+ 가 데려갈 값. 걸음 크기는 구간마다 다르다(`durationStepUp/Down` 머리말). */
  const downTo = durationStepDown(current);
  const upTo = durationStepUp(current);

  /** 타이핑을 확정한다. 잘못된 값으로 떠나면 저장된 값으로 되돌린다. */
  function commit(): void {
    if (isEmpty) {
      if (allowUnset) {
        if (value !== null) push(null);
        return;
      }
      setDraft(formatDraft(value));
      return;
    }
    if (!inRange) {
      setDraft(formatDraft(value));
      return;
    }
    if (parsed !== value) push(parsed);
  }

  /*
    ── 오류 문구를 **칸의 설명으로 잇는다** ────────────────────────────────────
    `role="alert"` 는 "방금 뜬 말"을 읽어 주지만, 포커스를 칸에 다시 두었을 때 낭독기가
    읽는 **칸의 설명**은 되지 못한다. 그래서 문구에 id 를 주고 `aria-describedby` 로
    잇는다. 호출부가 넘긴 설명이 있으면 **둘 다** 읽히게 이어 붙인다(둘 중 하나를
    버리면 호출부가 적어 둔 맥락이 사라진다).
    ⚠️ 오류가 없을 때 그 id 를 가리키면 **존재하지 않는 요소**를 가리키게 되어, 낭독기가
       아무것도 읽지 않거나 구현에 따라 칸의 이름까지 흔들린다. 그래서 켤 때만 잇는다.
  */
  const errorId = `${id}-error`;
  const describedByValue =
    [describedBy, isValid ? null : errorId].filter((part) => part != null).join(
      " ",
    ) || undefined;

  return (
    <span className="flex w-fit flex-col gap-1">
      <span className="flex items-center gap-1">
        <StepButton
          direction="down"
          onClick={() => push(downTo)}
          disabled={disabled || current <= RUN_DURATION_MIN}
          aria-label={`${ariaLabel ?? "소요 시간"} ${String(downTo)}분으로 줄이기`}
        />
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={RUN_DURATION_MIN}
          max={RUN_DURATION_MAX}
          step={1}
          value={draft}
          placeholder={String(fallbackMinutes)}
          invalid={!isValid}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={describedByValue}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (commitOnBlur) return;
            const nextTrimmed = next.trim();
            if (nextTrimmed === "") {
              if (allowUnset && value !== null && !disabled) onChange(null);
              return;
            }
            const nextParsed = Number.parseInt(nextTrimmed, 10);
            if (
              Number.isInteger(nextParsed) &&
              nextParsed >= RUN_DURATION_MIN &&
              nextParsed <= RUN_DURATION_MAX &&
              nextParsed !== value &&
              !disabled
            ) {
              onChange(nextParsed);
            }
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // 다이얼로그 안에서 Enter 가 폼 제출로 새는 것을 막는다.
            event.preventDefault();
            commit();
          }}
          className={cn(
            "h-control-sm w-14 px-1.5 py-1 text-center tabular-nums",
            NO_NATIVE_SPINNER,
          )}
        />
        <StepButton
          direction="up"
          onClick={() => push(upTo)}
          disabled={disabled || current >= RUN_DURATION_MAX}
          aria-label={`${ariaLabel ?? "소요 시간"} ${String(upTo)}분으로 늘리기`}
        />
        {/* 단위는 수치 주석이라 12px 이 허용된다(§4 — 문장만 14px 하한). */}
        <span className="shrink-0 text-caption text-ink-muted">분</span>
      </span>
      {isValid ? null : (
        /*
          ⚠️ **무엇이 잘못됐는지** 적는다. 빈 칸과 범위 초과는 다른 사건이고, 전자는
             이 화면에서 애초에 허용되지 않는다는 사실을 말해야 한다.

          ★ ═══════════════════════════════════════════════════════════════════
            **문구가 칸 묶음의 폭을 늘려서는 안 된다** (2026-10-11 실측 결함)
            ═══════════════════════════════════════════════════════════════════
            이 `<span>` 은 위 컨트롤 줄과 같은 `flex-col` 자식이므로, 묶음의
            max-content 폭 = `max(컨트롤 줄, 이 문구)` 다. 처음 문구는
            *"5~600분 사이의 정수로 입력해 주세요."* 였고 14px 에서 ≈252px — 컨트롤
            줄(≈152px)보다 **100px 넓다.** 묶음을 감싼 쪽이 `shrink-0` 이면 쪼개지지도
            줄지도 않아 폭 340px 이하에서 **가로 스크롤**이 생겼다(§4 금지).
            그래서 둘을 함께 쓴다:
              ① 문구를 짧게 — `PartySizeField` 의 오류 문구와 **같은 모양**이다
                 (`1~20 사이의 정수`). 자매 칸과 같은 말을 쓰는 것이 덤이다.
                 ⚠️ 상한이 20 으로 내려와 문구가 한 글자 더 짧아졌지만(2026-10-11),
                    ②의 상한은 **그대로 둔다** — 문구가 짧아진 것은 숫자 하나 덕이고,
                    다음 사람이 설명을 덧붙이면 폭 문제는 즉시 돌아온다.
              ② `max-w-36`(144px) 상한 — 다음 사람이 문구를 늘려도 **줄바꿈으로** 가고
                 폭으로는 가지 않는다. 144 ≤ 152 라 묶음 폭이 컨트롤 줄에서 결정된다.
        */
        <span
          id={errorId}
          role="alert"
          className="max-w-36 text-body-sm text-error"
        >
          {isEmpty
            ? "값이 필요합니다"
            : `${String(RUN_DURATION_MIN)}~${String(RUN_DURATION_MAX)} 사이의 정수`}
        </span>
      )}
    </span>
  );
}
