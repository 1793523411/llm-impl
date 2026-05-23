import type {
  AssistantContentBlock,
  AssistantMessage,
  Config,
  ImageBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolUseBlock,
  UserContentBlock,
} from './schema'

// ─── OpenAI request shape (only the bits we use) ────────────────────────────
export type OpenAIChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          >
    }
  | {
      role: 'assistant'
      content: string | null
      reasoning_content?: string
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export type OpenAITool = {
  type: 'function'
  function: { name: string; description?: string; parameters: object }
}

export type AnthropicTool = {
  name: string
  description?: string
  input_schema: object
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        | { type: 'url'; url: string }
        | { type: 'base64'; media_type: string; data: string }
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: 'thinking'; thinking: string; signature: string }

export type AnthropicMessageParam = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

export type AnthropicRequestOptions = {
  max_tokens: number
  temperature?: number
  thinking?: { type: 'enabled'; budget_tokens: number } | {
    type: 'adaptive'
    display: 'summarized'
  }
  output_config?: { effort: 'high' }
}

export type OpenAIResponsesTool = {
  type: 'function'
  name: string
  description: string | null
  parameters: object
  strict: false
}

export type OpenAIMessageOptions = {
  includeReasoningContent?: boolean
}

export type OpenAIResponsesInputItem =
  | {
      role: 'user' | 'assistant' | 'system' | 'developer'
      content:
        | string
        | Array<
            | { type: 'input_text'; text: string }
            | { type: 'input_image'; image_url: string; detail: 'auto' }
          >
      type?: 'message'
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export type OpenAIResponseLoose = {
  output_text?: string
  output?: Array<{
    type?: string
    call_id?: string
    name?: string
    arguments?: string
    content?: Array<{
      type?: string
      text?: string
      refusal?: string
    }>
    summary?: Array<{ text?: string }>
  }>
}

export function usesOpenAIReasoningContent(
  model: string,
  baseUrl = '',
): boolean {
  return /deepseek/i.test(model) || /deepseek/i.test(baseUrl)
}

function imageUrl(block: ImageBlock): string {
  return block.source.type === 'url'
    ? block.source.url
    : `data:${block.source.media_type};base64,${block.source.data}`
}

export function toOpenAIMessages(
  system: string | undefined,
  messages: Message[],
  options: OpenAIMessageOptions = {},
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  if (system && system.trim()) out.push({ role: 'system', content: system })

  for (const msg of messages) {
    if (msg.role === 'user') {
      // tool_result blocks become separate `role:'tool'` messages
      const nonToolBlocks: UserContentBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          })
        } else {
          nonToolBlocks.push(block)
        }
      }
      if (nonToolBlocks.length > 0) {
        const allText = nonToolBlocks.every((b) => b.type === 'text')
        if (allText) {
          out.push({
            role: 'user',
            content: nonToolBlocks
              .map((b) => (b as TextBlock).text)
              .join('\n'),
          })
        } else {
          out.push({
            role: 'user',
            content: nonToolBlocks.map((b) => {
              if (b.type === 'text') return { type: 'text' as const, text: b.text }
              if (b.type === 'image')
                return {
                  type: 'image_url' as const,
                  image_url: {
                    url: imageUrl(b),
                  },
                }
              throw new Error(`unexpected user block type`)
            }),
          })
        }
      }
    } else {
      const textBlocks: TextBlock[] = []
      const thinkingBlocks: ThinkingBlock[] = []
      const toolUseBlocks: ToolUseBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'text') textBlocks.push(block)
        else if (block.type === 'thinking') thinkingBlocks.push(block)
        else if (block.type === 'tool_use') toolUseBlocks.push(block)
      }
      const text = textBlocks.map((b) => b.text).join('\n')
      if (!text && toolUseBlocks.length === 0) continue
      const reasoningContent = thinkingBlocks
        .map((b) => b.thinking)
        .filter(Boolean)
        .join('\n')
      const aiMsg: Extract<OpenAIChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: text || null,
      }
      if (options.includeReasoningContent && reasoningContent) {
        aiMsg.reasoning_content = reasoningContent
      }
      if (toolUseBlocks.length > 0) {
        aiMsg.tool_calls = toolUseBlocks.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }))
      }
      out.push(aiMsg)
    }
  }
  return out
}

export function toOpenAIResponsesInput(messages: Message[]): OpenAIResponsesInputItem[] {
  const out: OpenAIResponsesInputItem[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string; detail: 'auto' }
      > = []
      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: 'input_text', text: block.text })
        } else if (block.type === 'image') {
          content.push({
            type: 'input_image',
            image_url: imageUrl(block),
            detail: 'auto',
          })
        } else if (block.type === 'tool_result') {
          out.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: block.content,
          })
        }
      }
      if (content.length > 0) out.push({ role: 'user', content })
    } else {
      const text = msg.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (text) out.push({ role: 'assistant', content: text })
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          out.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          })
        }
      }
    }
  }
  return out
}

