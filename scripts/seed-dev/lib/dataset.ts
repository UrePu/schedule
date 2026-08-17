/**
 * 시드 데이터 정의 — **실행 시점(`now`)에서 계산**한다. 날짜 하드코딩 없음.
 *
 * 값은 `src/features/schedule/data/mock-fixtures.ts` 와 같은 구성으로 골랐다.
 * 목 데이터를 실제 쿼리로 갈아끼웠을 때 화면이 그대로 이어지게 하기 위해서다.
 *
 * ★ 심어 둔 엣지 케이스 (전부 의도적이다)
 *
 * | # | 심어 둔 것                        | 어디서 보이나 |
 * |---|-----------------------------------|---------------|
 * | 1 | 하루 통째 제외                     | 라이언 · 목요일 전체 (`0~1440`) |
 * | 2 | 구간 일부 제외                     | 코코 · 일요일 21:00~22:00 |
 * | 3 | **자정 넘김 구간의 일부 제외**      | 진서 · 토 00:00~01:00 → 금 23:00~03:00 패턴이 **두 조각**으로 쪼개진다 |
 * | 4 | 사유 없는 제외 (`note = null`)     | 미르 · 수요일 21:00~24:00 |
 * | 5 | 자정을 넘기는 가능시간             | 라이언 22:00~26:00, 진서 23:00~27:00 (`end_minute > 1440`) |
 * | 6 | 빠진 참가자 번호(재배열 금지)      | 목요일 파티 `member_no` = 1,2,3,**5**,6,7 — 4번이 비어 있다 |
 * | 7 | 일정이 0건인 파티                  | 길드 신입 원정대 |
 * | 8 | 게스트(초대 승계 대기)             | 코코 — `claim_token_hash` 有 / `claimed_by_user_id` = null |
 * | 9 | 균등이 아닌 분배 (33:67)           | 칼로스 런 — `share_mode = 'manual'`, 3300 / 6700 |
 * |10 | 가격 미확인 보스                   | `bellona_normal` 런 + 클리어 2건 → 수익 합계 제외, `unknown_price_count` 로 별도 계상 |
 * |11 | 미판매 드랍 (`sale_amount = null`) | 칠흑의 보스 세트 반지 |
 * |12 | 수동/API 판정 충돌                 | 라이언 · 카오스 더스크 → `has_conflict = true` |
 * |13 | 일간 보스 클리어                   | 하드 반 레온 · 노멀 힐라 → 주간 12개 카운터에 들어가지 않는다 |
 *
 * ⚠️ 목 데이터와 **의도적으로 다른 점**
 * - 파티 가시성: 주말 검마를 `public` 으로 두었다. 그러지 않으면 비로그인 공개 시간표
 *   (`v_public_party_board` / `v_public_party_runs`)가 통째로 비어 검증할 수 없다.
 *   결과적으로 `private` / `link` / `public` 세 값이 모두 데이터에 나타난다.
 * - 보스 엔트리 id 는 **실 스키마 값**을 쓴다. 목 데이터의 `velona_normal` / `jin_hilla_hard` /
 *   `darknell_hard` / `von_leon_chaos` 는 DB 에 없는 이름이라
 *   `bellona_normal` / `verus_hilla_hard` / `dunkel_hard` / `von_leon_hard` 로 대응시켰다.
 */
import { seedHash, seedId } from './ids'
import { DAY_LABELS, kstDate, kstMoment, weekKey } from './week'

// ─────────────────────────────────────────────────────────────────────────────
// 행 타입 — DB 컬럼과 1:1
// ─────────────────────────────────────────────────────────────────────────────

export interface AppUserRow {
  id: string
  display_name: string
}

export interface GuestProfileRow {
  id: string
  display_name: string
  created_via_invite_id: string
  claim_token_hash: string
}

export interface CharacterRow {
  id: string
  user_id: string
  character_name: string
  world_name: string
  character_class: string
  character_level: number
  guild_name: string
  is_main: boolean
  is_tracked: boolean
}

export interface PartyRow {
  id: string
  owner_user_id: string
  name: string
  description: string
  visibility: 'private' | 'link' | 'public'
  share_slug: string | null
  world_name: string
  default_capacity: number
}

export interface InviteLinkRow {
  id: string
  party_id: string
  token_hash: string
  created_by_user_id: string
  role_on_join: 'owner' | 'organizer' | 'member'
  label: string
  max_uses: number
  used_count: number
}

export interface FriendshipRow {
  id: string
  requester_user_id: string
  addressee_user_id: string
  status: 'pending' | 'accepted' | 'blocked'
  responded_at: string
}

