/**
 * 안전장치 — 사용자 키의 하루 할당량(개발 키 1,000건/일)을 태우지 않기 위한 코어.
 *
 * 세 가지를 강제한다.
 *  1) 초당 호출 수 스로틀 (개발 키 한도 5/초 → 기본 2/초)
 *  2) 총 호출 예산 하드 스톱 (기본 100회)
 *  3) 중단 래치 — 429(OPENAPI00007) 를 받으면 즉시 이후 호출을 전부 스킵
 *
 * 시계(`Clock`)를 주입 가능하게 만들어서, 단위 점검이 실제로 기다리지 않고
 * 스로틀 간격을 검증할 수 있게 한다.
 */

/** 개발 단계 키의 공식 한도. 하드코딩 금지 — 여기 한 곳에만 둔다. */
export const DEV_KEY_LIMIT_PER_SECOND = 5
export const DEV_KEY_LIMIT_PER_DAY = 1000

/** 기본 스로틀: 공식 한도의 절반 이하로 잡는다. */
export const DEFAULT_REQUESTS_PER_SECOND = 2
/** 기본 총 호출 예산. 하루 한도의 10%. */
export const DEFAULT_CALL_BUDGET = 100

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    }),
}

/** 테스트용 가짜 시계 — 실제로 기다리지 않고 논리 시간만 전진시킨다. */
export class FakeClock implements Clock {
  private current: number
  /** 각 sleep 호출에서 요청된 대기 시간 (검증용) */
  readonly sleeps: number[] = []

  constructor(start = 0) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
    return Promise.resolve()
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export type StopReason = 'budget-exhausted' | 'rate-limited' | 'manual'

export interface AcquireDenied {
  readonly granted: false
  readonly reason: string
}
export interface AcquireGranted {
  readonly granted: true
  readonly waitedMs: number
}
export type AcquireResult = AcquireGranted | AcquireDenied

/**
 * 스로틀 + 예산 + 중단 래치를 한 곳에서 관리한다.
 * 모든 API 호출은 반드시 `acquire()` 를 통과해야 한다.
 */
export class CallGovernor {
  readonly budget: number
  readonly requestsPerSecond: number
  private readonly clock: Clock
  private readonly minIntervalMs: number
  private lastCallAt: number | null = null
  private consumed = 0
  private stopped: StopReason | null = null

  constructor(budget: number, requestsPerSecond: number, clock: Clock = systemClock) {
    if (budget < 0) throw new RangeError('budget must be >= 0')
    if (requestsPerSecond <= 0) throw new RangeError('requestsPerSecond must be > 0')
    this.budget = budget
    this.requestsPerSecond = requestsPerSecond
    this.clock = clock
    this.minIntervalMs = Math.ceil(1000 / requestsPerSecond)
  }

  get used(): number {
    return this.consumed
  }

  get remaining(): number {
    return Math.max(0, this.budget - this.consumed)
  }

  get stopReason(): StopReason | null {
    return this.stopped
  }

  get isStopped(): boolean {
    return this.stopped !== null
  }

  /** 429 등으로 즉시 중단시킨다. 이후 모든 `acquire()` 는 거부된다. */
  stop(reason: StopReason): void {
    this.stopped ??= reason
  }

  /**
   * 호출 1건에 대한 허가를 받는다. 허가되면 예산이 1 소모되고,
   * 필요한 만큼 스로틀 대기를 수행한 뒤 반환한다.
   */
  async acquire(): Promise<AcquireResult> {
    if (this.stopped !== null) {
      return { granted: false, reason: `중단됨 (${this.stopped})` }
    }
    if (this.consumed >= this.budget) {
      this.stopped = 'budget-exhausted'
      return { granted: false, reason: `호출 예산 ${String(this.budget)}회 소진` }
    }

    let waitedMs = 0
    if (this.lastCallAt !== null) {
      const elapsed = this.clock.now() - this.lastCallAt
      const remaining = this.minIntervalMs - elapsed
      if (remaining > 0) {
        await this.clock.sleep(remaining)
        waitedMs = remaining
      }
    }
    this.lastCallAt = this.clock.now()
    this.consumed += 1
    return { granted: true, waitedMs }
  }
}
