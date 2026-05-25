import { useEffect, useRef, useState } from 'react'
import {
  usesOpenAIReasoningContent,
  type AssistantContentBlock,
  type AssistantMessage,
  type Config,
  type Message,
  type ProviderInfo,
  type Usage,
} from '@llm-impl/shared'
import { useStore } from '../store'
import * as api from '../api'
import { Select } from './ui/Select'
import { MarkdownPreview } from './MarkdownPreview'

type PaneState = {
  config: Config
  message: AssistantMessage
  status: 'idle' | 'running' | 'done' | 'error' | 'stopped'
  error?: string
  notice?: string
  usage?: Usage | null
  latency?: number | null
  stopReason?: string | null
}

const COMPARE_STREAM_FLUSH_MS = 250
const COMPARE_RUNNING_PREVIEW_LIMIT = 20_000

function compareInputMessages(messages: Message[]): {
  messages: Message[]
  trimmedAssistantCount: number
} {
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === 'assistant') end -= 1
  if (end === 0) return { messages, trimmedAssistantCount: 0 }
  return {
    messages: messages.slice(0, end),
    trimmedAssistantCount: messages.length - end,
  }
}

function deepSeekThinkingReplayNotice(
  config: Config,
  provider: ProviderInfo | undefined,
  messages: Message[],
): string | null {
  if (!provider) return null
  if (!usesOpenAIReasoningContent(config.model, provider.baseUrl)) return null

  const missingThinkingIndex = messages.findIndex(
    (message) =>
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'tool_use') &&
      !message.content.some(
        (block) => block.type === 'thinking' && block.thinking.trim(),
      ),
  )
  if (missingThinkingIndex < 0) return null

  return [
    'Thinking disabled for replay:',
    `message ${missingThinkingIndex + 1} has tool_use but no saved reasoning_content.`,
    'Tool history is still sent normally.',
  ].join(' ')
}

