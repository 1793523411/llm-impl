import { useStore } from '../store'

export function SendBar() {
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const send = useStore((s) => s.send)
  const messages = useStore((s) => s.messages)

  const last = messages[messages.length - 1]
  const lastIsAssistantWithToolUse =
    last?.role === 'assistant' &&
    last.content.some((b) => b.type === 'tool_use')
  const lastIsUserWithEmptyToolResult =
    last?.role === 'user' &&
    last.content.some((b) => b.type === 'tool_result' && !b.content)

  const sendLabel = lastIsAssistantWithToolUse
    ? 'Send (will fail — fill tool_results first)'
    : lastIsUserWithEmptyToolResult
      ? 'Continue ▶'
      : 'Send ▶'

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center gap-3">
      <button
        className="btn-primary"
        disabled={status === 'running'}
        onClick={() => send()}
      >
        {status === 'running' ? 'running…' : sendLabel}
      </button>
      <span className="text-xs text-zinc-500">
        {messages.length} message{messages.length === 1 ? '' : 's'}
      </span>
      {error && (
        <span className="text-xs text-red-400 flex-1 truncate">⚠ {error}</span>
      )}
      <span className="text-[10px] text-zinc-600 ml-auto">
        ⌘+Enter to send
      </span>
    </div>
  )
}
