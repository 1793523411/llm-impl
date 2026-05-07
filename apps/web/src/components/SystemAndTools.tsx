import { useState } from 'react'
import { useStore } from '../store'

export function SystemAndTools() {
  const system = useStore((s) => s.system)
  const setSystem = useStore((s) => s.setSystem)
  const tools = useStore((s) => s.tools)
  const addTool = useStore((s) => s.addTool)
  const updateTool = useStore((s) => s.updateTool)
  const removeTool = useStore((s) => s.removeTool)

  const [openSystem, setOpenSystem] = useState(true)
  const [openTools, setOpenTools] = useState(false)

  return (
    <div className="space-y-3">
      <div className="rounded border border-zinc-800">
        <button
          className="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-zinc-900"
          onClick={() => setOpenSystem(!openSystem)}
        >
          <span className="text-xs uppercase tracking-wider text-zinc-400">
            {openSystem ? '▾' : '▸'} system
          </span>
          {!openSystem && system && (
            <span className="text-xs text-zinc-500 truncate ml-2 max-w-md">
              {system.slice(0, 80)}
              {system.length > 80 && '…'}
            </span>
          )}
        </button>
        {openSystem && (
          <div className="p-3 pt-0">
            <textarea
              className="field-area"
              rows={3}
              placeholder="You are a helpful assistant..."
              value={system}
              onChange={(e) => setSystem(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="rounded border border-zinc-800">
        <button
          className="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-zinc-900"
          onClick={() => setOpenTools(!openTools)}
        >
          <span className="text-xs uppercase tracking-wider text-zinc-400">
            {openTools ? '▾' : '▸'} tools{' '}
            <span className="text-zinc-600">({tools.length})</span>
          </span>
        </button>
        {openTools && (
          <div className="p-3 pt-0 space-y-2">
            {tools.map((tool, i) => (
              <ToolEditor
                key={i}
                tool={tool}
                onChange={(patch) => updateTool(i, patch)}
                onRemove={() => removeTool(i)}
              />
            ))}
            <button className="btn" onClick={addTool}>
              + Add tool
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ToolEditor({
  tool,
  onChange,
  onRemove,
}: {
  tool: { name: string; description?: string; input_schema: Record<string, unknown> }
  onChange: (patch: { name?: string; description?: string; input_schema?: Record<string, unknown> }) => void
  onRemove: () => void
}) {
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(tool.input_schema, null, 2))
  const [schemaError, setSchemaError] = useState<string | null>(null)

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          className="field flex-1"
          placeholder="tool_name"
          value={tool.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button className="btn-danger" onClick={onRemove} title="Remove tool">
          ✕
        </button>
      </div>
      <input
        className="field"
        placeholder="description (optional)"
        value={tool.description ?? ''}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <div>
        <div className="label mb-1">input_schema (JSON)</div>
        <textarea
          className={`field-area font-mono text-xs ${schemaError ? 'border-red-700' : ''}`}
          rows={6}
          value={schemaText}
          onChange={(e) => {
            const v = e.target.value
            setSchemaText(v)
            try {
              const parsed = JSON.parse(v)
              setSchemaError(null)
              onChange({ input_schema: parsed })
            } catch (err) {
              setSchemaError((err as Error).message)
            }
          }}
        />
        {schemaError && (
          <div className="text-xs text-red-400 mt-1">{schemaError}</div>
        )}
      </div>
    </div>
  )
}
