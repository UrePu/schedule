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
 * ⚠️ **12개 상한 판정을 TS 에서 다시 계산하지 않는다.** 주간 카운트와 상한 판정은 전부
 *    `v_character_weekly_boss_progress` 가 낸다. 웹과 카톡 봇이 같은 답을 내야 하므로
 *    구현은 DB 에 하나만 있어야 한다.
 *    유일한 예외가 `*_total` 5개다 — 일간 보스가 범위 밖(2026-08-18 발주자 지시)이 되면서
 *    뷰의 합계를 쓸 수 없게 됐고, 뺄셈으로 되돌릴 수도 없다. 사유와 방식은
 *    `server/boss-plan-repo.ts` 머리말에 적혀 있다.
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
  /**
   * ★ **이 캐릭터가 이 보스를 몇 인으로 도는가.** ← `character_boss_plans.default_party_size`
   *
   * **언제나 값이 있다.** 컬럼이 `NOT NULL DEFAULT 1` 이므로 "미설정" 상태는 없다
   * (마이그레이션 `20260819100000_default_party_size_one.sql`, 발주자 지시 2026-08-19:
   * *"그냥 1인을 기본으로 잡아 굳이 1이라고 설정안하게"*). 아무것도 정하지 않은 보스는
   * **1인으로 확정**이며, 화면은 그 사실에 경고를 달지 않는다.
   *
   * ⚠️ 그 대가: 실제로는 파티로 도는 보스를 1 그대로 두면 아무 경고 없이 결정석 수익이
   *    최대 6배 과대 계상된다(§1.3 D3). 발주자가 알고 내린 결정이다.
   *
   * 이 값은 **앞으로 생길 클리어의 기본값**이다. 이미 있는 클리어·런은 이 값을 바꿔도
   * 한 행도 움직이지 않는다 — 사실(`boss_clears.party_size` ·
   * `party_runs.entry_party_size`)이 언제나 기본값을 이긴다.
   */
  readonly defaultPartySize: number;
  readonly released: boolean;
  /** 트리거 계산값 `coalesce(manual_active, api_registered)`. 목록의 켜짐/꺼짐. */
  readonly isActive: boolean;
  /**
   * 사람이 직접 내린 판단. `null` = 미판단. **동기화가 절대 덮어쓰지 않는다.**
   *
   * ★ `false` 는 "안 간다"는 **묘비**다. 트리거의
   *   `coalesce(manual_active, api_registered, false)` 가 이 값을 집으므로 다음 동기화가
   *   넥슨의 `registration_flag = true` 를 봐도 되살아나지 않는다. 행을 지우면 이 묘비가
   *   함께 사라져 되살아난다 — 2026-08-18 에 실제로 그렇게 되던 결함을 고친 지점이다.
   */
  readonly manualActive: boolean | null;
  /** 넥슨 `registration_flag`. 수동 값을 이기지 못한다. */
  readonly apiRegistered: boolean | null;
  /**
   * 수동 ≠ API. ← DB `has_conflict`.
   *
   * ⚠️ **이 값만 보고 경고를 그리지 말 것.** 트리거가 최신성을 비교하지 않아서
   *    (마이그레이션 19-2 주석: *"최신성 비교 없음"*) 사용자가 앱에서 방금 켠 순간
   *    즉시 켜진다 — 넥슨은 아직 옛 상태를 말하고 있으니까. 아래 두 시각과 함께
   *    `lib/plan-conflict.ts` 의 `resolvePlanConflictState()` 에 넣어야 "게임 반영 대기"와
   *    "진짜 어긋남"이 갈린다.
   */
  readonly hasConflict: boolean;
  /**
   * 사람이 이 계획을 켜고 끈 시각. ← `character_boss_plans.manual_set_at`
   *
   * ★ 뷰 `v_character_boss_plan_status` 에는 **이 컬럼이 없다.** repo 가 원본 테이블에서
   *   따로 읽어 채운다(`server/boss-plan-repo.ts`). 뷰를 고치려면 마이그레이션이
   *   필요한데 미적용분이 밀려 있어 그 길을 막아 두었다.
   */
  readonly manualSetAt: string | null;
  /** 그 값을 관측한 넥슨 응답의 기준 시각. ← `character_boss_plans.api_observed_at` */
  readonly apiObservedAt: string | null;
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
 *   반드시 읽어야 한다. **DB 는 여전히 13번째를 막지 않는다**(난제 16-3 — 동기화가 넣는
 *   `api_registered` 까지 거부할 수는 없다). 사람이 누르는 경로만 서버 repo 가 막으므로
 *   (`assertWeeklyPlanSlotAvailable`), 이미 넘어 있는 계획은 그대로 남아 있고 이 값을
 *   읽지 않으면 사용자는 입장조차 못 하는 계획을 세워 두고도 모른다.
 *
 * ★ **일간은 이 타입에 없다.** 2026-08-18 발주자 지시로 일간 보스가 범위 밖이 되면서
 *   `plannedDaily` 를 지웠다(`@/lib/domain/boss-scope`). `*_total` 은 주간+월간 합이며,
 *   12개 상한 관련 값은 예나 지금이나 뷰가 낸 값 그대로다.
 */
