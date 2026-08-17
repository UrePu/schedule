import type {
  BossCycle,
  BossDifficultyId,
  BossDifficultyTier,
  WeekKey,
} from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터별 "매주 가는 보스" — 화면·서버가 공유하는 타입 (DB-SCHEMA 난제 16)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 파일에 `server-only` 를 넣지 않는다. 서버 repo 와 클라이언트 조회 모듈이 **같은
 * 계약**을 봐야 하고, 타입만 담고 있어 클라이언트 번들에 들어가도 새는 것이 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 계획과 진행은 **둘 다 넥슨이 준다** (§1.1.1 — 2026-08-17 실측)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 캐릭터의 실측 응답에서 `registration_flag=true` 12건, `complete_flag=true` 10건이
 * 나왔다. 즉 "이번 주에 갈 보스"와 "이미 잡은 보스"를 **사용자가 손으로 만들 필요가 없다.**
 * 계획 화면은 동기화 결과를 **보정**하는 곳이지 처음부터 채우는 곳이 아니다.
 *
 * 저장소 대응:
 *   registration_flag → `character_boss_plans.api_registered` (`sync_character_boss_plan`)
 *   complete_flag     → `boss_clears.api_cleared`             (난제 6 의 최신성 규칙)
 *   두 값의 결합      → 뷰 `v_character_boss_plan_status.is_active` / `is_cleared`
 *
 * ⚠️ **진행률을 TS 에서 다시 계산하지 않는다.** `planned/cleared/remaining` 과 12개 상한
 *    판정은 전부 `v_character_weekly_boss_progress` 가 낸다. 웹과 카톡 봇이 같은 답을
 *    내야 하므로 구현은 DB 에 하나만 있어야 한다.
 */

/** 이 계획 행이 어느 출처에서 왔는가. ← 뷰 `v_character_boss_plan_status.origin` */
export type PlanOrigin = "manual" | "nexon_api" | "both";

/**
 * 계획 한 줄. ← 뷰 `v_character_boss_plan_status` 의 한 행
 *
 * ★ **난이도까지 특정된 보스다.** `bossDisplayName` 은 `boss_difficulties.korean_name`
 *   이라 이미 `하드 최초의 대적자` 형태다 — "스우"가 아니라 "하드 스우"여야 한다는
 *   요구가 이 컬럼 하나로 충족된다.
 */
export interface CharacterBossPlan {
  readonly planId: string;
  readonly characterId: string;
  readonly bossDifficultyId: BossDifficultyId;
  readonly bossId: string;
  /** ← `boss_difficulties.korean_name`. 예: `하드 최초의 대적자` */
  readonly bossDisplayName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  /** ← `boss_difficulties.max_party`. **소프트 상한**이다 (§1.3 D5). */
  readonly maxParty: number | null;
  readonly released: boolean;
  /** 트리거 계산값 `coalesce(manual_active, api_registered)`. 목록의 켜짐/꺼짐. */
  readonly isActive: boolean;
  /** 사람이 직접 내린 판단. `null` = 미판단. **동기화가 절대 덮어쓰지 않는다.** */
  readonly manualActive: boolean | null;
  /** 넥슨 `registration_flag`. 수동 값을 이기지 못한다. */
  readonly apiRegistered: boolean | null;
  /** 수동 ≠ API. 진 쪽을 지우지 않고 배지로 드러낸다. */
  readonly hasConflict: boolean;
  readonly origin: PlanOrigin;
  /**
   * ★ **12개 카운터에 들어가는가.** 일간·월간은 `false` 다 (§1 — 일간 결정석은 12에
   *   포함되지 않는다). 뷰가 행 단위로 내주므로 화면이 cycle 을 다시 판정하지 않는다.
   */
  readonly countsTowardWeeklyLimit: boolean;
  /** 이번 주(KST 목 00:00 기준) 클리어 여부. ← `boss_clears` 조인 */
  readonly isCleared: boolean;
  readonly clearedAt: string | null;
  readonly note: string | null;
}

