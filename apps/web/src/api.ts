import type {
  RunRequest,
  RunResponse,
  Case,
  ProviderInfo,
  StreamEvent,
  ExecToolDef,
  ExecToolResponse,
} from '@llm-impl/shared'

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await fetch('/api/providers')
  if (!res.ok) throw new Error(`providers failed: ${res.status}`)
  return res.json()
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
): Promise<ExecToolResponse> {
  const res = await fetch('/api/exec-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  })
  if (!res.ok) throw new Error(`exec-tool failed: ${res.status}`)
  return res.json()
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

export async function deleteCase(path: string): Promise<void> {
  const res = await fetch(`/api/cases/${encodeURI(path)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete failed: ${res.status}`)
}
