import { z } from 'zod'

export const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
})
export type TextBlock = z.infer<typeof TextBlock>

export const ImageBlock = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({
      type: z.literal('url'),
      url: z.string().min(1),
    }),
  ]),
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

export const SandboxConfig = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['workspace-write', 'read-only']).optional(),
  network: z.enum(['blocked', 'allowed']).optional(),
  allowedRoots: z.array(z.string()).optional(),
  writableRoots: z.array(z.string()).optional(),
  label: z.string().optional(),
})
export type SandboxConfig = z.infer<typeof SandboxConfig>

export const SkillConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  dirPath: z.string().optional(),
  userUploaded: z.boolean().optional(),
  source: z.enum(['skill-md', 'manual']).default('skill-md').optional(),
  preload: z.boolean().default(false).optional(),
  requiresRunCommand: z.boolean().optional(),
  // Legacy manual skill fields kept so old case JSON can still load.
  instruction: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true),
  exposeAsTool: z.boolean().default(false),
})
export type SkillConfig = z.infer<typeof SkillConfig>

export const McpToolConfig = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true),
})
export type McpToolConfig = z.infer<typeof McpToolConfig>

export const McpServerConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'streamablehttp']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
  timeout_ms: z.number().int().positive().optional(),
  tools: z.array(McpToolConfig).default([]),
})
export type McpServerConfig = z.infer<typeof McpServerConfig>

export const ApiProtocol = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])
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

export const ProviderTestRequest = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})
export type ProviderTestRequest = z.infer<typeof ProviderTestRequest>

export const ProviderTestResponse = z.object({
  ok: z.boolean(),
  latency_ms: z.number().optional(),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .partial()
    .optional(),
  sample: z.string().optional(),
  error: z.string().optional(),
  provider_error: z.unknown().optional(),
})
export type ProviderTestResponse = z.infer<typeof ProviderTestResponse>

export const Config = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  api: ApiProtocol.optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  thinking: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('enabled'),
        budget_tokens: z.number().int().positive(),
      }),
      z.object({
        type: z.literal('disabled'),
      }),
    ])
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
    type: z.literal('thinking_signature_delta'),
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
  sandbox: SandboxConfig.optional(),
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

export const SkillListRequest = z.object({
  roots: z.array(z.string()).default([]),
})
export type SkillListRequest = z.infer<typeof SkillListRequest>

export const SkillListResponse = z.object({
  ok: z.boolean(),
  skills: z.array(SkillConfig).optional(),
  error: z.string().optional(),
})
export type SkillListResponse = z.infer<typeof SkillListResponse>

export const SkillLoadRequest = z.object({
  skill: SkillConfig,
})
export type SkillLoadRequest = z.infer<typeof SkillLoadRequest>

export const McpListToolsRequest = z.object({
  server: McpServerConfig,
})
export type McpListToolsRequest = z.infer<typeof McpListToolsRequest>

export const McpListToolsResponse = z.object({
  ok: z.boolean(),
  tools: z.array(McpToolConfig).optional(),
  error: z.string().optional(),
  stderr: z.string().optional(),
})
export type McpListToolsResponse = z.infer<typeof McpListToolsResponse>

export const McpCallToolRequest = z.object({
  server: McpServerConfig,
  toolName: z.string().min(1),
  input: z.unknown().optional(),
})
export type McpCallToolRequest = z.infer<typeof McpCallToolRequest>

export const McpCallToolResponse = ExecToolResponse.extend({
  raw: z.unknown().optional(),
  stderr: z.string().optional(),
})
export type McpCallToolResponse = z.infer<typeof McpCallToolResponse>

export const DebugConstraintSnapshot = z
  .object({
    kind: z
      .enum(['plan', 'policy', 'approval', 'budget', 'guardrail', 'custom'])
      .default('custom'),
    name: z.string().optional(),
    status: z
      .enum(['ok', 'blocked', 'violated', 'waiting', 'completed'])
      .default('ok'),
    currentStep: z.string().optional(),
    progressText: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    requiredTools: z.array(z.string()).optional(),
    forbiddenTools: z.array(z.string()).optional(),
    violation: z
      .object({
        message: z.string(),
        retryable: z.boolean().optional(),
      })
      .optional(),
    raw: z.unknown().optional(),
  })
  .passthrough()
export type DebugConstraintSnapshot = z.infer<typeof DebugConstraintSnapshot>

export const LiveDebugResumeAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('continue'),
  }),
  z.object({
    action: z.literal('override_input'),
    input: z.record(z.unknown()),
  }),
  z.object({
    action: z.literal('mock_result'),
    result: z.unknown(),
    isError: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('abort'),
    reason: z.string().optional(),
  }),
])
export type LiveDebugResumeAction = z.infer<typeof LiveDebugResumeAction>

export const DebugCaseRouting = z
  .object({
    group: z.union([z.string(), z.array(z.string())]).optional(),
    name: z.string().optional(),
  })
  .passthrough()
export type DebugCaseRouting = z.infer<typeof DebugCaseRouting>

