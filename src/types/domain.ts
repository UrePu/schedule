/**
 * 화면(UI)이 쓰는 도메인 타입.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 생성 DB 타입과의 관계 — **이미 붙어 있다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 마이그레이션 18개가 실제 DB(`hryikreaxngexhjjxfyl`)에 적용돼 있고
 * `src/types/database.ts` (= `Database["public"]["Tables" | "Views" | "Functions"]`)
 * 가 그 스키마에서 생성돼 있다. 이 파일은 **그것과 별개로 유지된다**:
 *
 *   1. 아래 각 타입 옆의 `// ← 출처:` 주석이 생성 타입의 어느 행/컬럼에서 오는지 가리킨다.
 *   2. 이 파일의 타입은 **화면 모양 그대로**이고, DB Row → 화면 타입 변환은
 *      `src/features/schedule/server/schedule-repo.ts` 한 곳에서만 일어난다.
 *   3. 그래서 컴포넌트는 DB 스키마가 바뀌어도 한 줄도 고치지 않는다.
 *
 * DB 행과 1:1 로 만들지 않은 이유:
 * - DB 는 `timestamptz` 를 ISO 문자열로 돌려주지만 화면은 `Date` 가 편하다.
 * - DB 는 snake_case, 화면은 camelCase.
 * - DB 는 `user_id` / `guest_id` 두 널러블 FK 로 사람을 표현하지만(난제 7),
 *   화면에는 "사람 하나 = id 하나"만 있으면 된다. → `PersonId` 로 합친다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 금액 표현 규칙 (CLAUDE.md §1.3 D4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 금액 단위는 **전부 메소**이며 타입 이름에 `Meso` 를 남긴다.
 * **가격 미확인은 `null` 이고 `0` 이 아니다.** `0` 은 "0메소를 벌었다"는 사실 주장이지만
 * 진실은 "모른다" 이다. 합계에서 제외하고 건수로 따로 보고한다.
 * (DB 는 `bigint` 이지만 결정석 최고가가 약 3.2e9 이라 JS `number` 의 안전 정수
 *  범위(9.0e15) 안에 넉넉히 들어온다. 주간 합계도 12개 × 3.2e9 = 3.8e10 수준이다.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// 식별자 · 스칼라
// ─────────────────────────────────────────────────────────────────────────────

/** 사람(정규 사용자 또는 게스트) 한 명. ← 출처: `app_users.id` 또는 `guest_profiles.id` */
export type PersonId = string;

/** ← 출처: `parties.id` */
export type PartyId = string;

/** ← 출처: `party_runs.id` */
export type RunId = string;

/** 보스 × 난이도 엔트리의 영구 slug. ← 출처: `boss_difficulties.id` (예: `lotus_hard`) */
export type BossDifficultyId = string;

/** 메소 금액. 항상 정수. */
export type Meso = number;

/** 메소 금액 또는 **미확인**(`null`). `0` 을 미확인 대신 쓰지 않는다 (§1.3 D4). */
export type MesoOrUnknown = Meso | null;

/** 주간 버킷 키. 예: `2026-W33`. ← 출처: `public.week_key(timestamptz)` */
export type WeekKey = string;

/** KST 달력 날짜 키. 예: `2026-08-20`. ← 출처: `public.kst_date(timestamptz)` */
export type KstDayKey = string;

/** ISO 요일 (1=월 … 7=일). ← 출처: `availability_patterns.weekday`, `extract(isodow)` */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 조회 구간. DB 함수의 `p_from` / `p_to` 에 그대로 대응한다. */
export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// 파티 · 참가자
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 사람 한 명 — **파티와 무관한 정체성**.
 * ← 출처: `app_users`(정규 사용자) 또는 `guest_profiles`(초대 링크 게스트)
 *
 * 파티를 여러 개 두려면 "사람"과 "그 파티에서의 자리"를 분리해야 한다.
 * 같은 사람이 여러 파티에 속하고, 파티마다 **번호가 다르다.**
 */
