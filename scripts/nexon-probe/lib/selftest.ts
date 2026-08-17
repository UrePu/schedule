/**
 * 단위 점검 (`pnpm probe --selftest`).
 *
 * - 네트워크를 쓰지 않는다.
 * - API 키를 요구하지 않는다.
 * - **시간을 실제로 기다리지 않는다** — `FakeClock` 으로 논리 시간만 전진시켜 스로틀 간격을 검증한다.
 *
 * 별도 테스트 러너 의존성을 추가하지 않기 위해 최소 어서션만 직접 구현했다.
 */
import { CallGovernor, DEV_KEY_LIMIT_PER_SECOND, FakeClock } from './governor'
import { NexonClient, extractError } from './client'
import { makeScrubber, maskId, maskName } from './redact'
import { parseDotenv } from './env'
import { parseYaml, yamlGet } from './yaml'
import { compareSpecToResponse, extractSpecFileMeta, findResponseSchemaName, flattenSpecSchema } from './spec'
import { diffJson } from './diff'
import { computeLagHours, kstDateString } from './observe'
import { parseArgs } from './cli'
import { mayOverwriteDoc, parseDocState, renderObservedMarkdown } from './report'
import type { CallResult, Json, Summary } from './types'

interface Case {
  readonly name: string
  readonly run: () => Promise<void> | void
}

class AssertionError extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new AssertionError(`${message}\n    expected: ${b ?? 'undefined'}\n    actual:   ${a ?? 'undefined'}`)
}

/** 실제 넥슨 YAML 의 형태를 축약한 픽스처 (블록 스칼라 / 같은 들여쓰기 시퀀스 / 여러 줄 평문 포함) */
const YAML_FIXTURE = `openapi: 3.0.3
info:
  title: 메이플스토리 API
  version: 1.0.0
servers:
- url: https://open.api.nexon.com
paths:
  /maplestory/v1/scheduler/character-state:
    get:
      tags:
      - scheduler
      parameters:
      - name: ocid
        in: query
        description: 캐릭터 식별자<br>
          자신의 계정에 속한 캐릭터만 조회가 가능합니다.
        required: true
        schema:
          type: string
      responses:
        '200':
          description: SUCCESS
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CharacterStateResponse'
components:
  schemas:
    CharacterStateResponse:
      type: object
      properties:
        date:
          type: string
          description: 조회 기준일 (YYYY-MM-DD)
          example: "2023-12-21T00:00+09:00"
        character_image:
          type: string
          description: |
            여러 줄 설명
            - action: A00
              - frame: 0 ~ 2
        boss_contents:
          type: array
          description: 보스 콘텐츠 정보
          items:
            type: object
            properties:
              content_name:
                type: string
                description: 보스 명
              difficulty:
                type: string
              list_order_no:
                type: number
                format: int64
        weekly_boss_clear_limit_count:
          type: number
          format: int64
`

