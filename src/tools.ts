/**
 * tools.ts - fix #303 v3 - compila sem dom lib e sem node_modules local
 * O1-O5 + fix TS2304 TextEncoder/AbortSignal/console
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterPropertySpec, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { LingshuBridge } from './bridge.ts'
import { attributeSession } from './lib/session_state.js'

// --- #303 O1-O5 ---
const MAX_BYTES = 1_048_576
const ALLOWED_CONTENT_KINDS = new Set([
  'fact','preference','skill','project','workflow',
  'error_lesson','identity','relation','anchor','timeline'
])
/**
 * ID_RE alinhado com md_cg/evidence.py::_NODE_ID_RE + _NODE_ID_FORBIDDEN
 * GOOD: node-0123, mem_..., 中文节点, a.b@c, a,b, a-b_c
 * BAD:  ../../, /etc/passwd, sub/dir, has:colon, has%2e%2e, None/null, >128, ., ..
 * Regra #303 O5 + #277 P1-P6 - v4 FINAL TRAVADO - NÃO VOLTAR PARA /^[A-Za-z0-9_-]$/
 */
const ID_RE = /^[\p{L}\p{N}_\-.@,]{1,128}$/u
const FORBIDDEN_ID_EXACT = new Set(['None', 'null', 'none', 'NULL'])
const K_MIN = 1
const K_MAX = 100

function throwExplicit(code: string, msg: string): never {
  const err = new Error(`[${code}] ${msg}`) as any
  err.code = code
  throw err
}

// Fix TS2304: usa Buffer se existir, senão fallback sem precisar de lib dom
function byteLengthUtf8(str: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (typeof g.Buffer !== 'undefined') {
    return g.Buffer.byteLength(str, 'utf-8')
  }
  if (typeof g.TextEncoder !== 'undefined') {
    return new g.TextEncoder().encode(str).length
  }
  // fallback puro JS (aproximado, suficiente pra 1MiB check) - usa globalThis pra não precisar de lib dom
  if (typeof g.Blob !== 'undefined') {
    return new g.Blob([str]).size
  }
  // ultimo fallback: conta caracteres * 3 (utf8 max)
  return str.length * 3
}

function validateContentField(value: unknown, fieldName = 'content') {
  if (typeof value !== 'string') return
  if (value.includes('\0')) {
    throwExplicit('NUL_BYTE_NOT_ALLOWED', `${fieldName} 包含 NUL`)
  }
  const bytes = byteLengthUtf8(value)
  if (bytes > MAX_BYTES) {
    throwExplicit('CONTENT_TOO_LARGE', `${fieldName} 超过 1MiB: ${bytes} > ${MAX_BYTES}`)
  }
}
function validateContentKind(kind: unknown) {
  if (kind == null) return
  if (typeof kind !== 'string') return
  if (!ALLOWED_CONTENT_KINDS.has(kind)) {
    // Fix TS2584 console: usa globalThis
    ;(globalThis as any).console?.warn?.(`[AUDIT][unknown_content_kind] ${kind}`)
  }
}
function validateK(value: unknown) {
  if (value == null) return
  const n = typeof value === 'number' ? value : Number(value as any)
  if (!Number.isInteger(n) || n < K_MIN || n > K_MAX) {
    throwExplicit('OUT_OF_RANGE_K', `k 越界: 需 ${K_MIN}..${K_MAX}, 实得 ${value}`)
  }
}
function validateId(id: unknown, fieldName = 'id') {
  if (id == null) return
  if (typeof id !== 'string') {
    throwExplicit('INVALID_NODE_ID', `${fieldName} 类型错误`)
  }
  // #277 P1: reserva None/null etc
  if (FORBIDDEN_ID_EXACT.has(id)) {
    throwExplicit('INVALID_NODE_ID', `invalid_node_id: reserved=${id}`)
  }
  // #277 P2-P6: traversal
  if (id === '.' || id === '..' || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes(':') || id.includes('%')) {
    throwExplicit('INVALID_NODE_ID', `invalid_node_id: traversal=${id}`)
  }
  if (!ID_RE.test(id)) {
    throwExplicit('INVALID_NODE_ID', `invalid_node_id: ${fieldName}=${id}`)
  }
}
function validateCommonArgs(args: Record<string, unknown>) {
  for (const key of ['content','text','body','fact','value','description','summary']) {
    if (key in args) validateContentField(args[key], key)
  }
  for (const key of ['content_kind','kind','type','content_type']) {
    if (key in args) validateContentKind(args[key])
  }
  for (const key of ['k','top_k','topK','limit']) {
    if (key in args) validateK(args[key])
  }
  // v4.3 - expande para cobrir issue147 pack_id, 245 swarm, 258 pack, 265, 277, 294 flywheel, 295 sleep_root, 297 rewrite, p24 evidence
  for (const key of [
    'id','node_id','nodeId','target_id','source_id','anchor_id',
    'pack_id','packId','swarm_id','swarmId','pool_id','poolId',
    'pack','swarm','anchor','root','binding','evidence_id','evidenceId',
    'flywheel_id','rewrite_id','sleep_id','sensitive_id'
  ]) {
    if (key in args) validateId(args[key], key)
  }
}

