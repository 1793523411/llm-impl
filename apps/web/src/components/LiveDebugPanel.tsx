import { useEffect, useMemo, useState } from 'react'
import type {
  LiveDebugPausePoint,
  LiveDebugSettings,
  LiveDebugStateResponse,
} from '@llm-impl/shared'
import * as api from '../api'
import { useStore } from '../store'

const emptyState: LiveDebugStateResponse = {
  settings: {
    enabled: false,
    pauseAll: false,
    toolNames: [],
  },
  pausePoints: [],
}

const splitToolNames = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)

function statusClass(status: LiveDebugPausePoint['status']): string {
  if (status === 'paused') return 'text-amber-400'
  if (status === 'continued') return 'text-emerald-400'
  return 'text-red-400'
}

function PausePointCard({
  point,
  onOpenCase,
}: {
  point: LiveDebugPausePoint
  onOpenCase: (casePath: string) => Promise<void>
}) {
  const [opening, setOpening] = useState(false)

  const openCase = async () => {
    if (!point.casePath) return
    setOpening(true)
    try {
      await onOpenCase(point.casePath)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="tool-library-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${statusClass(point.status)}`}>
              {point.status}
            </span>
            <code className="truncate text-xs text-zinc-200">
              {point.toolCall.name}
            </code>
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {point.source.project}
            {point.source.sessionId ? ` / ${point.source.sessionId}` : ''}
          </div>
        </div>
        <button className="btn" disabled={!point.casePath || opening} onClick={openCase}>
          {opening ? 'Opening...' : 'Open Case'}
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
        <span>messages {point.messagesCount}</span>
        <span>tools {point.toolsCount}</span>
        <span>{new Date(point.createdAt).toLocaleTimeString()}</span>
      </div>
      {point.casePath && (
        <div className="mt-1 truncate text-[10px] text-zinc-500">
          {point.casePath}
        </div>
      )}

      {point.plan?.progress && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
            plan progress
          </summary>
          <pre className="tool-schema-preview scrollbar">{point.plan.progress}</pre>
        </details>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
          tool input
        </summary>
        <pre className="tool-schema-preview scrollbar">
          {JSON.stringify(point.toolCall.input, null, 2)}
        </pre>
      </details>
    </div>
  )
}

export function LiveDebugPanel() {
  const refreshCases = useStore((s) => s.refreshCases)
  const loadCase = useStore((s) => s.loadCase)
  const [state, setState] = useState<LiveDebugStateResponse>(emptyState)
  const [toolNamesText, setToolNamesText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pausedCount = useMemo(
    () => state.pausePoints.filter((point) => point.status === 'paused').length,
    [state.pausePoints],
  )

  const load = async () => {
    try {
      const next = await api.getLiveDebugState()
      setState(next)
      setToolNamesText(next.settings.toolNames.join('\n'))
      if (next.pausePoints.some((point) => point.casePath)) {
        await refreshCases()
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const saveSettings = async (patch: Partial<LiveDebugSettings> = {}) => {
    const nextSettings: LiveDebugSettings = {
      ...state.settings,
      toolNames: splitToolNames(toolNamesText),
      ...patch,
    }
    setLoading(true)
    try {
      const saved = await api.updateLiveDebugSettings(nextSettings)
      setState((current) => ({ ...current, settings: saved }))
      setToolNamesText(saved.toolNames.join('\n'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const openCase = async (casePath: string) => {
    await refreshCases()
    await loadCase(casePath)
  }

  return (
    <div className="setup-section space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="label">global live breakpoints</div>
          <div className="mt-1 text-xs text-zinc-500">
            Pause connected agent sessions before matching tool calls.
          </div>
        </div>
        <span className={`tool-status ${state.settings.enabled ? 'is-enabled' : ''}`}>
          {state.settings.enabled ? `${pausedCount} paused` : 'off'}
        </span>
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={state.settings.enabled}
          onChange={(event) => saveSettings({ enabled: event.target.checked })}
        />
        enabled
      </label>

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={state.settings.pauseAll}
          disabled={!state.settings.enabled}
          onChange={(event) => saveSettings({ pauseAll: event.target.checked })}
        />
        pause every tool call
      </label>

      <div>
        <div className="label mb-1">tool breakpoints</div>
        <textarea
          className="field-area text-xs"
          rows={4}
          placeholder={'request_user_approval\nskill_lg_standard_center_query_get_rule_detail'}
          value={toolNamesText}
          disabled={state.settings.pauseAll}
          onChange={(event) => setToolNamesText(event.target.value)}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-500">
            One tool per line, or use pause every tool call.
          </span>
          <button className="btn" disabled={loading} onClick={() => saveSettings()}>
            Save
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="space-y-2">
        {state.pausePoints.length === 0 ? (
          <div className="setup-empty-state">No live pause points yet</div>
        ) : (
          state.pausePoints.map((point) => (
            <PausePointCard key={point.id} point={point} onOpenCase={openCase} />
          ))
        )}
      </div>
    </div>
  )
}
