import http from 'node:http'
import https from 'node:https'

export type DebugRunMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  toolCallId?: string
  tool_call_id?: string
  toolCalls?: DebugRunToolCall[]
  tool_calls?: DebugRunToolCall[]
  streamEvents?: DebugRunEvent[]
  stream_events?: DebugRunEvent[]
}

export type DebugRunToolCall = {
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export type DebugRunTool =
  | {
      name: string
      description?: string
      input_schema: Record<string, unknown>
    }
  | {
      type: 'function'
      function: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }

export type DebugRunUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type DebugConstraintSnapshot = {
  kind?: 'plan' | 'policy' | 'approval' | 'budget' | 'guardrail' | 'custom'
  name?: string
  status?: 'ok' | 'blocked' | 'violated' | 'waiting' | 'completed'
  currentStep?: string
  progressText?: string
  allowedTools?: string[]
  requiredTools?: string[]
  forbiddenTools?: string[]
  violation?: {
    message: string
    retryable?: boolean
  }
  raw?: unknown
  [key: string]: unknown
}

export type DebugCaseRouting = {
  group?: string | string[]
  name?: string
  [key: string]: unknown
}

export type DebugRunPayload = {
  source: {
    project: string
    sessionId?: string
    runId?: string
    userId?: string
  }
  caseRouting?: DebugCaseRouting
  config: {
    provider?: string
    model: string
    api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
    baseUrl?: string
    temperature?: number
    max_tokens?: number
  }
  system?: string
  tools?: DebugRunTool[]
  messages?: DebugRunMessage[]
  events?: DebugRunEvent[]
  constraints?: DebugConstraintSnapshot[]
  metadata?: Record<string, unknown>
  lastRun?: {
    timestamp?: string
    usage?: DebugRunUsage
    latency_ms?: number
    stop_reason?: string | null
  }
}

export type DebugRunEvent = {
  type: string
  timestamp?: number
  data?: unknown
}

export type DebugRunSubmitResult = {
  ok: boolean
  id: string
  casePath?: string
  debugUrl: string
  skipped?: boolean
  reason?: string
}

export type LiveDebugToolCall = {
  id: string
  name: string
  input?: Record<string, unknown>
}

export type LiveDebugToolCallResponse = {
  paused: boolean
  action?: 'continue'
  pauseId?: string
  casePath?: string
}

export type LiveDebugResumeAction =
  | { action: 'continue' }
  | { action: 'override_input'; input: Record<string, unknown> }
  | { action: 'mock_result'; result: unknown; isError?: boolean }
  | { action: 'abort'; reason?: string }

export type LiveDebugWaitResponse = LiveDebugResumeAction & {
  status: 'continued' | 'timeout' | 'abandoned' | 'aborted'
}

export type LlmImplDebuggerOptions = {
  endpoint?: string
  project: string
  enabled?: boolean
  provider?: string
  model?: string
  api?: DebugRunPayload['config']['api']
  baseUrl?: string
  caseRouting?: DebugCaseRouting
  redact?: string[]
  timeoutMs?: number
  liveWaitTimeoutMs?: number
  onError?: (error: Error) => void
}

type RequestOptions = {
  method: 'POST'
  headers: Record<string, string>
}

const DEFAULT_ENDPOINT = 'http://localhost:3181'
const DEFAULT_TIMEOUT_MS = 2500
const DEFAULT_LIVE_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_REDACT_KEYS = [
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
]

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function shouldRedact(key: string, redactKeys: string[]): boolean {
  const normalized = key.toLowerCase()
  return redactKeys.some((item) => normalized.includes(item.toLowerCase()))
}

function redactValue(value: unknown, redactKeys: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactKeys))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = shouldRedact(key, redactKeys)
      ? '[redacted]'
      : redactValue(child, redactKeys)
  }
  return out
}