export const CORE_TOOLS = ['cg','stg'] as const
export const BRAIN_TOOLS = [
  'cg','stg',
  'mdcg_remember','mdcg_recall','mdcg_search','mdcg_get',
  'mdcg_reflect','mdcg_verify','mdcg_flywheel','mdcg_mine_fix_pairs',
  'mdcg_rejected','mdcg_unresolved',
  'mdcg_propose','mdcg_review_list','mdcg_review_records',
  'mdcg_protect','mdcg_forgetting_history',
  'mdcg_identity','mdcg_consistency','mdcg_metacognition','mdcg_self_state',
  'mdcg_predict','mdcg_causal','mdcg_evolution',
  'mdcg_health','mdcg_whoami','mdcg_ingest','mdcg_watermarks',
  'mdcg_whitebox','mdcg_service_info',
] as const

export type ToolSelection = 'core' | 'brain' | 'all' | string[]
const READ_TOOLS = new Set([
  'mdcg_recall','mdcg_search','mdcg_get','mdcg_review_list','mdcg_review_records',
  'mdcg_forgetting_history','mdcg_health','mdcg_whoami','mdcg_watermarks','mdcg_service_info',
])
export function isToolConcurrencySafe(name: string): boolean { return READ_TOOLS.has(name) }
export const RISK_TOOLS = new Set(['mdcg_forget','mdcg_restore','mdcg_review_decide'])
export function selectTools(all: string[], selection: ToolSelection): string[] {
  if (selection === 'all') return all.filter((name) => !RISK_TOOLS.has(name))
  const allowed = new Set(selection === 'core' ? CORE_TOOLS : selection === 'brain' ? BRAIN_TOOLS : selection)
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
    if (required.has(key)) spec[key] = { ...value, required: true as const }
    else spec[key] = value
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
    case 'string': return { type: 'string', ...annotations, ...(enumValues ? { enum: enumValues as string[] } : {}) }
    case 'number': return { type: 'number', ...annotations }
    case 'integer': return { type: 'integer', ...annotations }
    case 'boolean': return { type: 'boolean', ...annotations }
    case 'null': return { type: 'null', ...annotations }
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
    default: return { type: 'json', ...annotations }
  }
}
export function extractText(content: Array<{ type: string; text?: string; [key: string]: unknown }>): string {
  return content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n')
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
          // Fix TS7006: tipa explicitamente _args e value
          render(_args: any, value: any) {
            return [{ type: 'text', text: extractText((value as McpCallResultLike).content ?? []) }]
          },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => isToolConcurrencySafe(tool.name),
        async execute(args: Record<string, unknown>, exec?: { signal?: any }) {
          if (exec?.signal?.aborted) throw new Error(`灵枢 ${tool.name} 已取消`)
          try { validateCommonArgs(args) } catch (e) { throw e }
          const forwarded = attributeSession(tool.name, args as Record<string, unknown>)
          const result = await bridge.callTool(tool.name, forwarded, exec?.signal as any)
          if (exec?.signal?.aborted) throw new Error(`灵枢 ${tool.name} 已取消`)
          if (result.isError) {
            throw new Error(extractText(result.content) || `灵枢 ${tool.name} 执行失败`)
          }
          return { content: result.content } as never
        },
      })
      disposers.push((ctx as any).tools.register(definition))
      registered.push(publicName)
    }
  } catch (err) {
    for (const dispose of disposers) dispose()
    throw err
  }
  ;(ctx as any).logger.info(`dsh-memory: 已注册 ${registered.length} 个灵枢工具（${registered.join(', ')}）`)
  return () => {
    for (const dispose of disposers) dispose()
  }
}
interface McpCallResultLike {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
}
