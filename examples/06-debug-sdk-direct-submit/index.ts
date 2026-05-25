import {
  createLlmImplDebugger,
  type DebugConstraintSnapshot,
  type DebugRunMessage,
  type DebugRunTool,
} from '@llm-impl/debug-sdk'

const endpoint = process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181'
const sessionId = `sdk-direct-${Date.now()}`
const toolCallId = `call_get_ticket_${Date.now()}`
const startedAt = Date.now()

const tools: DebugRunTool[] = [
  {
    name: 'get_support_ticket',
    description: 'Read a support ticket by id.',
    input_schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
  },
]

const constraints: DebugConstraintSnapshot[] = [
  {
    kind: 'plan',
    name: 'support-ticket-triage',
    status: 'completed',
    currentStep: 'Step 2 - summarize read-only ticket data',
    progressText: 'Ticket lookup completed; final summary can be generated.',
    allowedTools: ['get_support_ticket'],
    forbiddenTools: ['update_ticket', 'send_email'],
  },
]

const messages: DebugRunMessage[] = [
  {
    role: 'user',
    content: 'Read ticket T-100 and summarize the customer issue.',
  },
  {
    role: 'assistant',
    content: 'I will inspect the ticket before summarizing.',
    toolCalls: [
      {
        id: toolCallId,
        type: 'function',
        function: {
          name: 'get_support_ticket',
          arguments: JSON.stringify({ ticketId: 'T-100' }),
        },
      },
    ],
  },
  {
    role: 'tool',
    toolCallId,
    content: {
      ticketId: 'T-100',
      priority: 'high',
      issue: 'The customer cannot finish checkout after applying a coupon.',
    },
  },
  {
    role: 'assistant',
    content:
      'Ticket T-100 is a high-priority checkout issue: coupon application blocks checkout completion.',
  },
]

const debug = createLlmImplDebugger({
  endpoint,
  project: 'debug-sdk-direct',
  provider: 'sdk-demo',
  model: 'custom-agent-loop',
  caseRouting: {
    group: ['direct-submit'],
    name: sessionId,
  },
  onError: (error) => {
    console.warn(`[llm-impl] ${error.message}`)
  },
})

debug.runStart({
  sessionId,
  runId: `run-${sessionId}`,
  userId: 'example-user',
  metadata: { example: '06-debug-sdk-direct-submit' },
})
debug.modelStart({
  provider: 'sdk-demo',
  model: 'custom-agent-loop',
  messages: messages.slice(0, 1),
  tools,
})
debug.modelDelta('I will inspect the ticket before summarizing.')
debug.assistantMessage({
  content: 'I will inspect the ticket before summarizing.',
  toolCalls: messages[1]?.toolCalls,
})
debug.planEvent('step_completed', constraints[0])
debug.toolStart({
  toolCallId,
  toolName: 'get_support_ticket',
  args: { ticketId: 'T-100' },
})
debug.toolResult({
  toolCallId,
  toolName: 'get_support_ticket',
  result: messages[2]?.content,
  durationMs: 12,
})
debug.runEnd({ stop_reason: 'completed' })

const result = await debug.submitRun({
  messages,
  tools,
  constraints,
  metadata: {
    example: '06-debug-sdk-direct-submit',
    integration: 'custom-agent-loop',
  },
  lastRun: {
    timestamp: new Date().toISOString(),
    latency_ms: Date.now() - startedAt,
    stop_reason: 'completed',
    usage: {
      input_tokens: 120,
      output_tokens: 48,
    },
  },
})

console.log(JSON.stringify({
  ok: Boolean(result?.ok),
  casePath: result?.casePath,
}))
