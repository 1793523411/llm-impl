---
name: llm-impl-debug-sdk
description: Use this skill whenever a user asks how to integrate llm-impl with another LLM, agent, LangChain, LangGraph, or custom tool-calling runtime; asks for SDK usage, Debug Protocol v1, live breakpoint debugging, constraints, resume actions, or examples; or wants implementation guidance for adding llm-impl debugging to an agent project.
---

# llm-impl Debug SDK Integration

Use this skill to help users integrate external LLM/agent projects with
`llm-impl`.

The canonical docs are maintained outside this skill and linked through
`references/`. Do not duplicate large sections into the skill body. When docs
change, the skill stays current because the references point at the same source
files.

## First Step

Read the relevant reference before giving implementation guidance:

| Need | Read |
|---|---|
| Generic SDK, HTTP protocol, live breakpoints, constraints | `references/debug-sdk.md` |
| LangChain or LangGraph adapter usage | `references/langchain-langgraph-adapter.md` |
| Low-level SDK package API | `references/debug-sdk-package.md` |
| LangChain/LangGraph package API | `references/langchain-adapter-package.md` |
| Concrete example layouts | `references/examples.md` |

If the user asks for code changes, inspect the target project before editing.

## Integration Decision Tree

Choose the lightest integration mode that satisfies the user's goal:

1. **Completed-run replay only**
   Use `@llm-impl/debug-sdk` directly and call `submitRun` when the agent run
   finishes.

2. **Live tool debugging for a custom agent loop**
   Add a hook immediately before real tool execution:
   `beforeToolCall -> waitForToolResume -> apply resume action`.

3. **LangChain**
   Prefer `@llm-impl/langchain-adapter`:
   - `callbackHandler` for trace collection
   - `wrapTool` / `wrapTools` for live tool pause

4. **LangGraph with normal ToolNode**
   Wrap tools before passing them to `new ToolNode(...)`.

5. **LangGraph with durable pause/resume**
   Use `adapter.debugger.beforeToolCall(...)` inside a graph node and pair it
   with LangGraph `interrupt()` / checkpoint resume.

## Concepts to Explain Clearly

- The SDK talks to `llm-impl` over HTTP.
- `constraints` is the generic runtime-state channel. Plan progress is just
  `constraints[{ kind: "plan" }]`.
- Live resume actions are:
  - `continue`
  - `override_input`
  - `mock_result`
  - `abort`
- The SDK is fail-open by design; debugger failure should not break production
  agent behavior.
- Tool-level live debugging is necessarily more intrusive than completed-run
  import because it must sit before real tool execution.

## Implementation Checklist

For a new integration:

1. Identify where the project stores messages, tools, events, metadata, and
   runtime state.
2. Decide whether the project needs completed-run import, live tool debugging,
   or both.
3. Map project-specific state into:
   - `source.project`
   - `source.sessionId`
   - `source.runId`
   - `source.userId`
   - `messages`
   - `tools`
   - `events`
   - `constraints`
   - `metadata`
4. For live debugging, hook immediately before tool execution.
5. Apply resume actions in the project runtime:
   - continue: execute original tool
   - override_input: validate/rewrite input, then execute
   - mock_result: skip real tool and inject result
   - abort: stop gracefully and persist partial state
6. Keep the integration fail-open.
7. Add an example or README section showing how to enable it.

## Common Commands

Start `llm-impl`:

```bash
bun run dev
```

Build local packages:

```bash
bun run --cwd packages/debug-sdk build
bun run --cwd packages/langchain-adapter build
```

Run typecheck:

```bash
bun run typecheck
```

## Answering Style

When answering a user:

- Start with which integration mode fits their case.
- Then explain where the hook goes in their runtime.
- Then show the smallest code shape needed.
- Mention the relevant references so the user can inspect the canonical docs.
- Avoid presenting govern_experience-specific PlanExecutor behavior as generic;
  describe it as one example of mapping business state into `constraints`.
