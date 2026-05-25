# @llm-impl/debug-sdk

Node SDK for connecting external LLM/agent projects to `llm-impl`.

It can:

- submit a completed agent run as a replayable `llm-impl` case
- create live breakpoints before tool calls
- wait for case-level resume actions from the debugger UI
- carry generic runtime `constraints` such as plan, policy, approval, budget,
  guardrail, or custom state
- fail open when the debugger server is unavailable

If your project uses LangChain or LangGraph, start with
`@llm-impl/langchain-adapter` instead of calling this low-level SDK directly.
The adapter provides callback collection, tool wrappers, and LangGraph examples
on top of this package.

## Install for Local Development

```bash
cd /path/to/agent-project
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk
```

Start `llm-impl` separately:

```bash
cd /Users/bytedance/Desktop/work/desktop/llm-impl
bun run dev
```

The default endpoint is `http://localhost:3181`.

## Quick Start

```ts
import { createLlmImplDebugger } from '@llm-impl/debug-sdk'

const debug = createLlmImplDebugger({
  endpoint: 'http://localhost:3181',
  project: 'my_agent_project',
  provider: 'ark',
  model: 'ep-...',
  api: 'openai-completions',
  baseUrl: 'https://...',
  caseRouting: {
    group: ['knowledge', 'live'],
    name: sessionId,
  },
  onError: (error) => console.warn(`[llm-impl] ${error.message}`),
})

debug.runStart({ sessionId, runId, userId })
debug.modelStart({ messages, tools })

const pause = await debug.beforeToolCall({
  toolCall: {
    id: toolCallId,
    name: 'request_user_approval',
    input: { title: 'Confirm data' },
  },
  messages,
  tools,
  constraints: [
    {
      kind: 'plan',
      status: 'waiting',
      currentStep: 'Step 2 - Data confirmation approval',
      progressText: 'Collected rule data. Approval is required before generation.',
      requiredTools: ['request_user_approval'],
      forbiddenTools: ['submit_knowledge_result'],
    },
  ],
})

let toolInput = originalToolInput
let mockedToolResult:
  | { result: unknown; isError?: boolean }
  | undefined

if (pause.paused && pause.pauseId) {
  const resume = await debug.waitForToolResume(pause.pauseId)

  if (resume.action === 'override_input') {
    toolInput = resume.input
  }

  if (resume.action === 'mock_result') {
    mockedToolResult = { result: resume.result, isError: resume.isError }
  }

  if (resume.action === 'abort') {
    throw new Error(resume.reason ?? 'aborted from llm-impl')
  }
}

if (mockedToolResult) {
  debug.toolResult({
    toolCallId,
    toolName,
    result: mockedToolResult.result,
    isError: mockedToolResult.isError,
  })
} else {
  debug.toolStart({ toolCallId, toolName, args: toolInput })
  const result = await executeTool(toolName, toolInput)
  debug.toolResult({ toolCallId, toolName, result })
}

await debug.submitRun({
  system,
  messages,
  tools,
  constraints,
  caseRouting: {
    group: ['knowledge', 'completed'],
    name: taskId,
  },
  metadata: { taskId },
  lastRun: {
    timestamp: new Date().toISOString(),
    stop_reason: 'completed',
  },
})
```

`project` is the top-level namespace used in case paths and audit metadata.
Set it per integration project.

## Constructor

```ts
createLlmImplDebugger({
  endpoint?: string
  project: string
  enabled?: boolean
  provider?: string
  model?: string
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseUrl?: string
  caseRouting?: {
    group?: string | string[]
    name?: string
  }
  redact?: string[]
  timeoutMs?: number
  liveWaitTimeoutMs?: number
  onError?: (error: Error) => void
})
```

Defaults:

- `endpoint`: `http://localhost:3181`
- `enabled`: `true`
- `timeoutMs`: `2500`
- `liveWaitTimeoutMs`: `30 * 60 * 1000`

`redact` extends the built-in sensitive-key list. Built-ins include token,
secret, password, cookie, authorization, and api key variants.

`provider`, `model`, `api`, and `baseUrl` are sent into the debug case. They do
not need to exist in llm-impl's local `config/providers.json` for display: the
web UI preserves them as external case metadata. Running the case from llm-impl
still requires a configured provider key, since requests need a local API key.

