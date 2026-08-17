/**
 * 넥슨이 배포하는 **OpenAPI YAML 원본**을 받아 실제 응답과 대조한다.
 *
 * 스펙 파일 URL 은 파일명에 타임스탬프가 박혀 있어 개정 시 바뀐다. 그래서 URL 을 하드코딩하지 않고
 * `https://openapi.nexon.com/ko/game/maplestory/` 페이지의 `__NEXT_DATA__` 에서 `fileUrl` 을
 * 매번 다시 뽑는다. (fileName 변화 자체가 스펙 개정의 1차 신호다 → 드리프트 모드에서 감지됨)
 *
 * 여기서 나가는 요청은 정적 파일 다운로드이며 **API 키 할당량을 소모하지 않는다.**
 * 그래도 호출 수는 따로 세어서 보고한다.
 */
import { createHash } from 'node:crypto'
import type { Json, SpecComparison, SpecField, SpecFile, SpecFileMeta } from './types'
import { isYamlObject, parseYaml, yamlGet } from './yaml'
import type { YamlValue } from './yaml'

export const SPEC_INDEX_URL = 'https://openapi.nexon.com/ko/game/maplestory/'

const NEXT_DATA_PATTERN = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/

function isJsonObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `__NEXT_DATA__` JSON 을 전부 훑어 `fileUrl` 을 가진 노드를 모은다. */
export function extractSpecFileMeta(html: string): SpecFileMeta[] {
  const match = NEXT_DATA_PATTERN.exec(html)
  if (match === null) return []
  const jsonText = match[1]
  if (jsonText === undefined) return []
  let data: Json
  try {
    data = JSON.parse(jsonText) as Json
  } catch {
    return []
  }

  const found: SpecFileMeta[] = []
  const seen = new Set<string>()
  const walk = (node: Json): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isJsonObject(node)) return
    const fileUrl = node['fileUrl']
    if (typeof fileUrl === 'string' && fileUrl.endsWith('.yaml') && !seen.has(fileUrl)) {
      seen.add(fileUrl)
      found.push({
        id: typeof node['id'] === 'number' ? node['id'] : -1,
        categoryName: typeof node['categoryName'] === 'string' ? node['categoryName'] : '(unknown)',
        fileName: typeof node['fileName'] === 'string' ? node['fileName'] : fileUrl.split('/').pop() ?? fileUrl,
        fileUrl,
      })
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(data)
  return found.sort((a, b) => a.id - b.id)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface LoadedSpec {
  readonly meta: SpecFile
  readonly doc: YamlValue
}

export interface SpecFetcher {
  (url: string): Promise<string>
}

/** 페이지 1건 + YAML N건을 받아온다. 실패해도 예외를 던지지 않고 결과에 기록한다. */
export async function loadSpecs(
  fetchText: SpecFetcher,
  onFetch?: (url: string, ok: boolean) => void,
): Promise<{ indexUrl: string; specs: LoadedSpec[]; indexError: string | null }> {
  let html: string
  try {
    html = await fetchText(SPEC_INDEX_URL)
    onFetch?.(SPEC_INDEX_URL, true)
  } catch (error) {
    onFetch?.(SPEC_INDEX_URL, false)
    return { indexUrl: SPEC_INDEX_URL, specs: [], indexError: error instanceof Error ? error.message : String(error) }
  }

  const metas = extractSpecFileMeta(html)
  const specs: LoadedSpec[] = []
  for (const meta of metas) {
    let text: string
    try {
      text = await fetchText(meta.fileUrl)
      onFetch?.(meta.fileUrl, true)
    } catch (error) {
      onFetch?.(meta.fileUrl, false)
      specs.push({
        meta: { ...meta, sha256: '', bytes: 0, parsed: false, parseError: error instanceof Error ? error.message : String(error) },
        doc: null,
      })
      continue
    }
    let doc: YamlValue = null
    let parseError: string | null = null
    try {
      doc = parseYaml(text)
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error)
    }
    specs.push({
      meta: {
        ...meta,
        sha256: sha256(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        parsed: parseError === null,
        parseError,
      },
      doc,
    })
  }
  return { indexUrl: SPEC_INDEX_URL, specs, indexError: metas.length === 0 ? '__NEXT_DATA__ 에서 fileUrl 을 찾지 못했습니다' : null }
}

/** `paths[apiPath].get.responses['200']...schema.$ref` 를 따라가 스키마 이름을 얻는다. */
export function findResponseSchemaName(doc: YamlValue, apiPath: string): string | null {
  const schema = yamlGet(doc, 'paths', apiPath, 'get', 'responses', '200', 'content', 'application/json', 'schema')
  if (!isYamlObject(schema)) return null
  const ref = schema['$ref']
  if (typeof ref !== 'string') return null
  const parts = ref.split('/')
  return parts[parts.length - 1] ?? null
}

/** OpenAPI 스키마 트리를 `a.b[].c` 형태의 평탄한 필드 목록으로 편다. */
export function flattenSpecSchema(doc: YamlValue, schemaName: string): SpecField[] {
  const root = yamlGet(doc, 'components', 'schemas', schemaName)
  if (!isYamlObject(root)) return []
  const out: SpecField[] = []
  const visit = (node: YamlValue, prefix: string, depth: number): void => {
    if (!isYamlObject(node) || depth > 8) return
    const type = typeof node['type'] === 'string' ? node['type'] : 'object'
    if (type === 'array') {
      const items = node['items']
      if (prefix.length > 0) visit(items ?? null, `${prefix}[]`, depth + 1)
      return
    }
    const properties = node['properties']
    if (!isYamlObject(properties)) return
    for (const [key, child] of Object.entries(properties)) {
      if (!isYamlObject(child)) continue
      const childType = typeof child['type'] === 'string' ? child['type'] : 'object'
      const format = typeof child['format'] === 'string' ? child['format'] : null
      const path = prefix.length > 0 ? `${prefix}.${key}` : key
      out.push({ path, type: childType, format })
      if (childType === 'array') visit(child['items'] ?? null, `${path}[]`, depth + 1)
      else if (childType === 'object') visit(child, path, depth + 1)
    }
  }
  visit(root, '', 0)
  return out
}

/** 실제 JSON 응답을 같은 규칙으로 평탄화한다. 값 타입은 OpenAPI 어휘로 환산한다. */
export function flattenJson(value: Json): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const record = (path: string, type: string): void => {
    const bucket = out.get(path) ?? new Set<string>()
    bucket.add(type)
    out.set(path, bucket)
  }
  const visit = (node: Json, prefix: string, depth: number): void => {
    if (depth > 8) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, `${prefix}[]`, depth + 1)
      return
    }
    if (isJsonObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        const path = prefix.length > 0 ? `${prefix}.${key}` : key
        record(path, jsonTypeName(child))
        visit(child, path, depth + 1)
      }
    }
  }
  visit(value, '', 0)
  return out
}

