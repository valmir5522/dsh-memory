/**
 * 工具桥接：运行时从灵枢拉取工具清单（tools/list），把 JSON Schema
 * 转换为 dsh-tools 的 ParameterSchemaSpec，经 defineTool 注册进 ctx.tools。
 *
 * 动态拉取意味着灵枢库升级新增工具后，DSH 侧零改动即可获得新能力。
 * 
 * P3 加固 #303 (2026-10-14): 边界加固 - NUL/1MiB/content_kind/k越界/id非法
 * 预期处置 O1-O5 实现在此客户端做显式错误，服务端保持兜底
 */

// 兼容缺失的 @deepseek-ai/dsh-tools 类型声明：在本地提供最小 AST 以避免
// "Cannot find module '@deepseek-ai/dsh-tools'"，并保持与运行时 `defineTool` 的用法一致。
type ValueType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'

type ValueSchemaSpec = {
  type?: ValueType
  description?: string
  enum?: string[]
  items?: ValueSchemaSpec
  properties?: Record<string, ParameterPropertySpec>
  additionalProperties?: boolean
}

type ParameterPropertySpec = ValueSchemaSpec & {
  required?: true
}

type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

const defineTool = <T extends object>(tool: T): T => tool

import type { LingshuBridge, McpTool } from './bridge.ts'
import { attributeSession } from './lib/session_state.js'

type Context = {
  tools: { register(tool: ReturnType<typeof defineTool>): () => void }
  logger: { info(message: string): void }
}

// ==================== #303 边界加固 O1-O5 ====================
const MAX_BYTES = 1_048_576 // 1MiB 精确边界: -1 ok, +1 block
const ALLOWED_CONTENT_KINDS = new Set([
  'fact', 'preference', 'skill', 'project', 'workflow', 
  'error_lesson', 'identity', 'relation', 'anchor', 'timeline'
])
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/ // 非法 id 显式错误而非 null
const K_MIN = 1
const K_MAX = 100

function throwExplicit(code: string, msg: string): never {
  // 统一格式便于测试: invalid_node_id / out_of_range / NUL / too_large / unknown_kind
  const err = new Error(`[${code}] ${msg}`) as Error & { code?: string }
  ;(err as any).code = code
  throw err
}

function utf8ByteLength(value: string): number {
  const globalScope = globalThis as typeof globalThis & {
    TextEncoder?: new () => { encode(input: string): Uint8Array }
    Buffer?: { byteLength(input: string, encoding?: string): number }
  }

  if (typeof globalScope.TextEncoder !== 'undefined') {
    return new globalScope.TextEncoder().encode(value).length
  }
  if (typeof globalScope.Buffer !== 'undefined') {
    return globalScope.Buffer.byteLength(value, 'utf-8')
  }
  return value.length
}

// O1: 六要素 / 1MiB 阈值 NUL 判断
function validateContentField(value: unknown, fieldName = 'content') {
  if (typeof value !== 'string') return
  if (value.includes('\0')) {
    // O1 处置: NUL 属于非法文本 - 显式错误 (或文档说明合法则改为 strip)
    throwExplicit('NUL_BYTE_NOT_ALLOWED', `${fieldName} 包含 NUL (\\0) - 属于非法文本范围`)
  }
  const bytes = utf8ByteLength(value)
  if (bytes > MAX_BYTES) {
    throwExplicit('CONTENT_TOO_LARGE', `${fieldName} 超过 1MiB: ${bytes} > ${MAX_BYTES} (-1 exact ok, +1 block)`)
  }
}

// O2: 未知 content_kind - 统一审计而非静默
function validateContentKind(kind: unknown) {
  if (kind == null) return
  if (typeof kind !== 'string') return
  if (!ALLOWED_CONTENT_KINDS.has(kind)) {
    // O2 处置: 保持现状(包容) + 审计日志 (或可选抛错)
    ;(globalThis as typeof globalThis & { console?: { warn(message: string): void } }).console?.warn(
      `[AUDIT][unknown_content_kind] ${kind} -> 统一审计`,
    )
    // 如需严格模式，取消下面注释:
    // throwExplicit('UNKNOWN_CONTENT_KIND', `unknown content_kind: ${kind}`)
  }
}

