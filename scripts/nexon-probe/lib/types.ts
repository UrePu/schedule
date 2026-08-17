/** 도구 전역에서 공유하는 타입. `any` 는 쓰지 않는다. */

/** JSON 으로 직렬화 가능한 값 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** 실행 모드 */
export type RunMode = 'dry-run' | 'live' | 'spec-only' | 'selftest' | 'no-key'

/** 한 번의 HTTP 호출 계획 */
export interface PlannedCall {
  /** 요약/원본 파일에서 이 호출을 식별하는 안정적 라벨 */
  readonly label: string
  readonly path: string
  /** 값이 실행 시점에 정해지는 파라미터는 `<...>` 플레이스홀더로 둔다 */
  readonly query: Readonly<Record<string, string>>
  /** 이 호출이 어떤 미확인 항목을 겨냥하는지 (사람이 읽는 설명) */
  readonly purpose: string
}

/** 실제 호출 결과 */
export interface CallResult {
  readonly label: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly purpose: string
  readonly status: number | null
  readonly ok: boolean
  readonly durationMs: number
  readonly headerNames: readonly string[]
  readonly rateLimitHeaders: Readonly<Record<string, string>>
  readonly body: Json | null
  readonly bodyText: string | null
  readonly errorName: string | null
  readonly errorMessage: string | null
  readonly networkError: string | null
  readonly skipped: boolean
  readonly skipReason: string | null
}

/** 넥슨 문서 페이지 `__NEXT_DATA__` 에서 뽑아낸 스펙 파일 메타 */
export interface SpecFileMeta {
  readonly id: number
  readonly categoryName: string
  readonly fileName: string
  readonly fileUrl: string
}

/** 다운로드까지 마친 스펙 파일 */
export interface SpecFile extends SpecFileMeta {
  readonly sha256: string
  readonly bytes: number
  readonly parsed: boolean
  readonly parseError: string | null
}

/** 스펙에서 평탄화한 필드 하나 */
export interface SpecField {
  /** `boss_contents[].difficulty` 형태 */
  readonly path: string
  /** OpenAPI `type` (string / number / array / object …) */
  readonly type: string
  readonly format: string | null
}

/** 스펙 ↔ 실제 응답 대조 결과 */
export interface SpecComparison {
  readonly endpointLabel: string
  readonly apiPath: string
  readonly specFileName: string | null
  readonly schemaName: string | null
  /** 스펙에 있는데 응답에 없는 필드 */
  readonly missingInResponse: readonly string[]
  /** 응답에 있는데 스펙에 없는 필드 */
  readonly extraInResponse: readonly string[]
  /** 타입 불일치 */
  readonly typeMismatch: readonly { path: string; spec: string; observed: string }[]
  readonly note: string | null
}

/** 미확인 항목 1건의 해소 상태 */
export type UnknownStatus = 'answered' | 'partial' | 'unanswered'

export interface UnknownFinding {
  /** 조사 문서의 번호와 맞춘 식별자 (예: `NEXON-API#1`) */
  readonly id: string
  readonly question: string
  readonly status: UnknownStatus
  /** 실측으로 채운 답 (없으면 왜 못 채웠는지) */
  readonly answer: string
}

/** 스케줄러 응답에서 뽑아낸 관측치 */
export interface Observations {
  /** `account_list` 길이 — 미확인 #13 (복수 계정 반환 조건) */
  readonly accountCount: number
  readonly accountIdsMasked: readonly string[]
  readonly characterCount: number
  readonly charactersPerAccount: readonly number[]
  readonly worlds: readonly string[]
  /** 스케줄러 응답을 실제로 받은 캐릭터 수 */
  readonly schedulerCharacters: number
  /** 응답이 비어 있던(미접속 추정) 캐릭터 수 */
  readonly schedulerEmpty: number
  readonly bossDifficulties: readonly string[]
  readonly bossCycles: readonly string[]
  readonly bossContentNames: readonly string[]
  readonly bossEntryCount: number
  readonly dailyContentNames: readonly string[]
  readonly dailyTypes: readonly string[]
  readonly dailyQuestStates: readonly string[]
  readonly weeklyContentNames: readonly string[]
  readonly weeklyTypes: readonly string[]
  readonly weeklyQuestStates: readonly string[]
  readonly weeklyBossClearCounts: readonly number[]
  readonly weeklyBossClearLimitCounts: readonly number[]
  /** 플래그 필드의 런타임 타입과 실제 값 집합 — 미확인: "true"/"false" 문자열인가 불리언인가 */
  readonly flagKinds: readonly FlagKind[]
  /** 응답 `date` 필드 vs 호출 시각 — 데이터 지연 실측 */
  readonly dateLag: readonly DateLag[]
  /** `date` 소급 조회 가능 범위 실측 */
  readonly dateBackfill: readonly DateBackfillResult[]
  /** 응답 헤더 전량(이름만) + rate limit 관련으로 보이는 헤더 */
  readonly responseHeaderNames: readonly string[]
  readonly rateLimitHeaders: Readonly<Record<string, string>>
  /** 에러 상황별 실측 (HTTP status + error.name) */
  readonly errorProbes: readonly ErrorProbeResult[]
}

export interface FlagKind {
  readonly field: string
  readonly jsTypes: readonly string[]
  readonly values: readonly string[]
}

export interface DateLag {
  readonly characterMasked: string
  readonly responseDate: string | null
  readonly observedAt: string
  readonly lagHours: number | null
}

export interface DateBackfillResult {
  readonly date: string
  readonly daysAgo: number | null
  readonly status: number | null
  readonly errorName: string | null
  readonly hasPayload: boolean
}

export interface ErrorProbeResult {
  readonly label: string
  readonly description: string
  readonly httpStatus: number | null
  readonly errorName: string | null
  readonly errorMessage: string | null
  readonly note: string | null
}

/** 관측 요약 — `latest.json` 의 본문이자 드리프트 비교 대상 */
export interface Summary {
  readonly schemaVersion: number
  readonly runId: string
  readonly generatedAt: string
  readonly mode: RunMode
  readonly tool: {
    readonly maxPlannedCalls: number
    readonly executedCalls: number
    readonly budget: number
    readonly rps: number
    readonly abortedReason: string | null
  }
  readonly key: { readonly present: boolean; readonly valid: boolean | null; readonly source: string | null }
  readonly spec: { readonly indexUrl: string; readonly files: readonly SpecFile[] }
  readonly calls: readonly CallDigest[]
  readonly observations: Observations | null
  readonly specComparison: readonly SpecComparison[]
  readonly unknowns: readonly UnknownFinding[]
}

/** 요약본에 남기는 호출 1건의 축약형 (본문은 raw/ 에만 남는다) */
export interface CallDigest {
  readonly label: string
  readonly path: string
  readonly status: number | null
  readonly errorName: string | null
  readonly skipped: boolean
  readonly skipReason: string | null
}
