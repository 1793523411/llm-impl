import { useMemo, useState } from 'react'
import {
  toAnthropicMessages,
  toAnthropicRequestOptions,
  toAnthropicTools,
  toOpenAIMessages,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
  toOpenAITools,
  usesOpenAIReasoningContent,
  type ApiProtocol,
  type Config,
  type Message,
  type Tool,
} from '@llm-impl/shared'
import { useStore } from '../store'

type PreviewItem = {
  label: string
  payload: unknown
}

type Preview = {
  protocol: ApiProtocol | 'internal'
  body: unknown
}

function usesNewTokenParam(model: string): boolean {
  return /^(o[0-9]|gpt-5)/.test(model)
}

function tokenField(model: string, max: number | undefined) {
  if (max === undefined) return {}
  return usesNewTokenParam(model)
    ? { max_completion_tokens: max }
    : { max_tokens: max }
}

function buildPreview({
  api,
  config,
  system,
  tools,
  messages,
  providerBaseUrl,
}: {
  api: ApiProtocol | undefined
  config: Config
  system: string
  tools: Tool[]
  messages: Message[]
  providerBaseUrl?: string
}): Preview {
  if (api === 'openai-completions') {
    const convertedTools = tools.length > 0 ? toOpenAITools(tools) : undefined
    return {
      protocol: api,
      body: {
        model: config.model,
        messages: toOpenAIMessages(system || undefined, messages, {
          includeReasoningContent: usesOpenAIReasoningContent(
            config.model,
            providerBaseUrl,
          ),
        }),
        stream: true,
        stream_options: { include_usage: true },
        ...(config.temperature !== undefined && {
          temperature: config.temperature,
        }),
        ...tokenField(config.model, config.max_tokens),
        ...(convertedTools && { tools: convertedTools }),
      },
    }
  }

  if (api === 'openai-responses') {
    const convertedTools =
      tools.length > 0 ? toOpenAIResponsesTools(tools) : undefined
    return {
      protocol: api,
      body: {
        model: config.model,
        input: toOpenAIResponsesInput(messages),
        ...(system && { instructions: system }),
        ...(config.temperature !== undefined && {
          temperature: config.temperature,
        }),
        ...(config.max_tokens !== undefined && {
          max_output_tokens: config.max_tokens,
        }),
        ...(convertedTools && { tools: convertedTools }),
      },
    }
  }

  if (api === 'anthropic-messages') {
    const convertedTools = tools.length > 0 ? toAnthropicTools(tools) : undefined
    return {
      protocol: api,
      body: {
        model: config.model,
        ...toAnthropicRequestOptions(config),
        ...(system && { system }),
        ...(convertedTools && { tools: convertedTools }),
        messages: toAnthropicMessages(messages),
      },
    }
  }

  return {
    protocol: 'internal',
    body: {
      config: { ...config, stream: true },
      ...(system && { system }),
      ...(tools.length > 0 && { tools }),
      messages,
    },
  }
}

function compactValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'data' && value.length > 120) {
      return `<base64: ${value.length} chars>`
    }
    if (value.startsWith('data:') && value.length > 160) {
      return `${value.slice(0, 96)}… <data-url: ${value.length} chars>`
    }
    if (value.length > 4000) {
      return `${value.slice(0, 4000)}… <truncated: ${value.length} chars>`
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => compactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        compactValue(childValue, childKey),
      ]),
    )
  }
  return value
}

function stringify(value: unknown): string {
  return JSON.stringify(compactValue(value), null, 2)
}

export function ModelInputPreview({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const config = useStore((s) => s.config)
  const providers = useStore((s) => s.providers)
  const system = useStore((s) => s.system)
  const tools = useStore((s) => s.tools)
  const skills = useStore((s) => s.skills)
  const mcpServers = useStore((s) => s.mcpServers)
  const messages = useStore((s) => s.messages)
  const getEffectiveSystem = useStore((s) => s.getEffectiveSystem)
  const getEffectiveTools = useStore((s) => s.getEffectiveTools)
  const [open, setOpen] = useState(defaultOpen)

  const currentProvider = providers.find((provider) => provider.key === config.provider)
  const effectiveSystem = useMemo(
    () => getEffectiveSystem(),
    [getEffectiveSystem, system, skills],
  )
  const effectiveTools = useMemo(
    () => getEffectiveTools(),
    [getEffectiveTools, tools, skills, mcpServers],
  )
  const preview = useMemo(
    () =>
      open
        ? buildPreview({
            api: currentProvider?.api,
            config,
            system: effectiveSystem,
            tools: effectiveTools,
            messages,
            providerBaseUrl: currentProvider?.baseUrl,
          })
        : null,
    [
      open,
      currentProvider?.api,
      currentProvider?.baseUrl,
      config,
      effectiveSystem,
      effectiveTools,
      messages,
    ],
  )
  const previewProtocol = preview?.protocol ?? currentProvider?.api ?? 'internal'

  return (
    <div className="model-input-card rounded border border-zinc-800">
      <button
        className="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-zinc-900"
        onClick={() => setOpen(!open)}
      >
        <span className="text-xs uppercase tracking-wider text-zinc-400">
          {open ? '▾' : '▸'} model input
        </span>
        <span className="text-xs text-zinc-500 truncate ml-2 max-w-md">
          {previewProtocol} · exact request body
        </span>
      </button>

      {open && (
        <div className="model-preview p-3 pt-0 space-y-2">
          {preview && <PreviewBlock label="request body" payload={preview.body} />}
        </div>
      )}
    </div>
  )
}

function PreviewBlock({ label, payload }: PreviewItem) {
  const text = useMemo(() => stringify(payload), [payload])

  return (
    <div className="model-preview-block">
      <div className="model-preview-label">{label}</div>
      <pre className="model-preview-code scrollbar">{text}</pre>
    </div>
  )
}
