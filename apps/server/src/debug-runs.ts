import { randomUUID } from 'node:crypto'
import type {
  AssistantContentBlock,
  Case,
  Config,
  DebugRunRequest,
  ImageBlock,
  Message,
  TextBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  UserContentBlock,
} from '@llm-impl/shared'
import { writeCase } from './cases'

type JsonRecord = Record<string, unknown>
type ImportedToolResult = {
  toolUseId: string
  content: string
  isError?: boolean
}

export type DebugRunImportResult = {
  id: string
  casePath: string
  debugUrl: string
}

type CaseDebug = NonNullable<Case['debug']>

export interface BuildDebugRunCaseOptions {
  id?: string
  now?: string
  casePath?: string
  name?: string
  tags?: string[]
  debugLive?: CaseDebug['live']
  debugMetadata?: Record<string, unknown>
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function compactJson(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function slug(value: string | undefined, fallback: string): string {
  const cleaned = (value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned || fallback
}

function routeGroupSegments(route: DebugRunRequest['caseRouting']): string[] {
  const rawGroup = route?.group
  const values = Array.isArray(rawGroup) ? rawGroup : rawGroup ? [rawGroup] : []
  return values
    .flatMap((value) => value.split(/[\\/]+/))
    .map((value) => slug(value, ''))
    .filter(Boolean)
}

function routeName(route: DebugRunRequest['caseRouting']): string | undefined {
  if (!route?.name) return undefined
  return slug(route.name, '') || undefined
}

function timestampForPath(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function normalizeToolInput(argumentsValue: unknown): Record<string, unknown> {
  if (asRecord(argumentsValue)) return argumentsValue as Record<string, unknown>
  if (typeof argumentsValue !== 'string' || !argumentsValue.trim()) return {}
  try {
    const parsed = JSON.parse(argumentsValue) as unknown
    return asRecord(parsed) ?? { _raw: argumentsValue }
  } catch {
    return { _raw: argumentsValue }
  }
}

function contentToPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) return prettyJson(content)

  return content
    .map((item) => {
      const block = asRecord(item)
      if (!block) return compactJson(item)
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      const imageUrl = imageUrlFromBlock(block)
      if (imageUrl) return `[image: ${imageUrl}]`
      return compactJson(block)
    })
    .filter(Boolean)
    .join('\n')
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function inferToolResultError(content: string): boolean {
  const parsed = parseJsonObject(content)
  if (parsed) {
    if (typeof parsed.error === 'string' && parsed.error.trim()) return true
    if (parsed.type === 'args_invalid' || parsed.type === 'tool_execution_error') {
      return true
    }
  }
  return /\b(error|args_invalid|tool_execution_error)\b/i.test(content)
}

function imageUrlFromBlock(block: JsonRecord): string | null {
  if (typeof block.image_url === 'string') return block.image_url
  const imageUrl = asRecord(block.image_url)
  if (typeof imageUrl?.url === 'string') return imageUrl.url
  if (typeof block.url === 'string' && /image/.test(String(block.type ?? ''))) {
    return block.url
  }
  return null
}

function contentToUserBlocks(content: unknown): UserContentBlock[] {
  if (typeof content === 'string' || content == null || !Array.isArray(content)) {
    return [{ type: 'text', text: contentToPlainText(content) }]
  }

  const blocks: UserContentBlock[] = []
  for (const item of content) {
    const block = asRecord(item)
    if (!block) {
      blocks.push({ type: 'text', text: compactJson(item) })
      continue
    }

    const imageUrl = imageUrlFromBlock(block)
    if (imageUrl) {
      blocks.push({
        type: 'image',
        source: { type: 'url', url: imageUrl },
      } satisfies ImageBlock)
      continue
    }

    blocks.push({
      type: 'text',
      text: contentToPlainText([block]),
    } satisfies TextBlock)
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

function normalizeToolCalls(message: JsonRecord): ToolUseBlock[] {
  const rawToolCalls = message.toolCalls ?? message.tool_calls
  if (!Array.isArray(rawToolCalls)) return []

  return rawToolCalls.flatMap((raw, index): ToolUseBlock[] => {
    const toolCall = asRecord(raw)
    if (!toolCall) return []
    const fn = asRecord(toolCall.function)
    const name = asString(fn?.name) ?? ''
    if (!name) return []
    return [
      {
        type: 'tool_use',
        id: asString(toolCall.id) ?? `call_imported_${index}`,
        name,
        input: normalizeToolInput(fn?.arguments),
      },
    ]
  })
}

function explicitToolResultId(record: JsonRecord): string | undefined {
  return (
    asString(record.toolCallId) ??
    asString(record.tool_call_id) ??
    asString(record.id)
  )
}

function streamEventsFromMessage(record: JsonRecord): unknown[] {
  const rawEvents = record.streamEvents ?? record.stream_events
  return Array.isArray(rawEvents) ? rawEvents : []
}

function toolResultFromEvent(raw: unknown): ImportedToolResult | null {
  const event = asRecord(raw)
  if (!event || event.type !== 'tool_result') return null

  const data = asRecord(event.data) ?? event
  const toolUseId =
    asString(data.toolCallId) ??
    asString(data.tool_call_id) ??
    asString(data.toolUseId) ??
    asString(data.tool_use_id)
  if (!toolUseId) return null

  const content =
    Object.prototype.hasOwnProperty.call(data, 'toolResult')
      ? data.toolResult
      : Object.prototype.hasOwnProperty.call(data, 'result')
        ? data.result
        : Object.prototype.hasOwnProperty.call(data, 'content')
          ? data.content
          : data.output
  const isErrorValue = data.isError ?? data.is_error
  const resultContent = contentToPlainText(content)

  return {
    toolUseId,
    content: resultContent,
    isError:
      typeof isErrorValue === 'boolean'
        ? isErrorValue
        : inferToolResultError(resultContent) || undefined,
  }
}

function collectSyntheticToolResults(
  messages: unknown[],
  events: unknown[] = [],
): Map<string, ImportedToolResult> {
  const explicitIds = new Set<string>()
  const results = new Map<string, ImportedToolResult>()

  for (const raw of messages) {
    const record = asRecord(raw)
    if (!record || record.role !== 'tool') continue
    const id = explicitToolResultId(record)
    if (id) explicitIds.add(id)
  }

  const ingest = (raw: unknown) => {
    const result = toolResultFromEvent(raw)
    if (!result || explicitIds.has(result.toolUseId) || results.has(result.toolUseId)) {
      return
    }
    results.set(result.toolUseId, result)
  }

  for (const raw of messages) {
    const record = asRecord(raw)
    if (!record) continue
    for (const event of streamEventsFromMessage(record)) ingest(event)
  }
  for (const event of events) ingest(event)

  return results
}

function toolResultMessage(results: ImportedToolResult[]): Message {
  const content: UserContentBlock[] = results.map((result) => ({
    type: 'tool_result',
    tool_use_id: result.toolUseId,
    content: result.content,
    ...(result.isError === undefined ? {} : { is_error: result.isError }),
  } satisfies ToolResultBlock))

  return { role: 'user', content }
}

function convertMessage(raw: unknown): {
  system?: string
  message?: Message
} | null {
  const record = asRecord(raw)
  if (!record) return null
  const role = asString(record.role)

  if (role === 'system') {
    return { system: contentToPlainText(record.content) }
  }

  if (role === 'user') {
    return {
      message: {
        role: 'user',
        content: contentToUserBlocks(record.content),
      },
    }
  }

  if (role === 'assistant') {
    const content = contentToPlainText(record.content)
    const blocks: AssistantContentBlock[] = []
    if (content) blocks.push({ type: 'text', text: content })
    blocks.push(...normalizeToolCalls(record))
    if (blocks.length === 0) return null
    return {
      message: {
        role: 'assistant',
        content: blocks,
      },
    }
  }

  if (role === 'tool') {
    const toolUseId =
      explicitToolResultId(record) ??
      `tool_result_imported_${randomUUID()}`
    const content = contentToPlainText(record.content)
    return {
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            ...(inferToolResultError(content) ? { is_error: true } : {}),
          },
        ],
      },
    }
  }

  return null
}

function convertMessages(input: unknown[], events: unknown[] = []): {
  system: string
  messages: Message[]
} {
  const systemParts: string[] = []
  const messages: Message[] = []
  const syntheticToolResults = collectSyntheticToolResults(input, events)
  const consumedToolResults = new Set<string>()

  for (const raw of input) {
    const converted = convertMessage(raw)
    if (!converted) continue
    if (converted.system) systemParts.push(converted.system)
    if (converted.message) {
      messages.push(converted.message)
      if (converted.message.role === 'assistant') {
        const results: ImportedToolResult[] = []
        for (const block of converted.message.content) {
          if (block.type !== 'tool_use' || consumedToolResults.has(block.id)) continue
          const result = syntheticToolResults.get(block.id)
          if (!result) continue
          consumedToolResults.add(block.id)
          results.push(result)
        }
        if (results.length > 0) messages.push(toolResultMessage(results))
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  }

  return {
    system: systemParts.join('\n\n'),
    messages,
  }
}

function convertTool(raw: unknown): Tool | null {
  const record = asRecord(raw)
  if (!record) return null

  if (typeof record.name === 'string') {
    return {
      name: record.name,
      description: asString(record.description),
      input_schema:
        asRecord(record.input_schema) ??
        asRecord(record.parameters) ??
        { type: 'object', properties: {} },
    }
  }

  const fn = asRecord(record.function)
  if (typeof fn?.name !== 'string') return null
  return {
    name: fn.name,
    description: asString(fn.description),
    input_schema: asRecord(fn.parameters) ?? { type: 'object', properties: {} },
  }
}

function convertTools(input: unknown[]): Tool[] {
  return input.flatMap((raw): Tool[] => {
    const tool = convertTool(raw)
    return tool ? [tool] : []
  })
}

function configFromDebugRun(input: DebugRunRequest): Config {
  return {
    provider:
      input.config.provider ??
      process.env.LLM_IMPL_DEBUG_PROVIDER ??
      input.source.project,
    model: input.config.model,
    temperature: input.config.temperature,
    max_tokens: input.config.max_tokens,
    stream: true,
  }
}

function casePathForDebugRun(input: DebugRunRequest, id: string): string {
  const project = slug(input.source.project, 'debug')
  const session = slug(input.source.sessionId, 'session')
  const run = slug(input.source.runId ?? id, 'run')
  const runTail = run.startsWith(`${session}-`) ? run.slice(session.length + 1) : run
  const routedName = routeName(input.caseRouting)
  const name = routedName ?? session
  const suffix = routedName
    ? ''
    : runTail && runTail !== session
      ? `-${runTail.slice(-8)}`
      : ''
  const timestamp = timestampForPath()
  return ['debug', project, ...routeGroupSegments(input.caseRouting), `${timestamp}-${name}${suffix}.json`].join('/')
}

export function buildDebugRunCase(
  input: DebugRunRequest,
  options: BuildDebugRunCaseOptions = {},
): Case {
  const id = options.id ?? input.source.runId ?? randomUUID()
  const converted = convertMessages(input.messages, input.events)
  const system = [input.system, converted.system].filter(Boolean).join('\n\n')
  const now = options.now ?? new Date().toISOString()
  const metadata = {
    ...(input.metadata ?? {}),
    ...(options.debugMetadata ?? {}),
  }

  return {
    meta: {
      name: options.name ?? `${input.source.project} ${input.source.sessionId ?? id}`,
      tags: options.tags ?? ['debug-run', input.source.project],
      updatedAt: now,
      source: input.source.project,
      sessionId: input.source.sessionId,
      runId: id,
    },
    config: configFromDebugRun(input),
    system,
    tools: convertTools(input.tools),
    messages: converted.messages,
    lastRun: input.lastRun
      ? {
          timestamp: input.lastRun.timestamp ?? now,
          usage: input.lastRun.usage,
          latency_ms: input.lastRun.latency_ms,
          stop_reason: input.lastRun.stop_reason,
        }
      : undefined,
    debug: {
      source: input.source,
      events: input.events,
      ...(input.constraints?.length && { constraints: input.constraints }),
      ...(Object.keys(metadata).length > 0 && { metadata }),
      ...(options.debugLive && { live: options.debugLive }),
    },
  }
}

export async function importDebugRun(input: DebugRunRequest): Promise<DebugRunImportResult> {
  const id = input.source.runId || randomUUID()
  const casePath = casePathForDebugRun(input, id)
  const caseData = buildDebugRunCase(input, { id })

  await writeCase(casePath, caseData)

  return {
    id,
    casePath,
    debugUrl: process.env.LLM_IMPL_WEB_URL ?? 'http://localhost:5181',
  }
}
