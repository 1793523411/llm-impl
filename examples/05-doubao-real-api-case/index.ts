import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import {
  createLangChainDebugAdapter,
  executeToolWithLlmImplDebug,
} from '@llm-impl/langchain-adapter'

type ProviderRecord = {
  baseUrl: string
  apiKey: string
  api?: string
  models?: Array<{ id: string; name?: string }>
}

function readProvidersFile(
  filePath: string,
  seen = new Set<string>(),
): Record<string, ProviderRecord> {
  const absolutePath = path.resolve(filePath)
  if (seen.has(absolutePath)) return {}
  seen.add(absolutePath)
  if (!existsSync(absolutePath)) return {}

  const parsed = JSON.parse(readFileSync(absolutePath, 'utf8')) as {
    include?: string
    includes?: string[]
    providers?: Record<string, ProviderRecord>
    models?: { providers?: Record<string, ProviderRecord> }
  } & Record<string, ProviderRecord>

  const providers: Record<string, ProviderRecord> = {}
  const includes = [
    ...(parsed.include ? [parsed.include] : []),
    ...(parsed.includes ?? []),
  ]

  for (const include of includes) {
    Object.assign(
      providers,
      readProvidersFile(path.resolve(path.dirname(absolutePath), include), seen),
    )
  }

  Object.assign(
    providers,
    parsed.providers ?? parsed.models?.providers ?? (includes.length > 0 ? {} : parsed),
  )
  seen.delete(absolutePath)
  return providers
}

function readLocalProvider(providerKey: string): ProviderRecord | undefined {
  const filePath = path.resolve('config/providers.json')
  if (!existsSync(filePath)) return undefined
  return readProvidersFile(filePath)[providerKey]
}

function requireValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}. Configure config/providers.json or set an override env var.`)
  }
  return value
}

const providerKey = process.env.DOUBAO_PROVIDER ?? 'volcengine'
const provider = readLocalProvider(providerKey)
const modelName =
  process.env.DOUBAO_MODEL ??
  provider?.models?.[0]?.id ??
  'doubao-seed-2-0-mini-260215'
const baseUrl =
  process.env.DOUBAO_BASE_URL ??
  provider?.baseUrl ??
  'https://ark.cn-beijing.volces.com/api/v3'
const apiKey = requireValue(
  'Doubao API key',
  process.env.DOUBAO_API_KEY_OVERRIDE ?? provider?.apiKey ?? process.env.DOUBAO_API_KEY,
)
const endpoint = process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181'
const sessionId = `doubao-real-${Date.now()}`
const startedAt = Date.now()
const systemPrompt = 'You are a concise assistant. If the user requests current data, use the provided tool first.'

function constraints() {
  return [
    {
      kind: 'policy' as const,
      name: 'read-only-demo-tool-policy',
      status: 'ok' as const,
      progressText: 'The real model may only call the read-only weather tool.',
      allowedTools: ['get_current_weather'],
      forbiddenTools: ['write_file', 'send_email', 'delete_record'],
    },
  ]
}

const rawTools = [
  new DynamicStructuredTool({
    name: 'get_current_weather',
    description: 'Get current weather for a city. This is a read-only demo tool.',
    schema: z.object({
      city: z.string().describe('City name, for example Beijing'),
    }),
    func: async ({ city }) =>
      JSON.stringify({
        city,
        forecast: 'clear',
        temperatureC: 24,
        source: 'local demo weather service',
      }),
  }),
]

let messages: BaseMessage[] = [
  new HumanMessage(
    'Use get_current_weather exactly once, then answer in one short sentence: what is the weather in Beijing?',
  ),
]

const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint,
    project: 'doubao-real-api',
    provider: providerKey,
    model: modelName,
    api: 'openai-completions',
    baseUrl,
    caseRouting: {
      group: ['real-api'],
      name: sessionId,
    },
  },
  sessionId,
  metadata: {
    example: '05-doubao-real-api-case',
    provider: providerKey,
    model: modelName,
    baseUrl,
  },
  getMessages: () => messages,
  getTools: () => rawTools,
  getConstraints: constraints,
})

const model = new ChatOpenAI({
  model: modelName,
  apiKey,
  temperature: 0,
  maxTokens: 256,
  configuration: {
    baseURL: baseUrl,
  },
})
const modelWithTools = model.bindTools(rawTools)

const toolRequest = await modelWithTools.invoke(
  messages,
  { callbacks: [adapter.callbackHandler] },
)
messages.push(toolRequest)

const toolCalls = (toolRequest as AIMessage).tool_calls ?? []
if (toolCalls.length === 0) {
  throw new Error('Doubao did not call get_current_weather; no debug tool call to import.')
}

for (const toolCall of toolCalls) {
  const tool = rawTools.find((candidate) => candidate.name === toolCall.name)
  if (!tool) throw new Error(`Unknown tool requested by model: ${toolCall.name}`)
  const toolCallId = toolCall.id ?? `call_${toolCall.name}_${Date.now()}`
  const output = await executeToolWithLlmImplDebug({
    debugger: adapter.debugger,
    tool,
    toolName: toolCall.name,
    toolCallId,
    toolInput: toolCall.args,
    execute: (nextInput) => tool.invoke(nextInput),
    options: {
      getMessages: () => messages,
      getTools: () => rawTools,
      getConstraints: constraints,
    },
  })
  messages.push(
    new ToolMessage({
      content: typeof output === 'string' ? output : JSON.stringify(output),
      tool_call_id: toolCallId,
    }),
  )
}

const finalResponse = await model.invoke(messages, {
  callbacks: [adapter.callbackHandler],
})
messages.push(finalResponse)

const submit = await adapter.submitRun({
  system: systemPrompt,
  messages,
  tools: rawTools,
  metadata: {
    example: '05-doubao-real-api-case',
    provider: providerKey,
    model: modelName,
    baseUrl,
    usedLocalProviderConfig: Boolean(provider),
  },
  lastRun: {
    stop_reason: 'completed',
    latency_ms: Date.now() - startedAt,
  },
})

console.log(JSON.stringify({
  ok: true,
  provider: providerKey,
  model: modelName,
  casePath: submit?.casePath,
  toolCalls: toolCalls.length,
  final: finalResponse.content,
}))
