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
  /**
   * **이 파티에 데려가는 캐릭터.** ← `party_participants.character_id`
   *
   * `null` 은 정상 상태다 — 아직 고르지 않았거나, 게스트라 캐릭터 개념이 없다.
   * 런 단위로 다른 캐릭터를 데려가는 것은 `run_signups.character_id` 가 따로 표현한다.
   */
  readonly characterId: string | null;
  /** ← `characters.character_name`. 표시 조합은 `lib/domain/participant-label.ts` 가 소유한다. */
  readonly characterName: string | null;
  /** ← `characters.is_main`. 본캐면 `더저`, 아니면 `더저(메검메)` 로 표시된다. */
  readonly isMainCharacter: boolean;
}

/**
 * 파티 목록에 얹히는 **구성원 한 명의 최소 정보**.
 *
 * `PartyMember` 와 다르다 — 저쪽은 로스터를 편집하려고 `participantId` · `seatNo` 까지
 * 들고 있는 무거운 타입이고, 이쪽은 **"이 파티가 어느 파티인지 알아보게 하는"** 데만 쓰는
 * 두 글자다. 파티 목록은 한 번에 열 개가 넘게 오므로 그 차이가 payload 에 그대로 남는다.
 */
export interface PartyMemberBrief {
  /** ← `party_participants.display_name` (정식 사용자는 본캐 닉네임). */
  readonly displayName: string;
  /**
   * **이 파티에 데려가는 캐릭터.** ← `party_participants.character_id → characters`
   *
   * `null` 이면 아직 고르지 않은 것이고, 그때 **화면은 `displayName` 을 캐릭터로 읽는다** —
   * 정식 사용자의 표시명은 본캐 닉네임이기 때문이다(§2.1: 계정은 본캐 닉네임으로 식별).
   * 즉 "캐릭터가 없는 사람"은 없다. 있다면 **어느 캐릭터로 가는지 아직 안 정한 것**이다.
   *
   * ⚠️ 그래서 여기에 `캐릭터 미정` 같은 꼬리표를 붙이지 않는다(2026-09-02 발주자:
   *    *"캐릭터 미정 말고 실제 캐릭터 말하는거임"*). 이름 자리에 이미 실제 캐릭터가 있다.
   */
  readonly characterName: string | null;
  /**
   * 레벨 · 직업 — **추적 캐릭터 목록에서 보여 주는 그 값**이다(발주자: *"추적캐릭터에서
   * 보여주는 그 캐릭터가 보이게"*). 캐릭터를 고른 구성원만 갖는다.
   *
   */
  readonly characterLevel: number | null;
  readonly characterClass: string | null;
  /**
   * 초상화. ← `characters.image_url`
   *
   * ★ **여기서 넥슨을 부르지 않는다.** 초상화는 `/character/basic` 을 캐릭터당 한 번
   *   불러야 나오고(§2.1.1), 파티 목록을 열 때마다 구성원 수만큼 부르는 것은 하루
   *   1,000콜 예산에서 감당할 수 없다. 대신 **캐릭터 선택 모달이 이미 부른 그 응답**을
   *   `/api/nexon/character/basic` 이 DB 에 적어 두고(2026-09-02), 여기서는 적힌 것만 읽는다.
   * ⚠️ 그래서 `null` 이 **정상 상태**다 — 그 캐릭터를 아직 선택 모달에서 본 적이 없다는
   *    뜻이고, 화면은 실루엣을 그린다. 오류가 아니다(§2.1.1 초상화 규약).
   */
  readonly characterImageUrl: string | null;
  /** ← `party_participants.guest_id is not null`. */
  readonly isGuest: boolean;
}

