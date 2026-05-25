import { randomUUID } from 'node:crypto'
import type {
  DebugRunSource,
  DebugConstraintSnapshot,
  DebugRunRequest,
  LiveDebugPausePoint,
  LiveDebugPauseRequest,
  LiveDebugResumeAction,
  LiveDebugSettings,
  LiveDebugStateResponse,
  LiveDebugToolCallResponse,
  LiveDebugWaitResponse,
} from '@llm-impl/shared'
import { deleteCase, listCases, readCase, writeCase, type CaseEntry } from './cases'
import { buildDebugRunCase } from './debug-runs'

type StoredPausePoint = LiveDebugPausePoint & {
  config?: LiveDebugPauseRequest['config']
  caseRouting?: LiveDebugPauseRequest['caseRouting']
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function liveSourceKey(source: DebugRunSource): string {
  return [
    slug(source.project, 'live'),
    slug(source.sessionId ?? source.runId, 'session'),
  ].join('/')
}

function liveSourceKeyFromCase(data: unknown): string | undefined {
  const record = asRecord(data)
  const meta = asRecord(record?.meta)
  const debug = asRecord(record?.debug)
  const source = asRecord(debug?.source)
  const project = asString(source?.project) ?? asString(meta?.source)
  const sessionId = asString(source?.sessionId) ?? asString(meta?.sessionId)
  const runId = asString(source?.runId) ?? asString(meta?.runId)
  if (!project || (!sessionId && !runId)) return undefined
  return [slug(project, 'live'), slug(sessionId ?? runId, 'session')].join('/')
}

function liveMetadata(data: unknown): Record<string, unknown> | null {
  const record = asRecord(data)
  const debug = asRecord(record?.debug)
  return asRecord(debug?.live)
}

function liveUpdatedAt(data: unknown): string | undefined {
  const record = asRecord(data)
  const meta = asRecord(record?.meta)
  return asString(meta?.updatedAt)
}

function flattenCases(entries: CaseEntry[]): CaseEntry[] {
  return entries.flatMap((entry) => [entry, ...(entry.children ? flattenCases(entry.children) : [])])
}

function routeGroupSegments(route: LiveDebugPauseRequest['caseRouting']): string[] {
  const rawGroup = route?.group
  const values = Array.isArray(rawGroup) ? rawGroup : rawGroup ? [rawGroup] : []
  return values
    .flatMap((value) => value.split(/[\\/]+/))
    .map((value) => slug(value, ''))
    .filter(Boolean)
}

function routeName(route: LiveDebugPauseRequest['caseRouting']): string | undefined {
  if (!route?.name) return undefined
  return slug(route.name, '') || undefined
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
    constraints: point.constraints,
    resume: point.resume,
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

function liveCasePath(input: Pick<LiveDebugPauseRequest, 'source' | 'caseRouting'>): string {
  const project = slug(input.source.project, 'live')
  const session = slug(input.source.sessionId ?? input.source.runId, 'session')
  const name = routeName(input.caseRouting) ?? session
  return ['live', project, ...routeGroupSegments(input.caseRouting), `${name}.json`].join('/')
}

function defaultLiveConfig(point: StoredPausePoint): DebugRunRequest['config'] {
  return (
    point.config ?? {
      provider: point.source.project,
      model: 'live-debug',
    }
  )
}

function constraintsFromInput(
  input: Pick<LiveDebugPauseRequest, 'constraints' | 'plan'>,
): DebugConstraintSnapshot[] | undefined {
  if (input.constraints?.length) return input.constraints
  if (!input.plan) return undefined
  return [
    {
      kind: 'plan',
      status: 'ok',
      currentStep: input.plan.currentStep,
      progressText: input.plan.progress,
      raw: input.plan,
    },
  ]
}

function waitResponseFromResumeAction(
  resume: LiveDebugResumeAction,
): LiveDebugWaitResponse {
  return {
    ...resume,
    status: resume.action === 'abort' ? 'aborted' : 'continued',
  }
}

function resumeActionFromWaitResponse(
  response: LiveDebugWaitResponse,
): LiveDebugResumeAction | undefined {
  if (response.action === 'continue') return { action: 'continue' }
  if (response.action === 'override_input' && response.input) {
    return { action: 'override_input', input: response.input }
  }
  if (response.action === 'mock_result') {
    return {
      action: 'mock_result',
      result: response.result,
      isError: response.isError,
    }
  }
  if (response.action === 'abort') {
    return { action: 'abort', reason: response.reason }
  }
  return undefined
}

async function writeLiveCase(point: StoredPausePoint): Promise<void> {
  if (!point.casePath) return

  const input: DebugRunRequest = {
    source: point.source,
    caseRouting: point.caseRouting,
    config: defaultLiveConfig(point),
    messages: point.messages,
    tools: point.tools,
    events: point.events,
    constraints: point.constraints,
    metadata: {
      ...(point.metadata ?? {}),
      live: true,
      pauseId: point.id,
      status: point.status,
      toolCall: point.toolCall,
      plan: point.plan,
      constraints: point.constraints,
      resume: point.resume,
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
      constraints: point.constraints,
      resume: point.resume,
    },
  })
  await writeCase(point.casePath, caseData)
}

async function cleanupStaleLiveCases(point: StoredPausePoint): Promise<void> {
  if (!point.casePath) return

  const pointSourceKey = liveSourceKey(point.source)
  const pointUpdatedAt = point.resumedAt ?? point.createdAt
  const entries = flattenCases(await listCases())
  const candidates = entries.filter(
    (entry) =>
      entry.type === 'file' &&
      entry.path.startsWith('live/') &&
      entry.path.endsWith('.json') &&
      entry.path !== point.casePath,
  )

  await Promise.allSettled(
    candidates.map(async (entry) => {
      const data = await readCase(entry.path)
      if (liveSourceKeyFromCase(data) !== pointSourceKey) return

      const updatedAt = liveUpdatedAt(data)
      if (updatedAt && updatedAt.localeCompare(pointUpdatedAt) > 0) return

      const live = liveMetadata(data)
      const status = asString(live?.status)
      const pauseId = asString(live?.pauseId)
      const knownPoint = pauseId ? pausePoints.get(pauseId) : undefined
      if (status === 'paused' && knownPoint?.status === 'paused') return

      await deleteCase(entry.path)
    }),
  )
}

async function settlePause(
  pauseId: string,
  response: LiveDebugWaitResponse,
): Promise<boolean> {
  const point = pausePoints.get(pauseId)
  if (!point) return false

  if (point.status === 'paused') {
    point.status = response.status
    point.resumedAt = nowIso()
    point.resume = resumeActionFromWaitResponse(response)
  }

  await writeLiveCase(point).catch(() => undefined)
  await cleanupStaleLiveCases(point).catch(() => undefined)

  const waiter = waiters.get(pauseId)
  if (waiter) {
    clearTimeout(waiter.timer)
    if (waiter.cleanup) waiter.cleanup()
    waiters.delete(pauseId)
    waiter.resolve(response)
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
  const latestBySource = new Map<string, StoredPausePoint>()
  for (const point of pausePoints.values()) {
    if (!point.casePath) continue
    const existing = latestByCasePath.get(point.casePath)
    if (!existing || point.createdAt.localeCompare(existing.createdAt) > 0) {
      latestByCasePath.set(point.casePath, point)
    }

    const sourceKey = liveSourceKey(point.source)
    const existingSourcePoint = latestBySource.get(sourceKey)
    if (!existingSourcePoint || point.createdAt.localeCompare(existingSourcePoint.createdAt) > 0) {
      latestBySource.set(sourceKey, point)
    }
  }

  const pointsToWrite = Array.from(latestByCasePath.values()).filter((point) => {
    const latestSourcePoint = latestBySource.get(liveSourceKey(point.source))
    return point.status === 'paused' || latestSourcePoint === point
  })

  await Promise.allSettled(pointsToWrite.map((point) => writeLiveCase(point)))
  await Promise.allSettled(
    Array.from(latestBySource.values()).map((point) => cleanupStaleLiveCases(point)),
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
    caseRouting: input.caseRouting,
    config: input.config,
    toolCall: input.toolCall,
    casePath,
    createdAt: nowIso(),
    plan: input.plan,
    constraints: constraintsFromInput(input),
    messages: input.messages,
    tools: input.tools,
    events: input.events,
    messagesCount: input.messages.length,
    toolsCount: input.tools.length,
    eventsCount: input.events.length,
  }
  pausePoints.set(pauseId, point)
  await writeLiveCase(point)
  await cleanupStaleLiveCases(point).catch(() => undefined)

  return { paused: true, pauseId, casePath }
}

export async function syncLiveDebugCaseFromRun(input: DebugRunRequest): Promise<void> {
  const casePath = liveCasePath(input)
  const point = Array.from(pausePoints.values())
    .filter((candidate) => candidate.casePath === casePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]

  if (!point || point.status === 'paused') return

  point.config = input.config
  point.caseRouting = input.caseRouting
  point.lastRun = input.lastRun
  point.metadata = input.metadata
  point.messages = input.messages
  point.tools = input.tools
  point.events = input.events
  point.constraints = input.constraints ?? point.constraints
  point.messagesCount = input.messages.length
  point.toolsCount = input.tools.length
  point.eventsCount = input.events.length

  await writeLiveCase(point)
  await cleanupStaleLiveCases(point).catch(() => undefined)
}

export function waitForLiveDebugPause(
  pauseId: string,
  signal?: AbortSignal,
): Promise<LiveDebugWaitResponse> {
  const point = pausePoints.get(pauseId)
  if (!point) return Promise.resolve({ action: 'continue', status: 'abandoned' })
  if (point.status !== 'paused') {
    if (point.resume) return Promise.resolve(waitResponseFromResumeAction(point.resume))
    return Promise.resolve({ action: 'continue', status: point.status })
  }

  return new Promise((resolve) => {
    const finish = (status: LiveDebugWaitResponse['status']) => {
      void settlePause(pauseId, { action: 'continue', status })
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

export function resumeLiveDebugPause(
  pauseId: string,
  resume: LiveDebugResumeAction,
): Promise<boolean> {
  return settlePause(pauseId, waitResponseFromResumeAction(resume))
}
