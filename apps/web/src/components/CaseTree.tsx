import { useState, type DragEvent } from 'react'
import { useStore } from '../store'
import type { CaseEntry } from '../api'

const CASE_DRAG_TYPE = 'application/x-llm-case-entry'

type DragPayload = {
  path: string
  type: CaseEntry['type']
}

const basename = (entryPath: string): string => entryPath.split('/').pop() ?? entryPath

const cleanPathInput = (value: string): string | null => {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) return null
  return parts.join('/')
}

const joinPath = (...parts: string[]): string =>
  parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')

const displayDir = (dir: string): string => (dir ? `/${dir}` : '/')

function readDragPayload(event: DragEvent): DragPayload | null {
  const raw = event.dataTransfer.getData(CASE_DRAG_TYPE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DragPayload
    if (!parsed.path || !parsed.type) return null
    return parsed
  } catch {
    return null
  }
}

function targetPathFor(payload: DragPayload, targetDir: string): string {
  return joinPath(targetDir, basename(payload.path))
}

function TreeNode({
  entry,
  depth,
  selectedDir,
  dragOverDir,
  onSelectDir,
  onDragOverDir,
  onDropToDir,
  onNewCase,
  onNewFolder,
}: {
  entry: CaseEntry
  depth: number
  selectedDir: string
  dragOverDir: string | null
  onSelectDir: (dir: string) => void
  onDragOverDir: (dir: string | null) => void
  onDropToDir: (dir: string, event: DragEvent) => void
  onNewCase: (dir: string) => void
  onNewFolder: (dir: string) => void
}) {
  const [open, setOpen] = useState(true)
  const loadCase = useStore((s) => s.loadCase)
  const deleteCase = useStore((s) => s.deleteCase)
  const currentCasePath = useStore((s) => s.currentCasePath)
  const isActive = currentCasePath === entry.path
  const dragClass = dragOverDir === entry.path ? 'is-drop-target' : ''

  const beginDrag = (event: DragEvent) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      CASE_DRAG_TYPE,
      JSON.stringify({ path: entry.path, type: entry.type } satisfies DragPayload),
    )
  }

  if (entry.type === 'dir') {
    const isSelected = selectedDir === entry.path
    return (
      <div>
        <div
          className={`case-tree-row case-tree-dir ${isSelected ? 'is-selected' : ''} ${dragClass}`}
          style={{ paddingLeft: depth * 12 + 4 }}
          draggable
          onDragStart={beginDrag}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            onDragOverDir(entry.path)
          }}
          onDragLeave={() => onDragOverDir(null)}
          onDrop={(event) => onDropToDir(entry.path, event)}
          onClick={() => onSelectDir(entry.path)}
        >
          <button
            className="case-tree-twist"
            title={open ? 'Collapse folder' : 'Expand folder'}
            onClick={(event) => {
              event.stopPropagation()
              setOpen(!open)
            }}
          >
            {open ? '▾' : '▸'}
          </button>
          <span className="case-tree-name">{basename(entry.path)}</span>
          <button
            className="case-tree-action"
            title="New case here"
            onClick={(event) => {
              event.stopPropagation()
              onNewCase(entry.path)
            }}
          >
            Case
          </button>
          <button
            className="case-tree-action"
            title="New folder here"
            onClick={(event) => {
              event.stopPropagation()
              onNewFolder(entry.path)
            }}
          >
            Dir
          </button>
        </div>
        {open &&
          entry.children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedDir={selectedDir}
              dragOverDir={dragOverDir}
              onSelectDir={onSelectDir}
              onDragOverDir={onDragOverDir}
              onDropToDir={onDropToDir}
              onNewCase={onNewCase}
              onNewFolder={onNewFolder}
            />
          ))}
      </div>
    )
  }

  return (
    <div
      className={`case-tree-row case-tree-file ${isActive ? 'is-active' : ''}`}
      style={{ paddingLeft: depth * 12 + 16 }}
      draggable
      onDragStart={beginDrag}
      onClick={() => loadCase(entry.path).catch(() => {})}
    >
      <span className="case-tree-name">
        {entry.path.split('/').pop()?.replace(/\.json$/, '')}
      </span>
      <button
        className="case-tree-delete"
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
  const createCaseDir = useStore((s) => s.createCaseDir)
  const moveCaseEntry = useStore((s) => s.moveCaseEntry)
  const [selectedDir, setSelectedDir] = useState('')
  const [dragOverDir, setDragOverDir] = useState<string | null>(null)

  const handleNewCase = (dir = selectedDir) => {
    const input = prompt(
      `Case name under ${displayDir(dir)}. Leave empty for an auto name.`,
      '',
    )
    if (input === null) return
    const name = input.trim() ? cleanPathInput(input) : ''
    if (input.trim() && !name) {
      alert('Invalid case name')
      return
    }
    newCase(dir, name || undefined).catch((e) =>
      alert(`create failed: ${(e as Error).message}`),
    )
  }

  const handleNewFolder = (dir = selectedDir) => {
    const input = prompt(`Folder name under ${displayDir(dir)}`, '')
    if (input === null) return
    const child = cleanPathInput(input)
    if (!child) {
      alert('Invalid folder name')
      return
    }
    const nextDir = joinPath(dir, child)
    createCaseDir(nextDir)
      .then(() => setSelectedDir(nextDir))
      .catch((e) => alert(`folder create failed: ${(e as Error).message}`))
  }

  const handleDropToDir = (targetDir: string, event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDragOverDir(null)
    const payload = readDragPayload(event)
    if (!payload) return

    if (
      payload.type === 'dir' &&
      (targetDir === payload.path || targetDir.startsWith(`${payload.path}/`))
    ) {
      alert('Cannot move a folder into itself')
      return
    }

    const targetPath = targetPathFor(payload, targetDir)
    if (!targetPath || targetPath === payload.path) return

    moveCaseEntry(payload.path, targetPath)
      .then(() => {
        if (
          selectedDir === payload.path ||
          selectedDir.startsWith(`${payload.path}/`)
        ) {
          setSelectedDir(
            selectedDir === payload.path
              ? targetPath
              : `${targetPath}${selectedDir.slice(payload.path.length)}`,
          )
        }
      })
      .catch((e) => alert(`move failed: ${(e as Error).message}`))
  }

  return (
    <aside className="w-full h-full border-r border-zinc-800 bg-zinc-950 flex flex-col">
      <div className="p-2 border-b border-zinc-800">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">cases</div>
        <button
          className="case-tree-path"
          title="Current target directory"
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDragOverDir(selectedDir)
          }}
          onDragLeave={() => setDragOverDir(null)}
          onDrop={(event) => handleDropToDir(selectedDir, event)}
        >
          <span className="truncate">{displayDir(selectedDir)}</span>
          <span className="text-[10px] text-zinc-600">target</span>
        </button>
        <div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-1">
          <button className="btn" onClick={() => handleNewCase()} title="Create JSON case">
            + Case
          </button>
          <button className="btn" onClick={() => handleNewFolder()} title="Create folder">
            + Dir
          </button>
          <button className="btn-ghost" onClick={() => refreshCases()} title="Refresh">
            ⟳
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar py-1">
        <div
          className={`case-tree-row case-tree-dir ${selectedDir === '' ? 'is-selected' : ''} ${
            dragOverDir === '' ? 'is-drop-target' : ''
          }`}
          style={{ paddingLeft: 4 }}
          onClick={() => setSelectedDir('')}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDragOverDir('')
          }}
          onDragLeave={() => setDragOverDir(null)}
          onDrop={(event) => handleDropToDir('', event)}
        >
          <span className="case-tree-twist">/</span>
          <span className="case-tree-name">root</span>
        </div>
        {cases.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-600">no cases yet</div>
        )}
        {cases.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedDir={selectedDir}
            dragOverDir={dragOverDir}
            onSelectDir={setSelectedDir}
            onDragOverDir={setDragOverDir}
            onDropToDir={handleDropToDir}
            onNewCase={handleNewCase}
            onNewFolder={handleNewFolder}
          />
        ))}
      </div>
    </aside>
  )
}
