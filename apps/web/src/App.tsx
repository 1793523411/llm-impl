import { useEffect } from 'react'
import { enableAutoSave, useStore } from './store'
import { CaseTree } from './components/CaseTree'
import { ConfigPanel } from './components/ConfigPanel'
import { SystemAndTools } from './components/SystemAndTools'
import { MessageList } from './components/MessageList'
import { Toolbar } from './components/Toolbar'
import { SendBar } from './components/SendBar'

export function App() {
  const refreshCases = useStore((s) => s.refreshCases)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const refreshExecTools = useStore((s) => s.refreshExecTools)
  const loadWorkspace = useStore((s) => s.loadWorkspace)
  useEffect(() => {
    loadWorkspace()
      .then(() => refreshProviders())
      .finally(() => {
        enableAutoSave()
      })
    refreshCases()
    refreshExecTools()
  }, [loadWorkspace, refreshProviders, refreshCases, refreshExecTools])

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <CaseTree />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Toolbar />
        <div className="flex-1 overflow-auto scrollbar px-4 py-3 space-y-4">
          <SystemAndTools />
          <MessageList />
        </div>
        <SendBar />
      </main>
      <ConfigPanel />
    </div>
  )
}
