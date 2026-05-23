import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  fromAnthropicContent,
  fromOpenAIMessage,
  fromOpenAIResponse,
  toAnthropicMessages,
  toAnthropicRequestOptions,
  toAnthropicTools,
  toOpenAIMessages,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
  toOpenAITools,
  usesOpenAIReasoningContent,
  type OpenAIResponseLoose,
  type RunRequest,
  type RunResponse,
  type StreamEvent,
} from '@llm-impl/shared'
import { getProvider, type ProviderRecord } from './providers'

const anthropicCache = new Map<string, Anthropic>()
const openaiCache = new Map<string, OpenAI>()

function anthropicClient(p: ProviderRecord): Anthropic {
  const key = `${p.baseUrl}|${p.apiKey}`
  let c = anthropicCache.get(key)
  if (!c) {
    c = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl })
    anthropicCache.set(key, c)
  }
  return c
}

function openaiClient(p: ProviderRecord): OpenAI {
  const key = `${p.baseUrl}|${p.apiKey}`
  let c = openaiCache.get(key)
  if (!c) {
    c = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseUrl })
    openaiCache.set(key, c)
  }
  return c
}

function resolveProvider(req: RunRequest): ProviderRecord {
  const provider = getProvider(req.config.provider)
  if (!provider) {
    throw Object.assign(new Error(`unknown provider: ${req.config.provider}`), {
      status: 400,
    })
  }
  return provider
}

// GPT-5 / o-series models reject `max_tokens`; they require `max_completion_tokens`.
function usesNewTokenParam(model: string): boolean {
  return /^(o[0-9]|gpt-5)/.test(model)
}

function tokenField(model: string, max: number | undefined) {
  if (max === undefined) return {}
  return usesNewTokenParam(model)
    ? { max_completion_tokens: max }
    : { max_tokens: max }
}

type OpenAIResponsesCreateBody = Record<string, unknown>
type OpenAIResponsesCreateResult = {
  status?: string | null
  error?: { message?: string | null } | null
  output_text?: string
  output?: unknown[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  } | null
}

type OpenAIResponsesClient = {
  responses: {
    create: (body: OpenAIResponsesCreateBody) => Promise<OpenAIResponsesCreateResult>
  }
}

function openaiResponsesClient(p: ProviderRecord): OpenAIResponsesClient {
  return openaiClient(p) as unknown as OpenAIResponsesClient
}

async function runOpenAIResponsesOnce(
  req: RunRequest,
  provider: ProviderRecord,
  start: number,
): Promise<RunResponse> {
  const tools =
    req.tools && req.tools.length > 0
      ? toOpenAIResponsesTools(req.tools)
      : undefined
  const res = await openaiResponsesClient(provider).responses.create({
    model: req.config.model,
    input: toOpenAIResponsesInput(req.messages),
    ...(req.system && { instructions: req.system }),
    ...(req.config.temperature !== undefined && {
      temperature: req.config.temperature,
    }),
    ...(req.config.max_tokens !== undefined && {
      max_output_tokens: req.config.max_tokens,
    }),
    ...(tools && { tools }),
  })

  if (res.error) {
    throw new Error(res.error.message ?? 'Responses API returned an error')
  }

  return {
    message: fromOpenAIResponse(res as OpenAIResponseLoose),
    stop_reason: res.status ?? null,
    usage: res.usage
      ? {
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cache_read_input_tokens:
            res.usage.input_tokens_details?.cached_tokens ?? undefined,
        }
      : undefined,
    latency_ms: Date.now() - start,
  }
}

