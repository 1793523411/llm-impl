# 09 Debug SDK

`@llm-impl/debug-sdk` is the integration layer for bringing an external LLM or
agent runtime into `llm-impl`. It has two jobs:

- import a completed agent run as an editable/replayable case under
  `cases/debug/...`
- pause a running agent before matched tool calls, then resume it from the
  `llm-impl` case UI

The protocol is intentionally generic. Project-specific adapters should only map
their local agent state into messages, tools, events, and `constraints`.

## Current Capabilities

The SDK and server currently support:

- **Completed run import**: `submitRun` posts model config, system prompt,
  messages, tools, raw events, runtime constraints, metadata, and last-run
  metrics to `POST /api/debug-runs`.
- **Live breakpoints**: `beforeToolCall` checks the global Live Debug settings
  before a tool executes. Matched calls create a live case under
  `cases/live/<project>/<session>.json`.
- **Case-level resume controls**: the paused `tool_use` block in the live case
  can continue the original call, override input, inject a mock result, or abort
  the run.
- **Constraint snapshots**: `constraints` is the generic channel for plan,
  policy, approval, budget, guardrail, or custom runtime state. The old `plan`
  field is still accepted and mapped to `constraints[{ kind: "plan" }]`.
- **Audit trail**: live cases persist `debug.live.status`, pause id, tool call,
  constraints at pause time, and resume action for replay and inspection.
- **Fail-open behavior**: debugger errors, timeouts, unavailable server, or bad
  responses return safe values and should not block the external agent.
- **Redaction**: common sensitive keys such as `token`, `secret`, `cookie`, and
  `authorization` are redacted before payloads leave the agent process.

## Start llm-impl

```bash
bun run dev
```

By default the SDK uses:

```txt
server: http://localhost:3181
web:    http://localhost:5181
```

## SDK Setup

For a local workspace integration, link the package first:

```bash
cd /path/to/agent-project
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk
```

Then create one debugger per agent run/session:

```ts
import { createLlmImplDebugger } from '@llm-impl/debug-sdk'

const debug = createLlmImplDebugger({
  endpoint: 'http://localhost:3181',
  project: 'my_agent_project',
  provider: 'ark',
  model: 'ep-...',
  api: 'openai-completions',
  baseUrl: 'https://...',
  onError: (error) => console.warn(`[llm-impl] ${error.message}`),
})
```

`project` is the top-level namespace for the integration. Different agent
projects should use different values, for example `my_agent_project` or
`support_agent`.

You can optionally customize where imported cases are written:

```ts
const debug = createLlmImplDebugger({
  endpoint: 'http://localhost:3181',
  project: 'my_agent_project',
  model: 'ep-...',
  caseRouting: {
    group: ['knowledge', 'batch'],
    name: 'example-case-001',
  },
})
```

If `caseRouting` is omitted, `llm-impl` keeps the default layout:

```txt
live/<project>/<session>.json
debug/<project>/<timestamp>-<session>-<suffix>.json
```

If `caseRouting` is provided, the server sanitizes every segment and writes:

```txt
live/<project>/<group...>/<name-or-session>.json
debug/<project>/<group...>/<timestamp>-<name-or-session>.json
```

## Run Import Flow

Call lifecycle helpers as the agent runs, then submit the final snapshot:

```ts
debug.runStart({ sessionId, runId, userId, metadata: { taskType: 'batch' } })

debug.modelStart({
  model,
  provider: 'ark',
  baseUrl,
  messages,
  tools,
})

debug.modelDelta(chunk)
debug.assistantMessage({ content, toolCalls })
debug.toolStart({ toolCallId, toolName, args })
debug.toolResult({ toolCallId, toolName, result, durationMs, isError })
debug.planEvent('step_completed', { step: 'Step 1.1' })
debug.runEnd({ status: 'completed' })

const result = await debug.submitRun({
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
    latency_ms: 1284,
    stop_reason: 'completed',
  },
})
```

Successful imports return a case path:

```json
{
  "ok": true,
  "id": "s_...",
  "casePath": "debug/my_agent_project/2026-05-25T11-20-31-123Z-s_....json",
  "debugUrl": "http://localhost:5181"
}
```

Open the web UI and select the returned `casePath` in the Cases tree. The
imported case can be edited, replayed, forked, and compared like any other
`llm-impl` case.

If a run is only waiting for user approval, submit it with
`metadata.status: "approval_pending"` or
`lastRun.stop_reason: "approval_pending"`. The server syncs the matching live
case but skips writing a non-live debug snapshot:

```json
{
  "ok": true,
  "id": "s_...",
  "casePath": "",
  "debugUrl": "http://localhost:5181",
  "skipped": true,
  "reason": "approval_pending"
}
```

## Live Breakpoint Flow

Enable Live Debug from the web UI. The global dialog only configures breakpoint
matching:

- enabled or disabled
- pause every tool call
- or pause named tools, one per line. `*` also means every tool.

Before executing a tool, the agent calls `beforeToolCall`:

```ts
const pause = await debug.beforeToolCall({
  toolCall: {
    id: toolCallId,
    name: 'request_user_approval',
    input: { title: 'Confirm data' },
  },
  messages,
  tools,
  events,
  constraints,
  caseRouting: {
    group: ['knowledge', 'live'],
    name: sessionId,
  },
  config: { model, provider: 'ark', baseUrl },
})

if (pause.paused && pause.pauseId) {
  const resume = await debug.waitForToolResume(pause.pauseId)
  // apply resume action in the agent loop
}
```

