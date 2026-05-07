import { create } from 'zustand'
import type {
  AssistantContentBlock,
  AssistantMessage,
  Case,
  Config,
  ExecToolDef,
  Message,
  ProviderInfo,
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

interface Store {
  // case state
  config: Config
  system: string
  tools: Tool[]
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

  // ─── actions ────────────────────────────────────────────────────────────
  setConfig: (patch: Partial<Config>) => void
  setSystem: (s: string) => void

  addTool: () => void
  updateTool: (i: number, patch: Partial<Tool>) => void
  removeTool: (i: number) => void

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
  newCase: () => void

  exportJson: () => string
  importJson: (json: string) => void

  loadWorkspace: () => Promise<void>
  refreshProviders: () => Promise<void>
  refreshExecTools: () => Promise<void>
  runRegisteredTool: (msgIdx: number, blockIdx: number) => Promise<void>
  refreshCases: () => Promise<void>
  loadCase: (path: string) => Promise<void>
  saveCase: (path: string) => Promise<void>
  deleteCase: (path: string) => Promise<void>
}

export const useStore = create<Store>()(
  (set, get) => ({
      config: defaultConfig,
      system: '',
      tools: [],
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

      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      setSystem: (system) => set({ system }),

      addTool: () =>
        set((s) => ({
          tools: [
            ...s.tools,
            {
              name: 'new_tool',
              description: '',
              input_schema: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          ],
        })),
      updateTool: (i, patch) =>
        set((s) => ({
          tools: s.tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
        })),
      removeTool: (i) =>
        set((s) => ({ tools: s.tools.filter((_, idx) => idx !== i) })),

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
        try {
          const { config, system, tools, messages } = get()

          // append an empty draft assistant message that we'll fill in as
          // events arrive
          const draftIdx = messages.length
          set({
            messages: [...messages, { role: 'assistant', content: [] }],
          })

          const inputBuffers = new Map<number, string>()

          const updateDraft = (
            mut: (msg: AssistantMessage) => AssistantMessage,
          ) => {
            set((s) => {
              const msgs = [...s.messages]
              const cur = msgs[draftIdx]
              if (!cur || cur.role !== 'assistant') return s
              msgs[draftIdx] = mut(cur)
              return { messages: msgs }
            })
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
            } else if (ev.type === 'tool_input_delta') {
              const buf = (inputBuffers.get(ev.index) ?? '') + ev.delta
              inputBuffers.set(ev.index, buf)
              try {
                const parsed = JSON.parse(buf) as Record<string, unknown>
                updateDraft((m) => {
                  const content = [...m.content]
                  const b = content[ev.index]
                  if (b && b.type === 'tool_use') {
                    content[ev.index] = { ...b, input: parsed }
                  }
                  return { ...m, content }
                })
              } catch {
                /* partial JSON — wait for more deltas */
              }
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

      newCase: () =>
        set({
          config: defaultConfig,
          system: '',
          tools: [],
          messages: [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: null,
          lastLatency: null,
          lastStopReason: null,
          currentCasePath: null,
        }),

      exportJson: () => {
        const { config, system, tools, messages, lastUsage, lastLatency, lastStopReason } =
          get()
        const c: Case = {
          config,
          ...(system && { system }),
          ...(tools.length > 0 && { tools }),
          messages,
          ...((lastUsage || lastLatency !== null) && {
            lastRun: {
              timestamp: new Date().toISOString(),
              ...(lastUsage && { usage: lastUsage }),
              ...(lastLatency !== null && { latency_ms: lastLatency }),
              ...(lastStopReason && { stop_reason: lastStopReason }),
            },
          }),
        }
        return JSON.stringify(c, null, 2)
      },

      importJson: (json) => {
        const parsed = JSON.parse(json) as Case
        set({
          config: parsed.config ?? defaultConfig,
          system: parsed.system ?? '',
          tools: parsed.tools ?? [],
          messages: parsed.messages ?? [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: parsed.lastRun?.usage ?? null,
          lastLatency: parsed.lastRun?.latency_ms ?? null,
          lastStopReason: parsed.lastRun?.stop_reason ?? null,
        })
      },

      loadWorkspace: async () => {
        try {
          const ws = (await api.getWorkspace()) as
            | (Partial<Store> & { lastUsage?: Usage; lastLatency?: number; lastStopReason?: string })
            | null
          if (!ws) return
          set({
            config: ws.config ?? defaultConfig,
            system: ws.system ?? '',
            tools: ws.tools ?? [],
            messages:
              ws.messages && ws.messages.length > 0
                ? ws.messages
                : [emptyUserMessage()],
            currentCasePath: ws.currentCasePath ?? null,
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
        const { messages, execTools } = get()
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
        if (!execTools.some((t) => t.name === tu!.name)) {
          set((s) => ({
            messages: s.messages.map((m, i) =>
              i === msgIdx
                ? {
                    ...m,
                    content: m.content.map((b, j) =>
                      j === blockIdx
                        ? {
                            ...b,
                            content: `tool '${tu!.name}' is not registered on the server`,
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
        try {
          const result = await api.execTool(tu.name, tu.input)
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
        } catch (e) {
          set((s) => ({
            messages: s.messages.map((m, i) =>
              i === msgIdx
                ? {
                    ...m,
                    content: m.content.map((b, j) =>
                      j === blockIdx
                        ? {
                            ...b,
                            content: (e as Error).message,
                            is_error: true,
                          }
                        : b,
                    ),
                  }
                : m,
            ) as Message[],
          }))
        }
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
        set({
          config: data.config ?? defaultConfig,
          system: data.system ?? '',
          tools: data.tools ?? [],
          messages: data.messages ?? [emptyUserMessage()],
          status: 'idle',
          error: null,
          lastUsage: data.lastRun?.usage ?? null,
          lastLatency: data.lastRun?.latency_ms ?? null,
          lastStopReason: data.lastRun?.stop_reason ?? null,
          currentCasePath: path,
        })
      },

      saveCase: async (path) => {
        const json = get().exportJson()
        const data = JSON.parse(json) as Case
        if (data.meta) {
          data.meta.updatedAt = new Date().toISOString()
        } else {
          data.meta = { updatedAt: new Date().toISOString() }
        }
        await api.writeCase(path, data)
        set({ currentCasePath: path })
        await get().refreshCases()
      },

      deleteCase: async (path) => {
        await api.deleteCase(path)
        if (get().currentCasePath === path) set({ currentCasePath: null })
        await get().refreshCases()
      },
    }),
)

// ─── server-side persistence (auto-save with debounce) ─────────────────────
let saveTimer: ReturnType<typeof setTimeout> | null = null
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
    state.messages === prev.messages &&
    state.currentCasePath === prev.currentCasePath &&
    state.lastUsage === prev.lastUsage &&
    state.lastLatency === prev.lastLatency &&
    state.lastStopReason === prev.lastStopReason
  ) {
    return
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    api
      .saveWorkspace({
        config: state.config,
        system: state.system,
        tools: state.tools,
        messages: state.messages,
        currentCasePath: state.currentCasePath,
        lastUsage: state.lastUsage,
        lastLatency: state.lastLatency,
        lastStopReason: state.lastStopReason,
      })
      .catch((e) => console.error('workspace save failed:', e))
  }, 400)
})
