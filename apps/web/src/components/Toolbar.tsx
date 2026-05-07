import { useState } from 'react'
import { useStore } from '../store'
import { Compare } from './Compare'

export function Toolbar() {
  const exportJson = useStore((s) => s.exportJson)
  const importJson = useStore((s) => s.importJson)
  const reset = useStore((s) => s.reset)
  const currentCasePath = useStore((s) => s.currentCasePath)

  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)

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
      alert(`Invalid JSON: ${(e as Error).message}`)
    }
  }

  return (
    <header className="border-b border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center gap-2">
      <span className="text-sm font-medium text-zinc-200">llm-impl</span>
      <span className="text-xs text-zinc-600 truncate flex-1">
        {currentCasePath ? `· ${currentCasePath}` : '· (unsaved)'}
      </span>
      {copyMsg && <span className="text-xs text-emerald-400">{copyMsg}</span>}
      <button className="btn" onClick={() => setComparing(true)} title="Compare two models on the same conversation">
        ⇆ Compare
      </button>
      <button className="btn" onClick={handleCopy} title="Copy current state as JSON">
        Copy JSON
      </button>
      <button className="btn" onClick={() => setImporting(true)}>
        Import JSON
      </button>
      <button
        className="btn-danger"
        onClick={() => {
          if (confirm('Reset messages?')) reset()
        }}
      >
        Reset
      </button>

      {comparing && <Compare onClose={() => setComparing(false)} />}

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
