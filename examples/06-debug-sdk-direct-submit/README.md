# 06 Debug SDK Direct Submit

Uses `@llm-impl/debug-sdk` directly, without LangChain or LangGraph.

Use this when:

- your agent loop is custom-built
- you want to import a completed run as an editable/replayable case
- you want to record lifecycle events, tool calls, constraints, metadata, and
  custom case routing

## Run

Start `llm-impl` first:

```bash
bun run dev
```

Then run:

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 \
bunx tsx examples/06-debug-sdk-direct-submit/index.ts
```

## Output Case

Open the UI and look under:

```text
debug/debug-sdk-direct/direct-submit
```

The generated case shows a completed custom-agent run with one tool call,
one tool result, a final assistant message, constraints, usage, and lifecycle
events.