/**
 * 캐릭터 × 이번 주 진행 상황. ← 뷰 `v_character_weekly_boss_progress`
 *
 * ★ **12개 상한 판정 지점이다.** `weeklyOverLimit` / `weeklySlotsRemaining` 을 화면이
 *   반드시 읽어야 한다 — DB 는 13번째를 **막지 않으므로**(난제 16-3), 읽지 않으면
 *   사용자는 입장조차 못 하는 계획을 세워 두고도 모른다.
 */
export interface CharacterWeeklyProgress {
  readonly characterId: string;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly weekKey: WeekKey;
  readonly plannedTotal: number;
  readonly plannedWeekly: number;
  readonly plannedDaily: number;
  readonly plannedMonthly: number;
  readonly clearedTotal: number;
  readonly clearedWeekly: number;
  readonly remainingTotal: number;
  readonly remainingWeekly: number;
  /** 목록에 두고 꺼 둔 항목 수. "숨긴 항목 N개" 로 쓴다. */
  readonly inactiveTotal: number;
  readonly conflictCount: number;
  /** ← `public.weekly_crystal_sell_limit()`. **코드에 12를 박지 않는다.** */
  readonly weeklyLimit: number;
  readonly weeklyOverLimit: boolean;
  readonly weeklySlotsRemaining: number;
}

/** 스케줄러의 주간 숙제 1건. ← `character_scheduler_snapshots.payload.weekly_contents[]` */
export interface SchedulerChore {
  readonly contentName: string;
  readonly type: string | null;
  readonly registered: boolean;
  readonly nowCount: number | null;
  readonly maxCount: number | null;
}

/**
 * 마지막 동기화 결과 요약. ← `character_scheduler_snapshots` 최신 행
 *
 * ★ **`보스 10/12` 는 여기서 온다.** 넥슨이 직접 주는 값(`weekly_boss_clear_count` /
 *   `weekly_boss_clear_limit_count`)이고, 실측에서 주간 `complete_flag=true` 개수와
 *   정확히 일치했다(10). 우리가 세지 않는다 — 게임이 세 준 값을 그대로 보여 준다.
 */
export interface SchedulerSnapshot {
  /** 넥슨 응답의 `date`. 데이터 기준 시각이며 호출 시각이 아니다. */
  readonly snapshotAt: string;
  readonly fetchedAt: string;
  readonly weeklyBossClearCount: number | null;
  readonly weeklyBossClearLimitCount: number | null;
  /** 주간 숙제. 스케줄러가 주는 `weekly_contents[]` 중 등록된 것만 추린다. */
  readonly weeklyChores: readonly SchedulerChore[];
}

/**
 * 체크리스트에 쓰는 캐릭터 신원.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ `credentialId` — **이 캐릭터를 읽을 수 있는 키가 무엇인지**
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 키는 그 키를 발급한 계정의 캐릭터만 읽는다(§1.1). 한 사람이 넥슨 계정을 여러 개
 * 쓰므로(§2.1) 브라우저는 **캐릭터마다 다른 키**를 골라 보내야 하는데, 원문 키는 DB 에
 * 없고 브라우저에만 있으므로(§2.1.1) 서버가 골라 줄 수가 없다.
 *
 * 그래서 서버는 **어느 자격증명에 속하는지**만 실어 보내고, 브라우저가 자기 localStorage
 * 맵에서 그 키를 꺼내 헤더에 싣는다. 해석 경로는
 * `characters.nexon_account_ref → credential_nexon_accounts → user_credentials.id`
 * 이며, 이미 뷰 `v_character_sync_source` 가 그 조인을 갖고 있다 — **스키마 변경 없음.**
 *
 * `null` 은 두 경우다. (a) 이 캐릭터가 어느 넥슨 계정에서 왔는지 기록이 없다(옛 행),
 * (b) 그 계정에 유효한 키가 하나도 없다. 어느 쪽이든 **에러가 아니라 "동기화 불가"
 * 라는 상태**이며, 화면은 그렇게 그린다.
 */
