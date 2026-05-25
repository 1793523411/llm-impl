import {
  createLlmImplDebugger,
  type DebugConstraintSnapshot,
  type DebugRunEvent,
  type DebugRunMessage,
  type DebugRunSubmitResult,
  type DebugRunTool,
  type DebugRunToolCall,
  type LlmImplDebugger,
  type LlmImplDebuggerOptions,
  type LiveDebugResumeAction,
  type LiveDebugWaitResponse,
} from '@llm-impl/debug-sdk'

export type MaybePromise<T> = T | Promise<T>

export type LangChainToolLike = {
  name?: string
  description?: string
  schema?: unknown
  argsSchema?: unknown
  args_schema?: unknown
  invoke?: (input: unknown, config?: unknown) => MaybePromise<unknown>
  call?: (input: unknown, config?: unknown) => MaybePromise<unknown>
  _call?: (input: unknown, runManager?: unknown, config?: unknown) => MaybePromise<unknown>
  [key: string]: unknown
}

export type ToolCallInput = Record<string, unknown>

export type ToolExecutionContext = {
  tool: LangChainToolLike
  toolName: string
  toolCallId: string
  input: unknown
}

export type ToolWrapperOptions = {
  getMessages?: () => MaybePromise<unknown[] | DebugRunMessage[] | undefined>
  getTools?: () => MaybePromise<unknown[] | DebugRunTool[] | undefined>
  getConstraints?: () => MaybePromise<DebugConstraintSnapshot[] | undefined>
  getConfig?: () => MaybePromise<Record<string, unknown> | undefined>
  getToolCallId?: (context: Omit<ToolExecutionContext, 'toolCallId'>) => string
  inputToToolCallInput?: (input: unknown, context: ToolExecutionContext) => ToolCallInput
  resumeInputToToolInput?: (
    input: ToolCallInput,
    originalInput: unknown,
    context: ToolExecutionContext,
  ) => unknown
  onResume?: (resume: LiveDebugWaitResponse, context: ToolExecutionContext) => MaybePromise<void>
}

export type LangChainDebugAdapterOptions = {
  debugger?: LlmImplDebugger
  debuggerOptions?: LlmImplDebuggerOptions
  sessionId?: string
  runId?: string
  userId?: string
  metadata?: Record<string, unknown>
  getMessages?: () => MaybePromise<unknown[] | DebugRunMessage[] | undefined>
  getTools?: () => MaybePromise<unknown[] | DebugRunTool[] | undefined>
  getConstraints?: () => MaybePromise<DebugConstraintSnapshot[] | undefined>
  getMetadata?: () => MaybePromise<Record<string, unknown> | undefined>
  getConfig?: () => MaybePromise<Record<string, unknown> | undefined>
}

export type SubmitLangChainRunInput = {
  system?: string
  messages?: unknown[] | DebugRunMessage[]
  tools?: unknown[] | DebugRunTool[]
  events?: DebugRunEvent[]
  constraints?: DebugConstraintSnapshot[]
  metadata?: Record<string, unknown>
  lastRun?: {
    timestamp?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    latency_ms?: number
    stop_reason?: string | null
  }
}

export type LangChainDebugAdapter = {
  debugger: LlmImplDebugger
  callbackHandler: Record<string, unknown>
  events: DebugRunEvent[]
  wrapTool: <T extends LangChainToolLike>(tool: T, options?: ToolWrapperOptions) => T
  wrapTools: <T extends LangChainToolLike>(tools: T[], options?: ToolWrapperOptions) => T[]
  submitRun: (input?: SubmitLangChainRunInput) => Promise<DebugRunSubmitResult | null>
  recordEvent: (type: string, data?: unknown) => void
}

export class LlmImplDebugAbortError extends Error {
  readonly resume: Extract<LiveDebugResumeAction, { action: 'abort' }>

  constructor(resume: Extract<LiveDebugResumeAction, { action: 'abort' }>) {
    super(resume.reason ?? 'aborted from llm-impl')
    this.name = 'LlmImplDebugAbortError'
    this.resume = resume
  }
}

