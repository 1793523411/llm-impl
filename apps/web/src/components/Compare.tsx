import { useState } from 'react'
import type {
  AssistantContentBlock,
  AssistantMessage,
  Config,
  Usage,
} from '@llm-impl/shared'
import { useStore } from '../store'
import * as api from '../api'

type PaneState = {
  config: Config
  message: AssistantMessage
  status: 'idle' | 'running' | 'done' | 'error'
  error?: string
  usage?: Usage | null
  latency?: number | null
  stopReason?: string | null
}

export function Compare({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers)
  const baseConfig = useStore((s) => s.config)
  const system = useStore((s) => s.system)
  const tools = useStore((s) => s.tools)
  const messages = useStore((s) => s.messages)

  const [left, setLeft] = useState<PaneState>(() => ({
    config: { ...baseConfig },
    message: { role: 'assistant', content: [] },
    status: 'idle',
  }))
  const [right, setRight] = useState<PaneState>(() => {
    // pick a different provider/model if possible
    const others = providers.filter((p) => p.key !== baseConfig.provider)
    const second = others[0] ?? providers[0]
    return {
      config: {
        ...baseConfig,
        provider: second?.key ?? baseConfig.provider,
        model: second?.models[0]?.id ?? baseConfig.model,
      },
      message: { role: 'assistant', content: [] },
      status: 'idle',
    }
  })
  const [running, setRunning] = useState(false)

  const runOne = async (
    setter: (updater: (s: PaneState) => PaneState) => void,
    config: Config,
  ) => {
    setter((s) => ({
      ...s,
      message: { role: 'assistant', content: [] },
      status: 'running',
      error: undefined,
      usage: undefined,
      latency: undefined,
      stopReason: undefined,
    }))
    const inputBuffers = new Map<number, string>()
    try {
      for await (const ev of api.postRunStream({
        config,
        system: system || undefined,
        tools: tools.length > 0 ? tools : undefined,
        messages,
      })) {
        if (ev.type === 'block_start') {
          setter((s) => {
            const content = [...s.message.content]
            content[ev.index] = ev.block
            return { ...s, message: { ...s.message, content } }
          })
          if (ev.block.type === 'tool_use') inputBuffers.set(ev.index, '')
        } else if (ev.type === 'text_delta') {
          setter((s) => {
            const content = [...s.message.content]
            const b = content[ev.index]
            if (b && b.type === 'text') {
              content[ev.index] = { ...b, text: b.text + ev.delta }
            }
            return { ...s, message: { ...s.message, content } }
          })
        } else if (ev.type === 'thinking_delta') {
          setter((s) => {
            const content = [...s.message.content]
            const b = content[ev.index]
            if (b && b.type === 'thinking') {
              content[ev.index] = { ...b, thinking: b.thinking + ev.delta }
            }
            return { ...s, message: { ...s.message, content } }
          })
        } else if (ev.type === 'tool_input_delta') {
          const buf = (inputBuffers.get(ev.index) ?? '') + ev.delta
          inputBuffers.set(ev.index, buf)
          try {
            const parsed = JSON.parse(buf) as Record<string, unknown>
            setter((s) => {
              const content = [...s.message.content]
              const b = content[ev.index]
              if (b && b.type === 'tool_use') {
                content[ev.index] = { ...b, input: parsed }
              }
              return { ...s, message: { ...s.message, content } }
            })
          } catch {
            /* partial */
          }
        } else if (ev.type === 'message_stop') {
          setter((s) => ({
            ...s,
            status: 'done',
            usage: ev.usage ?? null,
            latency: ev.latency_ms ?? null,
            stopReason: ev.stop_reason ?? null,
          }))
        } else if (ev.type === 'error') {
          throw new Error(ev.message)
        }
      }
    } catch (e) {
      setter((s) => ({ ...s, status: 'error', error: (e as Error).message }))
    }
  }

  const handleRunBoth = async () => {
    setRunning(true)
    await Promise.all([runOne(setLeft, left.config), runOne(setRight, right.config)])
    setRunning(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded w-full max-w-6xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-sm font-medium">Compare two models</span>
          <span className="text-xs text-zinc-500">
            same conversation history sent to both
          </span>
          <button
            className="btn-primary ml-auto"
            disabled={running}
            onClick={handleRunBoth}
          >
            {running ? 'running…' : '▶ Run both'}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="flex-1 grid grid-cols-2 gap-2 p-2 overflow-hidden">
          <Pane
            title="A"
            state={left}
            providers={providers}
            onConfigChange={(patch) =>
              setLeft((s) => ({ ...s, config: { ...s.config, ...patch } }))
            }
          />
          <Pane
            title="B"
            state={right}
            providers={providers}
            onConfigChange={(patch) =>
              setRight((s) => ({ ...s, config: { ...s.config, ...patch } }))
            }
          />
        </div>
      </div>
    </div>
  )
}

function Pane({
  title,
  state,
  providers,
  onConfigChange,
}: {
  title: string
  state: PaneState
  providers: ReturnType<typeof useStore.getState>['providers']
  onConfigChange: (patch: Partial<Config>) => void
}) {
  const provider = providers.find((p) => p.key === state.config.provider)

  return (
    <div className="border border-zinc-800 rounded flex flex-col overflow-hidden">
      <div className="p-2 border-b border-zinc-800 bg-zinc-950 space-y-1">
        <div className="flex items-center gap-2">
          <span className="label">pane {title}</span>
          <select
            className="field text-xs flex-1"
            value={state.config.provider}
            onChange={(e) => {
              const p = providers.find((x) => x.key === e.target.value)
              onConfigChange({
                provider: e.target.value,
                model: p?.models[0]?.id ?? state.config.model,
              })
            }}
          >
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key}
              </option>
            ))}
          </select>
          <select
            className="field text-xs flex-1"
            value={state.config.model}
            onChange={(e) => onConfigChange({ model: e.target.value })}
          >
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
              </option>
            ))}
          </select>
        </div>
        <div className="text-[10px] text-zinc-500 flex items-center gap-3">
          <span>{state.status}</span>
          {state.latency != null && <span>· {state.latency}ms</span>}
          {state.stopReason && <span>· stop: {state.stopReason}</span>}
          {state.usage?.input_tokens != null && (
            <span>
              · {state.usage.input_tokens}→{state.usage.output_tokens} tok
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar p-2 space-y-2">
        {state.error && (
          <div className="text-xs text-red-400">⚠ {state.error}</div>
        )}
        {state.message.content.length === 0 && state.status === 'idle' && (
          <div className="text-xs text-zinc-600 italic">
            click "Run both" to compare
          </div>
        )}
        {state.message.content.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </div>
  )
}

function BlockView({ block }: { block: AssistantContentBlock }) {
  if (block.type === 'text') {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <div className="label mb-1">text</div>
        <div className="text-sm whitespace-pre-wrap font-mono">{block.text}</div>
      </div>
    )
  }
  if (block.type === 'thinking') {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <div className="label mb-1 text-zinc-500">thinking</div>
        <div className="text-xs whitespace-pre-wrap font-mono italic text-zinc-400">
          {block.thinking}
        </div>
      </div>
    )
  }
  if (block.type === 'tool_use') {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <div className="label mb-1 text-emerald-400">
          tool_use · {block.name}
        </div>
        <pre className="text-xs whitespace-pre-wrap font-mono">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    )
  }
  return null
}
