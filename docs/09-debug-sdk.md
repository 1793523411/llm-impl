# 09 Debug SDK

`@llm-impl/debug-sdk` lets another LLM or agent project submit a completed run
to `llm-impl` and turn it into a normal case under `cases/debug/...`.

## Server endpoint

Start `llm-impl`:

```bash
bun run dev
```

The SDK posts to:

```txt
POST http://localhost:3181/api/debug-runs
```

The response contains:

```json
{
  "ok": true,
  "id": "...",
  "casePath": "debug/govern_experience/...",
  "debugUrl": "http://localhost:5181"
}
```

Open the web UI and select the returned `casePath` in the Cases tree.

If a run is only paused for human approval, submit it with
`metadata.status: "approval_pending"` or `lastRun.stop_reason:
"approval_pending"`. The server will sync the matching live case, but skip
writing a non-live `cases/debug/...` snapshot:

```json
{
  "ok": true,
  "id": "...",
  "casePath": "",
  "debugUrl": "http://localhost:5181",
  "skipped": true,
  "reason": "approval_pending"
}
```

## Payload shape

The import endpoint accepts OpenAI-style agent history:

- `system` messages become the case `system`
- `user` messages become text/image blocks
- `assistant.content + assistant.toolCalls` become `text + tool_use` blocks
- `tool` messages become user-side `tool_result` blocks
- OpenAI function tools become `llm-impl` tool definitions

Raw run events are stored in `case.debug.events` for later inspection, while
the normalized messages can be edited, replayed, and compared like any other
case.

## govern_experience

`govern_experience` is wired through `apps/bff_govern_experience/agent/llm-impl-debugger.ts`.
Enable it explicitly when starting the BFF:

```bash
LLM_IMPL_DEBUG=1 \
LLM_IMPL_DEBUG_ENDPOINT=http://localhost:3181 \
LLM_IMPL_DEBUG_PROVIDER=ark \
npm run dev
```

The integration is fail-open. If `llm-impl` is not running, the agent continues
normally and logs a warning.

## Live debugging

Live debugging uses the same endpoint host with two layers:

- Global `Live Debug` controls only configure breakpoints: enable/disable,
  pause every tool call, or list tool names one per line.
- When a connected agent hits a live breakpoint, the server writes a live case
  under `cases/live/<project>/<session>.json`.
- Open that live case from the Cases tree or the read-only active session list.
  The paused `tool_use` block in the case message panel shows `Continue live`.

The global dialog does not continue the agent directly. Runtime progress belongs
to the live case so messages, tool input, plan progress, and the resume action
stay in the same debugging surface.