export interface CharacterWeeklyProgress {
  readonly characterId: string;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly weekKey: WeekKey;
  /** 켜져 있는 계획 수(주간+월간). */
  readonly plannedTotal: number;
  readonly plannedWeekly: number;
  readonly plannedMonthly: number;
  readonly clearedTotal: number;
  readonly clearedWeekly: number;
  readonly remainingTotal: number;
  readonly remainingWeekly: number;
  /** 목록에 두고 꺼 둔 항목 수. "숨긴 항목 N개" 로 쓴다. */
  readonly inactiveTotal: number;
  /**
   * 넥슨 관측이 우리 수동 설정보다 **나중인데도** 값이 다른 항목 수 — 진짜 어긋남.
   * 판정은 `lib/plan-conflict.ts` 하나에만 있다.
   */
  readonly conflictDivergedCount: number;
  /**
   * 우리 설정이 더 최신이라 **아직 게임에 반영되지 않은** 항목 수.
   * 경고가 아니다 — 넥슨 데이터는 ~15분 늦다(§1.1).
   */
  readonly conflictPendingCount: number;
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
 * 쓰므로(§2.1) 캐릭터마다 **다른 키**를 골라야 한다. 해석 경로는
 * `characters.nexon_account_ref → credential_nexon_accounts → user_credentials.id`
 * 이며, 이미 뷰 `v_character_sync_source` 가 그 조인을 갖고 있다 — **스키마 변경 없음.**
 *
 * `null` 은 두 경우다. (a) 이 캐릭터가 어느 넥슨 계정에서 왔는지 기록이 없다(옛 행),
 * (b) 그 계정에 유효한 키가 하나도 없다. 어느 쪽이든 **에러가 아니라 "동기화 불가"
 * 라는 상태**이며, 화면은 그렇게 그린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ `serverKeyAvailable` — **브라우저에 키가 없어도 되는가** (§2.1.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문 키를 이제 서버가 AEAD 로 암호화해 보관하므로, 이 값이 `true` 면 브라우저는 키를
 * 하나도 갖고 있지 않아도 된다 — `characterId` 만 보내면 서버가 그 계정 키를 꺼내 부른다.
 * 새 기기에서 전 계정이 동기화되는 근거가 정확히 이 값이다.
 *
 * `false` 는 **오류가 아니라 "아직 그 키를 서버에 올리지 않았다"** 이다. 이때는 브라우저에
 * 원문이 있으면 그것으로 부르고(그리고 성공하면 서버가 보관한다), 둘 다 없을 때만
 * "그 계정 키를 입력해 주세요"가 된다. 출처는 `v_character_sync_source.allow_server_side_use`.
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
  /** 서버가 그 자격증명의 키를 대신 부를 수 있는가. `true` 면 브라우저 키가 필요 없다. */
  readonly serverKeyAvailable: boolean;
}

/**
 * 대시보드 첫 화면의 캐릭터 한 섹션 (§1.1.1).
 *
 * ★ **섹션은 캐릭터마다 하나다.** 12개 상한이 캐릭터당이라 합치면 의미가 사라진다.
 * ★ `planned` 는 이번 주 계획 **전체**다 — 클리어한 것까지 들어 있다. 대시보드가
 *   12칸 그리드가 되면서(발주자 지시, 2026-08-18) **12칸을 채우려면 잡은 것도 필요**해졌고,
 *   "아직 안 잡은 것"은 `isCleared` 로 거르면 나오므로 배열을 두 벌 나르지 않는다.
 */
export interface CharacterChecklist {
  readonly character: ChecklistCharacter;
  /** 계획이 하나도 없으면 `null`(뷰에 행 자체가 없다). 동기화 전의 정상 상태다. */
  readonly progress: CharacterWeeklyProgress | null;
  /** 한 번도 동기화하지 않았으면 `null`. 에러가 아니라 "아직 안 불러왔다"이다. */
  readonly snapshot: SchedulerSnapshot | null;
  /**
   * `is_active` 인 계획 전부(주간 + 월간). **클리어 여부로 거르지 않는다** —
   * 12칸 그리드는 이번 주 계획 전체를 보여 주고 잡은 것은 취소선으로 죽인다.
   * 일간 보스는 서버 쿼리에서 이미 빠져 있어 여기에 등장하지 않는다.
   */
  readonly planned: readonly CharacterBossPlan[];
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

/**
 * `DELETE /api/boss-plans?…` — **내 판단을 지우고 인게임 목록에 맡긴다.**
 *
 * ⚠️ "목록에서 뺀다"가 아니다. 그건 `SetPlanInput { active: false }` 이고, 그쪽만이
 *    동기화가 되살릴 수 없는 묘비(`manual_active = false`)를 남긴다. 이쪽은 판단을 지우므로
 *    넥슨이 등록 중인 보스는 **다시 나타난다** — 의도된 동작이다.
 */
export interface ResetPlanInput {
  readonly characterId: string;
  readonly bossDifficultyId: BossDifficultyId;
}

/**
 * `PUT /api/boss-plans/party-size` — 이 보스를 몇 인으로 도는지 정한다.
 *
 * ★ `partySize: null` 은 **기본값 1로 되돌리기**다(입력칸을 비웠을 때). 0 을 보내는 것이
 *   아니며, "미설정으로 해제"도 아니다 — 미설정이라는 상태는 2026-08-19 에 사라졌다.
 *   DB 함수가 `coalesce(p_party_size, 1)` 로 접는다.
 * ★ 상한은 `boss_difficulties.max_party` 지만 **막지 않는다**(§1.3 D5) — 서버·DB 모두
 *   1~24 만 검사하고, 초과는 화면이 주황 경고로 알린다.
 */
export interface SetPlanPartySizeInput {
  readonly characterId: string;
  readonly bossDifficultyId: BossDifficultyId;
  readonly partySize: number | null;
}

/*
 * ★ 2026-08-19 삭제 — `ApplyPlanPartySizeInput` / `ApplyPlanPartySizeResult`.
 *   이미 쌓인 클리어에 계획 인원수를 일괄 소급하던 경로의 타입이었다. 대상 조건이
 *   `boss_clears.party_size_confirmed = false` 인데 기본 인원 1인 확정(마이그레이션 25)
 *   이후 미확인 행이 하나도 없어 **언제나 0건**이라 UI·API·타입을 함께 걷어냈다.
 *   인원수 **설정**(`SetPlanPartySizeInput`, `PUT /api/boss-plans/party-size`)은 그대로다.
 */

/**
 * `POST /api/boss-plans/sync` 결과.
 *
 * **호출량은 캐릭터당 정확히 1콜**이다 (§2.1.1). 그 사실을 응답에 실어 화면이
 * "몇 콜 썼는지"를 사용자에게 그대로 보여 줄 수 있게 한다 — 개발 키는 하루 1,000콜이다.
 */
export interface SyncResult {
  readonly characterId: string;
  readonly characterName: string;
  /**
   * 넥슨이 준 `boss_contents[]` 중 **우리가 다루는 것**의 건수(주간+월간).
   * 일간은 저장 전에 버리므로(`@/lib/domain/boss-scope`) 여기 들어가지 않는다.
   */
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