/** ← 출처: `parties` */
export interface Party {
  readonly partyId: PartyId;
  /**
   * **이 파티를 만든 사람인가.** ← `parties.owner_user_id === 보는 사람`
   *
   * 해체(터트리기) 권한의 근거다(발주 요구 2026-08-20). 화면은 이 값으로 버튼을
   * 보일지 정하지만, **판정은 서버가 한다** — 버튼을 숨기는 것은 안내이지 방어가 아니다.
   */
  readonly isOwner: boolean;
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
  /**
   * 구성원 미리보기 — **파티를 구분하려고** 싣는다
   * (발주 지시 2026-09-01: *"파티 고를때 파티원도 다 보이게 해서 해줘 이름이 비슷해서
   * 하나도 모르겠음"*). 실측된 이름들이 `발벨3인` · `익세 4인` · `세쌀카2인523` ·
   * `세쌀카2인물결` 처럼 보스 줄임말 + 인원이라 **이름만으로는 서로 구분되지 않는다.**
   * 구분에 실제로 쓰이는 정보는 "누가 들어 있나"다.
   *
   * ★ **합친 문자열이 아니라 조각으로 싣는다**(2026-09-02: *"캐릭터 실제로 보여주고
   *   싶은데"*). 처음에는 `participantLabel` 이 만든 `더저(무르겨르)` 한 줄이었는데,
   *   그 규칙은 **본캐로 참여하면 괄호를 붙이지 않는다** — 그래서 절반의 사람은 캐릭터가
   *   화면에 아예 나오지 않았다. 화면마다 캐릭터를 어떻게 보일지(굵기·줄·색)가 다르므로
   *   **조합은 그리는 쪽에 맡기고 여기서는 재료만 준다.**
   * ★ `member_no` 순서다. 카톡에서 `1번` 이라 부르는 그 순서와 같아야 한다(§1.4).
   * ★ **남의 공개 파티는 빈 배열이다.** 공개 게시판 뷰(`v_public_party_board`)는 인원수만
   *   내주며, 이름을 보태려고 그 공개면을 넓히지 않는다 — 고르는 데 필요한 것은 내가 낀
   *   파티를 구분하는 일이고, 그건 이 값으로 이미 된다.
   */
  readonly members: readonly PartyMemberBrief[];
  /**
   * ← `parties.name_is_custom` (마이그레이션 22).
   *
   * `false` = 보스 줄임말 + 정원으로 만든 **자동 제목**이라, 보스 목록이나 정원이 바뀌면
   * 서버가 다시 만든다(`익세 하대 하카 2인`).
   * `true` = 사람이 직접 적은 제목이라 **자동 생성이 절대 덮지 않는다.**
   *
   * ★ 편집 화면은 이 값으로 이름 칸의 초기값을 정한다 — 자동 제목이면 칸을 비워 두고
   *   자동 제목을 placeholder 로 보여 준다. 자동 제목을 그대로 칸에 넣어 두면 사용자가
   *   손대지 않고 저장하는 순간 "사람이 정한 이름"으로 굳어 버린다.
   * ★ 남의 공개 파티는 편집 대상이 아니므로 언제나 `true` 로 온다(그 이름에 손대지 않는다).
   */
  readonly nameIsCustom: boolean;
}

/**
 * 파티에 등록된 보스 한 줄. ← 출처: `party_bosses` (+ `v_boss_catalog`)
 *
 * 발주 요구(원문): "파티 정보 자체에 보스가 등록된다. 같은 파티에 보스가 여러개
 * 있을수도있고 추가될수도있고 삭제될수도있다."
 *
 * ⚠️ `sortOrder` 는 **표시 순서이지 관리 번호가 아니다** (§1.4 와 다르다).
 *    `member_no` / `run_no` 는 대화에서 사람·일정을 가리키는 이름이라 재배열이 금지되지만,
 *    보스 순서는 "연달아 도는 차례"라 사용자가 바꿔도 된다. 대신 **제목이 따라 바뀐다.**
 */
export interface PartyBoss {
  readonly bossDifficultyId: BossDifficultyId;
  /** ← `boss_difficulties.korean_name`. 예: `하드 카링` */
  readonly koreanName: string;
  /** ← `bosses.korean_name`. 예: `카링` */
  readonly bossKoreanName: string;
  /**
   * ← `boss_difficulties.short_name`. 예: `하카`
   *
   * ★ 마이그레이션 22 미적용이면 서버가 `koreanName` 을 그대로 넣어 준다 —
   *   제목이 길어질 뿐 틀리지 않는다. 규칙으로 지어내지 않는다.
   */
  readonly shortName: string;
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  /** ← `boss_difficulties.max_party`. **소프트 상한** (§1.3 D5). */
  readonly maxParty: number;
  /** ← 현재 유효 결정석 기본가(솔로). `null` = 미확인 (§1.3 D4). **0 이 아니다.** */
  readonly crystalPriceMeso: MesoOrUnknown;
  /** 1부터. 표시·연속 배치 순서다. */
  readonly sortOrder: number;
}

/** 파티의 보스 목록 **전체 교체**. ← 대응: `public.set_party_bosses(party, ids[])` */
export interface SetPartyBossesInput {
  readonly partyId: PartyId;
  /** 배열 **순서가 곧 표시·배치 순서**다. 빈 배열은 "전부 지운다"이며 정상 입력이다. */
  readonly bossDifficultyIds: readonly BossDifficultyId[];
}

