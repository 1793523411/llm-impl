# 08 Debug SDK Fail Open And Redaction

Uses `@llm-impl/debug-sdk` directly to show two safety behaviors:

- fail-open behavior when the debugger endpoint is unavailable
- recursive redaction before a case is written

Use this when:

- your production agent must keep running even if `llm-impl` is down
- you need to understand which payload fields are redacted
- you want a minimal example of `onError`, `timeoutMs`, and custom `redact`

## Run

Start `llm-impl` first for the redaction import:

```bash
bun run dev
```

Then run:

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 \
bunx tsx examples/08-debug-sdk-fail-open-redaction/index.ts
```

## Output Case

Open the UI and look under:

```text
debug/debug-sdk-safety/fail-open-redaction
```

The case contains placeholder payload fields such as `apiKey`,
`authorization`, and `customerEmail`; their values should appear as
`[redacted]`.
