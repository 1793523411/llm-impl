import { useState } from 'react'
import { useStore } from '../store'
import type { CaseEntry } from '../api'

function TreeNode({ entry, depth }: { entry: CaseEntry; depth: number }) {
  const [open, setOpen] = useState(true)
  const loadCase = useStore((s) => s.loadCase)
  const deleteCase = useStore((s) => s.deleteCase)
  const currentCasePath = useStore((s) => s.currentCasePath)
  const isActive = currentCasePath === entry.path

  if (entry.type === 'dir') {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-0.5 px-1 hover:bg-zinc-800 cursor-pointer text-zinc-400"
          style={{ paddingLeft: depth * 12 + 4 }}
          onClick={() => setOpen(!open)}
        >
          <span className="text-xs">{open ? '▾' : '▸'}</span>
          <span className="text-sm truncate">{entry.path.split('/').pop()}</span>
        </div>
        {open &&
          entry.children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
      </div>
    )
  }

  return (
    <div
      className={`group flex items-center justify-between py-0.5 px-1 hover:bg-zinc-800 cursor-pointer ${
        isActive ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-300'
      }`}
      style={{ paddingLeft: depth * 12 + 16 }}
    >
      <span
        className="text-sm truncate flex-1"
        onClick={() => loadCase(entry.path).catch(() => {})}
      >
        {entry.path.split('/').pop()?.replace(/\.json$/, '')}
      </span>
      <button
        className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 px-1"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation()
          if (confirm(`Delete ${entry.path}?`)) deleteCase(entry.path)
        }}
      >
        ✕
      </button>
    </div>
  )
}

export function CaseTree() {
  const cases = useStore((s) => s.cases)
  const refreshCases = useStore((s) => s.refreshCases)
  const newCase = useStore((s) => s.newCase)
  const saveCase = useStore((s) => s.saveCase)
  const currentCasePath = useStore((s) => s.currentCasePath)

  const handleSave = () => {
    const def = currentCasePath ?? `case-${Date.now()}.json`
    const path = prompt('Save as (relative path, e.g. demo/foo.json):', def)
    if (!path) return
    const final = path.endsWith('.json') ? path : `${path}.json`
    saveCase(final).catch((e) => alert(`save failed: ${e.message}`))
  }

  return (
    <aside className="w-56 border-r border-zinc-800 bg-zinc-950 flex flex-col">
      <div className="p-2 border-b border-zinc-800">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">cases</div>
        <div className="flex gap-1">
          <button className="btn flex-1" onClick={() => newCase()} title="New case">
            + New
          </button>
          <button className="btn flex-1" onClick={handleSave} title="Save current">
            Save
          </button>
          <button className="btn-ghost" onClick={() => refreshCases()} title="Refresh">
            ⟳
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar py-1">
        {cases.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-600">no cases yet</div>
        )}
        {cases.map((entry) => (
          <TreeNode key={entry.path} entry={entry} depth={0} />
        ))}
      </div>
    </aside>
  )
}
