/**
 * 시드 데이터 식별 — **고정 UUID 대역**.
 *
 * 이 스크립트가 만든 행은 전부 `5eed` 로 시작하고 `5eed5eed5eed` 로 끝나는 UUID 를 갖는다.
 * 삭제는 **이 파일이 생성한 id 목록에 대해서만** 수행되므로, 시드가 아닌 행에는
 * 어떤 경우에도 손이 닿지 않는다. (`like '5eed%'` 스캔은 감사용 보조 수단일 뿐
 * 실제 삭제 경로가 아니다 — 우연히 같은 대역을 쓰는 실사용자 행을 지우지 않기 위해서다.)
 *
 * 형식:  `5eed<KKKK>-<NNNN>-4000-8000-5eed5eed5eed`
 *          └ 종류 코드   └ 순번(16진)  └ v4/variant 니블 (형식상 유효한 UUID 유지)
 */

/** 모든 시드 UUID 의 접두 4자리. */
export const SEED_UUID_PREFIX = '5eed'

/** 모든 시드 UUID 의 마지막 그룹. */
export const SEED_UUID_SUFFIX = '5eed5eed5eed'

/** 종류별 코드. **한 번 정한 값은 바꾸지 않는다** — 바꾸면 이전 시드 행이 고아가 된다. */
const KIND_CODES = {
  appUser: '0001',
  guest: '0002',
  character: '0003',
  party: '0004',
  participant: '0005',
  run: '0006',
  signup: '0007',
  pattern: '0008',
  exception: '0009',
  bossClear: '000a',
  drop: '000b',
  dropShare: '000c',
  friendship: '000d',
  invite: '000e',
} as const

export type SeedKind = keyof typeof KIND_CODES

/** 순번은 1부터. 종류당 최대 65,535개(4 hex)까지 표현된다. */
export function seedId(kind: SeedKind, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 0xffff) {
    throw new Error(`seedId: 순번은 1~65535 정수여야 합니다 (kind=${kind}, index=${index}).`)
  }
  const code = KIND_CODES[kind]
  const seq = index.toString(16).padStart(4, '0')
  return `${SEED_UUID_PREFIX}${code}-${seq}-4000-8000-${SEED_UUID_SUFFIX}`
}

/** 감사용. 이 문자열이 시드 대역에 속하는지. */
export function isSeedId(id: string): boolean {
  return id.startsWith(SEED_UUID_PREFIX) && id.endsWith(SEED_UUID_SUFFIX)
}

/**
 * 해시 자리표시자. **실제 해시가 아니다.**
 * `guest_profiles.claim_token_hash` 는 `^[0-9a-f]{64}$` 를 요구하므로 형식만 맞춘다.
 * 앞 8자리를 `5eed...` 로 고정해 시드 산출물임을 눈으로 알아볼 수 있게 했다.
 */
export function seedHash(label: string): string {
  const body = Array.from(label)
    .map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0'))
    .join('')
  return (SEED_UUID_PREFIX + SEED_UUID_SUFFIX + body).padEnd(64, '0').slice(0, 64)
}
