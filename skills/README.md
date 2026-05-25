# Skills

Project-local skills for AI assistants.

## llm-impl-debug-sdk

`skills/llm-impl-debug-sdk` teaches an assistant how to help users integrate the
llm-impl Debug SDK and LangChain/LangGraph adapter.

The skill intentionally reuses the canonical project docs through symlinks in
`skills/llm-impl-debug-sdk/references/`:

- `docs/09-debug-sdk.md`
- `docs/10-langchain-langgraph-adapter.md`
- `packages/debug-sdk/README.md`
- `packages/langchain-adapter/README.md`
- `examples/README.md`

When those docs change, the skill reads the updated content automatically.
Avoid copying long documentation into `SKILL.md`; keep `SKILL.md` as the routing
and integration guide.
