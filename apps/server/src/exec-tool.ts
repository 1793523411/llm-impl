import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExecToolDef, ExecToolResponse } from '@llm-impl/shared'

type ToolImpl = ExecToolDef & {
  handler: (input: Record<string, unknown>) => Promise<ExecToolResponse>
}

type CommandStatus = 'success' | 'failed' | 'timeout' | 'blocked'

const MAX_COMMAND_TIMEOUT_MS = 600_000
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024
const MAX_FILE_SIZE = 256 * 1024
const MAX_FETCH_CHARS = 128 * 1024
const DEFAULT_FETCH_CHARS = 32 * 1024
const FETCH_TIMEOUT_MS = 15_000
const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
])

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/,
  /\brm\s+-rf\s+\/(\s|$|\*)/,
  /\brm\s+-fr\s+\/(\s|$|\*)/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\/[sh]d/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bhalt\b/,
  />\s*\/dev\/[sh]d/,
  /\bchmod\s+-R\s+777\s+\/\s*$/,
  /\bchown\s+-R\s+.*\s+\/\s*$/,
]

const truncateMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  const keep = Math.floor(maxChars / 2)
  return `${text.slice(0, keep)}\n...[truncated]...\n${text.slice(-keep)}`
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : ''

const asPositiveNumber = (
  value: unknown,
  fallback: number,
  max: number,
): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback

const asNonNegativeNumber = (
  value: unknown,
  fallback: number,
  max: number,
): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, max)
    : fallback

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

function findDangerousCommand(command: string): string | null {
  const trimmed = command.trim()
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return pattern.source
  }
  return null
}

function formatRunCommandResult(payload: {
  status: CommandStatus
  command: string
  cwd: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: string | null
  note?: string
}): string {
  const rows = [
    '[run_command]',
    `status: ${payload.status}`,
    `command: ${payload.command}`,
    `cwd: ${payload.cwd}`,
  ]
  if (typeof payload.exitCode === 'number') rows.push(`exit_code: ${payload.exitCode}`)
  if (payload.signal) rows.push(`signal: ${payload.signal}`)
  if (payload.note) rows.push(`note: ${payload.note}`)
  if (payload.stdout) rows.push(`stdout:\n${payload.stdout}`)
  if (payload.stderr) rows.push(`stderr:\n${payload.stderr}`)
  return rows.join('\n')
}

async function runCommandHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const command = asString(input.command).trim()
  if (!command) return { content: 'command is required', is_error: true }

  const requestedCwd = asString(input.working_directory).trim()
  const cwd = requestedCwd ? path.resolve(requestedCwd) : process.cwd()
  if (!(await directoryExists(cwd))) {
    return {
      content: formatRunCommandResult({
        status: 'failed',
        command,
        cwd,
        note: 'working_directory does not exist or is not a directory',
      }),
      is_error: true,
    }
  }

  const dangerousPattern = findDangerousCommand(command)
  if (dangerousPattern) {
    return {
      content: formatRunCommandResult({
        status: 'blocked',
        command,
        cwd,
        note: `blocked dangerous command pattern: ${dangerousPattern}`,
      }),
      is_error: true,
    }
  }

  const timeoutMs = asPositiveNumber(
    input.timeout_ms,
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  )

  return new Promise<ExecToolResponse>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, LANG: process.env.LANG ?? 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = (text: string) => truncateMiddle(text, MAX_COMMAND_OUTPUT_CHARS)
    const finish = (response: ExecToolResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(response)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        content: formatRunCommandResult({
          status: 'timeout',
          command,
          cwd,
          stdout: stdout.trimEnd() || undefined,
          stderr: stderr.trimEnd() || undefined,
          note: `process killed after ${timeoutMs}ms`,
        }),
        is_error: true,
      })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = cap(stdout + chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = cap(stderr + chunk)
    })
    child.on('error', (error) => {
      finish({ content: error.message, is_error: true })
    })
    child.on('close', (code, signal) => {
      const ok = code === 0
      finish({
        content: formatRunCommandResult({
          status: ok ? 'success' : 'failed',
          command,
          cwd,
          stdout: stdout.trimEnd() || '(no output)',
          stderr: stderr.trimEnd() || undefined,
          exitCode: code,
          signal,
        }),
        is_error: !ok,
      })
    })
  })
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchUrlHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const url = asString(input.url).trim()
  if (!/^https?:\/\//.test(url)) {
    return { content: 'invalid url (must be http or https)', is_error: true }
  }
  const maxLength = asPositiveNumber(
    input.max_length,
    DEFAULT_FETCH_CHARS,
    MAX_FETCH_CHARS,
  )
  const format = ['text', 'html', 'json'].includes(asString(input.format))
    ? asString(input.format)
    : 'text'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'llm-impl/1.0 fetch_url',
        accept: format === 'json' ? 'application/json,*/*' : 'text/html,text/plain,*/*',
      },
      redirect: 'follow',
    })
    const contentType = res.headers.get('content-type') ?? ''
    const raw = await res.text()
    let body = raw
    if (format === 'json') {
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        body = raw
      }
    } else if (format === 'text') {
      body =
        contentType.includes('html') || raw.trimStart().startsWith('<')
          ? htmlToText(raw)
          : raw
    }
    const truncated = truncateMiddle(body, maxLength)
    return {
      content: [
        `[url: ${url}]`,
        `[status: ${res.status}]`,
        `[content-type: ${contentType || 'unknown'}]`,
        '',
        truncated,
        body.length > maxLength ? `\n[truncated at ${maxLength} chars]` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      is_error: !res.ok,
    }
  } catch (e) {
    const message =
      e instanceof Error && e.name === 'AbortError'
        ? `request timed out after ${FETCH_TIMEOUT_MS}ms`
        : (e as Error).message
    return { content: `fetch error: ${message}`, is_error: true }
  } finally {
    clearTimeout(timer)
  }
}

