/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 주간 수익 상세 화면의 **계약** — 서버와 클라이언트가 같은 파일을 본다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 타입만 있으므로 클라이언트 번들에 안전하게 들어간다.
 * (서버 구현은 `./server/income-repo.ts`, 브라우저 호출은 `./data/income-queries.ts`.)
 *
 * ⚠️ **금액 필드는 전부 DB 스냅샷의 사본이다.** 이 화면은 곱하기·나누기·합계를 한 번도
 *    하지 않는다. 결정석 분배는 `distribute_meso` / `resolve_crystal_payout` 가, 주간
 *    합계는 `v_weekly_income` 이 낸다. 웹과 카톡 봇(`!결정석`)이 **같은 답**을 내야 하므로
 *    구현은 DB 한 곳뿐이어야 하고, 이 파일에 등장하는 숫자는 전부 "받아 적은 값"이다.
 *
 * ⚠️ **`null` 은 0 이 아니다** (§1.3 D4). 가격 미확인은 합계에서 빠지고 건수로만 보고된다.
 */

import type {
  BossCycle,
  BossDifficultyId,
  BossDifficultyTier,
  MesoOrUnknown,
  PartyId,
  RunCharacterOption,
  RunId,
  WeekKey,
} from "@/types/domain";

/**
 * 수정 모달의 캐릭터 드롭다운 후보.
 *
 * ★ 일정 화면(`RunCharacterOption`)과 **같은 타입을 그대로 쓴다.** 후보 규칙이
 *   `characters where is_tracked` 로 동일하기 때문이다(§2.1.1). 모양이 같은 타입을
 *   두 번 선언하면 한쪽만 바뀌는 날이 오고, 그날 두 화면의 후보 목록이 갈라진다.
 */
export type IncomeCharacterOption = RunCharacterOption;

/** `boss_clears.source` — 이 기록이 어디서 왔는가. */
export type ClearSource = "manual" | "nexon_api" | "bot";

/**
 * 넥슨 관측과 수동 체크가 다를 때 **어느 쪽이 반영됐는가** (DB-SCHEMA 난제 6).
 *
 * 판정은 트리거가 이미 했다(`effective_cleared`). 우리는 덮어쓰지 않고 **보여 주기만** 한다.
 */
export type ClearWinner = "manual" | "api" | "none";

/** 주간 합계 — `v_weekly_income` 한 행을 그대로 옮긴 것. */
export interface WeeklyIncomeTotals {
  readonly weekKey: WeekKey;
  /** 결정석 분배 몫 합계. */
  readonly crystalIncomeMeso: MesoOrUnknown;
  /** 결정석 외 드랍 분배 몫 합계. **12 상한과 무관하다** (§8-8b). */
  readonly dropIncomeMeso: MesoOrUnknown;
  /** 뷰가 낸 총합. **우리가 두 값을 더하지 않는다.** */
  readonly totalIncomeMeso: MesoOrUnknown;
  readonly clearCount: number;
  /** 그중 주간 보스. 12 상한과 비교하는 값이다(일간·월간은 카운터 밖). */
  readonly weeklyClearCount: number;
  /** 가격 미확인 건수. 합계에서 빠져 있다. */
  readonly unknownPriceCount: number;
  /** 12 상한을 넘긴 클리어 건수. 뷰가 세어 준다. */
  readonly weeklyOverLimitCount: number;
  readonly dropCount: number;
  /** 아직 팔지 않은 드랍 건수. 금액이 없으니 합계에 못 넣는다(§8-6). */
  readonly unsoldDropCount: number;
}

/** 클리어 한 건. */
export interface ClearRecord {
  readonly clearId: string;
  readonly characterId: string | null;
  readonly characterName: string | null;
  readonly worldName: string | null;
  readonly bossDifficultyId: BossDifficultyId;
  /** `boss_difficulties.korean_name` — 이미 `하드 스우` 형태로 난이도를 포함한다. */
  readonly bossDisplayName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle | null;
  /** 주간 보스만 12 카운터에 들어간다(§1). cycle 을 화면이 다시 판정하지 않게 한다. */
  readonly countsTowardWeeklyLimit: boolean;

  /** 입장 시점 파티 인원. **사용자가 고칠 수 있다** (§1.3 D3). */
  readonly partySize: number;
  /** 보스별 상한. **소프트 상한이라 막지 않고 경고만 한다** (§1.3 D5). */
  readonly maxParty: number | null;
  readonly overMaxParty: boolean;
  /**
   * **아무도 인원을 확인한 적이 없는 상태** — `boss_clears.party_size_confirmed` 의 반대값.
   *
   * 넥슨 API 에는 파티 정보가 전혀 없으므로(§1.1) 관측만으로 만들어진 클리어는
   * `party_size` 가 DB 기본값 **1** 로 들어간다. 그 1 은 "솔로였다"는 사실 주장이 아니라
   * "모른다"이다. 6인 파티였다면 수익이 6배로 잡히므로 화면이 반드시 구분해야 한다.
   *
   * ★ 값이 아니라 **별도 비트**로 들고 있어서, 사용자가 "맞아요 솔로였어요"라고 확인한 1 과
   *   아무도 안 본 1 이 구별된다. 확인하면 이 값은 `false` 가 되고 다시 켜지지 않는다.
   */
  readonly partySizeUnconfirmed: boolean;
  /** 그 런에 `going` 으로 등록된 인원. `partySize` 와 다르면 화면이 경고한다. */
  readonly goingCount: number | null;