export interface ChecklistCharacter {
  readonly characterId: string;
  readonly name: string;
  readonly worldName: string | null;
  readonly className: string | null;
  readonly level: number | null;
  readonly isMain: boolean;
  /** 이 캐릭터의 스케줄러를 읽을 수 있는 자격증명. 없으면 `null`. */
  readonly credentialId: string | null;
  /** 그 자격증명에 사용자가 붙인 이름. "어느 키를 입력하면 되는지" 안내에 쓴다. */
  readonly credentialLabel: string | null;
}

/**
 * 대시보드 첫 화면의 캐릭터 한 섹션 (§1.1.1).
 *
 * ★ **섹션은 캐릭터마다 하나다.** 12개 상한이 캐릭터당이라 합치면 의미가 사라진다.
 * ★ `remaining` 은 **할 일 목록**이지 전리품 목록이 아니다 — 잡은 것이 아니라
 *   **아직 안 잡은 것**을 나열한다.
 */
export interface CharacterChecklist {
  readonly character: ChecklistCharacter;
  /** 계획이 하나도 없으면 `null`(뷰에 행 자체가 없다). 동기화 전의 정상 상태다. */
  readonly progress: CharacterWeeklyProgress | null;
  /** 한 번도 동기화하지 않았으면 `null`. 에러가 아니라 "아직 안 불러왔다"이다. */
  readonly snapshot: SchedulerSnapshot | null;
  /** `is_active and not is_cleared` — 뷰가 거른 결과를 그대로 싣는다. */
  readonly remaining: readonly CharacterBossPlan[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 요청 / 응답 계약
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/boss-plans?characterId=…` */
export interface CharacterPlanResponse {
  readonly plans: readonly CharacterBossPlan[];
  readonly progress: CharacterWeeklyProgress | null;
  readonly snapshot: SchedulerSnapshot | null;
}

/** `GET /api/boss-plans/checklist` */
export interface ChecklistResponse {
  readonly characters: readonly CharacterChecklist[];
}

/** `PUT /api/boss-plans` — 사람이 켜고 끈다(`set_character_boss_plan`). */
export interface SetPlanInput {
  readonly characterId: string;
  readonly bossDifficultyId: BossDifficultyId;
  readonly active: boolean;
}

/** `DELETE /api/boss-plans?…` — 목록에서 아예 지운다. */
export interface RemovePlanInput {
  readonly characterId: string;
  readonly bossDifficultyId: BossDifficultyId;
}

/**
 * `POST /api/boss-plans/sync` 결과.
 *
 * **호출량은 캐릭터당 정확히 1콜**이다 (§2.1.1). 그 사실을 응답에 실어 화면이
 * "몇 콜 썼는지"를 사용자에게 그대로 보여 줄 수 있게 한다 — 개발 키는 하루 1,000콜이다.
 */
export interface SyncResult {
  readonly characterId: string;
  readonly characterName: string;
  /** 넥슨이 준 `boss_contents[]` 총 건수. */
  readonly bossEntryCount: number;
  /** 계획에 반영된 건수(`sync_character_boss_plan` 호출 성공). */
  readonly planUpdatedCount: number;
  /** `complete_flag=true` 라 클리어 원장에 반영된 건수. */
  readonly clearRecordedCount: number;
  /**
   * 우리 보스 마스터에 매핑되지 않은 건수.
   * **0 이 아니어도 동기화는 성공이다** — `nexon_unmapped_contents` 에 남고 다음에 사람이 본다.
   */
  readonly unmappedCount: number;
  readonly weeklyBossClearCount: number | null;
  readonly weeklyBossClearLimitCount: number | null;
  /** 실제로 나간 넥슨 호출 수. 캐시에 맞으면 0 이다. */
  readonly nexonCallsUsed: number;
}
