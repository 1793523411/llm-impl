import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useStore } from '../store'
import type { CaseEntry } from '../api'
import { AlertDialog, ConfirmDialog, PromptDialog } from './ui/AppDialog'

const CASE_DRAG_TYPE = 'application/x-llm-case-entry'
const CASE_TREE_COLLAPSED_STORAGE_KEY = 'llm-impl-case-tree-collapsed-dirs'

type DragPayload = {
  path: string
  type: CaseEntry['type']
}

type CaseTreeDialog =
  | { kind: 'new-case'; dir: string; value: string; error?: string }
  | { kind: 'new-folder'; dir: string; value: string; error?: string }
  | { kind: 'delete-entry'; path: string; entryType: CaseEntry['type'] }
  | { kind: 'alert'; title: string; message: string }

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

function readCollapsedDirs(): string[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CASE_TREE_COLLAPSED_STORAGE_KEY) ?? '[]',
    ) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function writeCollapsedDirs(paths: string[]): void {
  try {
    localStorage.setItem(CASE_TREE_COLLAPSED_STORAGE_KEY, JSON.stringify(paths))
  } catch {
    // Ignore storage failures; the tree still works for the current session.
  }
}

function collectDirPaths(entries: CaseEntry[]): Set<string> {
  const paths = new Set<string>()
  const visit = (entry: CaseEntry) => {
    if (entry.type !== 'dir') return
    paths.add(entry.path)
    entry.children?.forEach(visit)
  }
  entries.forEach(visit)
  return paths
}

function entryPathExists(entries: CaseEntry[], targetPath: string): boolean {
  return entries.some(
    (entry) =>
      entry.path === targetPath ||
      (entry.children ? entryPathExists(entry.children, targetPath) : false),
  )
}

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

