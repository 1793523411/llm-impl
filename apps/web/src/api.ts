import type {
  RunRequest,
  RunResponse,
  Case,
  ProviderInfo,
  ProviderTestResponse,
  StreamEvent,
  ExecToolDef,
  ExecToolResponse,
  LiveDebugSettings,
  LiveDebugStateResponse,
  LiveDebugToolCallResponse,
  LiveDebugWaitResponse,
  LiveDebugResumeAction,
  McpCallToolResponse,
  McpListToolsResponse,
  McpServerConfig,
  SandboxConfig,
  SkillConfig,
  SkillListResponse,
} from '@llm-impl/shared'

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await fetch('/api/providers')
  if (!res.ok) throw new Error(`providers failed: ${res.status}`)
  return res.json()
}

export async function testProviderModel(
  provider: string,
  model: string,
): Promise<ProviderTestResponse> {
  const res = await fetch('/api/providers/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `provider test failed: ${res.status}`)
  return data as ProviderTestResponse
}

export async function generateCurl(
  provider: string,
  body: unknown,
  mode: 'stream' | 'non-stream',
): Promise<string> {
  const res = await fetch('/api/curl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, body, mode }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `curl failed: ${res.status}`)
  return data.curl as string
}

export async function getWorkspace(): Promise<unknown | null> {
  const res = await fetch('/api/workspace')
  if (!res.ok) throw new Error(`workspace get failed: ${res.status}`)
  return res.json()
}

export async function saveWorkspace(data: unknown): Promise<void> {
  const res = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`workspace save failed: ${res.status}`)
}

export async function postRun(req: RunRequest): Promise<RunResponse> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, config: { ...req.config, stream: false } }),
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`) as Error & {
      provider_error?: unknown
    }
    err.provider_error = data.provider_error
    throw err
  }
  return data as RunResponse
}

// NDJSON streaming run. Yields StreamEvents until the connection closes.
export async function* postRunStream(
  req: RunRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, config: { ...req.config, stream: true } }),
    signal,
  })
  if (!res.ok || !res.body) {
    let err: string
    try {
      const data = await res.json()
      err = data.error ?? `HTTP ${res.status}`
    } catch {
      err = `HTTP ${res.status}`
    }
    throw new Error(err)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line) as StreamEvent
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim()) as StreamEvent
}

export async function listExecTools(): Promise<ExecToolDef[]> {
  const res = await fetch('/api/exec-tools')
  if (!res.ok) throw new Error(`exec-tools failed: ${res.status}`)
  return res.json()
}

export async function execTool(
  name: string,
  input: unknown,
  sandbox?: SandboxConfig | null,
): Promise<ExecToolResponse> {
  const res = await fetch('/api/exec-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input, ...(sandbox && { sandbox }) }),
  })
  if (!res.ok) throw new Error(`exec-tool failed: ${res.status}`)
  return res.json()
}

export type ExecToolStreamEvent = {
  type: 'result'
  result: ExecToolResponse
}

export async function* execToolStream(
  name: string,
  input: unknown,
  sandbox?: SandboxConfig | null,
): AsyncGenerator<ExecToolStreamEvent> {
  const res = await fetch('/api/exec-tool/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input, ...(sandbox && { sandbox }) }),
  })
  if (!res.ok || !res.body) throw new Error(`exec-tool stream failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line) as ExecToolStreamEvent
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim()) as ExecToolStreamEvent
}

export async function listSkills(roots: string[]): Promise<SkillListResponse> {
  const res = await fetch('/api/skills/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `skills list failed: ${res.status}`)
  return data as SkillListResponse
}

export async function loadSkill(skill: SkillConfig): Promise<ExecToolResponse> {
  const res = await fetch('/api/skills/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.content ?? `skill load failed: ${res.status}`)
  return data as ExecToolResponse
}

export async function listMcpTools(
  server: McpServerConfig,
): Promise<McpListToolsResponse> {
  const res = await fetch('/api/mcp/list-tools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `mcp list failed: ${res.status}`)
  return data as McpListToolsResponse
}

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  input: unknown,
): Promise<McpCallToolResponse> {
  const res = await fetch('/api/mcp/call-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server, toolName, input }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `mcp call failed: ${res.status}`)
  return data as McpCallToolResponse
}

export type CaseEntry = {
  path: string
  type: 'file' | 'dir'
  children?: CaseEntry[]
}

export async function listCases(): Promise<CaseEntry[]> {
  const res = await fetch('/api/cases')
  if (!res.ok) throw new Error(`list failed: ${res.status}`)
  return res.json()
}

export async function readCase(path: string): Promise<Case> {
  const res = await fetch(`/api/cases/${encodeURI(path)}`)
  if (!res.ok) throw new Error(`read failed: ${res.status}`)
  return res.json()
}

export async function writeCase(path: string, data: Case): Promise<void> {
  const res = await fetch(`/api/cases/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
}

export async function createCaseDir(path: string): Promise<void> {
  const res = await fetch('/api/case-dirs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `mkdir failed: ${res.status}`)
}

export async function moveCaseEntry(from: string, to: string): Promise<void> {
  const res = await fetch('/api/cases/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `move failed: ${res.status}`)
  if (data.ok === false) throw new Error('source not found')
}

export async function deleteCase(path: string): Promise<void> {
  const res = await fetch(`/api/cases/${encodeURI(path)}`, { method: 'DELETE' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `delete failed: ${res.status}`)
  if (data.ok === false) throw new Error('source not found')
}

export async function getLiveDebugState(): Promise<LiveDebugStateResponse> {
  const res = await fetch('/api/live-debug/state')
  if (!res.ok) throw new Error(`live debug state failed: ${res.status}`)
  return res.json()
}

export async function updateLiveDebugSettings(
  settings: LiveDebugSettings,
): Promise<LiveDebugSettings> {
  const res = await fetch('/api/live-debug/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error ?? `live debug settings failed: ${res.status}`)
  }
  return data.settings as LiveDebugSettings
}

export async function resumeLiveDebugPause(
  pauseId: string,
  resume: LiveDebugResumeAction = { action: 'continue' },
): Promise<void> {
  const res = await fetch(`/api/live-debug/pause-points/${encodeURI(pauseId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resume),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `live debug resume failed: ${res.status}`)
  }
}

export type {
  LiveDebugSettings,
  LiveDebugStateResponse,
  LiveDebugToolCallResponse,
  LiveDebugWaitResponse,
  LiveDebugResumeAction,
}
