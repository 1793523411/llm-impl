import { memo, useEffect, useRef, useState } from 'react'
import type {
  AssistantContentBlock,
  Message,
  UserContentBlock,
} from '@llm-impl/shared'
import { useStore } from '../store'
import { MarkdownPreview } from './MarkdownPreview'
import { Select } from './ui/Select'

const roleStyles = {
  user: 'border-blue-900 bg-blue-950/20',
  assistant: 'border-purple-900 bg-purple-950/20',
} as const

const roleLabel = {
  user: { text: 'user', cls: 'text-blue-400' },
  assistant: { text: 'assistant', cls: 'text-purple-400' },
} as const

function isToolResultError(
  block: Extract<UserContentBlock, { type: 'tool_result' }> | undefined,
): boolean {
  if (!block) return false
  if (block.is_error) return true
  try {
    const parsed = JSON.parse(block.content)
    return Boolean(
      parsed?.error ||
        parsed?.type === 'args_invalid' ||
        parsed?.type === 'tool_execution_error',
    )
  } catch {
    return /\b(error|args_invalid|tool_execution_error)\b/i.test(block.content)
  }
}

export const MessageCard = memo(function MessageCard({
  message,
  index,
}: {
  message: Message
  index: number
}) {
  const removeMessage = useStore((s) => s.removeMessage)
  const truncateAfter = useStore((s) => s.truncateAfter)
  const addBlock = useStore((s) => s.addBlock)

  return (
    <div className={`rounded border ${roleStyles[message.role]}`}>
      <div className="px-3 py-1 flex items-center justify-between border-b border-zinc-800">
        <span className={`text-xs font-medium ${roleLabel[message.role].cls}`}>
          {roleLabel[message.role].text}
        </span>
        <div className="flex gap-1">
          <button
            className="btn-ghost text-xs"
            onClick={() => truncateAfter(index)}
            title="Fork from here (delete all messages after)"
          >
            ⊥ fork
          </button>
          <button
            className="btn-ghost text-xs hover:text-red-400"
            onClick={() => removeMessage(index)}
            title="Delete message"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="p-2 space-y-2">
        {message.content.map((block, bi) => (
          <BlockEditor
            key={bi}
            block={block}
            msgIdx={index}
            blockIdx={bi}
            role={message.role}
          />
        ))}
        <BlockAdder msgIdx={index} role={message.role} addBlock={addBlock} />
      </div>
    </div>
  )
})

function BlockAdder({
  msgIdx,
  role,
  addBlock,
}: {
  msgIdx: number
  role: 'user' | 'assistant'
  addBlock: (msgIdx: number, blockType: string) => void
}) {
  const types =
    role === 'user'
      ? ['text', 'image', 'tool_result']
      : ['text', 'tool_use', 'thinking']
  return (
    <div className="flex gap-1 flex-wrap">
      {types.map((t) => (
        <button
          key={t}
          className="btn-ghost text-[10px] text-zinc-500 hover:text-zinc-300"
          onClick={() => addBlock(msgIdx, t)}
        >
          + {t}
        </button>
      ))}
    </div>
  )
}