let generatedCallId = 0

function nextToolCallId(toolName: string): string {
  generatedCallId += 1
  const cleanName = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'tool'
  return `lc_${cleanName}_${Date.now()}_${generatedCallId}`
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function normalizeDebugToolCall(raw: unknown): DebugRunToolCall | null {
  const record = objectRecord(raw)
  if (!record) return null

  const fn = objectRecord(record.function)
  if (fn) {
    const name = stringValue(fn.name)
    if (!name) return null
    return {
      id: stringValue(record.id),
      type: 'function',
      function: {
        name,
        arguments:
          typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {}),
      },
    }
  }

  const name = stringValue(record.name)
  if (!name) return null
  return {
    id: stringValue(record.id),
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(record.args ?? record.arguments ?? {}),
    },
  }
}

function normalizeDebugToolCalls(raw: unknown): DebugRunMessage['toolCalls'] | undefined {
  if (!Array.isArray(raw)) return undefined
  const calls = raw.flatMap((item) => {
    const call = normalizeDebugToolCall(item)
    return call ? [call] : []
  })
  return calls.length > 0 ? calls : undefined
}

function defaultInputToToolCallInput(input: unknown): ToolCallInput {
  return objectRecord(input) ?? { input }
}

function defaultResumeInputToToolInput(
  input: ToolCallInput,
  originalInput: unknown,
): unknown {
  if (!objectRecord(originalInput) && Object.prototype.hasOwnProperty.call(input, 'input')) {
    return input.input
  }
  return input
}

function readMessageType(message: Record<string, unknown>): string | undefined {
  if (typeof message.role === 'string') return message.role
  if (typeof message.type === 'string') return message.type
  if (typeof message._getType === 'function') {
    try {
      const type = message._getType()
      if (typeof type === 'string') return type
    } catch {
      return undefined
    }
  }
  if (typeof message.getType === 'function') {
    try {
      const type = message.getType()
      if (typeof type === 'string') return type
    } catch {
      return undefined
    }
  }
  return undefined
}

function roleFromLangChainType(type: string | undefined): DebugRunMessage['role'] {
  if (type === 'system') return 'system'
  if (type === 'human' || type === 'user') return 'user'
  if (type === 'ai' || type === 'assistant') return 'assistant'
  if (type === 'tool' || type === 'function') return 'tool'
  return 'user'
}

export function toDebugMessage(message: unknown): DebugRunMessage {
  const record = objectRecord(message)
  if (!record) return { role: 'user', content: message }

  const additionalKwargs = objectRecord(record.additional_kwargs)
  const responseMetadata = objectRecord(record.response_metadata)
  const type = readMessageType(record)
  const toolCalls = normalizeDebugToolCalls(
    record.toolCalls ?? record.tool_calls ?? additionalKwargs?.tool_calls,
  )
  const toolCallId = record.toolCallId ?? record.tool_call_id

  return {
    role: roleFromLangChainType(type),
    content: record.content,
    ...(typeof toolCallId === 'string' && { toolCallId }),
    ...(toolCalls && { toolCalls }),
    ...(responseMetadata && { streamEvents: [{ type: 'response_metadata', data: responseMetadata }] }),
  }
}

export function toDebugMessages(messages: unknown[] | undefined): DebugRunMessage[] {
  if (!messages) return []
  const flattened = messages.flatMap((message) =>
    Array.isArray(message) ? message : [message],
  )
  return flattened.map((message) => toDebugMessage(message))
}

function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  const record = objectRecord(schema)
  if (!record) {
    return { type: 'object', additionalProperties: true }
  }
  if (typeof record.toJSON === 'function') {
    try {
      const json = record.toJSON()
      const jsonRecord = objectRecord(json)
      if (jsonRecord) return jsonRecord
    } catch {
      return { type: 'object', additionalProperties: true }
    }
  }
  if (record.type || record.properties || record.$schema) return record
  return { type: 'object', additionalProperties: true }
}

