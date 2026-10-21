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

import type { CharacterBossMinutes } from "@/lib/domain/boss-duration-estimate";
import type {
  GuestManageState,
  PartyMemberBrief,
  RunParticipant,
} from "@/types/domain";

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
  /**
   * ★ **이 런이 속한 보스 묶음.** 시간표 블록을 끊는 축이며(`lib/domain/run-grouping.ts`
   *   의 `sameBundle`), 같은 파티의 다른 조합이 한 블록으로 합쳐지지 않게 하는 유일한
   *   값이다. `null` = 묶음이 지워진 과거 런 — 그때는 파티로 끊는다(적용 전과 같다).
   */
  readonly bundleId: string | null;
  /** 묶음 이름. 상세 창이 "어느 조합인가"를 적는 데 쓴다. 묶음이 없으면 `null`. */
  readonly bundleName: string | null;
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
   * 그 캐릭터의 id. **런이 끝난 뒤 그 캐릭터만 동기화**하기 위해 필요하다
   * (발주 지시 2026-08-21: *"각 보스시간이 끝나고 그 캐릭을 동기화 돌리는게 좋을듯"*).
   * 이름으로는 넥슨을 부를 수 없다 — 키를 고르는 것도, 스케줄러를 읽는 것도 id 기준이다.
   */
  readonly characterId: string | null;
  /**
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **내 참가 행에 실제로 박혀 있는 캐릭터** — `run_signups.character_id` 그 컬럼.
   *   ═══════════════════════════════════════════════════════════════════════
   *
   * 위 `characterId` 와 **다르다.** 저쪽은 `coalesce(런 지정, 파티 기본값)` 으로 떨어진
   * **표시용** 값이고, 이것은 떨어뜨리지 않은 **원본**이다. 둘을 한 필드로 합치면 안 되는
   * 이유가 이번 결함 전체다(발주 신고 2026-10-16):
   *
   *   · 클리어를 일정에 붙이는 두 경로(`sync-scheduler.loadRunLinks` 의
   *     `(캐릭터, 보스, 주차)` 조회 · `income-repo.setRunClear`)는 **이 컬럼만** 읽는다.
   *   · 화면은 폴백된 값을 그리므로 캐릭터가 멀쩡히 보인다.
   *   → 그래서 "넥슨도 깼다고 하고 수익도 들어왔는데 이 일정만 클리어가 안 되는" 상태가
   *     **아무 표시 없이** 영원히 유지됐다.
   *
   * `null` 이면 그 사실을 화면이 말해야 한다(§4 — 주황 경고, 문장은 ink).
   * 등록 경로는 2026-10-16 부터 파티 기본값을 복사해 채우므로(`createPartyRuns`)
   * 새 일정에서는 더 이상 생기지 않는다 — 남은 것은 과거 행뿐이다.
   */
  readonly signupCharacterId: string | null;
  /**
   * **내가** 이 런을 클리어한 시각(ISO). 안 잡았으면 `null`.
   *
   * 발주 지적(2026-08-21): *"방금 클리어까지 찍히는게 보이는데 일정은 클리어 연동이
   * 안되네?"*. 연동 자체는 되고 있었다 — 넥슨 동기화가 `boss_clears.run_id` 를 채워
   * 런에 붙인다(R5-G). **시간표가 그 사실을 그리지 않았을 뿐이다.**
   *
   * ★ **남의 클리어가 아니라 내 것**이다. 같은 런을 파티원 각자가 클리어하므로
   *   `boss_clears` 에는 여러 행이 생기는데, 시간표는 "내가 갈 곳"을 묻는 화면이라
   *   답도 "내가 잡았나"여야 한다.
   */
  readonly clearedAt: string | null;
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
  /**
   * **이 사람의 클리어가 이 일정에 붙지 않는다** — 참가 행(`run_signups.character_id`)이
   * 비어 있는 앱 사용자. `TimetableRun.signupCharacterId` 와 같은 사실의 명단 버전이다.
   *
   * ⚠️ **앱 사용자가 아닌 참가자는 언제나 `false`** 다(이름만 적어 넣은 사람 · 게스트).
   *    그들에게는 캐릭터도 넥슨 계정도 없어 캐릭터가 비어 있는 것이 **정상**이고,
   *    실측(2026-10-16) 캐릭터 없는 `going` 참가 156건 중 **138건이 전부 그쪽**이다 —
   *    여기서 가르지 않으면 화면이 거짓 경고로 덮인다.
   * ⚠️ `going` 이 아닌 참가도 `false` 다. 안 가는 사람에게는 클리어가 생기지 않으므로
   *    캐릭터를 정할 이유도 없다.
   */
  readonly clearWontLink: boolean;
}