/**
 * 아직 계정이 없는 사람을 **닉네임만으로** 파티에 넣을 때 쓰는 이름 목록.
 * ← 대응: `insert into guest_profiles(display_name)` + `party_participants(guest_id)`
 *
 * 발주 요구(원문): "그냥 닉네임만으로도 파티 만들수있게 해야함. 상대방이 참여 안할수도있잖아."
 *
 * ★ **이미 파티에 있는 게스트는 여기 넣지 않는다.** 그들은 이미 `guest_profiles.id` 를
 *   가진 `PersonId` 이므로 `memberPersonIds` 로 들어온다. 이 목록은 **새로 만들 사람**
 *   전용이며, 넣을 때마다 새 게스트 행이 생긴다(같은 이름이어도 다른 사람일 수 있다).
 */
export type GuestNameInput = readonly string[];

/** 새 파티 만들기. ← 대응: `insert into parties` + `party_participants` 벌크 삽입 */
export interface CreatePartyInput {
  /** 비어 있으면 구성원 이름으로 자동 요약한다. */
  readonly name: string;
  readonly memberPersonIds: readonly PersonId[];
  /** 닉네임만으로 새로 만들어 넣을 게스트. 생략하면 없는 것으로 본다. */
  readonly guestNames?: GuestNameInput;
  /**
   * 이 파티가 **묶어서 도는 보스**. 배열 순서가 곧 표시·배치 순서다.
   *
   * ★ 파티를 만들 때 함께 받는 이유는 **제목이 여기서 나오기 때문**이다. 만든 뒤에
   *   따로 등록하게 하면 파티가 잠깐 `우레푸 외 2명` 이라는 이름으로 존재했다가 바뀐다.
   * ★ 생략·빈 배열도 정상이다. 그때는 예전처럼 구성원 이름으로 요약한다.
   */
  readonly bossDifficultyIds?: readonly BossDifficultyId[];
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
  /** 닉네임만으로 새로 만들어 넣을 게스트. 기존 게스트는 `memberPersonIds` 쪽이다. */
  readonly guestNames?: GuestNameInput;
  /**
   * 파티 이름. **`undefined` 는 "건드리지 않는다"** 이고 빈 문자열과 다르다.
   *
   * · 값이 있으면  → 그 이름으로 바꾸고 `name_is_custom = true` (자동 제목이 덮지 않는다)
   * · 빈 문자열이면 → `name_is_custom = false` 로 되돌리고 **자동 제목을 다시 만든다**
   *
   * 2026-08-20 에 추가했다. 그전에는 편집 화면이 이름 칸을 보여 주고 값을 받아 놓고도
   * 그 값을 **어디에도 보내지 않아** 저장이 안 됐다(발주 지적: *"파티명 수정이 안돼"*).
   */
  readonly name?: string;
}

/**
 * **이 파티에 어느 캐릭터로 들어가 있는가**를 정한다.
 * ← 대응: `update party_participants set character_id = ... where id = 내 참가자 행`
 *
 * ★ 대상은 **언제나 세션 본인의 참가자 행**이다. 남이 어느 캐릭터로 갈지는 본인만 아는
 *   정보이고, 받지 않는 값은 위조될 수 없다 — 그래서 "누구의" 를 받는 자리가 없다.
 * ★ `characterId === null` 은 "지정 해제"다. 에러가 아니라 정상 입력이다.
 */