When paused, `llm-impl` writes or updates:

```txt
cases/live/<project>/<session>.json
```

Open that live case from the Cases tree. The paused `tool_use` block contains
the runtime controls. The global Live Debug panel does not continue the agent
directly; it only owns breakpoint configuration.

## Resume Actions

The current live protocol supports four resume actions:

```ts
type LiveDebugResumeAction =
  | { action: 'continue' }
  | { action: 'override_input'; input: Record<string, unknown> }
  | { action: 'mock_result'; result: unknown; isError?: boolean }
  | { action: 'abort'; reason?: string }
```

Recommended agent-loop behavior:

- `continue`: execute the original tool call.
- `override_input`: replace tool input, then rerun local validation/plan checks
  before executing the tool.
- `mock_result`: skip real tool execution, inject the provided tool result, and
  update local runtime state as if the tool returned it.
- `abort`: stop the current run cleanly, persist generated messages/events, and
  surface the reason if present.

`waitForToolResume` returns a status in addition to the action:

```ts
type LiveDebugWaitResponse = LiveDebugResumeAction & {
  status: 'continued' | 'timeout' | 'abandoned' | 'aborted'
}
```

Timeout and abandoned responses are fail-open and should usually be treated like
`continue`.

## Constraints

`constraints` is the generic runtime-state snapshot shown as
`Constraints at Pause` in live debugging. It replaces UI-specific `plan`
language while preserving plan debugging as one constraint kind.

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

Example:

```json
[
  {
    "kind": "plan",
    "name": "Knowledge generation plan",
    "status": "waiting",
    "currentStep": "Step 2 - Data confirmation approval",
    "progressText": "Step 1 completed. Step 2 requires request_user_approval before submit_knowledge_result.",
    "allowedTools": ["request_user_approval"],
    "requiredTools": ["request_user_approval"],
    "forbiddenTools": ["submit_knowledge_result"],
    "violation": {
      "message": "submit_knowledge_result is not allowed before user approval",
      "retryable": true
    },
    "raw": {
      "executorState": "..."
    }
  }
]
```

Older clients may still send:

```json
{
  "plan": {
    "progress": "Step 1 completed",
    "currentStep": "Step 2"
  }
}
```

The server maps it to a plan constraint when `constraints` is missing.

## HTTP Protocol v1

SDK methods are thin wrappers around these endpoints:

```txt
POST /api/debug-runs
POST /api/live-debug/tool-calls
POST /api/live-debug/pause-points/:pauseId/wait
POST /api/live-debug/pause-points/:pauseId/resume
GET  /api/live-debug/state
PUT  /api/live-debug/settings
```

`POST /api/debug-runs` accepts:

```ts
{
  source: { project: string; sessionId?: string; runId?: string; userId?: string }
  config: {
    provider?: string
    model: string
    api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
    baseUrl?: string
    temperature?: number
    max_tokens?: number
  }
  system?: string
  tools?: unknown[]
  messages?: unknown[]
  events?: unknown[]
  constraints?: DebugConstraintSnapshot[]
  caseRouting?: {
    group?: string | string[]
    name?: string
  }
  metadata?: Record<string, unknown>
  lastRun?: {
    timestamp?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    latency_ms?: number
    stop_reason?: string | null
  }
}
```

`POST /api/live-debug/tool-calls` accepts the same `source`, optional `config`,
plus:

```ts
{
  toolCall: { id: string; name: string; input?: Record<string, unknown> }
  messages?: unknown[]
  tools?: unknown[]
  events?: unknown[]
  constraints?: DebugConstraintSnapshot[]
  caseRouting?: {
    group?: string | string[]
    name?: string
  }
  plan?: { progress?: string; currentStep?: string }
}
```

## Message and Tool Mapping

The import endpoint accepts OpenAI-style agent history:

- `system` messages become the case `system`.
- `user` messages become text/image blocks.
- `assistant.content + assistant.toolCalls` become `text + tool_use` blocks.
- `tool` messages become user-side `tool_result` blocks.
- OpenAI function tools become `llm-impl` tool definitions.

Raw events are stored in `case.debug.events`. Normalized messages remain
editable and replayable.

## Adapter Integration

Downstream projects can either call `@llm-impl/debug-sdk` directly or keep a
thin local adapter that maps project-specific agent state into the generic SDK
payload shape.

Such an adapter can either:

- call HTTP directly through the local adapter
- dynamically import the linked SDK and call the SDK methods

Useful local-development commands usually look like:

```bash
pnpm run link:llm-impl-debug-sdk   # build and link the local SDK
pnpm run dev:llm-impl:adapter      # run with direct HTTP adapter
pnpm run dev:llm-impl:sdk          # run with linked SDK package
```

Runtime switches:

```bash
LLM_IMPL_DEBUG=1
LLM_IMPL_DEBUG_ENDPOINT=http://localhost:3181
LLM_IMPL_DEBUG_PROJECT=my_agent_project
LLM_IMPL_DEBUG_CLIENT=adapter # or sdk
LLM_IMPL_DEBUG_PROVIDER=ark
LLM_IMPL_LIVE_DEBUG_TIMEOUT_MS=1800000
```

Plan-based integrations should map their plan progress, current step,
allowed/required/forbidden tools, and plan violations into
`constraints[{ kind: "plan" }]`.

The integration is fail-open. If `llm-impl` is not running, the agent continues
normally and logs a warning.
