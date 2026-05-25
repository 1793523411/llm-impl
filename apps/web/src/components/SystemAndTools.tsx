import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  ExecToolDef,
  McpServerConfig,
  McpToolConfig,
  SandboxConfig,
  SkillConfig,
  Tool,
} from '@llm-impl/shared'
import { useStore } from '../store'
import { toolNameForMcpTool } from '../store'
import { ModelConfigForm } from './ConfigPanel'
import { ModelInputPreview } from './ModelInputPreview'
import { AlertDialog } from './ui/AppDialog'

type SetupTab = 'model' | 'tools' | 'skills' | 'mcp' | 'sandbox' | 'input'

const tabs: Array<{ id: SetupTab; label: string }> = [
  { id: 'model', label: 'Model' },
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'input', label: 'Model Input' },
]

const RUN_COMMAND_TOOL_NAME = 'run_command'
const RUN_COMMAND_SKILL_HINT_REG =
  /\b(run_command|lgcli|cli|terminal|shell|bash|command-line)\b/i

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function skillNeedsRunCommand(skill: SkillConfig): boolean {
  if (skill.requiresRunCommand !== undefined) return skill.requiresRunCommand
  return RUN_COMMAND_SKILL_HINT_REG.test(
    [skill.name, skill.description, skill.instruction].filter(Boolean).join('\n'),
  )
}