/**
 * ★ ═════════════════════════════════════════════════════════════════════════
 *   **캐릭터 없는 참가를 사람에게 말하는 문구** — 블록·띠·상세가 같은 말을 쓴다
 *   ═════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-16): *"지금은 캐릭터 없는 참가가 조용히 영원히 클리어되지 않는다.
 * 사용자는 '왜 판정이 안 되지'만 겪는다"* — 그래서 문구가 **원인과 결과를 둘 다** 말한다.
 * 원인은 "가는 캐릭터가 정해지지 않았다", 결과는 "클리어가 이 일정에 붙지 않는다"다.
 * 하나만 말하면 사용자가 할 수 있는 일이 없다.
 *
 * ★ 세 곳이 한 문자열을 쓴다. 블록은 `title`·`sr-only` 로만 싣고(폭 42px 에 문장을 넣을
 *   자리가 없다) 눈에는 주황 삼각형 하나를 보여 주며, 상세 창이 문장을 그린다.
 */
export const CLEAR_WONT_LINK_REASON =
  "가는 캐릭터가 정해지지 않아 클리어가 이 일정에 붙지 않습니다.";

/**
 * 이어서 **무엇을 하면 되는지**. 상세 창에서만 쓴다 — 블록 `title` 에는 조치까지 넣으면
 * 툴팁이 두 줄을 넘어 읽히지 않는다.
 *
 * ⚠️ **이 창에는 참가 캐릭터를 고르는 입력이 없다**(2026-10-16 확인). 그래서 문구가
 *    가리키는 길은 **이미 있는 두 경로**다:
 *      · `이 일정에서 빠지기` → `다시 참가하기` — 그 되돌리기가 `saveRunSignup` 을
 *        부르면서 지금 화면에 보이는 캐릭터를 참가 기록에 **실제로 써 넣는다**.
 *      · `파티 관리` 에서 내 캐릭터를 정해 두면 **다음 등록부터** 복사된다
 *        (`schedule-repo.createPartyRuns`).
 *    없는 버튼을 가리키지 않는 것이 이 문구의 조건이다 — 사용자가 찾다가 못 찾으면
 *    경고가 없는 것보다 나쁘다.
 */
export const CLEAR_WONT_LINK_FIX =
  "아래 ‘이 일정에서 빠지기’ 를 누른 뒤 ‘다시 참가하기’ 를 누르면 위 캐릭터로 채워집니다. 파티 관리에서 내 캐릭터를 정해 두면 다음 일정부터는 자동으로 들어갑니다.";

