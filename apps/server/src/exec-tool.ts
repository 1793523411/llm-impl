import type { ExecToolDef, ExecToolResponse } from '@llm-impl/shared'

type ToolImpl = ExecToolDef & {
  handler: (input: Record<string, unknown>) => Promise<ExecToolResponse>
}

const tools: ToolImpl[] = [
  {
    name: 'get_time',
    description: 'Get the current ISO timestamp.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({ content: new Date().toISOString() }),
  },
  {
    name: 'web_fetch',
    description: 'GET a URL and return the response body (truncated to 10KB).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch (http(s))' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (input) => {
      const url = String(input.url ?? '')
      if (!/^https?:\/\//.test(url)) {
        return { content: 'invalid url (must be http or https)', is_error: true }
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        const text = await res.text()
        const truncated = text.slice(0, 10_000)
        return {
          content: `[HTTP ${res.status}]\n${truncated}${text.length > 10_000 ? '\n…(truncated)' : ''}`,
          is_error: !res.ok,
        }
      } catch (e) {
        return { content: `fetch error: ${(e as Error).message}`, is_error: true }
      }
    },
  },
  {
    name: 'calculator',
    description:
      'Evaluate a math expression. Allowed: digits, +, -, *, /, parentheses.',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'A math expression' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    handler: async (input) => {
      const expr = String(input.expression ?? '')
      if (!/^[\d\s+\-*/().]+$/.test(expr)) {
        return {
          content: 'expression contains invalid characters',
          is_error: true,
        }
      }
      try {
        const result = new Function(`"use strict"; return (${expr})`)() as unknown
        return { content: String(result) }
      } catch (e) {
        return { content: (e as Error).message, is_error: true }
      }
    },
  },
]

export function listTools(): ExecToolDef[] {
  return tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }))
}

export async function execTool(
  name: string,
  input: unknown,
): Promise<ExecToolResponse> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { content: `unknown tool: ${name}`, is_error: true }
  try {
    const inputObj =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    return await tool.handler(inputObj)
  } catch (e) {
    return { content: `tool error: ${(e as Error).message}`, is_error: true }
  }
}
