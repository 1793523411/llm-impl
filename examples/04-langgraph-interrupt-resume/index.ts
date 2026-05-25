import { Command, interrupt } from '@langchain/langgraph'
import { createLangGraphDebugAdapter, LlmImplDebugAbortError } from '@llm-impl/langchain-adapter'

type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

type GraphState = {
  messages: unknown[]
  pendingToolCall?: ToolCall
  resumeAction?: {
    action: 'continue' | 'override_input' | 'mock_result' | 'abort'
    input?: Record<string, unknown>
    result?: unknown
    isError?: boolean
    reason?: string
  }
}

const adapter = createLangGraphDebugAdapter({
  debuggerOptions: {
    endpoint: process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181',
    project: 'langgraph-interrupt-resume',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId: `lg-interrupt-${Date.now()}`,
  getConstraints: () => [
    {
      kind: 'guardrail',
      status: 'waiting',
      progressText: 'Human may inspect or override the next tool call.',
    },
  ],
})

export async function pauseBeforeToolNode(state: GraphState) {
  const call = state.pendingToolCall
  if (!call) return state

  if (!state.resumeAction) {
    const pause = await adapter.debugger.beforeToolCall({
      toolCall: {
        id: call.id,
        name: call.name,
        input: call.args,
      },
      messages: state.messages as never[],
      constraints: [
        {
          kind: 'custom',
          status: 'waiting',
          progressText: `Paused before ${call.name}`,
        },
      ],
    })

    if (pause.paused && pause.pauseId) {
      return interrupt({
        type: 'llm_impl_live_pause',
        pauseId: pause.pauseId,
        casePath: pause.casePath,
        toolCall: call,
      })
    }
  }

  const resume = state.resumeAction ?? { action: 'continue' as const }
  if (resume.action === 'abort') {
    throw new LlmImplDebugAbortError({ action: 'abort', reason: resume.reason })
  }
  if (resume.action === 'mock_result') {
    return {
      messages: [
        ...state.messages,
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(resume.result),
        },
      ],
      pendingToolCall: undefined,
      resumeAction: undefined,
    }
  }

  const toolInput = resume.action === 'override_input' && resume.input ? resume.input : call.args
  return {
    ...state,
    pendingToolCall: { ...call, args: toolInput },
    resumeAction: undefined,
  }
}

export async function resumeGraphFromLlmImpl(
  graph: { invoke(input: unknown, config: unknown): Promise<unknown> },
  pauseId: string,
  config: { configurable: { thread_id: string } },
) {
  const resume = await adapter.debugger.waitForToolResume(pauseId)
  return graph.invoke(new Command({ resume }), config)
}