export interface ParticipantRow {
  id: string
  party_id: string
  user_id: string | null
  guest_id: string | null
  display_name: string
  role: 'owner' | 'organizer' | 'member'
  character_id: string | null
  /** ★ 명시 지정. 트리거는 값이 있으면 존중하므로 빈 번호(4번)를 그대로 재현할 수 있다. */
  member_no: number
}

export interface PatternRow {
  id: string
  user_id: string | null
  guest_id: string | null
  /** ISO 1=월 … 7=일 */
  weekday: number
  start_minute: number
  /** 1440 초과 = 자정 넘김 */
  end_minute: number
  note: string | null
}

export interface ExceptionRow {
  id: string
  user_id: string | null
  guest_id: string | null
  /** KST 달력 날짜 `YYYY-MM-DD` */
  exception_date: string
  start_minute: number
  end_minute: number
  note: string | null
}

export interface RunRow {
  id: string
  party_id: string
  boss_difficulty_id: string
  /** ISO 8601 (UTC). `week_key` 는 생성 컬럼이므로 **보내지 않는다.** */
  scheduled_at: string
  duration_minutes: number
  status: 'proposed' | 'confirmed' | 'done' | 'cancelled'
  capacity: number
  entry_party_size: number
  share_mode: 'auto_equal' | 'manual'
  created_by_participant_id: string
  note: string
  run_no: number
}

export interface SignupRow {
  id: string
  run_id: string
  participant_id: string
  status: 'going' | 'maybe' | 'declined'
  character_id: string | null
  note: string | null
  /** `auto_equal` 런은 0 을 넣고 DB 트리거가 균등 재계산한다. */
  share_bp: number
}

export interface BossClearRow {
  id: string
  user_id: string
  character_id: string
  boss_difficulty_id: string
  run_id: string | null
  manual_cleared: boolean
  manual_set_at: string
  api_cleared: boolean | null
  api_observed_at: string | null
  cleared_at: string
  party_size: number
  world_name: string
  source: 'manual' | 'nexon_api' | 'bot'
  note: string | null
}

export interface DropRow {
  id: string
  run_id: string
  item_name: string
  /** `null` = 아직 안 팔았다. **0 이 아니다.** */
  sale_amount_meso: number | null
  share_mode: 'party_default' | 'custom' | 'solo'
  solo_participant_id: string | null
  recorded_by_participant_id: string
  note: string | null
}

export interface DropShareRow {
  id: string
  drop_id: string
  participant_id: string
  share_bp: number
}