async function readFileHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const filePath = asString(input.path).trim()
  if (!filePath) return { content: 'path is required', is_error: true }
  if (!(await fileExists(filePath))) {
    return { content: `[error] File not found: ${filePath}`, is_error: true }
  }
  const stat = await fs.stat(filePath)
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(Math.floor(input.limit), 5_000)
      : undefined
  if (stat.size > MAX_FILE_SIZE && !limit) {
    return {
      content: `[error] File too large (${stat.size} bytes). Use offset/limit to read a portion.`,
      is_error: true,
    }
  }
  const offset =
    typeof input.offset === 'number' && Number.isFinite(input.offset)
      ? Math.max(1, Math.floor(input.offset))
      : 1
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.split('\n')
    const start = offset - 1
    const end = limit ? start + limit : lines.length
    const slice = lines.slice(start, end)
    return {
      content:
        slice.map((line, i) => `${start + i + 1}|${line}`).join('\n') ||
        '(empty file)',
    }
  } catch (e) {
    return { content: `[error] ${(e as Error).message}`, is_error: true }
  }
}

type FileEntry = {
  relativePath: string
  isDirectory: boolean
  depth: number
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] ?? ''
    const next = normalized[i + 1]
    if (char === '*' && next === '*') {
      source += '.*'
      i += 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const regex = globToRegExp(pattern)
  if (regex.test(normalized)) return true
  return !pattern.includes('/') && regex.test(path.basename(normalized))
}

async function collectFiles(options: {
  basePath: string
  currentPath: string
  maxDepth: number
  includeHidden: boolean
  pattern?: string
  maxResults: number
  depth?: number
}): Promise<{ entries: FileEntry[]; totalFound: number }> {
  const depth = options.depth ?? 0
  const entries: FileEntry[] = []
  let totalFound = 0
  let names: string[] = []
  try {
    names = await fs.readdir(options.currentPath)
  } catch {
    return { entries, totalFound }
  }

  names.sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    if (!options.includeHidden && name.startsWith('.')) continue
    if (NOISE_DIRS.has(name)) continue

    const fullPath = path.join(options.currentPath, name)
    const stat = await fs.stat(fullPath).catch(() => null)
    if (!stat) continue
    const relativePath = path.relative(options.basePath, fullPath).replace(/\\/g, '/')
    const isDirectory = stat.isDirectory()
    const matches = options.pattern
      ? matchesGlob(relativePath, options.pattern)
      : true

    if (matches) {
      entries.push({ relativePath, isDirectory, depth })
      totalFound += 1
      if (entries.length >= options.maxResults) break
    }

    if (isDirectory && depth < options.maxDepth && entries.length < options.maxResults) {
      const child = await collectFiles({
        ...options,
        currentPath: fullPath,
        depth: depth + 1,
        maxResults: options.maxResults - entries.length,
      })
      entries.push(...child.entries)
      totalFound += child.totalFound
    }
  }

  return { entries, totalFound }
}

