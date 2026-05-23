import { create } from 'zustand'
import type {
  AssistantContentBlock,
  AssistantMessage,
  Case,
  Config,
  ExecToolDef,
  ExecToolResponse,
  McpServerConfig,
  McpToolConfig,
  Message,
  ProviderInfo,
  SkillConfig,
  Tool,
  UserContentBlock,
  Usage,
} from '@llm-impl/shared'
import * as api from './api'
import type { CaseEntry } from './api'

type Status = 'idle' | 'running' | 'error'

const defaultConfig: Config = {
  provider: 'polo',
  model: 'claude-sonnet-4-6',
  temperature: 0,
  max_tokens: 4096,
  stream: false,
}

const emptyUserMessage = (): Message => ({
  role: 'user',
  content: [{ type: 'text', text: '' }],
})

const newToolUseId = (): string =>
  `toolu_${Math.random().toString(36).slice(2, 10)}`

const STREAM_DRAFT_FLUSH_MS = 50

type CaseMeta = Case['meta']
type SkillPatch = Partial<SkillConfig>
type McpServerPatch = Partial<McpServerConfig>
type McpToolPatch = Partial<McpToolConfig>

interface Store {
  // case state
  config: Config
  system: string
  tools: Tool[]
  skillRoots: string[]
  skills: SkillConfig[]
  mcpServers: McpServerConfig[]
  messages: Message[]

  // run state
  status: Status
  error: string | null
  lastUsage: Usage | null
  lastLatency: number | null
  lastStopReason: string | null

  // providers
  providers: ProviderInfo[]

  // server-registered tools that can be auto-executed
  execTools: ExecToolDef[]

  // cases tree
  cases: CaseEntry[]
  currentCasePath: string | null
  currentCaseMeta: CaseMeta | null

  // ─── actions ────────────────────────────────────────────────────────────
  setConfig: (patch: Partial<Config>) => void
  setSystem: (s: string) => void

  setBuiltinToolEnabled: (name: string, enabled: boolean) => void
  removeTool: (i: number) => void

  setSkillRoots: (roots: string[]) => void
  refreshSkills: () => Promise<void>
  updateSkill: (i: number, patch: SkillPatch) => void
  removeSkill: (i: number) => void

  addMcpServer: () => void
  updateMcpServer: (i: number, patch: McpServerPatch) => void
  removeMcpServer: (i: number) => void
  updateMcpTool: (serverIdx: number, toolIdx: number, patch: McpToolPatch) => void
  refreshMcpServerTools: (i: number) => Promise<void>

  addMessage: (role: 'user' | 'assistant') => void
  removeMessage: (i: number) => void
  truncateAfter: (i: number) => void

  addBlock: (msgIdx: number, blockType: string) => void
  removeBlock: (msgIdx: number, blockIdx: number) => void
  updateBlock: (
    msgIdx: number,
    blockIdx: number,
    patch: Record<string, unknown>,
  ) => void

  send: () => Promise<void>
  reset: () => void
  newCase: (dir?: string, name?: string) => Promise<void>

  exportJson: () => string
  importJson: (json: string) => void

  loadWorkspace: () => Promise<void>
  refreshProviders: () => Promise<void>
  refreshExecTools: () => Promise<void>
  runRegisteredTool: (msgIdx: number, blockIdx: number) => Promise<void>
  getEffectiveTools: () => Tool[]
  getEffectiveSystem: () => string
  canRunTool: (name: string) => boolean
  refreshCases: () => Promise<void>
  loadCase: (path: string) => Promise<void>
  saveCase: (path: string) => Promise<void>
  createCaseDir: (path: string) => Promise<void>
  moveCaseEntry: (from: string, to: string) => Promise<void>
  deleteCase: (path: string) => Promise<void>
}

type CaseBuildState = Pick<
  Store,
  | 'config'
  | 'system'
  | 'tools'
  | 'skillRoots'
  | 'skills'
  | 'mcpServers'
  | 'messages'
  | 'lastUsage'
  | 'lastLatency'
  | 'lastStopReason'
  | 'currentCaseMeta'
>

const caseNameFromPath = (path: string): string =>
  path.split('/').pop()?.replace(/\.json$/, '') || path