function postJson<T>(url: string, payload: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const target = new URL(url)
  const body = JSON.stringify(payload)
  const transport = target.protocol === 'https:' ? https : http
  const options: RequestOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(target, options, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        data += chunk
      })
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`llm-impl debug import failed (${res.statusCode}): ${data}`))
          return
        }
        try {
          resolve(JSON.parse(data) as T)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })

    const timer = setTimeout(() => {
      req.destroy(new Error(`llm-impl debug request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.on('close', () => clearTimeout(timer))
    req.write(body)
    req.end()
  })
}

export class LlmImplDebugger {
  private readonly endpoint: string
  private readonly project: string
  private readonly enabled: boolean
  private readonly redactKeys: string[]
  private readonly onError?: (error: Error) => void
  private readonly defaults: Partial<DebugRunPayload['config']>
  private readonly caseRouting?: DebugCaseRouting
  private readonly timeoutMs: number
  private readonly liveWaitTimeoutMs: number
  private events: DebugRunEvent[] = []
  private messages: DebugRunMessage[] = []
  private tools: DebugRunTool[] = []
  private runId?: string
  private sessionId?: string
  private userId?: string

  constructor(options: LlmImplDebuggerOptions) {
    this.endpoint = (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.project = options.project
    this.enabled = options.enabled ?? true
    this.redactKeys = [...DEFAULT_REDACT_KEYS, ...(options.redact ?? [])]
    this.onError = options.onError
    this.caseRouting = options.caseRouting
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.liveWaitTimeoutMs = options.liveWaitTimeoutMs ?? DEFAULT_LIVE_WAIT_TIMEOUT_MS
    this.defaults = {
      provider: options.provider,
      model: options.model,
      api: options.api,
      baseUrl: options.baseUrl,
    }
  }

  runStart(input: { sessionId?: string; runId?: string; userId?: string; metadata?: unknown } = {}): void {
    if (!this.enabled) return
    this.sessionId = input.sessionId
    this.runId = input.runId
    this.userId = input.userId
    this.record('run_start', input.metadata)
  }

  modelStart(input: {
    model?: string
    provider?: string
    baseUrl?: string
    messages: DebugRunMessage[]
    tools?: DebugRunTool[]
  }): void {
    if (!this.enabled) return
    this.messages = cloneJson(input.messages)
    this.tools = cloneJson(input.tools ?? [])
    Object.assign(this.defaults, {
      model: input.model ?? this.defaults.model,
      provider: input.provider ?? this.defaults.provider,
      baseUrl: input.baseUrl ?? this.defaults.baseUrl,
    })
    this.record('model_start', {
      model: this.defaults.model,
      provider: this.defaults.provider,
      messagesCount: this.messages.length,
      toolsCount: this.tools.length,
    })
  }

  modelDelta(chunk: unknown): void {
    this.record('model_delta', chunk)
  }

  assistantMessage(input: { content: string; toolCalls?: DebugRunToolCall[] }): void {
    this.record('assistant_message', input)
  }

  toolStart(input: { toolCallId?: string; toolName: string; args?: unknown }): void {
    this.record('tool_start', input)
  }

  toolResult(input: {
    toolCallId?: string
    toolName: string
    result?: unknown
    durationMs?: number
    isError?: boolean
  }): void {
    this.record('tool_result', input)
  }

  planEvent(type: string, data?: unknown): void {
    this.record(`plan_${type}`, data)
  }

  runEnd(data?: unknown): void {
    this.record('run_end', data)
  }

  record(type: string, data?: unknown): void {
    if (!this.enabled) return
    this.events.push({ type, timestamp: Date.now(), data })
  }

  async submitRun(input: {
    config?: Partial<DebugRunPayload['config']>
    system?: string
    messages?: DebugRunMessage[]
    tools?: DebugRunTool[]
    events?: DebugRunEvent[]
    constraints?: DebugConstraintSnapshot[]
    caseRouting?: DebugCaseRouting
    metadata?: Record<string, unknown>
    lastRun?: DebugRunPayload['lastRun']
  }): Promise<DebugRunSubmitResult | null> {
    if (!this.enabled) return null

    const model = input.config?.model ?? this.defaults.model
    if (!model) {
      this.handleError(new Error('llm-impl debugger requires a model before submitRun'))
      return null
    }

    const payload: DebugRunPayload = {
      source: {
        project: this.project,
        sessionId: this.sessionId,
        runId: this.runId,
        userId: this.userId,
      },
      caseRouting: input.caseRouting ?? this.caseRouting,
      config: {
        ...this.defaults,
        ...input.config,
        model,
      },
      system: input.system,
      messages: input.messages ?? this.messages,
      tools: input.tools ?? this.tools,
      events: input.events ?? this.events,
      constraints: input.constraints,
      metadata: input.metadata,
      lastRun: input.lastRun,
    }

    try {
      const redacted = redactValue(payload, this.redactKeys) as DebugRunPayload
      return await postJson<DebugRunSubmitResult>(
        `${this.endpoint}/api/debug-runs`,
        redacted,
        this.timeoutMs,
      )
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  async beforeToolCall(input: {
    toolCall: LiveDebugToolCall
    messages?: DebugRunMessage[]
    tools?: DebugRunTool[]
    events?: DebugRunEvent[]
    constraints?: DebugConstraintSnapshot[]
    caseRouting?: DebugCaseRouting
    config?: Partial<DebugRunPayload['config']>
  }): Promise<LiveDebugToolCallResponse> {
    if (!this.enabled) return { paused: false, action: 'continue' }

    const payload = {
      source: {
        project: this.project,
        sessionId: this.sessionId,
        runId: this.runId,
        userId: this.userId,
      },
      caseRouting: input.caseRouting ?? this.caseRouting,
      config:
        input.config || this.defaults.model
          ? {
              ...this.defaults,
              ...input.config,
            }
          : undefined,
      toolCall: input.toolCall,
      messages: input.messages ?? this.messages,
      tools: input.tools ?? this.tools,
      events: input.events ?? this.events,
      constraints: input.constraints,
    }

    try {
      const redacted = redactValue(payload, this.redactKeys)
      return await postJson<LiveDebugToolCallResponse>(
        `${this.endpoint}/api/live-debug/tool-calls`,
        redacted,
        this.timeoutMs,
      )
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return { paused: false, action: 'continue' }
    }
  }

  async waitForToolResume(pauseId: string): Promise<LiveDebugWaitResponse> {
    if (!this.enabled) return { action: 'continue', status: 'abandoned' }

    try {
      return await postJson<LiveDebugWaitResponse>(
        `${this.endpoint}/api/live-debug/pause-points/${encodeURIComponent(pauseId)}/wait`,
        {},
        this.liveWaitTimeoutMs + 5000,
      )
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return { action: 'continue', status: 'abandoned' }
    }
  }

  async resumeToolCall(
    pauseId: string,
    resume: LiveDebugResumeAction = { action: 'continue' },
  ): Promise<boolean> {
    if (!this.enabled) return false

    try {
      const result = await postJson<{ ok: boolean }>(
        `${this.endpoint}/api/live-debug/pause-points/${encodeURIComponent(pauseId)}/resume`,
        resume,
        this.timeoutMs,
      )
      return result.ok
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private handleError(error: Error): void {
    if (this.onError) {
      this.onError(error)
    }
  }
}

export function createLlmImplDebugger(options: LlmImplDebuggerOptions): LlmImplDebugger {
  return new LlmImplDebugger(options)
}