## Lifecycle API

These methods record local events. They do not send network requests by
themselves:

```ts
debug.runStart({ sessionId, runId, userId, metadata })
debug.modelStart({ model, provider, api, baseUrl, messages, tools })
debug.modelDelta(chunk)
debug.assistantMessage({ content, toolCalls })
debug.toolStart({ toolCallId, toolName, args })
debug.toolResult({ toolCallId, toolName, result, durationMs, isError })
debug.planEvent(type, data)
debug.runEnd(data)
debug.record(type, data)
```

`submitRun` sends the current snapshot, unless explicit `messages`, `tools`, or
`events` are provided:

```ts
await debug.submitRun({
  config,
  system,
  messages,
  tools,
  events,
  constraints,
  caseRouting,
  metadata,
  lastRun,
})
```

Return value:

```ts
type DebugRunSubmitResult = {
  ok: boolean
  id: string
  casePath?: string
  debugUrl: string
  skipped?: boolean
  reason?: string
}
```

## Live Debug API

Check whether a tool call should pause:

```ts
const pause = await debug.beforeToolCall({
  toolCall: { id, name, input },
  messages,
  tools,
  events,
  constraints,
  caseRouting,
  config,
})
```

Return value:

```ts
type LiveDebugToolCallResponse = {
  paused: boolean
  action?: 'continue'
  pauseId?: string
  casePath?: string
}
```

Wait until the debugger UI resumes that pause point:

```ts
const resume = await debug.waitForToolResume(pauseId)
```

Resume action:

```ts
type LiveDebugResumeAction =
  | { action: 'continue' }
  | { action: 'override_input'; input: Record<string, unknown> }
  | { action: 'mock_result'; result: unknown; isError?: boolean }
  | { action: 'abort'; reason?: string }

type LiveDebugWaitResponse = LiveDebugResumeAction & {
  status: 'continued' | 'timeout' | 'abandoned' | 'aborted'
}
```

There is also a helper for tests or automation:

```ts
await debug.resumeToolCall(pauseId, { action: 'continue' })
```

## Constraints

`constraints` is the generic runtime-state channel displayed by the UI as
`Constraints at Pause`.

```ts
type DebugConstraintSnapshot = {
  kind?: 'plan' | 'policy' | 'approval' | 'budget' | 'guardrail' | 'custom'
  name?: string
  status?: 'ok' | 'blocked' | 'violated' | 'waiting' | 'completed'
  currentStep?: string
  progressText?: string
  allowedTools?: string[]
  requiredTools?: string[]
  forbiddenTools?: string[]
  violation?: {
    message: string
    retryable?: boolean
  }
  raw?: unknown
  [key: string]: unknown
}
```

Use `kind: 'plan'` for plan executors, `kind: 'approval'` for human approval
state, and `kind: 'guardrail'` or `kind: 'policy'` for runtime checks. Unknown
project-specific fields are allowed and preserved.

## Case Routing

By default, `llm-impl` writes:

```txt
live/<project>/<session>.json
debug/<project>/<timestamp>-<session>-<suffix>.json
```

Pass `caseRouting` to the constructor, `beforeToolCall`, or `submitRun` to group
cases differently:

```ts
caseRouting: {
  group: ['policy-rules', 'knowledge-generation'],
  name: 'example-case-001',
}
```

The server sanitizes `group` and `name`; callers do not send raw file paths.

## Fail-Open Contract

The SDK is designed not to break the agent:

- `submitRun` returns `null` on request errors.
- `beforeToolCall` returns `{ paused: false, action: 'continue' }` on request
  errors.
- `waitForToolResume` returns `{ action: 'continue', status: 'abandoned' }` on
  request errors.
- `resumeToolCall` returns `false` on request errors.

Use `onError` for logging. Do not rely on debugger availability for production
agent correctness.

## Framework Adapters

- `@llm-impl/langchain-adapter`: official TypeScript adapter for LangChain and
  LangGraph.
- Examples live in `examples/`.
  - `06-debug-sdk-direct-submit`: direct SDK completed-run import.
  - `07-debug-sdk-live-resume-actions`: direct SDK live pause/resume actions.
  - `08-debug-sdk-fail-open-redaction`: fail-open and redaction behavior.
