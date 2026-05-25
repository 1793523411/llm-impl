# 02 LangChain Live Tools

This example wraps LangChain tools so `llm-impl` can pause before tool
execution.

## Use This When

- You want live breakpoint debugging.
- You want to edit tool input before execution.
- You want to inject a mock tool result.
- You want to abort a running agent from the `llm-impl` UI.

## Flow

1. Create raw LangChain tools.
2. Create `createLangChainDebugAdapter`.
3. Pass raw tools through `adapter.wrapTools(rawTools)`.
4. Build the agent with the wrapped tools.
5. Enable Live Debug in `llm-impl`.
6. Run the agent and control paused tool calls from the live case.

## Run

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 tsx index.ts
```

The example uses LangChain v1 `createAgent` with `FakeToolCallingModel`, so it
does not require an OpenAI API key.

## Live Debug Setup

In `llm-impl`:

1. Click `Live Debug`.
2. Enable breakpoints.
3. Enable `pause every tool call`, or add `get_weather`.
4. Open the live case when the tool pauses.

## Resume Behavior

- `continue`: calls the real `get_weather` tool.
- `override_input`: replaces the tool input and calls the real tool.
- `mock_result`: skips the real tool and returns your mock JSON.
- `abort`: throws `LlmImplDebugAbortError`.

## Intrusion Level

Medium. Tool execution goes through the adapter wrapper.