  /** 내 몫 — `boss_clears.crystal_share_meso` 스냅샷. */
  readonly shareMeso: MesoOrUnknown;
  /** 파티 전체가 받은 총액 — 게임 규칙(`party_size × floor(가격/party_size)`). */
  readonly potMeso: MesoOrUnknown;
  /** 솔로 기준가 스냅샷. */
  readonly basePriceMeso: MesoOrUnknown;
  /** 분배 비율(basis point). 균등이면 `10000/n` 근사값이 들어 있다. */
  readonly shareBp: number | null;

  readonly source: ClearSource;
  readonly manualCleared: boolean | null;
  readonly apiCleared: boolean | null;
  /** 두 출처가 다르다. **덮어쓰지 않고 어느 쪽이 이겼는지 보여 준다** (난제 6). */
  readonly hasConflict: boolean;
  readonly winner: ClearWinner;

  readonly runId: RunId | null;
  readonly runNo: number | null;
  readonly partyName: string | null;
  readonly clearedAt: string | null;
}

/**
 * 캐릭터 한 명의 주간 수익 — `v_weekly_crystal_income_by_character` 한 행 + 그 캐릭터의 클리어 목록.
 *
 * **캐릭터 단위가 1층인 이유**: 주간 결정석 12개 상한이 캐릭터당이기 때문이다(§1).
 * 사용자 합계는 이 층을 다시 합산한 값이고, 그 합산도 뷰가 한다.
 */
export interface CharacterIncome {
  readonly characterId: string | null;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly incomeMeso: MesoOrUnknown;
  readonly clearCount: number;
  readonly weeklyClearCount: number;
  readonly dailyClearCount: number;
  readonly monthlyClearCount: number;
  readonly unknownPriceCount: number;
  readonly weeklyOverLimitCount: number;
  /** `weekly_crystal_sell_limit()` — 12 를 코드에 박지 않는다. */
  readonly weeklySellLimit: number;
  readonly clears: readonly ClearRecord[];
}

/**
 * 이번 주에 내가 `going` 으로 등록한 일정 한 건.
 *
 * 클리어 체크박스(§1.2 2순위)의 대상이다. 체크하면 `boss_clears.manual_cleared` 가 켜지고
 * 그 주 수익에 즉시 반영된다.
 */
export interface ScheduledRunClear {
  readonly runId: RunId;
  readonly runNo: number;
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly bossDifficultyId: BossDifficultyId;
  readonly bossDisplayName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  readonly scheduledAt: string | null;
  /** 1/n 의 분모 기본값. `entry_party_size` 가 비면 `capacity` 를 쓴다. */
  readonly entryPartySize: number;
  readonly goingCount: number;
  readonly maxParty: number | null;
  readonly characterId: string | null;
  readonly characterName: string | null;
  /** 결정석 솔로 기준가. `null` 이면 미확인이며 0 이 아니다. */
  readonly crystalPriceMeso: MesoOrUnknown;

  /** 집계에 실제로 반영되는 상태(`effective_cleared`). */
  readonly cleared: boolean;
  readonly manualCleared: boolean | null;
  readonly apiCleared: boolean | null;
  readonly hasConflict: boolean;
  readonly winner: ClearWinner;
  readonly clearId: string | null;
}

/** 아직 팔지 않은 드랍 한 건. **금액이 `null` 이라 합계에 못 들어간다** (§8-6). */
export interface UnsoldDrop {
  readonly dropId: string;
  readonly itemName: string;
  readonly runId: RunId;
  readonly bossDisplayName: string;
  readonly recordedAt: string;
}

/** 주간 수익 화면이 한 번에 받는 전부. */
export interface WeeklyIncomeDetail {
  readonly weekKey: WeekKey;
  /** 행이 없는 주는 `null` 이다 — **"0원을 벌었다"와 "아직 아무것도 없다"는 다르다.** */
  readonly totals: WeeklyIncomeTotals | null;
  readonly characters: readonly CharacterIncome[];
  readonly runs: readonly ScheduledRunClear[];
  readonly unsoldDrops: readonly UnsoldDrop[];
  /**
   * 수정 모달의 캐릭터 드롭다운 후보 — **추적 중인 내 캐릭터 전부**.
   *
   * `characters` 는 "이번 주에 클리어가 있는 캐릭터"라 후보로 쓸 수 없다. 클리어를
   * 아직 하나도 안 한 캐릭터로 옮기는 것이 정확히 이 드롭다운이 필요한 경우다.
   * 빈 배열은 오류가 아니라 **추적 캐릭터가 0명**인 정상 상태다(옵트인, §2.1.1).
   */
  readonly characterOptions: readonly IncomeCharacterOption[];
}

/** `GET /api/income` · 두 mutation 의 응답 — 항상 화면 전체를 다시 준다. */
export interface WeeklyIncomeResponse {
  readonly detail: WeeklyIncomeDetail;
}

export interface UpdatePartySizeInput {
  readonly clearId: string;
  readonly partySize: number;
  /** 응답으로 다시 그릴 주차. 화면이 보고 있는 주차를 그대로 넘긴다. */
  readonly weekKey: WeekKey;
}

export interface SetRunClearInput {
  readonly runId: RunId;
  readonly cleared: boolean;
  readonly weekKey: WeekKey;
}

/**
 * 클리어를 **다른 내 캐릭터에 귀속**시킨다 (§1 — 클리어와 12개 상한의 단위는 캐릭터).
 *
 * ⚠️ **금액은 바뀌지 않는다.** 분배는 `resolve_crystal_payout(run, user, …)` 가
 *    사람 단위로 정하므로 내 캐릭터끼리 옮겨도 내 몫은 그대로다. 바뀌는 것은
 *    **어느 캐릭터의 12개 카운터에 들어가는가**와 월드별 90개 집계(§1.3 D2)다.
 */
export interface UpdateClearCharacterInput {
  readonly clearId: string;
  readonly characterId: string;
  readonly weekKey: WeekKey;
}