export interface Person {
  readonly personId: PersonId;
  readonly displayName: string;
  /** ← `guest_id is not null` — 초대 링크로 들어온 임시 참가자 */
  readonly isGuest: boolean;
  /** 화면 설명용 한 줄 요약("직장인 · 평일 밤"). DB 에는 없다. */
  readonly blurb?: string;
}

/**
 * 특정 파티에서의 구성원 한 명. ← 출처: `party_participants`
 *
 * ⚠️ **`seatNo` 는 파티 단위다.** 같은 사람이 A파티에서 3번, B파티에서 2번일 수 있다.
 * 그래서 이 타입은 항상 "어느 파티의 로스터인지"와 함께 다뤄야 하고,
 * 화면도 번호가 어느 파티 것인지 알 수 있게 표시해야 한다.
 *
 * ⚠️ 번호는 **관리 번호**이지 순번이나 대기열이 아니다 (§1.4 / DB-SCHEMA §8-7).
 * 절대 재배열하지 않으므로 **연속이 아닐 수 있다** — 3번이 나가면 4번은 계속 4번이고
 * 3번 자리는 빈 채로 둔다. 신규는 언제나 `max + 1`.
 * 따라서 화면은 배열 인덱스가 아니라 이 값을 그대로 쓴다.
 *
 * ★ `seatNo` 의 실제 출처는 **`party_participants.member_no`** 다(마이그레이션 14).
 *   런 단위였던 `run_signups.seat_no` 는 그 마이그레이션에서 **제거**됐다 — "3번"이
 *   런마다 다른 사람을 가리키면 카톡 `!분배 3번 33` 이 성립하지 않기 때문이다.
 *   빠져나간 사람이 다시 들어오면 **예전 번호를 되찾는다**(`left_at` 을 되돌린다).
 */
export interface PartyMember extends Person {
  /** ← `party_participants.id`. 참여 의사(`run_signups`)를 쓸 때 필요하다. */
  readonly participantId: string;
  /** ← 파티 안에서의 관리 번호. 재배열 금지, 빈 번호 재사용 금지. */
  readonly seatNo: number;
}

/** ← 출처: `parties` */
export interface Party {
  readonly partyId: PartyId;
  /**
   * ← `parties.name` (DB 는 not null, 1~60자).
   * 사용자가 비워 두면 구성원 이름으로 요약해 채운다(`우레푸 외 3명`) —
   * 빈 문자열을 저장하지 않고 만들 때 결정한다.
   */
  readonly name: string;
  readonly visibility: "private" | "link" | "public";
  readonly defaultCapacity: number;
  /** 목록에서 파티를 구분하는 데 쓰는 보조 정보. ← `count(party_participants)` */
  readonly memberCount: number;
}

/** 새 파티 만들기. ← 대응: `insert into parties` + `party_participants` 벌크 삽입 */
export interface CreatePartyInput {
  /** 비어 있으면 구성원 이름으로 자동 요약한다. */
  readonly name: string;
  readonly memberPersonIds: readonly PersonId[];
}

/**
 * 로스터 편집. ← 대응: `party_participants` 삽입 + `left_at` 세팅(소프트 삭제)
 *
 * ⚠️ 빠진 사람의 번호는 **비운 채로 두고 재사용하지 않는다.** 새로 들어온 사람은
 * 그 파티의 `max(member_no) + 1` 을 받는다 (§1.4).
 */
export interface UpdatePartyRosterInput {
  readonly partyId: PartyId;
  readonly memberPersonIds: readonly PersonId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 가능 시간 (핵심 화면 왼쪽 패널)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 해석된 가용 구간 한 개 = **패턴 − 예외**.
 * ← 출처: `public.resolve_availability(p_person_ids, p_from, p_to)` 의 한 행
 *
 * ⚠️ **자정 넘김은 한 행이 그대로 자정을 넘는다.** 22:00~02:00 은 두 구간이 아니라
 * `startsAt = 22:00`, `endsAt = 다음날 02:00` 인 **하나의 구간**이다
 * (DB 는 `end_minute = 1560` 으로 저장한다 — DB-SCHEMA §10-2).
 * 화면도 이 구간을 쪼개지 않고 통째로 그려야 사용자의 의도가 보존된다.
 *
 * ⚠️ 다만 **예외가 겹치면 그 부분만 잘려 나가므로** 패턴 한 행이 구간 0~2개로
 * 쪼개질 수 있다. 예) 수 22:00~02:00 패턴 + 목요일 제외 → 수 22:00~24:00 만 남는다.
 *
 * DB 함수의 `source` 컬럼은 예외가 구간을 **만들 수** 있던 시절의 잔재다.
 * 예외가 뺄셈 전용이 된 지금은 모든 구간이 패턴에서 오므로 화면 타입에서 뺐다 (§1.4).
 */
