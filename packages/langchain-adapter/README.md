# @llm-impl/langchain-adapter

Official adapter for using `llm-impl` with LangChain and LangGraph.

This package sits on top of `@llm-impl/debug-sdk`. It keeps the SDK protocol
generic while giving LangChain/LangGraph users two ready-made integration hooks:

- a callback handler for run/event collection
- tool wrappers for live breakpoints before real tool execution

The package has no hard runtime dependency on LangChain or LangGraph. It uses
their common structural APIs, so it can be typechecked and built without pulling
framework packages into `llm-impl` itself.

## Installation

```bash
pnpm add @llm-impl/debug-sdk @llm-impl/langchain-adapter
```

Local development from this monorepo:

```bash
bun run --cwd /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk build
bun run --cwd /Users/bytedance/Desktop/work/desktop/llm-impl/packages/langchain-adapter build

cd /path/to/your-agent-project
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/langchain-adapter
```

Start `llm-impl`:

```bash
cd /Users/bytedance/Desktop/work/desktop/llm-impl
bun run dev
```

## Choosing an Integration Mode

| Mode | API | Intrusion | Capability |
|---|---|---:|---|
| Trace only | `callbackHandler` + `submitRun` | Low | Import completed run as replayable case. |
| Live tools | `wrapTool` / `wrapTools` | Medium | Pause, continue, override input, mock result, abort. |
| LangGraph ToolNode | `wrapTools` before `new ToolNode(...)` | Medium | Same live-tool control for LangGraph tools. |
| LangGraph interrupt | `adapter.debugger.beforeToolCall` | Medium | Durable pause with LangGraph checkpointing. |

## LangChain Trace Only

```ts
import { createLangChainDebugAdapter } from '@llm-impl/langchain-adapter'

const messages = []
const tools = []

const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'langchain-demo',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId: 'session-001',
  userId: 'user-001',
  getMessages: () => messages,
  getTools: () => tools,
})

const result = await agentExecutor.invoke(
  { input: 'Find the latest order status' },
  { callbacks: [adapter.callbackHandler] },
)

await adapter.submitRun({
  metadata: { result },
  lastRun: { stop_reason: 'completed' },
})
```

This does not alter agent execution. It only records callback events and submits
the final run snapshot.

## LangChain Live Tools

```ts
const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'langchain-live-tools',
    model: 'gpt-4.1-mini',
  },
  sessionId,
  getMessages: () => messages,
  getTools: () => tools,
  getConstraints: () => constraints,
})

const debugTools = adapter.wrapTools(tools)
```

When a wrapped tool matches Live Debug settings in the UI, the adapter waits for
a resume action:

- `continue`: execute original input.
- `override_input`: execute with edited input.
- `mock_result`: skip the real tool and return the mock result.
- `abort`: throw `LlmImplDebugAbortError`.

### Custom Tool Input Mapping

Use custom mapping if your tool receives a string, class instance, or nested
runtime object:

```ts
const debugSearch = adapter.wrapTool(searchTool, {
  inputToToolCallInput: (input) => ({ query: String(input) }),
  resumeInputToToolInput: (input) => input.query,
})
```

## LangGraph ToolNode

LangGraph `ToolNode` consumes LangChain-compatible tools. Wrap the tools before
constructing the node:

```ts
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { createLangGraphDebugAdapter } from '@llm-impl/langchain-adapter'

const adapter = createLangGraphDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'langgraph-demo',
    model: 'gpt-4.1-mini',
  },
  getMessages: () => graphMessages,
  getTools: () => tools,
  getConstraints: () => constraintsFromGraphState(graphState),
})

const toolNode = new ToolNode(adapter.wrapTools(tools))
```

## LangGraph Interrupt

For durable long-running graph pauses, use LangGraph checkpointing as the source
of truth and call the underlying debugger manually:

```ts
const pause = await adapter.debugger.beforeToolCall({
  toolCall: { id, name, input },
  messages,
  tools,
  constraints,
})

if (pause.paused && pause.pauseId) {
  return interrupt({
    type: 'llm_impl_live_pause',
    pauseId: pause.pauseId,
    casePath: pause.casePath,
    toolCall: { id, name, input },
  })
}
```

Then the driver waits for `adapter.debugger.waitForToolResume(pauseId)` and
resumes the graph with the returned action. See
`examples/04-langgraph-interrupt-resume`.

## Constraints

Use `getConstraints` to expose runtime state:

```ts
getConstraints: () => [
  {
    kind: 'plan',
    name: 'order_support_plan',
    status: 'waiting',
    currentStep: 'Step 2 - Inspect order evidence',
    progressText: plan.formatProgress(),
    allowedTools: ['lookup_order', 'search_policy'],
    forbiddenTools: ['issue_refund'],
  },
]
```

The adapter only forwards snapshots. Business rules, plan executors, and
guardrails still live in your project.

## API

```ts
createLangChainDebugAdapter({
  debugger?: LlmImplDebugger
  debuggerOptions?: LlmImplDebuggerOptions
  sessionId?: string
  runId?: string
  userId?: string
  metadata?: Record<string, unknown>
  getMessages?: () => unknown[]
  getTools?: () => unknown[]
  getConstraints?: () => DebugConstraintSnapshot[] | undefined
  getMetadata?: () => Record<string, unknown> | undefined
  getConfig?: () => Record<string, unknown> | undefined
})
```

Returns:

```ts
{
  debugger,
  callbackHandler,
  events,
  wrapTool(tool, options),
  wrapTools(tools, options),
  submitRun(input),
  recordEvent(type, data),
}
```

`createLangGraphDebugAdapter` is currently an alias with LangGraph naming.

### Tool Wrapper Options

```ts
{
  getMessages?: () => unknown[]
  getTools?: () => unknown[]
  getConstraints?: () => DebugConstraintSnapshot[] | undefined
  getConfig?: () => Record<string, unknown> | undefined
  getToolCallId?: (context) => string
  inputToToolCallInput?: (input, context) => Record<string, unknown>
  resumeInputToToolInput?: (input, originalInput, context) => unknown
  onResume?: (resume, context) => void | Promise<void>
}
```

## Mapping Helpers

- `toDebugMessage(message)`
- `toDebugMessages(messages)`
- `toDebugTool(tool)`
- `toDebugTools(tools)`
- `executeToolWithLlmImplDebug(...)`
- `wrapLangChainTool(debugger, tool, options)`
- `wrapLangGraphTool(debugger, tool, options)`

Use these helpers if your agent framework has a custom executor or message
storage.

## Fail-Open Behavior

The underlying SDK is fail-open:

- unavailable `llm-impl` server does not block the agent
- `beforeToolCall` falls back to continue
- `submitRun` returns `null` on request failure
- `waitForToolResume` falls back to continue/abandoned on request failure

## Examples

In this repository, see `examples/` for runnable/skeleton integrations.

## Limitations

- This package targets TypeScript/JavaScript.
- Callback tracing is best-effort and framework-version dependent.
- Live debugging requires wrapping the actual tool execution path.
- Exact LangGraph `interrupt` / `Command` imports may vary by LangGraph JS
  version.