export const Case = z.object({
  meta: z
    .object({
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
      updatedAt: z.string().optional(),
      source: z.string().optional(),
      sessionId: z.string().optional(),
      runId: z.string().optional(),
    })
    .optional(),
  config: Config,
  system: z.string().optional(),
  tools: z.array(Tool).optional(),
  skillRoots: z.array(z.string()).optional(),
  skills: z.array(SkillConfig).optional(),
  mcpServers: z.array(McpServerConfig).optional(),
  sandbox: SandboxConfig.optional(),
  messages: z.array(Message),
  lastRun: z
    .object({
      timestamp: z.string(),
      usage: Usage.optional(),
      latency_ms: z.number().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  debug: z
    .object({
      source: z.record(z.unknown()).optional(),
      events: z.array(z.unknown()).optional(),
      constraints: z.array(DebugConstraintSnapshot).optional(),
      metadata: z.record(z.unknown()).optional(),
      live: z
        .object({
          status: z.enum(['paused', 'continued', 'timeout', 'abandoned', 'aborted']).optional(),
          pauseId: z.string().optional(),
          casePath: z.string().optional(),
          toolCallId: z.string().optional(),
          toolName: z.string().optional(),
          plan: z.record(z.unknown()).optional(),
          constraints: z.array(DebugConstraintSnapshot).optional(),
          resume: LiveDebugResumeAction.optional(),
        })
        .optional(),
    })
    .optional(),
})
export type Case = z.infer<typeof Case>

export const DebugRunSource = z.object({
  project: z.string().min(1),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  userId: z.string().optional(),
})
export type DebugRunSource = z.infer<typeof DebugRunSource>

export const DebugRunConfig = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1),
  api: ApiProtocol.optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
})
export type DebugRunConfig = z.infer<typeof DebugRunConfig>

export const DebugRunLastRun = z.object({
  timestamp: z.string().optional(),
  usage: Usage.optional(),
  latency_ms: z.number().optional(),
  stop_reason: z.string().nullable().optional(),
})
export type DebugRunLastRun = z.infer<typeof DebugRunLastRun>

export const DebugRunRequest = z.object({
  source: DebugRunSource,
  caseRouting: DebugCaseRouting.optional(),
  config: DebugRunConfig,
  system: z.string().optional(),
  tools: z.array(z.unknown()).default([]),
  messages: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
  constraints: z.array(DebugConstraintSnapshot).optional(),
  metadata: z.record(z.unknown()).optional(),
  lastRun: DebugRunLastRun.optional(),
})
export type DebugRunRequest = z.infer<typeof DebugRunRequest>

export const DebugRunResponse = z.object({
  ok: z.boolean(),
  id: z.string(),
  casePath: z.string().optional(),
  debugUrl: z.string(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
})
export type DebugRunResponse = z.infer<typeof DebugRunResponse>

export const LiveDebugSettings = z.object({
  enabled: z.boolean().default(false),
  pauseAll: z.boolean().default(false),
  toolNames: z.array(z.string()).default([]),
})
export type LiveDebugSettings = z.infer<typeof LiveDebugSettings>

export const LiveDebugToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()).default({}),
})
export type LiveDebugToolCall = z.infer<typeof LiveDebugToolCall>

export const LiveDebugPauseRequest = z.object({
  source: DebugRunSource,
  caseRouting: DebugCaseRouting.optional(),
  config: DebugRunConfig.optional(),
  toolCall: LiveDebugToolCall,
  messages: z.array(z.unknown()).default([]),
  tools: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
  constraints: z.array(DebugConstraintSnapshot).optional(),
  plan: z
    .object({
      progress: z.string().optional(),
      currentStep: z.string().optional(),
    })
    .optional(),
})
export type LiveDebugPauseRequest = z.infer<typeof LiveDebugPauseRequest>

export const LiveDebugResumeRequest = z.preprocess((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (!record.action) return { ...record, action: 'continue' }
  }
  return value
}, LiveDebugResumeAction)
export type LiveDebugResumeRequest = z.infer<typeof LiveDebugResumeRequest>

export const LiveDebugPausePoint = z.object({
  id: z.string(),
  status: z.enum(['paused', 'continued', 'timeout', 'abandoned', 'aborted']),
  source: DebugRunSource,
  toolCall: LiveDebugToolCall,
  casePath: z.string().optional(),
  createdAt: z.string(),
  resumedAt: z.string().optional(),
  plan: z
    .object({
      progress: z.string().optional(),
      currentStep: z.string().optional(),
    })
    .optional(),
  constraints: z.array(DebugConstraintSnapshot).optional(),
  resume: LiveDebugResumeAction.optional(),
  messagesCount: z.number(),
  toolsCount: z.number(),
  eventsCount: z.number(),
})
export type LiveDebugPausePoint = z.infer<typeof LiveDebugPausePoint>

export const LiveDebugStateResponse = z.object({
  settings: LiveDebugSettings,
  pausePoints: z.array(LiveDebugPausePoint),
})
export type LiveDebugStateResponse = z.infer<typeof LiveDebugStateResponse>

export const LiveDebugToolCallResponse = z.object({
  paused: z.boolean(),
  action: z.literal('continue').optional(),
  pauseId: z.string().optional(),
  casePath: z.string().optional(),
})
export type LiveDebugToolCallResponse = z.infer<typeof LiveDebugToolCallResponse>

export const LiveDebugWaitResponse = z.object({
  action: z.enum(['continue', 'override_input', 'mock_result', 'abort']),
  status: z.enum(['continued', 'timeout', 'abandoned', 'aborted']),
  input: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  reason: z.string().optional(),
})
export type LiveDebugWaitResponse = z.infer<typeof LiveDebugWaitResponse>
