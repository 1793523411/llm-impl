import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { stream as honoStream } from 'hono/streaming'
import {
  ExecToolRequest,
  McpCallToolRequest,
  McpListToolsRequest,
  ProviderTestRequest,
  RunRequest,
  SkillListRequest,
  SkillLoadRequest,
} from '@llm-impl/shared'
import { runOnce, runStream } from './run'
import {
  listCases,
  readCase,
  writeCase,
  deleteCase,
  createCaseDir,
  moveCaseEntry,
} from './cases'
import { publicProviders } from './providers'
import { readWorkspace, writeWorkspace } from './workspace'
import { execTool, listTools } from './exec-tool'
import { callMcpTool, listMcpTools } from './mcp'
import { listSkills, loadSkillContent } from './skills'

const app = new Hono()

app.use('*', logger())
app.use('/api/*', cors())

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/providers', (c) => c.json(publicProviders()))

app.post('/api/providers/test', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = ProviderTestRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
  }

  const started = Date.now()
  try {
    const result = await runOnce({
      config: {
        provider: parsed.data.provider,
        model: parsed.data.model,
        max_tokens: 64,
        stream: false,
      },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Reply with exactly: ok' }],
        },
      ],
    })
    const sample = result.message.content
      .map((block) => {
        if (block.type === 'text') return block.text
        if (block.type === 'thinking') return block.thinking
        return `[${block.type}]`
      })
      .join('\n')
      .slice(0, 200)
    return c.json({
      ok: true,
      latency_ms: result.latency_ms,
      stop_reason: result.stop_reason,
      usage: result.usage,
      sample,
    })
  } catch (e) {
    const err = e as Error & { error?: unknown }
    return c.json({
      ok: false,
      latency_ms: Date.now() - started,
      error: err.message ?? 'test failed',
      provider_error: err.error ?? null,
    })
  }
})

app.get('/api/exec-tools', (c) => c.json(listTools()))

app.post('/api/skills/list', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = SkillListRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid request', issues: parsed.error.issues }, 400)
  }
  try {
    const skills = await listSkills(parsed.data.roots)
    return c.json({ ok: true, skills })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500)
  }
})

app.post('/api/skills/load', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = SkillLoadRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ content: 'invalid request', is_error: true }, 400)
  }
  try {
    const content = await loadSkillContent(parsed.data.skill)
    return c.json({ content })
  } catch (e) {
    return c.json({ content: (e as Error).message, is_error: true })
  }
})

app.post('/api/exec-tool', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = ExecToolRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
  }
  const result = await execTool(
    parsed.data.name,
    parsed.data.input ?? {},
    parsed.data.sandbox,
  )
  return c.json(result)
})

app.post('/api/mcp/list-tools', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = McpListToolsRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid request', issues: parsed.error.issues }, 400)
  }
  try {
    const result = await listMcpTools(parsed.data.server)
    return c.json({ ok: true, ...result })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500)
  }
})

app.post('/api/mcp/call-tool', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = McpCallToolRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
  }
  const result = await callMcpTool(
    parsed.data.server,
    parsed.data.toolName,
    parsed.data.input ?? {},
  )
  return c.json(result)
})

app.post('/api/run', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = RunRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
  }

  if (parsed.data.config.stream) {
    c.header('content-type', 'application/x-ndjson')
    c.header('cache-control', 'no-cache')
    return honoStream(c, async (s) => {
      try {
        for await (const event of runStream(parsed.data)) {
          await s.write(JSON.stringify(event) + '\n')
        }
      } catch (e) {
        const err = e as Error & { status?: number; error?: unknown }
        await s.write(
          JSON.stringify({
            type: 'error',
            message: err.message ?? 'stream error',
          }) + '\n',
        )
      }
    })
  }

  try {
    const result = await runOnce(parsed.data)
    return c.json(result)
  } catch (e) {
    const err = e as Error & { status?: number; error?: unknown }
    return c.json(
      {
        error: err.message ?? 'unknown error',
        provider_error: err.error ?? null,
      },
      (err.status as 400 | 401 | 500) ?? 500,
    )
  }
})

app.get('/api/workspace', async (c) => {
  return c.json(await readWorkspace())
})

app.put('/api/workspace', async (c) => {
  const body = await c.req.json()
  await writeWorkspace(body)
  return c.json({ ok: true })
})

app.get('/api/cases', async (c) => {
  return c.json(await listCases())
})

app.post('/api/case-dirs', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null
  const dirPath = typeof body?.path === 'string' ? body.path.trim() : ''
  if (!dirPath) return c.json({ error: 'missing path' }, 400)
  try {
    await createCaseDir(dirPath)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.post('/api/cases/move', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { from?: unknown; to?: unknown }
    | null
  const from = typeof body?.from === 'string' ? body.from.trim() : ''
  const to = typeof body?.to === 'string' ? body.to.trim() : ''
  if (!from || !to) return c.json({ error: 'missing path' }, 400)
  try {
    const ok = await moveCaseEntry(from, to)
    return c.json({ ok })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.get('/api/cases/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cases\//, '')
  if (!path) return c.json({ error: 'missing path' }, 400)
  const data = await readCase(path)
  if (!data) return c.json({ error: 'not found' }, 404)
  return c.json(data)
})

app.put('/api/cases/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cases\//, '')
  if (!path) return c.json({ error: 'missing path' }, 400)
  const body = await c.req.json()
  await writeCase(path, body)
  return c.json({ ok: true })
})

app.delete('/api/cases/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cases\//, '')
  if (!path) return c.json({ error: 'missing path' }, 400)
  const ok = await deleteCase(path)
  return c.json({ ok })
})

const port = Number(process.env.PORT ?? 3181)
console.log(`[server] listening on http://localhost:${port}`)

export default { port, fetch: app.fetch }