function casePathForInput(dir: string, value: string): string {
  return joinPath(dir, `${value.replace(/\.json$/i, '')}.json`)
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
  onDeleteEntry,
  isCollapsed,
  onToggleDir,
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
  onDeleteEntry: (path: string, entryType: CaseEntry['type']) => void
  isCollapsed: (dir: string) => boolean
  onToggleDir: (dir: string) => void
}) {
  const loadCase = useStore((s) => s.loadCase)
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
    const open = !isCollapsed(entry.path)
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
              onToggleDir(entry.path)
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
          <button
            className="case-tree-delete"
            title="Delete folder"
            onClick={(event) => {
              event.stopPropagation()
              onDeleteEntry(entry.path, entry.type)
            }}
          >
            ✕
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
              onDeleteEntry={onDeleteEntry}
              isCollapsed={isCollapsed}
              onToggleDir={onToggleDir}
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
          onDeleteEntry(entry.path, entry.type)
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
  const deleteCase = useStore((s) => s.deleteCase)
  const createCaseDir = useStore((s) => s.createCaseDir)
  const moveCaseEntry = useStore((s) => s.moveCaseEntry)
  const [selectedDir, setSelectedDir] = useState('')
  const [dragOverDir, setDragOverDir] = useState<string | null>(null)
  const [dialog, setDialog] = useState<CaseTreeDialog | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<string[]>(readCollapsedDirs)
  const collapsedDirSet = useMemo(() => new Set(collapsedDirs), [collapsedDirs])

  useEffect(() => {
    writeCollapsedDirs(collapsedDirs)
  }, [collapsedDirs])

  useEffect(() => {
    if (cases.length === 0) return
    const dirPaths = collectDirPaths(cases)
    setCollapsedDirs((paths) => {
      const next = paths.filter((path) => dirPaths.has(path))
      return next.length === paths.length ? paths : next
    })
  }, [cases])

  const showAlert = (title: string, message: string) =>
    setDialog({ kind: 'alert', title, message })

  const toggleDir = (dir: string) => {
    setCollapsedDirs((paths) =>
      paths.includes(dir)
        ? paths.filter((path) => path !== dir)
        : [...paths, dir],
    )
  }

  const handleNewCase = (dir = selectedDir) => {
    setDialog({ kind: 'new-case', dir, value: '' })
  }

  const confirmNewCase = () => {
    if (dialog?.kind !== 'new-case') return
    const input = dialog.value
    const name = input.trim() ? cleanPathInput(input) : ''
    if (input.trim() && !name) {
      setDialog({ ...dialog, error: 'Invalid case name' })
      return
    }
    if (name) {
      const nextPath = casePathForInput(dialog.dir, name)
      if (entryPathExists(cases, nextPath)) {
        setDialog({ ...dialog, error: `Already exists: ${nextPath}` })
        return
      }
    }
    setDialog(null)
    newCase(dialog.dir, name || undefined).catch((e) =>
      showAlert('Create Failed', (e as Error).message),
    )
  }

  const handleNewFolder = (dir = selectedDir) => {
    setDialog({ kind: 'new-folder', dir, value: '' })
  }

  const confirmNewFolder = () => {
    if (dialog?.kind !== 'new-folder') return
    const input = dialog.value
    const child = cleanPathInput(input)
    if (!child) {
      setDialog({ ...dialog, error: 'Invalid folder name' })
      return
    }
    const nextDir = joinPath(dialog.dir, child)
    if (entryPathExists(cases, nextDir)) {
      setDialog({ ...dialog, error: `Already exists: ${nextDir}` })
      return
    }
    setDialog(null)
    createCaseDir(nextDir)
      .then(() => {
        setCollapsedDirs((paths) => paths.filter((path) => path !== nextDir))
        setSelectedDir(nextDir)
      })
      .catch((e) => showAlert('Folder Create Failed', (e as Error).message))
  }

  const confirmDeleteCase = () => {
    if (dialog?.kind !== 'delete-entry') return
    const target = dialog.path
    setDialog(null)
    deleteCase(target)
      .then(() => {
        setCollapsedDirs((paths) =>
          paths.filter((path) => path !== target && !path.startsWith(`${target}/`)),
        )
        if (selectedDir === target || selectedDir.startsWith(`${target}/`)) {
          setSelectedDir('')
        }
      })
      .catch((e) => showAlert('Delete Failed', (e as Error).message))
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
      showAlert('Move Blocked', 'Cannot move a folder into itself.')
      return
    }

    const targetPath = targetPathFor(payload, targetDir)
    if (!targetPath || targetPath === payload.path) return
    if (entryPathExists(cases, targetPath)) {
      showAlert('Move Blocked', `Already exists: ${targetPath}`)
      return
    }

    moveCaseEntry(payload.path, targetPath)
      .then(() => {
        setCollapsedDirs((paths) => {
          if (
            !paths.some(
              (path) => path === payload.path || path.startsWith(`${payload.path}/`),
            )
          ) {
            return paths
          }
          return Array.from(
            new Set(
              paths.map((path) =>
                path === payload.path
                  ? targetPath
                  : path.startsWith(`${payload.path}/`)
                    ? `${targetPath}${path.slice(payload.path.length)}`
                    : path,
              ),
            ),
          )
        })
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
      .catch((e) => showAlert('Move Failed', (e as Error).message))
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
            onDeleteEntry={(path, entryType) =>
              setDialog({ kind: 'delete-entry', path, entryType })
            }
            isCollapsed={(dir) => collapsedDirSet.has(dir)}
            onToggleDir={toggleDir}
          />
        ))}
      </div>

      {dialog?.kind === 'new-case' && (
        <PromptDialog
          open
          title="New Case"
          description={`Case name under ${displayDir(dialog.dir)}. Leave empty for an auto name.`}
          value={dialog.value}
          error={dialog.error}
          placeholder="case-name"
          confirmLabel="Create"
          onValueChange={(value) => setDialog({ ...dialog, value, error: undefined })}
          onConfirm={confirmNewCase}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'new-folder' && (
        <PromptDialog
          open
          title="New Folder"
          description={`Folder name under ${displayDir(dialog.dir)}.`}
          value={dialog.value}
          error={dialog.error}
          placeholder="folder-name"
          confirmLabel="Create"
          onValueChange={(value) => setDialog({ ...dialog, value, error: undefined })}
          onConfirm={confirmNewFolder}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'delete-entry' && (
        <ConfirmDialog
          open
          title={dialog.entryType === 'dir' ? 'Delete Folder' : 'Delete Case'}
          message={
            dialog.entryType === 'dir'
              ? `Delete ${dialog.path} and all cases inside it?`
              : `Delete ${dialog.path}?`
          }
          confirmLabel="Delete"
          danger
          onConfirm={confirmDeleteCase}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'alert' && (
        <AlertDialog
          open
          title={dialog.title}
          message={dialog.message}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  )
}
