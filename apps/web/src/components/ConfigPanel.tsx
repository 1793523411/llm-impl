import { useState } from 'react'
import type { ProviderTestResponse } from '@llm-impl/shared'
import * as api from '../api'
import { useStore } from '../store'
import { Select } from './ui/Select'

function protocolLabel(api: string): string {
  if (api === 'anthropic-messages') return 'anthropic'
  if (api === 'openai-responses') return 'responses'
  return 'openai'
}

export function ModelConfigForm() {
  const config = useStore((s) => s.config)
  const setConfig = useStore((s) => s.setConfig)
  const providers = useStore((s) => s.providers)
  const lastUsage = useStore((s) => s.lastUsage)
  const lastLatency = useStore((s) => s.lastLatency)
  const lastStopReason = useStore((s) => s.lastStopReason)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResponse | null>(null)

  const currentProvider = providers.find((p) => p.key === config.provider)
  const currentModel = currentProvider?.models.find((m) => m.id === config.model)

  const handleTest = async () => {
    if (!config.provider || !config.model) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.testProviderModel(config.provider, config.model))
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="model-config-form space-y-4">
        <div>
          <div className="label mb-1">provider</div>
          <Select
            value={config.provider}
            onChange={(newKey) => {
              const newProvider = providers.find((p) => p.key === newKey)
              const firstModelId = newProvider?.models[0]?.id ?? ''
              setTestResult(null)
              setConfig({ provider: newKey, model: firstModelId })
            }}
            placeholder={providers.length === 0 ? '(loading…)' : '(select provider)'}
            options={providers.map((p) => ({
              value: p.key,
              label: `${p.key} · ${protocolLabel(p.api)}`,
              searchText: `${p.key} ${p.api} ${p.baseUrl}`,
            }))}
          />
          {currentProvider && (
            <div className="text-[10px] text-zinc-600 mt-1 truncate">
              {currentProvider.baseUrl}
            </div>
          )}
        </div>

        <div>
          <div className="label mb-1">model</div>
          <div className="flex gap-1">
            <Select
              className="flex-1"
              value={config.model}
              onChange={(model) => {
                setConfig({ model })
                setTestResult(null)
              }}
              placeholder={currentProvider ? '(select model)' : '(select provider)'}
              options={(currentProvider?.models ?? []).map((m) => ({
                value: m.id,
                label: `${m.name ?? m.id}${m.reasoning ? ' 🧠' : ''}${
                  m.input?.includes('image') ? ' 🖼' : ''
                }`,
                searchText: `${m.id} ${m.name ?? ''}`,
              }))}
            />
            <button
              className="btn"
              disabled={!currentProvider || !currentModel || testing}
              onClick={handleTest}
              title="Run a minimal request against this model"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
          {currentModel && (
            <div className="text-[10px] text-zinc-600 mt-1 space-x-2">
              {currentModel.contextWindow && (
                <span>ctx {(currentModel.contextWindow / 1000).toFixed(0)}k</span>
              )}
              {currentModel.maxTokens && <span>max {currentModel.maxTokens}</span>}
              <span className="font-mono">{currentModel.id}</span>
            </div>
          )}
          {testResult && (
            <div
              className={`text-[10px] mt-1 truncate ${
                testResult.ok ? 'text-emerald-400' : 'text-red-400'
              }`}
              title={testResult.error ?? testResult.sample}
            >
              {testResult.ok
                ? `ok · ${testResult.latency_ms ?? '?'} ms`
                : `failed · ${testResult.error ?? 'unknown error'}`}
              {testResult.ok && testResult.sample ? ` · ${testResult.sample}` : ''}
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
  )
}

export function ConfigPanel() {
  return (
    <aside className="w-full h-full border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-auto scrollbar">
      <div className="p-3">
        <ModelConfigForm />
      </div>
    </aside>
  )
}
