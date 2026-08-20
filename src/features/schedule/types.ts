/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 화면의 **분배 배율(share)** 계약 — Route Handler ↔ 브라우저 공용 타입
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-19): *"파티 설정할때 분배 배율 설정하는 칸도 있어야함. 단순히
 * 2인이면 1:1 이 아니라 스펙에 차이나는 사람끼리 1:2 분배 하는경우도있음"*
 *
 * ── 왜 `types/domain.ts` 가 아니라 여기인가 ─────────────────────────────────
 * 분배 배율은 일정 화면 하나만 쓰는 **기능 지역 계약**이고, 도메인 타입
 * (`ScheduledRun` · `RunParticipant`)에 필드를 더하면 대시보드·수익·봇까지 전부
 * 영향을 받는다. 배율은 별도 조회(`GET .../shares`)로 따로 오므로 도메인 타입을
 * 넓히지 않는다.
 *
 * ── 왜 `weight`(가중치)로 주고받는가 — **퍼센트가 아니다** ──────────────────
 * 사용자가 실제로 아는 것은 "쟤랑 나랑 1 : 2" 이지 "33.33% : 66.67%" 가 아니다.
 * 퍼센트를 직접 받으면 합 100 을 **사람이 맞춰야** 하고, 6인 파티에서 1/3 처럼
 * 나누어떨어지지 않는 비율은 사람 손으로 절대 맞출 수 없다(33+33+34 를 매번 고민하게
 * 된다). 가중치는 합계 제약이 없으므로 그 실패가 아예 존재하지 않는다.
 *
 * ── 잔돈은 **DB 가 나눈다.** TS 에서 반올림하지 않는다 ──────────────────────
 * 가중치 → `share_bp`(만분율) 환산도, pot → 개인 수령액 환산도 전부
 * `public.distribute_meso()`(최대잉여법) 한 구현이 한다. 웹과 카톡 봇(`!결정석`)과
 * 주간 집계 뷰가 **같은 답**을 내야 하기 때문이다 — 화면이 1/n 을 다시 적었다가
 * 실제 약정과 다른 금액을 말한 사고가 이 저장소에서 이미 두 번 있었다
 * (`run-drop-dialog.tsx` · `scheduled-run-list.tsx` 의 같은 주석).
 */

import type { RunParticipant } from "@/types/domain";

/**
 * 가중치를 정수로 실어 보내기 위한 배율.
 *
 * 입력칸은 소수 두 자리까지 받는다(`33.33 : 66.67` 을 그대로 쓸 수 있어야 하고,
 * 저장된 `share_bp` 를 되읽으면 정확히 그 모양이 된다). 그런데
 * `distribute_meso(p_weights integer[])` 는 **정수 배열**이라 소수를 담을 자리가 없다.
 * → 화면이 100 을 곱해 정수로 만들어 보낸다. 비율은 배율에 불변이므로 결과는 같다.
 */
export const RUN_SHARE_WEIGHT_SCALE = 100;

/** 가중치 하나가 가질 수 있는 최댓값(스케일 적용 후). 폭주한 입력을 서버가 끊는다. */
export const RUN_SHARE_WEIGHT_MAX = 1_000_000;

/** 분배 화면이 그리는 참가자 한 줄. */
export interface RunShareParticipantWire {
  readonly signupId: string;
  /** `party_participants.id` — `set_run_shares` 가 요구하는 키다. */
  readonly participantId: string;
  /**
   * 화면·카톡에서 사람을 가리키는 **관리 번호** (§1.4).
   * 재부여하지 않으므로 연속이 아닐 수 있고, 그게 정상이다.
   */
  readonly seatNo: number;
  readonly displayName: string;
  readonly isGuest: boolean;
  readonly status: RunParticipant["status"];
  readonly characterName: string | null;
  /**
   * 저장된 분배 비율(만분율, 10000 = 100%).
   *
   * `null` 은 **"아직 서버가 계산하지 않았다"** 이다 — 낙관적 반영 중에만 나타난다.
   * 0 과 다르다: 0 은 "이 사람 몫이 없다"는 확정된 사실이다.
   */
  readonly shareBp: number | null;
  /**
   * 이 사람이 실제로 받는 메소. **DB `distribute_meso` 가 낸 값 그대로**다.
   *
   * `null` 이면 (a) 결정석 가격 미확인(§1.3 D4) 또는 (b) 낙관적 반영 중이라 아직
   * 계산되지 않음. 어느 쪽인지는 `RunSharesPayload.potMeso` / `isEstimating` 이 가른다.
   */
  readonly amountMeso: number | null;
}