function formatFileTree(entries: FileEntry[], totalFound: number, maxResults: number): string {
  const lines = entries.slice(0, maxResults).map((entry) => {
    const indent = '  '.repeat(entry.depth)
    const suffix = entry.isDirectory ? '/' : ''
    return `${indent}${entry.relativePath.split('/').pop() ?? entry.relativePath}${suffix}`
  })
  if (totalFound > maxResults) {
    lines.push(`\n... and ${totalFound - maxResults} more entries`)
  }
  return lines.join('\n')
}

function formatFlatEntries(entries: FileEntry[], totalFound: number, maxResults: number): string {
  const lines = entries
    .slice(0, maxResults)
    .map((entry) => `${entry.relativePath}${entry.isDirectory ? '/' : ''}`)
  if (totalFound > maxResults) {
    lines.push(`\n... and ${totalFound - maxResults} more entries`)
  }
  return lines.join('\n')
}

async function listFilesHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const dirPath = asString(input.path).trim()
  if (!dirPath) return { content: 'path is required', is_error: true }
  if (!(await directoryExists(dirPath))) {
    return { content: `[error] Not a directory: ${dirPath}`, is_error: true }
  }
  const maxDepth = asNonNegativeNumber(input.max_depth, 3, 10)
  const maxResults = asPositiveNumber(input.max_results, 200, 1_000)
  const includeHidden = input.include_hidden === true
  const pattern = asString(input.pattern).trim() || undefined
  const { entries, totalFound } = await collectFiles({
    basePath: dirPath,
    currentPath: dirPath,
    maxDepth,
    includeHidden,
    pattern,
    maxResults,
  })
  if (entries.length === 0) {
    return {
      content: pattern
        ? `No files matching pattern '${pattern}' found in ${dirPath}`
        : `Directory is empty: ${dirPath}`,
    }
  }
  const header = pattern
    ? `Files matching '${pattern}' in ${dirPath}:`
    : `Contents of ${dirPath}:`
  const body = pattern
    ? formatFlatEntries(entries, totalFound, maxResults)
    : formatFileTree(entries, totalFound, maxResults)
  return { content: `${header}\n\n${body}` }
}

function buildSymbolPattern(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    String.raw`(export\s+)?(async\s+)?function\s+${escaped}`,
    String.raw`class\s+${escaped}`,
    String.raw`interface\s+${escaped}`,
    String.raw`type\s+${escaped}\s*[=<]`,
    String.raw`const\s+${escaped}\s*=`,
    String.raw`(def|class)\s+${escaped}`,
    String.raw`func\s+(\(.*?\)\s+)?${escaped}`,
    String.raw`(pub\s+)?(fn|struct|enum|trait|type|const)\s+${escaped}`,
  ].join('|')
}

function execFileCollect(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        maxBuffer: MAX_COMMAND_OUTPUT_CHARS * 2,
        timeout: 30_000,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const typedError = error as
          | (Error & { code?: number | string | null })
          | null
        const code =
          typeof typedError?.code === 'number'
            ? typedError.code
            : error
              ? 1
              : 0
        resolve({
          code,
          stdout: stdout ? truncateMiddle(stdout, MAX_COMMAND_OUTPUT_CHARS) : '',
          stderr: stderr ? truncateMiddle(stderr, MAX_COMMAND_OUTPUT_CHARS) : '',
          error: error?.message,
        })
      },
    )
  })
}

async function searchCodeHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const rawPattern = asString(input.pattern).trim()
  if (!rawPattern) return { content: 'pattern is required', is_error: true }
  const searchPath = asString(input.path).trim() || process.cwd()
  const cwd = process.cwd()
  const contextLines = asNonNegativeNumber(input.context_lines, 2, 10)
  const maxResults = asPositiveNumber(input.max_results, 50, 200)
  const pattern = input.mode === 'symbol' ? buildSymbolPattern(rawPattern) : rawPattern
  const fileGlob = asString(input.file_glob).trim()
  const args = [
    '--line-number',
    '--with-filename',
    '--color',
    'never',
    '-C',
    String(contextLines),
    '--max-count',
    String(maxResults),
    '--glob',
    '!node_modules',
    '--glob',
    '!.git',
    '--glob',
    '!dist',
    '--glob',
    '!build',
    '--glob',
    '!coverage',
  ]
  if (input.case_sensitive === false) args.push('-i')
  if (fileGlob) args.push('--glob', fileGlob)
  args.push('--', pattern, searchPath)

  let result = await execFileCollect('rg', args, cwd)
  if (result.code !== 0 && !result.stdout && /ENOENT/.test(result.error ?? '')) {
    const grepArgs = [
      '-RIn',
      '-C',
      String(contextLines),
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=dist',
      '--exclude-dir=build',
    ]
    if (input.case_sensitive === false) grepArgs.push('-i')
    if (fileGlob) grepArgs.push(`--include=${fileGlob}`)
    grepArgs.push('--', pattern, searchPath)
    result = await execFileCollect('grep', grepArgs, cwd)
  }

  if (result.code === 1 && !result.stdout.trim()) {
    return { content: 'No matches found.' }
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    return {
      content: `[error] ${result.stderr || result.error || 'search failed'}`,
      is_error: true,
    }
  }
  const lines = result.stdout.trimEnd().split('\n')
  const shown = lines.slice(0, maxResults * (contextLines * 2 + 2))
  const suffix = shown.length < lines.length ? '\n... [output truncated]' : ''
  return {
    content: `Search results for ${JSON.stringify(rawPattern)} in ${searchPath}:\n\n${shown.join('\n')}${suffix}`,
  }
}

