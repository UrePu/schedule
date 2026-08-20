import { IS_DEVELOPMENT } from "@/lib/env-flags";
import type {
  PartyId,
  PersonId,
  RunId,
  TimeRange,
  WeekKey,
} from "@/types/domain";

/**
 * TanStack Query 캐시 키 규약. **이후 모든 기능이 이 파일을 경유한다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙 1 — 네임스페이스로 출처를 가른다
 * ─────────────────────────────────────────────────────────────────────────────
 * 모든 키는 `"db"` 또는 `"nexon"` 으로 시작한다.
 *
 * | 루트      | 출처                        | 캐시 정책                                  |
 * |-----------|-----------------------------|--------------------------------------------|
 * | `"db"`    | Supabase (Postgres + RLS)   | 전역 기본값 (staleTime 60초, §2)           |
 * | `"nexon"` | 넥슨 Open API (프록시 경유) | **staleTime ≥ 15분 강제** (§1.1)           |
 *
 * 섞으면 안 되는 이유는 캐시 무효화 범위다. 파티 일정을 하나 등록한 뒤
 * `invalidateQueries({ queryKey: queryKeys.db.root() })` 를 하면 DB 쪽만 날아가고
 * 비싼(=쿼터를 먹는) 넥슨 응답은 그대로 살아 있어야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙 2 — 넥슨 쿼리는 staleTime 을 15분 밑으로 내릴 수 없다 (CLAUDE.md §1.1 · §1.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 데이터는 **평균 15분 지연**된다. 그보다 자주 물어봐도 **새 데이터는 없고
 * 쿼터만 탄다**(개발 키 1,000회/일). 그래서 "권장"이 아니라 코드로 막는다.
 *
 * 넥슨 API 를 타는 쿼리는 반드시 `nexonQueryOptions(...)` 를 스프레드해서 만든다:
 *
 * ```ts
 * useQuery({
 *   ...nexonQueryOptions(queryKeys.nexon.characterList(credentialId)),
 *   queryFn: fetchCharacterList,
 * });
 * ```
 *
 * 이 헬퍼는 두 가지를 동시에 강제한다.
 * 1. 넘긴 키가 `"nexon"` 네임스페이스가 아니면 **던진다.** (키를 잘못 고른 것)
 * 2. `staleTimeMs` 를 15분 미만으로 주면 개발 중엔 **던지고**, 프로덕션에선
 *    조용히 하한으로 **올린다.** (화면을 죽이느니 쿼터를 지킨다)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙 3 — staleTime 은 **티어**에서 고른다 (CLAUDE.md §2.4 Rule 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * `session` / `db` / `nexon` 셋뿐이고, 모든 `useQuery` 는 셋 중 하나의
 * 헬퍼를 스프레드한다(`sessionQueryOptions` · `dbQueryOptions` · `nexonQueryOptions`). 그래서 **쿼리를 읽으면 그 데이터가
 * 어떤 성격인지 한 줄로 드러난다.** 숫자를 손으로 적는 자리는 이 파일 밖에 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규칙 4 — 키는 **전부 이 파일**에 있다 (CLAUDE.md §2.4 Rule 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출부에 배열 리터럴(`["db","characters"]`)을 적으면 팩토리 모양이 바뀌는 날 조용히
 * 매칭이 끊긴다. 실제로 `auth-queries.ts` 두 곳이 그 상태였다. 검증은 한 줄이다:
 * `grep -rn "queryKey: \[" src` 의 결과가 **0건**이어야 한다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 키 직렬화 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 사람 id 목록을 캐시 키용 문자열로 만든다.
 *
 * **정렬한다.** 선택 순서가 달라도 겹침 결과는 같은데, 배열을 그대로 키에 넣으면
 * `[a,b]` 와 `[b,a]` 가 서로 다른 캐시가 되어 같은 답을 두 번 계산한다.
 * (DB 쪽 `p_person_ids uuid[]` 도 순서에 의존하지 않는다.)
 */
export function personScope(personIds: readonly PersonId[]): string {
  return [...personIds].sort().join(",");
}