export interface UpdatePartyCharacterInput {
  readonly partyId: PartyId;
  readonly characterId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 초대 · 승계 (게스트 → 정식 계정)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 게스트 한 명에게 발급한 초대 링크. ← 대응: `guest_profiles.claim_token_hash`
 *
 * ⚠️ **`token` 은 발급 응답에서 딱 한 번만 존재한다.** 서버는 SHA-256 해시만 보관하므로
 *    (마이그레이션 05 의 컬럼 주석 · CLAUDE.md §2.1 의 API 키 원칙과 같은 기조)
 *    잃어버리면 재발급뿐이고, 재발급하면 이전 링크는 즉시 죽는다.
 *
 * ★ 링크는 **파티가 아니라 사람에게** 붙는다. 그래서 이 한 장으로 그 사람이 끼어 있는
 *   파티가 전부 따라온다 — 발주 요구("1,2,3 파티에만 그사람이 끼어있다 … 바로 그
 *   초대된 친구에게도 파티 시간이 뜨는거지")가 정확히 이 모양이다.
 */
export interface GuestInvite {
  readonly guestPersonId: PersonId;
  readonly guestDisplayName: string;
  /** 원문 토큰. **이 응답 이후로는 어디에도 없다.** */
  readonly token: string;
  /** 이 링크를 받는 사람이 들어오게 될 파티 이름들. 화면이 "무엇이 딸려오는지" 설명한다. */
  readonly partyNames: readonly string[];
}

/**
 * 초대 링크를 열었을 때 보이는 내용. **비로그인도 볼 수 있다** — 그래야 받는 사람이
 * "이게 뭔지" 먼저 확인하고 로그인할지 정한다.
 */
export interface InviteSummary {
  readonly guestDisplayName: string;
  /** 그 게스트가 살아 있는 참가자로 들어가 있는 파티 이름들. */
  readonly partyNames: readonly string[];
  /** 이미 누군가에게 승계된 초대인가. `true` 면 링크는 더 이상 쓸 수 없다. */
  readonly alreadyClaimed: boolean;
}

/**
 * 승계 결과. ← `public.claim_guest_profile()` 의 반환값 그대로.
 *
 * - `movedParticipants` : 게스트 행이 그대로 내 계정 행으로 **전환**된 수.
 *   **`member_no` 는 손대지 않으므로 번호가 유지된다** (§1.4).
 * - `mergedParticipants`: 같은 파티에 내 정식 행이 이미 있어 **합쳐진** 수.
 *   실제로 생긴다 — 내가 이미 들어간 파티에 누군가 내 닉네임으로 게스트를 또 넣은 경우.
 */
export interface InviteClaimResult {
  readonly movedParticipants: number;
  readonly mergedParticipants: number;
  readonly partyNames: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 가능 시간 (핵심 화면 왼쪽 패널)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 요일별 반복 패턴 한 줄의 **입력 모양**. ← 대응: `availability_patterns` 삽입
 *
 * ★ **자정 넘김은 한 줄로 표현한다.** 수 22:00~02:00 = `{weekday: 3, 1320, 1560}`.
 *   `endMinute` 는 1440 을 넘을 수 있고(최대 2880), 그것이 곧 "다음 날로 이어진다"는 뜻이다.
 *   두 줄로 쪼개면 "밤 10시부터 새벽 2시까지"라는 사용자의 의도가 데이터에서 사라진다
 *   (DB-SCHEMA §10-2 · CLAUDE.md §1.4).
 *
 * ★ DB CHECK 와 같은 경계를 쓴다 — `startMinute` 0~1439, `endMinute` 1~2880,
 *   `endMinute > startMinute`, 그리고 **한 구간의 길이는 1440분(24시간) 이하**.
 */
export interface AvailabilityPatternInput {
  /**
   * 요일축. **주기를 쓰지 않는 사람**(대부분)의 축이며 `cycleDay` 와 정확히 하나만 채운다.
   *
   * ★ 널러블이 된 이유는 교대 근무다(2026-08-20). 교대는 요일이 아니라 N일 주기로 돌아서
   *   "화요일 = 항상 이 시간" 으로는 표현할 수 없다 — CLAUDE.md §1.4 · 마이그레이션 33.
   */
  readonly weekday: IsoWeekday | null;
  /** 교대 주기 칸 번호(0 … cycleDays-1). `weekday` 와 정확히 하나만 채운다. */
  readonly cycleDay: number | null;
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * 사람의 **교대 주기**. ← 출처: `availability_cycles`
 *
 * 없으면(=`null`) 요일(7일) 패턴으로 돈다. 있으면 그 사람의 요일 행은 **무시된다 —
 * 지워지지는 않으므로** 주기를 끄면 예전 패턴이 그대로 살아난다.
 */
export interface AvailabilityCycle {
  /** 주기 길이(일). 2 … 28. 주주야야비비 6 · 4조 3교대 8 · 격주 14 를 덮는다. */
  readonly cycleDays: number;
  /** 주기 **0번 칸**에 해당하는 KST 날짜(`yyyy-MM-dd`). 화면은 "1번 칸" 으로 보여 준다. */
  readonly anchorDate: string;
}

/**
 * 사람이 고른 **가능시간 방식**. ← 출처: `availability_modes`
 *
 * 둘은 **배타**다(마이그레이션 36). `weekly` 는 요일축 패턴만 읽고 달력 지정을 아예
 * 보지 않으며, `shift` 는 주기축 패턴 + 달력 지정만 읽고 요일축 패턴을 보지 않는다.
 * 고르지 않은 쪽 데이터는 **지워지지 않는다** — 되돌리면 그대로 살아난다.
 */
export type AvailabilityMode = "weekly" | "shift";

/**
 * 방식 + "직접 고른 적이 있는가".
 *
 * ⚠️ `chosen` 이 따로 있는 이유: 행이 없으면 해석기가 `weekly` 로 보므로 **동작은 같지만**,
 *    "고민 없이 기본값을 쓰는 중" 과 "weekly 를 골랐다" 는 화면에서 다른 말이어야 한다
 *    (방식 선택 모달을 먼저 띄울지 말지가 여기서 갈린다). 값만 내려보내면 그 구분이 사라진다.
 */
export interface AvailabilityModeState {
  readonly mode: AvailabilityMode;
  /** 한 번이라도 직접 고른 적이 있는가(행이 존재하는가). 행이 없으면 weekly 로 동작한다. */
  readonly chosen: boolean;
}

/**
 * **가능 시간대 묶음**의 입력 모양. 여기 적히는 구간은 그 날 **가능한 시간**이다.
 *
 * ⚠️ 2026-08-20 이전에는 "근무시간"(=빼는 시간)이었다. 뜻이 뒤집혔다 — 교대 근무자는
 *    근무만이 아니라 **자는 시간도 같이 돌기** 때문에 "못 하는 시간"을 적게 하면 자기
 *    하루를 통째로 설명해야 했고, 하나만 빠뜨려도 자는 시간이 "가능" 으로 남았다.
 */
export interface ShiftPresetInput {
  /** 화면에 찍히는 이름(주간근무날·야간근무날·비번…). 1~12자. */
  readonly name: string;
  /** 가능 시작(KST 분). */
  readonly startMinute: number;
  /** 가능 끝. 1440 초과 = 자정 넘김(22:00~익일 02:00 = 1320~1560). */
  readonly endMinute: number;
}

/** 저장된 가능 시간대 묶음. ← 출처: `shift_presets` */
export interface ShiftPreset extends ShiftPresetInput {
  readonly id: string;
  readonly sortOrder: number;
}

/**
 * 날짜별 **가능 시간 지정**. ← 출처: `shift_assignments`
 *
 * 하루에 하나이며 세 상태가 있다(2026-08-20 발주자: *"가능시간선택으로 바꿔"*).
 *   · 이 목록에 없는 날 → 평소 패턴 그대로
 *   · `presetId` 있음    → **그 날은 그 묶음의 시간만** 가능(패턴을 대체한다)
 *   · `presetId === null` → **그 날은 종일 불가**
 */
export interface ShiftAssignment {
  /** KST 달력 날짜(`yyyy-MM-dd`). */
  readonly workDate: string;
  readonly presetId: string | null;
}

/**
 * 달력의 한 날에 무엇을 찍는가. 세 상태를 **한 타입으로** 말한다 — `presetId: string | null`
 * 하나로는 "평소대로 되돌리기"와 "종일 불가"를 구분할 수 없다.
 */
export type DaySelection =
  | { readonly kind: "clear" }
  | { readonly kind: "blocked" }
  | { readonly kind: "preset"; readonly presetId: string };

/** 저장된 반복 패턴 한 줄. ← 출처: `availability_patterns` */
export interface AvailabilityPattern extends AvailabilityPatternInput {
  readonly id: string;
  readonly personId: PersonId;
  /** 메모. 화면은 입력을 요구하지 않으므로 `null` 이 정상이다. */
  readonly note: string | null;
}

/**
 * 특이사항(제외) 한 건의 **입력 모양**. ← 대응: `availability_exceptions` 삽입
 *
 * ★ **뺄셈 전용이다.** "이 날짜(또는 그 날의 이 구간)는 안 됨"이 표현할 수 있는 전부다.
 *   사유·메모·"대신 이 시간에 됨"은 **의도적으로 없다** (§1.4).
 * ★ 둘 다 `null` 이면 그날 전체 제외. 하나만 `null` 인 입력은 거부한다.
 */
export interface AvailabilityExceptionInput {
  readonly dayKey: KstDayKey;
  readonly startMinute: number | null;
  readonly endMinute: number | null;
}

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
 * **이미 등록된 보스 일정이 잡아먹은 시간** 한 조각.
 * ← 출처: `public.person_run_commitments(p_person_ids, p_from, p_to, p_exclude_run_id)`
 *
 * 발주자 원문(2026-08-18): *"일정을 등록하면 그 일정도 가능 시간에 반영이 되어야지
 * 당연히 보스를 두개 동시에 할수있는건아니잖음"*.
 *
 * ★ **이 값은 `AvailabilityInterval` 에서 이미 빠져 있지 않다.** 개인 레인은 여전히
 *   패턴−예외 전체를 그리고, 이 구간은 그 위에 **"이미 일정 있음" 블록으로 겹쳐**
 *   그린다(제외 블록과 같은 방식). 빠지는 것은 **겹침 계산(`OverlapWindow`)뿐**이다 —
 *   막대가 조용히 짧아지면 사용자에게는 "왜 안 되지?" 만 남는다.
 * ★ 판정(무엇이 시간을 잡아먹는가)은 **DB 함수 하나**가 소유한다. `going` 신청만 세고,
 *   취소된 런과 시각 미정 런은 세지 않는다. 웹과 카톡 봇이 같은 답을 내야 하기 때문에
 *   TS 에서 다시 판정하지 않는다.
 * ⚠️ 마이그레이션 미적용 DB 에서는 **빈 배열**이다(함수 없음). 오류가 아니라, 이 기능만
 *   조용히 빠진 정상 상태다.
 */
export interface RunCommitment {
  readonly personId: PersonId;
  readonly runId: RunId;
  readonly partyId: PartyId;
  readonly bossDifficultyId: BossDifficultyId;
  /** ← `boss_difficulties.short_name`. 좁은 블록에 들어가는 유일한 이름이다. */
  readonly shortName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
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

/**
 * ← 출처: enum `boss_cycle`. **불변이 아니다** — 2026-06-18 패치로 실제로 바뀌었다.
 *
 * ★ `season` 은 **집계 축**이지 초기화 축이 아니다(2026-08-26 발주 지시:
 *   *"시즌보스는 주간과 관련없어. 주간, 월간, 시즌보스 이렇게 세가지로 나눠"* ·
 *   *"하지만 시즌보스는 주간마다 초기화돼"*). 초기화는 주간과 같고, 12칸·주간 수익
 *   집계에서만 빠진다. DB 쪽 근거는 `v_character_boss_plan_status` 의 CASE 가
 *   season 을 ELSE(주차)로 떨어뜨린다는 것이다 — 마이그레이션 47 머리말 참고.
 */
export type BossCycle = "daily" | "weekly" | "monthly" | "season";

/**
 * 보스 엔트리 하나(= 보스 × 난이도).
 *
 * ← 출처: **코드 상수** `@/lib/boss-master` (2026-08-18). 그 상수는 시드 마이그레이션
 *   (`bosses` + `boss_difficulties` + `boss_crystal_prices` + `boss_aliases`)에서
 *   생성되며 `pnpm boss-master:check` 가 어긋남을 막는다. 뷰 `v_boss_catalog` 는
 *   DB 에 그대로 있지만 **앱은 더 이상 읽지 않는다.**
 */
export interface BossCatalogEntry {
  readonly bossDifficultyId: BossDifficultyId;
  readonly bossId: string;
  /** ← `boss_difficulties.korean_name`. UI·봇 응답에 그대로 쓴다. 예: `하드 스우` */
  readonly koreanName: string;
  /** ← `bosses.korean_name`. 예: `스우` */
  readonly bossKoreanName: string;
  /**
   * ← `boss_difficulties.short_name` (마이그레이션 22). 예: `하스`
   *
   * **좁은 자리 전용**이다 — 파티 묶음 제목, 목록 칩, 카톡 평문. 카드처럼 난이도 라벨을
   * 따로 그리는 자리에서는 `koreanName` / `bossKoreanName` 을 쓴다(줄임말에 이미 난이도가
   * 들어 있어 "하드 / 하스"로 두 번 말하게 된다).
   *
   * ★ 마이그레이션 미적용이면 서버가 `koreanName` 을 그대로 넣는다. 규칙으로 추론하지 않는다.
   */
  readonly shortName: string;
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
  /**
   * ← `boss_difficulties.counts_toward_weekly_limit`. 주간 결정석 **12칸을 먹는가.**
   *
   * 거의 언제나 `true` 다. `false` 는 `cycle: "weekly"` 이면서도 12칸에 들어가지 않는
   * 시즌/이벤트 보스뿐이다(메이린 · 2026-08-25). 이 값을 보지 않고 `cycle` 만으로
   * 12칸을 세면 그 보스 하나 때문에 체크리스트가 `13/12` 를 띄우고, 밤 동기화가 그
   * 캐릭터를 "다 찼다"로 보고 건너뛰어 **정작 그 보스의 클리어를 못 받는다.**
   */
  readonly countsTowardWeeklyLimit: boolean;
  /** ← `boss_aliases.alias` 목록. 봇/검색이 쓰는 별칭("하스우", "하카"). */
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
  /**
   * ← `party_participants.guest_id is not null` — 닉네임만으로 들어온 임시 참가자.
   * 게스트는 계정이 없어 캐릭터도 없으므로 이름 조합에서 괄호가 붙지 않는다
   * (`lib/domain/participant-label.ts`).
   */
  readonly isGuest: boolean;
  /** ← `party_participants.member_no` (§1.4 — 재배열 금지). */
  readonly seatNo: number;
  readonly status: SignupStatus;
  /** ← `run_signups.character_id`. `null` = 아직 어느 캐릭터로 갈지 정하지 않음. */
  readonly characterId: string | null;
  /** ← `characters.character_name`. `characterId` 가 있으면 반드시 함께 온다. */
  readonly characterName: string | null;
  /**
   * ← `characters.is_main`. 본캐로 가면 `더저`, 부캐로 가면 `더저(메검메)` 로 표시된다.
   * 조합 규칙은 `lib/domain/participant-label.ts` 한 곳이 소유한다.
   */
  readonly isMainCharacter: boolean;
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
  /**
   * ← `boss_difficulties.short_name`. 예: `하카`
   *
   * 카드는 난이도 라벨을 따로 그리므로 카드 제목에는 쓰지 않는다. 좁은 자리(칩·요약 줄·
   * 카톡 평문)가 이 값을 쓴다 — 파티 제목과 **같은 어휘**여야 사용자가 `익세 하대 하카 2인`
   * 파티와 그 일정을 눈으로 이을 수 있다.
   */
  readonly shortName: string;
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
 * **묶음 일정 등록** — 체크한 보스들을 시작 시각 하나로 **연달아** 잡는다.
 * ← 대응: `insert into party_runs` × N (Route Handler + service role)
 *
 * 발주 요구(원문): "보통 묶어서 가니 파티안에 보스를 여러개 등록 하고 시간 등록할때
 * 등록된 보스를 체크해서 시간대를 등록하게 만들어."
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **순차 배치가 기본이다. 같은 시각에 몰아넣지 않는다.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   익세 → 하대 → 하카는 한 자리에서 이어서 도는 순서이지 동시에 세 군데를 가는 것이
 *   아니다. 전부 같은 시각으로 넣으면 겹쳐보기 화면에서 막대 셋이 정확히 포개져
 *   **어느 것도 읽을 수 없게 된다.** 그래서 `scheduledAt` 은 **첫 보스의 시작 시각**이고,
 *   i 번째 보스는 `시작 + durationMinutes × i` 에 놓인다.
 *
 * ⚠️ `durationMinutes` 는 보스마다 다르지 않다 — 우리에게 보스별 소요 시간 데이터가
 *    없기 때문이다(넥슨 API 에도 없다). 한 값을 전부에 적용하고, 사용자가 그 값을
 *    조절한다. 보스별 값이 생기면 그때 배열로 바꾼다.
 * ⚠️ 배열이 **순서 그대로** 등록된다. `run_no` 는 트리거가 삽입 순서대로 max+1 을
 *    부여하므로 `#1 익세 · #2 하대 · #3 하카` 가 된다 (§1.4 — 재배열·재사용 없음).
 */
export interface CreateRunBundleInput
  extends Omit<CreateRunInput, "bossDifficultyId"> {
  /** 체크된 보스. **1개 이상**이며 배열 순서가 곧 등록 순서다. */
  readonly bossDifficultyIds: readonly BossDifficultyId[];
  /**
   * **고정팟** — 같은 요일·같은 시각으로 몇 주치를 한 번에 잡을 것인가 (2026-08-19 발주자:
   * *"보스 일정 등록할때 고정팟 체크가 있었으면 함. 매주 같은시간에 가는 파티도 있어"*).
   *
   * `1`(기본) 이면 이번 한 번만이다. `n` 이면 **이번 주를 포함해** n 주치가 각각 7일씩
   * 밀려 등록된다.
   *
   * ★ 반복을 **행으로 펼친다** — 규칙을 저장해 두고 나중에 만들어 내는 방식이 아니다.
   *   그 편이 이 저장소의 나머지와 맞는다: 일정은 파티원이 각자 참가/불참을 눌러 고치는
   *   대상이고, 규칙에서 매번 생성되는 화면은 "지난주엔 안 갔다"를 표현할 자리가 없다.
   *   대가는 4주 뒤가 지나면 다시 등록해야 한다는 것이고, 그건 화면이 문구로 말한다.
   */
  readonly repeatWeeks?: number;
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

/**
 * 일정 **수정** 입력. ← 대응: `update party_runs set ... where id = ...`
 *
 * 발주 지시(2026-08-18): *"일정 수정 취소 삭제 하는 부분은 api 부터 먼저 만들고 있어"*
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **`runNo` 는 이 경로에서 절대 바뀌지 않는다** (§1.4).
 *   ═══════════════════════════════════════════════════════════════════════════
 *   시각을 다음 주로 옮겨도 번호는 그대로다. 트리거 `party_runs_assign_run_no` 는
 *   `before insert` 에만 붙어 있어 UPDATE 로는 재부여가 일어나지 않고, 이 입력에도
 *   번호를 담는 자리를 두지 않는다 — **받지 않는 값은 바뀔 수 없다.**
 *   카톡에서 "2번 일정"이라 부르던 대화가 조용히 다른 일정을 가리키면 안 된다.
 *
 * ★ **부분 수정이다.** `undefined` 인 필드는 건드리지 않는다. `note` 만 `null` 이
 *   "지운다"는 뜻을 갖는다(빈 메모).
 *
 * ⚠️ **보스(`bossDifficultyId`)는 바꿀 수 없다.** 일부러 뺐다.
 *    - 클리어 원장 `boss_clears` 는 `(user_id, character_id, boss_difficulty_id, week_key)`
 *      가 유니크다. 런의 보스만 갈아끼우면 이미 붙은 클리어가 **다른 보스의 수익**을
 *      가리키게 되고, 갈아끼운 보스에 그 주 클리어가 이미 있으면 유니크 충돌이 난다.
 *    - 묶음 등록(`CreateRunBundleInput`)이 보스별로 시각을 순차 배치하므로, 보스를
 *      잘못 고른 런은 **아직 클리어가 없어 삭제가 되는** 상태다. 지우고 다시 등록하는
 *      비용이 위 위험보다 훨씬 싸다.
 * ⚠️ `weekKey` 도 받지 않는다 — `party_runs.week_key` 는 `scheduled_at` 에서 파생되는
 *    **생성 컬럼**이라 UPDATE 에 실으면 에러다. 시각을 바꾸면 알아서 따라간다.
 */
export interface UpdateRunInput {
  readonly runId: RunId;
  /**
   * 새 시작 시각. `null` = **시각 미정으로 되돌린다**(겹쳐보기로 다시 조율).
   *
   * ⚠️ 클리어가 이미 붙은 런은 **같은 주차 안에서만** 옮길 수 있다. 수익은 클리어
   *    주차에 귀속되는데(§1.3 D1) `boss_clears.week_key` 는 체크 시점에 스냅샷된
   *    값이라, 런만 다음 주로 옮기면 수익이 지난주에 남아 조용히 어긋난다.
   */
  readonly scheduledAt?: Date | null;
  /** DB CHECK 와 같은 5~600 범위. 서버가 다시 검증한다. */
  readonly durationMinutes?: number;
  /**
   * 입장 실제 인원. §1.3 D3 가 **사용자가 고칠 수 있어야 한다**고 못박은 값이라
   * 수정 경로에 반드시 있어야 한다. 1/n 의 분모이며 `max_party` 는 소프트 상한이라
   * 여기서 막지 않는다(§1.3 D5).
   */
  readonly entryPartySize?: number;
  /** `null` = 메모 삭제. */
  readonly note?: string | null;
  /**
   * `false` 로 보내면 **취소를 되돌린다**(복구).
   *
   * ★ 복구 경로를 만든 이유: 취소를 삭제보다 우선하는 근거가 "되돌릴 수 있어서"인데,
   *   되돌릴 길이 없으면 오조작 한 번으로 그 런이 영구히 화면에서 사라진다 —
   *   클리어가 붙어 있어 삭제도 안 되므로 사용자가 스스로 복구할 방법이 없어진다.
   *   컬럼 하나를 비우는 일이라 비용도 사실상 0 이다.
   * ★ `true` 는 받지 않는다. 취소는 `DELETE` 하나가 소유한다 — 같은 일을 두 경로가
   *   하면 반드시 갈라진다.
   */
  readonly cancelled?: false;
}

/**
 * 일정 제거 요청의 **서버 판정 결과**.
 *
 * 발주자 확정 정책(2026-08-18 원문): *"클리어 붙은것은 취소, 안붙은건 삭제 가능하게 하고"*
 *
 * - `cancelled` — 클리어(`boss_clears.run_id`)가 붙어 있어 **행을 남기고** `cancelled_at`
 *   만 찍었다. 지우면 그 클리어가 런을 잃어 수익 이력이 끊긴다.
 * - `deleted` — 붙은 클리어가 없어 행을 제거했다.
 *
 * ★ **클라이언트는 어느 쪽인지 몰라도 된다.** 판정은 서버가 하고 결과만 알려 준다 —
 *   "먼저 물어보고 다시 부르는" 왕복은 그 사이에 상태가 바뀌면 틀린 판정을 낳는다.
 */
export type RunRemovalOutcome = "cancelled" | "deleted";
