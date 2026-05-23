import { usesOpenAIReasoningContent, type ApiProtocol } from '@llm-impl/shared'
import { getProvider, type ProviderRecord } from './providers'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function appendPath(baseUrl: string, path: string): string {
  const base = trimTrailingSlashes(baseUrl)
  const cleanPath = path.replace(/^\/+/, '')
  if (base.endsWith(`/${cleanPath}`)) return base
  return `${base}/${cleanPath}`
}

function endpointFor(api: ApiProtocol, baseUrl: string): string {
  if (api === 'openai-completions') return appendPath(baseUrl, 'chat/completions')
  if (api === 'openai-responses') return appendPath(baseUrl, 'responses')

  const base = trimTrailingSlashes(baseUrl)
  if (base.endsWith('/messages')) return base
  return /\/v\d+$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

function authHeaders(provider: ProviderRecord): string[] {
  if (provider.api === 'anthropic-messages') {
    return [
      `x-api-key: ${provider.apiKey}`,
      'anthropic-version: 2023-06-01',
    ]
  }
  return [`Authorization: Bearer ${provider.apiKey}`]
}

type RequestObject = Record<string, unknown>
type CurlMode = 'stream' | 'non-stream'
type ChatMessageLike = {
  role?: unknown
  tool_calls?: unknown
  reasoning_content?: unknown
}
type ResponsesInputLike = {
  role?: unknown
  type?: unknown
}

function isObject(value: unknown): value is RequestObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function trimTrailingAssistantMessages(
  body: RequestObject,
): { body: RequestObject; messages?: ChatMessageLike[] } {
  if (!Array.isArray(body.messages)) return { body }

  const messages = [...(body.messages as ChatMessageLike[])]
  while (messages.at(-1)?.role === 'assistant') {
    messages.pop()
  }
  if (messages.length === body.messages.length) return { body, messages }
  return { body: { ...body, messages }, messages }
}

function trimTrailingResponsesAssistantInput(body: RequestObject): RequestObject {
  if (!Array.isArray(body.input)) return body

  const input = [...(body.input as ResponsesInputLike[])]
  while (
    input.at(-1)?.role === 'assistant' ||
    input.at(-1)?.type === 'function_call'
  ) {
    input.pop()
  }
  if (input.length === body.input.length) return body
  return { ...body, input }
}

function hasMissingDeepSeekReasoning(messages: ChatMessageLike[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      !(
        typeof message.reasoning_content === 'string' &&
        message.reasoning_content.trim()
      ),
  )
}

function addOpenAIThinkingOverride(
  provider: ProviderRecord,
  body: RequestObject,
  messages: ChatMessageLike[] | undefined,
): RequestObject {
  if (provider.api !== 'openai-completions' || !messages) return body
  const model = typeof body.model === 'string' ? body.model : ''
  if (!usesOpenAIReasoningContent(model, provider.baseUrl)) return body
  if (!hasMissingDeepSeekReasoning(messages)) return body
  return { ...body, thinking: { type: 'disabled' } }
}

function applyStreamingMode(
  provider: ProviderRecord,
  body: RequestObject,
  mode: CurlMode,
): RequestObject {
  if (mode === 'stream') {
    return {
      ...body,
      stream: true,
      ...(provider.api === 'openai-completions' && {
        stream_options: { include_usage: true },
      }),
    }
  }

  const { stream: _stream, stream_options: _streamOptions, ...rest } = body
  void _stream
  void _streamOptions
  return rest
}

function runnableBodyFor(
  provider: ProviderRecord,
  requestBody: unknown,
  mode: CurlMode,
): unknown {
  if (!isObject(requestBody)) return requestBody

  if (provider.api === 'openai-responses') {
    return applyStreamingMode(
      provider,
      trimTrailingResponsesAssistantInput(requestBody),
      mode,
    )
  }

  if (
    provider.api !== 'anthropic-messages' &&
    provider.api !== 'openai-completions'
  ) {
    return applyStreamingMode(provider, requestBody, mode)
  }

  const { body, messages } = trimTrailingAssistantMessages(requestBody)
  return applyStreamingMode(
    provider,
    addOpenAIThinkingOverride(provider, body, messages),
    mode,
  )
}

export function buildRunnableCurl(
  providerKey: string,
  requestBody: unknown,
  mode: CurlMode = 'non-stream',
): string {
  const provider = getProvider(providerKey)
  if (!provider) throw new Error(`unknown provider: ${providerKey}`)
  if (!provider.apiKey) throw new Error(`provider has no apiKey: ${providerKey}`)

  const endpoint = endpointFor(provider.api, provider.baseUrl)
  const body = runnableBodyFor(provider, requestBody, mode)
  const headers = [
    'content-type: application/json',
    ...authHeaders(provider),
  ]
  const lines = [
    `curl ${shellQuote(endpoint)} \\`,
    ...headers.map((header) => `  -H ${shellQuote(header)} \\`),
    "  --data-binary @- <<'JSON'",
    JSON.stringify(body, null, 2),
    'JSON',
  ]

  return lines.join('\n')
}
