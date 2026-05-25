# 04 LangGraph Interrupt Resume

This example shows the durable-pause pattern for LangGraph.

Instead of relying only on a long HTTP wait, the graph node uses LangGraph
`interrupt()` and lets LangGraph checkpointing own the pause state.

## Use This When

- A graph may stay paused for a long time.
- Resume may happen from another process.
- You already use LangGraph checkpointing.
- You want `llm-impl` live debugging but do not want the agent process to be the
  only owner of pause state.

## Flow

1. A graph node prepares a tool call.
2. The node calls `adapter.debugger.beforeToolCall(...)`.
3. If paused, the node calls `interrupt({ pauseId, casePath, toolCall })`.
4. The driver or worker calls `adapter.debugger.waitForToolResume(pauseId)`.
5. The graph is resumed with the returned action.
6. The node applies:
   - `continue`: keep original input.
   - `override_input`: replace input.
   - `mock_result`: append a tool result without executing the real tool.
   - `abort`: throw `LlmImplDebugAbortError`.

## Run

This directory is a skeleton because exact LangGraph JS imports vary by version.
Use it as the integration shape rather than a copy-paste runnable script.

## Why This Pattern Exists

The simpler `wrapTools` mode is enough for local debugging. The interrupt mode is
better for production-like long agents because LangGraph checkpointing can
restore the paused graph independently of the HTTP request lifecycle.

## Intrusion Level

Medium. You add a pause node or pause branch, but gain durable resume semantics.