async function getTimeHandler(
  input: Record<string, unknown>,
): Promise<ExecToolResponse> {
  const timezone =
    asString(input.timezone).trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map((part) => [part.type, part.value]),
    )
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    }).format(now)
    return {
      content: [
        `date: ${parts.year}-${parts.month}-${parts.day}`,
        `time: ${parts.hour}:${parts.minute}:${parts.second}`,
        `weekday: ${weekday}`,
        `timezone: ${timezone}`,
        `unix_timestamp: ${Math.floor(now.getTime() / 1000)}`,
        `iso: ${now.toISOString()}`,
      ].join('\n'),
    }
  } catch {
    return {
      content: `invalid timezone: "${timezone}". Use IANA format like "Asia/Shanghai".`,
      is_error: true,
    }
  }
}

const fetchUrlSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The URL to fetch (http or https)' },
    max_length: {
      type: 'number',
      description: 'Optional max response characters (default 32768, max 131072)',
    },
    format: {
      type: 'string',
      enum: ['text', 'html', 'json'],
      description: 'Response format. text strips HTML, html returns raw HTML, json pretty-prints JSON.',
    },
  },
  required: ['url'],
  additionalProperties: false,
}

const tools: ToolImpl[] = [
  {
    name: 'get_time',
    description: 'Get current date, time, weekday, timezone, unix timestamp, and ISO timestamp.',
    input_schema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone, e.g. Asia/Shanghai or America/New_York',
        },
      },
      additionalProperties: false,
    },
    handler: getTimeHandler,
  },
  {
    name: 'run_command',
    description:
      'Run a local shell command for debugging scripts or skill bash snippets. Returns status, cwd, exit code, stdout, and stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        working_directory: {
          type: 'string',
          description: 'Absolute directory to run the command in',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default 60000, max 600000)',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: runCommandHandler,
  },
  {
    name: 'read_file',
    description:
      'Read a local text file with numbered lines. Use offset and limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: {
          type: 'number',
          description: 'Start line number, 1-based (default 1)',
        },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: readFileHandler,
  },
  {
    name: 'list_files',
    description:
      'List files and directories, with optional glob filtering and depth control. Skips common noise directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list' },
        pattern: {
          type: 'string',
          description: "Optional glob filter, e.g. '*.ts' or '**/*.test.ts'",
        },
        max_depth: { type: 'number', description: 'Max recursion depth (default 3, max 10)' },
        max_results: {
          type: 'number',
          description: 'Max entries to return (default 200, max 1000)',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden files and directories (default false)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: listFilesHandler,
  },
  {
    name: 'search_code',
    description:
      "Search local files for a regex using ripgrep when available, with grep fallback. Use mode='symbol' for common definition patterns.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern or symbol name' },
        path: {
          type: 'string',
          description: 'File or directory to search (defaults to server cwd)',
        },
        file_glob: {
          type: 'string',
          description: "Optional file glob, e.g. '*.ts' or '*.{ts,tsx}'",
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Case sensitive search (default true)',
        },
        context_lines: {
          type: 'number',
          description: 'Context lines around matches (default 2, max 10)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum matching lines per file for rg (default 50, max 200)',
        },
        mode: {
          type: 'string',
          enum: ['text', 'symbol'],
          description: 'text searches raw regex; symbol searches common definition forms',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: searchCodeHandler,
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a URL and return text, raw HTML, or pretty-printed JSON. HTML is stripped in text mode.',
    input_schema: fetchUrlSchema,
    handler: fetchUrlHandler,
  },
  {
    name: 'web_fetch',
    description: 'Legacy alias for fetch_url. GET a URL and return a truncated response body.',
    input_schema: fetchUrlSchema,
    handler: fetchUrlHandler,
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