function jsonTypeName(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

/** 스펙 필드 목록과 실제 응답을 대조한다. */
export function compareSpecToResponse(input: {
  endpointLabel: string
  apiPath: string
  specFileName: string | null
  schemaName: string | null
  specFields: readonly SpecField[]
  responses: readonly Json[]
}): SpecComparison {
  if (input.schemaName === null || input.specFields.length === 0) {
    return {
      endpointLabel: input.endpointLabel,
      apiPath: input.apiPath,
      specFileName: input.specFileName,
      schemaName: input.schemaName,
      missingInResponse: [],
      extraInResponse: [],
      typeMismatch: [],
      note: '스펙에서 해당 응답 스키마를 찾지 못해 대조하지 못했습니다.',
    }
  }
  if (input.responses.length === 0) {
    return {
      endpointLabel: input.endpointLabel,
      apiPath: input.apiPath,
      specFileName: input.specFileName,
      schemaName: input.schemaName,
      missingInResponse: [],
      extraInResponse: [],
      typeMismatch: [],
      note: '성공 응답을 얻지 못해 대조하지 못했습니다.',
    }
  }

  const observed = new Map<string, Set<string>>()
  for (const response of input.responses) {
    for (const [path, types] of flattenJson(response)) {
      const bucket = observed.get(path) ?? new Set<string>()
      for (const type of types) bucket.add(type)
      observed.set(path, bucket)
    }
  }

  const specByPath = new Map(input.specFields.map((field) => [field.path, field]))
  const missingInResponse: string[] = []
  const typeMismatch: { path: string; spec: string; observed: string }[] = []

  for (const field of input.specFields) {
    const seen = observed.get(field.path)
    if (seen === undefined) {
      missingInResponse.push(`${field.path}: ${field.type}`)
      continue
    }
    const concrete = [...seen].filter((type) => type !== 'null')
    if (concrete.length === 0) continue
    const compatible = concrete.every((type) => isCompatible(field.type, type))
    if (!compatible) {
      typeMismatch.push({ path: field.path, spec: field.type, observed: [...seen].sort().join('|') })
    }
  }

  const extraInResponse = [...observed.keys()]
    .filter((path) => !specByPath.has(path))
    .sort()
    .map((path) => `${path}: ${[...(observed.get(path) ?? [])].sort().join('|')}`)

  return {
    endpointLabel: input.endpointLabel,
    apiPath: input.apiPath,
    specFileName: input.specFileName,
    schemaName: input.schemaName,
    missingInResponse: missingInResponse.sort(),
    extraInResponse,
    typeMismatch,
    note: null,
  }
}

function isCompatible(specType: string, observedType: string): boolean {
  if (specType === observedType) return true
  // OpenAPI 는 integer/number 를 구분하지만 JSON 은 하나다.
  if ((specType === 'integer' || specType === 'number') && observedType === 'number') return true
  return false
}