function formatSkillNames(names: string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

function storedHeight(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export function SystemAndTools() {
  const tools = useStore((s) => s.tools)
  const [activeTab, setActiveTab] = useState<SetupTab>('model')
  const [systemHeight, setSystemHeight] = useState(() =>
    storedHeight('llm-impl-system-pane-height', 260),
  )

  useEffect(() => {
    localStorage.setItem('llm-impl-system-pane-height', String(systemHeight))
  }, [systemHeight])

  const beginSystemResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = systemHeight
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const delta = moveEvent.clientY - startY
      setSystemHeight(clamp(startHeight - delta, 160, 560))
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
    <aside className="setup-panel">
      <div className="setup-upper-pane">
        <div className="setup-tabbar scrollbar" role="tablist" aria-label="Conversation setup">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`setup-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'tools' && tools.length > 0 && (
                <span className="setup-tab-count">{tools.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="setup-tab-content scrollbar">
          {activeTab === 'model' && <ModelConfigForm />}
          {activeTab === 'tools' && <ToolsTab />}
          {activeTab === 'skills' && <SkillsTab />}
          {activeTab === 'mcp' && <McpTab />}
          {activeTab === 'sandbox' && <SandboxTab />}
          {activeTab === 'input' && <ModelInputPreview defaultOpen />}
        </div>
      </div>

      <div
        className="setup-y-resize-handle"
        onPointerDown={beginSystemResize}
      />
      <section
        className="setup-system-pane scrollbar"
        style={{ height: systemHeight }}
      >
        <SystemPromptTab />
      </section>
    </aside>
  )
}

function SystemPromptTab() {
  const system = useStore((s) => s.system)
  const setSystem = useStore((s) => s.setSystem)

  return (
    <div className="setup-section setup-system-section">
      <div className="label mb-2">system prompt</div>
      <textarea
        className="field-area setup-system-textarea"
        placeholder="You are a helpful assistant..."
        value={system}
        onChange={(e) => setSystem(e.target.value)}
      />
    </div>
  )
}

function ToolsTab() {
  const tools = useStore((s) => s.tools)
  const execTools = useStore((s) => s.execTools)
  const skills = useStore((s) => s.skills)
  const setBuiltinToolEnabled = useStore((s) => s.setBuiltinToolEnabled)
  const removeTool = useStore((s) => s.removeTool)
  const refreshExecTools = useStore((s) => s.refreshExecTools)
  const [refreshing, setRefreshing] = useState(false)

  const selectedNames = new Set(tools.map((tool) => tool.name))
  const execToolNames = new Set(execTools.map((tool) => tool.name))
  const legacyTools = tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => !execToolNames.has(tool.name))
  const enabledCount = execTools.filter((tool) => selectedNames.has(tool.name)).length

  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshExecTools()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="setup-section space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="label">built-in tools ({enabledCount}/{execTools.length})</div>
          <div className="mt-1 text-xs text-zinc-500">
            Choose server-runnable tools to expose to the model.
          </div>
        </div>
        <button className="btn" disabled={refreshing} onClick={refresh}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {execTools.length === 0 && (
        <div className="setup-empty-state">No built-in tools loaded</div>
      )}

      <RunCommandSkillWarning
        skills={skills}
        tools={tools}
        execTools={execTools}
        onEnable={() => setBuiltinToolEnabled(RUN_COMMAND_TOOL_NAME, true)}
      />

      {execTools.length > 0 && (
        <div className="space-y-2">
          {execTools.map((tool) => (
            <BuiltinToolRow
              key={tool.name}
              tool={tool}
              enabled={selectedNames.has(tool.name)}
              onToggle={(enabled) => setBuiltinToolEnabled(tool.name, enabled)}
            />
          ))}
        </div>
      )}

      {legacyTools.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-zinc-800">
          <div>
            <div className="label">manual-only tools ({legacyTools.length})</div>
            <div className="mt-1 text-xs text-zinc-500">
              These came from older case JSON and are sent to the model, but have no
              built-in executor.
            </div>
          </div>
          {legacyTools.map(({ tool, index }) => (
            <LegacyToolCard
              key={`${tool.name}-${index}`}
              tool={tool}
              onRemove={() => removeTool(index)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RunCommandSkillWarning({
  skills,
  tools,
  execTools,
  onEnable,
}: {
  skills: SkillConfig[]
  tools: Tool[]
  execTools: ExecToolDef[]
  onEnable: () => void
}) {
  const affectedSkills = skills
    .filter((skill) => skill.enabled && skillNeedsRunCommand(skill))
    .map((skill) => skill.name)
  const runCommandAvailable = execTools.some(
    (tool) => tool.name === RUN_COMMAND_TOOL_NAME,
  )
  const runCommandExposed = tools.some((tool) => tool.name === RUN_COMMAND_TOOL_NAME)

  if (affectedSkills.length === 0 || runCommandExposed) return null

  return (
    <div className="setup-warning-card">
      <div className="setup-warning-title">
        Enabled skills may need <span className="font-mono">{RUN_COMMAND_TOOL_NAME}</span>
      </div>
      <div>
        {formatSkillNames(affectedSkills)} can ask the model to run shell/CLI steps. Without
        <span className="font-mono"> {RUN_COMMAND_TOOL_NAME}</span> exposed, the model may
        keep reloading the skill instead of executing the next step.
      </div>
      <div className="setup-warning-actions">
        <button
          className="btn btn-primary"
          disabled={!runCommandAvailable}
          onClick={onEnable}
        >
          Enable run_command
        </button>
        {!runCommandAvailable && (
          <span>Refresh built-in tools before enabling run_command.</span>
        )}
      </div>
    </div>
  )
}

function BuiltinToolRow({
  tool,
  enabled,
  onToggle,
}: {
  tool: ExecToolDef
  enabled: boolean
  onToggle: (enabled: boolean) => void
}) {
  const [showSchema, setShowSchema] = useState(false)

  return (
    <div className={`tool-library-row ${enabled ? 'is-enabled' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2 text-xs">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block truncate font-mono text-zinc-200">{tool.name}</span>
            <span className="mt-1 block text-zinc-500">{tool.description}</span>
          </span>
        </label>
        <span className={`tool-status ${enabled ? 'is-enabled' : ''}`}>
          {enabled ? 'enabled' : 'off'}
        </span>
      </div>
      <button
        className="btn-ghost mt-2 text-[10px] text-zinc-500"
        onClick={() => setShowSchema((value) => !value)}
      >
        {showSchema ? 'Hide schema' : 'Show schema'}
      </button>
      {showSchema && <SchemaPreview schema={tool.input_schema} />}
    </div>
  )
}

function LegacyToolCard({
  tool,
  onRemove,
}: {
  tool: Tool
  onRemove: () => void
}) {
  const [showSchema, setShowSchema] = useState(false)

  return (
    <div className="tool-library-row is-legacy">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-zinc-200">{tool.name}</div>
          {tool.description && (
            <div className="mt-1 text-xs text-zinc-500">{tool.description}</div>
          )}
        </div>
        <button className="btn-danger" onClick={onRemove} title="Remove manual-only tool">
          x
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-amber-400">manual result required</span>
        <button
          className="btn-ghost text-[10px] text-zinc-500"
          onClick={() => setShowSchema((value) => !value)}
        >
          {showSchema ? 'Hide schema' : 'Show schema'}
        </button>
      </div>
      {showSchema && <SchemaPreview schema={tool.input_schema} />}
    </div>
  )
}

function SchemaPreview({ schema }: { schema: Record<string, unknown> }) {
  return (
    <pre className="tool-schema-preview scrollbar">
      {JSON.stringify(schema, null, 2)}
    </pre>
  )
}

const defaultSandboxConfig = (): SandboxConfig => ({
  label: 'case-sandbox',
  mode: 'workspace-write',
  network: 'blocked',
  allowedRoots: [],
  writableRoots: [],
})

const linesToPaths = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const pathsToLines = (paths: string[] | undefined): string =>
  (paths ?? []).join('\n')

function SandboxTab() {
  const sandbox = useStore((s) => s.sandbox)
  const setSandbox = useStore((s) => s.setSandbox)
  const effectiveSandbox = sandbox ?? defaultSandboxConfig()
  const [allowedRootsText, setAllowedRootsText] = useState(() =>
    pathsToLines(effectiveSandbox.allowedRoots),
  )
  const [writableRootsText, setWritableRootsText] = useState(() =>
    pathsToLines(effectiveSandbox.writableRoots),
  )
  const [rawText, setRawText] = useState(() =>
    JSON.stringify(effectiveSandbox, null, 2),
  )
  const [rawError, setRawError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setAllowedRootsText(pathsToLines(effectiveSandbox.allowedRoots))
    setWritableRootsText(pathsToLines(effectiveSandbox.writableRoots))
    setRawText(JSON.stringify(effectiveSandbox, null, 2))
    setRawError(null)
  }, [sandbox])

  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    },
    [],
  )

  const flashFeedback = (message: string) => {
    setFeedback(message)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1600)
  }

  const updateSandbox = (patch: Partial<SandboxConfig>, message?: string) => {
    setSandbox({
      ...defaultSandboxConfig(),
      ...(sandbox ?? {}),
      ...patch,
    })
    if (message) flashFeedback(message)
  }

  const applyRaw = () => {
    try {
      const parsed = JSON.parse(rawText || 'null') as SandboxConfig | null
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('sandbox must be an object or null')
      }
      setSandbox(parsed)
      setRawError(null)
      flashFeedback(parsed ? 'JSON applied' : 'Using server defaults')
    } catch (e) {
      setRawError((e as Error).message)
    }
  }

  return (
    <div className="setup-section space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="label">case sandbox</div>
          <div className="mt-1 text-xs text-zinc-500">
            Saved into this case JSON and inherited by runnable built-in tools.
            For run_command, disabling sandbox removes path, write, and network
            guards for that command.
          </div>
        </div>
        <span className={`tool-status ${sandbox ? 'is-enabled' : ''}`}>
          {sandbox ? 'case' : 'default'}
        </span>
      </div>
      {feedback && (
        <div className="rounded border border-emerald-800 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-300">
          {feedback}
        </div>
      )}

      <div className="rounded border border-zinc-800 bg-zinc-950 p-3 space-y-3">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={effectiveSandbox.enabled !== false}
            onChange={(e) =>
              updateSandbox(
                { enabled: e.target.checked },
                e.target.checked ? 'Command sandbox enabled' : 'Command sandbox disabled',
              )
            }
          />
          enable run_command sandbox and path guards
        </label>
        {effectiveSandbox.enabled === false && (
          <div className="sandbox-disabled-notice">
            run_command will run from any existing working directory using normal
            process permissions. Dangerous command checks and timeouts still apply.
          </div>
        )}

        <div>
          <div className="label mb-1">label</div>
          <input
            className="field"
            value={effectiveSandbox.label ?? ''}
            placeholder="case-sandbox"
            onChange={(e) => updateSandbox({ label: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="label mb-1">write mode</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`btn ${effectiveSandbox.mode !== 'read-only' ? 'btn-primary' : ''}`}
                onClick={() =>
                  updateSandbox({ mode: 'workspace-write' }, 'Write mode: workspace')
                }
              >
                workspace
              </button>
              <button
                className={`btn ${effectiveSandbox.mode === 'read-only' ? 'btn-primary' : ''}`}
                onClick={() =>
                  updateSandbox({ mode: 'read-only' }, 'Write mode: read only')
                }
              >
                read only
              </button>
            </div>
          </div>

          <div>
            <div className="label mb-1">network</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`btn ${effectiveSandbox.network !== 'allowed' ? 'btn-primary' : ''}`}
                onClick={() =>
                  updateSandbox({ network: 'blocked' }, 'Network blocked')
                }
              >
                blocked
              </button>
              <button
                className={`btn ${effectiveSandbox.network === 'allowed' ? 'btn-primary' : ''}`}
                onClick={() =>
                  updateSandbox({ network: 'allowed' }, 'Network allowed')
                }
              >
                allowed
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="label mb-1">allowed roots</div>
          <textarea
            className="field-area font-mono text-xs"
            rows={4}
            placeholder="One absolute path per line. Empty inherits server defaults."
            value={allowedRootsText}
            onChange={(e) => {
              const value = e.target.value
              setAllowedRootsText(value)
              updateSandbox({ allowedRoots: linesToPaths(value) })
            }}
          />
          <div className="mt-1 text-[10px] text-zinc-600">
            Used by read/search/list tools, and by run_command only while its
            sandbox is enabled.
          </div>
        </div>

        <div>
          <div className="label mb-1">writable roots</div>
          <textarea
            className="field-area font-mono text-xs"
            rows={3}
            placeholder="/tmp/llm-impl-debug-output"
            value={writableRootsText}
            onChange={(e) => {
              const value = e.target.value
              setWritableRootsText(value)
              updateSandbox({ writableRoots: linesToPaths(value) })
            }}
          />
          <div className="mt-1 text-[10px] text-zinc-600">
            Extra output folders for this case. They also become readable for debugging generated files.
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        {!sandbox && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setSandbox(defaultSandboxConfig())
              flashFeedback('Case sandbox enabled')
            }}
          >
            Enable case sandbox
          </button>
        )}
        <button
          className="btn"
          onClick={() => {
            setSandbox(null)
            setRawError(null)
            flashFeedback('Using server defaults')
          }}
        >
          Use server default
        </button>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-zinc-500">
          Advanced JSON
        </summary>
        <div className="mt-2 space-y-2">
          <textarea
            className={`field-area font-mono text-xs ${rawError ? 'border-red-700' : ''}`}
            rows={8}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          {rawError && <div className="text-xs text-red-400">{rawError}</div>}
          <button className="btn btn-primary" onClick={applyRaw}>
            Apply JSON
          </button>
        </div>
      </details>

      <div className="text-[10px] leading-4 text-zinc-500">
        Fields: enabled, label, mode, network, allowedRoots, writableRoots.
        enabled=false disables run_command sandbox/path/network guards. Per-command
        input can still override mode, network, allowed roots, writable roots, and
        enabled for a single tool call.
      </div>
    </div>
  )
}

