import { z } from 'zod'

export const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
})
export type TextBlock = z.infer<typeof TextBlock>

export const ImageBlock = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.string(),
    data: z.string(),
  }),
})
export type ImageBlock = z.infer<typeof ImageBlock>

export const ThinkingBlock = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
})
export type ThinkingBlock = z.infer<typeof ThinkingBlock>

export const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
})
export type ToolUseBlock = z.infer<typeof ToolUseBlock>

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
})
export type ToolResultBlock = z.infer<typeof ToolResultBlock>

export const UserContentBlock = z.discriminatedUnion('type', [
  TextBlock,
  ImageBlock,
  ToolResultBlock,
])
export type UserContentBlock = z.infer<typeof UserContentBlock>

export const AssistantContentBlock = z.discriminatedUnion('type', [
  TextBlock,
  ToolUseBlock,
  ThinkingBlock,
])
export type AssistantContentBlock = z.infer<typeof AssistantContentBlock>

export const UserMessage = z.object({
  role: z.literal('user'),
  content: z.array(UserContentBlock),
})
export type UserMessage = z.infer<typeof UserMessage>

export const AssistantMessage = z.object({
  role: z.literal('assistant'),
  content: z.array(AssistantContentBlock),
})
export type AssistantMessage = z.infer<typeof AssistantMessage>

export const Message = z.discriminatedUnion('role', [UserMessage, AssistantMessage])
export type Message = z.infer<typeof Message>

export const Tool = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()),
})
export type Tool = z.infer<typeof Tool>

export const ApiProtocol = z.enum(['openai-completions', 'anthropic-messages'])
export type ApiProtocol = z.infer<typeof ApiProtocol>

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  api: ApiProtocol.optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .partial()
    .optional(),
})
export type ModelInfo = z.infer<typeof ModelInfo>

export const ProviderInfo = z.object({
  key: z.string(),
  api: ApiProtocol,
  baseUrl: z.string(),
  models: z.array(ModelInfo),
})
export type ProviderInfo = z.infer<typeof ProviderInfo>

export const Config = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  thinking: z
    .object({
      type: z.literal('enabled'),
      budget_tokens: z.number().int().positive(),
    })
    .optional(),
})
export type Config = z.infer<typeof Config>

export const RunRequest = z.object({
  config: Config,
  system: z.string().optional(),
  tools: z.array(Tool).optional(),
  messages: z.array(Message).min(1),
})
export type RunRequest = z.infer<typeof RunRequest>

export const Usage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .partial()
export type Usage = z.infer<typeof Usage>

export const RunResponse = z.object({
  message: AssistantMessage,
  stop_reason: z.string().nullable().optional(),
  usage: Usage.optional(),
  latency_ms: z.number(),
})
export type RunResponse = z.infer<typeof RunResponse>

// Unified streaming events. Server emits as NDJSON, frontend builds the
// assistant message progressively.
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('block_start'),
    index: z.number(),
    block: AssistantContentBlock,
  }),
  z.object({
    type: z.literal('text_delta'),
    index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('thinking_delta'),
    index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('tool_input_delta'),
    index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('block_stop'),
    index: z.number(),
  }),
  z.object({
    type: z.literal('message_stop'),
    stop_reason: z.string().nullable().optional(),
    usage: Usage.optional(),
    latency_ms: z.number(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
])
export type StreamEvent = z.infer<typeof StreamEvent>

// Tool exec (real execution mode)
export const ExecToolRequest = z.object({
  name: z.string(),
  input: z.unknown().optional(),
})
export type ExecToolRequest = z.infer<typeof ExecToolRequest>

export const ExecToolResponse = z.object({
  content: z.string(),
  is_error: z.boolean().optional(),
})
export type ExecToolResponse = z.infer<typeof ExecToolResponse>

export const ExecToolDef = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
})
export type ExecToolDef = z.infer<typeof ExecToolDef>

export const Case = z.object({
  meta: z
    .object({
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
      updatedAt: z.string().optional(),
    })
    .optional(),
  config: Config,
  system: z.string().optional(),
  tools: z.array(Tool).optional(),
  messages: z.array(Message),
  lastRun: z
    .object({
      timestamp: z.string(),
      usage: Usage.optional(),
      latency_ms: z.number().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
})
export type Case = z.infer<typeof Case>