// O4: k 越界 - 返回区间外错误而非默认失败
function validateK(value: unknown) {
  if (value == null) return
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < K_MIN || n > K_MAX) {
    throwExplicit('OUT_OF_RANGE_K', `k 越界: 需 ${K_MIN}..${K_MAX}, 实得 ${value}`)
  }
}

// O5: 非法 id 返回结构化错误而非 null
function validateId(id: unknown, fieldName = 'id') {
  if (id == null) return
  if (typeof id !== 'string') {
    throwExplicit('INVALID_NODE_ID', `${fieldName} 类型错误: 期望 string, 实得 ${typeof id}`)
  }
  if (!ID_RE.test(id)) {
    throwExplicit('INVALID_NODE_ID', `invalid_node_id: ${fieldName}=${id} (区分于 "不存在" 的 null)`)
  }
}

// 通用参数扫描 - 覆盖所有 cg/stg 多态 op
function validateCommonArgs(args: Record<string, unknown>) {
  // 文本类六要素扫描
  for (const key of ['content', 'text', 'body', 'fact', 'value', 'description', 'summary']) {
    if (key in args) validateContentField(args[key], key)
  }
  // content_kind
  for (const key of ['content_kind', 'kind', 'type', 'content_type']) {
    if (key in args) validateContentKind(args[key])
  }
  // k / top_k / limit
  for (const key of ['k', 'top_k', 'topK', 'limit']) {
    if (key in args) validateK(args[key])
  }
  // id / node_id / target_id / source_id
  for (const key of ['id', 'node_id', 'nodeId', 'target_id', 'source_id', 'anchor_id']) {
    if (key in args) validateId(args[key], key)
  }
  // op 存在性提示 (O3: 文档已覆盖 op_derived 提示，保持现状)
  // 如果 op 缺签名推导，这里不强制，保留原行为，由服务端 op_derived hint 覆盖
}
// ==================== END #303 ====================

/** 默认暴露的核心工具集合：**记忆面已基元化**，只注册 `cg` / `stg` 两个认知基元。 */
export const CORE_TOOLS = [
  'cg',
  'stg',
] as const

export const BRAIN_TOOLS = [
  'cg', 'stg',
  'mdcg_remember', 'mdcg_recall', 'mdcg_search', 'mdcg_get',
  'mdcg_reflect', 'mdcg_verify', 'mdcg_flywheel', 'mdcg_mine_fix_pairs',
  'mdcg_rejected', 'mdcg_unresolved',
  'mdcg_propose', 'mdcg_review_list', 'mdcg_review_records',
  'mdcg_protect', 'mdcg_forgetting_history',
  'mdcg_identity', 'mdcg_consistency', 'mdcg_metacognition', 'mdcg_self_state',
  'mdcg_predict', 'mdcg_causal', 'mdcg_evolution',
  'mdcg_health', 'mdcg_whoami', 'mdcg_ingest', 'mdcg_watermarks',
  'mdcg_whitebox', 'mdcg_service_info',
] as const

export type ToolSelection = 'core' | 'brain' | 'all' | string[]

const READ_TOOLS = new Set([
  'mdcg_recall', 'mdcg_search', 'mdcg_get', 'mdcg_review_list', 'mdcg_review_records',
  'mdcg_forgetting_history', 'mdcg_health', 'mdcg_whoami', 'mdcg_watermarks', 'mdcg_service_info',
])

export function isToolConcurrencySafe(name: string): boolean {
  return READ_TOOLS.has(name)
}

export const RISK_TOOLS = new Set([
  'mdcg_forget',
  'mdcg_restore',
  'mdcg_review_decide',
])

export function selectTools(all: string[], selection: ToolSelection): string[] {
  if (selection === 'all') return all.filter((name) => !RISK_TOOLS.has(name))
  const allowed = new Set(
    selection === 'core' ? CORE_TOOLS
      : selection === 'brain' ? BRAIN_TOOLS
      : selection,
  )
  return all.filter((name) => allowed.has(name))
}

