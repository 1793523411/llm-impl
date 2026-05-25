# 05 Doubao Real API Case

Runs a real Doubao/Ark OpenAI-compatible chat model and imports the completed
run into an isolated `llm-impl` case directory.

Use this when:

- you want to verify the adapter against a real model provider
- you want a clean case tree separate from the fake-model examples
- you want to inspect model messages, tool calls, tool results, callbacks, and
  constraints in the `llm-impl` UI

## Run

Start `llm-impl` first:

```bash
bun run dev
```

Then run:

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 \
bunx tsx examples/05-doubao-real-api-case/index.ts
```

By default, this example reads the local gitignored `config/providers.json`
provider named `volcengine`, because Ark/Doubao model access is usually tied to
the endpoint and key pair.

Optional overrides:

```bash
DOUBAO_PROVIDER=volcengine
DOUBAO_MODEL=doubao-seed-2-0-mini-260215
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_API_KEY_OVERRIDE=...
```

`DOUBAO_API_KEY_OVERRIDE` is intentionally separate from `DOUBAO_API_KEY` so a
globally exported key does not accidentally override the provider-specific key
that matches the configured endpoint.

## Output Case

Open the UI and look under:

```text
debug/doubao-real-api/real-api
```

The generated case contains the real model call, wrapped tool execution,
constraints snapshot, and LangChain callback events.
