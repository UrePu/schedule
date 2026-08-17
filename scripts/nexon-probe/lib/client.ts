/**
 * 넥슨 오픈 API 클라이언트.
 *
 * - 키는 `x-nxopen-api-key` 헤더로만 나간다. URL 에는 절대 들어가지 않는다
 *   (URL 은 원본 파일과 요약에 그대로 기록되기 때문).
 * - 모든 호출은 `CallGovernor.acquire()` 를 통과한다.
 * - 429 / OPENAPI00007 을 만나면 즉시 governor 를 중단시키고, 이후 호출은 전부 스킵된다.
 *   재시도는 **하지 않는다** (재시도 폭주 금지).
 */
import type { CallGovernor } from './governor'
import type { CallResult, Json, PlannedCall } from './types'

export const NEXON_API_BASE = 'https://open.api.nexon.com'
export const API_KEY_HEADER = 'x-nxopen-api-key'

/** 잔여 호출량 관련으로 보이는 응답 헤더 이름 패턴 (미확인 #12 실측용) */
const RATE_LIMIT_HEADER_PATTERN = /(rate[-_]?limit|ratelimit|quota|remaining|retry-after|x-nxopen)/i

/** 429 를 나타내는 넥슨 에러 코드 */
export const ERROR_RATE_LIMITED = 'OPENAPI00007'
/** 유효하지 않은 API KEY */
export const ERROR_INVALID_KEY = 'OPENAPI00005'

function isRecord(value: Json | null): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{"error":{"name":..,"message":..}}` 형태에서 코드/메시지를 뽑는다. */
export function extractError(body: Json | null): { name: string | null; message: string | null } {
  if (!isRecord(body)) return { name: null, message: null }
  const error = body['error']
  if (!isRecord(error)) return { name: null, message: null }
  const name = typeof error['name'] === 'string' ? error['name'] : null
  const message = typeof error['message'] === 'string' ? error['message'] : null
  return { name, message }
}

export interface ClientDeps {
  readonly apiKey: string
  readonly governor: CallGovernor
  readonly fetchImpl?: typeof fetch
  readonly onCall?: (result: CallResult) => void
}

export class NexonClient {
  private readonly deps: ClientDeps
  private readonly fetchImpl: typeof fetch

  constructor(deps: ClientDeps) {
    this.deps = deps
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  get governor(): CallGovernor {
    return this.deps.governor
  }

  /** 계획된 호출 1건을 실행한다. 예산/중단 상태면 요청을 내지 않고 skipped 결과를 돌려준다. */
  async call(plan: PlannedCall): Promise<CallResult> {
    const permit = await this.deps.governor.acquire()
    if (!permit.granted) {
      const skipped = this.skippedResult(plan, permit.reason)
      this.deps.onCall?.(skipped)
      return skipped
    }

    const url = new URL(plan.path, NEXON_API_BASE)
    for (const [key, value] of Object.entries(plan.query)) url.searchParams.set(key, value)

    const startedAt = Date.now()
    let status: number | null = null
    let ok = false
    let headerNames: string[] = []
    const rateLimitHeaders: Record<string, string> = {}
    let bodyText: string | null = null
    let body: Json | null = null
    let networkError: string | null = null

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { [API_KEY_HEADER]: this.deps.apiKey, accept: 'application/json' },
      })
      status = response.status
      ok = response.ok
      response.headers.forEach((value, name) => {
        headerNames.push(name)
        if (RATE_LIMIT_HEADER_PATTERN.test(name)) rateLimitHeaders[name] = value
      })
      headerNames = headerNames.sort((a, b) => a.localeCompare(b))
      bodyText = await response.text()
      if (bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText) as Json
        } catch {
          body = null
        }
      }
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error)
    }

    const { name: errorName, message: errorMessage } = extractError(body)
    const result: CallResult = {
      label: plan.label,
      path: plan.path,
      query: plan.query,
      purpose: plan.purpose,
      status,
      ok,
      durationMs: Date.now() - startedAt,
      headerNames,
      rateLimitHeaders,
      body,
      bodyText,
      errorName,
      errorMessage,
      networkError,
      skipped: false,
      skipReason: null,
    }

    if (status === 429 || errorName === ERROR_RATE_LIMITED) {
      this.deps.governor.stop('rate-limited')
    }

    this.deps.onCall?.(result)
    return result
  }

  private skippedResult(plan: PlannedCall, reason: string): CallResult {
    return {
      label: plan.label,
      path: plan.path,
      query: plan.query,
      purpose: plan.purpose,
      status: null,
      ok: false,
      durationMs: 0,
      headerNames: [],
      rateLimitHeaders: {},
      body: null,
      bodyText: null,
      errorName: null,
      errorMessage: null,
      networkError: null,
      skipped: true,
      skipReason: reason,
    }
  }
}