export function toDebugTool(tool: unknown): DebugRunTool {
  const record = objectRecord(tool) ?? {}
  const name = stringValue(record.name) ?? 'tool'
  const description = stringValue(record.description)
  const schema = record.schema ?? record.argsSchema ?? record.args_schema
  return {
    name,
    ...(description && { description }),
    input_schema: schemaToJsonSchema(schema),
  }
}

export function toDebugTools(tools: unknown[] | undefined): DebugRunTool[] {
  return (tools ?? []).map((tool) => toDebugTool(tool))
}

async function resolveDebugMessages(
  input?: unknown[] | DebugRunMessage[],
): Promise<DebugRunMessage[]> {
  return toDebugMessages(input as unknown[] | undefined)
}

async function resolveDebugTools(input?: unknown[] | DebugRunTool[]): Promise<DebugRunTool[]> {
  return toDebugTools(input as unknown[] | undefined)
}

function createCallbackHandler(input: {
  debug: LlmImplDebugger
  events: DebugRunEvent[]
  getTools?: () => MaybePromise<unknown[] | DebugRunTool[] | undefined>
  getMessages?: () => MaybePromise<unknown[] | DebugRunMessage[] | undefined>
}): Record<string, unknown> {
  const toolRuns = new Map<string, { toolName: string; startedAt: number }>()

  const record = (type: string, data?: unknown) => {
    const event = { type, timestamp: Date.now(), data: safeJson(data) } satisfies DebugRunEvent
    input.events.push(event)
    input.debug.record(type, event.data)
  }

  return {
    name: 'llm_impl_debug_callback_handler',

    async handleChatModelStart(llm: unknown, messages: unknown[], runId?: string) {
      const tools = await input.getTools?.()
      input.debug.modelStart({
        model: stringValue(objectRecord(llm)?.model) ?? stringValue(objectRecord(llm)?.modelName),
        provider: stringValue(objectRecord(llm)?.provider),
        baseUrl: stringValue(objectRecord(llm)?.baseUrl),
        messages: toDebugMessages(messages),
        tools: toDebugTools(tools as unknown[] | undefined),
      })
      record('langchain_chat_model_start', { runId, llm })
    },

    async handleLLMStart(llm: unknown, prompts: string[], runId?: string) {
      const tools = await input.getTools?.()
      input.debug.modelStart({
        model: stringValue(objectRecord(llm)?.model) ?? stringValue(objectRecord(llm)?.modelName),
        provider: stringValue(objectRecord(llm)?.provider),
        baseUrl: stringValue(objectRecord(llm)?.baseUrl),
        messages: prompts.map((prompt) => ({ role: 'user', content: prompt })),
        tools: toDebugTools(tools as unknown[] | undefined),
      })
      record('langchain_llm_start', { runId, llm, promptsCount: prompts.length })
    },

    handleLLMNewToken(token: string, _idx?: unknown, runId?: string) {
      input.debug.modelDelta(token)
      record('langchain_llm_token', { runId, token })
    },

    handleLLMEnd(output: unknown, runId?: string) {
      record('langchain_llm_end', { runId, output })
    },

    handleLLMError(error: unknown, runId?: string) {
      record('langchain_llm_error', { runId, error: error instanceof Error ? error.message : error })
    },

    handleAgentAction(action: unknown, runId?: string) {
      record('langchain_agent_action', { runId, action })
    },

    handleAgentEnd(action: unknown, runId?: string) {
      record('langchain_agent_end', { runId, action })
    },

    handleToolStart(tool: unknown, toolInput: unknown, runId?: string) {
      const toolName = stringValue(objectRecord(tool)?.name) ?? 'tool'
      if (runId) toolRuns.set(runId, { toolName, startedAt: Date.now() })
      input.debug.toolStart({ toolName, toolCallId: runId, args: toolInput })
      record('langchain_tool_start', { runId, toolName, input: toolInput })
    },

    handleToolEnd(output: unknown, runId?: string) {
      const run = runId ? toolRuns.get(runId) : undefined
      const toolName = run?.toolName ?? 'tool'
      input.debug.toolResult({
        toolName,
        toolCallId: runId,
        result: output,
        durationMs: run ? Date.now() - run.startedAt : undefined,
      })
      if (runId) toolRuns.delete(runId)
      record('langchain_tool_end', { runId, toolName, output })
    },

    handleToolError(error: unknown, runId?: string) {
      const run = runId ? toolRuns.get(runId) : undefined
      const toolName = run?.toolName ?? 'tool'
      input.debug.toolResult({
        toolName,
        toolCallId: runId,
        result: error instanceof Error ? error.message : error,
        durationMs: run ? Date.now() - run.startedAt : undefined,
        isError: true,
      })
      if (runId) toolRuns.delete(runId)
      record('langchain_tool_error', { runId, toolName, error: error instanceof Error ? error.message : error })
    },

    async handleChainEnd(output: unknown, runId?: string) {
      const messages = await input.getMessages?.()
      record('langchain_chain_end', {
        runId,
        output,
        messagesCount: Array.isArray(messages) ? messages.length : undefined,
      })
    },

    handleChainError(error: unknown, runId?: string) {
      record('langchain_chain_error', { runId, error: error instanceof Error ? error.message : error })
    },
  }
}

