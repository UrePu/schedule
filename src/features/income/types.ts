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

/**
 * 주간 합계 — `v_weekly_income` 한 행에서 **일간분을 뺀 값**.
 *
 * 일간 보스는 범위 밖이다(2026-08-18 발주자 지시). 이미 쌓인 일간 클리어를 지우지 않으므로
 * 읽는 쪽에서 뺀다 — 방법과 정확성은 `server/crystal-scope.ts` 머리말 참고.
 * 12개 상한 관련 값은 **한 글자도 바뀌지 않는다**(일간은 그 카운터에 들어간 적이 없다).
 */
export interface WeeklyIncomeTotals {
  readonly weekKey: WeekKey;
  /** 결정석 분배 몫 합계. */
  readonly crystalIncomeMeso: MesoOrUnknown;
  /** 결정석 외 드랍 분배 몫 합계. **12 상한과 무관하다** (§8-8b). */
  readonly dropIncomeMeso: MesoOrUnknown;
  /** 뷰가 낸 총합. **우리가 두 값을 더하지 않는다.** */
  readonly totalIncomeMeso: MesoOrUnknown;
  /** 주간+월간 클리어 수. **일간은 세지 않는다.** */
  readonly clearCount: number;
  /** 그중 주간 보스. 12 상한과 비교하는 값이다(월간은 카운터 밖). */
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
  /** 주간+월간 클리어 수. **일간은 세지 않는다.** */
  readonly clearCount: number;
  readonly weeklyClearCount: number;
  readonly monthlyClearCount: number;
  readonly unknownPriceCount: number;
  readonly weeklyOverLimitCount: number;
  /** `weekly_crystal_sell_limit()` — 12 를 코드에 박지 않는다. */
  readonly weeklySellLimit: number;
  readonly clears: readonly ClearRecord[];
}

/**
 * `run_drops.share_mode` — DB enum `public.drop_share_mode` 의 값 **그대로**.
 *
 * - `party_default` — 그 런의 기본 분배 규칙(`v_run_share_weights`)을 따른다. 기본값.
 * - `solo`          — `solo_participant_id` 한 사람이 전부 가져간다.
 * - `custom`        — 이 드랍 한 건에만 적용되는 비율(`run_drop_shares`).
 *
 * ⚠️ **`custom` 은 읽기 전용이다** (2026-08-18 판단). 값이 존재하므로 타입에는 있고 화면도
 *    그렇게 표시하지만, 우리 쓰기 경로는 `party_default` 와 `solo` 만 만든다.
 *    이유: 건별 비율 편집은 합계 10000bp 를 맞추는 전용 편집기가 필요한데, 런 단위
 *    사용자 지정 비율(`party_runs.share_mode = 'manual'` + `set_run_shares`)이 이미
 *    있고 `party_default` 가 그것을 그대로 따른다 — 같은 일을 두 번 만들 이유가 없다.
 *    DB 쪽 지원은 그대로 살아 있으므로 필요해지면 UI 만 붙이면 된다.
 */
export type DropShareMode = "party_default" | "custom" | "solo";

/**
 * 드랍을 나눠 가질 수 있는 사람 — 그 런에 `going` 으로 등록된 참가자.
 *
 * 출처는 뷰 `v_run_share_weights` 이며 **게스트도 포함된다**. `solo` 분배에서 "누가
 * 다 가져가는가"를 고르는 후보이고, 화면은 §1.4 대로 `member_no` 를 함께 보여 준다 —
 * 카톡 평문에서 "3번"으로 부를 수 있어야 하기 때문이다.
 */
export interface RunDropParticipant {
  readonly participantId: string;
  /** 관리 번호. **재부여되지 않는다** (§1.4). 없는 경우도 있어 `null` 을 허용한다. */
  readonly memberNo: number | null;
  readonly displayName: string;
}

/**
 * 런 하나에서 나온 결정석 **외** 드랍 한 건.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `saleAmountMeso === null` 은 **"아직 안 팔았다"이지 0 이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * DB 컬럼 주석이 그렇게 못박고 있고, 집계 뷰(`v_run_drop_settlement`)가 그런 행을 아예
 * 빼고 `v_weekly_unsold_drops` 가 건수로만 센다. 모르는 값을 0 으로 채우면 "0메소를
 * 벌었다"는 거짓이 된다(§1.3 D4 와 같은 기조).
 *
 * ⚠️ **`myShareMeso` 는 화면이 계산한 값이 아니다.** `distribute_meso()` 가 낸
 *    `v_run_drop_settlement.amount_meso` 를 그대로 옮긴다. 화면이 1/n 을 다시 적으면
 *    웹과 카톡 봇의 답이 갈라진다 — 이 저장소에서 이미 두 번 일어난 사고다.
 */
