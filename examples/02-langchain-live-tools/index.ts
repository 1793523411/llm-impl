import { DynamicStructuredTool } from '@langchain/core/tools'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { z } from 'zod'
import { createLangChainDebugAdapter } from '@llm-impl/langchain-adapter'

const rawTools = [
  new DynamicStructuredTool({
    name: 'get_weather',
    description: 'Get the weather for a city.',
    schema: z.object({
      city: z.string(),
    }),
    func: async ({ city }) => {
      return JSON.stringify({ city, forecast: 'sunny', temperatureC: 26 })
    },
  }),
]

const messages: unknown[] = []

const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181',
    project: 'langchain-live-tools',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId: `lc-live-${Date.now()}`,
  getMessages: () => messages,
  getTools: () => tools,
  getConstraints: () => [
    {
      kind: 'guardrail',
      status: 'ok',
      progressText: 'Only read-only weather lookups are allowed.',
      allowedTools: ['get_weather'],
    },
  ],
})

const tools = adapter.wrapTools(rawTools)

const model = new FakeToolCallingModel({
  toolCalls: [
    [{ name: 'get_weather', args: { city: 'Beijing' }, id: 'call_get_weather' }],
    [],
  ],
})
const agent = createAgent({
  model,
  tools,
  prompt: 'You are a concise assistant. Use tools when useful.',
})

const result = await agent.invoke(
  { messages: [{ role: 'user', content: 'What is the weather in Beijing?' }] },
  { callbacks: [adapter.callbackHandler] },
)

await adapter.submitRun({
  metadata: { example: '02-langchain-live-tools', result },
  lastRun: { stop_reason: 'completed' },
})

console.log(result)