/** 조회 구간을 캐시 키용 문자열로. 밀리초까지 포함해야 경계가 어긋나지 않는다. */
export function rangeScope(range: TimeRange): string {
  return `${range.from.toISOString()}~${range.to.toISOString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 키 팩토리
// ─────────────────────────────────────────────────────────────────────────────

export const queryKeys = {
  /** Supabase(Postgres) 에서 오는 모든 것. */
  db: {
    root: () => ["db"] as const,

    /**
     * → `/api/auth/*` (세션 · 등록된 키 · 오늘 쓴 호출량)
     *
     * ★ **넥슨이 아니라 우리 DB 다.** `/api/auth/me` 도 `/api/nexon/quota` 도 넥슨을
     *   부르지 않는다(넥슨에는 잔여량 헤더 자체가 없다 — §1.0). 그래서 `"db"` 이고
     *   15분 하한의 대상이 아니다.
     *
     * ★ 예전에는 `features/auth/data/auth-queries.ts` 안에 `authQueryKeys` 라는 두 번째
     *   팩토리가 있었다. 키가 두 곳에 살면 한쪽만 바뀌는 날이 오므로 여기로 합쳤다
     *   (§2.4 Rule 5). 그쪽 이름은 이 값을 가리키는 별칭으로만 남는다.
     */
    auth: {
      root: () => ["db", "auth"] as const,
      /** "지금 누가 보고 있는가". 계정 상태가 화면 전체를 가른다 → 세션 티어. */
      session: () => ["db", "auth", "session"] as const,
      /** 오늘 쓴 넥슨 호출량 장부. **우리 DB** 를 읽는다. */
      quota: () => ["db", "auth", "quota"] as const,
      credentials: () => ["db", "auth", "credentials"] as const,
    },

    /**
     * → `GET /api/dashboard?weekKey=…` — 대시보드 한 화면분(수익 · 파티 · 체크리스트 ·
     *   주간 보스 칸).
     *
     * ★ **한 쿼리인 것이 중요하다.** 수익 합계 · 12칸 분모 · 파티 건수는 같은 원장에서
     *   한 번에 나온 값이라, 조각으로 나눠 받으면 화면이 잠깐 서로 어긋난 숫자를 말한다
     *   (수익 화면이 mutation 응답을 통째로 얹는 것과 같은 판단).
     */
    dashboard: {
      root: () => ["db", "dashboard"] as const,
      summary: (weekKey: WeekKey) =>
        ["db", "dashboard", "summary", weekKey] as const,
    },

    /** → `resolve_availability` / `availability_overlap` / `availability_exceptions` */
    availability: {
      root: () => ["db", "availability"] as const,
      /**
       * → `GET /api/schedule/availability?kind=board&…` → `public.availability_board(…)`
       *
       * **겹쳐보기 화면 한 벌** — 개인 구간 · 겹침 창 · 예외 · 런 점유가 한 응답에 온다.
       *
       * ★ **한 쿼리인 것이 중요하다.** 넷은 같은 사람 집합 · 같은 구간의 **한 시점 스냅샷**
       *   이라, 조각으로 나눠 받으면 화면이 잠깐 서로 어긋난 시간표를 그린다(대시보드
       *   `summary` 와 같은 판단). 왕복도 4 → 1 로 줄어든다.
       * ⚠️ `minCount` 와 `excludeRunId` 가 키에 들어간다 — 그 값이 달라지면 **겹침 창이
       *    달라지기 때문**이다. 기본값 `null` 은 `"none"` 으로 직렬화해 서버 prefetch 키와
       *    정확히 맞춘다(아래 `overlap` 과 같은 규약).
       */
      board: (
        personIds: readonly PersonId[],
        range: TimeRange,
        minCount: number,
        excludeRunId: RunId | null = null,
      ) =>
        [
          "db",
          "availability",
          "board",
          personScope(personIds),
          rangeScope(range),
          minCount,
          excludeRunId ?? "none",
        ] as const,
      /** → `public.resolve_availability(p_person_ids, p_from, p_to)` */
      resolve: (personIds: readonly PersonId[], range: TimeRange) =>
        [
          "db",
          "availability",
          "resolve",
          personScope(personIds),
          rangeScope(range),
        ] as const,
      /**
       * → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count[, p_exclude_run_id])`
       *
       * ⚠️ `excludeRunId` 가 키에 들어간다. 그 값이 달라지면 **답이 달라지기 때문**이다 —
       *    수정 중인 런을 제외한 겹침과 제외하지 않은 겹침은 서로 다른 시간표다.
       *    기본값 `null` 은 `"none"` 으로 직렬화해 서버 prefetch 키와 정확히 맞춘다.
       */
      overlap: (
        personIds: readonly PersonId[],
        range: TimeRange,
        minCount: number,
        excludeRunId: RunId | null = null,
      ) =>
        [
          "db",
          "availability",
          "overlap",
          personScope(personIds),
          rangeScope(range),
          minCount,
          excludeRunId ?? "none",
        ] as const,
      /**
       * → `public.person_run_commitments(p_person_ids, p_from, p_to, p_exclude_run_id)`
       *
       * **이미 등록된 런이 잡아먹은 시간.** `availability` 접두사 아래 있는 것이 중요하다 —
       * 일정을 등록·수정·삭제하면 겹침(`overlap`)과 이 목록이 **함께** 달라지므로,
       * 무효화는 언제나 `availability.root()` 하나로 넷을 동시에 날린다.
       */
      commitments: (
        personIds: readonly PersonId[],
        range: TimeRange,
        excludeRunId: RunId | null = null,
      ) =>
        [
          "db",
          "availability",
          "commitments",
          personScope(personIds),
          rangeScope(range),
          excludeRunId ?? "none",
        ] as const,
      /** → `select * from public.availability_exceptions where ...` */
      exceptions: (personIds: readonly PersonId[], range: TimeRange) =>
        [
          "db",
          "availability",
          "exceptions",
          personScope(personIds),
          rangeScope(range),
        ] as const,
      /**
       * → `GET /api/schedule/availability/patterns` (내 요일별 반복 패턴 **원본**)
       *
       * ⚠️ 인자가 없다. 대상이 **언제나 세션 본인**이라 사람별로 캐시를 가를 이유가 없고,
       *    로그아웃 시 캐시가 통째로 버려지므로 남의 값이 남을 여지도 없다
       *    (`income.detail` 과 같은 이유).
       *
       * ★ 이 키가 `availability` 아래 있는 것이 중요하다. 패턴을 저장하면 겹쳐보기
       *   (`resolve`)와 겹침 질의(`overlap`)의 답이 **함께** 바뀌므로, 무효화는 언제나
       *   `queryKeys.db.availability.root()` 한 번으로 셋을 동시에 날린다.
       */
      myPatterns: () => ["db", "availability", "myPatterns"] as const,
    },

    /**
     * → `GET /api/friends` — 친구 · 받은 신청 · 보낸 신청 · 내 검색 설정.
     *
     * ★ **키가 하나뿐이다.** 세 목록이 한 응답으로 오고 조작마다 서버가 전부를 다시 내려
     *   주므로, 목록별 키를 두면 같은 사실을 두 자리에 캐시하게 된다.
     */
    friends: {
      root: () => ["db", "friends"] as const,
      overview: () => ["db", "friends", "overview"] as const,
      /** 검색은 질의어마다 다른 답이라 키에 질의어가 들어간다. */
      search: (query: string) => ["db", "friends", "search", query] as const,
    },

    /** → `parties` / `party_participants` */
    party: {
      root: () => ["db", "party"] as const,
      /** → **볼 수 있는** 파티 목록(내 파티 + 남의 공개 파티). 파티는 여러 개다. */
      list: () => ["db", "party", "list"] as const,
      /**
       * → `GET /api/schedule/parties/mine?weekKey=…` — **내가 속한 파티만.**
       *
       * `list()` 와 의도적으로 다르다. 일정 등록은 파티 구성원만 할 수 있어서(서버가
       * 403) 남의 공개 파티는 후보가 아니다. `weekKey` 가 키에 있는 이유는 응답에
       * **그 주 일정 건수**가 실리기 때문이다 — 주차가 바뀌면 다른 답이다.
       */
      mine: (weekKey: WeekKey) => ["db", "party", "mine", weekKey] as const,
      detail: (partyId: PartyId) => ["db", "party", "detail", partyId] as const,
      /** ⚠️ 구성원과 번호는 **파티 단위**라 키에 partyId 가 반드시 들어간다. */
      members: (partyId: PartyId) =>
        ["db", "party", "members", partyId] as const,
      /**
       * → `GET /api/schedule/parties/{partyId}/shares` — 이 파티의 분배 설정.
       *
       * ⚠️ **`members` 와 같은 키를 쓰지 않는다.** 비율은 정산 값이라 세션 + 파티 구성원
       *    조건이 붙고(공개 시간표에는 실리지 않는다), 응답 모양도 다르다. 한 키에
       *    담으면 로그인 상태에 따라 같은 키가 다른 모양을 갖게 된다.
       */
      shares: (partyId: PartyId) =>
        ["db", "party", "shares", partyId] as const,
      /**
       * → `party_bosses` — 이 파티가 묶어서 도는 보스 목록.
       *
       * ★ `party` 접두사 아래 있는 것이 중요하다. 보스 목록을 저장하면 `name_is_custom`
       *   이 false 인 파티의 **제목이 함께 바뀌므로**(`익세 하대 하카 2인`), 무효화는
       *   `queryKeys.db.party.root()` 한 번으로 목록·보스·구성원을 동시에 날린다.
       */
      bosses: (partyId: PartyId) =>
        ["db", "party", "bosses", partyId] as const,
    },

    /** → 파티에 넣을 수 있는 사람 후보 (`friendships` + `guest_profiles`) */
    people: {
      root: () => ["db", "people"] as const,
      pool: () => ["db", "people", "pool"] as const,
    },

    /** → `party_runs` (+ `run_signups`) */
    runs: {
      root: () => ["db", "runs"] as const,
      list: (partyId: PartyId, weekKey: WeekKey) =>
        ["db", "runs", "list", partyId, weekKey] as const,
      detail: (runId: RunId) => ["db", "runs", "detail", runId] as const,
      /** → 뷰 `v_run_participation` */
      participation: (runId: RunId) =>
        ["db", "runs", "participation", runId] as const,
    },

    /*
      ★ `bosses` 키는 **없앴다** (2026-08-18). 보스 마스터는 더 이상 쿼리가 아니라
        코드 상수(`@/lib/boss-master`)다 — 시드 마이그레이션에서 생성되고 게임 패치
        때만 바뀐다. 캐시에 넣을 것이 없으므로 키도, `bossMaster` 티어도 필요 없다.
        ⚠️ CLAUDE.md §2.4 Rule 4 의 티어 표에는 `bossMaster` 행이 아직 남아 있다.
           문서 갱신은 컨덕터 몫이다(이 파일에서 문서를 고치지 않는다).
    */

    /** → 뷰 `v_weekly_income` / `v_weekly_crystal_income` */
    income: {
      root: () => ["db", "income"] as const,
      weekly: (userId: string, weekKey: WeekKey) =>
        ["db", "income", "weekly", userId, weekKey] as const,
      /**
       * → `GET /api/income?weekKey=...` (주간 수익 상세 화면 전체)
       *
       * ⚠️ 키에 `userId` 가 없다. 세션 쿠키가 곧 사용자이고 응답은 **언제나 본인 것**이라
       *    브라우저 캐시를 사람별로 가를 이유가 없다. 로그아웃 시 캐시가 통째로 버려지므로
       *    다른 사람의 값이 남을 여지도 없다.
       */
      detail: (weekKey: WeekKey) =>
        ["db", "income", "detail", weekKey] as const,
      /**
       * → `GET /api/income/ledger?from=…&to=…` (달력 + 주차별 내역)
       *
       * ★ **캘린더와 주차 목록이 같은 키를 쓴다.** 둘 다 "주차 범위의 원장"을 보므로
       *   범위가 같으면 캐시도 같아야 한다 — 나누면 같은 데이터를 두 번 받고, 한쪽만
       *   갱신되는 순간 달력과 목록이 서로 다른 숫자를 말한다.
       *
       * ⚠️ `income.root()` 아래에 있으므로 클리어 수정·체크가 무효화하는 범위에 자동으로
       *    들어간다(`invalidateQueries({ queryKey: queryKeys.db.income.root() })`).
       */
      ledger: (fromWeekKey: WeekKey, toWeekKey: WeekKey) =>
        ["db", "income", "ledger", fromWeekKey, toWeekKey] as const,
      /**
       * 원장 전체 무효화용 접두사. 클리어를 고치면 **보고 있던 범위 하나만이 아니라**
       * 열려 있는 모든 범위(달력의 이전 달, 주차 목록의 과거 페이지)가 낡는다.
       *
       * ★ 호출부에 `["db","income","ledger"]` 를 직접 적지 않기 위한 것이다(§2.4 Rule 5) —
       *   배열 리터럴은 팩토리 모양이 바뀌는 날 조용히 매칭이 끊긴다.
       */
      ledgerRoot: () => ["db", "income", "ledger"] as const,
    },

    /**
     * → `public.characters`
     *
     * ★ **넥슨이 아니라 우리 DB 다.** 목록의 진실은 로그인 때 이미 채워진
     *   `characters` 테이블이고(§2.1.1), 이 키로 나가는 요청은 넥슨을 한 번도 부르지
     *   않는다. 그래서 `"nexon"` 이 아니라 `"db"` 이고 15분 하한의 대상이 아니다.
     */
    characters: {
      root: () => ["db", "characters"] as const,
      /**
       * → `GET /api/characters` — 캐릭터 선택 모달이 쓰는 **보유 캐릭터 전체**.
       *
       * 사용자당 하나뿐이라 인자가 없다. 예전에는 `features/characters/data` 안에
       * `characterQueryKeys` 라는 두 번째 팩토리가 이 값을 갖고 있었다(§2.4 Rule 5 로
       * 여기로 합쳤다). 그쪽 이름은 별칭으로만 남는다.
       */
      list: () => ["db", "characters", "list"] as const,
      /** 일정에 데려갈 수 있는 내 추적 캐릭터. 사용자당 하나뿐이라 인자가 없다. */
      forRuns: () => ["db", "characters", "forRuns"] as const,
    },

    /**
     * → `character_boss_plans` + 뷰 `v_character_boss_plan_status`
     *   · `v_character_weekly_boss_progress` · `character_scheduler_snapshots`
     *
     * ⚠️ 동기화(`POST /api/boss-plans/sync`)는 넥슨을 타지만 **캐시 대상이 아니다** —
     *    사용자가 버튼을 눌렀을 때만 나가는 mutation 이라 staleTime 개념이 없다.
     *    그 결과를 담는 **이 조회들은 우리 DB** 를 읽으므로 `"db"` 가 맞다.
     */
    bossPlans: {
      root: () => ["db", "bossPlans"] as const,
      /** 캐릭터 하나의 계획 + 이번 주 진행 상황. */
      character: (characterId: string) =>
        ["db", "bossPlans", "character", characterId] as const,
      /** 대시보드용 — 추적 캐릭터 전원의 주간 체크리스트. */
      checklist: () => ["db", "bossPlans", "checklist"] as const,
    },

    /**
     * → `GET /api/bot/setup` — 내가 관여하는 방 + 내 파티의 알림 목적지.
     *
     * ★ **발급된 연결 코드는 키가 없다.** 원문 코드는 서버에 남지 않아 다시 읽을 수
     *   없으므로 캐시할 대상 자체가 없다(초대 토큰과 같은 이유). 발급은 mutation 이고,
     *   그 결과는 화면이 한 번만 들고 있는다.
     */
    bot: {
      root: () => ["db", "bot"] as const,
      setup: () => ["db", "bot", "setup"] as const,
    },
  },

  /**
   * 넥슨 Open API 프록시(`/api/nexon/*`) 에서 오는 모든 것.
   * 이 아래 키를 쓰는 쿼리는 **반드시** `nexonQueryOptions()` 를 함께 쓴다.
   */
  nexon: {
    root: () => ["nexon"] as const,
    /** → `GET /maplestory/v1/character/list` (키 유효성 + 보유 캐릭터) */
    characterList: (credentialId: string) =>
      ["nexon", "characterList", credentialId] as const,
    /**
     * → `GET /maplestory/v1/character/basic` 의 `character_image` (**캐릭터당 1콜**)
     *
     * 캐릭터 단위 키인 것이 중요하다. 목록 단위로 캐싱하면 화면에 보이는 12명만
     * 받아 온다는 §2.1.1 의 절약이 통째로 무너진다.
     */
    characterPortrait: (ocid: string) =>
      ["nexon", "characterPortrait", ocid] as const,
    /** → `GET /maplestory/v1/scheduler/character-state` */
    schedulerState: (characterId: string, dayKey: string) =>
      ["nexon", "schedulerState", characterId, dayKey] as const,
    /** → `GET /maplestory/v1/guild/basic` (다른 플레이어를 찾는 유일한 공개 경로) */
    guildMembers: (worldName: string, guildName: string) =>
      ["nexon", "guildMembers", worldName, guildName] as const,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 넥슨 쿼리 정책 — staleTime 하한을 코드로 강제한다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 넥슨 API 쿼리의 **staleTime 하한: 15분** (CLAUDE.md §1.1).
 *
 * 근거: 넥슨 데이터는 약 15분 지연되고 전날 데이터는 다음날 02:00 KST 에 확정된다.
 * 15분보다 자주 물으면 **같은 값을 다시 받으면서 쿼터만 소모**한다
 * (개발 키 1,000회/일 · 5회/초).
 */
export const NEXON_MIN_STALE_TIME_MS = 15 * 60 * 1000;

/** 넥슨 응답은 비싸므로 stale 이 된 뒤에도 한동안 메모리에 남겨 둔다. */
const NEXON_DEFAULT_GC_TIME_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// staleTime 티어 (CLAUDE.md §2.4 Rule 4) — **모든 쿼리가 여기서 하나를 고른다**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 세 개뿐이다. 쿼리마다 숫자를 손으로 적으면 같은 성격의 데이터가 화면마다 다른 주기로
 * 갱신되고, 그 차이는 코드를 읽어서는 보이지 않는다. 그래서 값이 아니라 **티어**를 고른다.
 *
 * | 티어         | staleTime | 근거                                                        |
 * |--------------|-----------|-------------------------------------------------------------|
 * | `session`    | 30초      | 계정 상태가 화면 전체를 가른다. 틀린 값의 대가가 가장 크다. |
 * | `db`         | 60초      | 우리 DB 의 가변 데이터. 신선도는 **뮤테이션 후 무효화**가 진다. |
 *
 * ★ 예전에는 `bossMaster`(6시간) 티어가 하나 더 있었다. 보스 마스터가 쿼리에서
 *   **코드 상수**로 내려가면서(`@/lib/boss-master`) 그 티어를 쓰는 쿼리가 0개가 되어
 *   지웠다 — 쓰이지 않는 티어를 남겨 두면 다음 사람이 그것을 살아 있는 선택지로 읽는다.
 * | `nexon`      | 15분      | 상류가 ~15분 지연(§1.1). 더 자주 물으면 같은 값 + 쿼터 소모.  |
 */
export const STALE_TIME = {
  session: 30 * 1000,
  db: 60 * 1000,
  nexon: NEXON_MIN_STALE_TIME_MS,
} as const;

export type StaleTimeTier = keyof typeof STALE_TIME;

export interface DbQueryOptions<K extends DbQueryKey> {
  readonly queryKey: K;
  readonly staleTime: number;
}

/**
 * `"db"` 네임스페이스 쿼리의 옵션을 만든다. `queryFn` 만 붙여 쓴다.
 *
 * `nexonQueryOptions` 와 대칭이며 같은 이유로 **네임스페이스를 검사한다** — 넥슨 키에
 * 60초를 붙이면 15분 하한이 조용히 뚫린다.
 */
function tieredDbOptions<K extends DbQueryKey>(
  tier: Exclude<StaleTimeTier, "nexon">,
  queryKey: K,
): DbQueryOptions<K> {
  if (queryKey[0] !== "db") {
    throw new Error(
      `[query-keys] "${tier}" 티어는 "db" 네임스페이스 키에만 쓸 수 있습니다. ` +
        `넥슨 키에는 nexonQueryOptions() 를 쓰세요. 받은 키: ${JSON.stringify(queryKey)}`,
    );
  }
  return { queryKey, staleTime: STALE_TIME[tier] };
}

/** 우리 DB 의 **가변** 데이터(파티 · 계획 · 가용시간 · 수익). 기본 티어다. */
export function dbQueryOptions<K extends DbQueryKey>(
  queryKey: K,
): DbQueryOptions<K> {
  return tieredDbOptions("db", queryKey);
}

/** 세션 · 계정 상태. 화면 전체를 가르는 값이라 가장 짧게 본다. */
export function sessionQueryOptions<K extends DbQueryKey>(
  queryKey: K,
): DbQueryOptions<K> {
  return tieredDbOptions("session", queryKey);
}

/** `queryKeys.nexon.*` 가 만들어 내는 키의 모양. 루트가 `"nexon"` 으로 고정된다. */
export type NexonQueryKey = readonly ["nexon", ...unknown[]];

/** `queryKeys.db.*` 가 만들어 내는 키의 모양. */
export type DbQueryKey = readonly ["db", ...unknown[]];

export interface NexonQueryOptions<K extends NexonQueryKey> {
  readonly queryKey: K;
  readonly staleTime: number;
  readonly gcTime: number;
  readonly refetchOnWindowFocus: false;
  readonly refetchOnMount: false;
  readonly retry: number;
}

/**
 * 넥슨 API 를 타는 `useQuery` 의 옵션을 만든다. `queryFn` 만 붙여 쓰면 된다.
 *
 * 실수를 두 군데서 막는다:
 * - **네임스페이스**: `"nexon"` 으로 시작하지 않는 키를 주면 던진다. 넥슨 정책을
 *   DB 쿼리에 잘못 붙이면 60초여야 할 데이터가 15분간 갱신되지 않는다.
 * - **staleTime**: 15분 미만을 주면 개발 중엔 던지고, 프로덕션에선 하한으로 올린다.
 *   프로덕션에서 던지지 않는 이유는, 이미 배포된 화면을 죽이는 것보다
 *   쿼터를 지키며 계속 보여 주는 쪽이 낫기 때문이다.
 */
export function nexonQueryOptions<K extends NexonQueryKey>(
  queryKey: K,
  options?: { readonly staleTimeMs?: number; readonly gcTimeMs?: number },
): NexonQueryOptions<K> {
  if (queryKey[0] !== "nexon") {
    throw new Error(
      `[query-keys] nexonQueryOptions 는 "nexon" 네임스페이스 키에만 쓸 수 있습니다. ` +
        `받은 키: ${JSON.stringify(queryKey)}`,
    );
  }

  const requested = options?.staleTimeMs ?? NEXON_MIN_STALE_TIME_MS;

  if (requested < NEXON_MIN_STALE_TIME_MS) {
    const message =
      `[query-keys] 넥슨 API 쿼리의 staleTime 은 ${NEXON_MIN_STALE_TIME_MS}ms(15분) 이상이어야 합니다 ` +
      `(CLAUDE.md §1.1 — 데이터가 15분 지연되므로 더 자주 물어도 새 값이 없습니다). ` +
      `받은 값: ${requested}ms · 키: ${JSON.stringify(queryKey)}`;

    // 개발에서는 즉시 터뜨려 알아채게 하고, 그 밖에서는 하한으로 올려 계속 돌린다.
    // 게이트가 fail-closed 라 환경이 불확실하면 "던지지 않는" 쪽으로 실패한다.
    if (IS_DEVELOPMENT) {
      throw new Error(message);
    }
    console.warn(message);
  }

  return {
    queryKey,
    staleTime: Math.max(requested, NEXON_MIN_STALE_TIME_MS),
    gcTime: Math.max(
      options?.gcTimeMs ?? NEXON_DEFAULT_GC_TIME_MS,
      NEXON_MIN_STALE_TIME_MS,
    ),
    // 탭 전환·재마운트마다 쿼터를 태우지 않는다.
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: 1,
  };
}