// ─── one-shot (non-stream) ──────────────────────────────────────────────────
export async function runOnce(req: RunRequest): Promise<RunResponse> {
  const start = Date.now()
  const provider = resolveProvider(req)

  if (provider.api === 'anthropic-messages') {
    const body = {
      model: req.config.model,
      ...toAnthropicRequestOptions(req.config),
      ...(req.system && { system: req.system }),
      ...(req.tools &&
        req.tools.length > 0 && {
          tools: toAnthropicTools(
            req.tools,
          ) as Anthropic.Messages.Tool[],
        }),
      messages: toAnthropicMessages(req.messages) as Anthropic.Messages.MessageParam[],
    } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming
    const res = await anthropicClient(provider).messages.create(body)
    return {
      message: fromAnthropicContent(
        res.content as unknown as Array<Record<string, unknown>>,
      ),
      stop_reason: res.stop_reason,
      usage: {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cache_creation_input_tokens:
          res.usage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens: res.usage.cache_read_input_tokens ?? undefined,
      },
      latency_ms: Date.now() - start,
    }
  }

  if (provider.api === 'openai-completions') {
    const messages = toOpenAIMessages(req.system, req.messages, {
      includeReasoningContent: usesOpenAIReasoningContent(
        req.config.model,
        provider.baseUrl,
      ),
    })
    const tools =
      req.tools && req.tools.length > 0 ? toOpenAITools(req.tools) : undefined
    const res = await openaiClient(provider).chat.completions.create({
      model: req.config.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(req.config.temperature !== undefined && {
        temperature: req.config.temperature,
      }),
      ...tokenField(req.config.model, req.config.max_tokens),
      ...(tools && { tools: tools as OpenAI.Chat.ChatCompletionTool[] }),
    })
    const choice = res.choices[0]
    if (!choice) throw new Error('OpenAI returned no choices')
    return {
      message: fromOpenAIMessage(choice.message),
      stop_reason: choice.finish_reason,
      usage: res.usage
        ? {
            input_tokens: res.usage.prompt_tokens,
            output_tokens: res.usage.completion_tokens,
          }
        : undefined,
      latency_ms: Date.now() - start,
    }
  }

  if (provider.api === 'openai-responses') {
    return runOpenAIResponsesOnce(req, provider, start)
  }

  throw new Error(`unknown api protocol: ${provider.api}`)
}

// ─── streaming (NDJSON) ─────────────────────────────────────────────────────
export async function* runStream(req: RunRequest): AsyncGenerator<StreamEvent> {
  const start = Date.now()
  const provider = resolveProvider(req)

  if (provider.api === 'anthropic-messages') {
    yield* runAnthropicStream(req, provider, start)
    return
  }
  if (provider.api === 'openai-completions') {
    yield* runOpenAIStream(req, provider, start)
    return
  }
  if (provider.api === 'openai-responses') {
    yield* runOpenAIResponsesStream(req, provider, start)
    return
  }
  throw new Error(`unknown api protocol: ${provider.api}`)
}

async function* runAnthropicStream(
  req: RunRequest,
  provider: ProviderRecord,
  start: number,
): AsyncGenerator<StreamEvent> {
  const body = {
    model: req.config.model,
    ...toAnthropicRequestOptions(req.config),
    ...(req.system && { system: req.system }),
    ...(req.tools &&
      req.tools.length > 0 && {
        tools: toAnthropicTools(req.tools) as Anthropic.Messages.Tool[],
      }),
    messages: toAnthropicMessages(req.messages) as Anthropic.Messages.MessageParam[],
  } as unknown as Anthropic.Messages.MessageStreamParams
  const stream = anthropicClient(provider).messages.stream(body)

  let stopReason: string | null = null

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      const cb = event.content_block as {
        type: string
        id?: string
        name?: string
      }
      if (cb.type === 'text') {
        yield {
          type: 'block_start',
          index: event.index,
          block: { type: 'text', text: '' },
        }
      } else if (cb.type === 'thinking') {
        yield {
          type: 'block_start',
          index: event.index,
          block: { type: 'thinking', thinking: '' },
        }
      } else if (cb.type === 'tool_use') {
        yield {
          type: 'block_start',
          index: event.index,
          block: {
            type: 'tool_use',
            id: cb.id ?? '',
            name: cb.name ?? '',
            input: {},
          },
        }
      }
    } else if (event.type === 'content_block_delta') {
      const d = event.delta as {
        type: string
        text?: string
        thinking?: string
        signature?: string
        partial_json?: string
      }
      if (d.type === 'text_delta' && d.text) {
        yield { type: 'text_delta', index: event.index, delta: d.text }
      } else if (d.type === 'thinking_delta' && d.thinking) {
        yield { type: 'thinking_delta', index: event.index, delta: d.thinking }
      } else if (d.type === 'signature_delta' && d.signature) {
        yield {
          type: 'thinking_signature_delta',
          index: event.index,
          delta: d.signature,
        }
      } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
        yield {
          type: 'tool_input_delta',
          index: event.index,
          delta: d.partial_json,
        }
      }
    } else if (event.type === 'content_block_stop') {
      yield { type: 'block_stop', index: event.index }
    } else if (event.type === 'message_delta') {
      if (event.delta.stop_reason) stopReason = event.delta.stop_reason
    }
  }

  const final = await stream.finalMessage()
  yield {
    type: 'message_stop',
    stop_reason: stopReason ?? final.stop_reason,
    usage: {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cache_creation_input_tokens:
        final.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens: final.usage.cache_read_input_tokens ?? undefined,
    },
    latency_ms: Date.now() - start,
  }
}

