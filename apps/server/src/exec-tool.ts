import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecToolDef, ExecToolResponse, SandboxConfig } from '@llm-impl/shared'

type ToolImpl = ExecToolDef & {
  handler: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ExecToolResponse>
}

export type ExecToolStreamEvent = {
  type: 'result'
  result: ExecToolResponse
}

type CommandStatus = 'running' | 'success' | 'failed' | 'timeout' | 'blocked'
type SandboxMode = 'workspace-write' | 'read-only'
type SandboxNetwork = 'blocked' | 'allowed'
type ToolContext = {
  sandbox?: SandboxConfig
  onRunCommandProgress?: (response: ExecToolResponse) => void
}
type ResolvedSandboxConfig = {
  enabled: boolean
  mode: SandboxMode
  network: SandboxNetwork
  allowedRoots: string[]
  writableRoots: string[]
  label?: string
}

const MAX_COMMAND_TIMEOUT_MS = 600_000
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024
const MAX_FILE_SIZE = 256 * 1024
const MAX_WRITE_FILE_BYTES = 512 * 1024
const MAX_EDIT_FILE_BYTES = 512 * 1024
const MAX_FETCH_CHARS = 128 * 1024
const DEFAULT_FETCH_CHARS = 32 * 1024
const FETCH_TIMEOUT_MS = 15_000
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
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

const splitPathList = (value: string | undefined): string[] =>
  value
    ? value
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

const defaultAllowedRootCandidates = (extraRoots: string[] = []): string[] => [
  REPO_ROOT,
  path.resolve(REPO_ROOT, 'skills'),
  path.resolve(REPO_ROOT, '../rule_agent/skills'),
  ...splitPathList(process.env.SKILL_ROOTS),
  ...splitPathList(process.env.LLM_IMPL_ALLOWED_ROOTS),
  ...extraRoots,
]

const defaultReadOnlyRoots = (): string[] => [
  '/bin',
  '/sbin',
  '/usr',
  '/System',
  '/Library',
  '/opt',
  ...splitPathList(process.env.PATH),
]

const defaultTempWriteRoots = (): string[] => [
  os.tmpdir(),
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
]

const truncateMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  const keep = Math.floor(maxChars / 2)
  return `${text.slice(0, keep)}\n...[truncated]...\n${text.slice(-keep)}`
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : ''

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

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

function sandboxModeFrom(value: unknown): SandboxMode | undefined {
  return value === 'read-only' || value === 'workspace-write'
    ? value
    : undefined
}

function sandboxNetworkFrom(value: unknown): SandboxNetwork | undefined {
  return value === 'allowed' || value === 'blocked' ? value : undefined
}

function resolveSandboxConfig(
  input: Record<string, unknown>,
  context: ToolContext,
): ResolvedSandboxConfig {
  const caseSandbox = context.sandbox ?? {}
  return {
    enabled:
      typeof input.sandbox_enabled === 'boolean'
        ? input.sandbox_enabled
        : caseSandbox.enabled !== false,
    mode:
      sandboxModeFrom(input.sandbox_mode) ??
      caseSandbox.mode ??
      'workspace-write',
    network:
      sandboxNetworkFrom(input.sandbox_network) ??
      caseSandbox.network ??
      'blocked',
    allowedRoots: [
      ...(caseSandbox.allowedRoots ?? []),
      ...asStringArray(input.sandbox_allowed_roots),
    ],
    writableRoots: [
      ...(caseSandbox.writableRoots ?? []),
      ...asStringArray(input.sandbox_writable_roots),
    ],
    label:
      asString(input.sandbox_label).trim() ||
      caseSandbox.label ||
      undefined,
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function realExistingPath(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath)
  } catch {
    return null
  }
}

