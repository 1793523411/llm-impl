import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  TextBlock,
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

export function toOpenAIMessages(
  system: string | undefined,
  messages: Message[],
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
                    url: `data:${b.source.media_type};base64,${b.source.data}`,
                  },
                }
              throw new Error(`unexpected user block type`)
            }),
          })
        }
      }
    } else {
      const textBlocks: TextBlock[] = []
      const toolUseBlocks: ToolUseBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'text') textBlocks.push(block)
        else if (block.type === 'tool_use') toolUseBlocks.push(block)
        // thinking blocks are dropped on OpenAI side
      }
      const text = textBlocks.map((b) => b.text).join('\n')
      const aiMsg: Extract<OpenAIChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: text || null,
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
