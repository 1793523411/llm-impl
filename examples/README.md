# llm-impl Integration Examples

These examples show how external agent frameworks can connect to `llm-impl`.
Each example lives in its own directory and focuses on one integration pattern.

## Prerequisites

Start `llm-impl`:

```bash
cd /Users/bytedance/Desktop/work/desktop/llm-impl
bun run dev
```

In a real project, install or link the packages:

```bash
pnpm add @llm-impl/debug-sdk @llm-impl/langchain-adapter
```

For local development against this monorepo:

```bash
bun run --cwd /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk build
bun run --cwd /Users/bytedance/Desktop/work/desktop/llm-impl/packages/langchain-adapter build
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/debug-sdk
pnpm link /Users/bytedance/Desktop/work/desktop/llm-impl/packages/langchain-adapter
```

The examples use `tsx` style commands and assume the target project has the
framework dependencies installed, such as `@langchain/core`,
`@langchain/langgraph`, `@langchain/openai`, `langchain`, and `zod`.

## Examples

| Example | Pattern | What It Demonstrates |
|---|---|---|
| `01-langchain-callback-trace` | Callback trace only | Lowest-intrusion completed-run import. |
| `02-langchain-live-tools` | LangChain tool wrapper | Live pause, continue, input override, mock result, abort. |
| `03-langgraph-tool-node` | LangGraph `ToolNode` | Wrap tools before giving them to LangGraph. |
| `04-langgraph-interrupt-resume` | LangGraph checkpoint interrupt | Durable graph pause/resume skeleton. |
| `05-doubao-real-api-case` | Real Doubao/Ark API | Real model call plus wrapped tool import into an isolated case directory. |
| `06-debug-sdk-direct-submit` | Low-level SDK import | Custom agent loop lifecycle events, constraints, and completed-run import. |
| `07-debug-sdk-live-resume-actions` | Low-level SDK live protocol | Programmatic continue, override input, mock result, and abort. |
| `08-debug-sdk-fail-open-redaction` | Low-level SDK safety | Fail-open behavior, timeout errors, and recursive redaction. |

## Which One Should I Start With?

- If you only need replay/debug after the run completes, start with
  `01-langchain-callback-trace`.
- If you want to control tool execution from the `llm-impl` UI, start with
  `02-langchain-live-tools`.
- If your LangGraph app uses the standard `ToolNode`, start with
  `03-langgraph-tool-node`.
- If your graph needs durable pauses across processes or long waits, read
  `04-langgraph-interrupt-resume`.
- If you want to inspect a real Doubao/Ark model execution in the UI, run
  `05-doubao-real-api-case`.
- If you are integrating a custom agent loop without LangChain, start with
  `06-debug-sdk-direct-submit`, then read `07-debug-sdk-live-resume-actions`.
- If you need production safety behavior, run
  `08-debug-sdk-fail-open-redaction`.

## Coverage Matrix

| Capability | Covered By |
|---|---|
| `submitRun` completed case import | `01`, `03`, `05`, `06`, `07`, `08` |
| `runStart`, `modelStart`, `modelDelta`, `assistantMessage`, `toolStart`, `toolResult`, `planEvent`, `runEnd`, `record` | `06`, `07`, `08` |
| `constraints` snapshots | `02`, `03`, `05`, `06`, `07` |
| `caseRouting` for isolated directories | `05`, `06`, `07`, `08` |
| live `beforeToolCall` + `waitForToolResume` | `02`, `03`, `05`, `07` |
| live `resumeToolCall` | `07` |
| resume `continue` | `02`, `07` |
| resume `override_input` | `02`, `07` |
| resume `mock_result` | `02`, `07` |
| resume `abort` | `02`, `07` |
| fail-open when `llm-impl` is unavailable | `08` |
| redaction | `08` |
| LangChain callback trace | `01`, `02`, `05` |
| LangGraph `ToolNode` wrapping | `03` |
| LangGraph durable interrupt/resume skeleton | `04` |
| real Doubao/Ark model call | `05` |

## Live Debug Checklist

For examples that pause tools:

1. Open `http://localhost:5181`.
2. Click `Live Debug`.
3. Enable breakpoints.
4. Choose `pause every tool call`, or enter the exact tool name.
5. Run the example.
6. Open the live case under `live/<project>/<session>`.
7. Use the paused tool block controls to continue, override input, mock result,
   or abort.

## Notes

These are reference examples. Exact LangChain/LangGraph imports can vary across
framework versions, especially for LangGraph `interrupt` and `Command`.
