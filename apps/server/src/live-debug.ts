import { randomUUID } from 'node:crypto'
import type {
  DebugRunRequest,
  LiveDebugPausePoint,
  LiveDebugPauseRequest,
  LiveDebugSettings,
  LiveDebugStateResponse,
  LiveDebugToolCallResponse,
  LiveDebugWaitResponse,
} from '@llm-impl/shared'
import { writeCase } from './cases'
import { buildDebugRunCase } from './debug-runs'

type StoredPausePoint = LiveDebugPausePoint & {
  config?: LiveDebugPauseRequest['config']
  lastRun?: DebugRunRequest['lastRun']
  metadata?: Record<string, unknown>
  messages: unknown[]
  tools: unknown[]
  events: unknown[]
}

type Waiter = {
  resolve: (value: LiveDebugWaitResponse) => void
  timer: ReturnType<typeof setTimeout>
  cleanup?: () => void
}

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_PAUSE_POINTS = 80
const COMPLETED_TTL_MS = 60 * 60 * 1000

let settings: LiveDebugSettings = {
  enabled: false,
  pauseAll: false,
  toolNames: [],
}

const pausePoints = new Map<string, StoredPausePoint>()
const waiters = new Map<string, Waiter>()

function nowIso(): string {
  return new Date().toISOString()
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

function normalizeSettings(input: LiveDebugSettings): LiveDebugSettings {
  const toolNames = Array.from(
    new Set(input.toolNames.map((name) => name.trim()).filter(Boolean)),
  )
  return {
    enabled: input.enabled,
    pauseAll: input.pauseAll,
    toolNames,
  }
}

function visiblePausePoint(point: StoredPausePoint): LiveDebugPausePoint {
  return {
    id: point.id,
    status: point.status,
    source: point.source,
    toolCall: point.toolCall,
    casePath: point.casePath,
    createdAt: point.createdAt,
    resumedAt: point.resumedAt,
    plan: point.plan,
    messagesCount: point.messagesCount,
    toolsCount: point.toolsCount,
    eventsCount: point.eventsCount,
  }
}

function shouldPause(toolName: string): boolean {
  if (!settings.enabled) return false
  if (settings.pauseAll) return true
  return settings.toolNames.some((name) => name === '*' || name === toolName)
}

function liveCasePath(input: Pick<LiveDebugPauseRequest, 'source'>): string {
  const project = slug(input.source.project, 'live')
  const session = slug(input.source.sessionId ?? input.source.runId, 'session')
  return `live/${project}/${session}.json`
}

function defaultLiveConfig(point: StoredPausePoint): DebugRunRequest['config'] {
  return (
    point.config ?? {
      provider: point.source.project,
      model: 'live-debug',
    }
  )
}

async function writeLiveCase(point: StoredPausePoint): Promise<void> {
  if (!point.casePath) return

  const input: DebugRunRequest = {
    source: point.source,
    config: defaultLiveConfig(point),
    messages: point.messages,
    tools: point.tools,
    events: point.events,
    metadata: {
      ...(point.metadata ?? {}),
      live: true,
      pauseId: point.id,
      status: point.status,
      toolCall: point.toolCall,
      plan: point.plan,
    },
    lastRun: point.lastRun,
  }

  const caseData = buildDebugRunCase(input, {
    id: point.source.runId ?? point.id,
    now: point.resumedAt ?? point.createdAt,
    name: `live ${point.source.project} ${point.source.sessionId ?? point.source.runId ?? point.id}`,
    tags: ['live-debug', point.source.project],
    debugLive: {
      status: point.status,
      pauseId: point.id,
      casePath: point.casePath,
      toolCallId: point.toolCall.id,
      toolName: point.toolCall.name,
      plan: point.plan,
    },
  })
  await writeCase(point.casePath, caseData)
}

async function settlePause(
  pauseId: string,
  status: LiveDebugWaitResponse['status'],
): Promise<boolean> {
  const point = pausePoints.get(pauseId)
  if (!point) return false

  if (point.status === 'paused') {
    point.status = status
    point.resumedAt = nowIso()
  }

  await writeLiveCase(point).catch(() => undefined)

  const waiter = waiters.get(pauseId)
  if (waiter) {
    clearTimeout(waiter.timer)
    if (waiter.cleanup) waiter.cleanup()
    waiters.delete(pauseId)
    waiter.resolve({ action: 'continue', status })
  }

  return true
}

function prunePausePoints(): void {
  const now = Date.now()
  for (const [id, point] of pausePoints) {
    if (point.status === 'paused') continue
    const createdAt = new Date(point.createdAt).getTime()
    if (Number.isFinite(createdAt) && now - createdAt > COMPLETED_TTL_MS) {
      pausePoints.delete(id)
    }
  }

  if (pausePoints.size <= MAX_PAUSE_POINTS) return

  const removable = Array.from(pausePoints.values())
    .filter((point) => point.status !== 'paused')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  for (const point of removable) {
    if (pausePoints.size <= MAX_PAUSE_POINTS) break
    pausePoints.delete(point.id)
  }
}

async function syncLatestLiveCases(): Promise<void> {
  const latestByCasePath = new Map<string, StoredPausePoint>()
  for (const point of pausePoints.values()) {
    if (!point.casePath) continue
    const existing = latestByCasePath.get(point.casePath)
    if (!existing || point.createdAt.localeCompare(existing.createdAt) > 0) {
      latestByCasePath.set(point.casePath, point)
    }
  }

  await Promise.allSettled(
    Array.from(latestByCasePath.values()).map((point) => writeLiveCase(point)),
  )
}

export async function getLiveDebugState(): Promise<LiveDebugStateResponse> {
  prunePausePoints()
  await syncLatestLiveCases()
  return {
    settings,
    pausePoints: Array.from(pausePoints.values())
      .map(visiblePausePoint)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }
}

export function updateLiveDebugSettings(input: LiveDebugSettings): LiveDebugSettings {
  settings = normalizeSettings(input)
  return settings
}

export async function registerLiveDebugToolCall(
  input: LiveDebugPauseRequest,
): Promise<LiveDebugToolCallResponse> {
  prunePausePoints()

  if (!shouldPause(input.toolCall.name)) {
    return { paused: false, action: 'continue' }
  }

  const pauseId = randomUUID()
  const casePath = liveCasePath(input)
  const point: StoredPausePoint = {
    id: pauseId,
    status: 'paused',
    source: input.source,
    config: input.config,
    toolCall: input.toolCall,
    casePath,
    createdAt: nowIso(),
    plan: input.plan,
    messages: input.messages,
    tools: input.tools,
    events: input.events,
    messagesCount: input.messages.length,
    toolsCount: input.tools.length,
    eventsCount: input.events.length,
  }
  pausePoints.set(pauseId, point)
  await writeLiveCase(point)

  return { paused: true, pauseId, casePath }
}

export async function syncLiveDebugCaseFromRun(input: DebugRunRequest): Promise<void> {
  const casePath = liveCasePath(input)
  const point = Array.from(pausePoints.values())
    .filter((candidate) => candidate.casePath === casePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]

  if (!point || point.status === 'paused') return

  point.config = input.config
  point.lastRun = input.lastRun
  point.metadata = input.metadata
  point.messages = input.messages
  point.tools = input.tools
  point.events = input.events
  point.messagesCount = input.messages.length
  point.toolsCount = input.tools.length
  point.eventsCount = input.events.length

  await writeLiveCase(point)
}

export function waitForLiveDebugPause(
  pauseId: string,
  signal?: AbortSignal,
): Promise<LiveDebugWaitResponse> {
  const point = pausePoints.get(pauseId)
  if (!point) return Promise.resolve({ action: 'continue', status: 'abandoned' })
  if (point.status !== 'paused') {
    return Promise.resolve({ action: 'continue', status: point.status })
  }

  return new Promise((resolve) => {
    const finish = (status: LiveDebugWaitResponse['status']) => {
      void settlePause(pauseId, status)
    }

    const timer = setTimeout(() => {
      finish('timeout')
    }, DEFAULT_WAIT_TIMEOUT_MS)

    const abort = () => {
      finish('abandoned')
    }

    waiters.set(pauseId, { resolve, timer })

    if (signal) {
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      const waiter = waiters.get(pauseId)
      if (waiter) {
        waiter.cleanup = () => signal.removeEventListener('abort', abort)
      }
    }
  })
}

export function resumeLiveDebugPause(pauseId: string): Promise<boolean> {
  return settlePause(pauseId, 'continued')
}
