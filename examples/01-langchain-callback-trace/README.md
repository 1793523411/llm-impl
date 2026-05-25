# 01 LangChain Callback Trace

This example imports a completed LangChain run into `llm-impl` as a normal
debug case.

## Use This When

- You want low-intrusion post-run replay.
- You do not need to pause before tools execute.
- You can call `adapter.submitRun()` after the agent finishes.

## Flow

1. Create `createLangChainDebugAdapter`.
2. Pass `adapter.callbackHandler` to LangChain callbacks.
3. Keep access to the current messages/tools through `getMessages` and
   `getTools`.
4. Call `adapter.submitRun()` after the model/agent returns.
5. Open the generated `cases/debug/...` case in `llm-impl`.

## Run

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 tsx index.ts
```

The example uses LangChain's `FakeToolCallingModel`, so it does not require an
OpenAI API key.

## Expected Result

The run appears under `cases/debug/langchain-callback-trace/...` and can be
edited/replayed like a normal `llm-impl` case.

## Intrusion Level

Low. This example does not wrap tools or change runtime behavior.
