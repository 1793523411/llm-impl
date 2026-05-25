import { HumanMessage } from '@langchain/core/messages'
import { FakeToolCallingModel } from 'langchain'
import { createLangChainDebugAdapter } from '@llm-impl/langchain-adapter'

const messages = [new HumanMessage('Explain why tool tracing is useful in one sentence.')]
const tools: unknown[] = []

const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181',
    project: 'langchain-callback-trace',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId: `lc-trace-${Date.now()}`,
  getMessages: () => messages,
  getTools: () => tools,
})

const model = new FakeToolCallingModel()

const response = await model.invoke(messages, {
  callbacks: [adapter.callbackHandler],
})

messages.push(response)

await adapter.submitRun({
  messages,
  tools,
  metadata: { example: '01-langchain-callback-trace' },
  lastRun: { stop_reason: 'completed' },
})

console.log('Imported LangChain trace into llm-impl')
