import { useStore } from '../store'
import { MessageCard } from './MessageCard'

export function MessageList() {
  const messages = useStore((s) => s.messages)
  const addMessage = useStore((s) => s.addMessage)

  return (
    <div className="space-y-2">
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
