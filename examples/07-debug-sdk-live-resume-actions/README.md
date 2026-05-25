# 07 Debug SDK Live Resume Actions

Uses `@llm-impl/debug-sdk` directly to exercise all live resume actions:

- `continue`
- `override_input`
- `mock_result`
- `abort`

The example programmatically enables Live Debug, creates one paused tool call
per action, resumes each pause through the SDK, then restores the previous Live
Debug settings.

Use this when:

- you want to understand the low-level live protocol
- your framework has its own tool executor
- you want automated coverage of live resume behavior without clicking the UI

## Run

Start `llm-impl` first:

```bash
bun run dev
```

Then run:

```bash
LLM_IMPL_ENDPOINT=http://localhost:3181 \
bunx tsx examples/07-debug-sdk-live-resume-actions/index.ts
```

## Output Cases

Open the UI and look under:

```text
live/debug-sdk-live-resume/resume-actions
debug/debug-sdk-live-resume/resume-actions/completed
```

The live cases preserve the pause point and selected resume action. The completed
debug cases show how a custom executor can apply each action to its final
message history.