/** `GET /api/schedule/timetable?weekKey=…` 의 응답 본문. */
export interface TimetableResponse {
  readonly runs: readonly TimetableRun[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 묶음 — **한 파티 안의 "이 조합"** (2단계, 2026-10-16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 왜 이 계약이 `types/domain.ts` 가 아니라 여기인가
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 문제(2026-10-16): *"같은 두 사람이 보스 묶음·캐릭터·분배만 바꿔 여러 조합을 도는데
 * 조합마다 파티를 새로 만들어야 한다."* 라이브 실측 — 같은 구성원인데 보스만 다른 활성
 * 파티가 **6개**, 이름은 `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 **캐릭터 이름으로만**
 * 갈린다.
 *
 * 묶음을 읽고 쓰는 화면은 둘(`/parties` 의 묶음 목록 · `/` 의 일정 잡기)이고, 둘 다
 * **일정 기능 안**이다. `Party` 나 `ScheduledRun` 같은 도메인 타입에 칸을 더하면 수익 ·
 * 봇 · 보스 계획까지 전부 따라 움직이는데, 그 화면들은 묶음을 **런의 `bundle_id` 하나로만**
 * 안다(정산은 SQL 뷰가 혼자 처리한다 — `v_run_share_weights`). 그래서 기능 지역 계약이다.
 * `RunSharesPayload` · `TimetableRun` 이 이미 같은 이유로 여기 산다.
 *
 * ★ **분배는 비어 있을 수 있고, 비어 있음이 "파티를 따름"이다.** `shareMode === null` ·
 *   `shareBp === null` 은 0 이 아니다(§1.3 D4 와 같은 기조). 화면은 그 자리를 0 으로
 *   그리면 안 되고 "상속 중"이라고 말해야 한다 — DB 컬럼이 nullable 인 것이 1단계 설계의
 *   핵심이었고(마이그레이션 머리말), 화면이 0 을 적어 보내면 그 설계가 그 순간 무너진다.
 */

/** 묶음이 연달아 도는 보스 한 줄. */
export interface PartyBundleBossWire {
  readonly bossDifficultyId: string;
  readonly koreanName: string;
  readonly shortName: string;
  readonly difficulty: "easy" | "normal" | "chaos" | "hard" | "extreme";
  /** `null` = 이 묶음은 이 보스의 시간을 **정하지 않았다**(0 도 20 도 아니다). */
  readonly durationMinutes: number | null;
}

/** 묶음 안의 사람 한 줄 — 구성원은 파티가 소유하고, 묶음은 **캐릭터와 비율**만 더한다. */
export interface PartyBundleMemberWire {
  readonly participantId: string;
  /** 파티 안 관리 번호(§1.4). 재부여하지 않으므로 연속이 아닐 수 있다. */
  readonly seatNo: number;
  readonly displayName: string;
  readonly isGuest: boolean;
  /** 보고 있는 사람 자신인가. **내 줄만 캐릭터를 고칠 수 있다**(아래 ⚠️). */
  readonly isMe: boolean;
  /**
   * 이 묶음에서 데려가는 캐릭터 (`party_bundle_characters`).
   * `null` = 이 묶음에서는 정하지 않았다 → `partyCharacterName` 으로 떨어진다.
   */
  readonly bundleCharacterId: string | null;
  readonly bundleCharacterName: string | null;
  /** 파티 기본값 (`party_participants.character_id`). 2단계부터 **기본값 공급**이다. */
  readonly partyCharacterId: string | null;
  readonly partyCharacterName: string | null;
  /** 묶음 비율(만분율). `null` = 파티 값 상속이며 **0 과 다르다**. */
  readonly bundleShareBp: number | null;
  /** 파티 비율(만분율). 상속 중일 때 화면이 "따르는 값"으로 보여 준다. */
  readonly partyShareBp: number | null;
  /**
   * 이 사람이 **이 묶음으로 일정에 가면 데려갈 캐릭터**(묶음 → 파티 → 본캐 — 서버
   * `createPartyRuns` 가 참가 기록에 넣는 규칙)의 사람이 넣은 분 전부(분 + 그 줄의 인원). `null` = 캐릭터
   * 없음(게스트 · 본캐 미추적). 묶음 편집 창이 빈 칸의 배율 합산 추정을 그리는 재료다
   * (`resolveBossDuration` — `boss-duration-estimate` 머리말 4절).
   */
  readonly runBossMinutes: CharacterBossMinutes | null;
  /** 같은 값을 **묶음 지정 없이**(파티 → 본캐) 푼 것. 새 묶음을 만들 때 쓴다. */
  readonly partyFallbackBossMinutes: CharacterBossMinutes | null;
}

/** 묶음 하나. `GET /api/schedule/parties/{partyId}/bundles` 의 한 줄. */
export interface PartyBundleWire {
  readonly bundleId: string;
  readonly partyId: string;
  /** 파티 안에서 사람이 부르는 번호. **재배열·재사용 금지**(§1.4). */
  readonly bundleNo: number | null;
  readonly name: string;
  /** `true` = 사람이 적은 이름이라 보스를 바꿔도 **따라가지 않는다**. */
  readonly nameIsCustom: boolean;
  /**
   * 지금 보스로 만들면 나올 **자동 이름**(`익세 하대 하카 3인`).
   *
   * ★ 화면이 다시 계산하지 않게 서버가 싣는다. 조합 규칙의 주인은
   *   `@/lib/domain/party-title.buildPartyTitle` 하나이고(그 파일 머리말), 목록이
   *   규칙을 베끼면 저장 결과와 갈라진다. 편집 창의 **미리보기만** 예외다 —
   *   거기서는 체크할 때마다 즉시 바뀌어야 해서 같은 함수를 직접 부른다.
   */
  readonly autoName: string;
  /**
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **이름이 적고 있지만 이 묶음에 없는 보스 줄임말** — 빈 배열이 정상이다
   *   ═══════════════════════════════════════════════════════════════════════
   *
   * 파티원 신고(2026-10-17): *"진듄더 세카데 4인을 익검4인으로 변경해서 일정
   * 넣을려고하니까 보스일정에 안나옴요"*. 실측 — 보스는 검은 마법사 하나인데 이름은
   * `진듄더 익세하카하적` 이었다. **이름이 거짓말을 하고 있었던 것**이고, 사람은 보스
   * 얼굴이 옆에 있어도 이름을 읽는다.
   *
   * 판정 규칙과 "왜 이름을 일괄로 다시 짓지 않는가" 는 `findStaleBossMentions` 머리말에
   * 있다. 여기서는 두 가지만: **자동 이름은 애초에 판정하지 않고**(어긋날 수 없다),
   * **보스가 없는 묶음도 판정하지 않는다**(기준이 없고, 그 상태는 이미 따로 말한다).
   */
  readonly staleBossMentions: readonly string[];
  /** `null` = 파티 설정(`parties.share_mode`)을 따른다. */
  readonly shareMode: "auto_equal" | "manual" | null;
  /** 상속을 푼 실효 방식. 화면이 "지금 어떻게 나뉘는가"를 말하는 데 쓴다. */
  readonly effectiveShareMode: "auto_equal" | "manual";
  /** 파티 쪽 방식. 상속 중일 때 "파티가 균등이라 균등"임을 말할 수 있다. */
  readonly partyShareMode: "auto_equal" | "manual";
  /**
   * `false` = **결정석만 균등**, 드랍은 비율대로. 발주 근거(2026-10-16):
   * *"분배비율 에 결정석 포함 설정을 넣어. 드랍만 비율로 거는사람도있어"*.
   */
  readonly crystalFollowsShare: boolean;
  readonly bosses: readonly PartyBundleBossWire[];
  readonly members: readonly PartyBundleMemberWire[];
  /** 이 묶음으로 잡힌 런 수. 보관을 막지는 않지만 **무엇이 걸려 있는지** 말해야 한다. */
  readonly runCount: number;
}

/** `GET /api/schedule/parties/{partyId}/bundles` 의 응답 본문. */
export interface PartyBundlesResponse {
  readonly bundles: readonly PartyBundleWire[];
}

/**
 * 일정 잡기 목록의 한 줄 — `GET /api/schedule/bundles/mine`.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **고르는 횟수를 늘리지 않기 위해 존재하는 타입이다** (§1.1.1)
 *   ═══════════════════════════════════════════════════════════════════════════
 *   빈 칸을 누르면 **묶음 하나**를 고르고 끝이어야 한다. 파티를 고른 뒤 묶음을 고르는
 *   2단이 되면 이번 작업은 실패다. 그래서 응답은 "내 모든 파티의 모든 활성 묶음"을
 *   **한 번에** 평평하게 내려 주고, 어느 파티의 것인지는 `partyName` 이 말한다.
 *
 * ★ 얼굴 재료(`bosses` · `members`)를 함께 싣는다. 파티 목록(`Party.bosses`)이 이미
 *   같은 판단을 한 자리이고(2026-10-04 — 파티당 한 건씩 받던 왕복 30건을 0 으로),
 *   묶음은 수가 더 많으므로 더 중요하다.
 */
export interface BundleOptionWire {
  readonly bundleId: string;
  readonly partyId: string;
  readonly bundleNo: number | null;
  /** 묶음 이름. 비우면 서버가 보스 줄임말로 만든 이름이 들어 있다. */
  readonly name: string;
  /**
   * 지금 보스로 만들면 나올 자동 이름. `PartyBundleWire.autoName` 과 같은 값이고
   * 같은 이유로 **서버가** 만든다.
   */
  readonly autoName: string;
  /**
   * 이름이 적고 있지만 이 묶음에 없는 보스 줄임말 (`PartyBundleWire.staleBossMentions`).
   *
   * ★ 이 화면에서는 **고칠 수 없다** — 묶음 이름의 집은 `/parties` 다. 그래서 여기서
   *   하는 일은 경고가 아니라 **찾을 수 있게 하는 것**이다: 줄의 둘째 줄이 실제 보스를
   *   함께 적어, `익검` 묶음을 찾는 사람이 `진듄더 익세하카하적` 이라는 줄에서 그것을
   *   알아볼 수 있게 한다. 신고의 증상이 정확히 "못 찾았다" 였다.
   */
  readonly staleBossMentions: readonly string[];
  /** 어느 파티의 묶음인가. 묶음 이름이 보스 줄임말이라 **이것 없이는 구분이 안 된다**. */
  readonly partyName: string;
  readonly memberCount: number;
  readonly bosses: readonly PartyBundleBossWire[];
  /** 얼굴 줄용 최소 정보. 파티 구성원 전원이며 묶음이 사람을 고르지는 않는다. */
  readonly members: readonly PartyMemberBrief[];
  /**
   * **내가 이 묶음에 데려가는 캐릭터** (묶음 지정 → 파티 기본값 순).
   *
   * ★ id 와 이름을 **둘 다** 싣는다. 이름은 목록이 그리는 값이고, id 는 일정 등록이
   *   서버로 보내는 값이다(`createPartyRuns` 가 캐릭터를 요구한다). 이름으로 id 를
   *   되찾게 하면 화면이 캐릭터 목록을 뒤져 짝을 맞춰야 하고, 같은 이름이 두 월드에
   *   있으면 엉뚱한 캐릭터로 일정이 잡힌다.
   */
  readonly myCharacterId: string | null;
  readonly myCharacterName: string | null;
  /** 묶음 쪽에 실제로 지정이 있는가. 폴백으로 보이는 이름과 가르는 유일한 칸이다. */
  readonly myCharacterAssigned: boolean;
  /**
   * 구성원마다 **이 묶음으로 일정에 가면 데려갈 캐릭터**(묶음 → 파티 → 본캐)의 사람이 넣은
   * 분 전부(분 + 그 줄의 인원). 키 = `personId`, `null` = 캐릭터 없음(게스트 · 본캐 미추적).
   * 일정 잡기 창이 **체크한 참여자**의 배율 합산 미리보기를 서버와 같은 입력으로 그린다
   * (`resolveBossDuration`). ⚠️ 본인 줄도 실려 있지만 **쓰지 않는다** — 본인은 창이 보내는
   * `characterId` 의 값이 쓰인다(서버도 같다). 본인 판정은 화면이 **보는 사람 id 비교**로
   * 한다 — 키 유무로 가리면 캐시가 낡은 동안 새로 들어온 구성원이 본인으로 오인된다.
   */
  readonly memberBossMinutes: Readonly<Record<string, CharacterBossMinutes | null>>;
}

/** `GET /api/schedule/bundles/mine` 의 응답 본문. */
export interface MyBundlesResponse {
  readonly bundles: readonly BundleOptionWire[];
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 묶음 분배를 바꾸는 **세 가지 방법** — 비워 두기가 그중 하나다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `shareMode` + `shares` 두 칸으로 받으면 "비어 있음"이 **두 벌**이 된다(모드가 null ·
 * 비율이 null). 둘을 어긋나게 보낼 수 있고, 어긋나면 상속인지 균등인지 서버가 추측해야
 * 한다. 그래서 세 경우를 **타입으로 못박는다** — 보낼 수 없는 조합이 아예 없다.
 *
 *   · `inherit` — 묶음이 아무것도 정하지 않는다. `party_bundles.share_mode = null` +
 *                 `party_bundle_shares` 행 삭제. **빈 상태가 곧 "파티를 따름"** 이고,
 *                 화면은 이 상태를 0 으로 그리면 안 된다(§1.3 D4 와 같은 기조).
 *   · `equal`   — 이 묶음만 균등. 파티가 `manual` 이어도 여기서는 1/n 이다.
 *   · `manual`  — 가중치를 적는다. **퍼센트가 아니라 가중치**이며(위 머리말), 만분율
 *                 환산은 DB `distribute_meso()` 가 한다 — 화면도 서버도 나눗셈을 하지
 *                 않는다. 전원을 함께 보내야 하고, 빠진 사람을 0 으로 암묵 처리하지
 *                 않는다(`setPartyShares` 와 같은 규약: 한 줄을 못 보낸 버그가 곧바로
 *                 "그 사람 몫은 0" 이라는 금전 약정이 된다).
 */
export type BundleShareInput =
  | { readonly kind: "inherit" }
  | { readonly kind: "equal" }
  | {
      readonly kind: "manual";
      readonly weights: readonly {
        readonly participantId: string;
        /** 이미 `RUN_SHARE_WEIGHT_SCALE` 이 곱해진 정수. */
        readonly weight: number;
      }[];
    };

/**
 * 묶음 만들기·고치기 요청 본문 — **보낸 칸만 바뀐다.**
 *
 * ⚠️ 생략과 `null` 이 **다른 뜻**이다. 보스 목록을 빼면 보존이고, 분배를 `null` 로
 *    보내면 "파티를 따르게 되돌린다"다. 이 구분이 흐려지면 묶음 하나를 고칠 때마다
 *    건드리지도 않은 값이 날아간다(`PUT .../bosses` 가 이미 같은 함정을 지났다).
 */
export interface SaveBundleBody {
  readonly name?: string;
  readonly bossDifficultyIds?: readonly string[];
  /** `bossDifficultyIds` 와 **같은 길이**여야 한다. 원소 `null` = 정하지 않음. */
  readonly durationMinutes?: readonly (number | null)[];
  readonly share?: BundleShareInput;
  readonly crystalFollowsShare?: boolean;
  /** **내 캐릭터만** 고칠 수 있다(아래 ⚠️). `null` = 지정 해제(파티 기본값으로). */
  readonly myCharacterId?: string | null;
}

/**
 * ⚠️ ═══════════════════════════════════════════════════════════════════════════
 *   **남의 캐릭터는 고르지 못한다 — 자료가 없어서다**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   "각자 캐릭터" 를 묶음마다 정하는 것이 발주 요구지만, 고를 **후보**는
 *   `fetchMyRunCharacters`(= 내 추적 캐릭터)뿐이고 남의 캐릭터 목록을 내주는 경로는
 *   이 앱에 없다(만들면 그 사람의 로스터를 전부 공개하는 일이 된다). 서버도 같은 선을
 *   긋는다 — `requireOwnedTrackedCharacter` 는 **부르는 사람 소유**만 통과시킨다.
 *   그래서 묶음 캐릭터는 **각자 자기 줄을** 고치고, 남의 줄은 그 사람이 정해 둔 값
 *   (묶음 지정 → 파티 기본값)을 **읽기 전용으로 보여 준다.**
 *   발주자가 겪던 혼란(`본캐 림흉 돌먹` vs `은월 림흉 돌먹`)은 **자기 캐릭터**가 다른
 *   경우이므로 이 범위로 전부 해결된다.
 */
export const BUNDLE_OTHER_CHARACTER_NOTE =
  "다른 사람의 캐릭터는 본인만 고칠 수 있습니다. 여기 보이는 값은 그 사람이 정해 둔 것입니다.";

/** `crystal_follows_share` 토글 설명 — **끄면 무엇이 달라지는지** 한 줄로 말한다. */
export const BUNDLE_CRYSTAL_FOLLOWS_SHARE_HINT =
  "끄면 결정석은 인원수대로 똑같이 나누고, 드랍만 위 비율로 나눕니다. 결정석은 각자 자기 캐릭터가 먹으므로 균등이 곧 “각자 자기 것” 입니다.";

// ─────────────────────────────────────────────────────────────────────────────
// 게스트 정리 — 숨기기 · 지우기 (2026-10-21)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/schedule/people/guests` 와 `PATCH` 의 응답.
 *
 * ★ `available = false` 는 **오류가 아니다.** 마이그레이션 `20261021120000` 이 아직 적용되지
 *   않아 판정 함수가 없다는 뜻이고, 화면은 "정리 기능을 아직 쓸 수 없습니다" 를 그린다.
 *   오류로 접으면 적용 전 배포에서 사람 고르기 창에 빨간 상자가 뜬다.
 */
export interface GuestManageSnapshot {
  readonly available: boolean;
  readonly guests: readonly GuestManageState[];
}

/** `DELETE /api/schedule/people/guests/{guestId}` 의 응답. */
export interface GuestDeleteResult extends GuestManageSnapshot {
  /** 함께 사라진 파티 구성원 자리 수. 번호는 비워 둔다(§1.4). */
  readonly removedSeats: number;
}