/** `GET`/`PUT`/`DELETE /api/schedule/runs/{runId}/shares` 의 공통 응답 본문. */
export interface RunSharesPayload {
  readonly runId: string;
  readonly partyId: string;
  readonly weekKey: string;
  /**
   * `auto_equal` = 참가자가 바뀌면 균등 재계산 / `manual` = 사용자 지정 비율 보존.
   * 사용자가 한 번이라도 비율을 저장하면 `set_run_shares` 가 `manual` 로 바꾼다.
   */
  readonly shareMode: "auto_equal" | "manual";
  /** 1/n 의 분모 = 실제 입장 인원 (§1.3 D3). 사용자가 일정 수정에서 고칠 수 있다. */
  readonly entryPartySize: number;
  /**
   * 파티 전체가 받는 총액 = `party_size × floor(솔로가 / party_size)`.
   * **게임 규칙이라 우리가 못 바꾼다.** 가격 미확인이면 `null`(0 이 아니다 · §1.3 D4).
   */
  readonly potMeso: number | null;
  /** `going` 이 아닌 사람도 포함한다 — 화면이 "왜 이 사람은 칸이 잠겼는지"를 말해야 한다. */
  readonly participants: readonly RunShareParticipantWire[];
  /**
   * 낙관적으로 먼저 반영된 상태인가. `true` 면 `shareBp` · `amountMeso` 가 아직
   * 서버 값이 아니며(대개 `null`), 화면은 그 자리를 "계산 중"으로 그린다.
   *
   * ★ 화면이 금액을 **지어내지 않기 위한** 필드다. 사용자가 방금 입력한 가중치는
   *   즉시 보여 줄 수 있지만(그건 사용자가 친 값 그대로다), 메소는 DB 가 나눈다.
   */
  readonly isEstimating?: boolean;
}

/**
 * 파티 분배 설정 한 벌 — **분배는 파티의 성질이다**(2026-08-19 발주자).
 *
 * 런 단위 `RunSharesPayload` 와 달리 pot·보스·입장 인원이 없다. 여기서 정하는 것은
 * "이 파티는 어떤 비율로 나누는가" 하나뿐이고, 그 비율이 결정석과 드랍 정산 양쪽에
 * 그대로 쓰인다(`run_drops.share_mode` 기본값이 `party_default` 라 같은 뷰를 탄다).
 */
export interface PartySharesPayload {
  readonly partyId: string;
  /** `auto_equal` = 균등 / `manual` = 사용자 지정 비율. */
  readonly shareMode: "auto_equal" | "manual";
  readonly participants: readonly PartyShareParticipantWire[];
}

/** 파티 분배 화면의 한 줄. */
export interface PartyShareParticipantWire {
  readonly participantId: string;
  /** 파티 안 관리 번호(§1.4). 카톡에서 `1번` 으로 부르는 그 번호다. */
  readonly seatNo: number;
  readonly displayName: string;
  /** 저장된 만분율. `null` 이면 아직 정하지 않았다(= 균등). */
  readonly shareBp: number | null;
}

/** `PUT .../shares` 요청 본문 한 줄. `weight` 는 이미 100 이 곱해진 정수다. */
export interface RunShareWeightInput {
  readonly participantId: string;
  readonly weight: number;
}