const newId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}`

const defaultObjectSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: {},
})

const loadSkillTool = (): Tool => ({
  name: 'load_skill',
  description:
    'Load the full instructions of a configured SKILL.md package by exact name. Use this before executing a task that matches an available skill.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact skill name from the Available Skills list',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
})

const sanitizeToolPart = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'tool'
}

export const toolNameForMcpTool = (
  server: Pick<McpServerConfig, 'id'>,
  tool: Pick<McpToolConfig, 'name'>,
): string =>
  `mcp__${sanitizeToolPart(server.id)}__${sanitizeToolPart(tool.name)}`.slice(0, 64)

const newMcpServer = (): McpServerConfig => ({
  id: newId('mcp'),
  name: 'new_mcp_server',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  enabled: true,
  timeout_ms: 15_000,
  tools: [],
})

const execToolToTool = (tool: ExecToolDef): Tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema,
})

const normalizeRelPath = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')

const joinRelPath = (...parts: string[]): string =>
  normalizeRelPath(parts.filter(Boolean).join('/'))

const newCaseFileName = (): string => {
  const d = new Date()
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return [
    'case-',
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
    '-',
    pad(d.getMilliseconds(), 3),
    '.json',
  ].join('')
}

const newCasePath = (dir = '', name?: string): string => {
  const baseName = name?.trim()
  const fileName = baseName
    ? `${baseName.replace(/\.json$/i, '')}.json`
    : newCaseFileName()
  return joinRelPath(dir, fileName)
}

const buildCaseFromState = (
  state: CaseBuildState,
  options: { touch?: boolean } = {},
): Case => {
  const meta =
    state.currentCaseMeta || options.touch
      ? { ...(state.currentCaseMeta ?? {}) }
      : undefined
  if (meta && options.touch) {
    meta.updatedAt = new Date().toISOString()
  }

  const hasLastRun =
    state.lastUsage || state.lastLatency !== null || state.lastStopReason

  return {
    ...(meta && Object.keys(meta).length > 0 && { meta }),
    config: state.config,
    ...(state.system && { system: state.system }),
    ...(state.tools.length > 0 && { tools: state.tools }),
    ...(state.skillRoots.length > 0 && { skillRoots: state.skillRoots }),
    ...(state.skills.length > 0 && { skills: state.skills }),
    ...(state.mcpServers.length > 0 && { mcpServers: state.mcpServers }),
    messages: state.messages,
    ...(hasLastRun && {
      lastRun: {
        timestamp: new Date().toISOString(),
        ...(state.lastUsage && { usage: state.lastUsage }),
        ...(state.lastLatency !== null && { latency_ms: state.lastLatency }),
        ...(state.lastStopReason && { stop_reason: state.lastStopReason }),
      },
    }),
  }
}

const freshCase = (path: string): Case => ({
  meta: {
    name: caseNameFromPath(path),
    updatedAt: new Date().toISOString(),
  },
  config: defaultConfig,
  skillRoots: [],
  skills: [],
  mcpServers: [],
  messages: [emptyUserMessage()],
})

const stableCaseFingerprint = (path: string, data: Case): string => {
  const stableMeta: NonNullable<CaseMeta> = {}
  if (data.meta?.name !== undefined) stableMeta.name = data.meta.name
  if (data.meta?.tags !== undefined) stableMeta.tags = data.meta.tags
  const stableLastRun = data.lastRun
    ? {
        timestamp: '',
        ...(data.lastRun.usage && { usage: data.lastRun.usage }),
        ...(data.lastRun.latency_ms !== undefined && {
          latency_ms: data.lastRun.latency_ms,
        }),
        ...(data.lastRun.stop_reason !== undefined && {
          stop_reason: data.lastRun.stop_reason,
        }),
      }
    : undefined
  const stableData: Case = {
    config: data.config,
    ...(data.system && { system: data.system }),
    ...(data.tools && { tools: data.tools }),
    ...(data.skillRoots && { skillRoots: data.skillRoots }),
    ...(data.skills && { skills: data.skills }),
    ...(data.mcpServers && { mcpServers: data.mcpServers }),
    messages: data.messages,
    ...(stableLastRun && { lastRun: stableLastRun }),
    ...(Object.keys(stableMeta).length > 0 && { meta: stableMeta }),
  }
  return JSON.stringify({ path, data: stableData })
}

let lastSavedCaseFingerprint: string | null = null

const rememberSavedCase = (path: string, data: Case) => {
  lastSavedCaseFingerprint = stableCaseFingerprint(path, data)
}

function buildMcpTool(server: McpServerConfig, tool: McpToolConfig): Tool | null {
  if (!server.enabled || !tool.enabled) return null
  return {
    name: toolNameForMcpTool(server, tool),
    description: [
      `MCP ${server.name} / ${tool.name}.`,
      tool.description?.trim(),
    ]
      .filter(Boolean)
      .join(' '),
    input_schema: tool.input_schema ?? defaultObjectSchema(),
  }
}

function buildEffectiveToolsFromState(state: Pick<Store, 'tools' | 'skills' | 'mcpServers'>): Tool[] {
  const generated = [
    ...(state.skills.some((skill) => skill.enabled) ? [loadSkillTool()] : []),
    ...state.mcpServers.flatMap((server) =>
      server.tools
        .map((tool) => buildMcpTool(server, tool))
        .filter((tool): tool is Tool => !!tool),
    ),
  ]
  const seen = new Set<string>()
  return [...state.tools, ...generated].filter((tool) => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

function buildSkillCatalog(skills: SkillConfig[]): string {
  const enabled = skills.filter((skill) => skill.enabled)
  if (enabled.length === 0) return ''
  const lines = enabled.map((skill) => {
    const dir = skill.dirPath ? ` (dir: \`${skill.dirPath}\`)` : ''
    return `- \`${skill.name}\`${dir}: ${skill.description || '(no description)'}`
  })
  return [
    '## Available Skills (NOT tools — cannot be called directly)',
    '',
    'Skills are NOT tools. You CANNOT call a skill name as a tool.',
    'To use a skill, you MUST first call the `load_skill` tool with the skill name.',
    'The `load_skill` tool will return instructions and context for the skill.',
    'Only load skills that are relevant to the current task.',
    'When executing skill scripts via run_command, always set working_directory to the skill directory shown in parentheses.',
    '',
    ...lines,
  ].join('\n')
}

