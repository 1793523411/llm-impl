# @llm-impl/debug-sdk

Small Node SDK for importing an external LLM/agent run into `llm-impl` as a
debuggable case.

```ts
import { createLlmImplDebugger } from '@llm-impl/debug-sdk'

const debug = createLlmImplDebugger({
  endpoint: 'http://localhost:3181',
  project: 'govern_experience',
  provider: 'ark',
  model: 'ep-...',
})

debug.runStart({ sessionId, userId })
debug.modelStart({ messages, tools })
debug.toolResult({ toolName, toolCallId, result })

await debug.submitRun({
  messages,
  tools,
  lastRun: { stop_reason: 'done' },
})
```

The SDK is fail-open: submit errors are passed to `onError` and resolve as
`null`, so agent execution does not depend on the debugger being available.