function BlockEditor({
  block,
  msgIdx,
  blockIdx,
  role,
}: {
  block: UserContentBlock | AssistantContentBlock
  msgIdx: number
  blockIdx: number
  role: 'user' | 'assistant'
}) {
  const updateBlock = useStore((s) => s.updateBlock)
  const removeBlock = useStore((s) => s.removeBlock)

  if (block.type === 'text') {
    return (
      <TextBlockEditor
        text={block.text}
        role={role}
        onRemove={() => removeBlock(msgIdx, blockIdx)}
        onChange={(text) => updateBlock(msgIdx, blockIdx, { text })}
      />
    )
  }

  if (block.type === 'tool_use') {
    return (
      <ToolUseBlockEditor
        block={block}
        msgIdx={msgIdx}
        blockIdx={blockIdx}
        onChange={(patch) => updateBlock(msgIdx, blockIdx, patch)}
        onRemove={() => removeBlock(msgIdx, blockIdx)}
      />
    )
  }

  if (block.type === 'tool_result') {
    return (
      <ToolResultBlockEditor
        block={block}
        msgIdx={msgIdx}
        blockIdx={blockIdx}
        onRemove={() => removeBlock(msgIdx, blockIdx)}
        onChange={(patch) => updateBlock(msgIdx, blockIdx, patch)}
      />
    )
  }

  if (block.type === 'thinking') {
    return (
      <BlockShell
        label="thinking"
        accent="text-zinc-500"
        onRemove={() => removeBlock(msgIdx, blockIdx)}
      >
        <textarea
          className="field-area italic text-zinc-400"
          rows={3}
          value={block.thinking}
          onChange={(e) =>
            updateBlock(msgIdx, blockIdx, { thinking: e.target.value })
          }
        />
        {block.signature && (
          <div className="text-[10px] text-zinc-600 mt-1 truncate">
            sig: {block.signature.slice(0, 60)}…
          </div>
        )}
      </BlockShell>
    )
  }

  if (block.type === 'image') {
    return (
      <BlockShell label="image" onRemove={() => removeBlock(msgIdx, blockIdx)}>
        {block.source.type === 'url' ? (
          <input
            className="field text-xs"
            placeholder="https://example.com/image.png"
            value={block.source.url}
            onChange={(e) =>
              updateBlock(msgIdx, blockIdx, {
                source: { type: 'url', url: e.target.value },
              })
            }
          />
        ) : (
          <div className="text-xs text-zinc-500">
            [image, {block.source.media_type}, {block.source.data.length} chars base64]
          </div>
        )}
      </BlockShell>
    )
  }

  return null
}