export function schemaToParameters(inputSchema: Record<string, unknown> | undefined): ParameterSchemaSpec {
  if (!inputSchema || typeof inputSchema !== 'object') return {}
  const properties = inputSchema['properties'] as Record<string, unknown> | undefined
  if (!properties || typeof properties !== 'object') return {}
  const required = new Set(Array.isArray(inputSchema['required']) ? (inputSchema['required'] as string[]) : [])
  const spec: Record<string, ParameterPropertySpec> = {}
  for (const [key, raw] of Object.entries(properties)) {
    const value = toValueSpec(raw)
    if (required.has(key)) {
      spec[key] = { ...value, required: true as const }
    } else {
      spec[key] = value
    }
  }
  return spec
}

function toValueSpec(raw: unknown): ValueSchemaSpec {
  if (typeof raw !== 'object' || raw === null) return { type: 'json' }
  const node = raw as Record<string, unknown>
  const annotations: { description?: string } = {}
  if (typeof node['description'] === 'string') annotations.description = node['description'] as string
  const type = node['type']
  const enumValues = Array.isArray(node['enum']) ? (node['enum'] as unknown[]) : undefined
  switch (type) {
    case 'string':
      return { type: 'string', ...annotations, ...(enumValues ? { enum: enumValues as string[] } : {}) }
    case 'number':
      return { type: 'number', ...annotations }
    case 'integer':
      return { type: 'integer', ...annotations }
    case 'boolean':
      return { type: 'boolean', ...annotations }
    case 'null':
      return { type: 'null', ...annotations }
    case 'array': {
      const spec: { type: 'array'; items?: ValueSchemaSpec } & typeof annotations = { type: 'array', ...annotations }
      if (node['items'] !== undefined) spec.items = toValueSpec(node['items'])
      return spec
    }
    case 'object': {
      const props = schemaToParameters(node)
      const additional = node['additionalProperties'] === false ? false : true
      return { type: 'object', properties: props, additionalProperties: additional, ...annotations }
    }
    default:
      return { type: 'json', ...annotations }
  }
}

export function extractText(content: Array<{ type: string; text?: string; [key: string]: unknown }>): string {
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

export async function registerLingshuTools(
  ctx: Context,
  bridge: LingshuBridge,
  opts: { selection: ToolSelection; toolPrefix: string },
): Promise<() => void> {
  const tools = await bridge.listTools()
  const wanted = new Set(selectTools(tools.map((t) => t.name), opts.selection))
  const disposers: Array<() => void> = []
  const registered: string[] = []
  try {
    for (const tool of tools) {
      if (!wanted.has(tool.name)) continue
      const publicName = `${opts.toolPrefix}${tool.name}`
      const definition = defineTool({
        name: publicName,
        description: tool.description || `灵枢 ${tool.name}`,
        parameters: schemaToParameters(tool.inputSchema),
        output: {
          schema: { type: 'json' } as never,
          render(_args: Record<string, unknown>, value: unknown) {
            return [{ type: 'text', text: extractText((value as McpCallResultLike).content ?? []) }]
          },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => isToolConcurrencySafe(tool.name),
        async execute(args: Record<string, unknown>, exec: { signal: Parameters<LingshuBridge['callTool']>[2] }) {
          if (exec.signal.aborted) throw new Error(`灵枢 ${tool.name} 已取消`)
          // #303 边界加固: 在转发前显式校验，返回结构化错误而非静默/null
          try {
            validateCommonArgs(args)
          } catch (e) {
            // 直接抛出，让 DSH 侧看到明确错误码
            throw e
          }
          const forwarded = attributeSession(tool.name, args as Record<string, unknown>)
          const result = await bridge.callTool(tool.name, forwarded, exec.signal)
          if (exec.signal.aborted) throw new Error(`灵枢 ${tool.name} 已取消`)
          if (result.isError) {
            throw new Error(extractText(result.content) || `灵枢 ${tool.name} 执行失败`)
          }
          return { content: result.content } as never
        },
      })
      disposers.push(ctx.tools.register(definition))
      registered.push(publicName)
    }
  } catch (err) {
    for (const dispose of disposers) dispose()
    throw err
  }
  ctx.logger.info(`dsh-memory: 已注册 ${registered.length} 个灵枢工具（${registered.join(', ')}）`)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

interface McpCallResultLike {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
}
