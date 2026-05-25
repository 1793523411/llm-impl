import { useState } from 'react'
import { useStore } from '../store'
import { Compare } from './Compare'

export function SendBar() {
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const send = useStore((s) => s.send)
  const messages = useStore((s) => s.messages)
  const currentCasePath = useStore((s) => s.currentCasePath)
  const config = useStore((s) => s.config)
  const providers = useStore((s) => s.providers)
  const [comparing, setComparing] = useState(false)
  const providerConfigured = providers.some((provider) => provider.key === config.provider)
  const missingProviderHint =
    config.provider && !providerConfigured
      ? `Provider "${config.provider}" is from this case only. Add it to config/providers.json to Send/Test/Compare.`
      : null

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
  const compareLabel = currentCasePath ? 'Compare Case' : 'Compare Draft'
  const compareTitle = currentCasePath
    ? `Compare two models on current case: ${currentCasePath}`
    : 'Compare two models on the unsaved workspace draft'

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center gap-3">
      <button
        className="btn-primary"
        disabled={status === 'running'}
        title={missingProviderHint ?? undefined}
        onClick={() => send()}
      >
        {status === 'running' ? 'running…' : sendLabel}
      </button>
      <button className="btn" onClick={() => setComparing(true)} title={compareTitle}>
        ⇆ {compareLabel}
      </button>
      <span className="text-xs text-zinc-500">
        {messages.length} message{messages.length === 1 ? '' : 's'}
      </span>
      {missingProviderHint && (
        <span className="text-xs text-amber-400 flex-1 truncate">
          {missingProviderHint}
        </span>
      )}
      {error && (
        <span className="text-xs text-red-400 flex-1 truncate">⚠ {error}</span>
      )}
      <span className="text-[10px] text-zinc-600 ml-auto">
        ⌘+Enter to send
      </span>
      {comparing && <Compare onClose={() => setComparing(false)} />}
    </div>
  )
}
