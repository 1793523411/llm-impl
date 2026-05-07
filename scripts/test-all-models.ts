import { readFileSync } from 'node:fs'

const SERVER = process.env.SERVER ?? 'http://localhost:3099'
const config = JSON.parse(
  readFileSync('./config/providers.json', 'utf8'),
) as {
  providers: Record<
    string,
    {
      baseUrl: string
      apiKey: string
      api: 'openai-completions' | 'anthropic-messages'
      models: Array<{ id: string; name?: string }>
    }
  >
}

type Result = {
  provider: string
  api: string
  model: string
  ok: boolean
  ms: number
  out?: string
  err?: string
}
const results: Result[] = []

for (const [pkey, prov] of Object.entries(config.providers)) {
  for (const m of prov.models) {
    process.stdout.write(`testing ${pkey}/${m.id} … `)
    const start = Date.now()
    try {
      const res = await fetch(`${SERVER}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            provider: pkey,
            model: m.id,
            max_tokens: 30,
            stream: false,
          },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Reply with the word "hi"' }],
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      const ms = Date.now() - start
      if (res.ok) {
        const data = (await res.json()) as {
          message: { content: Array<{ type: string; text?: string }> }
        }
        const text =
          data.message?.content?.find((b) => b.type === 'text')?.text ??
          '(no text block)'
        results.push({
          provider: pkey,
          api: prov.api,
          model: m.id,
          ok: true,
          ms,
          out: text.replace(/\n/g, ' ').slice(0, 50),
        })
        console.log(`✓ ${ms}ms`)
      } else {
        const err = await res.text()
        results.push({
          provider: pkey,
          api: prov.api,
          model: m.id,
          ok: false,
          ms,
          err: err.replace(/\n/g, ' ').slice(0, 200),
        })
        console.log(`✗ ${res.status} ${err.slice(0, 80)}`)
      }
    } catch (e) {
      const ms = Date.now() - start
      results.push({
        provider: pkey,
        api: prov.api,
        model: m.id,
        ok: false,
        ms,
        err: (e as Error).message.slice(0, 200),
      })
      console.log(`✗ ${(e as Error).message}`)
    }
  }
}

console.log('\n══════════ SUMMARY ══════════')
const okCount = results.filter((r) => r.ok).length
console.log(`${okCount}/${results.length} models OK\n`)

const colWidths = {
  status: 2,
  provider: Math.max(...results.map((r) => r.provider.length)),
  api: Math.max(...results.map((r) => r.api.length)),
  model: Math.max(...results.map((r) => r.model.length)),
  ms: 6,
}
const pad = (s: string, w: number) => s.padEnd(w)
for (const r of results) {
  const status = r.ok ? '✓' : '✗'
  const detail = r.ok ? r.out : r.err
  console.log(
    `${status}  ${pad(r.provider, colWidths.provider)}  ${pad(r.api, colWidths.api)}  ${pad(r.model, colWidths.model)}  ${r.ms.toString().padStart(5)}ms  ${detail}`,
  )
}
