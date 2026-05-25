import { useEffect, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'
import { LiveDebugPanel } from './LiveDebugPanel'
import { AlertDialog, AppDialog, ConfirmDialog } from './ui/AppDialog'

type Theme = 'dark' | 'light'

function getInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

export function Toolbar() {
  const exportJson = useStore((s) => s.exportJson)
  const importJson = useStore((s) => s.importJson)
  const reset = useStore((s) => s.reset)
  const currentCasePath = useStore((s) => s.currentCasePath)
  const refreshCases = useStore((s) => s.refreshCases)
  const loadCase = useStore((s) => s.loadCase)

  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [liveDebugOpen, setLiveDebugOpen] = useState(false)
  const [liveDebugEnabled, setLiveDebugEnabled] = useState(false)
  const [liveDebugPausedCount, setLiveDebugPausedCount] = useState(0)

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('llm-impl-theme', theme)
  }, [theme])

  useEffect(() => {
    let cancelled = false
    const loadLiveDebugState = async () => {
      try {
        const state = await api.getLiveDebugState()
        if (cancelled) return
        setLiveDebugEnabled(state.settings.enabled)
        setLiveDebugPausedCount(
          state.pausePoints.filter((point) => point.status === 'paused').length,
        )
        if (state.pausePoints.some((point) => point.casePath)) {
          await refreshCases()
        }
        const activeLiveCase = state.pausePoints.find(
          (point) => point.casePath && point.casePath === useStore.getState().currentCasePath,
        )
        if (activeLiveCase?.casePath) {
          await loadCase(activeLiveCase.casePath)
        }
      } catch {
        if (cancelled) return
        setLiveDebugEnabled(false)
        setLiveDebugPausedCount(0)
      }
    }
    loadLiveDebugState()
    const timer = window.setInterval(loadLiveDebugState, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadCase, refreshCases])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportJson())
      setCopyMsg('copied!')
      setTimeout(() => setCopyMsg(null), 1500)
    } catch {
      setCopyMsg('copy failed')
    }
  }

  const handleImportConfirm = () => {
    try {
      importJson(importText)
      setImporting(false)
      setImportText('')
    } catch (e) {
      setErrorMessage(`Invalid JSON: ${(e as Error).message}`)
    }
  }

  return (
    <header className="border-b border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center gap-2">
      <span className="text-sm font-medium text-zinc-200">llm-impl</span>
      <span className="text-xs text-zinc-600 truncate flex-1">
        {currentCasePath ? `· ${currentCasePath}` : '· (no case selected)'}
      </span>
      {copyMsg && <span className="text-xs text-emerald-400">{copyMsg}</span>}
      <button
        className={liveDebugPausedCount > 0 ? 'btn-primary' : 'btn'}
        onClick={() => setLiveDebugOpen(true)}
        title="Open global live debugger"
      >
        Live Debug
        {liveDebugPausedCount > 0
          ? ` · ${liveDebugPausedCount} paused`
          : liveDebugEnabled
            ? ' · on'
            : ''}
      </button>
      <button
        className="btn theme-toggle"
        onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        aria-pressed={theme === 'light'}
      >
        <span aria-hidden>{theme === 'dark' ? '☾' : '☀'}</span>
        {theme === 'dark' ? 'Dark' : 'Light'}
      </button>
      <button className="btn" onClick={handleCopy} title="Copy current state as JSON">
        Copy JSON
      </button>
      <button className="btn" onClick={() => setImporting(true)}>
        Import JSON
      </button>
      <button
        className="btn-danger"
        onClick={() => setResetConfirmOpen(true)}
      >
        Reset
      </button>

      <ConfirmDialog
        open={resetConfirmOpen}
        title="Reset Messages"
        message="Reset all messages in the current case?"
        confirmLabel="Reset"
        danger
        onCancel={() => setResetConfirmOpen(false)}
        onConfirm={() => {
          setResetConfirmOpen(false)
          reset()
        }}
      />

      <AlertDialog
        open={!!errorMessage}
        title="Import Failed"
        message={errorMessage ?? ''}
        onClose={() => setErrorMessage(null)}
      />

      <AppDialog
        open={liveDebugOpen}
        title="Global Live Debugger"
        description="Runtime breakpoints apply globally to connected agent sessions, not to the selected case."
        onClose={() => setLiveDebugOpen(false)}
        actions={[{ label: 'Close', onClick: () => setLiveDebugOpen(false) }]}
      >
        <LiveDebugPanel />
      </AppDialog>

      {importing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setImporting(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded p-4 w-[600px] max-w-[90vw] space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium">Paste JSON</div>
            <textarea
              className="field-area font-mono text-xs"
              rows={20}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setImporting(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleImportConfirm}>
                Load
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
