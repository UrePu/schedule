/**
 * 넥슨 응답을 **정규화한** 모양. 화면·봇·동기화가 보는 유일한 형태다.
 *
 * snake_case 원본을 그대로 흘려보내지 않는 이유:
 * - 플래그가 문자열이라 원본을 그대로 쓰면 반드시 사고가 난다(§1.0).
 * - `cycle` 은 우리 enum 과 값이 다르다. 경계에서 한 번만 접는다.
 * - 원본 필드명이 화면까지 새면 넥슨이 필드를 바꿀 때 화면이 같이 깨진다.
 *
 * 이 파일은 **타입만** 담아 클라이언트 번들에도 안전하게 들어간다.
 */

import type { Database } from "@/types/database";

type BossCycle = Database["public"]["Enums"]["boss_cycle"];
type BossDifficultyTier = Database["public"]["Enums"]["boss_difficulty_tier"];

/** `/character/list` 의 캐릭터 1명. **이미지가 없다** — 초상화는 별도 1콜이다(§2.1.1). */
export interface NexonCharacterSummary {
  readonly ocid: string;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
}

/**
 * 넥슨 계정 1개와 그 계정의 캐릭터들.
 * `account_list` 는 **배열**이라 키 하나가 복수 계정을 돌려줄 수 있다(조건 미확인).
 */
export interface NexonAccountCharacters {
  readonly accountId: string | null;
  readonly characters: readonly NexonCharacterSummary[];
}

/** `/character/list` 응답 전체. 키 유효성 증명이자 소유 캐릭터 목록이다. */
export interface NexonCharacterListResult {
  readonly accounts: readonly NexonAccountCharacters[];
  /** 모든 계정의 캐릭터를 합친 편의 필드. */
  readonly characters: readonly NexonCharacterSummary[];
}

/** `/character/basic` — 초상화를 얻는 유일한 경로. */
export interface NexonCharacterBasicResult {
  readonly ocid: string;
  readonly characterName: string | null;
  readonly worldName: string | null;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
  readonly guildName: string | null;
  /** ★ `null` 은 **정상 상태**다. 화면은 실루엣을 그린다. 에러가 아니다(§2.1.1). */
  readonly imageUrl: string | null;
}

/**
 * `/character/basic` + **경험치** — 봇 `!%` 가 날짜별로 읽는다(2026-11-18).
 *
 * ★ `NexonCharacterBasicResult` 를 넓히지 않고 따로 둔 이유: 프록시 라우트
 *   (`api/nexon/character/basic`)가 그 결과 객체를 **통째로 JSON 으로 내보낸다.** 거기에 칸을
 *   더하면 초상화 응답 본문이 바뀐다. 경험치가 필요한 곳만 이 타입을 받는다.
 */
export interface NexonCharacterBasicWithExp extends NexonCharacterBasicResult {
  /** 넥슨이 돌려준 기준일. `date` 없이 부르면 `null` 이다(실측). */
  readonly date: string | null;
  /** 현재 레벨에서 보유한 경험치(정수). 못 쓰는 값이면 `null`. */
  readonly characterExp: number | null;
  /**
   * 현재 레벨 경험치 퍼센트 — **넥슨이 준 문자열 그대로**(`"7.143"`). 소수 셋째 자리에서
   * 반올림된 값이라 부동소수로 다시 찍으면 `7.14` 처럼 자릿수가 흔들린다. 숫자로 왔으면
   * 문자열로 바꾸고, 숫자 모양이 아니면 `null`.
   */
  readonly characterExpRate: string | null;
}

/** 스케줄러의 보스 항목 1건. */
export interface NexonBossEntry {
  /** 한글 보스명. `bosses.nexon_content_name` 과의 조인 키다. */
  readonly contentName: string | null;
  /** 우리 enum 으로 접은 난이도. 모르는 값이면 null. */
  readonly difficulty: BossDifficultyTier | null;
  /** 접기 전 원본. 미매핑을 기록할 때 필요하다. */
  readonly rawDifficulty: string | null;
  /** 우리 enum 으로 접은 주기. 모르는 값이면 null. */
  readonly cycle: BossCycle | null;
  /** 접기 전 원본(`bossDaily` 등). */
  readonly rawCycle: string | null;
  /** "이 보스를 갈 생각이다" — 인게임 스케줄러 등록 여부. */
  readonly registered: boolean | null;
  /** "깼다" — 현재 상태일 뿐 이력이 아니다(§1.1). */
  readonly cleared: boolean | null;
  readonly listOrderNo: number | null;
}

/** 스케줄러의 일간/주간 항목 1건 (보스가 아닌 숙제). */
export interface NexonChoreEntry {
  readonly contentName: string | null;
  readonly type: string | null;
  readonly registered: boolean | null;
  readonly nowCount: number | null;
  readonly maxCount: number | null;
  readonly questState: string | null;
}

/**
 * `/scheduler/character-state` 정규화 결과.
 *
 * ★ **빈 응답은 "그날 접속하지 않았다"**는 뜻이며 에러가 아니다(§1.1).
 *   `bosses` 가 빈 배열인 것으로 표현되고, 화면은 빈 상태를 그린다.
 */
export interface NexonSchedulerStateResult {
  /** KST 일 단위(시·분 0). 이 값은 **지연 시간이 아니라 기준일**이다. */
  readonly date: string | null;
  readonly characterName: string | null;
  readonly worldName: string | null;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
  readonly bosses: readonly NexonBossEntry[];
  readonly dailyContents: readonly NexonChoreEntry[];
  readonly weeklyContents: readonly NexonChoreEntry[];
  readonly weeklyBossClearCount: number | null;
  /** 실측 12. **코드에 12를 박지 않고** 이 값을 그대로 보관한다. */
  readonly weeklyBossClearLimitCount: number | null;
}

/** 넥슨 호출 1건의 결과 요약. 호출량 장부에 그대로 들어간다. */
export interface NexonCallOutcome {
  readonly ok: boolean;
  /** 응답을 못 받았으면 null. */
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  /** 429 / `OPENAPI00007`. 받으면 그 자격증명의 호출을 즉시 멈춘다. */
  readonly rateLimited: boolean;
}
