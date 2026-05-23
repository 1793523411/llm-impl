import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  McpCallToolResponse,
  McpServerConfig,
  McpToolConfig,
} from '@llm-impl/shared'

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

const DEFAULT_TIMEOUT_MS = 15_000

function inputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function stringifyResult(result: unknown): { content: string; is_error?: boolean } {
  if (!result || typeof result !== 'object') {
    return { content: result === undefined ? '' : String(result) }
  }

  const record = result as Record<string, unknown>
  const isError = record.isError === true
  if (Array.isArray(record.content)) {
    const content = record.content
      .map((item) => {
        if (!item || typeof item !== 'object') return String(item)
        const block = item as Record<string, unknown>
        if (block.type === 'text') return String(block.text ?? '')
        if (block.type === 'image') {
          const mimeType = String(block.mimeType ?? 'image')
          const data = typeof block.data === 'string' ? block.data : ''
          return `[${mimeType}, ${data.length} chars base64]`
        }
        return JSON.stringify(block)
      })
      .join('\n')
    return { content, ...(isError && { is_error: true }) }
  }

  return {
    content: JSON.stringify(result, null, 2),
    ...(isError && { is_error: true }),
  }
}

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stderrBuffer = ''

  constructor(private server: McpServerConfig) {
    const command = server.command?.trim()
    if (!command) throw new Error('MCP stdio command is required')
    this.child = spawn(command, server.args ?? [], {
      env: {
        ...process.env,
        ...(server.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-12_000)
    })
    this.child.on('error', (error) => this.rejectAll(error))
    this.child.on('exit', (code, signal) => {
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(`MCP server exited before response (code=${code}, signal=${signal})`),
        )
      }
    })
  }

  get stderr(): string {
    return this.stderrBuffer.trim()
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'llm-impl',
        version: '0.1.0',
      },
    })
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<McpToolConfig[]> {
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: unknown[] } | null)?.tools ?? []
    return tools
      .filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
      .map((tool) => ({
        name: String(tool.name ?? ''),
        description:
          typeof tool.description === 'string' ? tool.description : undefined,
        input_schema:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        enabled: true,
      }))
      .filter((tool) => tool.name)
  }

  async callTool(
    toolName: string,
    input: unknown,
  ): Promise<McpCallToolResponse> {
    const result = await this.request('tools/call', {
      name: toolName,
      arguments: inputObject(input),
    })
    return { ...stringifyResult(result), raw: result, stderr: this.stderr || undefined }
  }

  close() {
    this.child.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }
    const timeoutMs = this.server.timeout_ms ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      this.child.stdin.write(JSON.stringify(message) + '\n')
    })
  }

  private notify(method: string, params: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  private onStdout(chunk: string) {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.onMessage(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private onMessage(line: string) {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      this.stderrBuffer = `${this.stderrBuffer}\n[invalid stdout] ${line}`.slice(-12_000)
      return
    }

    if (message.id === undefined || message.id === null) return
    const id = Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ??
            `MCP error ${message.error.code ?? ''}`.trim(),
        ),
      )
    } else {
      pending.resolve(message.result)
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

class StreamableHttpMcpClient {
  private nextId = 1
  private sessionId: string | null = null

  constructor(private server: McpServerConfig) {
    if (!server.url?.trim()) throw new Error('MCP streamablehttp url is required')
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'llm-impl',
        version: '0.1.0',
      },
    })
    await this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<McpToolConfig[]> {
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: unknown[] } | null)?.tools ?? []
    return tools
      .filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
      .map((tool) => ({
        name: String(tool.name ?? ''),
        description:
          typeof tool.description === 'string' ? tool.description : undefined,
        input_schema:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        enabled: true,
      }))
      .filter((tool) => tool.name)
  }

  async callTool(
    toolName: string,
    input: unknown,
  ): Promise<McpCallToolResponse> {
    const result = await this.request('tools/call', {
      name: toolName,
      arguments: inputObject(input),
    })
    return { ...stringifyResult(result), raw: result }
  }

  close() {
    // HTTP MCP connections are request-scoped here.
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: '2.0', method, params })
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const response = await this.send({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })
    if (!response || typeof response !== 'object') return response
    const message = response as JsonRpcResponse
    if (message.error) {
      throw new Error(message.error.message ?? `MCP error ${message.error.code ?? ''}`.trim())
    }
    return message.result
  }

  private async send(payload: unknown): Promise<unknown> {
    const timeoutMs = this.server.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.server.url!, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...(this.server.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const nextSession = res.headers.get('mcp-session-id')
      if (nextSession) this.sessionId = nextSession
      const text = await res.text()
      if (!res.ok) throw new Error(`[HTTP ${res.status}] ${text}`)
      if (!text.trim()) return undefined
      return parseHttpMcpBody(text)
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseHttpMcpBody(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
  if (dataLines.length === 0) return trimmed
  return JSON.parse(dataLines[dataLines.length - 1]!)
}

type McpClient = StdioMcpClient | StreamableHttpMcpClient

function createMcpClient(server: McpServerConfig): McpClient {
  return server.transport === 'streamablehttp'
    ? new StreamableHttpMcpClient(server)
    : new StdioMcpClient(server)
}

export async function listMcpTools(
  server: McpServerConfig,
): Promise<{ tools: McpToolConfig[]; stderr?: string }> {
  const client = createMcpClient(server)
  try {
    await client.initialize()
    const tools = await client.listTools()
    const stderr = client instanceof StdioMcpClient ? client.stderr : undefined
    return { tools, stderr: stderr || undefined }
  } finally {
    client.close()
  }
}

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  input: unknown,
): Promise<McpCallToolResponse> {
  const client = createMcpClient(server)
  try {
    await client.initialize()
    return await client.callTool(toolName, input)
  } finally {
    client.close()
  }
}
