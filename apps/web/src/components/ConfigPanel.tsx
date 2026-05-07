import { useStore } from '../store'

export function ConfigPanel() {
  const config = useStore((s) => s.config)
  const setConfig = useStore((s) => s.setConfig)
  const providers = useStore((s) => s.providers)
  const lastUsage = useStore((s) => s.lastUsage)
  const lastLatency = useStore((s) => s.lastLatency)
  const lastStopReason = useStore((s) => s.lastStopReason)

  const currentProvider = providers.find((p) => p.key === config.provider)
  const currentModel = currentProvider?.models.find((m) => m.id === config.model)

  return (
    <aside className="w-72 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-auto scrollbar">
      <div className="p-3 space-y-4">
        <div>
          <div className="label mb-1">provider</div>
          <select
            className="field"
            value={config.provider}
            onChange={(e) => {
              const newKey = e.target.value
              const newProvider = providers.find((p) => p.key === newKey)
              const firstModelId = newProvider?.models[0]?.id ?? ''
              setConfig({ provider: newKey, model: firstModelId })
            }}
          >
            {providers.length === 0 && <option value="">(loading…)</option>}
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} · {p.api === 'anthropic-messages' ? 'anthropic' : 'openai'}
              </option>
            ))}
          </select>
          {currentProvider && (
            <div className="text-[10px] text-zinc-600 mt-1 truncate">
              {currentProvider.baseUrl}
            </div>
          )}
        </div>

        <div>
          <div className="label mb-1">model</div>
          <select
            className="field"
            value={config.model}
            onChange={(e) => setConfig({ model: e.target.value })}
          >
            {!currentProvider && <option value="">(select provider)</option>}
            {currentProvider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
                {m.reasoning ? ' 🧠' : ''}
                {m.input?.includes('image') ? ' 🖼' : ''}
              </option>
            ))}
          </select>
          {currentModel && (
            <div className="text-[10px] text-zinc-600 mt-1 space-x-2">
              {currentModel.contextWindow && (
                <span>ctx {(currentModel.contextWindow / 1000).toFixed(0)}k</span>
              )}
              {currentModel.maxTokens && <span>max {currentModel.maxTokens}</span>}
              <span className="font-mono">{currentModel.id}</span>
            </div>
          )}
        </div>

        <div>
          <div className="label mb-1">
            temperature ({config.temperature ?? 'default'})
          </div>
          <input
            className="w-full"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={config.temperature ?? 1}
            onChange={(e) => setConfig({ temperature: Number(e.target.value) })}
          />
        </div>

        <div>
          <div className="label mb-1">max_tokens</div>
          <input
            className="field"
            type="number"
            min={1}
            value={config.max_tokens ?? 4096}
            onChange={(e) => setConfig({ max_tokens: Number(e.target.value) })}
          />
        </div>

        {currentProvider?.api === 'anthropic-messages' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!config.thinking}
                onChange={(e) =>
                  setConfig({
                    thinking: e.target.checked
                      ? { type: 'enabled', budget_tokens: 1024 }
                      : undefined,
                  })
                }
              />
              <span>extended thinking</span>
            </label>
            {config.thinking && (
              <div>
                <div className="label mb-1">thinking budget</div>
                <input
                  className="field"
                  type="number"
                  min={1024}
                  value={config.thinking.budget_tokens}
                  onChange={(e) =>
                    setConfig({
                      thinking: {
                        type: 'enabled',
                        budget_tokens: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
            )}
          </div>
        )}

        <hr className="border-zinc-800" />

        <div>
          <div className="label mb-1">last run</div>
          {lastLatency !== null ? (
            <div className="text-xs space-y-0.5 text-zinc-400">
              <div>latency: {lastLatency} ms</div>
              {lastStopReason && <div>stop: {lastStopReason}</div>}
              {lastUsage && (
                <>
                  <div>in: {lastUsage.input_tokens ?? '?'} tok</div>
                  <div>out: {lastUsage.output_tokens ?? '?'} tok</div>
                  {lastUsage.cache_read_input_tokens !== undefined && (
                    <div>cache read: {lastUsage.cache_read_input_tokens}</div>
                  )}
                  {lastUsage.cache_creation_input_tokens !== undefined && (
                    <div>cache write: {lastUsage.cache_creation_input_tokens}</div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-600">no run yet</div>
          )}
        </div>
      </div>
    </aside>
  )
}