function buildEffectiveSystemFromState(state: Pick<Store, 'system' | 'skills'>): string {
  const catalog = buildSkillCatalog(state.skills)
  return [state.system.trim(), catalog].filter(Boolean).join('\n\n')
}

export const useStore = create<Store>()(
  (set, get) => ({
      config: defaultConfig,
      system: '',
      tools: [],
      skillRoots: [],
      skills: [],
      mcpServers: [],
      messages: [emptyUserMessage()],
      status: 'idle',
      error: null,
      lastUsage: null,
      lastLatency: null,
      lastStopReason: null,
      providers: [],
      execTools: [],
      cases: [],
      currentCasePath: null,
      currentCaseMeta: null,

      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      setSystem: (system) => set({ system }),

      setBuiltinToolEnabled: (name, enabled) =>
        set((s) => {
          const execTool = s.execTools.find((tool) => tool.name === name)
          if (!execTool) return s
          const nextTool = execToolToTool(execTool)
          const exists = s.tools.some((tool) => tool.name === name)

          if (enabled) {
            return {
              tools: exists
                ? s.tools.map((tool) => (tool.name === name ? nextTool : tool))
                : [...s.tools, nextTool],
            }
          }

          if (!exists) return s
          return { tools: s.tools.filter((tool) => tool.name !== name) }
        }),
      removeTool: (i) =>
        set((s) => ({ tools: s.tools.filter((_, idx) => idx !== i) })),

      setSkillRoots: (skillRoots) => set({ skillRoots }),
      refreshSkills: async () => {
        const { skillRoots, skills } = get()
        const result = await api.listSkills(skillRoots)
        if (!result.ok) throw new Error(result.error ?? 'skill discovery failed')
        const previous = new Map(skills.map((skill) => [skill.name, skill]))
        const discoveredNames = new Set((result.skills ?? []).map((skill) => skill.name))
        const discovered = (result.skills ?? []).map((skill) => {
          const old = previous.get(skill.name)
          return {
            ...skill,
            enabled: old?.enabled ?? skill.enabled,
            preload: old?.preload ?? skill.preload,
          }
        })
        const retained = skills.filter((skill) => !discoveredNames.has(skill.name))
        set({ skills: [...discovered, ...retained] })
      },
      updateSkill: (i, patch) =>
        set((s) => ({
          skills: s.skills.map((skill, idx) =>
            idx === i ? { ...skill, ...patch } : skill,
          ),
        })),
      removeSkill: (i) =>
        set((s) => ({ skills: s.skills.filter((_, idx) => idx !== i) })),

      addMcpServer: () =>
        set((s) => ({
          mcpServers: [...s.mcpServers, newMcpServer()],
        })),
      updateMcpServer: (i, patch) =>
        set((s) => ({
          mcpServers: s.mcpServers.map((server, idx) =>
            idx === i ? { ...server, ...patch } : server,
          ),
        })),
      removeMcpServer: (i) =>
        set((s) => ({
          mcpServers: s.mcpServers.filter((_, idx) => idx !== i),
        })),
      updateMcpTool: (serverIdx, toolIdx, patch) =>
        set((s) => ({
          mcpServers: s.mcpServers.map((server, idx) =>
            idx === serverIdx
              ? {
                  ...server,
                  tools: server.tools.map((tool, tIdx) =>
                    tIdx === toolIdx ? { ...tool, ...patch } : tool,
                  ),
                }
              : server,
          ),
        })),
      refreshMcpServerTools: async (i) => {
        const server = get().mcpServers[i]
        if (!server) return
        const result = await api.listMcpTools(server)
        if (!result.ok) throw new Error(result.error ?? 'MCP list-tools failed')
        const previousEnabled = new Map(
          server.tools.map((tool) => [tool.name, tool.enabled ?? true]),
        )
        const tools = (result.tools ?? []).map((tool) => ({
          ...tool,
          enabled: previousEnabled.get(tool.name) ?? tool.enabled ?? true,
        }))
        set((s) => ({
          mcpServers: s.mcpServers.map((item, idx) =>
            idx === i ? { ...item, tools } : item,
          ),
        }))
      },

      addMessage: (role) =>
        set((s) => ({
          messages: [
            ...s.messages,
            role === 'user'
              ? { role: 'user', content: [{ type: 'text', text: '' }] }
              : { role: 'assistant', content: [{ type: 'text', text: '' }] },
          ],
        })),
      removeMessage: (i) =>
        set((s) => ({ messages: s.messages.filter((_, idx) => idx !== i) })),
      truncateAfter: (i) =>
        set((s) => ({ messages: s.messages.slice(0, i + 1) })),

      addBlock: (msgIdx, blockType) =>
        set((s) => {
          const msgs = [...s.messages]
          const msg = msgs[msgIdx]
          if (!msg) return s
          const newContent = [...msg.content]
          if (msg.role === 'user') {
            const block: UserContentBlock | null =
              blockType === 'text'
                ? { type: 'text', text: '' }
                : blockType === 'image'
                  ? { type: 'image', source: { type: 'url', url: '' } }
                : blockType === 'tool_result'
                  ? { type: 'tool_result', tool_use_id: '', content: '' }
                  : null
            if (block) newContent.push(block)
            msgs[msgIdx] = { role: 'user', content: newContent as UserContentBlock[] }
          } else {
            const block: AssistantContentBlock | null =
              blockType === 'text'
                ? { type: 'text', text: '' }
                : blockType === 'tool_use'
                  ? {
                      type: 'tool_use',
                      id: newToolUseId(),
                      name: '',
                      input: {},
                    }
                  : blockType === 'thinking'
                    ? { type: 'thinking', thinking: '' }
                    : null
            if (block) newContent.push(block)
            msgs[msgIdx] = {
              role: 'assistant',
              content: newContent as AssistantContentBlock[],
            }
          }
          return { messages: msgs }
        }),

      removeBlock: (msgIdx, blockIdx) =>
        set((s) => {
          const msgs = [...s.messages]
          const msg = msgs[msgIdx]
          if (!msg) return s
          const newContent = msg.content.filter((_, i) => i !== blockIdx)
          msgs[msgIdx] = { ...msg, content: newContent } as Message
          return { messages: msgs }
        }),

      updateBlock: (msgIdx, blockIdx, patch) =>
        set((s) => {
          const msgs = [...s.messages]
          const msg = msgs[msgIdx]
          if (!msg) return s
          const newContent = msg.content.map((b, i) =>
            i === blockIdx ? { ...b, ...patch } : b,
          )
          msgs[msgIdx] = { ...msg, content: newContent } as Message
          return { messages: msgs }
        }),

      send: async () => {
        set({ status: 'running', error: null })
        let flushPendingDraft: (() => void) | null = null
        try {
          const { config, messages } = get()
          const system = get().getEffectiveSystem()
          const tools = get().getEffectiveTools()

          // append an empty draft assistant message that we'll fill in as
          // events arrive
          const draftIdx = messages.length
          let draftMessage: AssistantMessage = { role: 'assistant', content: [] }
          set({
            messages: [...messages, draftMessage],
          })

          const inputBuffers = new Map<number, string>()
          let flushTimer: ReturnType<typeof setTimeout> | null = null
          let hasPendingDraft = false

          const flushDraft = () => {
            if (flushTimer) {
              clearTimeout(flushTimer)
              flushTimer = null
            }
            if (!hasPendingDraft) return
            hasPendingDraft = false
            set((s) => {
              const msgs = [...s.messages]
              const cur = msgs[draftIdx]
              if (!cur || cur.role !== 'assistant') return s
              msgs[draftIdx] = draftMessage
              return { messages: msgs }
            })
          }
          flushPendingDraft = flushDraft

          const scheduleDraftFlush = () => {
            hasPendingDraft = true
            if (flushTimer) return
            flushTimer = setTimeout(flushDraft, STREAM_DRAFT_FLUSH_MS)
          }

          const updateDraft = (
            mut: (msg: AssistantMessage) => AssistantMessage,
          ) => {
            draftMessage = mut(draftMessage)
            scheduleDraftFlush()
          }

          let stopReason: string | null = null
          let usage: Usage | null = null
          let latency: number | null = null

          const stream = api.postRunStream({
            config,
            system: system || undefined,
            tools: tools.length > 0 ? tools : undefined,
            messages,
          })

          for await (const ev of stream) {
            if (ev.type === 'block_start') {
              updateDraft((m) => {
                const content = [...m.content]
                content[ev.index] = ev.block
                return { ...m, content }
              })
              if (ev.block.type === 'tool_use') {
                inputBuffers.set(ev.index, '')
              }
            } else if (ev.type === 'text_delta') {
              updateDraft((m) => {
                const content = [...m.content]
                const b = content[ev.index]
                if (b && b.type === 'text') {
                  content[ev.index] = { ...b, text: b.text + ev.delta }
                }
                return { ...m, content }
              })
            } else if (ev.type === 'thinking_delta') {
              updateDraft((m) => {
                const content = [...m.content]
                const b = content[ev.index]
                if (b && b.type === 'thinking') {
                  content[ev.index] = {
                    ...b,
                    thinking: b.thinking + ev.delta,
                  }
                }
                return { ...m, content }
              })
            } else if (ev.type === 'thinking_signature_delta') {
              updateDraft((m) => {
                const content = [...m.content]
                const b = content[ev.index]
                if (b && b.type === 'thinking') {
                  content[ev.index] = {
                    ...b,
                    signature: `${b.signature ?? ''}${ev.delta}`,
                  }
                }
                return { ...m, content }
              })
            } else if (ev.type === 'tool_input_delta') {
              const buf = (inputBuffers.get(ev.index) ?? '') + ev.delta
              inputBuffers.set(ev.index, buf)
            } else if (ev.type === 'block_stop') {
              const buf = inputBuffers.get(ev.index)
              if (buf !== undefined) {
                try {
                  const parsed = JSON.parse(buf || '{}') as Record<
                    string,
                    unknown
                  >
                  updateDraft((m) => {
                    const content = [...m.content]
                    const b = content[ev.index]
                    if (b && b.type === 'tool_use') {
                      content[ev.index] = { ...b, input: parsed }
                    }
                    return { ...m, content }
                  })
                } catch {
                  /* leave whatever we have */
                }
              }
            } else if (ev.type === 'message_stop') {
              stopReason = ev.stop_reason ?? null
              usage = ev.usage ?? null
              latency = ev.latency_ms ?? null
            } else if (ev.type === 'error') {
              throw new Error(ev.message)
            }
          }

          flushDraft()

          // After stream done: if assistant emitted tool_use blocks, auto-stub
          // a user message with empty tool_result blocks
          const finalDraft = get().messages[draftIdx]
          if (finalDraft && finalDraft.role === 'assistant') {
            const toolUses = finalDraft.content.filter(
              (b): b is Extract<AssistantContentBlock, { type: 'tool_use' }> =>
                b.type === 'tool_use',
            )
            if (toolUses.length > 0) {
              set((s) => ({
                messages: [
                  ...s.messages,
                  {
                    role: 'user',
                    content: toolUses.map((tu) => ({
                      type: 'tool_result' as const,
                      tool_use_id: tu.id,
                      content: '',
                    })),
                  },
                ],
              }))
            }
          }

          set({
            status: 'idle',
            lastUsage: usage,
            lastLatency: latency,
            lastStopReason: stopReason,
          })
        } catch (e) {
          flushPendingDraft?.()
          set({ status: 'error', error: (e as Error).message })
        }
      },

      reset: () =>
        set({
          messages: [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: null,
          lastLatency: null,
          lastStopReason: null,
        }),

      newCase: async (dir, name) => {
        const path = newCasePath(dir, name)
        const data = freshCase(path)
        await api.writeCase(path, data)
        rememberSavedCase(path, data)
        set({
          config: data.config,
          system: '',
          tools: [],
          skills: data.skills ?? [],
          mcpServers: data.mcpServers ?? [],
          skillRoots: data.skillRoots ?? [],
          messages: data.messages,
          status: 'idle',
          error: null,
          lastUsage: null,
          lastLatency: null,
          lastStopReason: null,
          currentCasePath: path,
          currentCaseMeta: data.meta ?? null,
        })
        await get().refreshCases()
      },

      exportJson: () => {
        const c = buildCaseFromState(get())
        return JSON.stringify(c, null, 2)
      },

      importJson: (json) => {
        const parsed = JSON.parse(json) as Case
        set({
          config: parsed.config ?? defaultConfig,
          system: parsed.system ?? '',
          tools: parsed.tools ?? [],
          skillRoots: parsed.skillRoots ?? [],
          skills: parsed.skills ?? [],
          mcpServers: parsed.mcpServers ?? [],
          messages: parsed.messages ?? [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: parsed.lastRun?.usage ?? null,
          lastLatency: parsed.lastRun?.latency_ms ?? null,
          lastStopReason: parsed.lastRun?.stop_reason ?? null,
          currentCaseMeta: parsed.meta ?? null,
        })
      },

      loadWorkspace: async () => {
        try {
          const ws = (await api.getWorkspace()) as
            | (Partial<Store> & { lastUsage?: Usage; lastLatency?: number; lastStopReason?: string })
            | null
          if (!ws) return
          const currentCasePath = ws.currentCasePath ?? null
          if (currentCasePath) {
            try {
              const data = await api.readCase(currentCasePath)
              rememberSavedCase(currentCasePath, data)
              set({
                config: data.config ?? defaultConfig,
                system: data.system ?? '',
                tools: data.tools ?? [],
                skillRoots: data.skillRoots ?? [],
                skills: data.skills ?? [],
                mcpServers: data.mcpServers ?? [],
                messages: data.messages ?? [emptyUserMessage()],
                currentCasePath,
                currentCaseMeta: data.meta ?? null,
                lastUsage: data.lastRun?.usage ?? null,
                lastLatency: data.lastRun?.latency_ms ?? null,
                lastStopReason: data.lastRun?.stop_reason ?? null,
              })
              return
            } catch {
              /* fall back to the workspace draft if the case file is gone */
            }
          }
          set({
            config: ws.config ?? defaultConfig,
            system: ws.system ?? '',
            tools: ws.tools ?? [],
            skillRoots: ws.skillRoots ?? [],
            skills: ws.skills ?? [],
            mcpServers: ws.mcpServers ?? [],
            messages:
              ws.messages && ws.messages.length > 0
                ? ws.messages
                : [emptyUserMessage()],
            currentCasePath,
            currentCaseMeta: null,
            lastUsage: ws.lastUsage ?? null,
            lastLatency: ws.lastLatency ?? null,
            lastStopReason: ws.lastStopReason ?? null,
          })
        } catch (e) {
          set({ error: (e as Error).message })
        }
      },

      refreshProviders: async () => {
        try {
          const providers = await api.listProviders()
          set({ providers })
          // if current provider/model no longer valid, fall back to first
          const { config } = get()
          const cur = providers.find((p) => p.key === config.provider)
          if (!cur && providers[0]) {
            const first = providers[0]
            set({
              config: {
                ...config,
                provider: first.key,
                model: first.models[0]?.id ?? '',
              },
            })
          } else if (cur && !cur.models.some((m) => m.id === config.model)) {
            set({
              config: { ...config, model: cur.models[0]?.id ?? config.model },
            })
          }
        } catch (e) {
          set({ error: (e as Error).message })
        }
      },

      refreshExecTools: async () => {
        try {
          const tools = await api.listExecTools()
          set({ execTools: tools })
        } catch (e) {
          set({ error: (e as Error).message })
        }
      },

      runRegisteredTool: async (msgIdx, blockIdx) => {
        const { messages, execTools, tools } = get()
        const msg = messages[msgIdx]
        if (!msg || msg.role !== 'user') return
        const block = msg.content[blockIdx]
        if (!block || block.type !== 'tool_result') return
        // find the corresponding tool_use to know the name + input
        let tu: Extract<AssistantContentBlock, { type: 'tool_use' }> | null =
          null
        for (const m of messages) {
          if (m.role !== 'assistant') continue
          for (const b of m.content) {
            if (b.type === 'tool_use' && b.id === block.tool_use_id) {
              tu = b
              break
            }
          }
          if (tu) break
        }
        if (!tu) {
          set((s) => ({
            messages: s.messages.map((m, i) =>
              i === msgIdx
                ? {
                    ...m,
                    content: m.content.map((b, j) =>
                      j === blockIdx
                        ? {
                            ...b,
                            content: 'no matching tool_use found',
                            is_error: true,
                          }
                        : b,
                    ),
                  }
                : m,
            ) as Message[],
          }))
          return
        }
        const writeToolResult = (result: ExecToolResponse) => {
          set((s) => ({
            messages: s.messages.map((m, i) =>
              i === msgIdx
                ? {
                    ...m,
                    content: m.content.map((b, j) =>
                      j === blockIdx
                        ? {
                            ...b,
                            content: result.content,
                            is_error: result.is_error ?? false,
                          }
                        : b,
                    ),
                  }
                : m,
            ) as Message[],
          }))
        }

        const skillName =
          tu.name === 'load_skill' && typeof tu.input.name === 'string'
            ? tu.input.name.trim()
            : ''
        const skill = skillName
          ? get().skills.find((item) => item.enabled && item.name === skillName)
          : undefined
        const mcpMatch = get().mcpServers
          .filter((server) => server.enabled)
          .flatMap((server) =>
            server.tools
              .filter((tool) => tool.enabled)
              .map((tool) => ({ server, tool })),
          )
          .find(({ server, tool }) => toolNameForMcpTool(server, tool) === tu!.name)

        const builtInToolIsSelected =
          tools.some((tool) => tool.name === tu!.name) &&
          execTools.some((tool) => tool.name === tu!.name)

        if (tu.name === 'load_skill' && !skill) {
          writeToolResult({
            content: `Error: Unknown or disabled skill '${skillName || '(empty)'}'.`,
            is_error: true,
          })
          return
        }

        if (!skill && !mcpMatch && !builtInToolIsSelected) {
          writeToolResult({
            content: `tool '${tu!.name}' is not configured as a runnable tool`,
            is_error: true,
          })
          return
        }
        try {
          const result = skill
            ? await api.loadSkill(skill)
            : mcpMatch
              ? await api.callMcpTool(mcpMatch.server, mcpMatch.tool.name, tu.input)
              : await api.execTool(tu.name, tu.input)
          writeToolResult(result)
        } catch (e) {
          writeToolResult({
            content: (e as Error).message,
            is_error: true,
          })
        }
      },

      getEffectiveTools: () => buildEffectiveToolsFromState(get()),
      getEffectiveSystem: () => buildEffectiveSystemFromState(get()),

      canRunTool: (name) => {
        const state = get()
        if (name === 'load_skill' && state.skills.some((skill) => skill.enabled)) {
          return true
        }
        if (
          state.tools.some((tool) => tool.name === name) &&
          state.execTools.some((tool) => tool.name === name)
        ) {
          return true
        }
        return state.mcpServers.some(
          (server) =>
            server.enabled &&
            server.tools.some(
              (tool) =>
                tool.enabled && toolNameForMcpTool(server, tool) === name,
            ),
        )
      },

      refreshCases: async () => {
        try {
          const cases = await api.listCases()
          set({ cases })
        } catch (e) {
          set({ error: (e as Error).message })
        }
      },

      loadCase: async (path) => {
        const data = await api.readCase(path)
        rememberSavedCase(path, data)
        set({
          config: data.config ?? defaultConfig,
          system: data.system ?? '',
          tools: data.tools ?? [],
          skillRoots: data.skillRoots ?? [],
          skills: data.skills ?? [],
          mcpServers: data.mcpServers ?? [],
          messages: data.messages ?? [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: data.lastRun?.usage ?? null,
          lastLatency: data.lastRun?.latency_ms ?? null,
          lastStopReason: data.lastRun?.stop_reason ?? null,
          currentCasePath: path,
          currentCaseMeta: data.meta ?? null,
        })
      },

      saveCase: async (path) => {
        const data = buildCaseFromState(get(), { touch: true })
        await api.writeCase(path, data)
        rememberSavedCase(path, data)
        set({ currentCasePath: path, currentCaseMeta: data.meta ?? null })
        await get().refreshCases()
      },

      createCaseDir: async (path) => {
        await api.createCaseDir(normalizeRelPath(path))
        await get().refreshCases()
      },

      moveCaseEntry: async (from, to) => {
        const normalizedFrom = normalizeRelPath(from)
        const normalizedTo = normalizeRelPath(to)
        if (!normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) {
          return
        }
        await api.moveCaseEntry(normalizedFrom, normalizedTo)
        const currentCasePath = get().currentCasePath
        if (
          currentCasePath === normalizedFrom ||
          currentCasePath?.startsWith(`${normalizedFrom}/`)
        ) {
          const nextPath =
            currentCasePath === normalizedFrom
              ? normalizedTo
              : `${normalizedTo}${currentCasePath.slice(normalizedFrom.length)}`
          set({ currentCasePath: nextPath })
        }
        await get().refreshCases()
      },

      deleteCase: async (path) => {
        await api.deleteCase(path)
        if (get().currentCasePath === path) {
          lastSavedCaseFingerprint = null
          set({ currentCasePath: null, currentCaseMeta: null })
        }
        await get().refreshCases()
      },
    }),
)

// ─── server-side persistence (auto-save with debounce) ─────────────────────
let workspaceSaveTimer: ReturnType<typeof setTimeout> | null = null
let caseSaveTimer: ReturnType<typeof setTimeout> | null = null
let saveEnabled = false

export function enableAutoSave() {
  saveEnabled = true
}

useStore.subscribe((state, prev) => {
  if (!saveEnabled) return
  if (
    state.config === prev.config &&
    state.system === prev.system &&
    state.tools === prev.tools &&
    state.skillRoots === prev.skillRoots &&
    state.skills === prev.skills &&
    state.mcpServers === prev.mcpServers &&
    state.messages === prev.messages &&
    state.currentCasePath === prev.currentCasePath &&
    state.currentCaseMeta === prev.currentCaseMeta &&
    state.lastUsage === prev.lastUsage &&
    state.lastLatency === prev.lastLatency &&
    state.lastStopReason === prev.lastStopReason &&
    state.status === prev.status
  ) {
    return
  }

  if (state.status === 'running') {
    if (workspaceSaveTimer) clearTimeout(workspaceSaveTimer)
    if (caseSaveTimer) clearTimeout(caseSaveTimer)
    workspaceSaveTimer = null
    caseSaveTimer = null
    return
  }

  if (workspaceSaveTimer) clearTimeout(workspaceSaveTimer)
  workspaceSaveTimer = setTimeout(() => {
    api
      .saveWorkspace({
        config: state.config,
        system: state.system,
        tools: state.tools,
        skillRoots: state.skillRoots,
        skills: state.skills,
        mcpServers: state.mcpServers,
        messages: state.messages,
        currentCasePath: state.currentCasePath,
        lastUsage: state.lastUsage,
        lastLatency: state.lastLatency,
        lastStopReason: state.lastStopReason,
      })
      .catch((e) => console.error('workspace save failed:', e))
  }, 400)

  if (!state.currentCasePath) {
    if (caseSaveTimer) clearTimeout(caseSaveTimer)
    caseSaveTimer = null
    return
  }

  const path = state.currentCasePath
  if (caseSaveTimer) clearTimeout(caseSaveTimer)
  caseSaveTimer = setTimeout(() => {
    const latest = useStore.getState()
    if (latest.currentCasePath !== path) return
    const data = buildCaseFromState(latest, { touch: true })
    if (stableCaseFingerprint(path, data) === lastSavedCaseFingerprint) return
    api
      .writeCase(path, data)
      .then(() => rememberSavedCase(path, data))
      .catch((e) => console.error('case save failed:', e))
  }, 500)
})
