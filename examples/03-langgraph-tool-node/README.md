# 03 LangGraph ToolNode

This example uses `@llm-impl/langchain-adapter` with a standard LangGraph
`ToolNode`.

## Use This When

- Your LangGraph app already uses `ToolNode`.
- Your tools are LangChain-compatible tools.
- You want live pause/override/mock/abort without rewriting the graph.

## Flow

1. Create raw tools.
2. Create `createLangGraphDebugAdapter`.
3. Wrap tools with `adapter.wrapTools(rawTools)`.
4. Pass wrapped tools into `new ToolNode(...)`.
5. Keep `getMessages`, `getTools`, and `getConstraints` connected to graph
   state.

## Run

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 tsx index.ts
```

The example uses LangChain's `FakeToolCallingModel`, so it does not require an
OpenAI API key.

## Live Debug Setup

Enable Live Debug and pause `lookup_order`, or pause every tool call.

## Expected Result

When the graph reaches the `tools` node, the wrapped `lookup_order` tool can be
paused and controlled from the live case.

## Intrusion Level

Medium. The graph shape stays the same, but tools are wrapped before they enter
the `ToolNode`.
