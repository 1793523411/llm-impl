import { DynamicStructuredTool } from '@langchain/core/tools'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { FakeToolCallingModel } from 'langchain'
import { z } from 'zod'
import { createLangGraphDebugAdapter } from '@llm-impl/langchain-adapter'

const rawTools = [
  new DynamicStructuredTool({
    name: 'lookup_order',
    description: 'Look up an order by id.',
    schema: z.object({ orderId: z.string() }),
    func: async ({ orderId }) => JSON.stringify({ orderId, status: 'paid' }),
  }),
]

let graphMessages: unknown[] = []

const adapter = createLangGraphDebugAdapter({
  debuggerOptions: {
    endpoint: process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181',
    project: 'langgraph-tool-node',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId: `lg-tool-node-${Date.now()}`,
  getMessages: () => graphMessages,
  getTools: () => tools,
  getConstraints: () => [
    {
      kind: 'policy',
      status: 'ok',
      progressText: 'Order lookup is read-only.',
      allowedTools: ['lookup_order'],
    },
  ],
})

const tools = adapter.wrapTools(rawTools)
const toolNode = new ToolNode(tools)
const model = new FakeToolCallingModel({
  toolCalls: [
    [{ name: 'lookup_order', args: { orderId: 'A123' }, id: 'call_lookup_order' }],
    [],
  ],
}).bindTools(tools)

const callModel = async (state: typeof MessagesAnnotation.State) => {
  graphMessages = state.messages
  const response = await model.invoke(state.messages, {
    callbacks: [adapter.callbackHandler],
  })
  return { messages: [response] }
}

const shouldContinue = (state: typeof MessagesAnnotation.State) => {
  const last = state.messages[state.messages.length - 1] as AIMessage
  return last.tool_calls?.length ? 'tools' : '__end__'
}

const graph = new StateGraph(MessagesAnnotation)
  .addNode('agent', callModel)
  .addNode('tools', toolNode)
  .addEdge('__start__', 'agent')
  .addConditionalEdges('agent', shouldContinue)
  .addEdge('tools', 'agent')
  .compile()

const result = await graph.invoke({
  messages: [new HumanMessage('Check order A123')],
})

graphMessages = result.messages
await adapter.submitRun({
  metadata: { example: '03-langgraph-tool-node' },
  lastRun: { stop_reason: 'completed' },
})

console.log(result.messages.at(-1)?.content)
