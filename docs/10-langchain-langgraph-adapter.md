# 10 LangChain / LangGraph Adapter

`@llm-impl/langchain-adapter` is the official framework adapter built on top of
`@llm-impl/debug-sdk`. It is meant for projects that already use LangChain or
LangGraph and want `llm-impl` run import plus live tool debugging without writing
their own protocol wrapper.

## What It Solves

The base SDK is framework-neutral. It exposes generic methods:

- `submitRun`
- `beforeToolCall`
- `waitForToolResume`
- `resumeToolCall`

LangChain/LangGraph users still need to answer two framework-specific questions:

- Where do I collect messages, tool schemas, and lifecycle events?
- Where can I pause before the real tool executes?

The adapter answers those with:

- `adapter.callbackHandler`: collect LangChain callback events.
- `adapter.wrapTool(tool)`: pause before a LangChain-compatible tool runs.
- `adapter.wrapTools(tools)`: wrap a tool list before giving it to an agent or
  LangGraph `ToolNode`.
- `createLangGraphDebugAdapter`: same API with LangGraph naming.
- Mapping helpers for custom executors.

## Package

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

## Integration Modes

Use the lightest mode that gives you the control you need.

| Mode | Intrusion | Use When |
|---|---:|---|
| Callback trace only | Low | You only need completed-run import and replay. |
| Wrapped tools | Medium | You need live pause, input override, mock result, or abort before tools execute. |
| LangGraph interrupt | Medium | You want durable graph pauses backed by LangGraph checkpointing. |
| Custom executor | Medium | Your project has a non-standard tool runner but can call adapter helpers. |

## LangChain: Callback Trace

This mode is read-only with respect to agent execution.

```ts
import { createLangChainDebugAdapter } from '@llm-impl/langchain-adapter'

const messages = []
const tools = []

const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'my-langchain-agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  sessionId,
  userId,
  getMessages: () => messages,
  getTools: () => tools,
})

const result = await executor.invoke(input, {
  callbacks: [adapter.callbackHandler],
})

await adapter.submitRun({
  metadata: { result },
  lastRun: { stop_reason: 'completed' },
})
```

This creates a normal `cases/debug/...` case that can be replayed and edited in
`llm-impl`.

## LangChain: Live Tool Debugging

To pause before tools execute, wrap tools before passing them to the agent:

```ts
const adapter = createLangChainDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'my-langchain-agent',
    model: 'gpt-4.1-mini',
  },
  sessionId,
  getMessages: () => messages,
  getTools: () => tools,
  getConstraints: () => [
    {
      kind: 'guardrail',
      status: 'ok',
      progressText: 'Only read-only tools are allowed.',
      forbiddenTools: ['delete_customer'],
    },
  ],
})

const debugTools = adapter.wrapTools(tools)
```

When a wrapped tool matches Live Debug settings, it waits for a case-level resume
action:

- `continue`: execute the original tool input.
- `override_input`: execute with the edited JSON input from the UI.
- `mock_result`: skip the real tool and return the mock result.
- `abort`: throw `LlmImplDebugAbortError`.

You can customize input mapping:

```ts
const debugTool = adapter.wrapTool(searchTool, {
  inputToToolCallInput: (input) => ({ query: String(input) }),
  resumeInputToToolInput: (input) => input.query,
})
```

## LangGraph: ToolNode

The common LangGraph path is to wrap LangChain-compatible tools before passing
them into `ToolNode`.

```ts
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { createLangGraphDebugAdapter } from '@llm-impl/langchain-adapter'

const adapter = createLangGraphDebugAdapter({
  debuggerOptions: {
    endpoint: 'http://localhost:3181',
    project: 'my-langgraph-agent',
    model: 'gpt-4.1-mini',
  },
  getMessages: () => graphMessages,
  getTools: () => tools,
  getConstraints: () => constraintsFromGraphState(graphState),
})

const toolNode = new ToolNode(adapter.wrapTools(tools))
```

This is close to the LangChain live-tool mode. It is simple and works well for
local debugging.

## LangGraph: Durable Interrupt

For long-running or resumable graph workflows, prefer LangGraph checkpointing as
the durable pause mechanism:

1. A graph node calls `adapter.debugger.beforeToolCall(...)`.
2. If `llm-impl` returns `{ paused: true, pauseId }`, the node calls
   LangGraph `interrupt({ pauseId, ... })`.
3. The graph driver waits with `adapter.debugger.waitForToolResume(pauseId)`.
4. The driver resumes the graph with the resume action.
5. The node applies `continue`, `override_input`, `mock_result`, or `abort`.

This keeps pause state in LangGraph instead of relying only on the HTTP wait
request. See `examples/04-langgraph-interrupt-resume`.

## Constraints

Use `getConstraints` to expose framework or business state to `llm-impl`:

```ts
getConstraints: () => [
  {
    kind: 'plan',
    name: 'refund_workflow',
    status: 'waiting',
    currentStep: 'Step 2 - Verify evidence',
    progressText: plan.formatProgress(),
    allowedTools: ['search_orders', 'inspect_evidence'],
    forbiddenTools: ['issue_refund'],
  },
]
```

The adapter does not understand your plan or guardrail logic. It only forwards
snapshots to the generic SDK.

## API Reference

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

Return value:

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

Use these when your tool input is not a plain object or when the UI should edit a
different shape than the runtime tool expects.

## Examples

See [examples](../examples/README.md):

- `01-langchain-callback-trace`
- `02-langchain-live-tools`
- `03-langgraph-tool-node`
- `04-langgraph-interrupt-resume`

## Limitations

- The adapter targets TypeScript/JavaScript first.
- Python LangChain/LangGraph can still use the HTTP protocol or a future Python
  SDK, but this package is not a Python package.
- Callback handlers are best-effort event collectors. Live debugging requires
  wrapping the actual tool execution path.
- Exact LangGraph imports such as `interrupt` and `Command` may differ between
  LangGraph JS versions. The durable interrupt example is a pattern skeleton.

## Troubleshooting

- No case is generated: make sure `adapter.submitRun()` is called and
  `llm-impl` server is reachable at `endpoint`.
- Tool does not pause: enable Live Debug in the UI and either enable
  `pause every tool call` or include the exact tool name.
- Override input is ignored: check `resumeInputToToolInput`; your tool may
  expect a string or class instance instead of a plain object.
- Mock result shape is wrong: the mock result is returned directly from the tool
  wrapper. Match the shape your agent expects from that tool.