const CASES: Case[] = [
  {
    name: 'governor: 스로틀이 rps 에 맞는 간격을 강제한다 (실제 대기 없음)',
    run: async () => {
      const clock = new FakeClock(0)
      const governor = new CallGovernor(10, 2, clock)
      const first = await governor.acquire()
      assert(first.granted, '첫 호출은 허가되어야 한다')
      assertEqual(first.granted ? first.waitedMs : -1, 0, '첫 호출은 대기하지 않는다')
      const second = await governor.acquire()
      assert(second.granted, '두 번째 호출도 허가되어야 한다')
      assertEqual(second.granted ? second.waitedMs : -1, 500, 'rps=2 이면 500ms 간격을 둔다')
      assertEqual(clock.sleeps, [500], 'sleep 은 정확히 한 번 500ms')
      clock.advance(10_000)
      const third = await governor.acquire()
      assertEqual(third.granted ? third.waitedMs : -1, 0, '충분히 시간이 지났으면 대기하지 않는다')
    },
  },
  {
    name: 'governor: 예산을 넘기면 하드 스톱한다',
    run: async () => {
      const clock = new FakeClock(0)
      const governor = new CallGovernor(3, 5, clock)
      for (let i = 0; i < 3; i += 1) {
        const permit = await governor.acquire()
        assert(permit.granted, `${String(i + 1)}번째 호출은 예산 안이다`)
      }
      const denied = await governor.acquire()
      assert(!denied.granted, '예산을 넘으면 거부되어야 한다')
      assertEqual(governor.used, 3, '예산 초과 시도는 소모로 세지 않는다')
      assertEqual(governor.stopReason, 'budget-exhausted', '중단 사유가 기록된다')
    },
  },
  {
    name: 'governor: 429 로 중단되면 이후 전부 거부된다',
    run: async () => {
      const clock = new FakeClock(0)
      const governor = new CallGovernor(100, 5, clock)
      await governor.acquire()
      governor.stop('rate-limited')
      const denied = await governor.acquire()
      assert(!denied.granted, '중단 후에는 허가되지 않는다')
      assertEqual(governor.used, 1, '중단 후 예산이 더 소모되지 않는다')
    },
  },
  {
    name: 'client: 429 를 받으면 즉시 중단하고 남은 호출을 스킵한다 (재시도 없음)',
    run: async () => {
      const clock = new FakeClock(0)
      const governor = new CallGovernor(10, 5, clock)
      let requests = 0
      const fetchImpl: typeof fetch = async () => {
        requests += 1
        return Promise.resolve(
          new Response(JSON.stringify({ error: { name: 'OPENAPI00007', message: 'quota' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      const seen: CallResult[] = []
      const client = new NexonClient({ apiKey: 'dummy-key-for-selftest', governor, fetchImpl, onCall: (r) => seen.push(r) })
      const first = await client.call({ label: 'a', path: '/x', query: {}, purpose: 'p' })
      assertEqual(first.status, 429, '429 를 그대로 관측한다')
      const second = await client.call({ label: 'b', path: '/y', query: {}, purpose: 'p' })
      assert(second.skipped, '429 이후 호출은 스킵된다')
      assertEqual(requests, 1, '재시도를 하지 않는다 — 실제 요청은 1건뿐')
      assertEqual(seen.length, 2, '스킵도 결과로 기록된다')
    },
  },
  {
    name: 'client: API 키는 URL 이 아니라 헤더로만 나간다',
    run: async () => {
      const clock = new FakeClock(0)
      const governor = new CallGovernor(10, 5, clock)
      const secret = 'super-secret-key-value'
      let seenUrl = ''
      let seenHeader: string | null = null
      const fetchImpl: typeof fetch = async (input, init) => {
        seenUrl = String(input)
        const headers = new Headers(init?.headers)
        seenHeader = headers.get('x-nxopen-api-key')
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      const client = new NexonClient({ apiKey: secret, governor, fetchImpl })
      const result = await client.call({ label: 'a', path: '/maplestory/v1/id', query: { character_name: '홍길동' }, purpose: 'p' })
      assert(!seenUrl.includes(secret), 'URL 에 키가 들어가면 안 된다')
      assertEqual(seenHeader, secret, '키는 x-nxopen-api-key 헤더로 전달된다')
      assertEqual(result.status, 200, '정상 응답')
    },
  },
  {
    name: 'redact: 키 스크러버와 식별자 마스킹',
    run: () => {
      const scrub = makeScrubber(['abcdefgh12345678', null, 'short'])
      assertEqual(scrub('key=abcdefgh12345678 끝'), 'key=***REDACTED*** 끝', '키가 치환된다')
      assertEqual(scrub('short'), 'short', '8자 미만은 오탐 방지를 위해 무시한다')
      assert(maskId('0123456789abcdef').startsWith('012345…'), 'ocid 는 앞 6자만 남는다')
      assert(!maskId('0123456789abcdef').includes('789abcdef'), '마스킹 후 뒷부분이 남으면 안 된다')
      assertEqual(maskName('우레푸'), '우**', '캐릭터명 마스킹')
    },
  },
  {
    name: 'env: dotenv 최소 문법 파싱',
    run: () => {
      const parsed = parseDotenv(['# 주석', 'NEXON_API_KEY=abc123', 'export OTHER="q u o t e d"', 'BAD_LINE', "S='x'"].join('\n'))
      assertEqual(parsed['NEXON_API_KEY'], 'abc123', '기본 형태')
      assertEqual(parsed['OTHER'], 'q u o t e d', 'export + 큰따옴표')
      assertEqual(parsed['S'], 'x', '작은따옴표')
      assertEqual(parsed['BAD_LINE'], undefined, '= 없는 줄은 무시')
    },
  },
  {
    name: 'cli: 기본값은 dry-run 이고 --yes 로만 실제 호출이 켜진다',
    run: () => {
      const none = parseArgs([])
      assert(none.dryRun && !none.yes, '옵션이 없으면 dry-run')
      const yes = parseArgs(['--yes'])
      assert(!yes.dryRun && yes.yes, '--yes 면 실제 호출')
      const both = parseArgs(['--yes', '--dry-run'])
      assert(both.dryRun && !both.yes, '--dry-run 이 --yes 를 이긴다 (안전한 쪽)')
      const overRps = parseArgs(['--rps', String(DEV_KEY_LIMIT_PER_SECOND + 1)])
      assert(overRps.errors.length > 0, '개발 키 한도를 넘는 rps 는 거부')
      assertEqual(parseArgs(['--budget', '7']).budget, 7, '--budget 파싱')
      assert(parseArgs(['--nope']).errors.length > 0, '알 수 없는 옵션은 에러')
    },
  },
  {
    name: 'yaml: 넥슨 스펙 형태를 파싱한다',
    run: () => {
      const doc = parseYaml(YAML_FIXTURE)
      assertEqual(yamlGet(doc, 'openapi'), '3.0.3', '최상위 스칼라')
      assertEqual(yamlGet(doc, 'info', 'title'), '메이플스토리 API', '중첩 매핑')
      const servers = yamlGet(doc, 'servers')
      assert(Array.isArray(servers) && servers.length === 1, '부모와 같은 들여쓰기의 시퀀스')
      const schemaName = findResponseSchemaName(doc, '/maplestory/v1/scheduler/character-state')
      assertEqual(schemaName, 'CharacterStateResponse', '$ref 로 응답 스키마 이름을 찾는다')
      const fields = flattenSpecSchema(doc, 'CharacterStateResponse')
      const paths = fields.map((field) => field.path)
      assert(paths.includes('boss_contents[].content_name'), '배열 아이템 필드가 평탄화된다')
      assert(paths.includes('weekly_boss_clear_limit_count'), '스칼라 필드도 잡힌다')
      assert(paths.includes('character_image'), '블록 스칼라 설명이 구조를 깨뜨리지 않는다')
      const orderNo = fields.find((field) => field.path === 'boss_contents[].list_order_no')
      assertEqual(orderNo?.format, 'int64', 'format 도 보존된다')
    },
  },
  {
    name: 'spec: 실제 응답과 대조해 누락/추가/타입 불일치를 잡는다',
    run: () => {
      const doc = parseYaml(YAML_FIXTURE)
      const fields = flattenSpecSchema(doc, 'CharacterStateResponse')
      const response: Json = {
        date: '2026-08-17T00:00+09:00',
        boss_contents: [{ content_name: '하드 스우', difficulty: '하드', brand_new_field: 1 }],
        weekly_boss_clear_limit_count: '12',
      }
      const comparison = compareSpecToResponse({
        endpointLabel: 'scheduler',
        apiPath: '/maplestory/v1/scheduler/character-state',
        specFileName: 'fixture.yaml',
        schemaName: 'CharacterStateResponse',
        specFields: fields,
        responses: [response],
      })
      assert(
        comparison.missingInResponse.some((entry) => entry.startsWith('character_image')),
        '스펙에만 있는 필드를 잡는다',
      )
      assert(
        comparison.extraInResponse.some((entry) => entry.startsWith('boss_contents[].brand_new_field')),
        '응답에만 있는 필드를 잡는다',
      )
      assert(
        comparison.typeMismatch.some((entry) => entry.path === 'weekly_boss_clear_limit_count'),
        '타입 불일치를 잡는다 (spec number vs 실제 string)',
      )
    },
  },
  {
    name: 'spec: __NEXT_DATA__ 에서 fileUrl 을 다시 추출한다',
    run: () => {
      const html =
        '<html><body><script id="__NEXT_DATA__" type="application/json">' +
        JSON.stringify({
          props: {
            pageProps: {
              list: [
                { id: 62, categoryName: '스케줄러 정보 조회', fileName: '62_ko_x.yaml', fileUrl: 'https://openapi.nexon.com/static/api/maplestory/62_ko_x.yaml' },
                { id: 14, categoryName: '캐릭터 정보 조회', fileName: '14_ko_y.yaml', fileUrl: 'https://openapi.nexon.com/static/api/maplestory/14_ko_y.yaml' },
              ],
            },
          },
        }) +
        '</script></body></html>'
      const metas = extractSpecFileMeta(html)
      assertEqual(metas.length, 2, 'fileUrl 2건을 찾는다')
      assertEqual(metas[0]?.id, 14, 'id 오름차순 정렬')
      assertEqual(extractSpecFileMeta('<html></html>').length, 0, '스크립트가 없으면 빈 배열 (크래시 금지)')
    },
  },
  {
    name: 'diff: 바뀐 것만 뽑고 휘발성 필드는 무시한다',
    run: () => {
      const before: Json = {
        runId: 'A',
        observations: { bossDifficulties: ['노멀', '하드'], weeklyBossClearLimitCounts: [12] },
      }
      const after: Json = {
        runId: 'B',
        observations: { bossDifficulties: ['노멀', '익스트림'], weeklyBossClearLimitCounts: [12] },
      }
      const changes = diffJson(before, after)
      assertEqual(changes.length, 1, '휘발성 runId 는 제외되고 실제 변경만 남는다')
      assertEqual(changes[0]?.path, 'observations.bossDifficulties[1]', '변경 경로가 정확하다')
      assertEqual(diffJson(before, before).length, 0, '동일하면 변경 0건')
    },
  },
  {
    name: 'observe: 지연 계산과 KST 날짜 생성',
    run: () => {
      const observedAt = Date.parse('2026-08-17T12:00:00+09:00')
      assertEqual(computeLagHours('2026-08-17T00:00+09:00', observedAt), 12, 'KST 기준일 00:00 부터의 경과')
      assertEqual(computeLagHours(null, observedAt), null, 'date 없으면 null')
      assertEqual(computeLagHours('not-a-date', observedAt), null, '파싱 실패는 null')
      assertEqual(kstDateString(new Date('2026-08-16T16:30:00Z')), '2026-08-17', 'UTC 16:30 은 KST 로 다음날')
      assertEqual(kstDateString(new Date('2026-08-16T16:30:00Z'), 1), '2026-08-16', 'daysAgo 적용')
    },
  },
  {
    name: 'report: 관측 문서 등급을 마커로 판정한다',
    run: () => {
      assertEqual(parseDocState(null), 'absent', '파일이 없으면 absent')
      assertEqual(
        parseDocState('<!-- nexon-probe: state=measured; runId=X; mode=live -->\n# 제목\n'),
        'measured',
        '실측본 마커',
      )
      assertEqual(
        parseDocState('<!-- nexon-probe: state=placeholder; runId=X; mode=no-key -->\n# 제목\n'),
        'placeholder',
        '플레이스홀더 마커',
      )
      assertEqual(parseDocState('# 사람이 손으로 쓴 문서\n내용'), 'measured', '마커가 없으면 보존 쪽(measured)으로 본다')
    },
  },
  {
    name: 'report: 문서는 정보량이 줄어드는 방향으로 덮어쓰이지 않는다',
    run: () => {
      assert(!mayOverwriteDoc('measured', 'placeholder', false), '실측본을 플레이스홀더로 덮으면 안 된다')
      assert(mayOverwriteDoc('measured', 'placeholder', true), '--overwrite-doc 이면 강제 가능')
      assert(mayOverwriteDoc('measured', 'measured', false), '실측본은 실측본으로 갱신 가능')
      assert(mayOverwriteDoc('placeholder', 'placeholder', false), '플레이스홀더는 현재 상태로 다시 쓴다 (헤더 신선도)')
      assert(mayOverwriteDoc('placeholder', 'measured', false), '플레이스홀더는 실측본으로 승격 가능')
      assert(mayOverwriteDoc('absent', 'placeholder', false), '문서가 없으면 새로 만든다')
    },
  },
  {
    name: 'report: 렌더링된 문서의 마커와 본문 상태가 일치한다',
    run: () => {
      const base = {
        schemaVersion: 1,
        runId: 'R',
        generatedAt: '2026-08-17T00:00:00.000Z',
        tool: { maxPlannedCalls: 18, executedCalls: 0, budget: 100, rps: 2, abortedReason: null },
        spec: { indexUrl: '', files: [] },
        calls: [],
        specComparison: [],
        unknowns: [],
      } as const
      const noKey: Summary = {
        ...base,
        mode: 'no-key',
        key: { present: false, valid: null, source: null },
        observations: null,
      }
      const text = renderObservedMarkdown(noKey, null)
      assert(text.startsWith('<!-- nexon-probe: state=placeholder'), '첫 줄이 플레이스홀더 마커여야 한다')
      assert(text.includes('API 키: **없음**'), '헤더가 키 없음을 정확히 말해야 한다')
      assert(text.includes('아직 실측되지 않았습니다'), '본문이 미실측 상태를 알려야 한다')
      assertEqual(parseDocState(text), 'placeholder', '자기 자신을 다시 읽어도 같은 등급')
    },
  },
  {
    name: 'client: 에러 바디에서 name/message 를 뽑는다',
    run: () => {
      assertEqual(extractError({ error: { name: 'OPENAPI00005', message: 'bad' } }), { name: 'OPENAPI00005', message: 'bad' }, '정상 형태')
      assertEqual(extractError(null), { name: null, message: null }, 'null 안전')
      assertEqual(extractError({ ok: true }), { name: null, message: null }, 'error 없는 바디')
      assertEqual(extractError([1, 2]), { name: null, message: null }, '배열 안전')
    },
  },
]

export async function runSelfTest(print: (text: string) => void): Promise<boolean> {
  let passed = 0
  const failures: string[] = []
  for (const testCase of CASES) {
    try {
      await testCase.run()
      passed += 1
      print(`  PASS  ${testCase.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${testCase.name}\n    ${message}`)
      print(`  FAIL  ${testCase.name}`)
      print(`        ${message.split('\n').join('\n        ')}`)
    }
  }
  print('')
  print(`  ${String(passed)}/${String(CASES.length)} 통과`)
  return failures.length === 0
}