/** `PUT .../shares` 요청 본문. */
export interface SetRunSharesBody {
  readonly weights: readonly RunShareWeightInput[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 이번 주 시간표 — **내가 가는 런만** (현황 › 이번주 일정)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 시간표 블록 하나 = 내가 가는 런 한 건.
 *
 * ── 왜 `types/domain.ts` 가 아니라 여기인가 ─────────────────────────────────
 * `ScheduledRun` 은 **파티가 소유한 일정**이고 이것은 **내가 가는 일정**이라, 같은 행을
 * 보더라도 관점이 다르다(여기에는 "내가 데려가는 캐릭터"가 있고 파티 명단이 없다).
 * 도메인 타입에 필드를 더하면 대시보드·수익·봇이 전부 따라 움직이므로 넓히지 않는다.
 *
 * ★ 시각은 **ISO 문자열**이다. JSON 경계를 넘고, 격자 좌표로의 변환은 렌더 시점에
 *   한 번만 일어난다.
 */
export interface TimetableRun {
  readonly runId: string;
  readonly partyId: string;
  /** 파티 이름. 블록에 그대로 적는다(발주 요구). */
  readonly partyName: string;
  /** 방+주차 번호(§1.4). 방에 안 묶인 파티는 `null` 이며 정상이다. */
  readonly partyNo: number | null;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  /** 보스 얼굴을 고르는 키. `BossIcon` 이 이 값을 받는다. */
  readonly bossDifficultyId: string;
  readonly difficulty: "easy" | "normal" | "chaos" | "hard" | "extreme";
  readonly bossKoreanName: string;
  /** `boss_difficulties.short_name`. 블록이 좁을 때 쓰며 없을 수 있다. */
  readonly shortName: string | null;
  /** **내가 데려가는 캐릭터.** 런 지정이 없으면 파티 기본값으로 떨어진다. */
  readonly characterName: string | null;
  /**
   * 이 런의 **참가자 전원**. `going` 이 아닌 사람도 담는다.
   *
   * 발주 지시(2026-08-20): *"클릭하면 저 보스에 대한 상세 모달을 여는걸로 (…) 파티 이름,
   * 파티원, 내 캐릭터 등등 전부다 보여주는식으로"*.
   *
   * ★ **파티 명단이 아니라 그 런의 명단이다.** 5명이 한 방에 있어도 그중 3명만 보스를
   *   갈 수 있다(발주자 2026-08-20: *"파티 = 보스파티 가 아니고"*). 그래서 여기 담기는
   *   것은 `run_signups` 이며, 신청 자체를 하지 않은 파티원은 애초에 행이 없다.
   * ★ 불참(`declined`)도 담는 이유: 모달이 "누가 안 오는가"를 말할 수 있어야 한다.
   *   빠진 사람과 불참을 누른 사람은 다른 사실이다.
   */
  readonly participants: readonly TimetableParticipant[];
}

/** 상세 모달의 명단 한 줄. */
export interface TimetableParticipant {
  readonly participantId: string;
  /**
   * 파티 안 관리 번호(§1.4). 카톡에서 `1번` 으로 부르는 그 번호이며 **재부여하지 않는다** —
   * 연속이 아닐 수 있고, 그게 정상이다.
   */
  readonly memberNo: number;
  readonly displayName: string;
  /** 그 사람이 이 런에 데려가는 캐릭터. 런 지정 → 파티 기본값 순으로 떨어진다. */
  readonly characterName: string | null;
  readonly status: "going" | "maybe" | "declined";
  /** 보고 있는 사람 자신인가. 명단에서 나를 먼저 찾을 수 있어야 한다. */
  readonly isMe: boolean;
}

/** `GET /api/schedule/timetable?weekKey=…` 의 응답 본문. */
export interface TimetableResponse {
  readonly runs: readonly TimetableRun[];
}