async function* runOpenAIStream(
  req: RunRequest,
  provider: ProviderRecord,
  start: number,
): AsyncGenerator<StreamEvent> {
  const messages = toOpenAIMessages(req.system, req.messages, {
    includeReasoningContent: usesOpenAIReasoningContent(
      req.config.model,
      provider.baseUrl,
    ),
  })
  const tools =
    req.tools && req.tools.length > 0 ? toOpenAITools(req.tools) : undefined

  const stream = await openaiClient(provider).chat.completions.create({
    model: req.config.model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: true,
    stream_options: { include_usage: true },
    ...(req.config.temperature !== undefined && {
      temperature: req.config.temperature,
    }),
    ...tokenField(req.config.model, req.config.max_tokens),
    ...(tools && { tools: tools as OpenAI.Chat.ChatCompletionTool[] }),
  })

  // We synthesize block events from the chunk stream. Track which non-tool
  // block is currently open (text or thinking) — switching types closes the
  // previous block.
  let currentNonToolType: 'text' | 'thinking' | null = null
  let currentNonToolIdx = -1
  const toolBlocks = new Map<number, number>() // openai tool_call.index → our block index
  let nextIdx = 0
  let finishReason: string | null = null
  let finalUsage:
    | {
        input_tokens?: number
        output_tokens?: number
      }
    | undefined

  for await (const chunk of stream) {
    if (chunk.usage) {
      finalUsage = {
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
      }
    }
    const choice = chunk.choices[0]
    if (!choice) continue
    const delta = choice.delta as {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }

    // reasoning_content → thinking block
    if (
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content.length > 0
    ) {
      if (currentNonToolType !== 'thinking') {
        if (currentNonToolIdx >= 0) {
          yield { type: 'block_stop', index: currentNonToolIdx }
        }
        currentNonToolIdx = nextIdx++
        currentNonToolType = 'thinking'
        yield {
          type: 'block_start',
          index: currentNonToolIdx,
          block: { type: 'thinking', thinking: '' },
        }
      }
      yield {
        type: 'thinking_delta',
        index: currentNonToolIdx,
        delta: delta.reasoning_content,
      }
    }

    // content → text block
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (currentNonToolType !== 'text') {
        if (currentNonToolIdx >= 0) {
          yield { type: 'block_stop', index: currentNonToolIdx }
        }
        currentNonToolIdx = nextIdx++
        currentNonToolType = 'text'
        yield {
          type: 'block_start',
          index: currentNonToolIdx,
          block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'text_delta',
        index: currentNonToolIdx,
        delta: delta.content,
      }
    }

    // tool_calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaiIdx = tc.index ?? 0
        let blockIdx = toolBlocks.get(oaiIdx)
        if (blockIdx === undefined) {
          blockIdx = nextIdx++
          toolBlocks.set(oaiIdx, blockIdx)
          yield {
            type: 'block_start',
            index: blockIdx,
            block: {
              type: 'tool_use',
              id: tc.id ?? `toolu_${oaiIdx}`,
              name: tc.function?.name ?? '',
              input: {},
            },
          }
        }
        if (typeof tc.function?.arguments === 'string') {
          yield {
            type: 'tool_input_delta',
            index: blockIdx,
            delta: tc.function.arguments,
          }
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  if (currentNonToolIdx >= 0) {
    yield { type: 'block_stop', index: currentNonToolIdx }
  }
  for (const idx of toolBlocks.values()) {
    yield { type: 'block_stop', index: idx }
  }

  yield {
    type: 'message_stop',
    stop_reason: finishReason,
    usage: finalUsage,
    latency_ms: Date.now() - start,
  }
}

async function* runOpenAIResponsesStream(
  req: RunRequest,
  provider: ProviderRecord,
  start: number,
): AsyncGenerator<StreamEvent> {
  const result = await runOpenAIResponsesOnce(req, provider, start)

  for (const [index, block] of result.message.content.entries()) {
    yield { type: 'block_start', index, block }
    if (block.type === 'text') {
      yield { type: 'text_delta', index, delta: block.text }
    } else if (block.type === 'thinking') {
      yield { type: 'thinking_delta', index, delta: block.thinking }
    } else if (block.type === 'tool_use') {
      yield {
        type: 'tool_input_delta',
        index,
        delta: JSON.stringify(block.input),
      }
    }
    yield { type: 'block_stop', index }
  }

  yield {
    type: 'message_stop',
    stop_reason: result.stop_reason,
    usage: result.usage,
    latency_ms: result.latency_ms,
  }
}