async function existingDirectories(paths: string[]): Promise<string[]> {
  const roots: string[] = []
  for (const entry of paths) {
    const resolved = path.resolve(entry)
    const real = await realExistingPath(resolved)
    if (real && (await directoryExists(real))) roots.push(real)
    if (real && (await directoryExists(resolved))) roots.push(resolved)
  }
  return [...new Set(roots)]
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

async function allowedRoots(extraRoots: string[] = []): Promise<string[]> {
  return existingDirectories(defaultAllowedRootCandidates(extraRoots))
}

async function writableRootsForSandbox(
  sandbox: ResolvedSandboxConfig,
): Promise<string[]> {
  const rootCandidates = [
    ...defaultTempWriteRoots(),
    ...sandbox.writableRoots,
    ...(sandbox.mode === 'workspace-write'
      ? defaultAllowedRootCandidates(sandbox.allowedRoots)
      : []),
  ]
  const lexicalRoots = rootCandidates.map((entry) => path.resolve(entry))
  const realRoots = await existingDirectories(rootCandidates)
  return [...new Set([...realRoots, ...lexicalRoots])]
}

async function requireAllowedPath(
  targetPath: string,
  label: string,
  extraAllowedRoots: string[] = [],
): Promise<{ ok: true; realPath: string; roots: string[] } | { ok: false; response: ExecToolResponse }> {
  const realPath = await realExistingPath(path.resolve(targetPath))
  if (!realPath) {
    return {
      ok: false,
      response: {
        content: `[error] ${label} does not exist: ${targetPath}`,
        is_error: true,
      },
    }
  }
  const roots = await allowedRoots(extraAllowedRoots)
  if (roots.some((root) => isPathInside(root, realPath))) {
    return { ok: true, realPath, roots }
  }
  return {
    ok: false,
    response: {
      content: [
        `[sandbox] blocked ${label}: ${realPath}`,
        'Allowed roots:',
        ...roots.map((root) => `- ${root}`),
        '',
        'Set LLM_IMPL_ALLOWED_ROOTS to add more trusted roots.',
      ].join('\n'),
      is_error: true,
    },
  }
}

async function requireWritablePath(
  targetPath: string,
  label: string,
  sandbox: ResolvedSandboxConfig,
): Promise<{ ok: true; resolvedPath: string; roots: string[] } | { ok: false; response: ExecToolResponse }> {
  const resolvedPath = path.resolve(targetPath)
  const roots = await writableRootsForSandbox(sandbox)
  const existingTarget = await realExistingPath(resolvedPath)
  const parentPath = path.dirname(resolvedPath)
  const existingParent = await realExistingPath(parentPath)
  const checkPath =
    existingTarget ??
    (existingParent
      ? path.join(existingParent, path.basename(resolvedPath))
      : resolvedPath)

  if (roots.some((root) => isPathInside(root, checkPath))) {
    return { ok: true, resolvedPath, roots }
  }

  return {
    ok: false,
    response: {
      content: [
        `[sandbox] blocked ${label}: ${resolvedPath}`,
        'Writable roots:',
        ...roots.map((root) => `- ${root}`),
        '',
        'Use case sandbox.writableRoots or per-call sandbox_writable_roots to add a writable root.',
      ].join('\n'),
      is_error: true,
    },
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
  sandbox?: string
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
  if (payload.sandbox) rows.push(`sandbox: ${payload.sandbox}`)
  if (typeof payload.exitCode === 'number') rows.push(`exit_code: ${payload.exitCode}`)
  if (payload.signal) rows.push(`signal: ${payload.signal}`)
  if (payload.note) rows.push(`note: ${payload.note}`)
  if (payload.stdout) rows.push(`stdout:\n${payload.stdout}`)
  if (payload.stderr) rows.push(`stderr:\n${payload.stderr}`)
  return rows.join('\n')
}

function sandboxString(value: string): string {
  return JSON.stringify(value)
}

async function commandReferenceRoots(roots: string[]): Promise<string[]> {
  return existingDirectories([
    ...defaultReadOnlyRoots(),
    ...defaultTempWriteRoots(),
    ...roots,
  ])
}

function isAllowedDevicePath(targetPath: string): boolean {
  return targetPath === '/dev/null' || targetPath.startsWith('/dev/fd/')
}

function extractAbsolutePathRefs(command: string): string[] {
  const refs: string[] = []
  const pattern = /(?:^|[\s"'=])((?:\/[^\s"'`$;&|<>()\[\]{}]+)+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command))) {
    if (match[1]) refs.push(match[1])
  }
  return refs
}

async function findDisallowedCommandPathRef(
  command: string,
  roots: string[],
): Promise<string | null> {
  const referenceRoots = await commandReferenceRoots(roots)
  for (const ref of extractAbsolutePathRefs(command)) {
    if (ref.startsWith('//')) continue
    const resolved = (await realExistingPath(ref)) ?? path.resolve(ref)
    if (isAllowedDevicePath(resolved)) continue
    if (!referenceRoots.some((root) => isPathInside(root, resolved))) {
      return resolved
    }
  }
  return null
}

async function buildMacSandboxProfile(
  cwd: string,
  sandbox: ResolvedSandboxConfig,
): Promise<string> {
  const writeRoots = await existingDirectories([
    ...defaultTempWriteRoots(),
    ...(sandbox.mode === 'workspace-write' ? [cwd] : []),
    ...sandbox.writableRoots,
  ])
  const writeRules = writeRoots
    .map((root) => `(subpath ${sandboxString(root)})`)
    .join('\n    ')

  return [
    '(version 1)',
    '(allow default)',
    sandbox.network === 'blocked' ? '(deny network*)' : '',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    writeRules ? `(allow file-write*\n    ${writeRules})` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function commandSpawnConfig(
  command: string,
  cwd: string,
  sandbox: ResolvedSandboxConfig,
): Promise<{ file: string; args: string[]; label: string }> {
  const sandboxExec = '/usr/bin/sandbox-exec'
  const configLabel = sandbox.label ? `:${sandbox.label}` : ''
  if (sandbox.enabled && process.platform === 'darwin' && (await fileExists(sandboxExec))) {
    const profile = await buildMacSandboxProfile(cwd, sandbox)
    return {
      file: sandboxExec,
      args: ['-p', profile, '/bin/sh', '-c', command],
      label: `macos-sandbox-exec:${sandbox.mode}:network-${sandbox.network}${configLabel}`,
    }
  }
  return {
    file: '/bin/sh',
    args: ['-c', command],
    label: sandbox.enabled
      ? `soft-path-guard:${sandbox.mode}:network-${sandbox.network}${configLabel}`
      : `sandbox-disabled${configLabel}`,
  }
}

function commandEnv(): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'HOME',
    'USER',
    'SHELL',
    'PYTHONPATH',
    'NODE_PATH',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.LANG = env.LANG ?? 'en_US.UTF-8'
  env.TMPDIR = env.TMPDIR ?? os.tmpdir()
  return env
}

async function runCommandHandler(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ExecToolResponse> {
  const command = asString(input.command).trim()
  if (!command) return { content: 'command is required', is_error: true }
  const sandbox = resolveSandboxConfig(input, context)

  const requestedCwd = asString(input.working_directory).trim()
  const cwd = requestedCwd ? path.resolve(requestedCwd) : process.cwd()
  const resolvedCwd = sandbox.enabled
    ? await requireAllowedPath(
        cwd,
        'working_directory',
        [...sandbox.allowedRoots, ...sandbox.writableRoots],
      )
    : { ok: true as const, realPath: (await realExistingPath(cwd)) ?? cwd, roots: [] }

  if (!resolvedCwd.ok) {
    return {
      content: formatRunCommandResult({
        status: 'blocked',
        command,
        cwd,
        note: resolvedCwd.response.content,
      }),
      is_error: true,
    }
  }
  if (!(await directoryExists(resolvedCwd.realPath))) {
    return {
      content: formatRunCommandResult({
        status: 'failed',
        command,
        cwd: resolvedCwd.realPath,
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
  const disallowedPathRef = sandbox.enabled
    ? await findDisallowedCommandPathRef(
        command,
        [...resolvedCwd.roots, ...sandbox.allowedRoots, ...sandbox.writableRoots],
      )
    : null
  if (disallowedPathRef) {
    return {
      content: formatRunCommandResult({
        status: 'blocked',
        command,
        cwd: resolvedCwd.realPath,
        note: `command references a path outside allowed roots: ${disallowedPathRef}`,
      }),
      is_error: true,
    }
  }

  const timeoutMs = asPositiveNumber(
    input.timeout_ms,
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  )
  const spawnConfig = await commandSpawnConfig(
    command,
    resolvedCwd.realPath,
    sandbox,
  )

  return new Promise<ExecToolResponse>((resolve) => {
    const child = spawn(spawnConfig.file, spawnConfig.args, {
      cwd: resolvedCwd.realPath,
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    const cap = (text: string) => truncateMiddle(text, MAX_COMMAND_OUTPUT_CHARS)
    const runningResponse = (): ExecToolResponse => ({
      content: formatRunCommandResult({
        status: 'running',
        command,
        cwd: resolvedCwd.realPath,
        sandbox: spawnConfig.label,
        stdout: stdout.trimEnd() || undefined,
        stderr: stderr.trimEnd() || undefined,
      }),
      is_error: false,
    })
    const emitProgress = (force = false) => {
      if (!context.onRunCommandProgress || settled) return
      if (progressTimer) return
      if (force) {
        context.onRunCommandProgress(runningResponse())
        return
      }
      progressTimer = setTimeout(() => {
        progressTimer = null
        if (!settled) context.onRunCommandProgress?.(runningResponse())
      }, 100)
    }
    const finish = (response: ExecToolResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (progressTimer) clearTimeout(progressTimer)
      resolve(response)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        content: formatRunCommandResult({
          status: 'timeout',
          command,
          cwd: resolvedCwd.realPath,
          sandbox: spawnConfig.label,
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
      emitProgress()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = cap(stderr + chunk)
      emitProgress()
    })
    emitProgress(true)
    child.on('error', (error) => {
      finish({ content: error.message, is_error: true })
    })
    child.on('close', (code, signal) => {
      const ok = code === 0
      finish({
        content: formatRunCommandResult({
          status: ok ? 'success' : 'failed',
          command,
          cwd: resolvedCwd.realPath,
          sandbox: spawnConfig.label,
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
  context: ToolContext,
): Promise<ExecToolResponse> {
  const filePath = asString(input.path).trim()
  if (!filePath) return { content: 'path is required', is_error: true }
  const sandbox = resolveSandboxConfig(input, context)
  const allowedPath = await requireAllowedPath(
    filePath,
    'read_file path',
    [...sandbox.allowedRoots, ...sandbox.writableRoots],
  )
  if (!allowedPath.ok) return allowedPath.response
  if (!(await fileExists(allowedPath.realPath))) {
    return { content: `[error] File not found: ${filePath}`, is_error: true }
  }
  const stat = await fs.stat(allowedPath.realPath)
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
    const content = await fs.readFile(allowedPath.realPath, 'utf8')
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

async function writeFileHandler(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ExecToolResponse> {
  const filePath = asString(input.path).trim()
  if (!filePath) return { content: 'path is required', is_error: true }
  if (typeof input.content !== 'string') {
    return { content: 'content must be a string', is_error: true }
  }

  const sandbox = resolveSandboxConfig(input, context)
  const writablePath = await requireWritablePath(
    filePath,
    'write_file path',
    sandbox,
  )
  if (!writablePath.ok) return writablePath.response

  const content = input.content
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_FILE_BYTES) {
    return {
      content: `[error] content too large (${bytes} bytes). Max ${MAX_WRITE_FILE_BYTES} bytes.`,
      is_error: true,
    }
  }

  const overwrite = input.overwrite === true
  const createDirs = input.create_dirs === true
  const parent = path.dirname(writablePath.resolvedPath)
  const parentExists = await directoryExists(parent)
  if (!parentExists && !createDirs) {
    return {
      content: `[error] parent directory does not exist: ${parent}. Set create_dirs=true to create it.`,
      is_error: true,
    }
  }
  if (!parentExists) await fs.mkdir(parent, { recursive: true })

  const existingStat = await fs.stat(writablePath.resolvedPath).catch(() => null)
  if (existingStat?.isDirectory()) {
    return {
      content: `[error] target is a directory: ${writablePath.resolvedPath}`,
      is_error: true,
    }
  }
  if (existingStat && !overwrite) {
    return {
      content: `[error] file already exists: ${writablePath.resolvedPath}. Set overwrite=true to replace it.`,
      is_error: true,
    }
  }

  await fs.writeFile(writablePath.resolvedPath, content, 'utf8')
  const configLabel = sandbox.label ? `:${sandbox.label}` : ''
  return {
    content: [
      '[write_file]',
      `path: ${writablePath.resolvedPath}`,
      `bytes: ${bytes}`,
      `overwritten: ${existingStat ? 'true' : 'false'}`,
      `created_dirs: ${!parentExists && createDirs ? 'true' : 'false'}`,
      `sandbox: server-path-guard:${sandbox.mode}:network-${sandbox.network}${configLabel}`,
    ].join('\n'),
  }
}

function countExactMatches(content: string, target: string): number {
  let count = 0
  let index = 0
  while (true) {
    const next = content.indexOf(target, index)
    if (next === -1) return count
    count += 1
    index = next + target.length
  }
}

async function editFileHandler(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ExecToolResponse> {
  const filePath = asString(input.path).trim()
  if (!filePath) return { content: 'path is required', is_error: true }
  if (typeof input.old_text !== 'string') {
    return { content: 'old_text must be a string', is_error: true }
  }
  if (typeof input.new_text !== 'string') {
    return { content: 'new_text must be a string', is_error: true }
  }
  if (!input.old_text) {
    return { content: 'old_text must not be empty', is_error: true }
  }
  const oldText = input.old_text
  const newText = input.new_text

  const sandbox = resolveSandboxConfig(input, context)
  const writablePath = await requireWritablePath(
    filePath,
    'edit_file path',
    sandbox,
  )
  if (!writablePath.ok) return writablePath.response

  const stat = await fs.stat(writablePath.resolvedPath).catch(() => null)
  if (!stat) {
    return {
      content: `[error] file does not exist: ${writablePath.resolvedPath}`,
      is_error: true,
    }
  }
  if (!stat.isFile()) {
    return {
      content: `[error] target is not a file: ${writablePath.resolvedPath}`,
      is_error: true,
    }
  }
  if (stat.size > MAX_EDIT_FILE_BYTES) {
    return {
      content: `[error] file too large (${stat.size} bytes). Max ${MAX_EDIT_FILE_BYTES} bytes.`,
      is_error: true,
    }
  }

  const original = await fs.readFile(writablePath.resolvedPath, 'utf8')
  const matchCount = countExactMatches(original, oldText)
  if (matchCount === 0) {
    return {
      content: '[error] old_text was not found in file',
      is_error: true,
    }
  }

  const replaceAll = input.replace_all === true
  let expectedReplacements: number | undefined
  if (input.expected_replacements !== undefined) {
    if (
      typeof input.expected_replacements !== 'number' ||
      !Number.isFinite(input.expected_replacements) ||
      input.expected_replacements < 0 ||
      !Number.isInteger(input.expected_replacements)
    ) {
      return {
        content: 'expected_replacements must be a non-negative integer',
        is_error: true,
      }
    }
    expectedReplacements = input.expected_replacements
  }

  if (!replaceAll && matchCount !== 1) {
    return {
      content: `[error] old_text matched ${matchCount} times. Make old_text more specific or set replace_all=true.`,
      is_error: true,
    }
  }

  const replacementCount = replaceAll ? matchCount : 1
  if (
    expectedReplacements !== undefined &&
    replacementCount !== expectedReplacements
  ) {
    return {
      content: `[error] replacement count mismatch: expected ${expectedReplacements}, got ${replacementCount}.`,
      is_error: true,
    }
  }

  const edited = replaceAll
    ? original.split(oldText).join(newText)
    : original.replace(oldText, newText)
  const bytes = Buffer.byteLength(edited, 'utf8')
  if (bytes > MAX_EDIT_FILE_BYTES) {
    return {
      content: `[error] edited file would be too large (${bytes} bytes). Max ${MAX_EDIT_FILE_BYTES} bytes.`,
      is_error: true,
    }
  }

  const dryRun = input.dry_run === true
  if (!dryRun) await fs.writeFile(writablePath.resolvedPath, edited, 'utf8')
  const configLabel = sandbox.label ? `:${sandbox.label}` : ''
  return {
    content: [
      '[edit_file]',
      `path: ${writablePath.resolvedPath}`,
      `matches: ${matchCount}`,
      `replacements: ${replacementCount}`,
      `bytes_before: ${Buffer.byteLength(original, 'utf8')}`,
      `bytes_after: ${bytes}`,
      `dry_run: ${dryRun ? 'true' : 'false'}`,
      `sandbox: server-path-guard:${sandbox.mode}:network-${sandbox.network}${configLabel}`,
    ].join('\n'),
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
  context: ToolContext,
): Promise<ExecToolResponse> {
  const dirPath = asString(input.path).trim()
  if (!dirPath) return { content: 'path is required', is_error: true }
  const sandbox = resolveSandboxConfig(input, context)
  const allowedPath = await requireAllowedPath(
    dirPath,
    'list_files path',
    [...sandbox.allowedRoots, ...sandbox.writableRoots],
  )
  if (!allowedPath.ok) return allowedPath.response
  if (!(await directoryExists(allowedPath.realPath))) {
    return { content: `[error] Not a directory: ${dirPath}`, is_error: true }
  }
  const maxDepth = asNonNegativeNumber(input.max_depth, 3, 10)
  const maxResults = asPositiveNumber(input.max_results, 200, 1_000)
  const includeHidden = input.include_hidden === true
  const pattern = asString(input.pattern).trim() || undefined
  const { entries, totalFound } = await collectFiles({
    basePath: allowedPath.realPath,
    currentPath: allowedPath.realPath,
    maxDepth,
    includeHidden,
    pattern,
    maxResults,
  })
  if (entries.length === 0) {
    return {
      content: pattern
        ? `No files matching pattern '${pattern}' found in ${allowedPath.realPath}`
        : `Directory is empty: ${allowedPath.realPath}`,
    }
  }
  const header = pattern
    ? `Files matching '${pattern}' in ${allowedPath.realPath}:`
    : `Contents of ${allowedPath.realPath}:`
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
  context: ToolContext,
): Promise<ExecToolResponse> {
  const rawPattern = asString(input.pattern).trim()
  if (!rawPattern) return { content: 'pattern is required', is_error: true }
  const requestedSearchPath = asString(input.path).trim() || REPO_ROOT
  const sandbox = resolveSandboxConfig(input, context)
  const allowedSearchPath = await requireAllowedPath(
    requestedSearchPath,
    'search_code path',
    [...sandbox.allowedRoots, ...sandbox.writableRoots],
  )
  if (!allowedSearchPath.ok) return allowedSearchPath.response
  const searchPath = allowedSearchPath.realPath
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
      'Run a local shell command for debugging scripts or skill bash snippets. Defaults to sandboxed path/network guards; sandbox_enabled=false disables those run_command guards while keeping dangerous-command checks. Returns status, cwd, sandbox label, exit code, stdout, and stderr.',
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
        sandbox_mode: {
          type: 'string',
          enum: ['workspace-write', 'read-only'],
          description:
            'Sandbox mode. workspace-write allows writes only in working_directory and temp dirs. read-only prevents writes to working_directory; temp dirs remain writable.',
        },
        sandbox_network: {
          type: 'string',
          enum: ['blocked', 'allowed'],
          description: 'Network policy for this command. Defaults to blocked.',
        },
        sandbox_allowed_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional trusted roots for this command. Prefer case-level sandbox.allowedRoots for repeatable tests.',
        },
        sandbox_writable_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional writable roots for this command. Use sparingly for debugging.',
        },
        sandbox_enabled: {
          type: 'boolean',
          description:
            'When false, run_command skips OS sandbox, path allowlist, command path-reference checks, and network sandboxing. Dangerous command checks, timeout, output truncation, and inherited process permissions still apply.',
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
    name: 'write_file',
    description:
      'Create or overwrite a local UTF-8 text file inside sandbox writable roots. Defaults to no overwrite and no parent directory creation.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write' },
        content: {
          type: 'string',
          description: 'UTF-8 text content to write (max 512 KiB)',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace the file when it already exists (default false)',
        },
        create_dirs: {
          type: 'boolean',
          description:
            'Create missing parent directories when true (default false)',
        },
        sandbox_mode: {
          type: 'string',
          enum: ['workspace-write', 'read-only'],
          description:
            'Sandbox mode. workspace-write allows writes inside allowed roots and writable roots; read-only allows only writable roots and temp dirs.',
        },
        sandbox_network: {
          type: 'string',
          enum: ['blocked', 'allowed'],
          description:
            'Accepted for parity with case sandbox; write_file does not use network.',
        },
        sandbox_allowed_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional trusted roots for this write when sandbox_mode is workspace-write.',
        },
        sandbox_writable_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional writable roots for this write. Prefer case-level sandbox.writableRoots for repeatable tests.',
        },
        sandbox_enabled: {
          type: 'boolean',
          description:
            'Kept for parity with run_command. write_file always uses server path guards.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: writeFileHandler,
  },
  {
    name: 'edit_file',
    description:
      'Edit an existing UTF-8 text file inside sandbox writable roots by exact old_text/new_text replacement. Defaults to one exact match.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_text: {
          type: 'string',
          description:
            'Exact text to replace. Must match once unless replace_all=true.',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text',
        },
        replace_all: {
          type: 'boolean',
          description:
            'Replace every exact match when true. Defaults to false.',
        },
        expected_replacements: {
          type: 'number',
          description:
            'Optional guard for the number of replacements that must happen.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Validate and report replacement counts without writing the file.',
        },
        sandbox_mode: {
          type: 'string',
          enum: ['workspace-write', 'read-only'],
          description:
            'Sandbox mode. workspace-write allows edits inside allowed roots and writable roots; read-only allows only writable roots and temp dirs.',
        },
        sandbox_network: {
          type: 'string',
          enum: ['blocked', 'allowed'],
          description:
            'Accepted for parity with case sandbox; edit_file does not use network.',
        },
        sandbox_allowed_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional trusted roots for this edit when sandbox_mode is workspace-write.',
        },
        sandbox_writable_roots: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional writable roots for this edit. Prefer case-level sandbox.writableRoots for repeatable tests.',
        },
        sandbox_enabled: {
          type: 'boolean',
          description:
            'Kept for parity with run_command. edit_file always uses server path guards.',
        },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    handler: editFileHandler,
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
  sandbox?: SandboxConfig,
): Promise<ExecToolResponse> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { content: `unknown tool: ${name}`, is_error: true }
  try {
    const inputObj =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    return await tool.handler(inputObj, { sandbox })
  } catch (e) {
    return { content: `tool error: ${(e as Error).message}`, is_error: true }
  }
}

export async function* execToolStream(
  name: string,
  input: unknown,
  sandbox?: SandboxConfig,
): AsyncGenerator<ExecToolStreamEvent> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    yield { type: 'result', result: { content: `unknown tool: ${name}`, is_error: true } }
    return
  }
  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  if (name !== 'run_command') {
    yield { type: 'result', result: await execTool(name, inputObj, sandbox) }
    return
  }

  type QueuedEvent = ExecToolStreamEvent & { final: boolean }
  const queue: QueuedEvent[] = []
  let wake: (() => void) | null = null
  let finished = false
  const push = (event: QueuedEvent) => {
    queue.push(event)
    wake?.()
    wake = null
  }
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      wake = resolve
    })

  void runCommandHandler(inputObj, {
    sandbox,
    onRunCommandProgress: (result) => push({ type: 'result', result, final: false }),
  }).then(
    (result) => push({ type: 'result', result, final: true }),
    (e) =>
      push({
        type: 'result',
        result: { content: `tool error: ${(e as Error).message}`, is_error: true },
        final: true,
      }),
  )

  while (!finished) {
    if (queue.length === 0) await waitForEvent()
    while (queue.length > 0) {
      const event = queue.shift()!
      finished = event.final
      yield { type: event.type, result: event.result }
    }
  }
}
