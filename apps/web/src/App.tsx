import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { enableAutoSave, useStore } from './store'
import { CaseTree } from './components/CaseTree'
import { SystemAndTools } from './components/SystemAndTools'
import { MessageList } from './components/MessageList'
import { Toolbar } from './components/Toolbar'
import { SendBar } from './components/SendBar'

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function storedWidth(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export function App() {
  const refreshCases = useStore((s) => s.refreshCases)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const refreshExecTools = useStore((s) => s.refreshExecTools)
  const refreshSkills = useStore((s) => s.refreshSkills)
  const loadWorkspace = useStore((s) => s.loadWorkspace)
  const [leftWidth, setLeftWidth] = useState(() =>
    storedWidth('llm-impl-left-width', 224),
  )
  const [setupWidth, setSetupWidth] = useState(() =>
    storedWidth('llm-impl-setup-width', 420),
  )

  useEffect(() => {
    loadWorkspace()
      .then(async () => {
        await refreshProviders()
        await refreshSkills().catch(() => undefined)
      })
      .finally(() => {
        enableAutoSave()
      })
    refreshCases()
    refreshExecTools()
  }, [
    loadWorkspace,
    refreshProviders,
    refreshSkills,
    refreshCases,
    refreshExecTools,
  ])

  useEffect(() => {
    localStorage.setItem('llm-impl-left-width', String(leftWidth))
  }, [leftWidth])

  useEffect(() => {
    localStorage.setItem('llm-impl-setup-width', String(setupWidth))
  }, [setupWidth])

  const beginResize = (
    side: 'cases' | 'setup',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'cases' ? leftWidth : setupWidth
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const delta = moveEvent.clientX - startX
      if (side === 'cases') {
        setLeftWidth(clamp(startWidth + delta, 176, 420))
      } else {
        setSetupWidth(clamp(startWidth + delta, 320, 680))
      }
    }
    const onUp = () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <div className="h-full shrink-0" style={{ width: leftWidth }}>
        <CaseTree />
      </div>
      <div
        className="resize-handle"
        onPointerDown={(event) => beginResize('cases', event)}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Toolbar />
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <section className="h-full shrink-0" style={{ width: setupWidth }}>
            <SystemAndTools />
          </section>
          <div
            className="resize-handle"
            onPointerDown={(event) => beginResize('setup', event)}
          />
          <section className="conversation-debug-pane">
            <div className="flex-1 overflow-auto scrollbar px-4 py-3">
              <MessageList />
            </div>
            <SendBar />
          </section>
        </div>
      </main>
    </div>
  )
}