function BlockShell({
  label,
  accent = 'text-zinc-500',
  onRemove,
  actions,
  children,
}: {
  label: string
  accent?: string
  onRemove: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
      <div className="flex items-center justify-between mb-1">
        <span className={`text-[10px] uppercase tracking-wider ${accent}`}>{label}</span>
        <div className="flex items-center gap-1">
          {actions}
          <button
            className="btn-ghost text-[10px] text-zinc-600 hover:text-red-400"
            onClick={onRemove}
          >
            ✕
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

function PreviewToggle({
  mode,
  onChange,
}: {
  mode: 'edit' | 'preview'
  onChange: (mode: 'edit' | 'preview') => void
}) {
  return (
    <div className="markdown-preview-toggle" role="tablist" aria-label="Markdown view">
      <button
        className={mode === 'edit' ? 'is-active' : ''}
        onClick={() => onChange('edit')}
      >
        Edit
      </button>
      <button
        className={mode === 'preview' ? 'is-active' : ''}
        onClick={() => onChange('preview')}
      >
        Preview
      </button>
    </div>
  )
}

function TextBlockEditor({
  text,
  role,
  onRemove,
  onChange,
}: {
  text: string
  role: 'user' | 'assistant'
  onRemove: () => void
  onChange: (text: string) => void
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>(
    role === 'assistant' ? 'preview' : 'edit',
  )

  return (
    <BlockShell
      label="text"
      onRemove={onRemove}
      actions={<PreviewToggle mode={mode} onChange={setMode} />}
    >
      {mode === 'preview' ? (
        <MarkdownPreview>{text}</MarkdownPreview>
      ) : (
        <textarea
          className="field-area"
          rows={role === 'user' ? 2 : 3}
          placeholder={role === 'user' ? 'user message...' : 'assistant text...'}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </BlockShell>
  )
}

function ToolResultBlockEditor({
  block,
  msgIdx,
  blockIdx,
  onRemove,
  onChange,
}: {
  block: Extract<UserContentBlock, { type: 'tool_result' }>
  msgIdx: number
  blockIdx: number
  onRemove: () => void
  onChange: (patch: Partial<Extract<UserContentBlock, { type: 'tool_result' }>>) => void
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const messages = useStore((s) => s.messages)
  const execTools = useStore((s) => s.execTools)
  const skills = useStore((s) => s.skills)
  const mcpServers = useStore((s) => s.mcpServers)
  const canRunTool = useStore((s) => s.canRunTool)
  const runRegisteredTool = useStore((s) => s.runRegisteredTool)
  const currentCaseDebug = useStore((s) => s.currentCaseDebug)
  void execTools
  void skills
  void mcpServers
  const isLiveCase =
    currentCaseDebug?.metadata?.live === true || Boolean(currentCaseDebug?.live)

  // resolve the tool_use this is a result for (for the ▶ run button)
  let matchingToolName: string | undefined
  let matchingToolInput: Record<string, unknown> | undefined
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id === block.tool_use_id) {
        matchingToolName = b.name
        matchingToolInput = b.input
      }
    }
  }
  const canRun =
    !!matchingToolName && canRunTool(matchingToolName)
  const failed = isToolResultError(block)

  return (
    <BlockShell
      label="tool_result"
      accent="text-amber-400"
      onRemove={onRemove}
      actions={<PreviewToggle mode={mode} onChange={setMode} />}
    >
      {matchingToolName && (
        <div className="tool-call-summary">
          <span>matches</span>
          <code>{matchingToolName}</code>
          <span
            className={failed ? 'text-red-400' : 'text-emerald-400'}
            title={failed ? 'Tool returned an error result' : 'Tool returned successfully'}
          >
            {failed ? 'failed' : 'ok'}
          </span>
          {!canRun && (
            <span
              className="tool-status"
              title={
                isLiveCase
                  ? 'Result captured from the connected live agent'
                  : 'Manual or mock result'
              }
            >
              {isLiveCase ? 'live result' : 'mock'}
            </span>
          )}
        </div>
      )}
      {matchingToolInput && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
            input params
          </summary>
          <pre className="tool-schema-preview scrollbar">
            {JSON.stringify(matchingToolInput, null, 2)}
          </pre>
        </details>
      )}
      <div className="flex gap-1">
        <label className="tool-call-id-field flex-1">
          <span>call id</span>
          <input
            className="field text-xs"
            placeholder="tool_use_id"
            value={block.tool_use_id}
            onChange={(e) => onChange({ tool_use_id: e.target.value })}
          />
        </label>
        {canRun && (
          <button
            className="btn"
            title={`Execute ${matchingToolName} on the server and fill in the result`}
            onClick={() => runRegisteredTool(msgIdx, blockIdx)}
          >
            ▶ run {matchingToolName}
          </button>
        )}
      </div>
      {mode === 'preview' ? (
        <MarkdownPreview className={`mt-1 ${block.is_error ? 'is-error' : ''}`}>
          {block.content}
        </MarkdownPreview>
      ) : (
        <textarea
          className={`field-area mt-1 ${block.is_error ? 'border-red-700' : ''}`}
          rows={3}
          placeholder="tool result content..."
          value={block.content}
          onChange={(e) => onChange({ content: e.target.value })}
        />
      )}
      <label className="flex items-center gap-2 text-xs mt-1 text-zinc-400">
        <input
          type="checkbox"
          checked={block.is_error ?? false}
          onChange={(e) => onChange({ is_error: e.target.checked })}
        />
        is_error
      </label>
    </BlockShell>
  )
}

function ToolUseBlockEditor({
  block,
  msgIdx,
  blockIdx,
  onChange,
  onRemove,
}: {
  block: Extract<AssistantContentBlock, { type: 'tool_use' }>
  msgIdx: number
  blockIdx: number
  onChange: (patch: Partial<Extract<AssistantContentBlock, { type: 'tool_use' }>>) => void
  onRemove: () => void
}) {
  const [inputText, setInputText] = useState(() =>
    JSON.stringify(block.input, null, 2),
  )
  const [inputError, setInputError] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveContinuing, setLiveContinuing] = useState(false)
  const [toolNameMode, setToolNameMode] = useState<'pick' | 'custom'>('pick')
  const lastSyncedBlockIdRef = useRef(block.id)
  const lastSyncedInputRef = useRef(JSON.stringify(block.input, null, 2))
  const tools = useStore((s) => s.tools)
  const skills = useStore((s) => s.skills)
  const mcpServers = useStore((s) => s.mcpServers)
  const messages = useStore((s) => s.messages)
  const currentCaseDebug = useStore((s) => s.currentCaseDebug)
  const getEffectiveTools = useStore((s) => s.getEffectiveTools)
  const addMockToolResultAfter = useStore((s) => s.addMockToolResultAfter)
  const resumeLivePause = useStore((s) => s.resumeLivePause)
  const effectiveTools = getEffectiveTools()
  const isLiveCase =
    currentCaseDebug?.metadata?.live === true || Boolean(currentCaseDebug?.live)
  const isConfiguredTool = effectiveTools.some((tool) => tool.name === block.name)
  const toolNameOptions = effectiveTools.some((tool) => tool.name === block.name)
    ? effectiveTools
    : block.name
      ? [
          {
            name: block.name,
            description: isLiveCase
              ? 'external/live captured tool name'
              : 'custom/mock tool name',
            input_schema: {},
          },
          ...effectiveTools,
        ]
      : effectiveTools
  const toolNameListId = `tool-name-options-${block.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const nextMessage = messages[msgIdx + 1]
  const hasToolResult =
    nextMessage?.role === 'user' &&
    nextMessage.content.some(
      (item) => item.type === 'tool_result' && item.tool_use_id === block.id,
    )
  const matchingResult =
    nextMessage?.role === 'user'
      ? nextMessage.content.find(
          (item): item is Extract<UserContentBlock, { type: 'tool_result' }> =>
            item.type === 'tool_result' && item.tool_use_id === block.id,
        )
      : undefined
  const matchingResultFailed = isToolResultError(matchingResult)
  const liveForBlock =
    currentCaseDebug?.live?.toolCallId === block.id
      ? currentCaseDebug.live
      : undefined
  const livePlanProgress =
    typeof liveForBlock?.plan?.progress === 'string'
      ? liveForBlock.plan.progress
      : undefined
  const canContinueLive =
    liveForBlock?.status === 'paused' && typeof liveForBlock.pauseId === 'string'
  void tools
  void skills
  void mcpServers

  const serializedInput = JSON.stringify(block.input, null, 2)

  const continueLive = async () => {
    if (!canContinueLive || !liveForBlock?.pauseId) return
    setLiveContinuing(true)
    try {
      await resumeLivePause(liveForBlock.pauseId)
      setLiveError(null)
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : String(err))
    } finally {
      setLiveContinuing(false)
    }
  }

  useEffect(() => {
    const isNewBlock = lastSyncedBlockIdRef.current !== block.id
    const localIsSynced = inputText === lastSyncedInputRef.current
    if (isNewBlock || localIsSynced) {
      setInputText(serializedInput)
      setInputError(null)
    }
    if (isNewBlock) setToolNameMode(block.name && !isConfiguredTool ? 'custom' : 'pick')
    lastSyncedBlockIdRef.current = block.id
    lastSyncedInputRef.current = serializedInput
  }, [block.id, block.name, inputText, isConfiguredTool, serializedInput])

  useEffect(() => {
    if (block.name && !isConfiguredTool && toolNameMode === 'pick') {
      setToolNameMode('custom')
    }
  }, [block.name, isConfiguredTool, toolNameMode])

  return (
    <BlockShell
      label="tool_use"
      accent="text-emerald-400"
      onRemove={onRemove}
      actions={
        <>
          {canContinueLive && (
            <button
              className="btn-primary text-[10px]"
              disabled={liveContinuing}
              onClick={continueLive}
              title="Continue the paused connected agent session"
            >
              {liveContinuing ? 'Continuing...' : 'Continue live'}
            </button>
          )}
          <button
            className="btn-ghost text-[10px] text-zinc-500 hover:text-zinc-300"
            disabled={!block.id || hasToolResult}
            onClick={() => addMockToolResultAfter(msgIdx, blockIdx)}
            title={
              hasToolResult
                ? isLiveCase
                  ? 'A matching live tool_result already exists in the next user message'
                  : 'A matching mock tool_result already exists in the next user message'
                : 'Insert a matching tool_result in the next user message'
            }
          >
            {hasToolResult
              ? isLiveCase
                ? 'live result exists'
                : 'mock result exists'
              : isLiveCase
                ? '+ tool_result'
                : '+ mock result'}
          </button>
        </>
      }
    >
      <div className="space-y-1">
        <div className="tool-name-row">
          <div className="tool-call-id-field flex-1">
            <span>tool</span>
            {toolNameMode === 'pick' ? (
              <Select
                value={block.name}
                onChange={(name) => onChange({ name })}
                placeholder="pick configured tool"
                options={toolNameOptions.map((tool) => ({
                  value: tool.name,
                  label: tool.name,
                  searchText: `${tool.name} ${tool.description ?? ''}`,
                }))}
              />
            ) : (
              <>
                <input
                  className="field text-xs"
                  list={toolNameListId}
                  placeholder={
                    isLiveCase ? 'external/live tool name' : 'custom/mock tool name'
                  }
                  value={block.name}
                  onChange={(e) => onChange({ name: e.target.value })}
                />
                <datalist id={toolNameListId}>
                  {effectiveTools.map((tool) => (
                    <option key={tool.name} value={tool.name} />
                  ))}
                </datalist>
              </>
            )}
          </div>
          <div className="markdown-preview-toggle" role="tablist" aria-label="Tool name mode">
            <button
              className={toolNameMode === 'pick' ? 'is-active' : ''}
              onClick={() => setToolNameMode('pick')}
            >
              Pick
            </button>
            <button
              className={toolNameMode === 'custom' ? 'is-active' : ''}
              onClick={() => setToolNameMode('custom')}
            >
              Custom
            </button>
          </div>
          {block.name && !isConfiguredTool && (
            <span
              className="tool-status"
              title={
                isLiveCase
                  ? 'Tool captured from a connected live agent'
                  : 'Manual or mock tool name'
              }
            >
              {isLiveCase ? 'external' : 'mock'}
            </span>
          )}
          {matchingResult && (
            <span
              className={matchingResultFailed ? 'text-red-400' : 'text-emerald-400'}
              title={
                matchingResultFailed
                  ? 'Matching tool_result is an error'
                  : 'Matching tool_result is available'
              }
            >
              {matchingResultFailed ? 'failed' : 'ok'}
            </span>
          )}
          {liveForBlock?.status && (
            <span
              className={
                liveForBlock.status === 'paused'
                  ? 'text-amber-400'
                  : liveForBlock.status === 'continued'
                    ? 'text-emerald-400'
                    : 'text-red-400'
              }
              title="Live breakpoint status"
            >
              live {liveForBlock.status}
            </span>
          )}
        </div>
      </div>
      {livePlanProgress && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
            live plan progress
          </summary>
          <pre className="tool-schema-preview scrollbar">{livePlanProgress}</pre>
        </details>
      )}
      {liveError && <div className="mt-1 text-xs text-red-400">{liveError}</div>}
      <div className="mt-1">
        <label className="tool-call-id-field">
          <span>call id</span>
          <input
            className="field text-xs"
            placeholder="provider-generated id"
            value={block.id}
            onChange={(e) => onChange({ id: e.target.value })}
          />
        </label>
      </div>
      <div className="mt-1">
        <div className="label mb-0.5">input (JSON)</div>
        <textarea
          className={`field-area font-mono text-xs ${inputError ? 'border-red-700' : ''}`}
          rows={3}
          value={inputText}
          onChange={(e) => {
            const value = e.target.value
            setInputText(value)
            try {
              const parsed = JSON.parse(value || '{}')
              setInputError(null)
              onChange({ input: parsed })
            } catch (err) {
              setInputError((err as Error).message)
            }
          }}
        />
        {inputError && (
          <div className="mt-1 text-xs text-red-400">
            Invalid JSON; the last valid input is what will be sent.
          </div>
        )}
      </div>
    </BlockShell>
  )
}