export interface Dataset {
  readonly now: Date
  readonly weekStart: Date
  readonly weekKey: string
  readonly appUsers: readonly AppUserRow[]
  readonly characters: readonly CharacterRow[]
  readonly parties: readonly PartyRow[]
  readonly inviteLinks: readonly InviteLinkRow[]
  readonly guestProfiles: readonly GuestProfileRow[]
  readonly friendships: readonly FriendshipRow[]
  readonly participants: readonly ParticipantRow[]
  readonly patterns: readonly PatternRow[]
  readonly exceptions: readonly ExceptionRow[]
  readonly runs: readonly RunRow[]
  readonly signups: readonly SignupRow[]
  readonly bossClears: readonly BossClearRow[]
  readonly drops: readonly DropRow[]
  readonly dropShares: readonly DropShareRow[]
  /** 33:67 을 확정 적용할 런. 삽입 후 `set_run_shares` 로 한 번 더 못박는다. */
  readonly manualShareRun: {
    runId: string
    participantIds: readonly string[]
    shareBps: readonly number[]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 사람
// ─────────────────────────────────────────────────────────────────────────────

const USER_KEYS = [
  'urepu',
  'ryan',
  'mir',
  'haneul',
  'jinseo',
  'dante',
  'yui',
  'sera',
] as const
type UserKey = (typeof USER_KEYS)[number]

const GUEST_KEYS = ['coco'] as const
type GuestKey = (typeof GUEST_KEYS)[number]

type PersonKey = UserKey | GuestKey

const DISPLAY_NAMES: Record<PersonKey, string> = {
  urepu: '우레푸',
  ryan: '라이언',
  mir: '미르',
  haneul: '하늘',
  jinseo: '진서',
  dante: '단테',
  yui: '유이',
  sera: '세라',
  coco: '코코',
}

const CHARACTER_INFO: Record<UserKey, { charClass: string; level: number }> = {
  urepu: { charClass: '아크메이지(불,독)', level: 285 },
  ryan: { charClass: '나이트로드', level: 279 },
  mir: { charClass: '아델', level: 291 },
  haneul: { charClass: '패스파인더', level: 276 },
  jinseo: { charClass: '호영', level: 283 },
  dante: { charClass: '데몬슬레이어', level: 271 },
  yui: { charClass: '카데나', level: 268 },
  sera: { charClass: '비숍', level: 274 },
}

const WORLD_NAME = '스카니아'
const GUILD_NAME = '결정석파티'

const userIndex = (key: UserKey): number => USER_KEYS.indexOf(key) + 1
const guestIndex = (key: GuestKey): number => GUEST_KEYS.indexOf(key) + 1

const userId = (key: UserKey): string => seedId('appUser', userIndex(key))
const guestId = (key: GuestKey): string => seedId('guest', guestIndex(key))
const characterId = (key: UserKey): string => seedId('character', userIndex(key))

const isGuest = (key: PersonKey): key is GuestKey =>
  (GUEST_KEYS as readonly string[]).includes(key)

const personOwner = (key: PersonKey): { user_id: string | null; guest_id: string | null } =>
  isGuest(key) ? { user_id: null, guest_id: guestId(key) } : { user_id: userId(key), guest_id: null }

// ─────────────────────────────────────────────────────────────────────────────
// 가능시간 패턴 — 목 데이터와 같은 값
// ─────────────────────────────────────────────────────────────────────────────

const MON_TO_FRI = [1, 2, 3, 4, 5] as const
const WEEKEND = [6, 7] as const
const H = (hour: number, minute = 0): number => hour * 60 + minute

interface PatternSpec {
  person: PersonKey
  weekdays: readonly number[]
  start: number
  end: number
  note?: string
}

/** ★ `end > 1440` 인 행은 자정 넘김을 **한 행으로** 표현한 것이다. 쪼개지 않는다. */
const PATTERN_SPECS: readonly PatternSpec[] = [
  // 우레푸 — 평일 21~24 / 주말 20~24
  { person: 'urepu', weekdays: MON_TO_FRI, start: H(21), end: H(24) },
  { person: 'urepu', weekdays: WEEKEND, start: H(20), end: H(24) },

  // 라이언 — 평일 22~익일 02 / 주말 21~익일 02  ★ 자정 넘김
  {
    person: 'ryan',
    weekdays: MON_TO_FRI,
    start: H(22),
    end: H(26),
    note: '퇴근 후 · 자정 넘겨서도 가능',
  },
  { person: 'ryan', weekdays: WEEKEND, start: H(21), end: H(26) },

  // 미르 — 평일 20~24 / 주말 낮 13~17 + 저녁 19~24
  { person: 'mir', weekdays: MON_TO_FRI, start: H(20), end: H(24) },
  { person: 'mir', weekdays: WEEKEND, start: H(13), end: H(17) },
  { person: 'mir', weekdays: WEEKEND, start: H(19), end: H(24) },

  // 하늘 — 교대근무. 월·수·금만 21~24 (화·목은 패턴 자체가 없다) / 주말 19~23
  {
    person: 'haneul',
    weekdays: [1, 3, 5],
    start: H(21),
    end: H(24),
    note: '화·목은 야간 근무라 패턴 없음',
  },
  { person: 'haneul', weekdays: WEEKEND, start: H(19), end: H(23) },

  // 진서 — 평일 23~익일 03 / 주말 20~익일 02  ★ 자정 넘김
  { person: 'jinseo', weekdays: MON_TO_FRI, start: H(23), end: H(27) },
  { person: 'jinseo', weekdays: WEEKEND, start: H(20), end: H(26) },

  // 코코(게스트) — 평일 21~23 / 주말 낮 15~19 + 저녁 21~24
  { person: 'coco', weekdays: MON_TO_FRI, start: H(21), end: H(23) },
  { person: 'coco', weekdays: WEEKEND, start: H(15), end: H(19) },
  { person: 'coco', weekdays: WEEKEND, start: H(21), end: H(24) },

  // 단테 — 평일 22~24 / 주말 20~24 (자정을 넘기지 않는다)
  { person: 'dante', weekdays: MON_TO_FRI, start: H(22), end: H(24) },
  { person: 'dante', weekdays: WEEKEND, start: H(20), end: H(24) },

  // 유이 — 평일 패턴이 **아예 없다** / 주말 낮 14~18 + 저녁 21~24
  { person: 'yui', weekdays: WEEKEND, start: H(14), end: H(18) },
  { person: 'yui', weekdays: WEEKEND, start: H(21), end: H(24) },

  // 세라 — 평일 20~23 / 주말 19~24
  { person: 'sera', weekdays: MON_TO_FRI, start: H(20), end: H(23) },
  { person: 'sera', weekdays: WEEKEND, start: H(19), end: H(24) },
]

interface ExceptionSpec {
  person: PersonKey
  /** 주 시작(목) 기준 오프셋. 0=목 … 6=수 */
  dayOffset: number
  start: number
  end: number
  note: string | null
  why: string
}

/**
 * ★ 예외는 **뺄셈 전용**이고 **벽시계 시각 기준**으로 잘라낸다 (CLAUDE.md §1.4).
 * `availability_exceptions` 는 `start_minute` / `end_minute` 가 NOT NULL 이므로
 * "하루 통째"는 `(0, 1440)` 으로 표현한다 — 별도 종류(kind)를 두지 않는다.
 */
const EXCEPTION_SPECS: readonly ExceptionSpec[] = [
  {
    person: 'ryan',
    dayOffset: 0, // 목
    start: 0,
    end: 1440,
    note: '야근 — 월말 결산',
    why: '하루 통째 제외. 수요일 22:00~02:00 에서 넘어온 목 00:00~02:00 까지 사라진다.',
  },
  {
    person: 'jinseo',
    dayOffset: 2, // 토
    start: 0,
    end: 60,
    note: '새벽 약속',
    why: '자정 넘김 구간의 **일부** 제외. 금 23:00~03:00 이 금23~토00 / 토01~토03 두 조각이 된다.',
  },
  {
    person: 'coco',
    dayOffset: 3, // 일
    start: H(21),
    end: H(22),
    note: '출장 복귀 늦어짐',
    why: '구간 일부 제외. 주말 저녁 21~24 패턴이 22~24 만 남는다.',
  },
  {
    person: 'mir',
    dayOffset: 6, // 수
    start: H(21),
    end: H(24),
    note: null,
    why: '사유 없는 제외(§1.4 "이유는 없어도 됨"). 수 20~21 만 남는다.',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 파티 / 일정
// ─────────────────────────────────────────────────────────────────────────────

type PartyKey = 'thursday' | 'kalos' | 'guild' | 'weekend'

const PARTY_KEYS: readonly PartyKey[] = ['thursday', 'kalos', 'guild', 'weekend']
const partyId = (key: PartyKey): string => seedId('party', PARTY_KEYS.indexOf(key) + 1)

interface PartySpec {
  key: PartyKey
  name: string
  description: string
  visibility: 'private' | 'link' | 'public'
  shareSlug: string | null
  capacity: number
  owner: UserKey
  /** `[사람, 그 파티에서의 번호]`. **번호는 파티마다 독립이다.** */
  roster: ReadonlyArray<{ person: PersonKey; memberNo: number; role?: 'organizer' }>
}

const PARTY_SPECS: readonly PartySpec[] = [
  {
    key: 'thursday',
    name: '목요일 결정석 파티',
    description: '주간 결정석 6인 고정. 링크를 아는 사람만 볼 수 있습니다.',
    visibility: 'link',
    shareSlug: 'seedthu1',
    capacity: 6,
    owner: 'urepu',
    // ★ 4번이 없다. 4번이 나갔지만 5·6·7 을 당기지 않았다 (§1.4 번호 재배열 금지).
    roster: [
      { person: 'urepu', memberNo: 1 },
      { person: 'ryan', memberNo: 2, role: 'organizer' },
      { person: 'mir', memberNo: 3 },
      { person: 'haneul', memberNo: 5 },
      { person: 'jinseo', memberNo: 6 },
      { person: 'coco', memberNo: 7 },
    ],
  },
  {
    key: 'kalos',
    name: '칼로스 3인',
    description: '카오스 칼로스 버스. 분배는 협의합니다.',
    visibility: 'private',
    shareSlug: null,
    capacity: 3,
    owner: 'urepu',
    roster: [
      { person: 'urepu', memberNo: 1 },
      { person: 'mir', memberNo: 2 },
      { person: 'dante', memberNo: 3 },
    ],
  },
  {
    key: 'guild',
    // ★ 목요일 파티와 구성원이 **하나도 겹치지 않는다** + 일정이 **0건**이다 (빈 상태 확인용).
    name: '길드 신입 원정대',
    description: '아직 일정이 하나도 없습니다.',
    visibility: 'private',
    shareSlug: null,
    capacity: 6,
    owner: 'yui',
    roster: [
      { person: 'yui', memberNo: 1 },
      { person: 'sera', memberNo: 2 },
      { person: 'dante', memberNo: 3 },
    ],
  },
  {
    key: 'weekend',
    name: '주말 검마',
    description: '월간 하드 검은 마법사. 누구나 볼 수 있는 공개 파티입니다.',
    visibility: 'public',
    shareSlug: 'seedwknd',
    capacity: 6,
    owner: 'haneul',
    roster: [
      { person: 'haneul', memberNo: 1 },
      { person: 'ryan', memberNo: 2 },
      { person: 'jinseo', memberNo: 3 },
      { person: 'sera', memberNo: 4 },
    ],
  },
]

type RunKey = 'lotus' | 'dusk' | 'bellona' | 'kalos' | 'blackMage'
const RUN_KEYS: readonly RunKey[] = ['lotus', 'dusk', 'bellona', 'kalos', 'blackMage']
const runId = (key: RunKey): string => seedId('run', RUN_KEYS.indexOf(key) + 1)

interface RunSpec {
  key: RunKey
  party: PartyKey
  bossDifficultyId: string
  /** 주 시작(목) 기준 오프셋 0~6 */
  dayOffset: number
  minute: number
  durationMinutes: number
  status: 'proposed' | 'confirmed' | 'done' | 'cancelled'
  entryPartySize: number
  shareMode: 'auto_equal' | 'manual'
  runNo: number
  note: string
  signups: ReadonlyArray<{
    person: PersonKey
    status: 'going' | 'maybe' | 'declined'
    /** `manual` 런에서만 의미가 있다. `auto_equal` 은 0 을 넣고 DB 가 계산한다. */
    shareBp?: number
    note?: string
  }>
}

const RUN_SPECS: readonly RunSpec[] = [
  {
    key: 'lotus',
    party: 'thursday',
    bossDifficultyId: 'lotus_hard',
    dayOffset: 2, // 토
    minute: H(21),
    durationMinutes: 60,
    status: 'confirmed',
    entryPartySize: 6,
    shareMode: 'auto_equal',
    runNo: 1,
    note: '전원 가능한 창(토 21~23시)에 잡았습니다.',
    signups: [
      { person: 'urepu', status: 'going' },
      { person: 'ryan', status: 'going' },
      { person: 'mir', status: 'going' },
      { person: 'haneul', status: 'going' },
      { person: 'jinseo', status: 'going' },
      { person: 'coco', status: 'going' },
    ],
  },
  {
    key: 'dusk',
    party: 'thursday',
    bossDifficultyId: 'dusk_chaos',
    dayOffset: 1, // 금
    minute: H(21),
    durationMinutes: 45,
    status: 'proposed',
    entryPartySize: 4,
    shareMode: 'auto_equal',
    runNo: 2,
    note: '인원 미정 — 4명이면 갑니다.',
    signups: [
      { person: 'urepu', status: 'going' },
      { person: 'ryan', status: 'going' },
      { person: 'mir', status: 'going' },
      { person: 'haneul', status: 'going' },
      { person: 'jinseo', status: 'declined', note: '결혼식' },
      { person: 'coco', status: 'maybe' },
    ],
  },
  {
    key: 'bellona',
    party: 'thursday',
    // ★ 가격 미확인 보스 (§1.3 D4). 수익 합계에서 제외되고 별도로 세어져야 한다.
    bossDifficultyId: 'bellona_normal',
    dayOffset: 3, // 일
    minute: H(22),
    durationMinutes: 40,
    status: 'confirmed',
    entryPartySize: 3,
    shareMode: 'auto_equal',
    runNo: 3,
    note: '결정석 시세 미확인 보스입니다. 수익 합계에는 잡히지 않습니다.',
    signups: [
      { person: 'urepu', status: 'going' },
      { person: 'mir', status: 'going' },
      { person: 'jinseo', status: 'going' },
    ],
  },
  {
    key: 'kalos',
    party: 'kalos',
    bossDifficultyId: 'kalos_chaos',
    dayOffset: 5, // 화
    minute: H(22),
    durationMinutes: 90,
    status: 'confirmed',
    entryPartySize: 2,
    // ★ 균등이 아닌 분배 (33:67)
    shareMode: 'manual',
    runNo: 1,
    note: '버스 — 분배 33 : 67 로 합의했습니다.',
    signups: [
      { person: 'urepu', status: 'going', shareBp: 3300 },
      { person: 'mir', status: 'going', shareBp: 6700 },
      { person: 'dante', status: 'declined' },
    ],
  },
  {
    key: 'blackMage',
    party: 'weekend',
    bossDifficultyId: 'black_mage_hard',
    dayOffset: 3, // 일
    minute: H(20),
    durationMinutes: 120,
    status: 'confirmed',
    entryPartySize: 4,
    shareMode: 'auto_equal',
    runNo: 1,
    note: '월간 보스. 드랍은 따로 정산합니다.',
    signups: [
      { person: 'haneul', status: 'going' },
      { person: 'ryan', status: 'going' },
      { person: 'jinseo', status: 'going' },
      { person: 'sera', status: 'going' },
    ],
  },
]

interface ClearSpec {
  person: UserKey
  bossDifficultyId: string
  run: RunKey | null
  partySize: number
  /** 런이 없는 일간 보스는 시각을 직접 지정한다. */
  at?: { dayOffset: number; minute: number }
  /** 넥슨 API 와 수동 체크가 어긋난 상태를 재현한다. */
  apiConflict?: boolean
  note?: string
}

const CLEAR_SPECS: readonly ClearSpec[] = [
  { person: 'urepu', bossDifficultyId: 'lotus_hard', run: 'lotus', partySize: 6 },
  { person: 'ryan', bossDifficultyId: 'lotus_hard', run: 'lotus', partySize: 6 },
  { person: 'mir', bossDifficultyId: 'lotus_hard', run: 'lotus', partySize: 6 },
  { person: 'urepu', bossDifficultyId: 'dusk_chaos', run: 'dusk', partySize: 4 },
  {
    person: 'ryan',
    bossDifficultyId: 'dusk_chaos',
    run: 'dusk',
    partySize: 4,
    // ★ 수동은 클리어, API 는 미클리어. 관측 시각이 더 최신인 수동이 이기고 충돌 배지가 남는다.
    apiConflict: true,
    note: '넥슨 API 는 아직 미반영 (약 15분 지연)',
  },
  // ★ 33:67 분배가 실제 금액에 반영되는지 보는 지점
  { person: 'urepu', bossDifficultyId: 'kalos_chaos', run: 'kalos', partySize: 2 },
  { person: 'mir', bossDifficultyId: 'kalos_chaos', run: 'kalos', partySize: 2 },
  // ★ 가격 미확인 — 0 이 아니라 null 로 남아야 한다
  { person: 'urepu', bossDifficultyId: 'bellona_normal', run: 'bellona', partySize: 3 },
  { person: 'mir', bossDifficultyId: 'bellona_normal', run: 'bellona', partySize: 3 },
  { person: 'haneul', bossDifficultyId: 'black_mage_hard', run: 'blackMage', partySize: 4 },
  // ★ 일간 보스 — 주간 12개 카운터에 들어가지 않는다
  {
    person: 'urepu',
    bossDifficultyId: 'von_leon_hard',
    run: null,
    partySize: 1,
    at: { dayOffset: 1, minute: H(20) },
  },
  {
    person: 'urepu',
    bossDifficultyId: 'hilla_normal',
    run: null,
    partySize: 1,
    at: { dayOffset: 2, minute: H(20) },
  },
]

interface DropSpec {
  run: RunKey
  itemName: string
  /** `null` = 아직 안 팔았다 */
  saleAmountMeso: number | null
  shareMode: 'party_default' | 'custom' | 'solo'
  soloPerson?: PersonKey
  /** `custom` 일 때만 */
  customShares?: ReadonlyArray<{ person: PersonKey; shareBp: number }>
  note?: string
}

const DROP_SPECS: readonly DropSpec[] = [
  {
    run: 'blackMage',
    itemName: '고통의 근원',
    saleAmountMeso: 1_200_000_000,
    shareMode: 'party_default',
  },
  {
    run: 'blackMage',
    itemName: '칠흑의 보스 세트 반지',
    // ★ 아직 안 팔았다. 0 이 아니라 null 이다 (§8-6).
    saleAmountMeso: null,
    shareMode: 'party_default',
    note: '아직 판매 전 — 정산 뷰에 나타나지 않아야 합니다.',
  },
  {
    run: 'blackMage',
    itemName: '여명의 눈',
    saleAmountMeso: 900_000_000,
    shareMode: 'custom',
    customShares: [
      { person: 'haneul', shareBp: 4000 },
      { person: 'ryan', shareBp: 2000 },
      { person: 'jinseo', shareBp: 2000 },
      { person: 'sera', shareBp: 2000 },
    ],
  },
  {
    run: 'lotus',
    itemName: '창세의 뿌리',
    saleAmountMeso: 500_000_000,
    shareMode: 'solo',
    soloPerson: 'urepu',
    note: '먹은 사람이 전부 가져갑니다.',
  },
]

/** 수락된 친구 관계. 파티원 후보 목록(§1.4 왼쪽 패널)의 출처다. */
const FRIENDSHIP_PAIRS: ReadonlyArray<readonly [UserKey, UserKey]> = [
  ['urepu', 'ryan'],
  ['urepu', 'mir'],
  ['urepu', 'haneul'],
  ['urepu', 'jinseo'],
  ['urepu', 'dante'],
  ['urepu', 'yui'],
  ['urepu', 'sera'],
  ['haneul', 'ryan'],
  ['haneul', 'jinseo'],
  ['haneul', 'sera'],
  ['yui', 'sera'],
  ['yui', 'dante'],
]

// ─────────────────────────────────────────────────────────────────────────────
// 조립
// ─────────────────────────────────────────────────────────────────────────────

const INVITE_ID = seedId('invite', 1)

export function buildDataset(now: Date, start: Date): Dataset {
  const iso = (d: Date): string => d.toISOString()

  const appUsers: AppUserRow[] = USER_KEYS.map((key) => ({
    id: userId(key),
    display_name: DISPLAY_NAMES[key],
  }))

  const characters: CharacterRow[] = USER_KEYS.map((key) => ({
    id: characterId(key),
    user_id: userId(key),
    character_name: DISPLAY_NAMES[key],
    world_name: WORLD_NAME,
    character_class: CHARACTER_INFO[key].charClass,
    character_level: CHARACTER_INFO[key].level,
    guild_name: GUILD_NAME,
    is_main: true,
    is_tracked: true,
  }))

  const parties: PartyRow[] = PARTY_SPECS.map((spec) => ({
    id: partyId(spec.key),
    owner_user_id: userId(spec.owner),
    name: spec.name,
    description: spec.description,
    visibility: spec.visibility,
    share_slug: spec.shareSlug,
    world_name: WORLD_NAME,
    default_capacity: spec.capacity,
  }))

  const inviteLinks: InviteLinkRow[] = [
    {
      id: INVITE_ID,
      party_id: partyId('thursday'),
      token_hash: seedHash('invite-thursday'),
      created_by_user_id: userId('urepu'),
      role_on_join: 'member',
      label: '목요일 파티 초대',
      max_uses: 5,
      used_count: 1,
    },
  ]

  // ★ 승계 대기 상태: 승계 토큰은 있고 `claimed_by_user_id` 는 비어 있다.
  const guestProfiles: GuestProfileRow[] = GUEST_KEYS.map((key) => ({
    id: guestId(key),
    display_name: DISPLAY_NAMES[key],
    created_via_invite_id: INVITE_ID,
    claim_token_hash: seedHash(`guest-${key}`),
  }))

  const friendships: FriendshipRow[] = FRIENDSHIP_PAIRS.map(([a, b], i) => ({
    id: seedId('friendship', i + 1),
    requester_user_id: userId(a),
    addressee_user_id: userId(b),
    status: 'accepted',
    responded_at: iso(now),
  }))

  // 파티 참가자 — `(파티, 사람)` → participant id 를 나중에 찾을 수 있게 색인해 둔다.
  const participants: ParticipantRow[] = []
  const participantIndex = new Map<string, string>()
  let pSeq = 0
  for (const spec of PARTY_SPECS) {
    for (const entry of spec.roster) {
      pSeq += 1
      const id = seedId('participant', pSeq)
      const owner = personOwner(entry.person)
      participants.push({
        id,
        party_id: partyId(spec.key),
        user_id: owner.user_id,
        guest_id: owner.guest_id,
        display_name: DISPLAY_NAMES[entry.person],
        role: entry.person === spec.owner ? 'owner' : (entry.role ?? 'member'),
        character_id: isGuest(entry.person) ? null : characterId(entry.person),
        member_no: entry.memberNo,
      })
      participantIndex.set(`${spec.key}:${entry.person}`, id)
    }
  }
  const participantOf = (party: PartyKey, person: PersonKey): string => {
    const id = participantIndex.get(`${party}:${person}`)
    if (id === undefined) {
      throw new Error(`참가자를 찾을 수 없습니다: ${party} / ${person}`)
    }
    return id
  }

  const patterns: PatternRow[] = []
  let patSeq = 0
  for (const spec of PATTERN_SPECS) {
    for (const weekday of spec.weekdays) {
      patSeq += 1
      const owner = personOwner(spec.person)
      patterns.push({
        id: seedId('pattern', patSeq),
        user_id: owner.user_id,
        guest_id: owner.guest_id,
        weekday,
        start_minute: spec.start,
        end_minute: spec.end,
        note: spec.note ?? null,
      })
    }
  }

  const exceptions: ExceptionRow[] = EXCEPTION_SPECS.map((spec, i) => {
    const owner = personOwner(spec.person)
    return {
      id: seedId('exception', i + 1),
      user_id: owner.user_id,
      guest_id: owner.guest_id,
      exception_date: kstDate(start, spec.dayOffset),
      start_minute: spec.start,
      end_minute: spec.end,
      note: spec.note,
    }
  })

  const runs: RunRow[] = RUN_SPECS.map((spec) => ({
    id: runId(spec.key),
    party_id: partyId(spec.party),
    boss_difficulty_id: spec.bossDifficultyId,
    scheduled_at: iso(kstMoment(start, spec.dayOffset, spec.minute)),
    duration_minutes: spec.durationMinutes,
    status: spec.status,
    capacity: PARTY_SPECS.find((p) => p.key === spec.party)!.capacity,
    entry_party_size: spec.entryPartySize,
    share_mode: spec.shareMode,
    created_by_participant_id: participantOf(
      spec.party,
      PARTY_SPECS.find((p) => p.key === spec.party)!.owner,
    ),
    note: spec.note,
    run_no: spec.runNo,
  }))

  const signups: SignupRow[] = []
  let sSeq = 0
  for (const spec of RUN_SPECS) {
    for (const entry of spec.signups) {
      sSeq += 1
      signups.push({
        id: seedId('signup', sSeq),
        run_id: runId(spec.key),
        participant_id: participantOf(spec.party, entry.person),
        status: entry.status,
        character_id: isGuest(entry.person) ? null : characterId(entry.person),
        note: entry.note ?? null,
        // 불참자는 반드시 0 이어야 한다 (`run_signups_non_going_has_no_share`).
        share_bp: entry.status === 'going' ? (entry.shareBp ?? 0) : 0,
      })
    }
  }

  const runEnd = (key: RunKey): Date => {
    const spec = RUN_SPECS.find((r) => r.key === key)!
    return kstMoment(start, spec.dayOffset, spec.minute + spec.durationMinutes)
  }

  const bossClears: BossClearRow[] = CLEAR_SPECS.map((spec, i) => {
    const at = spec.run !== null ? runEnd(spec.run) : kstMoment(start, spec.at!.dayOffset, spec.at!.minute)
    return {
      id: seedId('bossClear', i + 1),
      user_id: userId(spec.person),
      character_id: characterId(spec.person),
      boss_difficulty_id: spec.bossDifficultyId,
      run_id: spec.run !== null ? runId(spec.run) : null,
      manual_cleared: true,
      manual_set_at: iso(at),
      api_cleared: spec.apiConflict === true ? false : null,
      // 관측 시각을 수동보다 **이르게** 두어 수동이 이기게 한다 (§난제 6).
      api_observed_at:
        spec.apiConflict === true ? iso(new Date(at.getTime() - 60 * 60 * 1000)) : null,
      cleared_at: iso(at),
      party_size: spec.partySize,
      world_name: WORLD_NAME,
      source: 'manual',
      note: spec.note ?? null,
    }
  })

  const drops: DropRow[] = []
  const dropShares: DropShareRow[] = []
  let dSeq = 0
  let dsSeq = 0
  for (const spec of DROP_SPECS) {
    dSeq += 1
    const id = seedId('drop', dSeq)
    const runSpec = RUN_SPECS.find((r) => r.key === spec.run)!
    drops.push({
      id,
      run_id: runId(spec.run),
      item_name: spec.itemName,
      sale_amount_meso: spec.saleAmountMeso,
      share_mode: spec.shareMode,
      solo_participant_id:
        spec.soloPerson !== undefined ? participantOf(runSpec.party, spec.soloPerson) : null,
      recorded_by_participant_id: participantOf(
        runSpec.party,
        PARTY_SPECS.find((p) => p.key === runSpec.party)!.owner,
      ),
      note: spec.note ?? null,
    })
    for (const share of spec.customShares ?? []) {
      dsSeq += 1
      dropShares.push({
        id: seedId('dropShare', dsSeq),
        drop_id: id,
        participant_id: participantOf(runSpec.party, share.person),
        share_bp: share.shareBp,
      })
    }
  }

  const manualRunSpec = RUN_SPECS.find((r) => r.shareMode === 'manual')!
  const manualGoing = manualRunSpec.signups.filter((s) => s.status === 'going')

  return {
    now,
    weekStart: start,
    weekKey: weekKey(start),
    appUsers,
    characters,
    parties,
    inviteLinks,
    guestProfiles,
    friendships,
    participants,
    patterns,
    exceptions,
    runs,
    signups,
    bossClears,
    drops,
    dropShares,
    manualShareRun: {
      runId: runId(manualRunSpec.key),
      participantIds: manualGoing.map((s) => participantOf(manualRunSpec.party, s.person)),
      shareBps: manualGoing.map((s) => s.shareBp ?? 0),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 검증·설명에 쓰는 파생 정보
// ─────────────────────────────────────────────────────────────────────────────

/** 사람 키 → id. 검증 스크립트가 사람을 지목할 때 쓴다. */
export const PERSON_IDS: Record<PersonKey, string> = Object.fromEntries([
  ...USER_KEYS.map((k) => [k, userId(k)] as const),
  ...GUEST_KEYS.map((k) => [k, guestId(k)] as const),
]) as Record<PersonKey, string>

export const PERSON_NAMES = DISPLAY_NAMES

export const EXCEPTION_NOTES: ReadonlyArray<{ label: string; why: string }> = EXCEPTION_SPECS.map(
  (spec) => ({
    label: `${DISPLAY_NAMES[spec.person]} · ${DAY_LABELS[spec.dayOffset]}요일 ${spec.start}~${spec.end}분`,
    why: spec.why,
  }),
)
