/**
 * 탐침 계획.
 *
 * `/character/list` 로 시작한다 — 파라미터 없이 키만으로 계정 + 캐릭터를 한 번에 얻는 유일한 진입점.
 * 그 뒤 캐릭터별 basic / scheduler, 에러 형태 탐침, date 소급 탐침, 길드 경유 타 계정 탐침 순.
 *
 * 이 모듈은 **호출 수 산정**과 **dry-run 출력**의 단일 출처다.
 * 실제 실행 순서(main.ts)와 여기 목록이 어긋나면 dry-run 이 거짓말을 하게 되므로,
 * 라벨을 공유해 한쪽만 바뀌지 않게 한다.
 */
import type { Options } from './cli'
import type { PlannedCall } from './types'

export const PATHS = {
  characterList: '/maplestory/v1/character/list',
  characterBasic: '/maplestory/v1/character/basic',
  schedulerState: '/maplestory/v1/scheduler/character-state',
  ocid: '/maplestory/v1/id',
  guildId: '/maplestory/v1/guild/id',
  guildBasic: '/maplestory/v1/guild/basic',
  bogus: '/maplestory/v1/bogus/path',
} as const

/** 존재할 리 없는 캐릭터명 (한글 + 난수) — 에러 코드 탐침용 */
export function nonexistentCharacterName(): string {
  return `없는캐릭${Math.random().toString(36).slice(2, 8)}`
}

/** 형식은 그럴듯하지만 존재하지 않는 ocid */
export const BOGUS_OCID = '0'.repeat(64)

/** dry-run 에서 보여줄, 그리고 예산을 산정할 전체 계획 */
export function buildPlan(options: Options): PlannedCall[] {
  const plan: PlannedCall[] = [
    {
      label: 'character-list',
      path: PATHS.characterList,
      query: {},
      purpose: '키 유효성 + 계정/캐릭터 목록 (미확인 #13: account_list 복수 반환 조건)',
    },
  ]

  for (let i = 1; i <= options.characters; i += 1) {
    plan.push({
      label: `character-basic-${String(i)}`,
      path: PATHS.characterBasic,
      query: { ocid: '<ocid>' },
      purpose: `캐릭터 ${String(i)} 기본 정보 (길드명 확보 → 타 계정 탐침 재료)`,
    })
    plan.push({
      label: `scheduler-state-${String(i)}`,
      path: PATHS.schedulerState,
      query: { ocid: '<ocid>' },
      purpose: `캐릭터 ${String(i)} 스케줄러 — 이 도구의 핵심 (미확인 #1 #2, 플래그 타입, weekly_boss_clear_limit_count)`,
    })
  }

  if (options.dateProbe) {
    for (const label of ['yesterday', '7d', '30d', '2023-12-21']) {
      plan.push({
        label: `scheduler-date-${label}`,
        path: PATHS.schedulerState,
        query: { ocid: '<ocid>', date: `<${label}>` },
        purpose: '미확인 #4: date 소급 조회 가능 범위',
      })
    }
  }

  plan.push({
    label: 'error-unknown-character',
    path: PATHS.ocid,
    query: { character_name: '<존재하지 않는 캐릭터명>' },
    purpose: '미확인 #7: 존재하지 않는 캐릭터명의 에러 코드',
  })
  plan.push({
    label: 'error-bad-ocid',
    path: PATHS.characterBasic,
    query: { ocid: BOGUS_OCID },
    purpose: '잘못된 ocid 의 에러 코드',
  })
  plan.push({
    label: 'error-bogus-path',
    path: PATHS.bogus,
    query: {},
    purpose: '존재하지 않는 경로의 에러 코드 (유효 키일 때 OPENAPI00006 인지 확인)',
  })

  if (options.crossAccount) {
    plan.push({
      label: 'cross-guild-id',
      path: PATHS.guildId,
      query: { guild_name: '<길드명>', world_name: '<월드명>' },
      purpose: '타 계정 캐릭터를 찾기 위한 길드 조회 (1/3)',
    })
    plan.push({
      label: 'cross-guild-basic',
      path: PATHS.guildBasic,
      query: { oguild_id: '<oguild_id>' },
      purpose: '길드원 목록 확보 (2/3)',
    })
    plan.push({
      label: 'cross-ocid',
      path: PATHS.ocid,
      query: { character_name: '<타 계정 캐릭터명>' },
      purpose: '타 계정 캐릭터의 ocid 확보 (3/3)',
    })
    plan.push({
      label: 'error-cross-account-scheduler',
      path: PATHS.schedulerState,
      query: { ocid: '<타 계정 ocid>' },
      purpose: '미확인 #6: 타 계정 ocid 로 스케줄러 호출 시 정확한 에러 코드',
    })
  }

  return plan
}

/** 스펙 대조를 위한 정적 파일 다운로드 수 (API 키 할당량과 무관) */
export const SPEC_FETCH_ESTIMATE = 9
