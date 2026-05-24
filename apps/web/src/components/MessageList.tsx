import { useState } from 'react'
import type { AssistantContentBlock } from '@llm-impl/shared'
import { useStore } from '../store'
import { MessageCard } from './MessageCard'

function findToolName(
  messages: ReturnType<typeof useStore.getState>['messages'],
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) return undefined
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const block = message.content.find(
      (item): item is Extract<AssistantContentBlock, { type: 'tool_use' }> =>
        item.type === 'tool_use' && item.id === toolCallId,
    )
    if (block) return block.name
  }
  return undefined
}

function LivePauseBanner() {
  const messages = useStore((s) => s.messages)
  const live = useStore((s) => s.currentCaseDebug?.live)
  const resumeLivePause = useStore((s) => s.resumeLivePause)
  const [continuing, setContinuing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (live?.status !== 'paused' || !live.pauseId) return null

  const toolName = live.toolName ?? findToolName(messages, live.toolCallId) ?? 'tool call'
  const continueLive = async () => {
    setContinuing(true)
    try {
      await resumeLivePause(live.pauseId!)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setContinuing(false)
    }
  }

  return (
    <div className="live-pause-banner">
      <div className="min-w-0">
        <div className="text-xs font-medium text-amber-300">
          paused before <code>{toolName}</code>
        </div>
        {typeof live.plan?.progress === 'string' && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-amber-200/80">
              plan progress
            </summary>
            <pre className="tool-schema-preview scrollbar">{live.plan.progress}</pre>
          </details>
        )}
        {error && <div className="mt-1 text-xs text-red-300">{error}</div>}
      </div>
      <button className="btn-primary" disabled={continuing} onClick={continueLive}>
        {continuing ? 'Continuing...' : 'Continue live'}
      </button>
    </div>
  )
}

export function MessageList() {
  const messages = useStore((s) => s.messages)
  const addMessage = useStore((s) => s.addMessage)

  return (
    <div className="space-y-2">
      <LivePauseBanner />
      {messages.map((msg, i) => (
        <MessageCard key={i} message={msg} index={i} />
      ))}
      <div className="flex gap-2 pt-2">
        <button className="btn" onClick={() => addMessage('user')}>
          + User message
        </button>
        <button className="btn" onClick={() => addMessage('assistant')}>
          + Assistant message
        </button>
      </div>
    </div>
  )
}