export interface AvailabilityInterval {
  readonly personId: PersonId;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /**
   * 표시용 메모. **실제로는 언제나 `null` 이다.**
   * `resolve_availability()` 의 반환 컬럼은 `(person_id, starts_at, ends_at)` 셋뿐이라
   * 패턴 메모가 실려 오지 않는다. 애초에 실릴 수도 없다 — 한 구간은 여러 패턴 행의
   * 합집합에서 예외를 뺀 조각이라 "어느 행의 메모인가"가 정의되지 않는다.
   */
  readonly note: string | null;
}

/**
 * 특정 날짜를 **깎아 내는** 예외. ← 출처: `availability_exceptions`
 *
 * ★ **뺄셈 전용이다** (§1.4). "이 날짜(또는 그 날짜의 이 구간)는 안 됨"만 표현한다.
 *   패턴에 없는 시간을 **추가하는 수단이 아니다** — 그럴 일이 생기면 패턴을 넓히는 것이 답이다.
 *   (그래서 예전 `kind = 'custom_hours'` 는 없어졌다. 남은 의미는 하나뿐이라
 *    구분자 대신 **범위의 널 여부**로 전체/부분을 나타낸다.)
 *
 * ★ **사유는 선택 사항이다.** 이유 없이 "이때 안 돼요"만 남겨도 되며,
 *   화면은 메모 입력을 강요하지 않는다.
 *
 * ★ **적용은 벽시계 시각 기준이다** (§1.4). "목요일 제외" = KST 목요일에 속하는
 *   **어떤 순간도** 가능하지 않음. 수요일 패턴에서 넘어온 목 00:00~02:00 도 잘린다.
 *   패턴 행 단위로 지우면 못 온다고 말한 사람이 새벽 1시에 예약 가능한 채로 남는다 —
 *   스케줄링에서 거짓 "가능"은 거짓 "불가"보다 항상 비싸다.
 */
export interface AvailabilityException {
  readonly id: string;
  readonly personId: PersonId;
  readonly dayKey: KstDayKey;
  /**
   * 제외 구간(KST 벽시계 분, 0~1440). **둘 다 `null` 이면 그날 전체 제외.**
   * 하루 안으로 닫혀 있다 — 자정을 넘겨 빼고 싶으면 다음 날에도 예외를 하나 더 둔다.
   * 그래야 "목요일 제외"의 의미가 날짜와 정확히 일치한다.
   */
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  /** 사유. **선택 사항** — `null` 이 정상이다. */
  readonly note: string | null;
}

/**
 * k명 이상이 동시에 가능한 시간창.
 * ← 출처: `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count)` 의 한 행
 *
 * - `availableCount` 는 병합된 창 **전체에서 보장되는 최소 인원**이다.
 * - `personIds` 는 창 전체를 커버하는 사람들(정확한 교집합)이며,
 *   따라서 `personIds.length === availableCount` 가 성립한다.
 */
export interface OverlapWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly availableCount: number;
  readonly personIds: readonly PersonId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 마스터
// ─────────────────────────────────────────────────────────────────────────────

/** ← 출처: enum `boss_difficulty_tier` */
export type BossDifficultyTier = "easy" | "normal" | "hard" | "chaos" | "extreme";

/** ← 출처: enum `boss_cycle`. **불변이 아니다** — 2026-06-18 패치로 실제로 바뀌었다. */
export type BossCycle = "daily" | "weekly" | "monthly";

