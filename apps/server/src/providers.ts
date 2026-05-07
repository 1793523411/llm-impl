import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ApiProtocol, ModelInfo, ProviderInfo } from '@llm-impl/shared'

export type ProviderRecord = {
  baseUrl: string
  apiKey: string
  api: ApiProtocol
  models: ModelInfo[]
}

let cache: Record<string, ProviderRecord> | null = null

function configPath(): string {
  return path.resolve(
    process.env.PROVIDERS_CONFIG ?? './config/providers.json',
  )
}

export function loadProviders(): Record<string, ProviderRecord> {
  if (cache) return cache
  const p = configPath()
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw)
    cache = (parsed.providers ?? parsed) as Record<string, ProviderRecord>
    const keys = Object.keys(cache)
    console.log(`[providers] loaded ${keys.length} provider(s) from ${p}: ${keys.join(', ')}`)
  } catch (e) {
    console.warn(`[providers] could not load ${p}: ${(e as Error).message}`)
    cache = {}
  }
  return cache
}

export function publicProviders(): ProviderInfo[] {
  return Object.entries(loadProviders()).map(([key, p]) => ({
    key,
    api: p.api,
    baseUrl: p.baseUrl,
    models: p.models,
  }))
}

export function getProvider(key: string): ProviderRecord | undefined {
  return loadProviders()[key]
}