export function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = []
  const pushMessage = (
    role: AnthropicMessageParam['role'],
    content: AnthropicContentBlock[],
  ) => {
    if (content.length === 0) return
    const last = out[out.length - 1]
    if (last?.role === role) {
      last.content.push(...content)
      return
    }
    out.push({ role, content })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content: AnthropicContentBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.length > 0) {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          content.push({
            type: 'image',
            source:
              block.source.type === 'url'
                ? { type: 'url', url: block.source.url }
                : {
                    type: 'base64',
                    media_type: block.source.media_type,
                    data: block.source.data,
                  },
          })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          content.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error !== undefined && { is_error: block.is_error }),
          })
        }
      }
      pushMessage('user', content)
    } else {
      const content: AnthropicContentBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.length > 0) {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          })
        } else if (
          block.type === 'thinking' &&
          block.thinking.length > 0 &&
          block.signature
        ) {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature,
          })
        }
      }
      pushMessage('assistant', content)
    }
  }
  return out
}

export function usesAnthropicAdaptiveThinking(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.includes('claude-opus-4-7') ||
    normalized.includes('claude-opus-4-6') ||
    normalized.includes('claude-sonnet-4-6') ||
    normalized.includes('claude-mythos-preview')
  )
}

export function omitsAnthropicTemperature(model: string): boolean {
  return usesAnthropicAdaptiveThinking(model)
}

export function toAnthropicRequestOptions(
  config: Pick<Config, 'model' | 'temperature' | 'max_tokens' | 'thinking'>,
): AnthropicRequestOptions {
  const options: AnthropicRequestOptions = {
    max_tokens: config.max_tokens ?? 4096,
  }

  if (
    config.temperature !== undefined &&
    !omitsAnthropicTemperature(config.model)
  ) {
    options.temperature = config.temperature
  }

  if (config.thinking) {
    if (usesAnthropicAdaptiveThinking(config.model)) {
      options.thinking = { type: 'adaptive', display: 'summarized' }
      options.output_config = { effort: 'high' }
    } else {
      options.thinking = config.thinking
    }
  }

  return options
}

export function toOpenAITools(tools: Tool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

export function toAnthropicTools(tools: Tool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

export function toOpenAIResponsesTools(tools: Tool[]): OpenAIResponsesTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description ?? null,
    parameters: t.input_schema,
    strict: false,
  }))
}

// ─── OpenAI response → internal AssistantMessage ────────────────────────────
// We intentionally relax the type because various proxies return non-standard
// fields (DeepSeek-Reasoner: `reasoning_content`; some return content as an
// array of parts; etc).
export type OpenAIChoiceMessageLoose = {
  role: 'assistant'
  content?:
    | string
    | null
    | Array<{ type: string; text?: string; thinking?: string }>
  reasoning_content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export function fromOpenAIMessage(
  msg: OpenAIChoiceMessageLoose,
): AssistantMessage {
  const blocks: AssistantContentBlock[] = []

  // DeepSeek-Reasoner-style reasoning_content arrives separately from content.
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
    blocks.push({ type: 'thinking', thinking: msg.reasoning_content })
  }

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content })
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'reasoning' || part.type === 'thinking') {
        blocks.push({
          type: 'thinking',
          thinking: part.thinking ?? part.text ?? '',
        })
      }
    }
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments || '{}')
      } catch {
        input = { __raw: tc.function.arguments }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }
  return { role: 'assistant', content: blocks }
}

export function fromOpenAIResponse(res: OpenAIResponseLoose): AssistantMessage {
  const blocks: AssistantContentBlock[] = []
  if (Array.isArray(res.output)) {
    for (const item of res.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text })
          } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
            blocks.push({ type: 'text', text: part.refusal })
          }
        }
      } else if (item.type === 'function_call') {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(item.arguments || '{}')
        } catch {
          input = { __raw: item.arguments ?? '' }
        }
        blocks.push({
          type: 'tool_use',
          id: item.call_id ?? '',
          name: item.name ?? '',
          input,
        })
      } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const thinking = item.summary
          .map((part) => part.text ?? '')
          .filter(Boolean)
          .join('\n')
        if (thinking) blocks.push({ type: 'thinking', thinking })
      }
    }
  }
  if (
    blocks.length === 0 &&
    typeof res.output_text === 'string' &&
    res.output_text.length > 0
  ) {
    blocks.push({ type: 'text', text: res.output_text })
  }
  return { role: 'assistant', content: blocks }
}

// ─── Anthropic content blocks are nearly identical to ours ──────────────────
// Anthropic's SDK returns ContentBlock[] — map to our schema directly.
export function fromAnthropicContent(
  content: Array<Record<string, unknown>>,
): AssistantMessage {
  const blocks: AssistantContentBlock[] = []
  for (const b of content) {
    if (b.type === 'text') {
      blocks.push({ type: 'text', text: String(b.text ?? '') })
    } else if (b.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: String(b.id),
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
      })
    } else if (b.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: String(b.thinking ?? ''),
        signature: typeof b.signature === 'string' ? b.signature : undefined,
      })
    }
  }
  return { role: 'assistant', content: blocks }
}