/**
 * 보스 엔트리 하나(= 보스 × 난이도). ← 출처: 뷰 `v_boss_catalog`
 * (`bosses` + `boss_difficulties` + 현재 유효한 `boss_crystal_prices`)
 */
export interface BossCatalogEntry {
  readonly bossDifficultyId: BossDifficultyId;
  readonly bossId: string;
  /** ← `boss_difficulties.korean_name`. UI·봇 응답에 그대로 쓴다. 예: `하드 스우` */
  readonly koreanName: string;
  /** ← `bosses.korean_name`. 예: `스우` */
  readonly bossKoreanName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  /**
   * ← `boss_difficulties.max_party`. **소프트 상한이다** (§1.3 D5).
   * DB 는 초과를 막지 않는다. 앱은 **경고만** 하고 등록을 차단하지 않는다.
   */
  readonly maxParty: number;
  /**
   * ← `boss_crystal_prices.price_meso` (그 시점 유효가). **솔로 기준 가격**이다.
   * 실지급은 `floor(price / partySize)` (DB-SCHEMA 난제 5 R1).
   * `null` = 미확인(§1.3 D4 — 벨로나 3난이도가 실제로 null 이다). **0 이 아니다.**
   */
  readonly crystalPriceMeso: MesoOrUnknown;
  /** ← `boss_difficulties.released`. 미출시/폐지는 행 삭제 대신 false. */
  readonly released: boolean;
  /** ← `boss_aliases.alias` 목록. 봇/검색이 쓰는 별칭("하스우", "카룡"). */
  readonly aliases: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 보스 런(일정)
// ─────────────────────────────────────────────────────────────────────────────

/** ← 출처: enum `run_status` */
export type RunStatus = "proposed" | "confirmed" | "done" | "cancelled";

/** ← 출처: enum `signup_status` */
export type SignupStatus = "going" | "maybe" | "declined";

/**
 * 런 한 건의 참가 의사 1행. ← 출처: `run_signups` (+ `party_participants` + `characters`)
 *
 * ★ **캐릭터가 핵심이다.** 주간 결정석 12개 상한은 **캐릭터당**으로 세어지므로(§1),
 *   "누가 가는가"만으로는 수익 계산이 성립하지 않는다. `run_signups.character_id` 가
 *   그 자리이며 이 타입이 화면까지 그대로 나른다.
 *
 * ⚠️ `characterId === null` 은 **정상 상태**다 — 다른 사람이 대신 넣어 준 참가 의사에는
 *   그 사람이 어느 캐릭터로 갈지 알 방법이 없다. 본인이 신청할 때 채워진다.
 *   에러로 그리지 말고 "캐릭터 미지정"으로 표시한다.
 */
export interface RunParticipant {
  /** ← `run_signups.id` */
  readonly signupId: string;
  /** ← `party_participants.id` */
  readonly participantId: string;
  /** ← `party_participants.user_id ?? guest_id` */
  readonly personId: PersonId;
  readonly displayName: string;
  /** ← `party_participants.member_no` (§1.4 — 재배열 금지). */
  readonly seatNo: number;
  readonly status: SignupStatus;
  /** ← `run_signups.character_id`. `null` = 아직 어느 캐릭터로 갈지 정하지 않음. */
  readonly characterId: string | null;
  /** ← `characters.character_name`. `characterId` 가 있으면 반드시 함께 온다. */
  readonly characterName: string | null;
  readonly worldName: string | null;
}

/**
 * 일정에 데려갈 수 있는 내 캐릭터 하나. ← 출처: `characters where is_tracked`
 *
 * ★ 후보는 **추적 캐릭터뿐**이다 (§2.1.1). 추적하지 않는 캐릭터는 인게임 스케줄러와
 *   동기화되지 않아 클리어·결정석 집계가 성립하지 않는다.
 */
export interface RunCharacterOption {
  readonly characterId: string;
  readonly name: string;
  readonly worldName: string | null;
  readonly className: string | null;
  readonly level: number | null;
  /** 본캐는 목록 맨 앞에 오고 기본 선택이 된다(§2.1 — 표시 정체성). */
  readonly isMain: boolean;
}

/**
 * 등록된 보스 일정 한 건. ← 출처: `party_runs` (+ `boss_difficulties` 조인)
 *
 * ⚠️ `runNo` 는 화면·카톡에서 "2번 일정"이라고 부르기 위한 **관리 번호**다.
 * `member_no` 와 같은 규칙 — **재배열·재사용 금지, 신규는 max+1** (§1.4).
 *
 * ★ 출처는 **`party_runs.run_no`** 컬럼이다(마이그레이션 14에서 추가). 스코프는
 *   (파티) 하나뿐이고 주차를 넣지 않았다 — 일정을 다음 주로 미뤘다고 번호가 바뀌면 안 된다.
 *   INSERT 시 트리거 `party_runs_assign_run_no` 가 `max + 1` 을 채운다.
 */
export interface ScheduledRun {
  readonly runId: RunId;
  readonly partyId: PartyId;
  readonly runNo: number;
  readonly bossDifficultyId: BossDifficultyId;
  readonly bossKoreanName: string;
  readonly difficulty: BossDifficultyTier;
  /** ← `party_runs.scheduled_at`. `null` = **시각 미정**(겹쳐보기로 조율 중). */
  readonly scheduledAt: Date | null;
  readonly durationMinutes: number;
  readonly status: RunStatus;
  /**
   * ← `party_runs.entry_party_size`. **"실제로 몇 명이 입장했는가"** 이며
   * 기본값은 등록 참가자 수, 사용자가 고칠 수 있다 (§1.3 D3).
   * 이 값으로 `floor(가격 / entryPartySize)` 를 계산한다.
   */
  readonly entryPartySize: number;
  /** ← `party_runs.week_key` (생성 컬럼) */
  readonly weekKey: WeekKey;
  /** ← 등록 시점 보스 마스터 가격(솔로가). `null` = 미확인. */
  readonly crystalPriceMeso: MesoOrUnknown;
  /**
   * **이 열람자**가 이 런에서 가져갈 예상 분배 몫.
   * ← DB `distribute_meso(pot, keys, weights)` + 뷰 `v_run_share_weights`
   *
   * ★ **앱은 이 값을 계산하지 않는다.** 균등이든 33:67 이든 분배 규칙의 구현은
   *   `distribute_meso()` **하나뿐**이어야 한다 — 웹과 카톡 봇, 주간 집계 뷰가 같은 답을
   *   내야 하기 때문이다. TS 에 1/n 을 다시 적으면 `share_mode = 'manual'` 인 런에서
   *   화면이 실제 약정과 다른 금액을 말한다(실제로 그랬다).
   * ★ `null` = **가격 미확인**(§1.3 D4). `0` 이 아니므로 합계에 더하지 말고 따로 센다.
   * ⚠️ **열람자마다 값이 다르다.** 사람을 가로질러 더하면 안 된다. 열람자가 그 런의
   *   `going` 참가자가 아니면(비로그인 포함) 게임 기본값인 균등 몫이 들어온다 —
   *   DB `resolve_crystal_payout()` 이 미등록자에게 돌려주는 값과 같은 정책이다.
   */
  readonly viewerShareMeso: MesoOrUnknown;
  /** ← `party_runs.note`. 공개 파티에서는 비로그인에게도 보인다. */
  readonly note: string | null;
  /**
   * 이 런의 참가 의사 목록 (**캐릭터까지**). ← `run_signups`
   *
   * 사람 이름만으로는 "어느 캐릭터가 가는가"를 알 수 없고, 12개 상한이 캐릭터당이라
   * 그 정보가 없으면 수익 계산이 성립하지 않는다 (§1).
   */
  readonly participants: readonly RunParticipant[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 캐릭터 (넥슨 API + `characters` 테이블)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 넥슨이 발급하는 캐릭터 식별자.
 * ⚠️ **PK 로 쓰지 않는다** — 넥슨 스펙이 "게임 콘텐츠 변경으로 변경될 수 있다"고 명시했다
 * (§1.1 / DB-SCHEMA 난제 4). 우리 PK 는 별도 UUID 이고 `ocid` 는 갱신되는 컬럼이다.
 */
export type Ocid = string;

/**
 * 소유 캐릭터 한 명.
 * ← 출처: `GET /maplestory/v1/character/list` 의 `character_list[]`
 *   (+ 저장 후에는 `public.characters`)
 *
 * ⚠️ 이 응답에는 **이미지가 없다.** 초상화는 `/character/basic` 에서 오고
 *   **캐릭터당 1콜**이라 별도 타입으로 분리했다 (§2.1.1).
 */
export interface GameCharacter {
  /** 우리 UUID PK. 아직 저장 전이면 목록 응답 기준의 임시 키다. */
  readonly characterId: string;
  /** ← `character_list[].ocid`. 목록 응답에는 항상 들어 있다. */
  readonly ocid: Ocid;
  /** ← `character_list[].character_name` */
  readonly name: string;
  /** ← `character_list[].world_name`. 표시 전용이며 필터 수단이 아니다. */
  readonly worldName: string;
  /** ← `character_list[].character_class`. 예: `비숍` */
  readonly className: string;
  /** ← `character_list[].character_level` */
  readonly level: number;
}

/**
 * 캐릭터 초상화.
 * ← 출처: `GET /maplestory/v1/character/basic` 의 `character_image` (**캐릭터당 1콜**)
 *
 * ★ `imageUrl === null` 은 **정상 상태**다 (§2.1.1). 에러 UI 로 처리하지 않는다.
 *   화면은 회색 실루엣 플레이스홀더를 그린다.
 */
export interface CharacterPortrait {
  readonly ocid: Ocid;
  readonly imageUrl: string | null;
}

/**
 * 추적 대상 선택 결과.
 * ← 대응: `public.characters` upsert (+ `characters.is_main` 부분 유니크)
 *
 * ⚠️ 전체 동기화를 하지 않는 이유(§2.1.1): 스케줄러 동기화는 **캐릭터당 1콜**이고
 *   개발 키는 하루 1,000콜이다. 실측 계정의 59명을 전부 돌리면 한 번에 하루 예산의
 *   6%가 사라진다. 그래서 **고른 캐릭터만** 추적한다.
 *
 * ⚠️ `mainCharacterId` 는 계정 전체에서 **하나**다 — 표시 정체성이 본캐 닉네임이기
 *   때문이다(§2.1). 본캐는 반드시 추적 대상에 포함된다.
 */
export interface TrackedCharacterSelection {
  readonly characterIds: readonly string[];
  readonly mainCharacterId: string | null;
}

/** 일정 등록 입력. ← 대응: `insert into party_runs (...)` (Route Handler + service role) */
export interface CreateRunInput {
  readonly partyId: PartyId;
  readonly bossDifficultyId: BossDifficultyId;
  readonly scheduledAt: Date;
  readonly durationMinutes: number;
  readonly entryPartySize: number;
  /** 이 시간대에 참여 의사가 있는 파티원. ← `run_signups` 로 펼쳐진다. */
  readonly participantPersonIds: readonly PersonId[];
  /**
   * **등록자가 데려갈 캐릭터.** ← `run_signups.character_id` (등록자 본인 행에만 들어간다)
   *
   * ★ **필수다.** 결정석 12개 상한이 캐릭터당이라(§1) 캐릭터 없는 일정은 수익 계산에
   *   들어갈 수 없다. 서버가 소유·추적 여부를 확인하고 아니면 400 으로 거른다.
   *   다른 참가자의 캐릭터는 **알 수 없으므로** null 로 들어가고, 각자 신청할 때 채운다.
   */
  readonly characterId: string;
  readonly note: string | null;
}

/**
 * 참가 신청(또는 캐릭터 변경). ← 대응: `run_signups` upsert (Route Handler + service role)
 *
 * ★ **본인 행만 건드린다.** 남의 참가 의사를 대신 고치지 않는다 — 어느 캐릭터로
 *   갈지는 본인만 아는 정보다.
 */
export interface SaveRunSignupInput {
  readonly runId: RunId;
  readonly characterId: string;
  readonly status: SignupStatus;
}
