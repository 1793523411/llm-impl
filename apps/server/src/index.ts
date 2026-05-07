import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { stream as honoStream } from 'hono/streaming'
import { ExecToolRequest, RunRequest } from '@llm-impl/shared'
import { runOnce, runStream } from './run'
import { listCases, readCase, writeCase, deleteCase } from './cases'
import { publicProviders } from './providers'
import { readWorkspace, writeWorkspace } from './workspace'
import { execTool, listTools } from './exec-tool'

const app = new Hono()

app.use('*', logger())
app.use('/api/*', cors())

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/providers', (c) => c.json(publicProviders()))

app.get('/api/exec-tools', (c) => c.json(listTools()))

app.post('/api/exec-tool', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = ExecToolRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
  }
  const result = await execTool(parsed.data.name, parsed.data.input ?? {})
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
