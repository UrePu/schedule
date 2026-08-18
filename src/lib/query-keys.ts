import { IS_DEVELOPMENT } from "@/lib/env-flags";
import type {
  BossDifficultyId,
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
 * 반대로 Supabase 쿼리는 전역 기본값을 그대로 쓰므로 별도 헬퍼가 없다 —
 * 헬퍼가 필요 없다는 사실 자체가 "이건 넥슨이 아니다"라는 신호다.
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

    /** → `resolve_availability` / `availability_overlap` / `availability_exceptions` */
    availability: {
      root: () => ["db", "availability"] as const,
      /** → `public.resolve_availability(p_person_ids, p_from, p_to)` */
      resolve: (personIds: readonly PersonId[], range: TimeRange) =>
        [
          "db",
          "availability",
          "resolve",
          personScope(personIds),
          rangeScope(range),
        ] as const,
      /** → `public.availability_overlap(p_person_ids, p_from, p_to, p_min_count)` */
      overlap: (
        personIds: readonly PersonId[],
        range: TimeRange,
        minCount: number,
      ) =>
        [
          "db",
          "availability",
          "overlap",
          personScope(personIds),
          rangeScope(range),
          minCount,
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

    /** → `parties` / `party_participants` */
    party: {
      root: () => ["db", "party"] as const,
      /** → 내가 속한 파티 목록. 파티는 여러 개다(보스마다 조합이 다르다). */
      list: () => ["db", "party", "list"] as const,
      detail: (partyId: PartyId) => ["db", "party", "detail", partyId] as const,
      /** ⚠️ 구성원과 번호는 **파티 단위**라 키에 partyId 가 반드시 들어간다. */
      members: (partyId: PartyId) =>
        ["db", "party", "members", partyId] as const,
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

    /** → 뷰 `v_boss_catalog` (+ `boss_aliases`) */
    bosses: {
      root: () => ["db", "bosses"] as const,
      catalog: () => ["db", "bosses", "catalog"] as const,
      detail: (bossDifficultyId: BossDifficultyId) =>
        ["db", "bosses", "detail", bossDifficultyId] as const,
    },

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