export interface RunDropRecord {
  readonly dropId: string;
  readonly runId: RunId;
  readonly itemName: string;
  /** **`null` = 미판매.** 0 이 아니다. */
  readonly saleAmountMeso: MesoOrUnknown;
  /** 금액이 처음 채워진 시각. 트리거가 찍는다 — 우리가 보내지 않는다. */
  readonly soldAt: string | null;
  readonly shareMode: DropShareMode;
  readonly soloParticipantId: string | null;
  /** `solo` 일 때 다 가져가는 사람의 표시 이름. 참가자가 빠졌으면 `null`. */
  readonly soloDisplayName: string | null;
  readonly note: string | null;
  /**
   * 이 드랍에서 **내 몫** — `v_run_drop_settlement.amount_meso` 사본.
   *
   * 미판매면 `null`(모름)이다. 판매됐는데 내가 수령자가 아니면 `0`(사실)이다.
   * 두 상태는 다르므로 접지 않는다.
   */
  readonly myShareMeso: MesoOrUnknown;
  /** 이 드랍을 나눠 갖는 사람 수 — `v_run_drop_recipients` 가 해석한 결과. */
  readonly recipientCount: number;
  readonly recordedAt: string;
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

  /**
   * 이 일정에서 나온 결정석 **외** 드랍. 판매 전 기록도 함께 들어 있다.
   *
   * ★ 드랍을 **런에 매다는** 이유: 드랍은 특정 런에서 나오고 그 자리 사람들끼리
   *   나눈다(`run_drops.run_id`). 사용자 단위 목록으로 만들면 "누구랑 나누는가"를
   *   다시 유추해야 하고, 그 유추가 곧 분배 계산의 복제다.
   */
  readonly drops: readonly RunDropRecord[];
  /** `solo` 분배에서 고를 수 있는 사람들 — 그 런의 `going` 참가자(게스트 포함). */
  readonly dropParticipants: readonly RunDropParticipant[];
}

/**
 * 넥슨 계정 하나의 이번 주 결정 사용량 — **주 90개 천장** (§1.3 D2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 기준은 **월드가 아니라 넥슨 계정**이다 (2026-08-18 발주자 정정)
 * ─────────────────────────────────────────────────────────────────────────────
 * 집계 경로는 `boss_clears.character_id → characters.nexon_account_ref →
 * credential_nexon_accounts → user_credentials` 이며, 그 조인은 뷰
 * `v_character_sync_source` 에 이미 있다 — **스키마 변경 없이** 질의 시점에 묶는다.
 *
 * ⚠️ **경고이지 차단이 아니다.** 넘어도 저장을 막지 않고 표시 수익을 깎지도 않는다.
 * ⚠️ **실제보다 낮은 값이다.** 일간 보스가 범위 밖이라 일간 결정석이 빠져 있다. 이 숫자를
 *    그리는 화면은 그 사실을 문장으로 함께 말해야 한다 —
 *    `TRACKED_SCOPE_NOTE`(`@/lib/domain/boss-scope`).
 */