export function Compare({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers)
  const baseConfig = useStore((s) => s.config)
  const system = useStore((s) => s.system)
  const tools = useStore((s) => s.tools)
  const skills = useStore((s) => s.skills)
  const mcpServers = useStore((s) => s.mcpServers)
  const sandbox = useStore((s) => s.sandbox)
  const currentCasePath = useStore((s) => s.currentCasePath)
  const getEffectiveSystem = useStore((s) => s.getEffectiveSystem)
  const getEffectiveTools = useStore((s) => s.getEffectiveTools)
  const messages = useStore((s) => s.messages)
  const effectiveSystem = getEffectiveSystem()
  const effectiveTools = getEffectiveTools()
  const {
    messages: runMessages,
    trimmedAssistantCount,
  } = compareInputMessages(messages)
  void system
  void tools
  void skills
  void mcpServers

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
  const abortControllersRef = useRef<AbortController[]>([])

  const abortRunning = () => {
    for (const controller of abortControllersRef.current) {
      controller.abort()
    }
    abortControllersRef.current = []
  }

  useEffect(() => abortRunning, [])

  const runOne = async (
    setter: (updater: (s: PaneState) => PaneState) => void,
    config: Config,
    signal: AbortSignal,
  ) => {
    const provider = providers.find((p) => p.key === config.provider)
    const notice = deepSeekThinkingReplayNotice(config, provider, runMessages)
    const runConfig: Config = notice
      ? { ...config, thinking: { type: 'disabled' } }
      : config

    setter((s) => ({
      ...s,
      message: { role: 'assistant', content: [] },
      status: 'running',
      error: undefined,
      notice: notice ?? undefined,
      usage: undefined,
      latency: undefined,
      stopReason: undefined,
    }))
    const inputBuffers = new Map<number, string>()
    const textBuffers = new Map<number, string[]>()
    const thinkingBuffers = new Map<number, string[]>()
    let draftMessage: AssistantMessage = { role: 'assistant', content: [] }
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let hasPendingMessage = false

    const snapshotMessage = (): AssistantMessage => ({
      role: 'assistant',
      content: draftMessage.content.map((block, index) => {
        if (block.type === 'text') {
          return { ...block, text: (textBuffers.get(index) ?? [block.text]).join('') }
        }
        if (block.type === 'thinking') {
          return {
            ...block,
            thinking: (thinkingBuffers.get(index) ?? [block.thinking]).join(''),
          }
        }
        return block
      }),
    })

    const flushMessage = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!hasPendingMessage) return
      hasPendingMessage = false
      const snapshot = snapshotMessage()
      draftMessage = snapshot
      setter((s) => ({ ...s, message: snapshot }))
    }

    const scheduleMessageFlush = () => {
      hasPendingMessage = true
      if (flushTimer) return
      flushTimer = setTimeout(flushMessage, COMPARE_STREAM_FLUSH_MS)
    }

    try {
      for await (const ev of api.postRunStream({
        config: runConfig,
        system: effectiveSystem || undefined,
        tools: effectiveTools.length > 0 ? effectiveTools : undefined,
        messages: runMessages,
      }, signal)) {
        if (ev.type === 'block_start') {
          const content = [...draftMessage.content]
          content[ev.index] = ev.block
          draftMessage = { ...draftMessage, content }
          if (ev.block.type === 'tool_use') inputBuffers.set(ev.index, '')
          if (ev.block.type === 'text') textBuffers.set(ev.index, [ev.block.text])
          if (ev.block.type === 'thinking') {
            thinkingBuffers.set(ev.index, [ev.block.thinking])
          }
          scheduleMessageFlush()
        } else if (ev.type === 'text_delta') {
          const chunks = textBuffers.get(ev.index)
          if (chunks) {
            chunks.push(ev.delta)
            scheduleMessageFlush()
          }
        } else if (ev.type === 'thinking_delta') {
          const chunks = thinkingBuffers.get(ev.index)
          if (chunks) {
            chunks.push(ev.delta)
            scheduleMessageFlush()
          }
        } else if (ev.type === 'thinking_signature_delta') {
          const content = [...draftMessage.content]
          const b = content[ev.index]
          if (b && b.type === 'thinking') {
            content[ev.index] = {
              ...b,
              signature: `${b.signature ?? ''}${ev.delta}`,
            }
            draftMessage = { ...draftMessage, content }
            scheduleMessageFlush()
          }
        } else if (ev.type === 'tool_input_delta') {
          const buf = (inputBuffers.get(ev.index) ?? '') + ev.delta
          inputBuffers.set(ev.index, buf)
        } else if (ev.type === 'block_stop') {
          const buf = inputBuffers.get(ev.index)
          if (buf !== undefined) {
            try {
              const parsed = JSON.parse(buf || '{}') as Record<string, unknown>
              const content = [...draftMessage.content]
              const b = content[ev.index]
              if (b && b.type === 'tool_use') {
                content[ev.index] = { ...b, input: parsed }
                draftMessage = { ...draftMessage, content }
                scheduleMessageFlush()
              }
            } catch {
              /* leave the empty input if provider ended with malformed JSON */
            }
          }
        } else if (ev.type === 'message_stop') {
          flushMessage()
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
      flushMessage()
    } catch (e) {
      flushMessage()
      if ((e as Error).name === 'AbortError') {
        setter((s) => ({ ...s, status: 'stopped', stopReason: 'aborted' }))
        return
      }
      setter((s) => ({ ...s, status: 'error', error: (e as Error).message }))
    }
  }

  const handleRunBoth = async () => {
    abortRunning()
    const leftController = new AbortController()
    const rightController = new AbortController()
    abortControllersRef.current = [leftController, rightController]
    setRunning(true)
    await Promise.all([
      runOne(setLeft, left.config, leftController.signal),
      runOne(setRight, right.config, rightController.signal),
    ])
    abortControllersRef.current = []
    setRunning(false)
  }

  const handleStop = () => {
    abortRunning()
    setRunning(false)
  }

  const handleClose = () => {
    abortRunning()
    onClose()
  }
  const caseLabel = currentCasePath ?? 'unsaved workspace draft'
  const scopeTitle = currentCasePath ? 'Compare current case' : 'Compare workspace draft'
  const toolResultCount = runMessages.reduce(
    (count, message) =>
      count +
      message.content.filter((block) => block.type === 'tool_result').length,
    0,
  )
  const summaryItems = [
    `${runMessages.length}${
      runMessages.length === messages.length ? '' : `/${messages.length}`
    } message${runMessages.length === 1 ? '' : 's'} sent`,
    ...(trimmedAssistantCount > 0
      ? [
          `${trimmedAssistantCount} trailing assistant ${
            trimmedAssistantCount === 1 ? 'turn' : 'turns'
          } trimmed`,
        ]
      : []),
    effectiveSystem ? 'system prompt' : 'no system prompt',
    `${effectiveTools.length} tool${effectiveTools.length === 1 ? '' : 's'}`,
    toolResultCount
      ? `${toolResultCount} tool result${toolResultCount === 1 ? '' : 's'}`
      : 'no tool results',
    sandbox
      ? `sandbox: ${
          sandbox.enabled === false ? 'disabled' : sandbox.mode ?? 'workspace-write'
        }`
      : 'default sandbox',
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded w-full max-w-6xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-zinc-800 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium">{scopeTitle}</span>
              <span
                className="max-w-[56ch] truncate rounded border border-zinc-800 bg-zinc-950/50 px-2 py-0.5 text-[11px] text-zinc-400"
                title={caseLabel}
              >
                {caseLabel}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
              {summaryItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>
          <button
            className={running ? 'btn-danger ml-auto' : 'btn-primary ml-auto'}
            onClick={running ? handleStop : handleRunBoth}
          >
            {running ? 'Stop' : '▶ Run both'}
          </button>
          <button className="btn" onClick={handleClose}>
            Close
          </button>
        </header>
        <div className="flex-1 grid grid-cols-2 gap-2 p-2 overflow-hidden">
          <Pane
            title="A"
            state={left}
            providers={providers}
            running={running}
            onConfigChange={(patch) =>
              setLeft((s) => ({ ...s, config: { ...s.config, ...patch } }))
            }
          />
          <Pane
            title="B"
            state={right}
            providers={providers}
            running={running}
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
  running,
  onConfigChange,
}: {
  title: string
  state: PaneState
  providers: ReturnType<typeof useStore.getState>['providers']
  running: boolean
  onConfigChange: (patch: Partial<Config>) => void
}) {
  const provider = providers.find((p) => p.key === state.config.provider)

  return (
    <div className="border border-zinc-800 rounded flex flex-col overflow-hidden">
      <div className="p-2 border-b border-zinc-800 bg-zinc-950 space-y-1">
        <div className="flex items-center gap-2">
          <span className="label">pane {title}</span>
          <Select
            className="flex-1"
            value={state.config.provider}
            onChange={(value) => {
              const p = providers.find((x) => x.key === value)
              onConfigChange({
                provider: value,
                model: p?.models[0]?.id ?? state.config.model,
              })
            }}
            options={providers.map((p) => ({
              value: p.key,
              label: p.key,
              searchText: `${p.key} ${p.api}`,
            }))}
          />
          <Select
            className="flex-1"
            value={state.config.model}
            onChange={(value) => onConfigChange({ model: value })}
            options={(provider?.models ?? []).map((m) => ({
              value: m.id,
              label: m.name ?? m.id,
              searchText: `${m.id} ${m.name ?? ''}`,
            }))}
            placeholder="model"
          />
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
        {state.notice && (
          <div className="text-xs text-amber-400">ⓘ {state.notice}</div>
        )}
        {state.message.content.length === 0 && state.status === 'idle' && (
          <div className="text-xs text-zinc-600 italic">
            click "Run both" to compare this case
          </div>
        )}
        {state.message.content.map((block, i) => (
          <BlockView key={i} block={block} running={running} />
        ))}
      </div>
    </div>
  )
}

function runningPreviewText(text: string): string {
  if (text.length <= COMPARE_RUNNING_PREVIEW_LIMIT) return text
  return `${text.slice(0, COMPARE_RUNNING_PREVIEW_LIMIT)}\n\n[streaming preview truncated for responsiveness]`
}

function BlockView({
  block,
  running,
}: {
  block: AssistantContentBlock
  running: boolean
}) {
  if (block.type === 'text') {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <div className="label mb-1">text</div>
        {running ? (
          <pre className="text-sm whitespace-pre-wrap break-words">
            {runningPreviewText(block.text)}
          </pre>
        ) : (
          <MarkdownPreview>{block.text}</MarkdownPreview>
        )}
      </div>
    )
  }
  if (block.type === 'thinking') {
    const thinking = running ? runningPreviewText(block.thinking) : block.thinking
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <div className="label mb-1 text-zinc-500">thinking</div>
        <div className="text-xs whitespace-pre-wrap font-mono italic text-zinc-400">
          {thinking}
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
