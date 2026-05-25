import {
  createLlmImplDebugger,
  type DebugRunMessage,
  type DebugRunTool,
} from '@llm-impl/debug-sdk'

const endpoint = process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181'
const sessionId = `sdk-safety-${Date.now()}`

const messages: DebugRunMessage[] = [
  {
    role: 'user',
    content: {
      request: 'Summarize a redacted customer profile.',
      customerEmail: 'customer@example.com',
      authorization: 'Bearer demo-token',
    },
  },
  {
    role: 'assistant',
    content: 'The profile belongs to a redacted customer and is safe to inspect.',
  },
]

const tools: DebugRunTool[] = [
  {
    name: 'read_customer_profile',
    description: 'Read a customer profile by id.',
    input_schema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        apiKey: { type: 'string' },
      },
    },
  },
]

const failOpenErrors: string[] = []
const unavailable = createLlmImplDebugger({
  endpoint: 'http://127.0.0.1:9',
  project: 'debug-sdk-safety',
  provider: 'sdk-demo',
  model: 'fail-open-demo',
  timeoutMs: 100,
  onError: (error) => {
    failOpenErrors.push(error.message)
  },
})

unavailable.runStart({ sessionId: `${sessionId}-unavailable` })
const failOpenResult = await unavailable.submitRun({
  messages,
  tools,
  metadata: { expected: 'this request should fail open' },
  lastRun: { stop_reason: 'completed' },
})

const redacted = createLlmImplDebugger({
  endpoint,
  project: 'debug-sdk-safety',
  provider: 'sdk-demo',
  model: 'redaction-demo',
  redact: ['customerEmail'],
  caseRouting: {
    group: ['fail-open-redaction'],
    name: sessionId,
  },
  onError: (error) => {
    console.warn(`[llm-impl] ${error.message}`)
  },
})

redacted.runStart({
  sessionId,
  metadata: {
    apiKey: 'sk-demo-key',
    customerEmail: 'customer@example.com',
  },
})
redacted.record('custom_payload_seen', {
  nested: {
    apiKey: 'sk-demo-key',
    customerEmail: 'customer@example.com',
  },
})

const redactionResult = await redacted.submitRun({
  messages,
  tools,
  metadata: {
    example: '08-debug-sdk-fail-open-redaction',
    apiKey: 'sk-demo-key',
    authorization: 'Bearer demo-token',
    nested: {
      customerEmail: 'customer@example.com',
      safeLabel: 'visible',
    },
  },
  lastRun: {
    timestamp: new Date().toISOString(),
    stop_reason: 'completed',
  },
})

console.log(JSON.stringify({
  ok: Boolean(redactionResult?.ok) && failOpenResult === null,
  failOpenReturnedNull: failOpenResult === null,
  failOpenErrors,
  redactionCasePath: redactionResult?.casePath,
}, null, 2))