export async function executeToolWithLlmImplDebug<T = unknown>(input: {
  debugger: LlmImplDebugger
  tool: LangChainToolLike
  toolName?: string
  toolCallId?: string
  toolInput: unknown
  execute: (toolInput: unknown) => MaybePromise<T>
  options?: ToolWrapperOptions
}): Promise<T> {
  const toolName = input.toolName ?? input.tool.name ?? 'tool'
  const contextWithoutId = { tool: input.tool, toolName, input: input.toolInput }
  const toolCallId =
    input.toolCallId ??
    input.options?.getToolCallId?.(contextWithoutId) ??
    nextToolCallId(toolName)
  const context = { ...contextWithoutId, toolCallId }
  const toToolCallInput = input.options?.inputToToolCallInput ?? defaultInputToToolCallInput
  const resumeInputToToolInput =
    input.options?.resumeInputToToolInput ?? defaultResumeInputToToolInput

  const pause = await input.debugger.beforeToolCall({
    toolCall: {
      id: toolCallId,
      name: toolName,
      input: toToolCallInput(input.toolInput, context),
    },
    messages: await resolveDebugMessages((await input.options?.getMessages?.()) as unknown[] | undefined),
    tools: await resolveDebugTools((await input.options?.getTools?.()) as unknown[] | undefined),
    constraints: await input.options?.getConstraints?.(),
    config: await input.options?.getConfig?.(),
  })

  let finalInput = input.toolInput
  if (pause.paused && pause.pauseId) {
    const resume = await input.debugger.waitForToolResume(pause.pauseId)
    await input.options?.onResume?.(resume, context)

    if (resume.action === 'abort') {
      throw new LlmImplDebugAbortError({ action: 'abort', reason: resume.reason })
    }
    if (resume.action === 'override_input' && resume.input) {
      finalInput = resumeInputToToolInput(resume.input, input.toolInput, context)
    }
    if (resume.action === 'mock_result') {
      input.debugger.toolResult({
        toolName,
        toolCallId,
        result: resume.result,
        isError: resume.isError,
        durationMs: 0,
      })
      return resume.result as T
    }
  }

  input.debugger.toolStart({ toolName, toolCallId, args: finalInput })
  const startedAt = Date.now()
  try {
    const result = await input.execute(finalInput)
    input.debugger.toolResult({
      toolName,
      toolCallId,
      result,
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (error) {
    input.debugger.toolResult({
      toolName,
      toolCallId,
      result: error instanceof Error ? error.message : error,
      durationMs: Date.now() - startedAt,
      isError: true,
    })
    throw error
  }
}

export function wrapLangChainTool<T extends LangChainToolLike>(
  debug: LlmImplDebugger,
  tool: T,
  options: ToolWrapperOptions = {},
): T {
  const wrapped = Object.create(Object.getPrototypeOf(tool)) as T
  Object.assign(wrapped, tool)

  const originalInvoke = typeof tool.invoke === 'function' ? tool.invoke.bind(tool) : undefined
  const originalCall = typeof tool.call === 'function' ? tool.call.bind(tool) : undefined
  const originalUnderscoreCall = typeof tool._call === 'function' ? tool._call.bind(tool) : undefined

  if (originalInvoke) {
    wrapped.invoke = ((toolInput: unknown, config?: unknown) =>
      executeToolWithLlmImplDebug({
        debugger: debug,
        tool,
        toolInput,
        execute: (nextInput) => originalInvoke(nextInput, config),
        options,
      })) as T['invoke']
  }

  if (originalCall) {
    wrapped.call = ((toolInput: unknown, config?: unknown) =>
      executeToolWithLlmImplDebug({
        debugger: debug,
        tool,
        toolInput,
        execute: (nextInput) => originalCall(nextInput, config),
        options,
      })) as T['call']
  }

  if (originalUnderscoreCall) {
    wrapped._call = ((toolInput: unknown, runManager?: unknown, config?: unknown) =>
      executeToolWithLlmImplDebug({
        debugger: debug,
        tool,
        toolInput,
        execute: (nextInput) => originalUnderscoreCall(nextInput, runManager, config),
        options,
      })) as T['_call']
  }

  return wrapped
}

export function createLangChainDebugAdapter(
  options: LangChainDebugAdapterOptions,
): LangChainDebugAdapter {
  const debug =
    options.debugger ??
    createLlmImplDebugger({
      ...(options.debuggerOptions ?? { project: 'langchain' }),
    })
  const events: DebugRunEvent[] = []

  debug.runStart({
    sessionId: options.sessionId,
    runId: options.runId,
    userId: options.userId,
    metadata: options.metadata,
  })

  const recordEvent = (type: string, data?: unknown) => {
    const event = { type, timestamp: Date.now(), data: safeJson(data) } satisfies DebugRunEvent
    events.push(event)
    debug.record(type, event.data)
  }

  const callbackHandler = createCallbackHandler({
    debug,
    events,
    getTools: options.getTools,
    getMessages: options.getMessages,
  })

  return {
    debugger: debug,
    callbackHandler,
    events,
    recordEvent,
    wrapTool: <T extends LangChainToolLike>(tool: T, wrapperOptions: ToolWrapperOptions = {}) =>
      wrapLangChainTool(debug, tool, {
        getMessages: options.getMessages,
        getTools: options.getTools,
        getConstraints: options.getConstraints,
        getConfig: options.getConfig,
        ...wrapperOptions,
      }),
    wrapTools: <T extends LangChainToolLike>(tools: T[], wrapperOptions: ToolWrapperOptions = {}) =>
      tools.map((tool) =>
        wrapLangChainTool(debug, tool, {
          getMessages: options.getMessages,
          getTools: options.getTools,
          getConstraints: options.getConstraints,
          getConfig: options.getConfig,
          ...wrapperOptions,
        }),
      ),
    submitRun: async (input: SubmitLangChainRunInput = {}) => {
      const messages = input.messages ?? (await options.getMessages?.())
      const tools = input.tools ?? (await options.getTools?.())
      const metadata = {
        ...(await options.getMetadata?.()),
        ...(input.metadata ?? {}),
      }
      return debug.submitRun({
        system: input.system,
        messages: toDebugMessages(messages as unknown[] | undefined),
        tools: toDebugTools(tools as unknown[] | undefined),
        events: input.events ?? events,
        constraints: input.constraints ?? (await options.getConstraints?.()),
        metadata,
        lastRun: input.lastRun,
      })
    },
  }
}

export const createLangGraphDebugAdapter = createLangChainDebugAdapter
export const wrapLangGraphTool = wrapLangChainTool
export const wrapLangGraphTools = <T extends LangChainToolLike>(
  debug: LlmImplDebugger,
  tools: T[],
  options: ToolWrapperOptions = {},
): T[] => tools.map((tool) => wrapLangChainTool(debug, tool, options))
