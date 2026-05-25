import {
  createLlmImplDebugger,
  type DebugConstraintSnapshot,
  type DebugRunMessage,
  type DebugRunTool,
  type LiveDebugResumeAction,
} from '@llm-impl/debug-sdk'

interface LiveDebugSettings {
  enabled: boolean
  pauseAll: boolean
  toolNames: string[]
}

interface LiveDebugState {
  settings: LiveDebugSettings
}

interface Scenario {
  label: string
  resume: LiveDebugResumeAction
  originalInput: Record<string, unknown>
}

const endpoint = (process.env.LLM_IMPL_ENDPOINT ?? 'http://localhost:3181').replace(/\/+$/, '')
const baseSessionId = `sdk-live-${Date.now()}`
const toolName = 'lookup_customer_profile'

const tools: DebugRunTool[] = [
  {
    name: toolName,
    description: 'Read a customer profile by id.',
    input_schema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
      },
      required: ['customerId'],
      additionalProperties: false,
    },
  },
]

const scenarios: Scenario[] = [
  {
    label: 'continue',
    resume: { action: 'continue' },
    originalInput: { customerId: 'C-100' },
  },
  {
    label: 'override-input',
    resume: { action: 'override_input', input: { customerId: 'C-200' } },
    originalInput: { customerId: 'C-100' },
  },
  {
    label: 'mock-result',
    resume: {
      action: 'mock_result',
      result: {
        customerId: 'C-MOCK',
        tier: 'enterprise',
        source: 'mocked by llm-impl',
      },
    },
    originalInput: { customerId: 'C-100' },
  },
  {
    label: 'abort',
    resume: { action: 'abort', reason: 'example requested abort' },
    originalInput: { customerId: 'C-100' },
  },
]

function constraints(label: string): DebugConstraintSnapshot[] {
  return [
    {
      kind: 'policy',
      name: 'read-only-profile-debug',
      status: label === 'abort' ? 'blocked' : 'ok',
      currentStep: `Scenario ${label}`,
      progressText: 'Pause before the profile lookup so a debugger can choose the resume action.',
      allowedTools: [toolName],
      forbiddenTools: ['update_customer_profile', 'charge_customer'],
    },
  ]
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${endpoint}${path}`)
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return response.json() as Promise<T>
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return response.json() as Promise<T>
}

function executeProfileLookup(input: Record<string, unknown>): Record<string, unknown> {
  return {
    customerId: input.customerId,
    tier: input.customerId === 'C-200' ? 'enterprise' : 'standard',
    source: 'real demo tool',
  }
}

async function resumeSoon(
  debug: ReturnType<typeof createLlmImplDebugger>,
  pauseId: string,
  resume: LiveDebugResumeAction,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
  const ok = await debug.resumeToolCall(pauseId, resume)
  if (!ok) throw new Error(`resume failed for pause ${pauseId}`)
}

async function runScenario(scenario: Scenario): Promise<Record<string, unknown>> {
  const sessionId = `${baseSessionId}-${scenario.label}`
  const toolCallId = `call_${scenario.label}_${Date.now()}`
  const startedAt = Date.now()
  const debug = createLlmImplDebugger({
    endpoint,
    project: 'debug-sdk-live-resume',
    provider: 'sdk-demo',
    model: 'custom-live-agent-loop',
    liveWaitTimeoutMs: 5000,
    caseRouting: {
      group: ['resume-actions'],
      name: sessionId,
    },
  })
  const initialMessages: DebugRunMessage[] = [
    {
      role: 'user',
      content: `Run live resume scenario: ${scenario.label}`,
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(scenario.originalInput),
          },
        },
      ],
    },
  ]

  debug.runStart({ sessionId, runId: `run-${sessionId}` })
  debug.modelStart({
    provider: 'sdk-demo',
    model: 'custom-live-agent-loop',
    messages: initialMessages,
    tools,
  })

  const pause = await debug.beforeToolCall({
    toolCall: {
      id: toolCallId,
      name: toolName,
      input: scenario.originalInput,
    },
    messages: initialMessages,
    tools,
    constraints: constraints(scenario.label),
  })
  if (!pause.paused || !pause.pauseId) {
    throw new Error(`scenario ${scenario.label} did not pause`)
  }

  const waitPromise = debug.waitForToolResume(pause.pauseId)
  const resumePromise = resumeSoon(debug, pause.pauseId, scenario.resume)
  const resume = await waitPromise
  await resumePromise

  let finalMessages: DebugRunMessage[]
  let stopReason = 'completed'
  let finalResult: unknown

  if (resume.action === 'abort') {
    stopReason = 'aborted'
    debug.runEnd({ stop_reason: stopReason, reason: resume.reason })
    finalMessages = [
      ...initialMessages,
      {
        role: 'assistant',
        content: `Aborted by debugger: ${resume.reason ?? 'no reason provided'}`,
      },
    ]
  } else if (resume.action === 'mock_result') {
    finalResult = resume.result
    debug.toolResult({
      toolCallId,
      toolName,
      result: resume.result,
      isError: resume.isError,
      durationMs: 0,
    })
    finalMessages = [
      ...initialMessages,
      {
        role: 'tool',
        toolCallId,
        content: resume.result,
      },
      {
        role: 'assistant',
        content: `Used mocked result for ${scenario.label}.`,
      },
    ]
  } else {
    const finalInput =
      resume.action === 'override_input' ? resume.input : scenario.originalInput
    debug.toolStart({ toolCallId, toolName, args: finalInput })
    finalResult = executeProfileLookup(finalInput)
    debug.toolResult({
      toolCallId,
      toolName,
      result: finalResult,
      durationMs: Date.now() - startedAt,
    })
    finalMessages = [
      ...initialMessages,
      {
        role: 'tool',
        toolCallId,
        content: finalResult,
      },
      {
        role: 'assistant',
        content: `Profile lookup completed for ${String(finalInput.customerId)}.`,
      },
    ]
  }

  const submit = await debug.submitRun({
    messages: finalMessages,
    tools,
    constraints: constraints(scenario.label),
    caseRouting: {
      group: ['resume-actions', 'completed'],
      name: sessionId,
    },
    metadata: {
      example: '07-debug-sdk-live-resume-actions',
      scenario: scenario.label,
      liveCasePath: pause.casePath,
      resume,
    },
    lastRun: {
      timestamp: new Date().toISOString(),
      latency_ms: Date.now() - startedAt,
      stop_reason: stopReason,
    },
  })

  return {
    scenario: scenario.label,
    liveCasePath: pause.casePath,
    debugCasePath: submit?.casePath,
    resume,
    finalResult,
  }
}

const previous = await getJson<LiveDebugState>('/api/live-debug/state')
await putJson('/api/live-debug/settings', {
  enabled: true,
  pauseAll: true,
  toolNames: [],
})

try {
  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario))
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2))
} finally {
  await putJson('/api/live-debug/settings', previous.settings)
}