export interface AccountCrystalUsage {
  /** `user_nexon_accounts.id`. 계정 출처 기록이 없는 묶음은 `null`. */
  readonly accountRef: string | null;
  /** 화면에 그대로 쓰는 이름. 키 라벨 → 대표 캐릭터명 → 기본 문구 순으로 고른다. */
  readonly label: string;
  /** 주간+월간 합계. **일간은 빠져 있다.** */
  readonly crystalCount: number;
  readonly weeklyCount: number;
  readonly monthlyCount: number;
  /** 이 계정에서 이번 주 클리어가 잡힌 캐릭터 수. */
  readonly characterCount: number;
  /** ← `public.world_crystal_sell_limit()`. 90 을 코드에 박지 않는다. */
  readonly limit: number;
  /** 남은 칸. 음수로 내려가지 않는다. */
  readonly remaining: number;
  readonly overLimit: boolean;
  /** 상한의 80% 이상. 넘지 않았어도 알려 줘야 대응할 수 있다. */
  readonly nearLimit: boolean;
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
  /**
   * 넥슨 **계정당** 주 90개 결정 천장 (§1.3 D2 — 2026-08-18 정정: 월드가 아니라 계정).
   *
   * 결정이 1개 이상 잡힌 계정만 들어 있다. **경고일 뿐 아무것도 막지 않으며**,
   * 일간이 빠져 있어 **실제보다 낮다** — 화면이 그 사실을 문장으로 밝혀야 한다.
   */
  readonly accountCrystalUsage: readonly AccountCrystalUsage[];
  /** 어느 계정에도 붙이지 못한 클리어 수. 0 이 아니면 위 숫자가 그만큼 더 낮다. */
  readonly unassignedCrystalCount: number;
  /**
   * 상단 요약 카드 — **대시보드의 `결정석 수익` 카드와 글자 하나까지 같은 값**이다.
   *
   * 조립처가 `server/crystal-summary.ts` 하나뿐이라 두 화면이 갈라질 수 없다.
   * `null` 이면 이번 주 집계도 계획 최대치도 없다는 뜻이며 카드가 빈 상태를 그린다
   * (0 원을 벌었다는 주장이 아니다).
   */
  readonly crystalSummary: CrystalIncomeSummary | null;
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
 *    **어느 캐릭터의 12개 카운터에 들어가는가**와 넥슨 계정별 90개 집계(§1.3 D2)다.
 */
export interface UpdateClearCharacterInput {
  readonly clearId: string;
  readonly characterId: string;
  readonly weekKey: WeekKey;
}

/**
 * 드랍을 기록한다 — **판매액 없이도 저장된다.**
 *
 * ⚠️ `saleAmountMeso: null` 이 정상 경로다. 발주 요구의 기본 흐름이 "아이템만 먼저 적고
 *    판매액은 나중에 채운다"이므로 금액은 **필수가 아니다**. `null` 로 들어간 행은
 *    합계에서 빠지고 `unsold_drop_count` 로 따로 세어진다.
 */
export interface AddRunDropInput {
  readonly runId: RunId;
  readonly itemName: string;
  /** `null` = 아직 안 팔았다. 0 이 아니다. */
  readonly saleAmountMeso: number | null;
  /** 쓰기 경로는 두 값만 만든다 — `custom` 은 읽기 전용(`DropShareMode` 주석). */
  readonly shareMode: Exclude<DropShareMode, "custom">;
  /** `shareMode === "solo"` 일 때만 값이 있다. DB CHECK 가 같은 규칙을 강제한다. */
  readonly soloParticipantId: string | null;
  readonly note: string | null;
  readonly weekKey: WeekKey;
}

/**
 * 드랍을 고친다. **보내지 않은 필드는 건드리지 않는다** — 특히 `saleAmountMeso` 는
 * `undefined`(안 보냄)와 `null`(미판매로 되돌림)이 서로 다른 뜻이라 접지 않는다.
 */
export interface UpdateRunDropInput {
  readonly dropId: string;
  readonly itemName?: string;
  readonly saleAmountMeso?: number | null;
  readonly shareMode?: Exclude<DropShareMode, "custom">;
  readonly soloParticipantId?: string | null;
  readonly note?: string | null;
  readonly weekKey: WeekKey;
}

/**
 * 드랍을 지운다. **되돌릴 수 없다** — 딸린 `run_drop_shares` 도 `on delete cascade` 로
 * 함께 사라진다. 그래서 화면이 확인 단계를 둔다.
 */
export interface RemoveRunDropInput {
  readonly dropId: string;
  readonly weekKey: WeekKey;
}

// ═════════════════════════════════════════════════════════════════════════════
// 결정석 수익 카드 — **주간/월간 분리 + 이론상 최대치** (2026-08-19 발주자 지시)
// ═════════════════════════════════════════════════════════════════════════════
//
// 발주자: *"주간 월간은 따로놔야지"*, 그리고 결정석 수익에 **이론상 최대치**를 붙일 것.
//
// ⚠️ **대시보드 카드와 수익 화면 상단 요약이 같은 타입 하나를 쓴다.** 계산이 두 벌이면
//    두 화면이 다른 숫자를 말한다 — 이 저장소에서 이미 두 번 일어난 사고다. 값을 만드는
//    곳은 `server/crystal-summary.ts` 한 곳이고, 그 안의 산수는 전부 DB 뷰가 끝냈다
//    (`v_weekly_income` 의 주기별 컬럼 · `v_weekly_plan_potential`, 마이그레이션 27).

/** 한 주기(주간 또는 월간)의 실제 집계. **두 주기를 절대 합치지 않는다.** */
export interface CrystalCycleTally {
  readonly clearCount: number;
  /** 그 주기의 결정석 수령액. `null` 은 집계 불가이며 0 이 아니다. */
  readonly incomeMeso: MesoOrUnknown;
  /** 가격 미확인 건수. 위 금액에서 빠져 있다 (§1.3 D4). */
  readonly unknownPriceCount: number;
}

/**
 * 한 주기의 **이론상 최대치** — 켜진 계획을 전부 클리어했을 때.
 *
 * ⚠️ **목표가 아니라 상한이다.** 실제로 갈 생각이 없는 보스도 계획에 켜져 있으면 분모가
 *    커진다. 화면은 그 뜻을 문장으로 함께 말해야 한다.
 * ⚠️ **가격 미확인은 합계에서 빠지고 건수로만 센다** (§1.3 D4 — 0 으로 더하면 최대치가
 *    과소평가되고, 그건 D4 가 금지한 바로 그 짓이다).
 */
export interface CrystalPotentialCycle {
  /** 켜진 계획 수. */
  readonly plannedCount: number;
  /** 그중 12개 상한 안에 들어 금액에 반영된 수(월간은 상한이 없어 전부). */
  readonly countedCount: number;
  /** 상한을 넘어 금액에서 빠진 계획 수. 캐릭터당으로 판정된다. */
  readonly overLimitCount: number;
  readonly unknownPriceCount: number;
  readonly potentialMeso: MesoOrUnknown;
}

/**
 * 이번 주 계획 전체의 이론상 최대치. ← `v_weekly_plan_potential`
 *
 * ⚠️ **주차 축이 없다.** 계획은 "매주 이 보스를 돈다"는 현재 상태이고 과거 주차의 계획
 *    스냅샷은 어디에도 남지 않는다. 그래서 최대치는 **이번 주에만** 뜻이 있고, 과거 주차
 *    내역에는 붙이지 않는다.
 */
export interface CrystalPotential {
  readonly weekly: CrystalPotentialCycle;
  readonly monthly: CrystalPotentialCycle;
  /** 주간 + 월간. 뷰가 낸 두 값의 합이며 미확인은 어느 쪽에도 들어가 있지 않다. */
  readonly totalPotentialMeso: MesoOrUnknown;
  /** 계획이 하나라도 켜진 추적 캐릭터 수. */
  readonly characterCount: number;
}

/**
 * 주간 보스 칸 — `주간 보스 40 / 84건` 의 분자와 분모.
 *
 * **분모는 언제나 `추적 캐릭터 수 × 캐릭터당 상한`이다** (§1.1.1). 12개 상한은 캐릭터당
 * 이므로 합산 분자에 캐릭터 하나의 상한을 붙이면 화면이 `40 / 12건` 을 그린다 — 실제로
 * 그렇게 나갔던 화면이다. 대시보드의 `WeeklyBossCapacity` 가 이 모양을 그대로 만족한다.
 */
export interface WeeklyBossSlots {
  readonly trackedCount: number;
  /** 캐릭터당 상한(보통 12). 출처가 하나도 없으면 `null` — 12 를 지어내지 않는다. */
  readonly perCharacterLimit: number | null;
  /** 추적 0명이거나 상한을 모르면 `null`. **`0` 이 아니다** (분모 없음 ≠ 상한 0). */
  readonly limitTotal: number | null;
  readonly clearedTotal: number;
}

/** 결정석 수익 카드 한 장이 필요로 하는 전부. 대시보드와 수익 화면이 **같은 값**을 쓴다. */
export interface CrystalIncomeSummary {
  readonly weekKey: WeekKey;
  /** 주간 + 월간 결정석. 일간은 범위 밖이라 들어 있지 않다(2026-08-18 발주자 결정). */
  readonly crystalIncomeMeso: MesoOrUnknown;
  readonly dropIncomeMeso: MesoOrUnknown;
  readonly totalIncomeMeso: MesoOrUnknown;
  readonly weekly: CrystalCycleTally;
  /**
   * `monthly` 가 어느 **달**의 집계인가 (`2026-08`). 2026-08-20 발주자 지시로 월간 보스는
   * 주차가 아니라 달 단위로 센다 — *"저번주에 월간 잡은걸 안보여주면 어떡함"*.
   *
   * `null` 이면 옛 경로가 만든 값이라 `monthly` 가 **그 주차**의 숫자다. 화면은 이 값이
   * 있을 때만 "이번 달"이라고 말해야 한다 — 라벨이 범위를 앞질러 가면 그게 곧 거짓말이다.
   */
  readonly monthKey: string | null;
  /** 월간 보스 집계. 범위는 위 `monthKey` 가 말한다. */
  readonly monthly: CrystalCycleTally;
  readonly dropCount: number;
  readonly unsoldDropCount: number;
  readonly weeklyOverLimitCount: number;
  /** 주간+월간 합산 미확인 건수. 주기별 값은 각 `CrystalCycleTally` 안에 있다. */
  readonly unknownPriceCount: number;
  readonly slots: WeeklyBossSlots;
  /**
   * 이론상 최대치. **이번 주가 아니면 `null`** 이다 — 과거 주차의 계획은 남지 않는다.
   * 계획이 하나도 없어도 `null` 이다(최대치를 0 으로 찍으면 "0원이 상한"이 된다).
   */
  readonly potential: CrystalPotential | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 원장(ledger) — **캘린더와 주차별 내역이 같은 데이터를 본다**
// ═════════════════════════════════════════════════════════════════════════════
//
// 발주자 지시(2026-08-19): *"캘린더를 박아놔서 언제 무슨보스를 돌았고 하는 내역들을
// 볼수있게 해봐 주차별로 32주차엔 얼마 벌었다. 드랍 뭐였다 등등"*
//
// ★ **주차가 1층이다.** 달력은 월 격자로 그리지만 이 앱의 회계 단위는 주(목 00:00 KST
//   리셋)다. 그래서 서버는 **주차 묶음**을 주고, 달력은 그것을 날짜로 흩어 그린다.
//   같은 원장을 두 번 조회하지 않으므로 달력과 주차 목록이 다른 숫자를 말할 수 없다.

/** 원장에 실리는 드랍 한 건 — **판매된 것만**. 미판매는 금액이 없어 합계에 못 들어간다. */
export interface LedgerDrop {
  readonly dropId: string;
  readonly runId: RunId;
  readonly itemName: string;
  /** 그 드랍이 나온 일정의 보스. 런이 사라졌으면 `null`. */
  readonly bossDisplayName: string | null;
  readonly bossDifficultyId: BossDifficultyId | null;
  readonly difficulty: BossDifficultyTier | null;
  /** 판매 총액. */
  readonly saleAmountMeso: MesoOrUnknown;
  /** 그중 **내 몫** — `v_run_drop_settlement.amount_meso` 사본. 화면이 나누지 않는다. */
  readonly myShareMeso: MesoOrUnknown;
}

/** 주차 한 줄. 총액 · 주간/월간 분리 · 클리어 목록 · 드랍 목록을 함께 싣는다. */
export interface WeekLedgerEntry {
  readonly weekKey: WeekKey;
  /** 주 시작 = 그 주의 목요일 00:00 KST (ISO 문자열). */
  readonly startsAt: string;
  /** 주 끝 = 다음 목요일 00:00 KST. **배타 경계**다. */
  readonly endsAt: string;
  /** 주간 + 월간 결정석. 일간은 들어 있지 않다. */
  readonly crystalIncomeMeso: MesoOrUnknown;
  readonly dropIncomeMeso: MesoOrUnknown;
  readonly totalIncomeMeso: MesoOrUnknown;
  readonly weekly: CrystalCycleTally;
  readonly monthly: CrystalCycleTally;
  readonly weeklyOverLimitCount: number;
  readonly unsoldDropCount: number;
  /** 그 주의 클리어 전부. **일간은 빠져 있다.** 달력이 `clearedAt` 으로 날짜에 흩는다. */
  readonly clears: readonly ClearRecord[];
  readonly drops: readonly LedgerDrop[];
}

/** `GET /api/income/ledger?from=…&to=…` 의 응답. */
export interface IncomeLedgerResponse {
  /** 최신 주차가 먼저. **기록이 없는 주차는 아예 들어 있지 않다.** */
  readonly weeks: readonly WeekLedgerEntry[];
  /** 수정 모달의 캐릭터 드롭다운 후보 — 추적 중인 내 캐릭터 전부(§2.1.1). */
  readonly characterOptions: readonly IncomeCharacterOption[];
  /**
   * 기록이 있는 **가장 오래된 주차**. `null` 이면 원장이 통째로 비어 있다.
   * "더 보기" 버튼은 이 값과 요청 범위를 비교해 더 볼 것이 남았는지 판단한다 —
   * 서버가 페이지 커서를 들고 있지 않아도 되고, 빈 주차만 잔뜩 부르는 일도 없다.
   */
  readonly earliestWeekKey: WeekKey | null;
}
