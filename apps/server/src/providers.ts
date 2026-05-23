import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ApiProtocol, ModelInfo, ProviderInfo } from '@llm-impl/shared'

export type ProviderRecord = {
  baseUrl: string
  apiKey: string
  api: ApiProtocol
  models: ModelInfo[]
}

function configPath(): string {
  return path.resolve(
    process.env.PROVIDERS_CONFIG ?? './config/providers.json',
  )
}

export function loadProviders(): Record<string, ProviderRecord> {
  const p = configPath()
  try {
    return loadProvidersFile(p)
  } catch (e) {
    console.warn(`[providers] could not load ${p}: ${(e as Error).message}`)
    return {}
  }
}

function loadProvidersFile(
  filePath: string,
  seen = new Set<string>(),
): Record<string, ProviderRecord> {
  const absPath = path.resolve(filePath)
  if (seen.has(absPath)) {
    throw new Error(`circular providers include: ${absPath}`)
  }
  seen.add(absPath)

  const raw = readFileSync(absPath, 'utf8')
  const parsed = JSON.parse(raw) as {
    include?: string
    includes?: string[]
    providers?: Record<string, ProviderRecord>
    models?: { providers?: Record<string, ProviderRecord> }
  } & Record<string, ProviderRecord>

  const providers: Record<string, ProviderRecord> = {}
  const includes = [
    ...(parsed.include ? [parsed.include] : []),
    ...(parsed.includes ?? []),
  ]
  for (const include of includes) {
    Object.assign(
      providers,
      loadProvidersFile(path.resolve(path.dirname(absPath), include), seen),
    )
  }

  const ownProviders =
    parsed.providers ??
    parsed.models?.providers ??
    (includes.length > 0 ? {} : parsed)
  Object.assign(providers, ownProviders)

  seen.delete(absPath)
  return providers
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