function SkillsTab() {
  const skills = useStore((s) => s.skills)
  const tools = useStore((s) => s.tools)
  const execTools = useStore((s) => s.execTools)
  const skillRoots = useStore((s) => s.skillRoots)
  const setSkillRoots = useStore((s) => s.setSkillRoots)
  const refreshSkills = useStore((s) => s.refreshSkills)
  const updateSkill = useStore((s) => s.updateSkill)
  const removeSkill = useStore((s) => s.removeSkill)
  const setBuiltinToolEnabled = useStore((s) => s.setBuiltinToolEnabled)
  const [rootsText, setRootsText] = useState(() => skillRoots.join('\n'))
  const [refreshing, setRefreshing] = useState(false)
  const [alertMessage, setAlertMessage] = useState<string | null>(null)
  const enabledCount = skills.filter((skill) => skill.enabled).length

  useEffect(() => {
    setRootsText((current) => {
      const normalized = current
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
      const next = skillRoots.join('\n')
      return normalized === next ? current : next
    })
  }, [skillRoots])

  const applyRoots = (value: string) => {
    setRootsText(value)
    setSkillRoots(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshSkills()
    } catch (e) {
      setAlertMessage((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="setup-section space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="label">skills ({enabledCount}/{skills.length})</div>
          <div className="mt-1 text-xs text-zinc-500">
            SKILL.md packages are exposed through the generated load_skill tool.
          </div>
        </div>
        <button className="btn" disabled={refreshing} onClick={refresh}>
          {refreshing ? 'Discovering...' : 'Discover'}
        </button>
      </div>

      <RunCommandSkillWarning
        skills={skills}
        tools={tools}
        execTools={execTools}
        onEnable={() => setBuiltinToolEnabled(RUN_COMMAND_TOOL_NAME, true)}
      />

      <div>
        <div className="label mb-1">skill roots</div>
        <textarea
          className="field-area font-mono text-xs"
          rows={3}
          placeholder="/absolute/path/to/skills&#10;leave empty for server defaults"
          value={rootsText}
          onChange={(e) => applyRoots(e.target.value)}
        />
        <div className="mt-1 text-[10px] text-zinc-600">
          One directory per line. Empty uses server defaults such as this repo's
          skills folder and the sibling rule_agent skills folder.
        </div>
      </div>

      {skills.length === 0 && (
        <div className="setup-empty-state">No SKILL.md packages discovered</div>
      )}
      {skills.map((skill, i) => (
        <SkillCatalogRow
          key={skill.id}
          skill={skill}
          onChange={(patch) => updateSkill(i, patch)}
          onRemove={() => removeSkill(i)}
        />
      ))}
      <AlertDialog
        open={!!alertMessage}
        title="Skill Discovery Failed"
        message={alertMessage ?? ''}
        onClose={() => setAlertMessage(null)}
      />
    </div>
  )
}

function McpTab() {
  const servers = useStore((s) => s.mcpServers)
  const addMcpServer = useStore((s) => s.addMcpServer)
  const updateMcpServer = useStore((s) => s.updateMcpServer)
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const updateMcpTool = useStore((s) => s.updateMcpTool)
  const refreshMcpServerTools = useStore((s) => s.refreshMcpServerTools)
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [alertMessage, setAlertMessage] = useState<string | null>(null)

  return (
    <div className="setup-section space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="label">mcp servers ({servers.length})</div>
        <button className="btn" onClick={addMcpServer}>
          + Add server
        </button>
      </div>
      {servers.length === 0 && (
        <div className="setup-empty-state">No MCP servers configured</div>
      )}
      {servers.map((server, i) => (
        <McpServerEditor
          key={server.id}
          server={server}
          busy={busyIndex === i}
          onChange={(patch) => updateMcpServer(i, patch)}
          onRemove={() => removeMcpServer(i)}
          onFetchTools={async () => {
            setBusyIndex(i)
            try {
              await refreshMcpServerTools(i)
            } catch (e) {
              setAlertMessage((e as Error).message)
            } finally {
              setBusyIndex(null)
            }
          }}
          onToolChange={(toolIdx, patch) => updateMcpTool(i, toolIdx, patch)}
        />
      ))}
      <AlertDialog
        open={!!alertMessage}
        title="MCP Tools Failed"
        message={alertMessage ?? ''}
        onClose={() => setAlertMessage(null)}
      />
    </div>
  )
}

function SkillCatalogRow({
  skill,
  onChange,
  onRemove,
}: {
  skill: SkillConfig
  onChange: (patch: Partial<SkillConfig>) => void
  onRemove: () => void
}) {
  return (
    <div className={`tool-library-row ${skill.enabled ? 'is-enabled' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2 text-xs">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={skill.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="block truncate font-mono text-zinc-200">{skill.name}</span>
            <span className="mt-1 block text-zinc-500">
              {skill.description || 'No description'}
            </span>
          </span>
        </label>
        <span className={`tool-status ${skill.enabled ? 'is-enabled' : ''}`}>
          {skill.enabled ? 'enabled' : 'off'}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-600">
        <span className="truncate">
          {skill.dirPath ? skill.dirPath : skill.source ?? 'manual'}
        </span>
        <button className="btn-danger" onClick={onRemove} title="Remove skill">
          x
        </button>
      </div>
      <div className="mt-2 text-[10px] text-zinc-500">
        model tool: <span className="font-mono">load_skill</span>
      </div>
    </div>
  )
}

function McpServerEditor({
  server,
  busy,
  onChange,
  onRemove,
  onFetchTools,
  onToolChange,
}: {
  server: McpServerConfig
  busy: boolean
  onChange: (patch: Partial<McpServerConfig>) => void
  onRemove: () => void
  onFetchTools: () => Promise<void>
  onToolChange: (toolIdx: number, patch: Partial<McpToolConfig>) => void
}) {
  const transport = server.transport ?? 'stdio'
  const isHttp = transport === 'streamablehttp'
  const canFetch = isHttp
    ? Boolean(server.url?.trim())
    : Boolean(server.command?.trim())
  const [argsText, setArgsText] = useState(() => (server.args ?? []).join('\n'))
  const [envText, setEnvText] = useState(() =>
    JSON.stringify(server.env ?? {}, null, 2),
  )
  const [headersText, setHeadersText] = useState(() =>
    JSON.stringify(server.headers ?? {}, null, 2),
  )
  const [envError, setEnvError] = useState<string | null>(null)
  const [headersError, setHeadersError] = useState<string | null>(null)

  useEffect(() => {
    setArgsText((current) => {
      const normalized = current
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
      const next = (server.args ?? []).join('\n')
      return normalized === next ? current : next
    })
  }, [server.args])

  useEffect(() => {
    setEnvText((current) => {
      try {
        if (JSON.stringify(JSON.parse(current || '{}')) === JSON.stringify(server.env ?? {})) {
          return current
        }
      } catch {
        return current
      }
      setEnvError(null)
      return JSON.stringify(server.env ?? {}, null, 2)
    })
  }, [server.env])

  useEffect(() => {
    setHeadersText((current) => {
      try {
        if (
          JSON.stringify(JSON.parse(current || '{}')) ===
          JSON.stringify(server.headers ?? {})
        ) {
          return current
        }
      } catch {
        return current
      }
      setHeadersError(null)
      return JSON.stringify(server.headers ?? {}, null, 2)
    })
  }, [server.headers])

  const setTransport = (nextTransport: McpServerConfig['transport']) => {
    onChange({ transport: nextTransport, tools: [] })
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          className="field flex-1"
          placeholder="server name"
          value={server.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button className="btn-danger" onClick={onRemove} title="Remove MCP server">
          x
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={server.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        enabled
      </label>

      <div>
        <div className="label mb-1">transport</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            className={`btn ${transport === 'stdio' ? 'btn-primary' : ''}`}
            onClick={() => setTransport('stdio')}
          >
            stdio
          </button>
          <button
            className={`btn ${transport === 'streamablehttp' ? 'btn-primary' : ''}`}
            onClick={() => setTransport('streamablehttp')}
          >
            streamablehttp
          </button>
        </div>
      </div>

      {isHttp ? (
        <>
          <input
            className="field"
            placeholder="https://example.com/mcp"
            value={server.url ?? ''}
            onChange={(e) => onChange({ url: e.target.value })}
          />
          <div>
            <div className="label mb-1">headers (JSON)</div>
            <textarea
              className={`field-area font-mono text-xs ${headersError ? 'border-red-700' : ''}`}
              rows={4}
              value={headersText}
              onChange={(e) => {
                const value = e.target.value
                setHeadersText(value)
                try {
                  const parsed = JSON.parse(value || '{}')
                  setHeadersError(null)
                  const headers =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                      ? Object.fromEntries(
                          Object.entries(parsed).map(([key, childValue]) => [
                            key,
                            String(childValue),
                          ]),
                        )
                      : {}
                  onChange({ headers })
                } catch (err) {
                  setHeadersError((err as Error).message)
                }
              }}
            />
            {headersError && (
              <div className="text-xs text-red-400 mt-1">{headersError}</div>
            )}
          </div>
        </>
      ) : (
        <>
          <input
            className="field"
            placeholder="command"
            value={server.command ?? ''}
            onChange={(e) => onChange({ command: e.target.value })}
          />
          <div>
            <div className="label mb-1">args</div>
            <textarea
              className="field-area font-mono text-xs"
              rows={3}
              value={argsText}
              onChange={(e) => {
                const value = e.target.value
                setArgsText(value)
                onChange({
                  args: value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }}
            />
          </div>
          <div>
            <div className="label mb-1">env (JSON)</div>
            <textarea
              className={`field-area font-mono text-xs ${envError ? 'border-red-700' : ''}`}
              rows={4}
              value={envText}
              onChange={(e) => {
                const value = e.target.value
                setEnvText(value)
                try {
                  const parsed = JSON.parse(value || '{}')
                  setEnvError(null)
                  const env =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                      ? Object.fromEntries(
                          Object.entries(parsed).map(([key, childValue]) => [
                            key,
                            String(childValue),
                          ]),
                        )
                      : {}
                  onChange({ env })
                } catch (err) {
                  setEnvError((err as Error).message)
                }
              }}
            />
            {envError && <div className="text-xs text-red-400 mt-1">{envError}</div>}
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <input
          className="field w-28"
          type="number"
          min={1000}
          value={server.timeout_ms ?? 15000}
          onChange={(e) => onChange({ timeout_ms: Number(e.target.value) })}
        />
        <button
          className="btn flex-1"
          disabled={!canFetch || busy || Boolean(envError || headersError)}
          onClick={onFetchTools}
        >
          {busy ? 'Fetching…' : 'Fetch tools'}
        </button>
      </div>
      <div className="space-y-1">
        <div className="label">tools ({server.tools.length})</div>
        {server.tools.length === 0 && (
          <div className="setup-empty-state">No tools fetched</div>
        )}
        {server.tools.map((tool, i) => (
          <McpToolRow
            key={tool.name}
            server={server}
            tool={tool}
            onChange={(patch) => onToolChange(i, patch)}
          />
        ))}
      </div>
    </div>
  )
}

function McpToolRow({
  server,
  tool,
  onChange,
}: {
  server: McpServerConfig
  tool: McpToolConfig
  onChange: (patch: Partial<McpToolConfig>) => void
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={tool.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span className="font-mono text-zinc-300 truncate">{tool.name}</span>
      </label>
      {tool.description && (
        <div className="mt-1 text-[10px] text-zinc-500">
          {tool.description}
        </div>
      )}
      <div className="mt-1 text-[10px] text-zinc-600 truncate">
        tool: <span className="font-mono">{toolNameForMcpTool(server, tool)}</span>
      </div>
    </div>
  )
}
