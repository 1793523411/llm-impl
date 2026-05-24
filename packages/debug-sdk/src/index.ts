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

export type DebugRunPayload = {
  source: {
    project: string
    sessionId?: string
    runId?: string
    userId?: string
  }
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

export type LlmImplDebuggerOptions = {
  endpoint?: string
  project: string
  enabled?: boolean
  provider?: string
  model?: string
  api?: DebugRunPayload['config']['api']
  baseUrl?: string
  redact?: string[]
  onError?: (error: Error) => void
}

type RequestOptions = {
  method: 'POST'
  headers: Record<string, string>
}

const DEFAULT_ENDPOINT = 'http://localhost:3181'
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

function postJson<T>(url: string, payload: unknown): Promise<T> {
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

    req.on('error', reject)
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
      config: {
        ...this.defaults,
        ...input.config,
        model,
      },
      system: input.system,
      messages: input.messages ?? this.messages,
      tools: input.tools ?? this.tools,
      events: input.events ?? this.events,
      metadata: input.metadata,
      lastRun: input.lastRun,
    }

    try {
      const redacted = redactValue(payload, this.redactKeys) as DebugRunPayload
      return await postJson<DebugRunSubmitResult>(
        `${this.endpoint}/api/debug-runs`,
        redacted,
      )
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      return null
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
